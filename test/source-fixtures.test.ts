import "./network-guard.js";

import assert from "node:assert/strict";
import test from "node:test";

import { ashbyVendor, defaultAshbyApiBase } from "../src/providers/ashby.js";
import { AtsBoardProvider } from "../src/providers/ats.js";
import { defaultGreenhouseApiBase, greenhouseVendor } from "../src/providers/greenhouse.js";
import { findJobRecords, mapJobRecords } from "../src/providers/helpers.js";
import { HimalayasProvider } from "../src/providers/himalayas.js";
import { LennysJobsProvider, defaultEndpoint, defaultPartnerId, defaultSiteUrl } from "../src/providers/lennysjobs.js";
import { defaultLeverApiBase, leverVendor } from "../src/providers/lever.js";
import { RemoteOkProvider } from "../src/providers/remoteok.js";
import { WeWorkRemotelyProvider } from "../src/providers/weworkremotely.js";
import { normalizedJobSchema } from "../src/types.js";
import { byTitle, capturedAt, jsonResponse, sha256, sourceFixture, stubFetch, withoutSignals } from "./fixture-support.js";
import { searchQuery } from "./support.js";

import type { TestContext } from "node:test";
import type { AtsBoard, AtsVendor } from "../src/providers/ats.js";
import type { NormalizedJob, ProviderSearchResult } from "../src/types.js";

// One suite per source adapter, each driven end to end through the provider's own `search`
// with a recorded-shape fixture (see test/fixtures/sources/README.md) served by a stubbed
// fetcher. Every normalised field is asserted, including provenance: the source, its discovery
// URL, the source's own job id, and `captured_at`, which is the fetch time and is pinned here by
// mocking the clock. Record ids are asserted against the identity rule they hash, so an
// accidental change to deduplication identity fails loudly.

/** Pin the clock so `captured_at` is exactly `capturedAt`. Restored when the test ends. */
function pinClock(t: TestContext): void {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(capturedAt) });
}

/** Every record a provider returns must still satisfy the public output schema. */
function assertSchemaValid(result: ProviderSearchResult): void {
  for (const job of result.jobs) assert.doesNotThrow(() => normalizedJobSchema.parse(job), `${job.title} failed the output schema`);
}

function provenance(provider: string, discoveryUrl: string | undefined, sourceJobId: string | undefined): NormalizedJob["provenance"] {
  return [{
    provider,
    ...(discoveryUrl ? { discovery_url: discoveryUrl } : {}),
    ...(sourceJobId ? { source_job_id: sourceJobId } : {}),
    captured_at: capturedAt,
  }];
}

function atsProvider(vendor: AtsVendor, base: string, boards: AtsBoard[], fetcher: typeof fetch): AtsBoardProvider {
  return new AtsBoardProvider(vendor, true, boards, [], base, fetcher);
}

// ---- Greenhouse ---------------------------------------------------------------------------

const greenhouseUrl = `${defaultGreenhouseApiBase}/northwindanalytics/jobs?content=true`;

void test("Greenhouse fixture: every field and the provenance of each requisition", async (t) => {
  pinClock(t);
  const stub = stubFetch({ [greenhouseUrl]: () => jsonResponse(sourceFixture("greenhouse-northwind.json")) });
  const result = await atsProvider(greenhouseVendor, defaultGreenhouseApiBase, [{ token: "northwindanalytics" }], stub.fetcher)
    .search(searchQuery({ query: "northwind" }));

  assert.deepEqual(stub.requests.map((request) => request.url), [greenhouseUrl]);
  assert.equal(stub.requests[0]?.headers.accept, "application/json");
  assert.match(stub.requests[0]?.headers["user-agent"] ?? "", /^jobscout-mcp\//u, "requests identify the client");
  assert.equal(result.records_rejected, 1, "the requisition with no public URL is counted, not dropped silently");
  assert.equal(result.jobs.length, 2);
  assertSchemaValid(result);

  const requisition = "https://job-boards.greenhouse.io/northwindanalytics/jobs/4100001";
  assert.deepEqual(withoutSignals(byTitle(result.jobs, "Senior Data Engineer")), {
    id: sha256("ats:greenhouse:4100001"),
    title: "Senior Data Engineer",
    company: "Northwind Analytics",
    location: "Remote, Europe",
    remote: true,
    description: "About the role Build streaming pipelines & the warehouse that powers our forecasting product. Python and SQL",
    description_truncated: false,
    // first_published is 21:15 on 1 October in UTC-4, which is already 2 October in UTC.
    date_posted: "2026-10-02",
    canonical_url: requisition,
    tags: ["Data Platform"],
    provenance: provenance("greenhouse", requisition, "4100001"),
  });

  const architect = byTitle(result.jobs, "Solutions Architect, AI Agents");
  assert.deepEqual(withoutSignals(architect), {
    id: sha256("ats:greenhouse:4100002"),
    title: "Solutions Architect, AI Agents",
    company: "Northwind Analytics",
    location: "Dublin, Ireland",
    description: "Help customers deploy AI agents on our platform.",
    description_truncated: false,
    // No first_published, so updated_at stands in; 23:30 in UTC-7 is the next day in UTC.
    date_posted: "2026-09-29",
    canonical_url: "https://job-boards.greenhouse.io/northwindanalytics/jobs/4100002",
    tags: ["Customer Engineering", "EMEA"],
    provenance: provenance("greenhouse", "https://job-boards.greenhouse.io/northwindanalytics/jobs/4100002", "4100002"),
  });
  assert.equal("remote" in (architect ?? {}), false, "a location without 'remote' is left unknown, not asserted on-site");
  assert.deepEqual(architect?.signals?.domains, ["ai"]);
});

// ---- Ashby --------------------------------------------------------------------------------

const ashbyUrl = `${defaultAshbyApiBase}/bluefen?includeCompensation=true`;

void test("Ashby fixture: every field, compensation and provenance; unlisted postings skipped", async (t) => {
  pinClock(t);
  const stub = stubFetch({ [ashbyUrl]: () => jsonResponse(sourceFixture("ashby-bluefen.json")) });
  const result = await atsProvider(ashbyVendor, defaultAshbyApiBase, [{ token: "bluefen", company: "Bluefen Labs" }], stub.fetcher)
    .search(searchQuery({ query: "bluefen" }));

  assert.deepEqual(stub.requests.map((request) => request.url), [ashbyUrl]);
  assert.equal(result.records_rejected, 1, "only the posting with no URL counts; the unlisted one is skipped by design");
  assert.deepEqual(result.jobs.map((job) => job.title), ["ML Platform Engineer", "Office Manager"]);
  assertSchemaValid(result);

  const platformUrl = "https://jobs.ashbyhq.com/bluefen/6f1d2c3b-4a5e-4f60-9a7b-8c9d0e1f2a3b";
  assert.deepEqual(withoutSignals(result.jobs[0]), {
    id: sha256("ats:ashby:6f1d2c3b-4a5e-4f60-9a7b-8c9d0e1f2a3b"),
    title: "ML Platform Engineer",
    company: "Bluefen Labs",
    // Secondary locations are appended once each; the repeated "Berlin" is not listed twice.
    location: "Berlin; Remote (EU)",
    remote: true,
    description: "Run the training and inference platform for our machine learning teams.",
    description_truncated: false,
    employment_type: "full-time",
    date_posted: "2026-09-30",
    canonical_url: platformUrl,
    // The equity component is skipped; only the Salary component is a pay range.
    salary: { min: 90_000, max: 120_000, currency: "EUR", interval: "year" },
    tags: ["Engineering", "Machine Learning"],
    provenance: provenance("ashby", platformUrl, "6f1d2c3b-4a5e-4f60-9a7b-8c9d0e1f2a3b"),
  });

  const officeUrl = "https://jobs.ashbyhq.com/bluefen/7a2e3d4c-5b6f-4071-8b8c-9daeb0f1c2d3";
  assert.deepEqual(withoutSignals(result.jobs[1]), {
    id: sha256("ats:ashby:7a2e3d4c-5b6f-4071-8b8c-9daeb0f1c2d3"),
    title: "Office Manager",
    company: "Bluefen Labs",
    location: "Berlin",
    remote: false,
    // No descriptionPlain, so the HTML is reduced to text.
    description: "Keep our Berlin office running & welcoming.",
    description_truncated: false,
    employment_type: "part-time",
    date_posted: "2026-09-15",
    canonical_url: officeUrl,
    tags: ["Operations", "Workplace"],
    provenance: provenance("ashby", officeUrl, "7a2e3d4c-5b6f-4071-8b8c-9daeb0f1c2d3"),
  });
});

// ---- Lever --------------------------------------------------------------------------------

const leverUrl = `${defaultLeverApiBase}/kestrel-ledger?mode=json`;

void test("Lever fixture: every field, salary range and provenance", async (t) => {
  pinClock(t);
  const stub = stubFetch({ [leverUrl]: () => jsonResponse(sourceFixture("lever-kestrel.json")) });
  const result = await atsProvider(leverVendor, defaultLeverApiBase, [{ token: "kestrel-ledger", company: "Kestrel Ledger" }], stub.fetcher)
    .search(searchQuery({ query: "kestrel" }));

  assert.deepEqual(stub.requests.map((request) => request.url), [leverUrl]);
  assert.equal(result.records_rejected, 1);
  assert.equal(result.jobs.length, 2);
  assertSchemaValid(result);

  const auditorUrl = "https://jobs.lever.co/kestrel-ledger/3c9a1e5f-7b2d-4e8a-9f60-1a2b3c4d5e6f";
  const auditor = byTitle(result.jobs, "Smart Contract Auditor");
  assert.deepEqual(withoutSignals(auditor), {
    id: sha256("ats:lever:3c9a1e5f-7b2d-4e8a-9f60-1a2b3c4d5e6f"),
    title: "Smart Contract Auditor",
    company: "Kestrel Ledger",
    location: "Remote - Worldwide",
    remote: true,
    description: "Review smart contract code for our settlement protocol before every release.",
    description_truncated: false,
    employment_type: "Full-time",
    // createdAt is epoch milliseconds: 1790000000000 is 2026-09-21T14:13:20Z.
    date_posted: "2026-09-21",
    // The hosted posting is canonical, not the /apply form.
    canonical_url: auditorUrl,
    salary: { min: 140_000, max: 180_000, currency: "USD", interval: "year" },
    tags: ["Protocol", "Security"],
    provenance: provenance("lever", auditorUrl, "3c9a1e5f-7b2d-4e8a-9f60-1a2b3c4d5e6f"),
  });
  assert.deepEqual(auditor?.signals?.domains, ["web3"]);

  const leadUrl = "https://jobs.lever.co/kestrel-ledger/4d0b2f60-8c3e-4f9b-a071-2b3c4d5e6f70";
  assert.deepEqual(withoutSignals(byTitle(result.jobs, "Customer Success Lead")), {
    id: sha256("ats:lever:4d0b2f60-8c3e-4f9b-a071-2b3c4d5e6f70"),
    title: "Customer Success Lead",
    company: "Kestrel Ledger",
    // No allLocations, so the single location stands.
    location: "Lisbon",
    remote: false,
    description: "Lead onboarding for institutional customers.",
    description_truncated: false,
    employment_type: "Full-time",
    date_posted: "2026-09-13",
    canonical_url: leadUrl,
    tags: ["Accounts", "Customer Success"],
    provenance: provenance("lever", leadUrl, "4d0b2f60-8c3e-4f9b-a071-2b3c4d5e6f70"),
  });
});

void test("Lever fixture: without an operator label the site token names the employer", async () => {
  const stub = stubFetch({ [leverUrl]: () => jsonResponse(sourceFixture("lever-kestrel.json")) });
  const result = await atsProvider(leverVendor, defaultLeverApiBase, [{ token: "kestrel-ledger" }], stub.fetcher)
    .search(searchQuery({ query: "auditor" }));
  // Only the first letter is raised; a multi-word employer needs a `token=Company Name` label.
  assert.deepEqual(result.jobs.map((job) => job.company), ["Kestrel ledger"]);
});

// ---- RemoteOK -----------------------------------------------------------------------------

const remoteOkUrl = "https://remoteok.com/api";

void test("RemoteOK fixture: every field and provenance; the legal notice is not a listing", async (t) => {
  pinClock(t);
  const stub = stubFetch({ [remoteOkUrl]: () => jsonResponse(sourceFixture("remoteok-latest.json")) });
  const result = await new RemoteOkProvider(true, remoteOkUrl, stub.fetcher).search(searchQuery({ query: "engineer" }));

  assert.deepEqual(stub.requests.map((request) => request.url), [remoteOkUrl]);
  assert.equal(result.records_rejected, 1, "the listing with no position counts; the legal notice does not");
  assert.equal(result.jobs.length, 2);
  assertSchemaValid(result);

  const listing = "https://remoteok.com/remote-jobs/remote-senior-data-engineer-northwind-analytics-77001";
  assert.deepEqual(withoutSignals(byTitle(result.jobs, "senior data engineer")), {
    // The apply link is a Greenhouse requisition, so identity is the requisition itself.
    id: sha256("ats:greenhouse:4100001"),
    title: "senior data engineer",
    company: "Northwind Analytics Ltd",
    location: "Remote, Europe",
    remote: true,
    description: "Build streaming pipelines for a forecasting product.",
    description_truncated: false,
    // The date string wins over the epoch when both are present.
    date_posted: "2026-10-02",
    // Tracking parameters are removed; the vendor's own gh_src parameter is kept.
    canonical_url: "https://boards.greenhouse.io/northwindanalytics/jobs/4100001?gh_src=remoteok",
    // RemoteOK publishes no currency, so none is claimed.
    salary: { min: 85_000, max: 110_000 },
    tags: ["data", "python", "sql"],
    provenance: provenance("remoteok", listing, "77001"),
  });

  const backend = byTitle(result.jobs, "Backend Engineer (Go)");
  assert.deepEqual(withoutSignals(backend), {
    id: sha256("job:quillon health:backend engineer go:remote"),
    title: "Backend Engineer (Go)",
    company: "Quillon Health",
    // A blank RemoteOK location means unrestricted remote, not unknown.
    location: "Remote",
    remote: true,
    description: "Own the claims API.",
    description_truncated: false,
    // No date string: the epoch seconds (1790100000) supply it.
    date_posted: "2026-09-22",
    tags: ["golang", "backend"],
    provenance: provenance("remoteok", "https://remoteok.com/remote-jobs/remote-backend-engineer-go-quillon-health-77002", "77002"),
  });
  assert.equal(backend?.canonical_url, undefined, "a remoteok.com/l/ redirect is provenance, never the employer route");
});

// ---- We Work Remotely ---------------------------------------------------------------------

const wwrUrl = "https://weworkremotely.com/remote-jobs.rss";

void test("We Work Remotely fixture: every field and provenance from the RSS feed", async (t) => {
  pinClock(t);
  const stub = stubFetch({ [wwrUrl]: () => new Response(sourceFixture("weworkremotely-feed.xml"), { headers: { "content-type": "application/rss+xml" } }) });
  const result = await new WeWorkRemotelyProvider(true, wwrUrl, stub.fetcher).search(searchQuery({ query: "auditor designer" }));

  assert.deepEqual(stub.requests.map((request) => request.url), [wwrUrl]);
  assert.match(stub.requests[0]?.headers.accept ?? "", /application\/rss\+xml/u);
  assert.equal(result.records_rejected, 1, "the item with no link is counted");
  assert.deepEqual(result.jobs.map((job) => job.title), ["Smart Contract Auditor", "Product Designer"], "equal scores keep feed order");
  assertSchemaValid(result);

  const auditorLink = "https://weworkremotely.com/remote-jobs/kestrel-ledger-smart-contract-auditor";
  const auditor = result.jobs[0];
  assert.deepEqual(withoutSignals(auditor), {
    id: sha256("job:kestrel ledger:smart contract auditor:anywhere in the world"),
    title: "Smart Contract Auditor",
    company: "Kestrel Ledger",
    location: "Anywhere in the World",
    remote: true,
    description: "Headquarters: Remote Review smart contract code for our settlement protocol & publish audit notes.",
    description_truncated: false,
    employment_type: "Full-Time",
    date_posted: "2026-10-02",
    tags: ["Programming", "Full-Time"],
    // The guid is the feed's own id for the item.
    provenance: provenance("weworkremotely", auditorLink, auditorLink),
  });
  assert.equal(auditor?.canonical_url, undefined, "a board listing link is never promoted to the employer route");

  const designerLink = "https://weworkremotely.com/remote-jobs/quillon-health-product-designer";
  assert.deepEqual(withoutSignals(result.jobs[1]), {
    id: sha256("job:quillon health:product designer:europe only"),
    title: "Product Designer",
    company: "Quillon Health",
    location: "Europe Only",
    remote: true,
    description: "Design the clinician-facing scheduling tools.",
    description_truncated: false,
    employment_type: "Contract",
    // 23:59 on 30 September at UTC-2 is 1 October in UTC.
    date_posted: "2026-10-01",
    tags: ["Design", "Contract"],
    provenance: provenance("weworkremotely", designerLink, designerLink),
  });
});

// ---- Lenny's Job Board --------------------------------------------------------------------

void test("Lenny's Job Board fixture: every field and provenance; the employer route is canonical", async (t) => {
  pinClock(t);
  const stub = stubFetch({ [defaultEndpoint]: () => jsonResponse(sourceFixture("lennysjobs-search.json")) });
  const result = await new LennysJobsProvider(true, defaultEndpoint, defaultPartnerId, defaultSiteUrl, 1_000, stub.fetcher)
    .search(searchQuery({ query: "product manager" }));

  assert.equal(stub.requests.length, 1);
  assert.equal(stub.requests[0]?.method, "POST");
  assert.equal(JSON.parse(stub.requests[0]?.body ?? "[]")[0]?.params?.trueupPartnerId, "lenny");
  assert.equal(result.records_rejected, 1, "the hit with no company is counted");
  assert.equal(result.jobs.length, 2);
  assertSchemaValid(result);

  assert.deepEqual(withoutSignals(result.jobs[0]), {
    id: sha256("url:careers.larkspur.example/jobs/pm-growth"),
    // Highlight markers are presentation and are stripped.
    title: "Senior Product Manager, Growth",
    company: "Larkspur Robotics",
    location: "San Francisco, California, USA; Remote, US",
    remote: true,
    description: "Own activation and retention for our warehouse robot fleet software.",
    description_truncated: false,
    date_posted: "2026-09-27",
    // The hit's own employer route, with the board's tracking parameters removed.
    canonical_url: "https://careers.larkspur.example/jobs/pm-growth",
    tags: ["Product Management", "Robotics", "Senior", "Series B"],
    provenance: provenance("lennysjobs", "https://www.lennysjobs.com/jobs/ln-5001", "ln-5001"),
  });

  const design = result.jobs[1];
  assert.deepEqual(withoutSignals(design), {
    id: sha256("job:ostrava studio:design lead:czechia prague"),
    title: "Design Lead",
    company: "Ostrava Studio",
    location: "Prague, Czechia",
    tags: ["Design", "Lead"],
    provenance: provenance("lennysjobs", "https://www.lennysjobs.com/jobs/ln-5002", "ln-5002"),
  });
  assert.equal(design?.canonical_url, undefined, "the board's listing page is discovery, not an employer route");
});

// ---- Himalayas ----------------------------------------------------------------------------

const himalayasUrl = "https://mcp.himalayas.app/mcp";

function sse(payload: unknown): Response {
  return new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, { headers: { "content-type": "text/event-stream" } });
}

void test("Himalayas fixture: the MCP session is carried and the markdown result is normalised field by field", async (t) => {
  pinClock(t);
  const stub = stubFetch({
    [himalayasUrl]: [
      () => jsonResponse(sourceFixture("himalayas-initialize.json"), { "mcp-session-id": "fixture-session-1" }),
      () => sse({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: sourceFixture("himalayas-search.md") }] } }),
    ],
  });
  const result = await new HimalayasProvider(true, himalayasUrl, stub.fetcher).search(searchQuery({ query: "data engineer", location: "Germany" }));

  assert.deepEqual(stub.requests.map((request) => JSON.parse(request.body ?? "{}").method), ["initialize", "tools/call"]);
  assert.equal(stub.requests[0]?.headers["mcp-session-id"], undefined);
  assert.equal(stub.requests[1]?.headers["mcp-session-id"], "fixture-session-1", "the session from initialize is reused");
  assert.deepEqual(JSON.parse(stub.requests[1]?.body ?? "{}").params, { name: "search_jobs", arguments: { keyword: "data engineer", country: "Germany" } });
  assert.equal(result.records_rejected, 1, "the block with no company line is counted");
  assert.equal(result.jobs.length, 2);
  assertSchemaValid(result);

  assert.deepEqual(withoutSignals(result.jobs[0]), {
    id: sha256("job:northwind analytics:senior data engineer:europe remote"),
    title: "Senior Data Engineer",
    // The verified-employer tick is not part of the name.
    company: "Northwind Analytics",
    location: "Remote, Europe",
    remote: true,
    salary: { min: 95_000, max: 125_000, currency: "USD" },
    tags: [],
    // Query parameters (here tracking ones) are removed from the discovery link.
    provenance: provenance("himalayas", "https://himalayas.app/companies/northwind-analytics/jobs/senior-data-engineer", undefined),
  });
  assert.equal(result.jobs[0]?.canonical_url, undefined, "a Himalayas listing is never presented as the employer route");

  assert.deepEqual(withoutSignals(result.jobs[1]), {
    id: sha256("job:ostrava studio:support specialist:czechia"),
    title: "Support Specialist",
    company: "Ostrava Studio",
    location: "Czechia",
    remote: false,
    tags: [],
    provenance: provenance("himalayas", "https://himalayas.app/companies/ostrava-studio/jobs/support-specialist", undefined),
  });
});

void test("Himalayas fixture: structured content is preferred over the text block", async (t) => {
  pinClock(t);
  const stub = stubFetch({
    [himalayasUrl]: [
      () => jsonResponse(sourceFixture("himalayas-initialize.json")),
      () => jsonResponse(sourceFixture("himalayas-structured.json")),
    ],
  });
  const result = await new HimalayasProvider(true, himalayasUrl, stub.fetcher).search(searchQuery({ query: "advocate", remote_only: true }));

  assert.deepEqual(JSON.parse(stub.requests[1]?.body ?? "{}").params.arguments, { keyword: "advocate", worldwide: true });
  assert.equal(result.records_rejected, 0);
  assertSchemaValid(result);
  assert.deepEqual(result.jobs.map(withoutSignals), [{
    id: sha256("url:careers.bluefen.example/roles/developer-advocate"),
    title: "Developer Advocate",
    company: "Bluefen Labs",
    location: "Remote, EU",
    remote: true,
    date_posted: "2026-09-29",
    canonical_url: "https://careers.bluefen.example/roles/developer-advocate",
    tags: ["DevRel", "Machine Learning"],
    provenance: provenance("himalayas", "https://himalayas.app/companies/bluefen-labs/jobs/developer-advocate", undefined),
  }]);
});

// ---- JobSpy -------------------------------------------------------------------------------

// The JobSpy provider spawns a Python subprocess, which these tests cannot do without
// python-jobspy installed (and which would scrape live sites). After the subprocess returns,
// the provider does exactly this: `mapJobRecords("jobspy", findJobRecords(JSON.parse(stdout)))`.
// The fixture is the bridge's stdout shape: pandas rows serialised with nulls for missing cells.
function jobSpyResult(): ProviderSearchResult {
  return mapJobRecords("jobspy", findJobRecords(JSON.parse(sourceFixture("jobspy-bridge-output.json")) as unknown), 25);
}

void test("JobSpy fixture: every field and provenance from the bridge output", (t) => {
  pinClock(t);
  const result = jobSpyResult();
  assert.equal(result.records_rejected, 1, "the row with a null company is counted");
  assert.equal(result.jobs.length, 2);
  assertSchemaValid(result);

  const pm = result.jobs[0];
  assert.deepEqual(withoutSignals(pm), {
    // job_url_direct carries a trailing slash, which is not part of identity.
    id: sha256("url:careers.larkspur.example/jobs/pm-growth"),
    title: "Senior Product Manager, Growth",
    company: "Larkspur Robotics",
    location: "San Francisco, CA, US",
    remote: false,
    description: "Own **activation** and retention for our warehouse robot fleet software.",
    description_truncated: false,
    employment_type: "fulltime",
    date_posted: "2026-09-28",
    canonical_url: "https://careers.larkspur.example/jobs/pm-growth",
    // The "yearly" interval is not carried through today; see the todo test below.
    salary: { min: 170_000, max: 210_000, currency: "USD" },
    tags: [],
    provenance: provenance("jobspy", "https://www.indeed.com/viewjob?jk=8f3a2b1c0d9e", "in-8f3a2b1c0d9e"),
  });

  const technician = result.jobs[1];
  assert.equal(technician?.title, "Warehouse Robotics Technician");
  assert.equal(technician?.canonical_url, undefined, "a null job_url_direct leaves no employer route");
  assert.deepEqual(technician?.provenance, provenance("jobspy", "https://www.indeed.com/viewjob?jk=1a2b3c4d5e6f", "in-1a2b3c4d5e6f"));
  assert.equal(technician?.id, sha256("job:larkspur robotics:warehouse robotics technician:nv reno us"));
});

// python-jobspy reports intervals as "yearly", "monthly", "hourly" and so on, while the mapper
// accepts only the schema's own words ("year", "hour"). The amounts survive but the interval is
// dropped, so an hourly rate reads as an amount with no period. Left as a todo, not pinned as
// correct, so the gap stays visible in every test run until the mapper is fixed.
void test("JobSpy fixture: pay intervals are carried through", { todo: "map python-jobspy's yearly/hourly intervals onto the schema" }, () => {
  const [pm, technician] = jobSpyResult().jobs;
  assert.equal(pm?.salary?.interval, "year");
  assert.equal(technician?.salary?.interval, "hour");
});
