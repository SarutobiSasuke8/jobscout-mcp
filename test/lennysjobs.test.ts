import assert from "node:assert/strict";
import test from "node:test";

import { LennysJobsProvider, flattenLennysJobsRecord, matchesQuery, parseLennysJobsFeed } from "../src/providers/lennysjobs.js";

import type { SearchQuery } from "../src/types.js";

const query: SearchQuery = { query: "product manager", remote_only: false, limit: 25 };

function feed(jobs: unknown[]): unknown {
  return { jobs };
}

void test("flattens the nested employer and location shape a board feed uses", () => {
  const flat = flattenLennysJobsRecord({
    id: "2dbd9fc9-b2df-4567-82bd-7941760549b1",
    title: "Product Manager, Buying Services",
    company: { name: "Example Labs" },
    location: { name: "Remote - US" },
    departments: ["Product"],
  });
  assert.equal(flat.company, "Example Labs");
  assert.equal(flat.location, "Remote - US");
  assert.equal(flat.remote, true);
  assert.equal(flat.job_url, "https://www.lennysjobs.com/jobs/2dbd9fc9-b2df-4567-82bd-7941760549b1");
});

// A board link says where a record was found, never that the employer published it. Promoting
// one to canonical_url would make the apply route in a briefing a lie.
void test("board links stay discovery URLs and an apply flow is never promoted to canonical", () => {
  const { jobs } = parseLennysJobsFeed(feed([{
    id: "abc123",
    title: "Product Manager",
    company: { name: "Example Labs" },
    apply_url: "https://www.lennysjobs.com/apply/abc123",
  }]), query);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.canonical_url, undefined);
  assert.equal(jobs[0]?.provenance[0]?.discovery_url, "https://www.lennysjobs.com/jobs/abc123");
  assert.equal(jobs[0]?.provenance[0]?.provider, "lennysjobs");
  assert.equal(jobs[0]?.provenance[0]?.source_job_id, "abc123");
});

void test("an explicit employer route in the feed is kept as canonical", () => {
  const { jobs } = parseLennysJobsFeed(feed([{
    id: "abc123",
    title: "Product Manager",
    company: { name: "Example Labs" },
    job_url_direct: "https://jobs.example.com/pm",
  }]), query);
  assert.equal(jobs[0]?.canonical_url, "https://jobs.example.com/pm");
});

// The feed is a whole-board export, not a search endpoint. Without local filtering every
// search would return the entire board.
void test("filters a whole-board feed down to the query", () => {
  const { jobs } = parseLennysJobsFeed(feed([
    { id: "1", title: "Product Manager", company: { name: "Example Labs" } },
    { id: "2", title: "Warehouse Operative", company: { name: "Other Co" } },
  ]), query);
  assert.deepEqual(jobs.map((job) => job.title), ["Product Manager"]);
});

void test("query matching ignores sub-three-character noise words", () => {
  assert.equal(matchesQuery({ title: "Growth Lead", company: "Example" }, "AI"), true, "an all-noise query must not filter everything out");
  assert.equal(matchesQuery({ title: "Growth Lead", company: "Example" }, "AI product"), false);
  assert.equal(matchesQuery({ title: "Growth Lead", company: "Example" }, "growth"), true);
  assert.equal(matchesQuery({ title: "Growth Lead", company: "Example", tags: ["Web3"] }, "web3"), true);
});

void test("records missing a title or company are rejected, not silently dropped", () => {
  const result = parseLennysJobsFeed(feed([
    { id: "1", title: "Product Manager", company: { name: "Example Labs" } },
    { id: "2", title: "Product Manager" },
  ]), query);
  assert.equal(result.jobs.length, 1);
  assert.equal(result.records_rejected, 1);
});

void test("a disabled provider contacts nothing", async () => {
  const provider = new LennysJobsProvider(false, "https://feed.example.com/jobs.json", undefined, undefined, 1_000, () => {
    throw new Error("must not be called");
  });
  assert.deepEqual(await provider.search(query), { jobs: [], records_rejected: 0 });
});

// Enabled-but-unconfigured must fail visibly. An empty success would report "searched, found
// nothing" for a source that was never contacted.
void test("enabled without a feed URL fails loudly instead of returning an empty success", async () => {
  const provider = new LennysJobsProvider(true, undefined);
  await assert.rejects(provider.search(query), /LENNYSJOBS_FEED_URL is not set/u);
});

void test("forwards the query to the feed only when a parameter name is configured", async () => {
  const requested: string[] = [];
  const fetcher = (async (input: string) => {
    requested.push(String(input));
    return new Response(JSON.stringify(feed([{ id: "1", title: "Product Manager", company: { name: "Example Labs" } }])), {
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const withParam = new LennysJobsProvider(true, "https://feed.example.com/jobs.json", undefined, "q", 1_000, fetcher);
  const { jobs } = await withParam.search(query);
  assert.equal(jobs.length, 1);
  assert.equal(requested[0], "https://feed.example.com/jobs.json?q=product+manager");

  const withoutParam = new LennysJobsProvider(true, "https://feed.example.com/jobs.json", undefined, undefined, 1_000, fetcher);
  await withoutParam.search(query);
  assert.equal(requested[1], "https://feed.example.com/jobs.json");
});

void test("an HTML response is reported as a configuration error, not parsed as jobs", async () => {
  const fetcher = (async () => new Response("<!doctype html><html></html>", { headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
  const provider = new LennysJobsProvider(true, "https://www.example.com/jobs", undefined, undefined, 1_000, fetcher);
  await assert.rejects(provider.search(query), /must point at a JSON endpoint/u);
});

void test("a non-OK feed response surfaces the status", async () => {
  const fetcher = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
  const provider = new LennysJobsProvider(true, "https://feed.example.com/jobs.json", undefined, undefined, 1_000, fetcher);
  await assert.rejects(provider.search(query), /HTTP 503/u);
});

void test("a non-HTTP feed URL is refused", async () => {
  const provider = new LennysJobsProvider(true, "file:///etc/passwd");
  await assert.rejects(provider.search(query), /must use http or https/u);
});
