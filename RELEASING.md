# Releasing JobScout MCP

JobScout MCP is published to npm as `@sarutobi-sasuke/jobscout-mcp` and to the official MCP Registry as `io.github.SarutobiSasuke8/jobscout-mcp`. Both are published by GitHub Actions ([`.github/workflows/release.yml`](.github/workflows/release.yml)) when a GitHub Release with a `vX.Y.Z` tag is published. Nobody runs `npm publish` by hand.

## Versioning

The project follows semantic versioning. While the version is below 1.0.0, a minor bump (0.2.x to 0.3.0) may carry breaking changes to tool schemas or behaviour; a patch bump must not.

The version string lives in four places, and all must agree:

- `package.json` (`version`), and `package-lock.json` with it
- `server.json` (top-level `version` and `packages[0].version`)
- `src/version.ts` (`VERSION`, asserted against `package.json` by `test/version.test.ts`)

The release workflow also fails if the tag does not match `package.json`.

## Release steps

1. On a branch from `main`, bump the version:

   ```bash
   npm version 0.2.2 --no-git-tag-version
   ```

   Then update `server.json` (both fields) and `src/version.ts` to the same value.

2. In `CHANGELOG.md`, rename `## Unreleased` to `## 0.2.2 - YYYY-MM-DD` and add a fresh empty `## Unreleased` above it. Update the "Release status" section of the README if it mentions unreleased work.

3. Run the same gate the release workflow runs:

   ```bash
   npm ci
   npm run check
   npm audit --omit=dev --audit-level=high
   npm run pack:check
   npm run smoke:mcp
   ```

   Read the `pack:check` file list: only `dist/src`, `python/jobspy_bridge.py`, `README.md`, `LICENSE`, `NOTICE` and `server.json` should ship.

4. Open a pull request, let CI pass (Ubuntu and Windows, plus the MCP protocol smoke test), and merge to `main`.

5. Create the GitHub Release from `main` with tag `v0.2.2` and the changelog section as the notes:

   ```bash
   gh release create v0.2.2 --target main --title "v0.2.2" --notes-file <notes.md>
   ```

   Publishing the release triggers the workflow, which:

   - reruns `check`, `audit`, `pack:check` and `smoke:mcp` on Node 24
   - verifies the tag matches `package.json`
   - runs `npm publish --access public` through npm trusted publishing (OIDC, no token; provenance is attached automatically)
   - waits until npm serves the exact version, then validates `server.json` and publishes it to the MCP Registry with `mcp-publisher` using GitHub OIDC

6. Confirm the release landed:

   ```bash
   npm view @sarutobi-sasuke/jobscout-mcp dist-tags
   npm exec --yes --package=@sarutobi-sasuke/jobscout-mcp@0.2.2 -- jobscout-mcp
   ```

   and check the registry entry shows the new version.

If the npm job succeeds but the registry job fails, rerun the failed job from the Actions run. Do not cut a new version for a registry-only failure.

## Rolling back a bad release

npm only allows `npm unpublish` within 72 hours of publishing, and only when no other package depends on the version. Even inside that window, unpublishing is not the first move: the version number can never be reused, anyone who already installed it keeps it, and the MCP Registry entry still points at it. Roll forward instead, in this order.

These commands need a maintainer logged in to npm locally (`npm login`), because trusted publishing only covers `npm publish` from CI. Expect a one-time password prompt if 2FA is enabled on the account.

1. **Point `latest` back at the last good version**, so new `npx` and `npm exec` installs stop resolving to the bad one:

   ```bash
   npm dist-tag add @sarutobi-sasuke/jobscout-mcp@0.2.1 latest
   ```

2. **Deprecate the bad version** with a message that says what to use instead. Installs still work but print the warning:

   ```bash
   npm deprecate @sarutobi-sasuke/jobscout-mcp@0.2.2 "Broken release: <one-line reason>. Use 0.2.1 or 0.2.3."
   ```

3. **Publish a patch** (for example 0.2.3) through the normal release steps above, with a changelog entry naming the bad version and the fix. The CI publish moves `latest` to the patch.

4. **Resubmit to the registries.** The release workflow publishes the patch to the official MCP Registry from `server.json`, so check the registry job succeeded and the entry shows the patch version. No other directory listing (Smithery, Glama and similar) is referenced in this repository at present; if one is added later, list it here and resubmit or refresh it after the patch.

Finally, add a note to the GitHub Release of the bad version pointing to the patch.

`npm unpublish @sarutobi-sasuke/jobscout-mcp@<version>` is a last resort, reserved for a release that leaks a secret or ships something harmful, and only inside the 72-hour window. Rotate any leaked secret first: unpublishing does not remove copies already downloaded.
