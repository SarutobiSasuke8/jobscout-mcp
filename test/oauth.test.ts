import assert from "node:assert/strict";
import test from "node:test";

import { exportJWK, generateKeyPair, SignJWT } from "jose";

import { createFetchHandler } from "../src/http.js";
import {
  authorizationServerMetadataUrl,
  initialiseOAuth,
  OAuthConfigError,
  oauthConfigFromEnv,
  validateAuthorizationServerMetadata,
} from "../src/oauth.js";
import { ProviderRegistry } from "../src/registry.js";
import { newVerifier, pkceChallenge, startTestIssuer } from "./oauth-issuer.js";

import type { OAuthConfig, OAuthGuard } from "../src/oauth.js";
import type { TestIssuer } from "./oauth-issuer.js";

const registryFactory = (): ProviderRegistry => new ProviderRegistry([]);
const RESOURCE = "http://localhost/mcp";
const REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";
const mcpHeaders = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const toolsList = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });

function configFor(issuer: TestIssuer, overrides: Partial<OAuthConfig> = {}): OAuthConfig {
  return {
    mode: "required",
    issuer: issuer.issuer,
    resourceUrl: new URL(RESOURCE),
    audience: issuer.audience,
    requiredScopes: ["jobscout"],
    algorithms: ["ES256"],
    allowInsecure: true,
    ...overrides,
  };
}

async function withServer<T>(run: (ctx: { issuer: TestIssuer; guard: OAuthGuard; handle: (request: Request) => Promise<Response> }) => Promise<T>, overrides: Partial<OAuthConfig> = {}): Promise<T> {
  const issuer = await startTestIssuer();
  try {
    const guard = await initialiseOAuth(configFor(issuer, overrides));
    const handle = createFetchHandler({ registryFactory, oauth: guard });
    return await run({ issuer, guard, handle });
  } finally {
    await issuer.close();
  }
}

const callMcp = (handle: (request: Request) => Promise<Response>, token?: string): Promise<Response> =>
  handle(new Request(RESOURCE, { method: "POST", headers: { ...mcpHeaders, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: toolsList }));

void test("a client discovers the issuer from a 401, signs in with PKCE S256 and calls the MCP endpoint", async () => {
  await withServer(async ({ issuer, handle }) => {
    // 1. Unauthenticated call: 401 with an RFC 9728 pointer.
    const challenge = await callMcp(handle);
    assert.equal(challenge.status, 401);
    const header = challenge.headers.get("www-authenticate") ?? "";
    assert.match(header, /^Bearer /u);
    const metadataUrl = /resource_metadata="([^"]+)"/u.exec(header)?.[1];
    assert.equal(metadataUrl, "http://localhost/.well-known/oauth-protected-resource/mcp");

    // 2. Protected resource metadata names the issuer.
    const prm = await (await handle(new Request(metadataUrl))).json() as { resource: string; authorization_servers: string[]; scopes_supported: string[] };
    assert.equal(prm.resource, RESOURCE);
    assert.deepEqual(prm.authorization_servers, [issuer.issuer]);
    assert.deepEqual(prm.scopes_supported, ["jobscout"]);

    // 3. Authorisation server metadata from the issuer itself.
    const asMeta = await (await fetch(authorizationServerMetadataUrl(prm.authorization_servers[0] ?? ""))).json() as Record<string, string>;
    assert.deepEqual(asMeta.code_challenge_methods_supported as unknown, ["S256"]);

    // 4. Dynamic client registration as a public client.
    const registration = await fetch(asMeta.registration_endpoint ?? "", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "test client", redirect_uris: [REDIRECT] }) });
    assert.equal(registration.status, 201);
    const { client_id: clientId } = await registration.json() as { client_id: string };

    // 5. Authorisation request with PKCE S256.
    const verifier = newVerifier();
    const authorize = new URL(asMeta.authorization_endpoint ?? "");
    for (const [key, value] of Object.entries({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: pkceChallenge(verifier), code_challenge_method: "S256", state: "s1", scope: "jobscout", resource: RESOURCE })) {
      authorize.searchParams.set(key, value);
    }
    const redirect = await fetch(authorize, { redirect: "manual" });
    assert.equal(redirect.status, 302);
    const back = new URL(redirect.headers.get("location") ?? "");
    assert.equal(back.searchParams.get("state"), "s1");
    const code = back.searchParams.get("code") ?? "";
    assert.ok(code);

    // 6. Token exchange with the verifier.
    const tokenResponse = await fetch(asMeta.token_endpoint ?? "", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier, resource: RESOURCE }),
    });
    assert.equal(tokenResponse.status, 200);
    const { access_token: accessToken } = await tokenResponse.json() as { access_token: string };

    // 7. The MCP endpoint accepts the token.
    const ok = await callMcp(handle, accessToken);
    assert.equal(ok.status, 200);
    const body = await ok.json() as { result?: { tools?: Array<{ name: string }> } };
    assert.ok(body.result?.tools?.some((tool) => tool.name === "jobscout_search_jobs"));
  });
});

void test("the issuer contract refuses authorisation without S256 and token exchange with a wrong or replayed verifier", async () => {
  const issuer = await startTestIssuer();
  try {
    const registration = await fetch(`${issuer.issuer}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [REDIRECT] }) });
    const { client_id: clientId } = await registration.json() as { client_id: string };
    const authorise = async (params: Record<string, string>): Promise<URL> => {
      const url = new URL(`${issuer.issuer}/oauth/authorize`);
      for (const [key, value] of Object.entries({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, ...params })) url.searchParams.set(key, value);
      return new URL((await fetch(url, { redirect: "manual" })).headers.get("location") ?? "");
    };
    const verifier = newVerifier();
    assert.equal((await authorise({})).searchParams.get("error"), "invalid_request", "no PKCE");
    assert.equal((await authorise({ code_challenge: verifier, code_challenge_method: "plain" })).searchParams.get("error"), "invalid_request", "plain PKCE");

    const exchange = async (code: string, codeVerifier: string): Promise<Response> =>
      fetch(`${issuer.issuer}/oauth/token`, { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: codeVerifier }) });
    const first = (await authorise({ code_challenge: pkceChallenge(verifier), code_challenge_method: "S256" })).searchParams.get("code") ?? "";
    assert.equal((await exchange(first, newVerifier())).status, 400, "wrong verifier");
    const second = (await authorise({ code_challenge: pkceChallenge(verifier), code_challenge_method: "S256" })).searchParams.get("code") ?? "";
    assert.equal((await exchange(second, verifier)).status, 200);
    assert.equal((await exchange(second, verifier)).status, 400, "replayed code");
  } finally {
    await issuer.close();
  }
});

void test("protected resource and authorisation server metadata are served without a token", async () => {
  await withServer(async ({ issuer, handle }) => {
    for (const path of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"]) {
      const response = await handle(new Request(`http://localhost${path}`));
      assert.equal(response.status, 200, path);
      assert.equal(response.headers.get("access-control-allow-origin"), "*");
      const body = await response.json() as { authorization_servers: string[]; bearer_methods_supported: string[] };
      assert.deepEqual(body.authorization_servers, [issuer.issuer]);
      assert.deepEqual(body.bearer_methods_supported, ["header"]);
    }
    const asResponse = await handle(new Request("http://localhost/.well-known/oauth-authorization-server"));
    assert.equal(asResponse.status, 200);
    assert.deepEqual(await asResponse.json(), issuer.metadata);
    assert.equal((await handle(new Request("http://localhost/.well-known/oauth-authorization-server", { method: "POST" }))).status, 405);
    assert.equal((await handle(new Request("http://localhost/.well-known/oauth-protected-resource", { method: "OPTIONS" }))).status, 204);
    assert.equal((await handle(new Request("http://localhost/health"))).status, 200);
  });
});

void test("well-known paths are not served when OAuth is off", async () => {
  const handle = createFetchHandler({ registryFactory });
  assert.equal((await handle(new Request("http://localhost/.well-known/oauth-protected-resource"))).status, 404);
  assert.equal((await handle(new Request("http://localhost/.well-known/oauth-authorization-server"))).status, 404);
});

void test("token validation rejects expired, foreign, mistyped, mis-scoped and malformed tokens", async () => {
  await withServer(async ({ issuer, handle }) => {
    const now = Math.floor(Date.now() / 1000);
    const rejected: Array<[string, string, number]> = [
      ["expired", await issuer.mint({ exp: now - 60 }), 401],
      ["wrong audience", await issuer.mint({ aud: "someone-else" }), 401],
      ["wrong issuer", await issuer.mint({ iss: "https://evil.example.com" }), 401],
      ["not an access token", await issuer.mint({}, { typ: "JWT" }), 401],
      ["missing scope", await issuer.mint({ scope: "other" }), 403],
      ["garbage", "not-a-jwt", 401],
    ];
    // Signed by a key the issuer never published.
    const { privateKey } = await generateKeyPair("ES256");
    rejected.push(["unpublished key", await new SignJWT({ scope: "jobscout" }).setProtectedHeader({ alg: "ES256", kid: "test-key-1", typ: "at+jwt" }).setIssuer(issuer.issuer).setAudience(issuer.audience).setSubject("usr").setExpirationTime(now + 600).sign(privateKey), 401]);
    // Symmetric algorithm confusion: HS256 keyed with the public JWK.
    const { publicKey } = await generateKeyPair("ES256");
    const secret = new TextEncoder().encode(JSON.stringify(await exportJWK(publicKey)));
    rejected.push(["HS256", await new SignJWT({ scope: "jobscout" }).setProtectedHeader({ alg: "HS256", typ: "at+jwt" }).setIssuer(issuer.issuer).setAudience(issuer.audience).setSubject("usr").setExpirationTime(now + 600).sign(secret), 401]);
    // Tampered payload.
    const good = await issuer.mint();
    const [head, , signature] = good.split(".");
    const forged = Buffer.from(JSON.stringify({ iss: issuer.issuer, aud: issuer.audience, sub: "admin", scope: "jobscout", plan: "pro", exp: now + 600 })).toString("base64url");
    rejected.push(["tampered", `${head}.${forged}.${signature}`, 401]);

    for (const [label, token, status] of rejected) {
      const response = await callMcp(handle, token);
      assert.equal(response.status, status, label);
      assert.match(response.headers.get("www-authenticate") ?? "", /resource_metadata=/u, label);
    }

    const noSub = await callMcp(handle, await issuer.mint({}, { omitSubject: true }));
    assert.equal(noSub.status, 401);

    const basic = await handle(new Request(RESOURCE, { method: "POST", headers: { ...mcpHeaders, authorization: "Basic dXNlcjpwYXNz" }, body: toolsList }));
    assert.equal(basic.status, 401);

    assert.equal((await callMcp(handle, await issuer.mint())).status, 200);
  });
});

void test("a token's subject, plan and scopes reach the request as AuthInfo", async () => {
  await withServer(async ({ issuer, guard }) => {
    const token = await issuer.mint({ sub: "usr_42", plan: "pro", client_id: "cli_9" });
    const info = await guard.authenticate(new Request(RESOURCE, { method: "POST", headers: { authorization: `Bearer ${token}` } }));
    assert.ok(!(info instanceof Response));
    assert.equal(info.clientId, "cli_9");
    assert.deepEqual(info.scopes, ["jobscout"]);
    assert.deepEqual(info.extra, { subject: "usr_42", plan: "pro" });
    assert.equal(typeof info.expiresAt, "number");
  });
});

const goodMetadata = {
  issuer: "https://auth.example.com",
  authorization_endpoint: "https://auth.example.com/oauth/authorize",
  token_endpoint: "https://auth.example.com/oauth/token",
  registration_endpoint: "https://auth.example.com/oauth/register",
  jwks_uri: "https://auth.example.com/.well-known/jwks.json",
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"],
};
const strict = { issuer: "https://auth.example.com", allowInsecure: false };

void test("issuer metadata must enforce authorisation code with PKCE S256 only", () => {
  assert.equal(validateAuthorizationServerMetadata(goodMetadata, strict).issuer, "https://auth.example.com");
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ["plain PKCE", { code_challenge_methods_supported: ["S256", "plain"] }, /must not include plain/u],
    ["no PKCE", { code_challenge_methods_supported: undefined }, /must include S256/u],
    ["issuer mismatch", { issuer: "https://other.example.com" }, /issuer is/u],
    ["implicit grant", { grant_types_supported: ["authorization_code", "implicit"] }, /must not include implicit/u],
    ["implicit response", { response_types_supported: ["code", "token"] }, /must not offer implicit/u],
    ["no grant list", { grant_types_supported: undefined }, /stated explicitly/u],
    ["no registration", { registration_endpoint: undefined }, /registration_endpoint/u],
    ["http token endpoint", { token_endpoint: "http://auth.example.com/oauth/token" }, /token_endpoint must use https/u],
    ["no jwks", { jwks_uri: undefined }, /jwks_uri is missing/u],
  ];
  for (const [label, override, pattern] of cases) {
    assert.throws(() => validateAuthorizationServerMetadata({ ...goodMetadata, ...override }, strict), (error: unknown) => error instanceof OAuthConfigError && pattern.test(error.message), label);
  }
  // A client ID metadata document can stand in for dynamic registration.
  assert.doesNotThrow(() => validateAuthorizationServerMetadata({ ...goodMetadata, registration_endpoint: undefined, client_id_metadata_document_supported: true }, strict));
  assert.throws(() => validateAuthorizationServerMetadata("nope", strict), OAuthConfigError);
});

void test("startup fails closed when the issuer is unreachable, non-compliant or publishes no keys", async () => {
  const plain = await startTestIssuer({ metadataOverrides: { code_challenge_methods_supported: ["plain", "S256"] } });
  try {
    await assert.rejects(initialiseOAuth(configFor(plain)), /must not include plain/u);
  } finally {
    await plain.close();
  }
  const noKeys = await startTestIssuer({ metadataOverrides: {} });
  try {
    const fakeFetch: typeof fetch = async (input, init) => (String(input).endsWith("jwks.json") ? new Response(JSON.stringify({ keys: [] })) : fetch(input, init));
    await assert.rejects(initialiseOAuth(configFor(noKeys), fakeFetch), /published no keys/u);
  } finally {
    await noKeys.close();
  }
  await assert.rejects(initialiseOAuth({ ...configFor(noKeys), issuer: "http://127.0.0.1:9" }), /metadata fetch failed/u);
});

void test("OAuth configuration comes from environment variable names only and rejects partial settings", () => {
  assert.equal(oauthConfigFromEnv({}), undefined);
  const config = oauthConfigFromEnv({ JOBSCOUT_OAUTH_ISSUER: "https://auth.example.com", JOBSCOUT_OAUTH_RESOURCE_URL: "https://jobs.example.com/mcp", JOBSCOUT_OAUTH_AUDIENCE: "mcp-host-gateway" });
  assert.equal(config?.audience, "mcp-host-gateway");
  assert.deepEqual(config?.requiredScopes, ["jobscout"]);
  assert.deepEqual(config?.algorithms, ["ES256"]);
  assert.equal(oauthConfigFromEnv({ JOBSCOUT_OAUTH_ISSUER: "https://auth.example.com", JOBSCOUT_OAUTH_RESOURCE_URL: "https://jobs.example.com/mcp" })?.audience, "https://jobs.example.com/mcp");
  assert.throws(() => oauthConfigFromEnv({ JOBSCOUT_OAUTH_ISSUER: "https://auth.example.com" }), /RESOURCE_URL is required/u);
  assert.throws(() => oauthConfigFromEnv({ JOBSCOUT_OAUTH_RESOURCE_URL: "https://jobs.example.com/mcp" }), /ISSUER is required/u);
  assert.throws(() => oauthConfigFromEnv({ JOBSCOUT_OAUTH_ISSUER: "http://auth.example.com", JOBSCOUT_OAUTH_RESOURCE_URL: "https://jobs.example.com/mcp" }), /must use https/u);
  assert.throws(() => oauthConfigFromEnv({ JOBSCOUT_OAUTH_ISSUER: "http://auth.example.com", JOBSCOUT_OAUTH_RESOURCE_URL: "https://jobs.example.com/mcp", JOBSCOUT_OAUTH_ALLOW_INSECURE: "true" }), /only on loopback/u);
  assert.throws(() => oauthConfigFromEnv({ JOBSCOUT_OAUTH_ISSUER: "https://auth.example.com", JOBSCOUT_OAUTH_RESOURCE_URL: "https://jobs.example.com/mcp", JOBSCOUT_OAUTH_ALGORITHMS: "HS256" }), /asymmetric/u);
  assert.equal(authorizationServerMetadataUrl("https://auth.example.com/tenant/").href, "https://auth.example.com/.well-known/oauth-authorization-server/tenant");
});

void test("OAuth and the shared bearer token cannot be combined", async () => {
  await withServer(async ({ guard }) => {
    assert.throws(() => createFetchHandler({ registryFactory, oauth: guard, bearerToken: "x".repeat(32) }), /not both/u);
  });
});

void test("required mode declares oauth2 on every tool", async () => {
  await withServer(async ({ issuer, handle }) => {
    const body = await (await callMcp(handle, await issuer.mint())).json() as { result?: { tools?: Array<{ name: string; _meta?: { securitySchemes?: unknown } }> } };
    const tools = body.result?.tools ?? [];
    assert.ok(tools.length > 0);
    for (const tool of tools) assert.deepEqual(tool._meta?.securitySchemes, [{ type: "oauth2", scopes: ["jobscout"] }], tool.name);
  });
});

void test("optional mode serves anonymous calls but still rejects a bad token", async () => {
  await withServer(async ({ issuer, handle }) => {
    const anonymous = await callMcp(handle);
    assert.equal(anonymous.status, 200);
    const body = await anonymous.json() as { result?: { tools?: Array<{ _meta?: { securitySchemes?: unknown } }> } };
    assert.deepEqual(body.result?.tools?.[0]?._meta?.securitySchemes, [{ type: "noauth" }, { type: "oauth2", scopes: ["jobscout"] }]);
    assert.equal((await callMcp(handle, "not-a-jwt")).status, 401);
    assert.equal((await callMcp(handle, await issuer.mint({ aud: "someone-else" }))).status, 401);
    assert.equal((await callMcp(handle, await issuer.mint())).status, 200);
    assert.equal((await handle(new Request("http://localhost/.well-known/oauth-protected-resource"))).status, 200);
  }, { mode: "optional" });
  assert.throws(() => oauthConfigFromEnv({ JOBSCOUT_OAUTH_ISSUER: "https://auth.example.com", JOBSCOUT_OAUTH_RESOURCE_URL: "https://jobs.example.com/mcp", JOBSCOUT_OAUTH_MODE: "sometimes" }), /required or optional/u);
  assert.equal(oauthConfigFromEnv({ JOBSCOUT_OAUTH_ISSUER: "https://auth.example.com", JOBSCOUT_OAUTH_RESOURCE_URL: "https://jobs.example.com/mcp" })?.mode, "required");
});
