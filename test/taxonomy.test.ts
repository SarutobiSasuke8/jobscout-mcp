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
