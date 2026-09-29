import assert from "node:assert/strict";
import test from "node:test";

import { parseRemoteOkPayload } from "../src/providers/remoteok.js";

const payload = [
  { legal: "Attribution notice returned as the first element of the feed." },
  {
    slug: "example-corp-senior-backend-engineer",
    id: "1234",
    epoch: 1_786_000_000,
    date: "2026-08-18T12:00:00+00:00",
    company: "Example Corp",
    position: "Senior Backend Engineer",
    tags: ["backend", "golang"],
    description: "<p>Build our <strong>API</strong> platform &amp; tooling.</p>",
    location: "Worldwide",
    salary_min: 100_000,
    salary_max: 150_000,
    url: "https://remoteok.com/remote-jobs/1234-senior-backend-engineer",
    apply_url: "https://remoteok.com/l/1234",
  },
  {
    id: "5678",
    company: "Other Co",
    position: "Product Manager",
    tags: ["product"],
    description: "Own the product roadmap.",
    location: "",
    url: "https://remoteok.com/remote-jobs/5678-product-manager",
    apply_url: "https://otherco.example/careers/pm",
  },
];

void test("parses RemoteOK listings into normalized jobs", () => {
  const { jobs, records_rejected } = parseRemoteOkPayload(payload, "");
  assert.equal(jobs.length, 2);
  assert.equal(records_rejected, 0);
  const engineer = jobs.find((job) => job.company === "Example Corp");
  assert.equal(engineer?.title, "Senior Backend Engineer");
  assert.equal(engineer?.location, "Worldwide");
  assert.equal(engineer?.remote, true);
  assert.equal(engineer?.date_posted, "2026-08-18");
  assert.equal(engineer?.salary?.min, 100_000);
  assert.deepEqual(engineer?.tags, ["backend", "golang"]);
  // Description markup is reduced to text and entities decoded.
  assert.equal(engineer?.description, "Build our API platform & tooling.");
  assert.equal(engineer?.provenance[0]?.discovery_url, "https://remoteok.com/remote-jobs/1234-senior-backend-engineer");
  assert.equal(engineer?.provenance[0]?.source_job_id, "1234");
});

// canonical_url means "employer application route" and is the primary dedup identity. An
// aggregator's own redirect is neither, so it must not be promoted into that field.
void test("does not treat a RemoteOK redirect as an employer application route", () => {
  const { jobs } = parseRemoteOkPayload(payload, "");
  const engineer = jobs.find((job) => job.company === "Example Corp");
  assert.equal(engineer?.canonical_url, undefined, "remoteok.com/l/ links are provenance, not canonical");
});

void test("keeps a genuine off-domain employer apply route as canonical", () => {
  const { jobs } = parseRemoteOkPayload(payload, "");
  const manager = jobs.find((job) => job.company === "Other Co");
  assert.equal(manager?.canonical_url, "https://otherco.example/careers/pm");
});

void test("defaults a blank location to Remote rather than Unknown", () => {
  const { jobs } = parseRemoteOkPayload(payload, "");
  assert.equal(jobs.find((job) => job.company === "Other Co")?.location, "Remote");
});

// The attribution notice is metadata, not a malformed listing; counting it would make the
// drift signal permanently noisy.
void test("skips the legal notice without counting it as a rejection", () => {
  const { jobs, records_rejected } = parseRemoteOkPayload([{ legal: "notice" }], "");
  assert.equal(jobs.length, 0);
  assert.equal(records_rejected, 0);
});

void test("counts unreadable listings so shape drift stays visible", () => {
  const { jobs, records_rejected } = parseRemoteOkPayload([{ company: "No Position Co", url: "https://remoteok.com/x" }], "");
  assert.equal(jobs.length, 0);
  assert.equal(records_rejected, 1);
});

void test("ranks listings matching more query terms above single-term matches", () => {
  const { jobs } = parseRemoteOkPayload(payload, "product manager");
  assert.equal(jobs[0]?.company, "Other Co", "the listing matching both terms must rank first");
});

void test("falls back to the epoch timestamp when no date string is present", () => {
  const { jobs } = parseRemoteOkPayload([{
    id: "9",
    company: "Epoch Co",
    position: "Engineer",
    url: "https://remoteok.com/remote-jobs/9",
    epoch: 1_786_000_000,
  }], "");
  assert.equal(jobs[0]?.date_posted, new Date(1_786_000_000 * 1_000).toISOString().slice(0, 10));
});

void test("a non-array payload yields no jobs rather than throwing", () => {
  assert.deepEqual(parseRemoteOkPayload({ jobs: [] }, ""), { jobs: [], records_rejected: 0 });
});
