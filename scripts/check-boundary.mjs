/**
 * Public/private boundary gate.
 *
 * JobScout is the public, vendor-neutral half of a two-repository system. The rule that keeps
 * it publishable lives in AGENTS.md as prose, which means nothing enforces it. That is not
 * theoretical: a hardcoded `country_indeed: "Ireland"` default reached the initial commit,
 * survived a full PR, green CI on two operating systems, an npm audit, a pack check and an MCP
 * protocol smoke test, and was caught only by a human reading a 33-line Python file.
 *
 * This script turns the prose rule into a build gate. It is deliberately narrow: it fails on
 * things that are unambiguously private, not on anything that merely looks personal.
 *
 * Run with `npm run check:boundary`. Exits non-zero on any violation.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath, not URL.pathname: the latter keeps percent-encoding, so a repository checked
// out to a directory containing a space silently resolves to nothing and the gate passes
// without scanning a single file.
const root = fileURLToPath(new URL("..", import.meta.url));
const scanRoots = ["src", "python", "docs", "agents", "test", "scripts"];
const scanFiles = ["README.md", "AGENTS.md", "SECURITY.md", "CONTRIBUTING.md", "ROADMAP.md", ".env.example", "server.json", "package.json"];
const backslash = String.fromCharCode(92);

/** Collect every file under a directory, skipping build output and dependencies. */
function walk(directory, found = []) {
  let entries;
  try {
    entries = readdirSync(directory);
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) walk(full, found);
    else found.push(full);
  }
  return found;
}

const targets = [
  ...scanRoots.flatMap((directory) => walk(join(root, directory))),
  ...scanFiles.map((file) => join(root, file)),
];

const rules = [
  {
    id: "personal-identity",
    reason: "The public repository must not carry the maintainer's personal identity outside authorship metadata. Use a neutral example instead.",
    test: (text, file) => {
      // Authorship and copyright are deliberate, required publication of identity, not leakage.
      if (["package.json", "NOTICE", "LICENSE"].some((name) => file.endsWith(name))) return [];
      return ["alexei", "udall", "sarutobi sasuke"].filter((token) => text.toLowerCase().includes(token));
    },
  },
  {
    id: "local-machine-path",
    reason: "A local filesystem path leaked into the public repository.",
    test: (text) => {
      const forwardSlashed = text.split(backslash).join("/").toLowerCase();
      return ["c:/users/", "c:/dev/", "obsidian vault", "/mcp servers/"].filter((token) => forwardSlashed.includes(token));
    },
  },
  {
    id: "private-repo-reference",
    reason: "Do not point the public repository at the private one. Naming the pattern is fine; linking the repo is not.",
    test: (text) => {
      const lower = text.toLowerCase();
      return ["github.com/sarutobisasuke8/career-os", "career-os.git"].filter((token) => lower.includes(token));
    },
  },
  {
    id: "hardcoded-locale-default",
    reason: "A country or locale default belongs in the operator's configuration, never baked into the shipped package. Read it from JOBSPY_COUNTRY instead.",
    test: (text, file) => {
      if (!file.endsWith("jobspy_bridge.py") && !file.endsWith("jobspy.ts")) return [];
      // Flags `country_indeed` given any inline string default.
      const pattern = new RegExp('country_indeed"?\\s*[:,]\\s*(request\\.get\\([^)]*,\\s*)?"[A-Za-z]', "u");
      return pattern.test(text) ? ["country_indeed has an inline default"] : [];
    },
  },
];

const violations = [];
for (const file of targets) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  // Never let this file's own rule literals trip the scan.
  if (file.endsWith(`scripts${sep}check-boundary.mjs`)) continue;
  for (const rule of rules) {
    for (const hit of rule.test(text, file)) {
      violations.push({ file: relative(root, file), rule: rule.id, hit, reason: rule.reason });
    }
  }
}

if (violations.length) {
  console.error(`Boundary check FAILED with ${violations.length} violation(s):\n`);
  for (const violation of violations) {
    console.error(`  ${violation.file}`);
    console.error(`    rule: ${violation.rule}`);
    console.error(`    found: ${violation.hit}`);
    console.error(`    ${violation.reason}\n`);
  }
  process.exit(1);
}

console.log(`Boundary check passed. Scanned ${targets.length} files against ${rules.length} rules.`);
