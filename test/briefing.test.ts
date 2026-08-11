import assert from "node:assert/strict";
import test from "node:test";

import { toBriefingEntry } from "../src/briefing.js";
import { normalizeJob } from "../src/core.js";

const capturedAt = "2026-08-11T12:00:00.000Z";

// jobscout-mcp#3: consumers re-normalizing records dropped URLs. The briefing projection is
// the standard shape, so its link-fallback rule is the part that must never regress.
void test("briefing entry prefers the employer application route over the discovery page", () => {
  const entry = toBriefingEntry(normalizeJob({
    title: "Growth Marketing Lead",
    company: "Thatch",
    location: "United States",
    remote: false,
    canonical_url: "https://jobs.thatch.example/growth-lead",
    salary: { min: 145_000, max: 193_000, currency: "USD" },
    tags: [],
    provenance: [{ provider: "himalayas", discovery_url: "https://himalayas.app/companies/thatch/jobs/growth-marketing-lead", captured_at: capturedAt }],
  }));

  assert.equal(entry.url, "https://jobs.thatch.example/growth-lead");
  assert.equal(entry.url_kind, "canonical");
  assert.equal(entry.one_line, "Growth Marketing Lead at Thatch, United States, $145K-$193K");
});

void test("briefing entry falls back to the discovery page and says so", () => {
  const entry = toBriefingEntry(normalizeJob({
    title: "Partnerships Lead",
    company: "Example AI",
    location: "Remote, Europe",
    remote: true,
    tags: [],
    provenance: [{ provider: "himalayas", discovery_url: "https://himalayas.app/jobs/123", captured_at: capturedAt }],
  }));

  assert.equal(entry.url, "https://himalayas.app/jobs/123");
  assert.equal(entry.url_kind, "discovery");
  assert.equal(entry.one_line, "Partnerships Lead at Example AI, Remote, Europe, remote");
});

void test("briefing entry with no link at all is explicit about it", () => {
  const entry = toBriefingEntry(normalizeJob({
    title: "Ops Manager",
    company: "Example",
    location: "Unknown",
    tags: [],
    provenance: [{ provider: "test", captured_at: capturedAt }],
  }));

  assert.equal(entry.url, null);
  assert.equal(entry.url_kind, "none");
  assert.equal(entry.one_line, "Ops Manager at Example");
});
