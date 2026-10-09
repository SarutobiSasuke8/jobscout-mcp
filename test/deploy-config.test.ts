import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Static checks on the hosting recipe in deploy/. They keep the documented limits, the compose
// defaults and the Caddyfile defaults in step. They do not run Caddy or Docker; the PR that
// changes deploy/ carries the live evidence.

const repo = fileURLToPath(new URL("../../", import.meta.url));
// Normalise line endings: Windows checkouts may convert to CRLF.
const read = (...parts: string[]): string => readFileSync(join(repo, ...parts), "utf8").replace(/\r\n/gu, "\n");

const caddyfile = read("deploy", "Caddyfile");
const compose = read("deploy", "compose.yaml");
const envExample = read("deploy", ".env.example");
const deployment = read("docs", "DEPLOYMENT.md");

const LIMIT_SETTINGS = [
  "JOBSCOUT_MCP_RATE_EVENTS",
  "JOBSCOUT_MCP_RATE_WINDOW",
  "JOBSCOUT_MCP_MAX_BODY",
  "JOBSCOUT_SITE_RATE_EVENTS",
  "JOBSCOUT_SITE_RATE_WINDOW",
];

function caddyDefault(name: string): string {
  const match = new RegExp(`\\{\\$${name}:([^}]+)\\}`, "u").exec(caddyfile);
  assert.ok(match?.[1], `Caddyfile has no default for ${name}`);
  return match[1];
}

void test("documented limits match the Caddyfile, compose and .env.example defaults", () => {
  for (const name of LIMIT_SETTINGS) {
    const value = caddyDefault(name);
    assert.ok(deployment.includes(`| \`${name}\` | \`${value}\` |`), `docs/DEPLOYMENT.md does not document ${name} = ${value}`);
    assert.ok(compose.includes(`\${${name}:-${value}}`), `compose.yaml default for ${name} differs from ${value}`);
    assert.ok(envExample.includes(`${name}=${value}\n`), `deploy/.env.example value for ${name} differs from ${value}`);
  }
});

void test("the proxy rate-limits and size-caps /mcp before it reaches the app", () => {
  const mcpBlock = /handle \/mcp \{([\s\S]*?)\n\t\}\n/u.exec(caddyfile)?.[1] ?? "";
  const rateLimit = mcpBlock.indexOf("rate_limit");
  const sizeCap = mcpBlock.indexOf("request_body");
  const proxy = mcpBlock.indexOf("reverse_proxy");
  assert.ok(rateLimit >= 0 && sizeCap >= 0 && proxy >= 0, "the /mcp block needs rate_limit, request_body and reverse_proxy");
  assert.ok(rateLimit < proxy && sizeCap < proxy, "limits must come before reverse_proxy inside the route");
  assert.match(mcpBlock, /key \{client_ip\}/u);
});

void test("every page the manifest links to has a template and a source", () => {
  for (const page of ["index.html", "privacy.html", "terms.html"]) {
    assert.ok(existsSync(join(repo, "deploy", "site", page)), `deploy/site/${page} is missing`);
  }
  assert.match(read("deploy", "site", "privacy.html"), /include "privacy\.md"/u);
  assert.match(read("deploy", "site", "terms.html"), /include "terms\.md"/u);
  assert.ok(existsSync(join(repo, "docs", "discover", "privacy.md")));
  assert.ok(existsSync(join(repo, "docs", "discover", "terms.md")));
  assert.match(compose, /\.\.\/docs\/discover:\/srv\/content:ro/u);
  assert.match(caddyfile, /@pages path \/ \/privacy \/terms/u);
});

void test("compose builds the existing Dockerfile and keeps the app off the host network", () => {
  assert.ok(existsSync(join(repo, "Dockerfile")));
  assert.match(compose, /context: \.\.\n\s+dockerfile: Dockerfile/u);
  const appBlock = /\n {2}jobscout:\n([\s\S]*?)\n {2}caddy:/u.exec(compose)?.[1] ?? "";
  assert.doesNotMatch(appBlock, /\n {4}ports:/u, "the app container must not publish ports; only the proxy does");
  assert.doesNotMatch(compose, /JOBSCOUT_HTTP_BEARER_TOKEN:/u, "the anonymous public service must not set a bearer token");
});

void test("the deploy recipe carries no secrets", () => {
  for (const text of [compose, envExample, read("deploy", "local.env")]) {
    assert.doesNotMatch(text, /(token|secret|password)\s*[=:]\s*\S{8,}/iu);
  }
});
