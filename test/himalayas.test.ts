import assert from "node:assert/strict";
import test from "node:test";

import { parseHimalayasMarkdown } from "../src/providers/himalayas.js";

void test("parses the live Himalayas MCP markdown result shape", () => {
  const markdown = `Found 1 job

🚀 **Partnerships Manager**
🏢 Example AI ✅

🕘 Full-time • Ireland
💵 $60,000 - $80,000 USD
📂 Partnerships

🔗 **Apply on Himalayas:** https://himalayas.app/companies/example/jobs/partnerships-manager?utm_source=mcp
🏢 **Company Page:** https://himalayas.app/companies/example
`;
  const { jobs } = parseHimalayasMarkdown(markdown);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.title, "Partnerships Manager");
  assert.equal(jobs[0]?.company, "Example AI");
  assert.equal(jobs[0]?.location, "Ireland");
  assert.equal(jobs[0]?.salary?.min, 60_000);
  assert.equal(jobs[0]?.provenance[0]?.discovery_url, "https://himalayas.app/companies/example/jobs/partnerships-manager");
});
