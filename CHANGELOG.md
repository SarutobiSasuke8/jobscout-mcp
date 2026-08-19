# Changelog

## Unreleased

### Added

- opt-in Lenny's Job Board provider, querying the TrueUp search endpoint that powers the board
  under the board's own `lenny` partner scope, with location facet filtering, index-native tag
  and location mapping, and highlight-marker stripping
- `JOBSCOUT_ENABLE_LENNYSJOBS`, `LENNYSJOBS_ENDPOINT`, `LENNYSJOBS_PARTNER_ID`,
  `LENNYSJOBS_SITE_URL` and `LENNYSJOBS_TIMEOUT_MS`

### Notes

- the endpoint is undocumented and belongs to a third party: the provider ships disabled, states
  the dependency in `jobscout_list_sources`, and a change upstream is an expected failure mode
  rather than an exceptional one

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
