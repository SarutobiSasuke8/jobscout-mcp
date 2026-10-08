# Changelog

## Unreleased

### Added

- Single-VPS hosting recipe for JobScout Discover in `deploy/`: compose stack (existing `Dockerfile` behind Caddy with automatic HTTPS), per-IP rate limits and a request-size cap at the proxy, container, proxy and end-to-end health checks, and `/`, `/privacy` and `/terms` pages rendered from `docs/discover/`
- `npm run deploy:check` (external operator check) and `npm run deploy:load` (rate-limit and size-cap load script)
- Operator runbook in `docs/DEPLOYMENT.md`: DNS record, first boot, certificates, upgrade, rollback, logs

- Streamable HTTP entrypoint (`jobscout-mcp-http`, `npm run start:http`) with a `/health` endpoint, stateless per-request serving, an optional shared bearer token and JobSpy forced off when hosted
- `Dockerfile` for the hosted build (written, image build not yet run)
- JobScout Discover plugin package in `plugins/jobscout-discover` (manifest, `mcp.json`, two skills) with a local structural validator, `npm run check:plugin`
- Review materials in `docs/discover/` (privacy and terms drafts, demo-account template, 5 positive and 3 negative test cases, walkthrough), `docs/DEPLOYMENT.md` and `docs/MONETISATION.md`
- We Work Remotely provider, opt-in behind `JOBSCOUT_ENABLE_WEWORKREMOTELY`, reading the public RSS feed configured by `WWR_RSS_URL`
- RemoteOK provider, opt-in behind `JOBSCOUT_ENABLE_REMOTEOK`, reading the public JSON endpoint configured by `REMOTEOK_API_URL`
- shared provider text helpers for markup reduction, entity decoding, and client-side query ranking
- shared response cache for whole-feed providers, configured by `JOBSCOUT_FEED_CACHE_TTL_MS`, which serves a stale copy with a warning when a source rate-limits
- provider warning channel, surfaced per provider in search results
- `location_unfiltered`, disclosing providers that could not apply the requested location
- `records_rejected_by_provider`, attributing dropped records to their source
- `require_dated` and `include_descriptions` search parameters
- opt-in Lenny's Job Board provider, querying the TrueUp search endpoint that powers the board
  under the board's own `lenny` partner scope, with location facet filtering, index-native tag
  and location mapping, and highlight-marker stripping
- `JOBSCOUT_ENABLE_LENNYSJOBS`, `LENNYSJOBS_ENDPOINT`, `LENNYSJOBS_PARTNER_ID`,
  `LENNYSJOBS_SITE_URL` and `LENNYSJOBS_TIMEOUT_MS`
- `jobscout_source_yield`: per-source unique yield, overlap rate, employer-route coverage,
  undated records and duplicate conflicts over a supplied pool, returning counts only and no
  job text

### Notes

- the endpoint is undocumented and belongs to a third party: the provider ships disabled, states
  the dependency in `jobscout_list_sources`, and a change upstream is an expected failure mode
  rather than an exceptional one

### Changed

- JobScout Discover manifest and `mcp.json` now point at `https://jobscout.mcprack.dev` (placeholder until DNS and deployment exist)
- `npm run check:plugin` checks the manifest against the deploy recipe (one host, served paths, Caddyfile default host) and gains `--live`
- the version string is defined once in `src/version.ts` and asserted against the package manifest by a test


## 0.2.1 - 2026-08-11

Published as `@sarutobi-sasuke/jobscout-mcp` to npm and the MCP Registry.

### Added

- searches with zero enabled providers return `setup_required: true` with concrete guidance instead of an empty success
- results report `providers_disabled`, `records_rejected` and `undated_records`; schema-invalid records are counted, never silently dropped
- read-only `jobscout_briefing` tool: deterministic briefing-ready entries with `one_line`, `url` and `url_kind`
- MCP prompts `jobscout_setup` and `jobscout_find_jobs` for stateless first-run onboarding

### Changed

- provider tags, keywords, categories and departments are mapped instead of discarded, feeding the classifier its highest-precision input
- URL semantics documented: `canonical_url` is the employer apply route, `discovery_url` is provenance; the briefing tool applies the fallback rule
- npm scope renamed to `@sarutobi-sasuke` after the npm account rename
- release workflow publishes via npm trusted publishing (OIDC) with no token in CI, on Node 24 for a compatible npm CLI

## 0.2.0 - 2026-08-08

Published as `@sarutobisasuke/jobscout-mcp` (scope renamed in 0.2.1).

### Added

- deterministic AI, agentic and Web3 classification
- `jobscout_classify_jobs`
- GitHub-direct installation guidance for major MCP hosts
- MCP Registry metadata and npm release automation
- official MCP Inspector protocol smoke test
- optional JobScout Operator guide
- Windows and Linux CI coverage

### Changed

- remote-only and freshness constraints are enforced after provider retrieval
- provider status exposes transport, coverage, and optional dependency metadata
- canonical URLs remove common tracking parameters before fingerprinting

### Security

- job URLs accept HTTP(S) schemes only
- provider errors and remote/subprocess outputs are bounded
- JobSpy timeout configuration is constrained to a safe range
