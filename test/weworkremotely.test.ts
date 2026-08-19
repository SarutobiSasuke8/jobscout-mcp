import assert from "node:assert/strict";
import test from "node:test";

import { parseWeWorkRemotelyRss } from "../src/providers/weworkremotely.js";

const feed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
<title>We Work Remotely</title>
<item>
<title>Example Corp: Senior Backend Engineer</title>
<link>https://weworkremotely.com/remote-jobs/example-corp-senior-backend-engineer</link>
<pubDate>Mon, 18 Aug 2026 00:00:00 +0000</pubDate>
<description><![CDATA[<p>Build our <strong>API</strong> platform.</p>]]></description>
<region><![CDATA[Anywhere in the World]]></region>
<category>Programming</category>
</item>
<item>
<title>No Colon Listing</title>
<link>https://weworkremotely.com/remote-jobs/no-colon-listing</link>
<pubDate>Tue, 19 Aug 2026 00:00:00 +0000</pubDate>
<description><![CDATA[Some other role.]]></description>
</item>
</channel>
</rss>`;

void test("parses We Work Remotely RSS items into normalized jobs", () => {
  const { jobs, records_rejected } = parseWeWorkRemotelyRss(feed, "");
  assert.equal(jobs.length, 2);
  assert.equal(records_rejected, 0);
  assert.equal(jobs[0]?.title, "Senior Backend Engineer");
  assert.equal(jobs[0]?.company, "Example Corp");
  assert.equal(jobs[0]?.location, "Anywhere in the World");
  assert.equal(jobs[0]?.remote, true);
  assert.match(jobs[0]?.description ?? "", /Build our API platform/u);
  assert.equal(jobs[0]?.date_posted, "2026-08-18");
  assert.equal(jobs[0]?.provenance[0]?.discovery_url, "https://weworkremotely.com/remote-jobs/example-corp-senior-backend-engineer");
});

void test("falls back to Unknown company when the feed omits the colon convention", () => {
  const { jobs } = parseWeWorkRemotelyRss(feed, "");
  assert.equal(jobs[1]?.company, "Unknown");
  assert.equal(jobs[1]?.title, "No Colon Listing");
});

void test("filters items client-side by query since RSS has no search endpoint", () => {
  const { jobs, records_rejected } = parseWeWorkRemotelyRss(feed, "backend");
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.company, "Example Corp");
  assert.equal(records_rejected, 0);
});

void test("a query matching nothing returns no jobs and no rejections", () => {
  const { jobs, records_rejected } = parseWeWorkRemotelyRss(feed, "nonexistentroletoken");
  assert.equal(jobs.length, 0);
  assert.equal(records_rejected, 0);
});
