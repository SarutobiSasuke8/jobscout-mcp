import assert from "node:assert/strict";
import test from "node:test";

import { LennysJobsProvider, buildSearchBody, flattenHit, parseSearchResponse } from "../src/providers/lennysjobs.js";

import type { SearchQuery } from "../src/types.js";

const query: SearchQuery = { query: "product manager", remote_only: false, limit: 25 };

function response(hits: unknown[]): unknown {
  return { results: [{ hits, nbHits: hits.length }] };
}

function jsonFetcher(payload: unknown, capture?: RequestInit[]): typeof fetch {
  return (async (_input: string, init: RequestInit) => {
    capture?.push(init);
    return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

// The partner id is what scopes the index to this board rather than to all of TrueUp. Losing it
// would silently widen the pool while still looking like a working search.
void test("the search body carries the board's partner scope and request version", () => {
  const body = JSON.parse(buildSearchBody(query, "lenny")) as Array<{ indexName: string; params: Record<string, unknown> }>;
  assert.equal(body.length, 1, "only the hit-bearing query is issued");
  assert.equal(body[0]?.indexName, "job");
  assert.equal(body[0]?.params.trueupPartnerId, "lenny");
  assert.equal(body[0]?.params.trueupRequestVersion, 2);
  assert.equal(body[0]?.params.query, "product manager");
  assert.equal(body[0]?.params.hitsPerPage, 25);
});

void test("a location becomes a facet filter, and is absent when unset", () => {
  const withLocation = JSON.parse(buildSearchBody({ ...query, location: "Ireland" }, "lenny")) as Array<{ params: { facetFilters?: string[][] } }>;
  assert.deepEqual(withLocation[0]?.params.facetFilters, [["job_locations_combined:Ireland"]]);
  const withoutLocation = JSON.parse(buildSearchBody(query, "lenny")) as Array<{ params: { facetFilters?: string[][] } }>;
  assert.equal(withoutLocation[0]?.params.facetFilters, undefined);
});

void test("hitsPerPage never exceeds the index's page ceiling", () => {
  const body = JSON.parse(buildSearchBody({ ...query, limit: 100 }, "lenny")) as Array<{ params: { hitsPerPage: number } }>;
  assert.equal(body[0]?.params.hitsPerPage, 100);
});

void test("maps a hit using the index's own field names", () => {
  const flat = flattenHit({
    objectID: "2dbd9fc9-b2df-4567-82bd-7941760549b1",
    title: "Principal Product Manager",
    company: { name: "Example Labs" },
    job_locations_combined: ["Seattle, Washington, USA", "Remote, US"],
    job_subcategories_all: ["Product Management"],
    themes: ["AI"],
    level: ["Principal"],
  });
  assert.equal(flat.title, "Principal Product Manager");
  assert.equal(flat.company, "Example Labs");
  assert.equal(flat.location, "Seattle, Washington, USA; Remote, US");
  assert.equal(flat.remote, true);
  assert.deepEqual(flat.tags, ["Product Management", "AI", "Principal"]);
  assert.equal(flat.job_url, "https://www.lennysjobs.com/jobs/2dbd9fc9-b2df-4567-82bd-7941760549b1");
});

// The board asks the index to wrap matched terms in these markers. They are presentation, and
// must never reach a normalized record.
void test("highlight markers are stripped from returned text", () => {
  const flat = flattenHit({ objectID: "1", title: "__ais-highlight__Product__/ais-highlight__ Manager", company: "Example" });
  assert.equal(flat.title, "Product Manager");
});

// A board link says where a record was found, never that the employer published it.
void test("board links stay discovery URLs unless the hit names an employer route", () => {
  const { jobs } = parseSearchResponse(response([
    { objectID: "abc123", title: "Product Manager", company: "Example Labs" },
  ]), query);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.canonical_url, undefined);
  assert.equal(jobs[0]?.provenance[0]?.discovery_url, "https://www.lennysjobs.com/jobs/abc123");
  assert.equal(jobs[0]?.provenance[0]?.provider, "lennysjobs");
  assert.equal(jobs[0]?.provenance[0]?.source_job_id, "abc123");
});

void test("an explicit employer route in the hit is kept as canonical", () => {
  const { jobs } = parseSearchResponse(response([
    { objectID: "abc123", title: "Product Manager", company: "Example Labs", job_url_direct: "https://jobs.example.com/pm" },
  ]), query);
  assert.equal(jobs[0]?.canonical_url, "https://jobs.example.com/pm");
});

void test("hits missing a title or company are rejected, not silently dropped", () => {
  const result = parseSearchResponse(response([
    { objectID: "1", title: "Product Manager", company: "Example Labs" },
    { objectID: "2", title: "Product Manager" },
  ]), query);
  assert.equal(result.jobs.length, 1);
  assert.equal(result.records_rejected, 1);
});

void test("an unexpected response shape yields nothing rather than throwing", () => {
  assert.deepEqual(parseSearchResponse({ error: "nope" }, query), { jobs: [], records_rejected: 0 });
  assert.deepEqual(parseSearchResponse(null, query), { jobs: [], records_rejected: 0 });
});

void test("a disabled provider contacts nothing", async () => {
  const provider = new LennysJobsProvider(false, undefined, undefined, undefined, 1_000, () => {
    throw new Error("must not be called");
  });
  assert.deepEqual(await provider.search(query), { jobs: [], records_rejected: 0 });
});

void test("an enabled search posts the body to the configured endpoint", async () => {
  const captured: RequestInit[] = [];
  const provider = new LennysJobsProvider(true, undefined, undefined, undefined, 1_000, jsonFetcher(response([
    { objectID: "1", title: "Product Manager", company: "Example Labs" },
  ]), captured));
  const { jobs } = await provider.search(query);
  assert.equal(jobs.length, 1);
  assert.equal(captured[0]?.method, "POST");
  assert.match(String(captured[0]?.body), /"trueupPartnerId":"lenny"/u);
});

void test("a non-OK response surfaces the status", async () => {
  const fetcher = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
  const provider = new LennysJobsProvider(true, undefined, undefined, undefined, 1_000, fetcher);
  await assert.rejects(provider.search(query), /HTTP 503/u);
});

void test("a non-JSON response is reported rather than parsed", async () => {
  const fetcher = (async () => new Response("<!doctype html>", { headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
  const provider = new LennysJobsProvider(true, undefined, undefined, undefined, 1_000, fetcher);
  await assert.rejects(provider.search(query), /did not return JSON/u);
});

void test("a non-HTTP endpoint is refused", async () => {
  const provider = new LennysJobsProvider(true, "file:///etc/passwd");
  await assert.rejects(provider.search(query), /must use http or https/u);
});
