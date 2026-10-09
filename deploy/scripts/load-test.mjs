#!/usr/bin/env node
/**
 * Local load script for the proxy limits. Sends MCP tools/list calls (cheap: no job source is
 * contacted) to <baseUrl>/mcp and counts status codes, then sends one oversized body to check
 * the request-size cap.
 *
 * Usage:
 *   node deploy/scripts/load-test.mjs <baseUrl> [--requests 80] [--concurrency 8]
 *        [--expect-limit 60] [--oversize-bytes 131072] [--insecure]
 *
 * With --expect-limit N the run fails unless exactly N calls succeed and every other call gets
 * 429 with a Retry-After header. The size check runs first and spends one event of the
 * window. Use it against a fresh proxy (the window is sliding), and never against a production
 * host you share with real users. The base URL must be the first argument.
 */

const args = process.argv.slice(2);
const base = args[0]?.startsWith("--") ? undefined : args[0];
function option(name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? Number(args[index + 1]) : fallback;
}
const total = option("requests", 80);
const concurrency = option("concurrency", 8);
const expectLimit = option("expect-limit", undefined);
const oversizeBytes = option("oversize-bytes", 128 * 1024);
if (args.includes("--insecure")) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

if (!base) {
  console.error("Usage: node deploy/scripts/load-test.mjs <baseUrl> [--requests N] [--concurrency N] [--expect-limit N] [--oversize-bytes N]");
  process.exit(2);
}

const endpoint = new URL("mcp", base.endsWith("/") ? base : `${base}/`);
const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const statuses = new Map();
let retryAfterMissing = 0;
let firstLimitedAt;
let next = 0;

async function one(index) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: index, method: "tools/list", params: {} }),
    signal: AbortSignal.timeout(30_000),
  });
  await response.arrayBuffer();
  statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1);
  if (response.status === 429) {
    firstLimitedAt ??= index + 1;
    if (!response.headers.get("retry-after")) retryAfterMissing += 1;
  }
}

async function worker() {
  while (next < total) {
    const index = next++;
    try {
      await one(index);
    } catch (error) {
      statuses.set("error", (statuses.get("error") ?? 0) + 1);
      console.error(`request ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

// The oversized call goes first: once the window is spent it would get 429 instead of 413.
// It still counts as one event against the per-IP window, so it is subtracted below.
let failed = false;
let oversizeSent = 0;
if (oversizeBytes > 0) {
  // A syntactically valid JSON-RPC body padded past the cap, so only the size can reject it.
  const padding = "x".repeat(oversizeBytes);
  const body = JSON.stringify({ jsonrpc: "2.0", id: "oversize", method: "tools/list", params: { _meta: { padding } } });
  const response = await fetch(endpoint, { method: "POST", headers, body, signal: AbortSignal.timeout(30_000) });
  await response.arrayBuffer();
  const pass = response.status === 413;
  console.log(`${pass ? "PASS" : "FAIL"}  request-size cap: ${body.length} byte body returned HTTP ${response.status} (expected 413)`);
  failed ||= !pass;
  oversizeSent = 1;
}

const started = Date.now();
await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()));
const elapsed = Date.now() - started;

const ok = statuses.get(200) ?? 0;
const limited = statuses.get(429) ?? 0;
console.log(`POST ${endpoint.href} x ${total} (concurrency ${concurrency}) in ${elapsed} ms`);
console.log(`status counts: ${JSON.stringify(Object.fromEntries(statuses))}`);
console.log(`first 429 at request #${firstLimitedAt ?? "none"}; 429 responses missing Retry-After: ${retryAfterMissing}`);

if (expectLimit !== undefined) {
  const allowed = expectLimit - oversizeSent;
  const pass = ok === allowed && limited === total - allowed && retryAfterMissing === 0;
  console.log(`${pass ? "PASS" : "FAIL"}  rate limit: expected ${allowed} x 200 and ${total - allowed} x 429 (limit ${expectLimit}, ${oversizeSent} spent on the size check), got ${ok} x 200 and ${limited} x 429`);
  failed ||= !pass;
}

process.exit(failed ? 1 : 0);
