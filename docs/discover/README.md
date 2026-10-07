# JobScout Discover: ChatGPT and Codex plugin

JobScout Discover is the hosted, directory-ready packaging of JobScout MCP. The package lives in [`plugins/jobscout-discover`](../../plugins/jobscout-discover) and points at the Streamable HTTP server described in [deployment](../DEPLOYMENT.md).

## Contents

| Item | Where |
|---|---|
| Plugin manifest, MCP config, skills | `plugins/jobscout-discover/` |
| Local validator | `npm run check:plugin` (add `-- --submission` for strict mode) |
| Privacy policy draft | [privacy.md](privacy.md) |
| Terms draft | [terms.md](terms.md) |
| Demo account instructions | [demo-account.md](demo-account.md) |
| Test cases (5 positive, 3 negative) | [test-cases.md](test-cases.md) |
| Walkthrough | [walkthrough.md](walkthrough.md) |
| Monetisation | [MONETISATION.md](../MONETISATION.md) |

## Package format

Follows OpenAI's plugin documentation at https://developers.openai.com/plugins/build/plugins as read on 2026-10-07: a root `plugin.json` with an `extensions.com.openai` section, a root `mcp.json` using `streamable-http`, and `skills/<name>/SKILL.md`. OpenAI documents no standalone validator command, so `scripts/check-plugin.mjs` checks the structural rules the page states. Passing it means the package is well formed. It does not mean the portal will accept it.

## Scope

The plugin searches, merges and shows provenance. It has no tool to apply, message an employer, store a CV or rank jobs, and the skills say so.

## Remaining gaps (not faked)

1. Public HTTPS domain, deployment and domain verification.
2. OAuth client and authorisation server for existing-account sign-in.
3. A real demo account, entered only in the portal's private field.
4. `.app.json` with the `plugin_asdk_app_id` issued by the submission portal.
5. Icon, logo and screenshots as PNG in `plugins/jobscout-discover/assets/`.
6. Real privacy and terms pages published at the manifest URLs, with legal review.
7. Replacing every `jobscout.example.com` placeholder in the manifest and `mcp.json`.
8. Submitting through the portal, which only the operator can do.
9. A Docker image build and a first deployment.
10. Optional Claude Connectors Directory listing, which also needs the live domain.
