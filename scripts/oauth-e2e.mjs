#!/usr/bin/env node
// Local end-to-end OAuth test (#48): JobScout Pro as the issuer, jobscout-mcp as the resource
// server, both on loopback with throwaway state. Every key and secret is generated at run time
// and the issuer database lives in a temporary directory that is deleted afterwards.
//
//   npm run build && node scripts/oauth-e2e.mjs [--skip-expiry]
//
// JOBSCOUT_PRO_DIR points at a built jobscout-pro checkout (default ../jobscout-pro). Results go
// to stdout and, when JOBSCOUT_OAUTH_E2E_OUTPUT is set, to that JSON file. Exit 1 on any failure.

import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers";
import { URL, URLSearchParams, fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const proDir = path.resolve(process.env.JOBSCOUT_PRO_DIR ?? path.join(root, "..", "jobscout-pro"));
const skipExpiry = process.argv.includes("--skip-expiry");
const ACCESS_TTL = 60;
const AUDIENCE = "mcp-host-gateway";
const REDIRECT_URI = "http://127.0.0.1:33418/callback";

for (const file of [path.join(proDir, "dist/src/main.js"), path.join(root, "dist/src/http-server.js")]) {
  if (!existsSync(file)) {
    process.stderr.write(`missing ${file}: run npm ci && npm run build in both checkouts first\n`);
    process.exit(2);
  }
}

const results = [];
const children = [];
const work = mkdtempSync(path.join(tmpdir(), "jobscout-oauth-e2e-"));

function record(name, ok, detail) {
  results.push({ name, ok, ...(detail ? { detail } : {}) });
  process.stdout.write(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}\n`);
}

async function step(name, fn) {
  try {
    const detail = await fn();
    record(name, true, typeof detail === "string" ? detail : undefined);
    return true;
  } catch (error) {
    record(name, false, error instanceof Error ? error.message : String(error));
    return false;
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// Only what Node needs to start: the parent environment (and any .env) never leaks in.
function baseEnv(extra) {
  const keep = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "HOME", "USERPROFILE"];
  return { ...Object.fromEntries(keep.filter((k) => process.env[k]).map((k) => [k, process.env[k]])), ...extra };
}

function start(name, script, cwd, env) {
  const child = spawn(process.execPath, [script], { cwd, env: baseEnv(env), stdio: ["ignore", "pipe", "pipe"] });
  const state = { name, child, stderr: "", exited: null };
  child.stderr.on("data", (chunk) => { state.stderr += chunk.toString(); });
  child.stdout.on("data", () => {});
  child.on("exit", (code) => { state.exited = code; });
  children.push(state);
  return state;
}

async function waitFor(url, state) {
  for (let i = 0; i < 100; i++) {
    if (state.exited !== null) throw new Error(`${state.name} exited (${state.exited}): ${state.stderr.trim().split("\n").slice(-3).join(" | ")}`);
    try {
      const res = await fetch(url);
      await res.arrayBuffer();
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${state.name} did not become ready at ${url}`);
}

const b64url = (buf) => buf.toString("base64url");
const s256 = (verifier) => b64url(createHash("sha256").update(verifier).digest());

/** Cookie jar, same-origin Origin header on POSTs, manual redirects. */
class Browser {
  cookies = new Map();
  constructor(base) { this.base = base; }
  header() { return [...this.cookies].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; "); }
  keep(res) {
    for (const line of res.headers.getSetCookie()) {
      const [pair = ""] = line.split(";");
      const idx = pair.indexOf("=");
      if (idx < 0) continue;
      const value = decodeURIComponent(pair.slice(idx + 1).trim());
      if (/max-age=0/i.test(line) || value === "") this.cookies.delete(pair.slice(0, idx).trim());
      else this.cookies.set(pair.slice(0, idx).trim(), value);
    }
  }
  async get(p) {
    const res = await fetch(new URL(p, this.base), { redirect: "manual", headers: { cookie: this.header() } });
    this.keep(res);
    return res;
  }
  async post(p, fields) {
    const res = await fetch(new URL(p, this.base), {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: this.header(), origin: this.base },
      body: new URLSearchParams(fields).toString(),
    });
    this.keep(res);
    return res;
  }
}

const csrf = (html) => {
  const m = /name="csrf" value="([^"]+)"/.exec(html);
  if (!m) throw new Error("no csrf field on page");
  return m[1];
};

function rpc(url, token, method, params = {}) {
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

async function authorizeUrl(issuer, clientId, challenge, method, resource) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: method,
    state: "e2e-state",
    scope: "jobscout offline_access",
    resource,
  });
  return `${issuer}/oauth/authorize?${params}`;
}

async function getCode(browser, issuer, clientId, verifier, resource) {
  const consent = await browser.get(await authorizeUrl(issuer, clientId, s256(verifier), "S256", resource));
  const html = await consent.text();
  expect(consent.status === 200, `consent page returned ${consent.status} ${consent.headers.get("location") ?? ""} ${html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 160)}`);
  const fields = {};
  for (const m of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) fields[m[1]] = m[2].replaceAll("&amp;", "&");
  const decision = await browser.post("/oauth/authorize", { ...fields, decision: "allow" });
  expect(decision.status === 303, `consent decision returned ${decision.status}`);
  const redirect = new URL(decision.headers.get("location") ?? "");
  expect(redirect.origin + redirect.pathname === REDIRECT_URI, "redirect went somewhere else");
  expect(redirect.searchParams.get("state") === "e2e-state", "state not echoed");
  expect(redirect.searchParams.get("iss") === issuer, "iss not returned (RFC 9207)");
  const code = redirect.searchParams.get("code");
  expect(code, `no code: ${redirect.searchParams.get("error")}`);
  return code;
}

function exchange(issuer, clientId, code, verifier) {
  return fetch(`${issuer}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, client_id: clientId,
      ...(verifier === undefined ? {} : { code_verifier: verifier }),
    }),
  });
}

try {
  const [proPort, mcpPort, audPort, scopePort] = await Promise.all([freePort(), freePort(), freePort(), freePort()]);
  const issuer = `http://127.0.0.1:${proPort}`;
  const pro = start("jobscout-pro", "dist/src/main.js", proDir, {
    NODE_ENV: "development",
    HOST: "127.0.0.1",
    PORT: String(proPort),
    PUBLIC_BASE_URL: issuer,
    DATABASE_PATH: path.join(work, "issuer.sqlite"),
    SIGNING_KEY_SECRET: randomBytes(32).toString("base64"),
    TOKEN_AUDIENCE: AUDIENCE,
    // jobscout-mcp runs direct on its own ports, so its origins must be allowed as `resource`.
    EXTRA_RESOURCE_ORIGINS: [mcpPort, audPort, scopePort].map((p) => `http://127.0.0.1:${p}`).join(","),
    ACCESS_TOKEN_TTL_SECONDS: String(ACCESS_TTL),
    MAIL_TRANSPORT: "console",
    BILLING_PROVIDER: "mock",
    LOG_LEVEL: "warn",
  });
  await waitFor(`${issuer}/.well-known/oauth-authorization-server`, pro);

  // Three resource servers on the same issuer: the real one, one expecting another audience,
  // and one that also requires a scope the issuer never grants.
  const mcpEnv = (port, extra) => ({
    HOST: "127.0.0.1",
    PORT: String(port),
    JOBSCOUT_OAUTH_ISSUER: issuer,
    JOBSCOUT_OAUTH_RESOURCE_URL: `http://127.0.0.1:${port}/mcp`,
    JOBSCOUT_OAUTH_AUDIENCE: AUDIENCE,
    JOBSCOUT_OAUTH_ALLOW_INSECURE: "true",
    JOBSCOUT_OAUTH_MODE: "required",
    ...extra,
  });
  const mcp = start("jobscout-mcp", "dist/src/http-server.js", root, mcpEnv(mcpPort));
  const mcpAud = start("jobscout-mcp (other audience)", "dist/src/http-server.js", root, mcpEnv(audPort, { JOBSCOUT_OAUTH_AUDIENCE: "some-other-resource" }));
  const mcpScope = start("jobscout-mcp (extra scope)", "dist/src/http-server.js", root, mcpEnv(scopePort, { JOBSCOUT_OAUTH_SCOPES: "jobscout,jobscout:admin" }));
  await Promise.all([
    waitFor(`http://127.0.0.1:${mcpPort}/health`, mcp),
    waitFor(`http://127.0.0.1:${audPort}/health`, mcpAud),
    waitFor(`http://127.0.0.1:${scopePort}/health`, mcpScope),
  ]);
  const mcpUrl = `http://127.0.0.1:${mcpPort}/mcp`;

  let prm;
  let asMeta;
  let client;
  let browser;
  let tokens;

  await step("1 unauthenticated call gets 401 with resource_metadata", async () => {
    const res = await rpc(mcpUrl, undefined, "tools/list");
    await res.arrayBuffer();
    expect(res.status === 401, `status ${res.status}`);
    const challenge = res.headers.get("www-authenticate") ?? "";
    const m = /resource_metadata="([^"]+)"/.exec(challenge);
    expect(m, `no resource_metadata in ${challenge}`);
    prm = await (await fetch(m[1])).json();
    return m[1];
  });

  await step("2 protected resource metadata names the issuer", async () => {
    expect(prm, "no PRM from step 1");
    expect(prm.resource === mcpUrl, `resource ${prm.resource}`);
    expect(prm.authorization_servers?.includes(issuer), `authorization_servers ${JSON.stringify(prm.authorization_servers)}`);
  });

  await step("3 issuer metadata: S256 only, DCR, JWKS", async () => {
    asMeta = await (await fetch(`${issuer}/.well-known/oauth-authorization-server`)).json();
    expect(asMeta.issuer === issuer, "issuer mismatch");
    expect(JSON.stringify(asMeta.code_challenge_methods_supported) === '["S256"]', "PKCE methods are not S256 only");
    expect(asMeta.registration_endpoint, "no registration_endpoint");
    const jwks = await (await fetch(asMeta.jwks_uri)).json();
    expect(jwks.keys?.length > 0, "JWKS has no keys");
  });

  await step("4 dynamic client registration", async () => {
    const res = await fetch(asMeta.registration_endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "OAuth e2e client", redirect_uris: [REDIRECT_URI], grant_types: ["authorization_code", "refresh_token"], token_endpoint_auth_method: "none" }),
    });
    expect(res.status === 201, `status ${res.status}`);
    client = await res.json();
    expect(client.client_id, "no client_id");
  });

  await step("5 sign in with the magic link", async () => {
    browser = new Browser(issuer);
    const page = await (await browser.get("/account/signin")).text();
    const before = pro.stderr.length;
    const sent = await browser.post("/account/signin", { csrf: csrf(page), email: `e2e-${b64url(randomBytes(4))}@example.test`, next: "/account" });
    await sent.arrayBuffer();
    expect(sent.status === 200, `sign-in request ${sent.status}`);
    let link;
    for (let i = 0; i < 50 && !link; i++) {
      link = /(http\S+\/account\/verify\?token=\S+)/.exec(pro.stderr.slice(before))?.[1];
      if (!link) await new Promise((r) => setTimeout(r, 50));
    }
    expect(link, "no sign-in link in the console mail");
    const verify = new URL(link);
    const confirm = await (await browser.get(verify.pathname + verify.search)).text();
    const token = /name="token" value="([^"]+)"/.exec(confirm)?.[1] ?? "";
    const done = await browser.post("/account/verify", { csrf: csrf(confirm), token });
    await done.arrayBuffer();
    expect(done.status === 303, `verify returned ${done.status}`);
  });

  const verifier = b64url(randomBytes(32));
  let code;
  await step("6 authorisation code with PKCE S256 for the MCP resource", async () => {
    code = await getCode(browser, issuer, client.client_id, verifier, prm.resource);
  });

  await step("7 token exchange", async () => {
    const res = await exchange(issuer, client.client_id, code, verifier);
    const text = await res.text();
    expect(res.status === 200, `status ${res.status} ${text.slice(0, 160)}`);
    tokens = JSON.parse(text);
    expect(tokens.token_type === "Bearer" && tokens.access_token, "no bearer token");
    const header = JSON.parse(Buffer.from(tokens.access_token.split(".")[0], "base64url").toString());
    const claims = JSON.parse(Buffer.from(tokens.access_token.split(".")[1], "base64url").toString());
    expect(header.typ === "at+jwt" && header.alg === "ES256", `header ${JSON.stringify(header)}`);
    return `aud=${claims.aud} scope=${claims.scope} ttl=${claims.exp - claims.iat}s`;
  });

  await step("8 authorised tools/list and tools/call", async () => {
    const list = await rpc(mcpUrl, tokens.access_token, "tools/list");
    expect(list.status === 200, `tools/list ${list.status}`);
    const names = (await list.json()).result?.tools?.map((t) => t.name) ?? [];
    expect(names.includes("jobscout_list_sources"), `tools ${names.join(",")}`);
    const call = await rpc(mcpUrl, tokens.access_token, "tools/call", { name: "jobscout_list_sources", arguments: {} });
    expect(call.status === 200, `tools/call ${call.status}`);
    const body = await call.json();
    expect(body.result && !body.result.isError, `tool error ${JSON.stringify(body.error ?? body.result).slice(0, 160)}`);
    return `${names.length} tools`;
  });

  await step("N1 authorisation code replay is refused", async () => {
    expect(code && tokens, "needs a redeemed code from steps 6-7");
    const res = await exchange(issuer, client.client_id, code, verifier);
    const body = await res.json();
    expect(res.status === 400 && body.error === "invalid_grant", `status ${res.status} ${body.error}`);
  });

  await step("N2 PKCE plain is refused at /authorize", async () => {
    const plainVerifier = b64url(randomBytes(32));
    const res = await browser.get(await authorizeUrl(issuer, client.client_id, plainVerifier, "plain", prm.resource));
    const text = await res.text();
    const location = res.headers.get("location") ?? "";
    expect(res.status !== 200 || !/name="decision"/.test(text), "consent page shown for plain PKCE");
    expect(!/[?&]code=/.test(location), "a code was issued for plain PKCE");
    return `HTTP ${res.status}`;
  });

  await step("N3 wrong code_verifier is refused", async () => {
    const good = b64url(randomBytes(32));
    const c = await getCode(browser, issuer, client.client_id, good, prm.resource);
    const res = await exchange(issuer, client.client_id, c, b64url(randomBytes(32)));
    const body = await res.json();
    expect(res.status === 400 && body.error === "invalid_grant", `status ${res.status} ${body.error}`);
  });

  await step("N4 missing code_verifier is refused", async () => {
    const good = b64url(randomBytes(32));
    const c = await getCode(browser, issuer, client.client_id, good, prm.resource);
    const res = await exchange(issuer, client.client_id, c, undefined);
    const body = await res.json();
    expect(res.status === 400, `status ${res.status} ${body.error}`);
  });

  await step("N5 token for another audience is refused (401)", async () => {
    const res = await rpc(`http://127.0.0.1:${audPort}/mcp`, tokens.access_token, "tools/list");
    await res.arrayBuffer();
    expect(res.status === 401, `status ${res.status}`);
    expect(/invalid_token/.test(res.headers.get("www-authenticate") ?? ""), "no invalid_token challenge");
  });

  await step("N6 token missing a required scope is refused (403)", async () => {
    const res = await rpc(`http://127.0.0.1:${scopePort}/mcp`, tokens.access_token, "tools/list");
    await res.arrayBuffer();
    expect(res.status === 403, `status ${res.status}`);
    expect(/insufficient_scope/.test(res.headers.get("www-authenticate") ?? ""), "no insufficient_scope challenge");
  });

  await step("N7 tampered token is refused (401)", async () => {
    const [h, p, s] = tokens.access_token.split(".");
    const claims = JSON.parse(Buffer.from(p, "base64url").toString());
    const forged = `${h}.${b64url(Buffer.from(JSON.stringify({ ...claims, sub: "someone-else" })))}.${s}`;
    const res = await rpc(mcpUrl, forged, "tools/list");
    await res.arrayBuffer();
    expect(res.status === 401, `status ${res.status}`);
  });

  if (skipExpiry) {
    record("N8 expired token is refused (401)", true, "skipped (--skip-expiry)");
  } else {
    await step("N8 expired token is refused (401)", async () => {
      const claims = JSON.parse(Buffer.from(tokens.access_token.split(".")[1], "base64url").toString());
      const wait = Math.max(0, (claims.exp + 5 + 2) * 1000 - Date.now());
      process.stdout.write(`     waiting ${Math.ceil(wait / 1000)}s for the ${ACCESS_TTL}s access token to expire\n`);
      await new Promise((r) => setTimeout(r, wait));
      const res = await rpc(mcpUrl, tokens.access_token, "tools/list");
      await res.arrayBuffer();
      expect(res.status === 401, `status ${res.status}`);
      expect(/invalid_token/.test(res.headers.get("www-authenticate") ?? ""), "no invalid_token challenge");
    });
  }
} catch (error) {
  record("harness", false, error instanceof Error ? error.message : String(error));
} finally {
  for (const { child } of children) child.kill();
  await new Promise((r) => setTimeout(r, 300));
  rmSync(work, { recursive: true, force: true });
}

const failed = results.some((r) => !r.ok);
const summary = { passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
if (process.env.JOBSCOUT_OAUTH_E2E_OUTPUT) writeFileSync(process.env.JOBSCOUT_OAUTH_E2E_OUTPUT, `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`\n${summary.passed} passed, ${summary.failed} failed\n`);
process.exit(failed ? 1 : 0);
