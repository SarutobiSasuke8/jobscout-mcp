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

void test("submission mode fails while placeholder domains and assets remain", () => {
  const { status, output } = run(pluginDir, "--submission");
  assert.equal(status, 1);
  assert.match(output, /placeholder host/u);
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
      mcpServers: { jobscout: { type: "streamable-http", url: "https://jobscout.example.com/mcp", apiKey: "x" } },
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
