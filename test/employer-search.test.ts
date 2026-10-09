import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { normalizeJob } from "../src/core.js";
import { createFetchHandler } from "../src/http.js";
import { ashbyVendor, defaultAshbyApiBase } from "../src/providers/ashby.js";
import { AtsBoardProvider } from "../src/providers/ats.js";
import { defaultGreenhouseApiBase, greenhouseVendor } from "../src/providers/greenhouse.js";
import { ProviderRegistry, createProviderRegistry } from "../src/registry.js";
import { employerSearchQuerySchema, employerSourceIds, searchResultSchema } from "../src/types.js";
import { searchQuery } from "./support.js";

import type { AtsBoard, AtsVendor } from "../src/providers/ats.js";
import type { JobProvider, NormalizedJob } from "../src/types.js";

// Employer ATS sources live on their own tool so a gateway that gates whole tools by name can
// offer them separately. These tests pin the split: the free search never reaches them, the
// employer search reaches nothing else, and both say so. No network: recorded fixtures only.

function fixture(name: string): string {
  return readFileSync(new URL(`../../test/fixtures/ats/${name}`, import.meta.url), "utf8");
}
const greenhouseBody = fixture("greenhouse-gitlab.json");
const ashbyBody = fixture("ashby-ramp.json");
const greenhouseUrl = `${defaultGreenhouseApiBase}/gitlab/jobs?content=true`;
const ashbyUrl = `${defaultAshbyApiBase}/ramp?includeCompensation=true`;

interface FakeFetch {
  fetcher: typeof fetch;
  urls: string[];
}

function fakeFetch(routes: Record<string, string>): FakeFetch {
  const urls: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : input.toString();
    urls.push(url);
    const body = routes[url];
    return body === undefined
      ? new Response("{\"error\":\"not found\"}", { status: 404 })
      : new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetcher, urls };
}

function ats(vendor: AtsVendor, base: string, boards: AtsBoard[], fetcher: typeof fetch): AtsBoardProvider {
  return new AtsBoardProvider(vendor, true, boards, [], base, fetcher);
}

/** An enabled open source that records whether it was asked. */
function openSource(id: string, jobs: NormalizedJob[]): JobProvider & { calls: number } {
  const source = {
    calls: 0,
    status: () => ({ id, label: id, enabled: true, authentication: "none" as const, notes: "fixture" }),
    search: async () => {
      source.calls += 1;
      return { jobs, records_rejected: 0 };
    },
  };
  return source;
}

const boardJob = normalizeJob({
  title: "Account Manager",
  company: "Board Co",
  location: "Remote",
  tags: [],
  canonical_url: "https://example.com/jobs/account-manager",
  provenance: [{ provider: "board", discovery_url: "https://example.com/jobs/account-manager", captured_at: "2026-10-08T09:00:00.000Z" }],
});

function mixedRegistry(fake: FakeFetch): { registry: ProviderRegistry; board: ReturnType<typeof openSource> } {
  const board = openSource("board", [boardJob]);
  const registry = new ProviderRegistry([
    board,
    ats(greenhouseVendor, defaultGreenhouseApiBase, [{ token: "gitlab" }], fake.fetcher),
    ats(ashbyVendor, defaultAshbyApiBase, [{ token: "ramp", company: "Ramp" }], fake.fetcher),
  ]);
  return { registry, board };
}

// ---- Registry ------------------------------------------------------------------------------

void test("list_sources names the search tool for every source", () => {
  const statuses = createProviderRegistry({}).statuses();
  for (const status of statuses) {
    const expected = (employerSourceIds as readonly string[]).includes(status.id) ? "jobscout_search_employers" : "jobscout_search_jobs";
    assert.equal(status.search_tool, expected, `${status.id} must report ${expected}`);
  }
  assert.deepEqual(
    statuses.filter((status) => status.search_tool === "jobscout_search_employers").map((status) => status.id).sort(),
    [...employerSourceIds].sort(),
  );
});

void test("the free search never contacts an enabled employer source", async () => {
  const fake = fakeFetch({ [greenhouseUrl]: greenhouseBody, [ashbyUrl]: ashbyBody });
  const { registry, board } = mixedRegistry(fake);
  const result = await registry.search(searchQuery({ query: "manager" }));
  assert.equal(board.calls, 1);
  assert.deepEqual(fake.urls, [], "no ATS board is fetched by the free search");
  assert.deepEqual(result.providers_queried, ["board"]);
  assert.deepEqual(result.providers_disabled, [], "employer sources are not reported as disabled on the free search");
  assert(result.jobs.every((job) => job.provenance.every((item) => item.provider === "board")));
  assert.equal(result.sources_elsewhere, undefined);
});

void test("the free search is the default scope", async () => {
  const fake = fakeFetch({ [greenhouseUrl]: greenhouseBody });
  const { registry } = mixedRegistry(fake);
  const implicit = await registry.search(searchQuery({ query: "manager" }));
  const explicit = await registry.search(searchQuery({ query: "manager" }), "jobscout_search_jobs");
  assert.deepEqual(implicit.providers_queried, explicit.providers_queried);
  assert.deepEqual(fake.urls, []);
});

void test("asking the free search for an employer source points to the employer tool", async () => {
  const fake = fakeFetch({ [greenhouseUrl]: greenhouseBody });
  const { registry, board } = mixedRegistry(fake);
  const result = await registry.search(searchQuery({ query: "manager", sources: ["greenhouse", "nonexistent"] }));
  assert.equal(board.calls, 0);
  assert.deepEqual(fake.urls, []);
  assert.deepEqual(result.sources_elsewhere, [{ source: "greenhouse", tool: "jobscout_search_employers" }]);
  assert.deepEqual(result.unknown_sources, ["nonexistent"], "an employer source is not an unknown source");
  assert.equal(result.setup_required, true);
  assert.match(result.message ?? "", /greenhouse \(jobscout_search_employers\)/u);
});

void test("the employer search reaches only employer sources", async () => {
  const fake = fakeFetch({ [greenhouseUrl]: greenhouseBody, [ashbyUrl]: ashbyBody });
  const { registry, board } = mixedRegistry(fake);
  const result = await registry.search(searchQuery({ query: "manager" }), "jobscout_search_employers");
  assert.equal(board.calls, 0, "an open source is never asked by the employer search");
  assert.deepEqual(result.providers_queried, ["greenhouse", "ashby"]);
  assert(result.jobs.length > 0);
  for (const job of result.jobs) {
    assert(job.provenance.every((item) => item.provider === "greenhouse" || item.provider === "ashby"));
    assert(job.canonical_url, "every employer result carries the requisition link");
  }
  assert.deepEqual(result.location_unfiltered, []);
  assert.equal(searchResultSchema.safeParse(result).success, true, "the result matches the advertised output schema");
});

void test("the employer search discloses that location was not applied upstream", async () => {
  const fake = fakeFetch({ [ashbyUrl]: ashbyBody });
  const registry = new ProviderRegistry([ats(ashbyVendor, defaultAshbyApiBase, [{ token: "ramp" }], fake.fetcher)]);
  const result = await registry.search(searchQuery({ query: "manager", location: "Dublin" }), "jobscout_search_employers");
  assert.deepEqual(result.location_unfiltered, ["ashby"]);
});

void test("the employer search with nothing enabled fails closed with employer setup guidance", async () => {
  const registry = createProviderRegistry({ JOBSCOUT_ENABLE_HIMALAYAS: "true" });
  const result = await registry.search(searchQuery(), "jobscout_search_employers");
  assert.equal(result.setup_required, true);
  assert.deepEqual(result.providers_queried, []);
  assert.deepEqual([...result.providers_disabled].sort(), [...employerSourceIds].sort(), "only employer sources are listed as disabled");
  assert.match(result.message ?? "", /GREENHOUSE_BOARDS/u);
  assert.equal(searchResultSchema.safeParse(result).success, true);
});

void test("the employer input schema accepts only employer source ids", () => {
  assert.equal(employerSearchQuerySchema.safeParse({ query: "engineer", sources: ["lever", "ashby"] }).success, true);
  assert.equal(employerSearchQuerySchema.safeParse({ query: "engineer", sources: ["himalayas"] }).success, false);
  assert.equal(employerSearchQuerySchema.safeParse({ query: "engineer", limit: 101 }).success, false);
});

// ---- MCP surface ---------------------------------------------------------------------------

const mcpHeaders = { "content-type": "application/json", accept: "application/json, text/event-stream" };

function rpc(method: string, params: Record<string, unknown> = {}, id = 1): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

async function call(registryFactory: () => ProviderRegistry, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const handle = createFetchHandler({ registryFactory });
  const response = await handle(new Request("http://localhost/mcp", { method: "POST", headers: mcpHeaders, body: rpc(method, params) }));
  assert.equal(response.status, 200);
  const body = await response.json() as { result?: Record<string, unknown> };
  assert(body.result, "the JSON-RPC response carries a result");
  return body.result;
}

interface ListedTool {
  name: string;
  inputSchema?: { properties?: Record<string, { items?: { enum?: string[] } }> };
  outputSchema?: { properties?: Record<string, unknown>; required?: string[] };
  annotations?: { readOnlyHint?: boolean };
}

void test("tools/list advertises jobscout_search_employers with input and output schemas", async () => {
  const result = await call(() => new ProviderRegistry([]), "tools/list", {});
  const tools = result.tools as ListedTool[];
  const tool = tools.find((entry) => entry.name === "jobscout_search_employers");
  assert(tool, "the employer search tool is listed");
  assert.deepEqual(tool.inputSchema?.properties?.sources?.items?.enum, [...employerSourceIds]);
  assert(tool.outputSchema?.properties?.jobs, "the output schema describes jobs");
  for (const field of ["failures", "providers_queried", "providers_disabled", "warnings", "location_unfiltered"]) {
    assert(tool.outputSchema?.required?.includes(field), `${field} is a required output field`);
  }
  assert.equal(tool.annotations?.readOnlyHint, true);
  assert(tools.some((entry) => entry.name === "jobscout_search_jobs"), "the free search is still listed");
});

void test("calling jobscout_search_employers returns employer results that pass output validation", async () => {
  const fake = fakeFetch({ [greenhouseUrl]: greenhouseBody, [ashbyUrl]: ashbyBody });
  const result = await call(() => mixedRegistry(fake).registry, "tools/call", { name: "jobscout_search_employers", arguments: { query: "manager", include_descriptions: false } });
  assert.notEqual(result.isError, true, JSON.stringify(result).slice(0, 500));
  const structured = result.structuredContent as { jobs: NormalizedJob[]; providers_queried: string[] };
  assert.deepEqual(structured.providers_queried, ["greenhouse", "ashby"]);
  assert(structured.jobs.length > 0);
  const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
  assert.match(text, /^UNTRUSTED CONTENT NOTICE/u, "the untrusted notice is the same as on the free search");
});

void test("calling jobscout_search_employers with no employer source enabled fails closed, not as an error", async () => {
  const result = await call(() => new ProviderRegistry([]), "tools/call", { name: "jobscout_search_employers", arguments: { query: "engineer" } });
  assert.notEqual(result.isError, true);
  assert.equal((result.structuredContent as { setup_required?: boolean }).setup_required, true);
});

void test("calling jobscout_search_employers with an open source id is rejected by the input schema", async () => {
  const result = await call(() => new ProviderRegistry([]), "tools/call", { name: "jobscout_search_employers", arguments: { query: "engineer", sources: ["himalayas"] } });
  assert.equal(result.isError, true);
});

void test("calling jobscout_search_jobs with employer sources enabled returns no employer results", async () => {
  const fake = fakeFetch({ [greenhouseUrl]: greenhouseBody, [ashbyUrl]: ashbyBody });
  const result = await call(() => mixedRegistry(fake).registry, "tools/call", { name: "jobscout_search_jobs", arguments: { query: "manager" } });
  const structured = result.structuredContent as { jobs: NormalizedJob[]; providers_queried: string[] };
  assert.deepEqual(structured.providers_queried, ["board"]);
  assert(structured.jobs.every((job) => job.provenance.every((item) => !(employerSourceIds as readonly string[]).includes(item.provider))));
  assert.deepEqual(fake.urls, []);
});
