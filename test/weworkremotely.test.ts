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
<guid>https://weworkremotely.com/remote-jobs/example-corp-senior-backend-engineer</guid>
<pubDate>Mon, 18 Aug 2026 00:00:00 +0000</pubDate>
<description><![CDATA[<p>Build our <strong>API</strong> platform.</p>]]></description>
<region><![CDATA[Anywhere in the World]]></region>
<category>Programming</category>
<type>Full-Time</type>
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
  assert.equal(jobs[0]?.employment_type, "Full-Time");
  assert.equal(jobs[0]?.provenance[0]?.discovery_url, "https://weworkremotely.com/remote-jobs/example-corp-senior-backend-engineer");
  assert.equal(jobs[0]?.provenance[0]?.source_job_id, "https://weworkremotely.com/remote-jobs/example-corp-senior-backend-engineer");
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

// The caller slices to `limit`, so ordering decides what survives truncation. Without ranking,
// a two-word query returns whatever the feed listed first among single-word matches.
void test("ranks listings matching more query terms above single-term matches", () => {
  const ranked = `<rss><channel>
<item><title>A Co: Support Manager</title><link>https://weworkremotely.com/remote-jobs/a</link><description><![CDATA[Support work.]]></description></item>
<item><title>B Co: Product Manager</title><link>https://weworkremotely.com/remote-jobs/b</link><description><![CDATA[Own the product roadmap.]]></description></item>
</channel></rss>`;
  const { jobs } = parseWeWorkRemotelyRss(ranked, "product manager");
  assert.equal(jobs.length, 2, "both listings match on at least one term");
  assert.equal(jobs[0]?.company, "B Co", "the listing matching both terms must rank first");
});

void test("decodes HTML entities without manufacturing markup from escaped prose", () => {
  const entities = `<rss><channel>
<item>
<title>Ops &amp; Co: Data &#38; Analytics Lead</title>
<link>https://weworkremotely.com/remote-jobs/ops</link>
<description><![CDATA[<p>Compare &lt;script&gt; tags &amp; templates.</p>]]></description>
</item>
</channel></rss>`;
  const { jobs } = parseWeWorkRemotelyRss(entities, "");
  assert.equal(jobs[0]?.company, "Ops & Co");
  assert.equal(jobs[0]?.title, "Data & Analytics Lead");
  // Escaped markup stays inert text; it must not come back as a real tag.
  assert.equal(jobs[0]?.description, "Compare <script> tags & templates.");
});

void test("prefers an explicit company element over splitting the title", () => {
  const explicit = `<rss><channel>
<item>
<title>Engineer: Platform</title>
<company>Example Corp</company>
<link>https://weworkremotely.com/remote-jobs/platform</link>
</item>
</channel></rss>`;
  const { jobs } = parseWeWorkRemotelyRss(explicit, "");
  assert.equal(jobs[0]?.company, "Example Corp");
  // The colon here belongs to the role name, so the title must survive intact.
  assert.equal(jobs[0]?.title, "Engineer: Platform");
});

// records_rejected is the only signal that the feed's shape has drifted, so an item this
// parser cannot read must be counted rather than quietly skipped.
void test("counts unreadable items instead of dropping them silently", () => {
  const broken = `<rss><channel>
<item><description><![CDATA[No title and no link.]]></description></item>
<item><title>Good Co: Real Role</title><link>https://weworkremotely.com/remote-jobs/real</link></item>
</channel></rss>`;
  const { jobs, records_rejected } = parseWeWorkRemotelyRss(broken, "");
  assert.equal(jobs.length, 1);
  assert.equal(records_rejected, 1);
});
