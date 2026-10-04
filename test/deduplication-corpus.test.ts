import assert from "node:assert/strict";
import test from "node:test";

import { deduplicateJobs, normalizeJob } from "../src/core.js";
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
