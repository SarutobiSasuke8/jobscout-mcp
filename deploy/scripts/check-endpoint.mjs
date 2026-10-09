#!/usr/bin/env node
/**
 * External operator check for a JobScout Discover deployment.
 *
 * Checks, from outside the host: the end-to-end health route, the landing, privacy and terms
 * pages, an MCP initialize and tools/list through the proxy, the stateless 405 on GET /mcp,
 * the 404 fallback, and (for https) the certificate's remaining validity.
 *
 * Uses about ten requests, well under the documented per-IP limits.
 *
 * Usage: node deploy/scripts/check-endpoint.mjs <baseUrl> [--insecure] [--min-cert-days 14]
 *   e.g. node deploy/scripts/check-endpoint.mjs https://jobscout.mcprack.dev
 * Exit code 0 when every check passes, 1 otherwise.
 */

import { connect } from "node:tls";

const args = process.argv.slice(2);
const base = args.find((arg) => !arg.startsWith("--"));
const insecure = args.includes("--insecure");
const minDaysIndex = args.indexOf("--min-cert-days");
const minCertDays = minDaysIndex >= 0 ? Number(args[minDaysIndex + 1]) : 14;

if (!base) {
  console.error("Usage: node deploy/scripts/check-endpoint.mjs <baseUrl> [--insecure] [--min-cert-days N]");
  process.exit(2);
}
if (insecure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const root = new URL(base.endsWith("/") ? base : `${base}/`);
const mcpHeaders = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

async function check(name, fn) {
  try {
    const detail = await fn();
    record(name, true, detail);
  } catch (error) {
    record(name, false, error instanceof Error ? error.message : String(error));
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

async function get(path) {
  return fetch(new URL(path, root), { signal: AbortSignal.timeout(15_000), redirect: "manual" });
}

async function rpc(method, params, id) {
  const response = await fetch(new URL("mcp", root), {
    method: "POST",
    headers: mcpHeaders,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  expect(response.status === 200, `HTTP ${response.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

async function page(path, marker) {
  const response = await get(path);
  const text = await response.text();
  expect(response.status === 200, `HTTP ${response.status}`);
  expect((response.headers.get("content-type") ?? "").includes("text/html"), `content-type ${response.headers.get("content-type")}`);
  expect(text.includes(marker), `missing "${marker}"`);
  expect(!text.includes("{{"), "template not rendered");
  return `${text.length} bytes`;
}

await check("GET /health", async () => {
  const response = await get("health");
  const body = await response.json();
  expect(response.status === 200 && body.status === "ok", `HTTP ${response.status} ${JSON.stringify(body)}`);
  return `version ${body.version}`;
});
await check("GET /", () => page("", "JobScout Discover"));
await check("GET /privacy", () => page("privacy", "Privacy policy"));
await check("GET /terms", () => page("terms", "Terms of service"));
await check("POST /mcp initialize", async () => {
  const body = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "jobscout-endpoint-check", version: "1.0.0" } }, 1);
  expect(body.result?.serverInfo?.name === "jobscout-mcp", JSON.stringify(body).slice(0, 200));
  return `protocol ${body.result.protocolVersion}`;
});
await check("POST /mcp tools/list", async () => {
  const body = await rpc("tools/list", {}, 2);
  const names = (body.result?.tools ?? []).map((tool) => tool.name);
  expect(names.includes("jobscout_search_jobs"), `tools: ${names.join(", ")}`);
  return `${names.length} tools`;
});
await check("GET /mcp returns 405", async () => {
  const response = await get("mcp");
  expect(response.status === 405, `HTTP ${response.status}`);
});
await check("unknown path returns 404", async () => {
  const response = await get("definitely-not-a-route");
  expect(response.status === 404, `HTTP ${response.status}`);
});

if (root.protocol === "https:") {
  await check("TLS certificate validity", () => new Promise((resolve, reject) => {
    const socket = connect({ host: root.hostname, port: Number(root.port || 443), servername: root.hostname, rejectUnauthorized: !insecure }, () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      const days = Math.floor((new Date(cert.valid_to).getTime() - Date.now()) / 86_400_000);
      if (days < minCertDays) reject(new Error(`expires in ${days} days (${cert.valid_to}), below ${minCertDays}`));
      else resolve(`${days} days left, issuer ${cert.issuer?.O ?? cert.issuer?.CN ?? "unknown"}`);
    });
    socket.setTimeout(10_000, () => socket.destroy(new Error("TLS handshake timed out")));
    socket.on("error", reject);
  }));
}

const failed = results.filter((result) => !result.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed against ${root.origin}`);
process.exit(failed ? 1 : 0);
