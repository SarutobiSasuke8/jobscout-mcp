import assert from "node:assert/strict";
import test from "node:test";

import { normalizeJob } from "../src/core.js";
import { summarizeYield } from "../src/yield.js";

import type { NormalizedJob } from "../src/types.js";

function job(options: {
  title: string;
  company: string;
  location?: string;
  provider: string;
  canonical?: string;
  date?: string;
}): NormalizedJob {
  return normalizeJob({
    title: options.title,
    company: options.company,
    location: options.location ?? "Dublin, Ireland",
    tags: [],
    ...(options.canonical ? { canonical_url: options.canonical } : {}),
    ...(options.date ? { date_posted: options.date } : {}),
    provenance: [{ provider: options.provider, captured_at: "2026-08-19T12:00:00.000Z" }],
  });
}

function bySource(report: ReturnType<typeof summarizeYield>, source: string) {
  const entry = report.sources.find((item) => item.source === source);
  assert.ok(entry, `expected a row for ${source}`);
  return entry;
}

void test("an empty pool reports zeros rather than failing", () => {
  const report = summarizeYield([]);
  assert.equal(report.total_jobs, 0);
  assert.deepEqual(report.sources, []);
});

// The point of the report: what would be lost by dropping a source. A source whose every find
// is also found elsewhere has a unique yield of zero, however many rows it returned.
void test("separates what a source found alone from what it merely restated", () => {
  const report = summarizeYield([
    job({ title: "Partnerships Manager", company: "Example AI", provider: "alpha" }),
    job({ title: "Partnerships Manager", company: "Example AI", provider: "beta" }),
    job({ title: "Growth Lead", company: "Other Co", provider: "alpha" }),
  ]);

  assert.equal(report.total_jobs, 2, "the shared vacancy collapses to one job");
  assert.equal(report.multi_source_jobs, 1);
  assert.equal(report.single_source_jobs, 1);

  assert.equal(bySource(report, "alpha").jobs, 2);
  assert.equal(bySource(report, "alpha").unique, 1);
  assert.equal(bySource(report, "alpha").shared, 1);
  assert.equal(bySource(report, "alpha").overlap_rate, 0.5);

  assert.equal(bySource(report, "beta").jobs, 1);
  assert.equal(bySource(report, "beta").unique, 0, "beta found nothing alpha did not");
  assert.equal(bySource(report, "beta").overlap_rate, 1);
});

// A high-volume source that restates one other source is the case the report exists to expose:
// the WWSHEMI sweep looked productive at 1,000 records and was mostly duplicates.
void test("a high-volume source that adds nothing scores zero unique", () => {
  const pool = [
    ...Array.from({ length: 20 }, (_, index) => job({ title: `Role ${index}`, company: `Company ${index}`, provider: "narrow" })),
    ...Array.from({ length: 20 }, (_, index) => job({ title: `Role ${index}`, company: `Company ${index}`, provider: "firehose" })),
  ];
  const report = summarizeYield(pool);

  assert.equal(report.total_jobs, 20, "40 records describe 20 vacancies");
  assert.equal(bySource(report, "firehose").jobs, 20);
  assert.equal(bySource(report, "firehose").unique, 0);
  assert.equal(bySource(report, "firehose").overlap_rate, 1);
});

void test("reports employer-route coverage per source", () => {
  const report = summarizeYield([
    job({ title: "Account Executive", company: "Alpha Co", provider: "ats", canonical: "https://jobs.alpha.example/ae" }),
    job({ title: "Sales Lead", company: "Beta Co", provider: "board" }),
  ]);

  assert.equal(report.with_canonical, 1);
  assert.equal(bySource(report, "ats").with_canonical, 1);
  assert.equal(bySource(report, "board").with_canonical, 0, "a discovery link is not an application route");
});

void test("counts records whose freshness cannot be checked", () => {
  const report = summarizeYield([
    job({ title: "Dated Role", company: "Alpha Co", provider: "board", date: "2026-08-18" }),
    job({ title: "Undated Role", company: "Beta Co", provider: "board" }),
  ]);
  assert.equal(report.undated, 1);
  assert.equal(bySource(report, "board").undated, 1);
});

// One URL naming two different employers is left unmerged for a human. A source producing them
// is a source to look at closely, so it is counted rather than buried.
void test("surfaces duplicate conflicts and attributes them to the sources involved", () => {
  const shared = "https://jobs.example.com/opening";
  const report = summarizeYield([
    job({ title: "Product Manager", company: "Real Employer", provider: "trusted", canonical: shared }),
    job({ title: "Product Manager", company: "Impostor Ltd", provider: "sketchy", canonical: shared }),
  ]);

  assert.equal(report.total_jobs, 2, "conflicting records must not be merged into one");
  assert.equal(report.conflicts, 2);
  assert.equal(bySource(report, "trusted").conflicts, 1);
  assert.equal(bySource(report, "sketchy").conflicts, 1);
});

void test("sources are ranked by contribution, then by name", () => {
  const report = summarizeYield([
    job({ title: "One", company: "A Co", provider: "small" }),
    job({ title: "Two", company: "B Co", provider: "big" }),
    job({ title: "Three", company: "C Co", provider: "big" }),
  ]);
  assert.deepEqual(report.sources.map((entry) => entry.source), ["big", "small"]);
});

// The tool must be safe to point at raw provider output, not only at an already-deduplicated
// pool, or the first number a user sees will be an inflated one.
void test("deduplicates its input, so raw provider output reports honest totals", () => {
  const duplicate = job({ title: "Partnerships Manager", company: "Example AI", provider: "alpha" });
  const report = summarizeYield([duplicate, duplicate, duplicate]);
  assert.equal(report.total_jobs, 1);
  assert.equal(bySource(report, "alpha").jobs, 1);
});
