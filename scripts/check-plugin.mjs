/**
 * Local validator for the JobScout Discover plugin package.
 *
 * OpenAI documents no official validator command for plugin packages, so this checks the
 * structural rules stated in https://developers.openai.com/plugins/build/plugins: a root
 * plugin.json with a kebab-case name, relative ./ paths that stay inside the package, an
 * optional mcp.json with Streamable HTTP servers, skills as skills/<name>/SKILL.md with
 * name and description frontmatter, and no bundled hooks (those make a plugin ineligible
 * for the public directory).
 *
 * It also checks the package against the hosting recipe in deploy/: every public URL must
 * share one host, sit on the paths the proxy serves (/, /privacy, /terms, /mcp), and match
 * the default site address in deploy/Caddyfile.
 *
 * Structural errors fail the run. Submission blockers (placeholder domains, missing
 * assets, hosting not yet verified live) are reported separately because they need a live
 * domain or design work that cannot be faked. Pass --submission to turn blockers into
 * failures. Pass --live to fetch the public URLs; any live failure is an error.
 *
 * Usage: node scripts/check-plugin.mjs [pluginDir] [--submission] [--live]
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const strict = args.includes("--submission");
const live = args.includes("--live");
const positional = args.filter((arg) => !arg.startsWith("--"));
const defaultDir = fileURLToPath(new URL("../plugins/jobscout-discover", import.meta.url));
const root = resolve(positional[0] ?? defaultDir);
const caddyfilePath = fileURLToPath(new URL("../deploy/Caddyfile", import.meta.url));

/** The paths the deploy recipe serves; the manifest must use exactly these. */
const SERVED_PATHS = {
  homepage: "/",
  "interface.websiteURL": "/",
  "interface.privacyPolicyURL": "/privacy",
  "interface.termsOfServiceURL": "/terms",
  mcp: "/mcp",
};
/** label -> URL, gathered while checking, for the host and path consistency checks. */
const publicUrls = new Map();

const errors = [];
const blockers = [];

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    errors.push(`${file}: cannot read as JSON (${error instanceof Error ? error.message : "unknown error"})`);
    return undefined;
  }
}

function checkRelativePath(value, label) {
  if (typeof value !== "string" || !value.startsWith("./")) {
    errors.push(`${label}: path must be a string starting with ./`);
    return;
  }
  const target = resolve(root, value);
  if (target !== root && !target.startsWith(root + sep)) errors.push(`${label}: path escapes the plugin root`);
  else if (!existsSync(target)) blockers.push(`${label}: ${value} does not exist`);
}

function checkPublicUrl(value, label) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    errors.push(`${label}: not a valid URL`);
    return;
  }
  if (url.protocol !== "https:") errors.push(`${label}: public submission needs an https URL`);
  publicUrls.set(label, url);
  if (/(^|\.)example\.(com|org|net)$/u.test(url.hostname) || /^replace/iu.test(url.hostname)) {
    blockers.push(`${label}: placeholder host ${url.hostname} must be replaced with a verified domain`);
  }
}

const manifestPath = join(root, "plugin.json");
if (!existsSync(manifestPath)) {
  errors.push("plugin.json is missing at the plugin root");
} else {
  const manifest = readJson(manifestPath);
  if (manifest) {
    if (typeof manifest.name !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/u.test(manifest.name)) errors.push("name must be kebab-case");
    for (const field of ["version", "description", "license", "repository", "homepage"]) {
      if (typeof manifest[field] !== "string" || !manifest[field].trim()) errors.push(`${field} is required`);
    }
    if (!manifest.author || typeof manifest.author.name !== "string") errors.push("author.name is required");
    if (typeof manifest.homepage === "string") checkPublicUrl(manifest.homepage, "homepage");

    const openai = manifest.extensions?.["com.openai"];
    if (!openai) {
      errors.push("extensions.com.openai is required for ChatGPT and Codex");
    } else {
      if (openai.hooks) errors.push("bundled hooks make a plugin ineligible for the public directory");
      if (openai.apps) {
        checkRelativePath(openai.apps, "extensions.com.openai.apps");
      } else {
        blockers.push("extensions.com.openai.apps: .app.json needs a plugin_asdk_app_id issued by the submission portal");
      }
      const face = openai.interface;
      if (!face) {
        errors.push("extensions.com.openai.interface is required");
      } else {
        for (const field of ["displayName", "shortDescription", "longDescription", "developerName", "category", "websiteURL", "privacyPolicyURL", "termsOfServiceURL"]) {
          if (typeof face[field] !== "string" || !face[field].trim()) errors.push(`interface.${field} is required`);
        }
        for (const field of ["websiteURL", "privacyPolicyURL", "termsOfServiceURL"]) {
          if (face[field]) checkPublicUrl(face[field], `interface.${field}`);
        }
        if (!Array.isArray(face.defaultPrompt) || face.defaultPrompt.length === 0) errors.push("interface.defaultPrompt needs at least one example");
        for (const field of ["composerIcon", "logo"]) {
          if (face[field]) checkRelativePath(face[field], `interface.${field}`);
          else blockers.push(`interface.${field}: PNG asset not supplied`);
        }
        for (const [index, shot] of (face.screenshots ?? []).entries()) checkRelativePath(shot, `interface.screenshots[${index}]`);
        if (!face.screenshots?.length) blockers.push("interface.screenshots: no screenshots supplied");
      }
    }
  }
}

const mcpPath = join(root, "mcp.json");
if (existsSync(mcpPath)) {
  const mcp = readJson(mcpPath);
  const servers = mcp?.mcpServers;
  if (!servers || typeof servers !== "object" || Object.keys(servers).length === 0) {
    errors.push("mcp.json: mcpServers must name at least one server");
  } else {
    for (const [name, server] of Object.entries(servers)) {
      if (server.type !== "streamable-http") errors.push(`mcp.json: server ${name} must use type streamable-http`);
      checkPublicUrl(server.url, `mcp.json server ${name} url`);
      for (const key of Object.keys(server)) {
        if (/token|secret|password|key/iu.test(key)) errors.push(`mcp.json: server ${name} carries a credential-like field (${key}); never store credentials in the package`);
      }
    }
  }
} else {
  errors.push("mcp.json is missing");
}

const skillsDir = join(root, "skills");
if (!existsSync(skillsDir)) {
  errors.push("skills/ directory is missing");
} else {
  const skills = readdirSync(skillsDir).filter((entry) => statSync(join(skillsDir, entry)).isDirectory());
  if (skills.length === 0) errors.push("skills/ contains no skills");
  for (const skill of skills) {
    const file = join(skillsDir, skill, "SKILL.md");
    if (!existsSync(file)) {
      errors.push(`skills/${skill}: SKILL.md is missing`);
      continue;
    }
    const text = readFileSync(file, "utf8");
    const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u.exec(text);
    if (!front) {
      errors.push(`skills/${skill}/SKILL.md: frontmatter is missing`);
      continue;
    }
    const name = /^name:\s*(.+)$/mu.exec(front[1])?.[1]?.trim();
    const description = /^description:\s*(.+)$/mu.exec(front[1])?.[1]?.trim();
    if (!name) errors.push(`skills/${skill}/SKILL.md: name is missing`);
    else if (name !== skill) errors.push(`skills/${skill}/SKILL.md: name "${name}" must match the directory`);
    if (!description) errors.push(`skills/${skill}/SKILL.md: description is missing`);
    if (!front[2].trim()) errors.push(`skills/${skill}/SKILL.md: body is empty`);
  }
}

if (existsSync(join(root, "hooks"))) errors.push("hooks/ directory present: ineligible for the public directory");

// Consistency with the hosting recipe in deploy/.
const hosts = new Set([...publicUrls.values()].map((url) => url.host));
if (hosts.size > 1) errors.push(`public URLs use more than one host (${[...hosts].join(", ")}); the deploy recipe serves one`);
for (const [label, url] of publicUrls) {
  const expected = label.startsWith("mcp.json") ? SERVED_PATHS.mcp : SERVED_PATHS[label];
  if (expected && url.pathname !== expected) errors.push(`${label}: path ${url.pathname} is not served by the deploy recipe (expected ${expected})`);
}
const [manifestHost] = hosts;
if (manifestHost && existsSync(caddyfilePath)) {
  const site = /\{\$JOBSCOUT_SITE_ADDRESS:([^}]+)\}/u.exec(readFileSync(caddyfilePath, "utf8"))?.[1];
  if (!site) errors.push("deploy/Caddyfile: no default JOBSCOUT_SITE_ADDRESS found");
  else if (site !== manifestHost) errors.push(`deploy/Caddyfile serves ${site} by default but the manifest points at ${manifestHost}`);
}

if (live && manifestHost) {
  const origin = `https://${manifestHost}`;
  const probes = [
    { label: "health", url: `${origin}/health`, type: "application/json" },
    ...[...publicUrls].filter(([label]) => !label.startsWith("mcp.json")).map(([label, url]) => ({ label, url: url.href, type: "text/html" })),
  ];
  for (const probe of probes) {
    try {
      const response = await fetch(probe.url, { signal: AbortSignal.timeout(15_000) });
      const type = response.headers.get("content-type") ?? "";
      if (response.status !== 200 || !type.includes(probe.type)) errors.push(`live ${probe.label}: ${probe.url} returned HTTP ${response.status} ${type}`);
    } catch (error) {
      errors.push(`live ${probe.label}: ${probe.url} unreachable (${error instanceof Error ? error.message : "unknown error"})`);
    }
  }
  for (const [label, url] of publicUrls) {
    if (!label.startsWith("mcp.json")) continue;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "check-plugin", version: "1.0.0" } } }),
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status !== 200) errors.push(`live ${label}: initialize returned HTTP ${response.status}`);
    } catch (error) {
      errors.push(`live ${label}: ${url.href} unreachable (${error instanceof Error ? error.message : "unknown error"})`);
    }
  }
} else if (manifestHost) {
  blockers.push(`hosting at ${manifestHost} not verified live: add the DNS record, deploy (docs/DEPLOYMENT.md), then run npm run check:plugin -- --live`);
}

for (const message of blockers) console.log(`${strict ? "FAIL" : "submission blocker"}: ${message}`);
for (const message of errors) console.error(`FAIL: ${message}`);

if (errors.length || (strict && blockers.length)) {
  console.error(`Plugin check FAILED: ${errors.length} error(s), ${blockers.length} submission blocker(s).`);
  process.exit(1);
}
console.log(`Plugin check passed with ${blockers.length} documented submission blocker(s). Structure is valid; not yet submission-ready.`);
