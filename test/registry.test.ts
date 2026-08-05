import assert from "node:assert/strict";
import test from "node:test";

import { normalizeJob } from "../src/core.js";
import { ProviderRegistry } from "../src/registry.js";

import type { JobProvider } from "../src/types.js";

const working: JobProvider = {
  status: () => ({ id: "working", label: "Working", enabled: true, authentication: "none", notes: "fixture" }),
  search: async () => [normalizeJob({
    title: "Account Executive",
    company: "Example",
    location: "Ireland",
    tags: [],
    provenance: [{ provider: "working", captured_at: "2026-08-05T12:00:00.000Z" }],
  })],
};

const failing: JobProvider = {
  status: () => ({ id: "failing", label: "Failing", enabled: true, authentication: "none", notes: "fixture" }),
  search: async () => { throw new Error("source unavailable"); },
};

void test("returns partial results when one provider fails", async () => {
  const result = await new ProviderRegistry([working, failing]).search({ query: "sales", remote_only: false, limit: 25 });
  assert.equal(result.jobs.length, 1);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0]?.provider, "failing");
});
