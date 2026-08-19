# Changelog

## Unreleased

### Added

- opt-in Lenny's Job Board provider reading an operator-supplied public JSON feed, with local
  query filtering, nested employer/location flattening and listing links derived from record ids
- `JOBSCOUT_ENABLE_LENNYSJOBS`, `LENNYSJOBS_FEED_URL`, `LENNYSJOBS_QUERY_PARAM`,
  `LENNYSJOBS_SITE_URL` and `LENNYSJOBS_TIMEOUT_MS`

### Notes

- no feed endpoint ships with the package: the board publishes no documented public API, so the
  provider is inert until an operator supplies a URL they have verified, and an enabled provider
  with no URL fails visibly rather than returning an empty success

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
