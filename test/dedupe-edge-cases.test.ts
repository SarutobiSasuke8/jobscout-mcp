import "./network-guard.js";

import assert from "node:assert/strict";
import test from "node:test";

import { deduplicateJobs, normalizeJob } from "../src/core.js";
import { defaultGreenhouseApiBase, greenhouseVendor } from "../src/providers/greenhouse.js";
import { AtsBoardProvider } from "../src/providers/ats.js";
import { findJobRecords, mapJobRecords } from "../src/providers/helpers.js";
import { HimalayasProvider } from "../src/providers/himalayas.js";
import { LennysJobsProvider, defaultEndpoint, defaultPartnerId, defaultSiteUrl } from "../src/providers/lennysjobs.js";
import { RemoteOkProvider } from "../src/providers/remoteok.js";
import { capturedAt, jsonResponse, sha256, sourceFixture, stubFetch } from "./fixture-support.js";
import { searchQuery } from "./support.js";

import type { TestContext } from "node:test";
import type { NormalizedJob } from "../src/types.js";

// Deduplication edge cases: the same vacancy reaching JobScout from several sources, spelled
// and linked differently, and how provenance merges when the copies collapse. The first group
// runs real provider output from the recorded fixtures; the rest use hand-built records so each
// case isolates one rule. No network: fixtures are served through a stubbed fetcher.

function permutations<T>(items: T[]): T[][] {
  if (items.length < 2) return [items];
  return items.flatMap((item, index) => permutations(items.filter((_, i) => i !== index)).map((rest) => [item, ...rest]));
}

function pinClock(t: TestContext): void {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(capturedAt) });
}

interface Copy {
  provider: string;
  title?: string;
  company?: string;
  location?: string;
  url?: string;
  discovery?: string;
  sourceId?: string;
  captured?: string;
  extra?: Partial<NormalizedJob>;
}

/** A normalised record as a provider would hand it over. Defaults describe one vacancy. */
function copy(options: Copy): NormalizedJob {
  return normalizeJob({
    title: options.title ?? "Senior Data Engineer",
    company: options.company ?? "Northwind Analytics",
    location: options.location ?? "Dublin, Ireland",
    tags: [],
    ...(options.url ? { canonical_url: options.url } : {}),
    ...options.extra,
    provenance: [{
      provider: options.provider,
      ...(options.discovery ? { discovery_url: options.discovery } : {}),
      source_job_id: options.sourceId ?? options.provider,
      captured_at: options.captured ?? capturedAt,
    }],
  });
}

function providers(job: NormalizedJob | undefined): string[] {
  return job?.provenance.map((item) => item.provider) ?? [];
}

/** Output grouped as sorted provider lists, so a case can be checked in any input order. */
function groups(jobs: NormalizedJob[]): string[] {
  return jobs.map((job) => providers(job).sort().join(",")).sort();
}

// ---- The same job from several sources, end to end ---------------------------------------

async function fixturePool(): Promise<{ greenhouse: NormalizedJob[]; remoteok: NormalizedJob[]; himalayas: NormalizedJob[]; lennysjobs: NormalizedJob[]; jobspy: NormalizedJob[] }> {
  const greenhouseUrl = `${defaultGreenhouseApiBase}/northwindanalytics/jobs?content=true`;
  const stub = stubFetch({
    [greenhouseUrl]: () => jsonResponse(sourceFixture("greenhouse-northwind.json")),
    "https://remoteok.com/api": () => jsonResponse(sourceFixture("remoteok-latest.json")),
    [defaultEndpoint]: () => jsonResponse(sourceFixture("lennysjobs-search.json")),
    "https://mcp.himalayas.app/mcp": [
      () => jsonResponse(sourceFixture("himalayas-initialize.json")),
      () => jsonResponse(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: sourceFixture("himalayas-search.md") }] } })),
    ],
  });
  const query = searchQuery({ query: "engineer" });
  return {
    greenhouse: (await new AtsBoardProvider(greenhouseVendor, true, [{ token: "northwindanalytics" }], [], defaultGreenhouseApiBase, stub.fetcher).search(searchQuery({ query: "northwind" }))).jobs,
    remoteok: (await new RemoteOkProvider(true, "https://remoteok.com/api", stub.fetcher).search(query)).jobs,
    himalayas: (await new HimalayasProvider(true, "https://mcp.himalayas.app/mcp", stub.fetcher).search(query)).jobs,
    lennysjobs: (await new LennysJobsProvider(true, defaultEndpoint, defaultPartnerId, defaultSiteUrl, 1_000, stub.fetcher).search(searchQuery({ query: "product" }))).jobs,
    jobspy: mapJobRecords("jobspy", findJobRecords(JSON.parse(sourceFixture("jobspy-bridge-output.json")) as unknown), 25).jobs,
  };
}

void test("the same job from Greenhouse, RemoteOK and Himalayas collapses to one record in every arrival order", async (t) => {
  pinClock(t);
  const pool = await fixturePool();
  const requisition = "https://job-boards.greenhouse.io/northwindanalytics/jobs/4100001";

  for (const order of permutations([pool.greenhouse, pool.remoteok, pool.himalayas])) {
    const output = deduplicateJobs(order.flat());
    assert.equal(output.length, 4, "six records from three sources describe four vacancies");
    const merged = output.filter((job) => job.provenance.length > 1);
    assert.equal(merged.length, 1);
    const job = merged[0];

    // The employer's own requisition decides identity, the canonical link and the core fields,
    // whichever source arrived first. RemoteOK linked the same requisition through another
    // host with tracking parameters; Himalayas had no link at all and matched on text.
    assert.equal(job?.id, sha256("ats:greenhouse:4100001"));
    assert.equal(job?.canonical_url, requisition);
    assert.equal(job?.title, "Senior Data Engineer", "not RemoteOK's lower-case copy");
    assert.equal(job?.company, "Northwind Analytics", "not RemoteOK's 'Ltd' spelling");
    assert.equal(job?.date_posted, "2026-10-02");
    assert.match(job?.description ?? "", /^About the role/u, "the longest description wins");
    // Greenhouse publishes no pay; the first board copy that does fills the gap.
    assert.deepEqual(job?.salary, { min: 85_000, max: 110_000 });
    assert.deepEqual(job?.tags, ["Data Platform", "data", "python", "sql"]);

    // Provenance keeps every source, first-party first, each with its own discovery URL and id.
    assert.deepEqual(job?.provenance, [
      { provider: "greenhouse", discovery_url: requisition, source_job_id: "4100001", captured_at: capturedAt },
      { provider: "remoteok", discovery_url: "https://remoteok.com/remote-jobs/remote-senior-data-engineer-northwind-analytics-77001", source_job_id: "77001", captured_at: capturedAt },
      { provider: "himalayas", discovery_url: "https://himalayas.app/companies/northwind-analytics/jobs/senior-data-engineer", captured_at: capturedAt },
    ]);
    assert.equal(job?.duplicate_conflict, undefined);
  }
});

void test("the same job from Lenny's Job Board and JobSpy merges on the careers URL in two forms", async (t) => {
  pinClock(t);
  const pool = await fixturePool();
  const lenny = pool.lennysjobs.find((job) => job.company === "Larkspur Robotics");
  const jobspy = pool.jobspy.find((job) => job.title === "Senior Product Manager, Growth");
  assert(lenny && jobspy);
  // One link carries the board's utm parameters, the other a trailing slash.
  assert.equal(lenny.canonical_url, jobspy.canonical_url);

  for (const order of [[lenny, jobspy], [jobspy, lenny]]) {
    const [job, ...rest] = deduplicateJobs(order);
    assert.equal(rest.length, 0);
    assert.equal(job?.id, sha256("url:careers.larkspur.example/jobs/pm-growth"));
    assert.equal(job?.canonical_url, "https://careers.larkspur.example/jobs/pm-growth");
    assert.deepEqual(providers(job).sort(), ["jobspy", "lennysjobs"]);
    assert.equal(job?.description, "Own **activation** and retention for our warehouse robot fleet software.", "the longer description wins either way");
    assert.deepEqual(job?.salary, jobspy.salary, "the only copy with pay supplies it");
  }

  // Neither copy is first-party, so where they disagree the first arrival wins. Pinned so a
  // change to that rule is a deliberate decision, not an accident.
  const [lennyFirst] = deduplicateJobs([lenny, jobspy]);
  assert.equal(lennyFirst?.location, "San Francisco, California, USA; Remote, US");
  assert.equal(lennyFirst?.remote, true);
  assert.equal(lennyFirst?.date_posted, "2026-09-27");
  const [jobspyFirst] = deduplicateJobs([jobspy, lenny]);
  assert.equal(jobspyFirst?.location, "San Francisco, CA, US");
  assert.equal(jobspyFirst?.remote, false);
  assert.equal(jobspyFirst?.date_posted, "2026-09-28");
});

void test("a board copy with no employer link and a differently spelled location stays separate", async (t) => {
  pinClock(t);
  // Lever says "Remote - Worldwide", We Work Remotely says "Anywhere in the World". With no
  // shared link there is no evidence they are one requisition, so both are kept.
  const lever = copy({ provider: "lever", title: "Smart Contract Auditor", company: "Kestrel Ledger", location: "Remote - Worldwide", url: "https://jobs.lever.co/kestrel-ledger/3c9a1e5f-7b2d-4e8a-9f60-1a2b3c4d5e6f" });
  const wwr = copy({ provider: "weworkremotely", title: "Smart Contract Auditor", company: "Kestrel Ledger", location: "Anywhere in the World" });
  assert.deepEqual(groups(deduplicateJobs([lever, wwr])), ["lever", "weworkremotely"]);
});

void test("deduplication is idempotent on the whole fixture pool", async (t) => {
  pinClock(t);
  const pool = await fixturePool();
  const once = deduplicateJobs(Object.values(pool).flat());
  assert.deepEqual(deduplicateJobs(once), once);
  assert.equal(new Set(once.map((job) => job.id)).size, once.length, "every surviving record has its own id");
});

// ---- Case, whitespace and spelling ------------------------------------------------------------

void test("case, whitespace, Unicode width and punctuation differences in title and company merge", () => {
  const records = [
    copy({ provider: "a", title: "Senior Data Engineer - Platform", company: "Northwind Analytics" }),
    copy({ provider: "b", title: "  senior   DATA engineer (platform) ", company: "NORTHWIND analytics" }),
    // Full-width letters and a non-breaking space, as some boards emit.
    copy({ provider: "c", title: "Senior Data Engineer / Platform", company: "Ｎorthwind Analytics" }),
  ];
  for (const order of permutations(records)) {
    const output = deduplicateJobs(order);
    assert.deepEqual(groups(output), ["a,b,c"]);
  }
  // Identity fields are compacted, never re-cased: the first arrival's spelling is kept.
  assert.equal(deduplicateJobs(records)[0]?.title, "Senior Data Engineer - Platform");
  assert.equal(deduplicateJobs(records.slice(1))[0]?.title, "senior DATA engineer (platform)");
});

void test("a company in a different case with the same link merges; a different employer does not", () => {
  const url = "https://careers.northwind.example/jobs/42";
  assert.deepEqual(groups(deduplicateJobs([copy({ provider: "a", url }), copy({ provider: "b", url, company: "NORTHWIND ANALYTICS LIMITED" })])), ["a,b"]);
  const conflicting = deduplicateJobs([copy({ provider: "a", url }), copy({ provider: "b", url, company: "Northwind Recruiting" })]);
  assert.deepEqual(groups(conflicting), ["a", "b"]);
  assert(conflicting.every((job) => job.duplicate_conflict === true));
});

void test("without a link, a legal suffix is not enough to merge text-only copies", () => {
  // Text identity compares the company as written. Only a shared link licenses ignoring "Ltd".
  assert.deepEqual(groups(deduplicateJobs([copy({ provider: "a" }), copy({ provider: "b", company: "Northwind Analytics Ltd" })])), ["a", "b"]);
});

// ---- URL forms ------------------------------------------------------------------------------

void test("tracking parameters, trailing slashes, fragments, www, scheme and host case are one job", () => {
  const forms = [
    "https://careers.northwind.example/jobs/42",
    "https://careers.northwind.example/jobs/42/",
    "https://careers.northwind.example/jobs/42?utm_source=linkedin&utm_campaign=q4&utm_medium=social",
    "https://careers.northwind.example/jobs/42#apply",
    "http://www.careers.northwind.example/jobs/42?gclid=abc123&fbclid=def456&ref=board",
    "https://CAREERS.Northwind.EXAMPLE/jobs/42//",
    "https://careers.northwind.example/jobs/42?source=newsletter&referrer=friend&utm_content=hero&utm_term=data",
  ];
  const records = forms.map((url, index) => copy({ provider: `p${index}`, url }));
  for (const order of [records, [...records].reverse()]) {
    const output = deduplicateJobs(order);
    assert.equal(output.length, 1);
    assert.equal(output[0]?.provenance.length, forms.length);
    assert.equal(output[0]?.id, sha256("url:careers.northwind.example/jobs/42"));
  }
  assert.equal(deduplicateJobs(records)[0]?.canonical_url, "https://careers.northwind.example/jobs/42");
});

void test("meaningful query parameters are identity; their order is not", () => {
  const a = copy({ provider: "a", url: "https://careers.northwind.example/jobs?id=42&team=data" });
  const b = copy({ provider: "b", url: "https://careers.northwind.example/jobs?team=data&id=42&utm_source=x" });
  const c = copy({ provider: "c", url: "https://careers.northwind.example/jobs?id=43&team=data" });
  assert.deepEqual(groups(deduplicateJobs([a, b, c])), ["a,b", "c"]);
});

void test("path case is identity: two paths differing only in case stay separate", () => {
  const upper = copy({ provider: "a", url: "https://careers.northwind.example/jobs/ABC" });
  const lower = copy({ provider: "b", url: "https://careers.northwind.example/jobs/abc" });
  assert.deepEqual(groups(deduplicateJobs([upper, lower])), ["a", "b"]);
});

void test("ATS links merge across apply suffixes, id case and tracking parameters", () => {
  const id = "3c9a1e5f-7b2d-4e8a-9f60-1a2b3c4d5e6f";
  const records = [
    copy({ provider: "lever", url: `https://jobs.lever.co/kestrel-ledger/${id}` }),
    copy({ provider: "board", url: `https://jobs.lever.co/kestrel-ledger/${id.toUpperCase()}/apply?lever-source=Board&utm_source=feed` }),
    copy({ provider: "eu", url: `https://jobs.eu.lever.co/kestrel-ledger/${id}/` }),
  ];
  for (const order of permutations(records)) {
    const [job, ...rest] = deduplicateJobs(order);
    assert.equal(rest.length, 0);
    assert.equal(job?.id, sha256(`ats:lever:${id}`));
    assert.equal(job?.canonical_url, `https://jobs.lever.co/kestrel-ledger/${id}`, "the Lever adapter's own record is canonical");
    assert.equal(providers(job)[0], "lever", "the first-party source leads provenance");
  }
});

// ---- Same title, different places ------------------------------------------------------------

void test("the same title at different locations is two vacancies", () => {
  assert.deepEqual(groups(deduplicateJobs([
    copy({ provider: "a", location: "Dublin, Ireland" }),
    copy({ provider: "b", location: "Berlin, Germany" }),
  ])), ["a", "b"]);
  assert.deepEqual(groups(deduplicateJobs([
    copy({ provider: "a", location: "Dublin, Ireland", url: "https://job-boards.greenhouse.io/northwindanalytics/jobs/4100010" }),
    copy({ provider: "b", location: "Berlin, Germany", url: "https://job-boards.greenhouse.io/northwindanalytics/jobs/4100011" }),
  ])), ["a", "b"]);
});

void test("location tells a board copy which of two same-titled requisitions it belongs to", () => {
  const dublin = copy({ provider: "greenhouse-dublin", location: "Dublin, Ireland", url: "https://job-boards.greenhouse.io/northwindanalytics/jobs/4100010" });
  const berlin = copy({ provider: "greenhouse-berlin", location: "Berlin, Germany", url: "https://job-boards.greenhouse.io/northwindanalytics/jobs/4100011" });
  const board = copy({ provider: "board", location: "Ireland, Dublin" });
  for (const order of permutations([dublin, berlin, board])) {
    const output = deduplicateJobs(order);
    assert.deepEqual(groups(output), ["board,greenhouse-dublin", "greenhouse-berlin"]);
    assert(output.every((job) => job.duplicate_conflict === undefined));
  }
});

// ---- Re-posted jobs -------------------------------------------------------------------------

void test("an ATS re-post under a new requisition id is kept apart, and a board copy cannot pick one", () => {
  const original = copy({ provider: "original", url: "https://job-boards.greenhouse.io/northwindanalytics/jobs/4100001", extra: { date_posted: "2026-10-02" } });
  const repost = copy({ provider: "repost", url: "https://job-boards.greenhouse.io/northwindanalytics/jobs/4100099", extra: { date_posted: "2026-10-12" } });
  // Two requisitions are two vacancies as far as the evidence goes; merging them could hide
  // a genuinely new opening. They are not a conflict either: nothing contradicts anything.
  const pair = deduplicateJobs([original, repost]);
  assert.deepEqual(groups(pair), ["original", "repost"]);
  assert(pair.every((job) => job.duplicate_conflict === undefined));

  // A text-only board copy matches both, so it is flagged rather than guessed into one.
  for (const order of permutations([original, repost, copy({ provider: "board" })])) {
    const output = deduplicateJobs(order);
    assert.deepEqual(groups(output), ["board", "original", "repost"]);
    assert(output.every((job) => job.duplicate_conflict === true));
  }
});

void test("a board re-post under a new listing id merges, keeping both ids in provenance", () => {
  const first = copy({ provider: "remoteok", sourceId: "77001", discovery: "https://remoteok.com/remote-jobs/77001", extra: { date_posted: "2026-10-02" } });
  const relisted = copy({ provider: "remoteok", sourceId: "77450", discovery: "https://remoteok.com/remote-jobs/77450", extra: { date_posted: "2026-10-12" } });
  for (const order of [[first, relisted], [relisted, first]]) {
    const [job, ...rest] = deduplicateJobs(order);
    assert.equal(rest.length, 0);
    assert.deepEqual(job?.provenance.map((item) => item.source_job_id).sort(), ["77001", "77450"]);
    assert.equal(job?.id, sha256("job:northwind analytics:senior data engineer:dublin ireland"));
  }
  // Neither copy is first-party, so the date of whichever arrived first is kept.
  assert.equal(deduplicateJobs([first, relisted])[0]?.date_posted, "2026-10-02");
});

// ---- How provenance merges -------------------------------------------------------------------

void test("the same listing captured twice keeps one provenance entry, the one seen last", () => {
  const morning = copy({ provider: "remoteok", sourceId: "77001", discovery: "https://remoteok.com/remote-jobs/77001", captured: "2026-10-14T08:00:00.000Z" });
  const evening = copy({ provider: "remoteok", sourceId: "77001", discovery: "https://remoteok.com/remote-jobs/77001", captured: "2026-10-14T20:00:00.000Z" });
  const [job] = deduplicateJobs([morning, evening]);
  assert.deepEqual(job?.provenance, [{ provider: "remoteok", discovery_url: "https://remoteok.com/remote-jobs/77001", source_job_id: "77001", captured_at: "2026-10-14T20:00:00.000Z" }]);
});

void test("one provider reporting the same vacancy under two ids keeps both entries", () => {
  const url = "https://careers.northwind.example/jobs/42";
  const [job] = deduplicateJobs([
    copy({ provider: "jobspy", sourceId: "in-1", url, discovery: "https://www.indeed.com/viewjob?jk=1" }),
    copy({ provider: "jobspy", sourceId: "gd-9", url, discovery: "https://www.glassdoor.com/job-listing/9" }),
  ]);
  assert.deepEqual(job?.provenance.map((item) => item.source_job_id), ["in-1", "gd-9"]);
});

void test("merged fields: longest description, union of tags, first-party values first", () => {
  const ats = copy({
    provider: "greenhouse",
    url: "https://job-boards.greenhouse.io/northwindanalytics/jobs/4100001",
    extra: { description: "Short.", tags: ["Data Platform"], remote: false, employment_type: "Full-time" },
  });
  const board = copy({
    provider: "board",
    url: "https://boards.greenhouse.io/northwindanalytics/jobs/4100001",
    title: "SENIOR DATA ENGINEER",
    extra: {
      description: "A much longer board description of the same vacancy.",
      tags: ["data", "Data Platform"],
      remote: true,
      salary: { min: 1, max: 2, currency: "EUR", interval: "year" },
    },
  });
  for (const order of [[ats, board], [board, ats]]) {
    const [job] = deduplicateJobs(order);
    assert.equal(job?.title, "Senior Data Engineer");
    assert.equal(job?.description, "A much longer board description of the same vacancy.");
    assert.deepEqual(job?.tags, ["Data Platform", "data"]);
    assert.equal(job?.remote, false, "the employer's own workplace answer is not overridden by a board");
    assert.equal(job?.employment_type, "Full-time");
    assert.deepEqual(job?.salary, { min: 1, max: 2, currency: "EUR", interval: "year" }, "a gap in the first-party record is filled from the copy");
    assert.deepEqual(providers(job), ["greenhouse", "board"]);
  }
});
