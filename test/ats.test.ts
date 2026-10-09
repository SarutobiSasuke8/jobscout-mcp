import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { ashbyVendor, defaultAshbyApiBase, parseAshbyBoard } from "../src/providers/ashby.js";
import { AtsBoardProvider, atsMaxResponseBytes, maxBoardsPerProvider, resolveBoardList } from "../src/providers/ats.js";
import { defaultGreenhouseApiBase, greenhouseVendor, parseGreenhouseBoard } from "../src/providers/greenhouse.js";
import { mapUnknownJob } from "../src/providers/helpers.js";
import { ResponseCache } from "../src/providers/http.js";
import { defaultLeverApiBase, leverVendor, parseLeverBoard } from "../src/providers/lever.js";
import { ProviderRegistry, createAtsProvider, createProviderRegistry } from "../src/registry.js";
import { searchQuery } from "./support.js";

import type { AtsBoard, AtsVendor } from "../src/providers/ats.js";
import type { UnknownRecord } from "../src/providers/helpers.js";
import type { NormalizedJob } from "../src/types.js";

// Recorded from each vendor's public job-board endpoint on 2026-10-08, trimmed to three
// postings each with descriptions shortened. Tests never touch the network.
function fixture(name: string): string {
  return readFileSync(new URL(`../../test/fixtures/ats/${name}`, import.meta.url), "utf8");
}
const greenhouseBody = fixture("greenhouse-gitlab.json");
const leverBody = fixture("lever-spotify.json");
const ashbyBody = fixture("ashby-ramp.json");

/** Map parsed records through the same normalisation the provider uses, without fetching. */
function jobsFrom(provider: string, records: UnknownRecord[]): NormalizedJob[] {
  return records.map((record) => {
    const job = mapUnknownJob(provider, record);
    assert(job, `record failed normalisation: ${JSON.stringify(record).slice(0, 200)}`);
    return job;
  });
}

interface FakeFetch {
  fetcher: typeof fetch;
  urls: string[];
}

/** Serve recorded bodies by URL; anything unrecognised is a 404, as the vendors answer. */
function fakeFetch(routes: Record<string, () => Response>): FakeFetch {
  const urls: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : input.toString();
    urls.push(url);
    const route = routes[url];
    return route ? route() : new Response("{\"ok\":false,\"error\":\"Document not found\"}", { status: 404 });
  }) as typeof fetch;
  return { fetcher, urls };
}

function json(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

function provider(vendor: AtsVendor, base: string, boards: AtsBoard[], fetcher: typeof fetch, options: { enabled?: boolean; cache?: ResponseCache } = {}): AtsBoardProvider {
  return new AtsBoardProvider(vendor, options.enabled ?? true, boards, [], base, fetcher, options.cache);
}

const greenhouseUrl = `${defaultGreenhouseApiBase}/gitlab/jobs?content=true`;
const leverUrl = `${defaultLeverApiBase}/spotify?mode=json`;
const ashbyUrl = `${defaultAshbyApiBase}/ramp?includeCompensation=true`;

// ---- Greenhouse mapping -------------------------------------------------------------------

void test("Greenhouse: maps the recorded board into normalised jobs with requisition provenance", () => {
  const { records, rejected } = parseGreenhouseBoard(JSON.parse(greenhouseBody), { token: "gitlab" });
  assert.equal(rejected, 0);
  const jobs = jobsFrom("greenhouse", records);
  assert.equal(jobs.length, 3);
  const france = jobs.find((job) => job.title === "Account Executive - France");
  assert(france);
  assert.equal(france.company, "GitLab", "the payload's company_name is used when no label is configured");
  assert.equal(france.location, "Remote, France");
  assert.equal(france.remote, true);
  assert.equal(france.date_posted, "2026-10-02");
  assert.equal(france.canonical_url, "https://job-boards.greenhouse.io/gitlab/jobs/8860302002");
  assert.equal(france.provenance[0]?.provider, "greenhouse");
  assert.equal(france.provenance[0]?.discovery_url, "https://job-boards.greenhouse.io/gitlab/jobs/8860302002");
  assert.equal(france.provenance[0]?.source_job_id, "8860302002");
  assert.match(france.provenance[0]?.captured_at ?? "", /^\d{4}-\d{2}-\d{2}T/u);
  assert.deepEqual(france.tags, ["EMEA - Commercial"]);
});

void test("Greenhouse: escaped HTML content becomes plain text", () => {
  const { records } = parseGreenhouseBoard(JSON.parse(greenhouseBody), { token: "gitlab" });
  const description = jobsFrom("greenhouse", records)[0]?.description ?? "";
  assert.match(description, /^GitLab is the intelligent orchestration platform/u);
  assert.doesNotMatch(description, /<|&lt;|&gt;/u);
});

void test("Greenhouse: a location without 'remote' is left unknown, not asserted on-site", () => {
  const { records } = parseGreenhouseBoard(JSON.parse(greenhouseBody), { token: "gitlab" });
  const bangalore = jobsFrom("greenhouse", records).find((job) => job.location === "Bangalore, India");
  assert.equal(bangalore?.remote, undefined);
});

void test("Greenhouse: an operator label overrides the payload's company name", () => {
  const { records } = parseGreenhouseBoard(JSON.parse(greenhouseBody), { token: "gitlab", company: "GitLab Inc." });
  assert.equal(jobsFrom("greenhouse", records)[0]?.company, "GitLab Inc.");
});

void test("Greenhouse: unreadable postings are counted and an unexpected shape fails the board", () => {
  const { records, rejected } = parseGreenhouseBoard({ jobs: [{ title: "No URL" }, "not an object"] }, { token: "x" });
  assert.equal(records.length, 0);
  assert.equal(rejected, 2);
  assert.throws(() => parseGreenhouseBoard([], { token: "x" }), /unexpected payload shape/u);
});

// ---- Lever mapping ------------------------------------------------------------------------

void test("Lever: maps the recorded site, with the configured label as employer", () => {
  const { records, rejected } = parseLeverBoard(JSON.parse(leverBody), { token: "spotify", company: "Spotify" });
  assert.equal(rejected, 0);
  const jobs = jobsFrom("lever", records);
  assert.equal(jobs.length, 3);
  const android = jobs.find((job) => job.title === "Android Engineer - Experience");
  assert(android);
  assert.equal(android.company, "Spotify");
  assert.equal(android.location, "London; Stockholm", "every listed location is kept");
  assert.equal(android.remote, false, "hybrid is not remote");
  assert.equal(android.employment_type, "Permanent");
  assert.equal(android.date_posted, new Date(1_782_214_185_805).toISOString().slice(0, 10));
  assert.equal(android.canonical_url, "https://jobs.lever.co/spotify/2193db3f-77c5-43b8-b030-8f92c9882bf1");
  assert.equal(android.provenance[0]?.source_job_id, "2193db3f-77c5-43b8-b030-8f92c9882bf1");
  assert.deepEqual(android.tags, ["Experience", "Engineering"]);
  assert.equal(jobs.find((job) => job.title.startsWith("Associate"))?.remote, true);
});

void test("Lever: without a label the site token stands in for the employer", () => {
  const { records } = parseLeverBoard(JSON.parse(leverBody), { token: "spotify" });
  assert.equal(jobsFrom("lever", records)[0]?.company, "Spotify");
});

// None of the recorded sites published a salaryRange; this hand-labelled posting follows the
// documented shape so the mapping is still pinned.
void test("Lever: a published salary range is mapped with its currency and interval", () => {
  const { records } = parseLeverBoard([{
    id: "0b1c2d3e-0000-4000-8000-000000000001",
    text: "Engineer",
    hostedUrl: "https://jobs.lever.co/example/0b1c2d3e-0000-4000-8000-000000000001",
    categories: { location: "Dublin" },
    salaryRange: { min: 60_000, max: 80_000, currency: "EUR", interval: "per-year-salary" },
  }], { token: "example" });
  assert.deepEqual(jobsFrom("lever", records)[0]?.salary, { min: 60_000, max: 80_000, currency: "EUR", interval: "year" });
});

void test("Lever: an error object instead of an array fails the site", () => {
  assert.throws(() => parseLeverBoard({ ok: false, error: "Document not found" }, { token: "x" }), /unexpected payload shape/u);
});

// ---- Ashby mapping ------------------------------------------------------------------------

void test("Ashby: maps the recorded board, including compensation", () => {
  const { records, rejected } = parseAshbyBoard(JSON.parse(ashbyBody), { token: "ramp", company: "Ramp" });
  assert.equal(rejected, 0);
  const jobs = jobsFrom("ashby", records);
  assert.equal(jobs.length, 3);
  const security = jobs.find((job) => job.title === "Security Engineer, Cloud");
  assert(security, "leading whitespace in the source title is compacted");
  assert.equal(security.company, "Ramp");
  assert.equal(security.employment_type, "full-time");
  assert.equal(security.remote, true, "a hybrid role with a remote location is open to remote applicants");
  assert.equal(security.location, "New York, NY (HQ); Remote (Canada); Remote (US); Miami, FL");
  assert.deepEqual(security.salary, { min: 211_400, max: 290_600, currency: "USD", interval: "year" });
  assert.equal(security.date_posted, "2026-04-07");
  assert.equal(security.canonical_url, "https://jobs.ashbyhq.com/ramp/34413f8d-26bf-4bbc-8ade-eb309a0e2245");
  assert.equal(jobs.find((job) => job.title === "Product Manager | Growth")?.remote, false);
});

void test("Ashby: unlisted postings are skipped without counting as rejections", () => {
  const payload = JSON.parse(ashbyBody) as { jobs: UnknownRecord[] };
  const first = payload.jobs[0];
  assert(first);
  payload.jobs.push({ ...first, id: "11111111-1111-4111-8111-111111111111", isListed: false });
  payload.jobs.push({ title: "Broken" });
  const { records, rejected } = parseAshbyBoard(payload, { token: "ramp" });
  assert.equal(records.length, 3);
  assert.equal(rejected, 1, "only the genuinely unreadable posting counts");
});

// ---- Board configuration ------------------------------------------------------------------

void test("board lists accept tokens and labels, and refuse anything path-shaped", () => {
  const { boards, ignored } = resolveBoardList(" gitlab , acme=Acme Corp , ../admin, a/b, https://evil.example, GitLab ,,");
  assert.deepEqual(boards, [{ token: "gitlab" }, { token: "acme", company: "Acme Corp" }]);
  assert.deepEqual(ignored, ["../admin", "a/b", "https://evil.example", "GitLab"]);
  assert.deepEqual(resolveBoardList(undefined), { boards: [], ignored: [] });
});

void test("board lists are capped per provider", () => {
  const list = Array.from({ length: maxBoardsPerProvider + 3 }, (_, index) => `board${index}`).join(",");
  const { boards, ignored } = resolveBoardList(list);
  assert.equal(boards.length, maxBoardsPerProvider);
  assert.equal(ignored.length, 3);
});

// ---- Provider behaviour -------------------------------------------------------------------

void test("ATS providers are disabled by default and contact nothing", async () => {
  const fake = fakeFetch({});
  for (const vendor of [greenhouseVendor, ashbyVendor, leverVendor]) {
    const off = createAtsProvider(vendor, "https://example.test", {}, undefined, fake.fetcher);
    assert.equal(off.status().enabled, false);
    assert.deepEqual(await off.search(searchQuery()), { jobs: [], records_rejected: 0 });
  }
  assert.equal(fake.urls.length, 0);
});

void test("the enable flag alone does not enable a provider with no boards", () => {
  const status = createAtsProvider(greenhouseVendor, defaultGreenhouseApiBase, { JOBSCOUT_ENABLE_GREENHOUSE: "true" }).status();
  assert.equal(status.enabled, false);
  assert.match(status.notes, /No boards configured; set GREENHOUSE_BOARDS/u);
});

void test("status discloses the host contacted, the boards and the terms page", () => {
  const status = createAtsProvider(leverVendor, defaultLeverApiBase, {
    JOBSCOUT_ENABLE_LEVER: "true",
    LEVER_SITES: "spotify=Spotify,bad/token",
    LEVER_API_BASE: "https://api.eu.lever.co/v0/postings",
  }).status();
  assert.equal(status.enabled, true);
  assert.equal(status.location_filtering, "none");
  assert.match(status.notes, /api\.eu\.lever\.co/u);
  assert.match(status.notes, /Configured boards: spotify\./u);
  assert.match(status.notes, /Ignored entries: bad\/token\./u);
  assert.match(status.notes, /https:\/\/github\.com\/lever\/postings-api/u);
});

void test("search fetches each board from the public endpoint and ranks by query", async () => {
  const fake = fakeFetch({ [greenhouseUrl]: () => json(greenhouseBody) });
  const result = await provider(greenhouseVendor, defaultGreenhouseApiBase, [{ token: "gitlab" }], fake.fetcher).search(searchQuery({ query: "engineering director" }));
  assert.deepEqual(fake.urls, [greenhouseUrl]);
  assert.equal(result.jobs[0]?.title, "Director, Engineering, Platform Operations & Productivity");
  assert.equal(result.records_rejected, 0);
});

void test("the configured API base is honoured, so Lever's EU host works", async () => {
  const euBase = "https://api.eu.lever.co/v0/postings";
  const fake = fakeFetch({ [`${euBase}/spotify?mode=json`]: () => json(leverBody) });
  const result = await provider(leverVendor, euBase, [{ token: "spotify" }], fake.fetcher).search(searchQuery({ query: "engineer" }));
  assert.equal(result.jobs.length, 1);
});

void test("one failing board is a warning, not a provider failure", async () => {
  const fake = fakeFetch({ [ashbyUrl]: () => json(ashbyBody) });
  const result = await provider(ashbyVendor, defaultAshbyApiBase, [{ token: "ramp" }, { token: "missing" }], fake.fetcher).search(searchQuery({ query: "manager" }));
  assert.equal(result.jobs.length, 2);
  assert.equal(result.warnings?.length, 1);
  assert.match(result.warnings?.[0] ?? "", /Ashby board missing: Ashby board "missing" HTTP 404; that employer's openings are missing/u);
});

void test("every board failing is reported as a provider failure through the registry", async () => {
  const fake = fakeFetch({});
  const registry = new ProviderRegistry([provider(leverVendor, defaultLeverApiBase, [{ token: "nobody" }], fake.fetcher)]);
  const result = await registry.search(searchQuery(), "jobscout_search_employers");
  assert.equal(result.jobs.length, 0);
  assert.equal(result.failures[0]?.provider, "lever");
  assert.match(result.failures[0]?.error ?? "", /every configured board failed/u);
});

void test("invalid JSON from a board fails that board", async () => {
  const fake = fakeFetch({ [greenhouseUrl]: () => json("<html>maintenance</html>") });
  await assert.rejects(
    provider(greenhouseVendor, defaultGreenhouseApiBase, [{ token: "gitlab" }], fake.fetcher).search(searchQuery()),
    /not valid JSON/u,
  );
});

void test("the shared byte cap applies to board responses", async () => {
  const fake = fakeFetch({ [greenhouseUrl]: () => new Response("x", { headers: { "content-length": String(atsMaxResponseBytes + 1) } }) });
  await assert.rejects(
    provider(greenhouseVendor, defaultGreenhouseApiBase, [{ token: "gitlab" }], fake.fetcher).search(searchQuery()),
    /safety limit/u,
  );
});

void test("board responses are served from the shared response cache within the TTL", async () => {
  const fake = fakeFetch({ [ashbyUrl]: () => json(ashbyBody) });
  const ashby = provider(ashbyVendor, defaultAshbyApiBase, [{ token: "ramp" }], fake.fetcher, { cache: new ResponseCache(60_000) });
  await ashby.search(searchQuery({ query: "engineer" }));
  await ashby.search(searchQuery({ query: "manager" }));
  assert.equal(fake.urls.length, 1);
});

// ---- Registry integration -----------------------------------------------------------------

void test("list_sources reports the three ATS providers, disabled by default", () => {
  const statuses = createProviderRegistry({}).statuses();
  for (const id of ["greenhouse", "ashby", "lever"]) {
    const status = statuses.find((entry) => entry.id === id);
    assert(status, `${id} must be listed`);
    assert.equal(status.enabled, false);
    assert.equal(status.authentication, "none");
    assert.equal(status.transport, "http-api");
  }
});

void test("list_sources reports an ATS provider enabled once flagged and given boards", () => {
  const statuses = createProviderRegistry({ JOBSCOUT_ENABLE_ASHBY: "true", ASHBY_BOARDS: "ramp=Ramp" }).statuses();
  assert.equal(statuses.find((entry) => entry.id === "ashby")?.enabled, true);
  assert.equal(statuses.find((entry) => entry.id === "greenhouse")?.enabled, false);
});

void test("the search_employers sources filter accepts the ATS provider ids", async () => {
  const fake = fakeFetch({ [greenhouseUrl]: () => json(greenhouseBody), [leverUrl]: () => json(leverBody), [ashbyUrl]: () => json(ashbyBody) });
  const registry = new ProviderRegistry([
    provider(greenhouseVendor, defaultGreenhouseApiBase, [{ token: "gitlab" }], fake.fetcher),
    provider(ashbyVendor, defaultAshbyApiBase, [{ token: "ramp", company: "Ramp" }], fake.fetcher),
    provider(leverVendor, defaultLeverApiBase, [{ token: "spotify", company: "Spotify" }], fake.fetcher),
  ]);
  const result = await registry.search(searchQuery({ query: "manager", sources: ["lever", "ashby"] }), "jobscout_search_employers");
  assert.deepEqual(result.providers_queried, ["ashby", "lever"]);
  assert.deepEqual(result.unknown_sources, []);
  assert(!fake.urls.includes(greenhouseUrl), "an unselected provider is not contacted");
  assert(result.jobs.every((job) => job.provenance.every((item) => item.provider === "ashby" || item.provider === "lever")));
});
