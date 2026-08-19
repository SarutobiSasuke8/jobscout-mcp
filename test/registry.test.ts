import assert from "node:assert/strict";
import test from "node:test";

import { normalizeJob } from "../src/core.js";
import { ProviderRegistry, resolveJobSpySites } from "../src/registry.js";
import { searchQuery } from "./support.js";

import type { JobProvider } from "../src/types.js";

const working: JobProvider = {
  status: () => ({ id: "working", label: "Working", enabled: true, authentication: "none", notes: "fixture" }),
  search: async () => ({
    jobs: [normalizeJob({
      title: "Account Executive",
      company: "Example",
      location: "Ireland",
      tags: [],
      provenance: [{ provider: "working", captured_at: "2026-08-05T12:00:00.000Z" }],
    })],
    records_rejected: 2,
  }),
};

const failing: JobProvider = {
  status: () => ({ id: "failing", label: "Failing", enabled: true, authentication: "none", notes: "fixture" }),
  search: async () => { throw new Error("source unavailable"); },
};

const disabled: JobProvider = {
  status: () => ({ id: "disabled", label: "Disabled", enabled: false, authentication: "none", notes: "fixture" }),
  search: async () => ({ jobs: [], records_rejected: 0 }),
};

void test("returns partial results when one provider fails", async () => {
  const result = await new ProviderRegistry([working, failing]).search(searchQuery());
  assert.equal(result.jobs.length, 1);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0]?.provider, "failing");
});

void test("reports unknown requested sources", async () => {
  const result = await new ProviderRegistry([working]).search(searchQuery({ sources: ["working", "missing"] }));
  assert.deepEqual(result.unknown_sources, ["missing"]);
});

void test("enforces remote-only filters after provider retrieval", async () => {
  const result = await new ProviderRegistry([working]).search(searchQuery({ remote_only: true }));
  assert.equal(result.jobs.length, 0);
});

// Which sites JobSpy contacts is a disclosure question. The default must stay conservative and
// unrecognised values must never be forwarded to the bridge.
void test("JobSpy site resolution defaults to Indeed only", () => {
  assert.deepEqual(resolveJobSpySites(undefined), ["indeed"]);
  assert.deepEqual(resolveJobSpySites(""), ["indeed"]);
  assert.deepEqual(resolveJobSpySites("   "), ["indeed"]);
});

void test("JobSpy site resolution accepts a documented list and drops unknown values", () => {
  assert.deepEqual(resolveJobSpySites("linkedin, glassdoor"), ["linkedin", "glassdoor"]);
  assert.deepEqual(resolveJobSpySites("indeed,notareal site,google"), ["indeed", "google"]);
  assert.deepEqual(resolveJobSpySites("INDEED,indeed"), ["indeed"]);
  assert.deepEqual(resolveJobSpySites("nothing recognisable"), ["indeed"]);
});

// Honest-results contract (v0.2.1). A fresh install has zero enabled providers; without an
// explicit setup_required flag the empty success reads as "no jobs matched", which is false.
void test("a search with zero enabled providers says setup is required", async () => {
  const result = await new ProviderRegistry([disabled]).search(searchQuery());
  assert.equal(result.setup_required, true);
  assert.deepEqual(result.providers_disabled, ["disabled"]);
  assert.match(result.message ?? "", /No providers are enabled/u);
  assert.equal(result.jobs.length, 0);
});

void test("a search with an enabled provider does not raise setup_required", async () => {
  const result = await new ProviderRegistry([working, disabled]).search(searchQuery());
  assert.equal(result.setup_required, undefined);
  assert.deepEqual(result.providers_disabled, ["disabled"]);
});

void test("rejected and undated records are counted, not silently dropped", async () => {
  const result = await new ProviderRegistry([working]).search(searchQuery());
  assert.equal(result.records_rejected, 2, "provider-reported rejections must surface");
  assert.equal(result.undated_records, 1, "the fixture job has no date_posted");
});
