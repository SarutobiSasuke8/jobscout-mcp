import assert from "node:assert/strict";
import test from "node:test";

import { deduplicateJobs, normalizeJob } from "../src/core.js";

const capturedAt = "2026-08-05T12:00:00.000Z";

void test("deduplicates normalized company, title and location", () => {
  const left = normalizeJob({
    title: "Partnership Manager",
    company: "Example AI",
    location: "Remote, Europe",
    description: "Short description",
    tags: ["partnerships"],
    provenance: [{ provider: "one", discovery_url: "https://example.com/jobs/1", captured_at: capturedAt }],
  });
  const right = normalizeJob({
    title: "  Partnership   Manager ",
    company: "EXAMPLE AI",
    location: "Remote Europe",
    description: "A much longer and more useful description of the opportunity.",
    tags: ["ai"],
    provenance: [{ provider: "two", discovery_url: "https://board.example/jobs/abc", captured_at: capturedAt }],
  });

  const jobs = deduplicateJobs([left, right]);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.provenance.length, 2);
  assert.match(jobs[0]?.description ?? "", /more useful/u);
  assert.deepEqual(jobs[0]?.tags.sort(), ["ai", "partnerships"]);
});

void test("canonical URLs override text identity", () => {
  const url = "https://jobs.example.com/requisitions/42";
  const jobs = deduplicateJobs([
    normalizeJob({
      title: "Partner Lead",
      company: "Example",
      location: "Ireland",
      canonical_url: url,
      tags: [],
      provenance: [{ provider: "one", captured_at: capturedAt }],
    }),
    normalizeJob({
      title: "Partnerships Lead",
      company: "Example Inc.",
      location: "Dublin",
      canonical_url: url,
      tags: [],
      provenance: [{ provider: "two", captured_at: capturedAt }],
    }),
  ]);
  assert.equal(jobs.length, 1);
});
