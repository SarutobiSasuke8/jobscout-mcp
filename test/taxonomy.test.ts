import assert from "node:assert/strict";
import test from "node:test";

import { classifyJob } from "../src/taxonomy.js";

void test("classifies cross-domain agentic Web3 infrastructure signals", () => {
  const signals = classifyJob({
    title: "Agent Partnerships Lead",
    company: "Example Protocol",
    location: "Remote",
    description: "Grow an MCP and x402 ecosystem on Base for agent payments and developer partners.",
    tags: ["web3", "AI agents"],
  });

  assert.deepEqual(signals.domains.sort(), ["ai", "web3"]);
  assert.ok(signals.categories.includes("ai-agents"));
  assert.ok(signals.categories.includes("agentic-commerce"));
  assert.ok(signals.categories.includes("web3-protocols"));
  assert.deepEqual(signals.technologies.sort(), ["Base", "MCP", "x402"]);
  assert.equal(signals.confidence, "high");
});

void test("does not confuse substrings with AI or Base technologies", () => {
  const signals = classifyJob({
    title: "Database Administrator",
    company: "Main Street Retail",
    location: "Dublin",
    description: "Maintain relational databases and reporting.",
    tags: [],
  });

  assert.deepEqual(signals.domains, []);
  assert.deepEqual(signals.technologies, []);
  assert.equal(signals.confidence, "none");
});

// Negative fixtures. Each of these is ordinary job-advert English that the v0.2 classifier
// scored as AI or Web3, several at "high" confidence. docs/JOB_INTELLIGENCE.md asks for an
// ambiguity negative fixture and AGENTS.md requires a fixture per schema change.
const ambiguousPhrases: Array<[string, string]> = [
  ["base salary", "Base salary from 28k depending on experience."],
  ["customer base", "Grow our customer base across the region."],
  ["home-based", "This is a home-based role with occasional travel."],
  ["clinical protocol", "Follow the infection control protocol at all times."],
  ["security protocol", "Maintain the building security protocol."],
  ["customer wallet", "Handle the customer wallet and lost property process."],
  ["treasury liquidity", "Monitor treasury liquidity and short-term funding."],
  ["performance evaluation", "Lead the annual performance evaluation cycle."],
  ["stakeholder alignment", "Drive stakeholder alignment across departments."],
  ["oracle database", "Administer the Oracle database estate."],
];

for (const [label, description] of ambiguousPhrases) {
  void test(`does not classify ordinary job-advert English: ${label}`, () => {
    const signals = classifyJob({
      title: "Operations Manager",
      company: "Riverside Care Group",
      location: "Manchester",
      description,
      tags: [],
    });

    assert.deepEqual(signals.domains, [], `"${label}" produced domains ${JSON.stringify(signals.domains)}`);
    assert.deepEqual(signals.categories, []);
    assert.deepEqual(signals.technologies, []);
    assert.equal(signals.confidence, "none");
  });
}

void test("a nursing vacancy is not high-confidence AI and Web3", () => {
  const signals = classifyJob({
    title: "Staff Nurse",
    company: "Riverside Care Home",
    location: "Leeds",
    description: "Base salary from 28k. Follow the infection control protocol, complete clinical evaluation records and support stakeholder alignment with families.",
    tags: [],
  });

  assert.deepEqual(signals.domains, []);
  assert.equal(signals.confidence, "none");
});

void test("a retail bank operations role is not DeFi", () => {
  const signals = classifyJob({
    title: "Operations Manager",
    company: "High Street Bank",
    location: "Birmingham",
    description: "Own treasury liquidity reporting, the customer wallet recovery process and branch security protocol compliance.",
    tags: [],
  });

  assert.deepEqual(signals.domains, []);
  assert.deepEqual(signals.categories, []);
});

// Positive control: the anchored short forms must still work when the listing really is on-domain,
// otherwise the precision fix would have cost the recall the feature exists for.
void test("anchored short forms still resolve when the listing is genuinely on-domain", () => {
  const signals = classifyJob({
    title: "Protocol Partnerships Lead",
    company: "Example Labs",
    location: "Remote",
    description: "Grow the protocol on Base, integrate wallet providers and deepen onchain liquidity.",
    tags: ["web3"],
  });

  assert.ok(signals.domains.includes("web3"));
  assert.ok(signals.categories.includes("web3-protocols"));
  assert.ok(signals.technologies.includes("Base"));
});

// Confidence must rest on a specific term, not on an accumulation of weak ones.
void test("weak signals alone cannot reach high confidence", () => {
  const signals = classifyJob({
    title: "Systems Administrator",
    company: "University Computing Centre",
    location: "Bristol",
    description: "Maintain the GPU cluster used for statistical inference workloads. AI workloads are scheduled nightly.",
    tags: [],
  });

  assert.notEqual(signals.confidence, "high");
});
