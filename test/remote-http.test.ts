import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { createFetchHandler, createNodeListener, hostedEnvironment } from "../src/http.js";
import { ProviderRegistry } from "../src/registry.js";
import { VERSION } from "../src/version.js";

const registryFactory = (): ProviderRegistry => new ProviderRegistry([]);
const mcpHeaders = { "content-type": "application/json", accept: "application/json, text/event-stream" };

function rpc(method: string, params: Record<string, unknown> = {}, id = 1): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

const initialise = rpc("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "test", version: "0.0.0" },
});

void test("health reports status and version without authentication", async () => {
  const handle = createFetchHandler({ registryFactory, bearerToken: "secret" });
  const response = await handle(new Request("http://localhost/health"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok", name: "jobscout-mcp", version: VERSION, transport: "streamable-http" });
});

void test("unknown paths return 404 and health rejects writes", async () => {
  const handle = createFetchHandler({ registryFactory });
  assert.equal((await handle(new Request("http://localhost/nope"))).status, 404);
  assert.equal((await handle(new Request("http://localhost/health", { method: "POST" }))).status, 405);
});

void test("MCP endpoint answers initialize and lists tools statelessly", async () => {
  const handle = createFetchHandler({ registryFactory });
  const init = await handle(new Request("http://localhost/mcp", { method: "POST", headers: mcpHeaders, body: initialise }));
  assert.equal(init.status, 200);
  const initBody = await init.json() as { result?: { serverInfo?: { name?: string } } };
  assert.equal(initBody.result?.serverInfo?.name, "jobscout-mcp");

  const list = await handle(new Request("http://localhost/mcp", { method: "POST", headers: mcpHeaders, body: rpc("tools/list", {}, 2) }));
  assert.equal(list.status, 200);
  const listBody = await list.json() as { result?: { tools?: Array<{ name: string }> } };
  const names = (listBody.result?.tools ?? []).map((tool) => tool.name);
  assert.ok(names.includes("jobscout_search_jobs"));
  assert.ok(names.includes("jobscout_list_sources"));
});

void test("a search with no providers enabled returns setup guidance, not an empty market", async () => {
  const handle = createFetchHandler({ registryFactory });
  const call = rpc("tools/call", { name: "jobscout_search_jobs", arguments: { query: "engineer" } }, 3);
  const response = await handle(new Request("http://localhost/mcp", { method: "POST", headers: mcpHeaders, body: call }));
  const body = await response.json() as { result?: { structuredContent?: { setup_required?: boolean } } };
  assert.equal(body.result?.structuredContent?.setup_required, true);
});

void test("MCP endpoint rejects GET and DELETE in stateless mode", async () => {
  const handle = createFetchHandler({ registryFactory });
  for (const method of ["GET", "DELETE"]) {
    const response = await handle(new Request("http://localhost/mcp", { method }));
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "POST");
  }
});

void test("a malformed JSON body is rejected without a 5xx", async () => {
  const handle = createFetchHandler({ registryFactory });
  const response = await handle(new Request("http://localhost/mcp", { method: "POST", headers: mcpHeaders, body: "{not json" }));
  assert.ok(response.status >= 400 && response.status < 500);
});

void test("the optional bearer token gates MCP requests only", async () => {
  const handle = createFetchHandler({ registryFactory, bearerToken: "test-token-value" });
  const missing = await handle(new Request("http://localhost/mcp", { method: "POST", headers: mcpHeaders, body: initialise }));
  assert.equal(missing.status, 401);
  assert.match(missing.headers.get("www-authenticate") ?? "", /Bearer/u);
  const wrong = await handle(new Request("http://localhost/mcp", { method: "POST", headers: { ...mcpHeaders, authorization: "Bearer test-token-valuX" }, body: initialise }));
  assert.equal(wrong.status, 401);
  const right = await handle(new Request("http://localhost/mcp", { method: "POST", headers: { ...mcpHeaders, authorization: "Bearer test-token-value" }, body: initialise }));
  assert.equal(right.status, 200);
});

void test("hosted mode forces JobSpy off whatever the environment says", () => {
  assert.equal(hostedEnvironment({ JOBSCOUT_ENABLE_JOBSPY: "true", JOBSCOUT_ENABLE_REMOTEOK: "true" }).JOBSCOUT_ENABLE_JOBSPY, "false");
  assert.equal(hostedEnvironment({ JOBSCOUT_ENABLE_REMOTEOK: "true" }).JOBSCOUT_ENABLE_REMOTEOK, "true");
});

void test("the Node listener serves health and MCP over a real socket", async () => {
  const server = createServer(createNodeListener({ registryFactory }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    const init = await fetch(`${base}/mcp`, { method: "POST", headers: mcpHeaders, body: initialise });
    assert.equal(init.status, 200);
    const body = await init.json() as { result?: { serverInfo?: { name?: string } } };
    assert.equal(body.result?.serverInfo?.name, "jobscout-mcp");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
