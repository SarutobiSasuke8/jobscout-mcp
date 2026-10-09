import assert from "node:assert/strict";
import test from "node:test";

import { atsRequisition, deduplicateJobs, normalizeJob } from "../src/core.js";
import type { NormalizedJob } from "../src/types.js";

// Hand-labelled synthetic vacancies. Different requisitions must survive even when
// the employer reuses a title. A board copy without a direct URL cannot choose one.
function vacancy(source: string, url?: string, company = "Example", title = "Engineer"): NormalizedJob {
  return normalizeJob({
    title, company, location: "Dublin", tags: [],
    ...(url ? {canonical_url: url} : {}),
    provenance: [{provider: source, source_job_id: source, captured_at: "2026-09-01T12:00:00.000Z"}],
  });
}

function permutations<T>(items: T[]): T[][] {
  if (items.length < 2) return [items];
  return items.flatMap((item, index) => permutations(items.filter((_, i) => i !== index)).map(rest => [item, ...rest]));
}

const corpus = [
  {name: "distinct requisitions", records: [vacancy("a", "https://jobs.example/1"), vacancy("b", "https://jobs.example/2")], groups: [["a"], ["b"]]},
  {name: "ambiguous board copy cannot bridge requisitions", records: [vacancy("a", "https://jobs.example/1"), vacancy("b", "https://jobs.example/2"), vacancy("c")], groups: [["a"], ["b"], ["c"]]},
  {name: "unambiguous board copy merges", records: [vacancy("a", "https://jobs.example/1"), vacancy("b")], groups: [["a", "b"]]},
  {name: "employer name prefix is not identity", records: [vacancy("a", "https://jobs.example/1", "Example"), vacancy("b", "https://jobs.example/1", "Example Recruitment Scam")], groups: [["a"], ["b"]]},
  {name: "legal suffix variation merges", records: [vacancy("a", "https://jobs.example/1", "Example"), vacancy("b", "https://jobs.example/1", "Example Inc.")], groups: [["a", "b"]]},
  {name: "repeat conflicting employer keeps its own provenance", records: [vacancy("a", "https://jobs.example/1", "Example"), vacancy("b", "https://jobs.example/1", "Other"), vacancy("c", "https://jobs.example/1", "Other")], groups: [["a"], ["b", "c"]]},
  {name: "non-Latin employers remain distinct", records: [vacancy("a", undefined, "株式会社甲"), vacancy("b", undefined, "株式会社乙")], groups: [["a"], ["b"]]},
  // ATS requisition links. Boards copy whichever form they scraped; the requisition id decides.
  {name: "board copy of a Greenhouse requisition on another host merges", records: [vacancy("greenhouse", "https://job-boards.greenhouse.io/example/jobs/4000001"), vacancy("board", "https://boards.greenhouse.io/example/jobs/4000001?gh_src=feed"), vacancy("careers", "https://example.com/careers/open-roles?gh_jid=4000001")], groups: [["board", "careers", "greenhouse"]]},
  {name: "distinct Greenhouse requisitions with one title stay separate", records: [vacancy("greenhouse", "https://job-boards.greenhouse.io/example/jobs/4000001"), vacancy("board", "https://boards.greenhouse.io/example/jobs/4000002")], groups: [["greenhouse"], ["board"]]},
  {name: "Lever apply link merges with the hosted posting", records: [vacancy("lever", "https://jobs.lever.co/example/0b1c2d3e-0000-4000-8000-000000000001"), vacancy("board", "https://jobs.lever.co/example/0b1c2d3e-0000-4000-8000-000000000001/apply")], groups: [["board", "lever"]]},
  {name: "Ashby application link merges with the hosted posting", records: [vacancy("ashby", "https://jobs.ashbyhq.com/example/0b1c2d3e-0000-4000-8000-000000000002"), vacancy("board", "https://jobs.ashbyhq.com/Example/0B1C2D3E-0000-4000-8000-000000000002/application")], groups: [["ashby", "board"]]},
  {name: "unambiguous text-only board copy merges into the ATS record", records: [vacancy("greenhouse", "https://job-boards.greenhouse.io/example/jobs/4000001"), vacancy("board")], groups: [["board", "greenhouse"]]},
  {name: "same requisition id under another employer name is a conflict, not a merge", records: [vacancy("greenhouse", "https://job-boards.greenhouse.io/example/jobs/4000001"), vacancy("board", "https://boards.greenhouse.io/other/jobs/4000001", "Other")], groups: [["greenhouse"], ["board"]]},
];

for (const fixture of corpus) {
  void test(`deduplication corpus: ${fixture.name} in every input order`, () => {
    for (const input of permutations(fixture.records)) {
      const output = deduplicateJobs(input);
      const groups = output.map(job => job.provenance.map(p => p.provider).sort().join(",")).sort();
      assert.deepEqual(groups, fixture.groups.map(group => [...group].sort().join(",")).sort());
      assert.equal(new Set(output.map(job => job.id)).size, output.length, "distinct records need distinct output ids");
      if (fixture.name.includes("ambiguous board copy cannot")) assert(output.every(job => job.duplicate_conflict));
    }
  });
}

void test("deduplication preserves description truncation evidence", () => {
  const job = normalizeJob({...vacancy("a"), description: "x".repeat(6000)});
  assert.equal(deduplicateJobs([job])[0]?.description_truncated, true);
  assert.equal(deduplicateJobs([job, vacancy("b")])[0]?.description_truncated, true);
});

// The ATS record is first-party: whichever order results arrive in, its requisition URL is the
// canonical employer link and the board copy survives only as provenance.
void test("deduplication makes the ATS requisition URL canonical over a board copy", () => {
  const ats = vacancy("greenhouse", "https://job-boards.greenhouse.io/example/jobs/4000001");
  const board = vacancy("board", "https://boards.greenhouse.io/example/jobs/4000001?gh_src=feed");
  for (const input of [[ats, board], [board, ats]]) {
    const [merged, ...rest] = deduplicateJobs(input);
    assert.equal(rest.length, 0);
    assert.equal(merged?.canonical_url, "https://job-boards.greenhouse.io/example/jobs/4000001");
    assert.deepEqual(merged?.provenance.map(p => p.provider).sort(), ["board", "greenhouse"]);
  }
});

void test("ATS requisition identity recognises each vendor's link forms and nothing else", () => {
  assert.deepEqual(atsRequisition("https://boards.greenhouse.io/embed/job_app?for=example&token=4000001"), {vendor: "greenhouse", id: "4000001"});
  assert.deepEqual(atsRequisition("https://jobs.eu.lever.co/example/0B1C2D3E-0000-4000-8000-000000000001"), {vendor: "lever", id: "0b1c2d3e-0000-4000-8000-000000000001"});
  assert.deepEqual(atsRequisition("https://careers.example.com/role?ashby_jid=0b1c2d3e-0000-4000-8000-000000000002"), {vendor: "ashby", id: "0b1c2d3e-0000-4000-8000-000000000002"});
  assert.equal(atsRequisition("https://jobs.lever.co/example"), undefined, "a board index is not a requisition");
  assert.equal(atsRequisition("https://job-boards.greenhouse.io/example"), undefined);
  assert.equal(atsRequisition("https://jobs.example/1"), undefined);
  assert.equal(atsRequisition("not a url"), undefined);
});
