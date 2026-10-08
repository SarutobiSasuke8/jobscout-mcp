# JobScout Discover: ChatGPT and Codex plugin

JobScout Discover is the hosted, directory-ready packaging of JobScout MCP. The package lives in [`plugins/jobscout-discover`](../../plugins/jobscout-discover) and points at the Streamable HTTP server at `https://jobscout.mcprack.dev/mcp`, hosted with the recipe in [deployment](../DEPLOYMENT.md). That host is a placeholder until its DNS record and deployment exist.

## Contents

| Item | Where |
|---|---|
| Plugin manifest, MCP config, skills | `plugins/jobscout-discover/` |
| Local validator | `npm run check:plugin` (add `-- --submission` for strict mode, `-- --live` to fetch the public URLs) |
| Published pages | `/`, `/privacy` and `/terms`, served by the proxy in `deploy/`; the policy pages render `privacy.md` and `terms.md` from this folder |
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

1. DNS record for `jobscout.mcprack.dev`, a deployment of the `deploy/` recipe, and domain verification. The recipe and runbook exist; `npm run check:plugin -- --live` confirms the live URLs.
2. OAuth client and authorisation server for existing-account sign-in.
3. A real demo account, entered only in the portal's private field.
4. `.app.json` with the `plugin_asdk_app_id` issued by the submission portal.
5. Icon, logo and screenshots as PNG in `plugins/jobscout-discover/assets/`.
6. Final privacy and terms text with the operator's details and legal review. The proxy already serves these drafts at `/privacy` and `/terms`.
7. Submitting through the portal, which only the operator can do.
8. A Docker run of the compose stack and a first deployment.
9. Optional Claude Connectors Directory listing, which also needs the live domain.
