import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { VERSION } from "../src/version.js";

// The version string previously appeared verbatim in several files and had already drifted.
// This keeps the constant honest so the duplication cannot quietly return.
void test("the exported version matches the package manifest", () => {
  const manifestPath = fileURLToPath(new URL("../../package.json", import.meta.url));
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { version?: string };
  assert.equal(VERSION, manifest.version);
});
