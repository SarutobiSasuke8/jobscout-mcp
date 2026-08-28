# Changelog

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
