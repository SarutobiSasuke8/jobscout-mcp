import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const script = join(repo, "scripts", "check-plugin.mjs");
const pluginDir = join(repo, "plugins", "jobscout-discover");

function run(dir: string, ...extra: string[]): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [script, dir, ...extra], { encoding: "utf8" });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function copyPlugin(): string {
  const dir = mkdtempSync(join(tmpdir(), "jobscout-plugin-"));
  cpSync(pluginDir, dir, { recursive: true });
  return dir;
}

void test("the shipped plugin package is structurally valid", () => {
  const { status, output } = run(pluginDir);
  assert.equal(status, 0, output);
});

void test("submission mode fails while hosting is unverified and assets remain", () => {
  const { status, output } = run(pluginDir, "--submission");
  assert.equal(status, 1);
  assert.match(output, /not verified live/u);
  assert.match(output, /\.app\.json/u);
});

void test("the manifest points at the hosted domain the deploy recipe serves", () => {
  const manifest = readFileSync(join(pluginDir, "plugin.json"), "utf8");
  const mcp = JSON.parse(readFileSync(join(pluginDir, "mcp.json"), "utf8")) as { mcpServers: Record<string, { url: string }> };
  assert.doesNotMatch(manifest, /example\.com/u);
  assert.equal(mcp.mcpServers.jobscout?.url, "https://jobscout.mcprack.dev/mcp");
  const caddyfile = readFileSync(join(repo, "deploy", "Caddyfile"), "utf8");
  assert.match(caddyfile, /\{\$JOBSCOUT_SITE_ADDRESS:jobscout\.mcprack\.dev\}/u);
});

function rewriteUrls(dir: string, from: string, to: string, files = ["plugin.json", "mcp.json"]): void {
  for (const file of files) {
    const path = join(dir, file);
    writeFileSync(path, readFileSync(path, "utf8").split(from).join(to));
  }
}

void test("public URLs on more than one host are rejected", () => {
  const dir = copyPlugin();
  try {
    rewriteUrls(dir, "https://jobscout.mcprack.dev/mcp", "https://other.mcprack.dev/mcp", ["mcp.json"]);
    const { status, output } = run(dir);
    assert.equal(status, 1);
    assert.match(output, /more than one host/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("a privacy URL the proxy does not serve is rejected", () => {
  const dir = copyPlugin();
  try {
    rewriteUrls(dir, "https://jobscout.mcprack.dev/privacy", "https://jobscout.mcprack.dev/legal/privacy", ["plugin.json"]);
    const { status, output } = run(dir);
    assert.equal(status, 1);
    assert.match(output, /not served by the deploy recipe/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("a manifest host that differs from the Caddyfile default is rejected", () => {
  const dir = copyPlugin();
  try {
    rewriteUrls(dir, "jobscout.mcprack.dev", "jobs.mcprack.dev");
    const { status, output } = run(dir);
    assert.equal(status, 1);
    assert.match(output, /deploy\/Caddyfile serves jobscout\.mcprack\.dev/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("a non-kebab-case name is rejected", () => {
  const dir = copyPlugin();
  try {
    const manifestPath = join(dir, "plugin.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { name: string };
    manifest.name = "JobScout_Discover";
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const { status, output } = run(dir);
    assert.equal(status, 1);
    assert.match(output, /kebab-case/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("a credential-like field in mcp.json is rejected", () => {
  const dir = copyPlugin();
  try {
    writeFileSync(join(dir, "mcp.json"), JSON.stringify({
      mcpServers: { jobscout: { type: "streamable-http", url: "https://jobscout.mcprack.dev/mcp", apiKey: "x" } },
    }));
    const { status, output } = run(dir);
    assert.equal(status, 1);
    assert.match(output, /credential-like/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("a skill whose name does not match its directory is rejected", () => {
  const dir = copyPlugin();
  try {
    const file = join(dir, "skills", "find-jobs", "SKILL.md");
    writeFileSync(file, readFileSync(file, "utf8").replace("name: find-jobs", "name: other"));
    const { status, output } = run(dir);
    assert.equal(status, 1);
    assert.match(output, /must match the directory/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("the plugin exposes no application, messaging or storage capability", () => {
  const manifest = readFileSync(join(pluginDir, "plugin.json"), "utf8");
  assert.doesNotMatch(manifest, /"Write"/u);
  assert.doesNotMatch(readFileSync(join(pluginDir, "mcp.json"), "utf8"), /authorization|bearer/iu);
});
