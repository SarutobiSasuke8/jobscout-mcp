# Changelog

## Unreleased

### Added

- We Work Remotely provider, opt-in behind `JOBSCOUT_ENABLE_WEWORKREMOTELY`, reading the public RSS feed configured by `WWR_RSS_URL`
- RemoteOK provider, opt-in behind `JOBSCOUT_ENABLE_REMOTEOK`, reading the public JSON endpoint configured by `REMOTEOK_API_URL`
- shared provider text helpers for markup reduction, entity decoding, and client-side query ranking
- shared response cache for whole-feed providers, configured by `JOBSCOUT_FEED_CACHE_TTL_MS`, which serves a stale copy with a warning when a source rate-limits
- provider warning channel, surfaced per provider in search results
- `location_unfiltered`, disclosing providers that could not apply the requested location
- `records_rejected_by_provider`, attributing dropped records to their source
- `require_dated` and `include_descriptions` search parameters

### Changed

- the version string is defined once in `src/version.ts` and asserted against the package manifest by a test

## 0.2.0 - Unreleased

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
