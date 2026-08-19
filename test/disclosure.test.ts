import assert from "node:assert/strict";
import test from "node:test";

import { normalizeJob } from "../src/core.js";
import { ProviderRegistry, resolveCacheTtlMs } from "../src/registry.js";
import { searchQuery } from "./support.js";

import type { JobProvider, NormalizedJob, ProviderStatus } from "../src/types.js";

const today = new Date().toISOString().slice(0, 10);

function job(overrides: { title?: string; company?: string; datePosted?: string; description?: string }): NormalizedJob {
  return normalizeJob({
    title: overrides.title ?? "Account Executive",
    company: overrides.company ?? "Example",
    location: "Ireland",
    tags: [],
    ...(overrides.datePosted ? { date_posted: overrides.datePosted } : {}),
    ...(overrides.description ? { description: overrides.description } : {}),
    provenance: [{ provider: "fixture", captured_at: "2026-08-05T12:00:00.000Z" }],
  });
}

function provider(status: Partial<ProviderStatus> & { id: string }, jobs: NormalizedJob[], extra: { rejected?: number; warnings?: string[] } = {}): JobProvider {
  return {
    status: () => ({ label: status.id, enabled: true, authentication: "none", notes: "fixture", ...status }),
    search: async () => ({
      jobs,
      records_rejected: extra.rejected ?? 0,
      ...(extra.warnings ? { warnings: extra.warnings } : {}),
    }),
  };
}

// A whole-feed source has no location parameter to pass upstream, so a city-scoped search
// reaches it unscoped. Reporting that is the difference between "nothing there" and "nobody
// asked on your behalf".
void test("discloses providers that ignored the requested location", async () => {
  const registry = new ProviderRegistry([
    provider({ id: "scoped", location_filtering: "provider" }, [job({ company: "Scoped Co" })]),
    provider({ id: "wholefeed", location_filtering: "none" }, [job({ company: "Feed Co" })]),
  ]);
  const result = await registry.search(searchQuery({ location: "Dublin" }));
  assert.deepEqual(result.location_unfiltered, ["wholefeed"]);
});

void test("reports no location caveat when no location was requested", async () => {
  const registry = new ProviderRegistry([provider({ id: "wholefeed", location_filtering: "none" }, [job({})])]);
  const result = await registry.search(searchQuery());
  assert.deepEqual(result.location_unfiltered, []);
});

void test("attributes rejected records to the provider that produced them", async () => {
  const registry = new ProviderRegistry([
    provider({ id: "clean" }, [job({ company: "Clean Co" })], { rejected: 0 }),
    provider({ id: "drifting" }, [job({ company: "Drift Co" })], { rejected: 7 }),
  ]);
  const result = await registry.search(searchQuery());
  assert.equal(result.records_rejected, 7, "the aggregate still reports the total");
  assert.deepEqual(result.records_rejected_by_provider, { clean: 0, drifting: 7 });
});

void test("surfaces provider warnings without treating them as failures", async () => {
  const registry = new ProviderRegistry([
    provider({ id: "degraded" }, [job({})], { warnings: ["served the last cached copy"] }),
  ]);
  const result = await registry.search(searchQuery());
  assert.equal(result.failures.length, 0, "a warning is not a failure");
  assert.deepEqual(result.warnings, [{ provider: "degraded", warning: "served the last cached copy" }]);
  assert.equal(result.jobs.length, 1);
});

void test("hours_old drops records older than the window", async () => {
  const registry = new ProviderRegistry([
    provider({ id: "mixed" }, [job({ company: "Fresh Co", datePosted: today }), job({ company: "Old Co", datePosted: "2020-01-01" })]),
  ]);
  const result = await registry.search(searchQuery({ hours_old: 48 }));
  assert.deepEqual(result.jobs.map((entry) => entry.company), ["Fresh Co"]);
});

// An undated record cannot be shown to be fresh, only assumed to be. The default keeps and
// counts it; require_dated is for callers who would rather have fewer results than undatable
// ones.
void test("undated records survive hours_old by default but are counted", async () => {
  const registry = new ProviderRegistry([
    provider({ id: "mixed" }, [job({ company: "Fresh Co", datePosted: today }), job({ company: "Undated Co" })]),
  ]);
  const result = await registry.search(searchQuery({ hours_old: 24 }));
  assert.equal(result.jobs.length, 2);
  assert.equal(result.undated_records, 1);
});

void test("require_dated removes records that carry no posting date", async () => {
  const registry = new ProviderRegistry([
    provider({ id: "mixed" }, [job({ company: "Fresh Co", datePosted: today }), job({ company: "Undated Co" })]),
  ]);
  const result = await registry.search(searchQuery({ hours_old: 24, require_dated: true }));
  assert.deepEqual(result.jobs.map((entry) => entry.company), ["Fresh Co"]);
  assert.equal(result.undated_records, 0);
});

void test("include_descriptions=false strips the untrusted prose from results", async () => {
  const registry = new ProviderRegistry([
    provider({ id: "verbose" }, [job({ description: "A long job description." })]),
  ]);
  const withText = await registry.search(searchQuery());
  assert.equal(withText.jobs[0]?.description, "A long job description.");

  const without = await registry.search(searchQuery({ include_descriptions: false }));
  assert.equal(without.jobs[0]?.description, undefined);
  assert.equal(without.jobs[0]?.description_truncated, undefined);
  assert.equal(without.jobs[0]?.title, "Account Executive", "the rest of the record is untouched");
});

void test("cache TTL resolution clamps nonsense and honours an explicit zero", () => {
  assert.equal(resolveCacheTtlMs(undefined), 300_000);
  assert.equal(resolveCacheTtlMs("0"), 0);
  assert.equal(resolveCacheTtlMs("-5"), 300_000);
  assert.equal(resolveCacheTtlMs("not a number"), 300_000);
  assert.equal(resolveCacheTtlMs("90000000"), 60 * 60 * 1_000, "clamped to one hour");
});
