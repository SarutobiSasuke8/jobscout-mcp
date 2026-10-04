# Roadmap

## Reliability sweep, 2026-10-01 (unreleased)

- [x] Keep distinct employer requisition URLs separate even when titles match.
- [x] Keep ambiguous board copies separate; preserve conflict flags and source provenance.
- [x] Restrict employer equivalence to known legal suffixes, preserving non-Latin names.
- [x] Preserve description truncation evidence after repeated normalisation.
- [x] Stop reading HTTP feeds at the byte cap, including chunked responses.
- [x] Add a labelled synthetic deduplication corpus tested in every input order.
- [x] Check runtime, package and registry version agreement in the test gate.
- [x] Publish the matching registry entry after npm in the release workflow.
- [ ] Verify the registry OIDC job during the next deliberate package release.
- [ ] Complete provider field reports and the Ireland/UK JobSpy fixture before assessing stable.

## v0.1: trustworthy local discovery

- [x] Normalized job schema and deterministic deduplication
- [x] Opt-in Himalayas and JobSpy adapters
- [x] Source inventory and offline deduplication tools
- [x] Unit tests and CI
- [x] Live compatibility proof against Himalayas MCP
- [ ] JobSpy Ireland/UK reliability fixture

## v0.2: broader source adapters

- [x] Deterministic AI, agentic and Web3 discovery signals
- [x] MCP Registry metadata, npm release workflow and Inspector smoke test
- [x] Major-client installation recipes and optional operator guide
- [ ] Configurable official ATS adapters for Greenhouse, Ashby and Lever
- [x] Lenny's Job Board adapter via the TrueUp partner endpoint
- [ ] Apify actor adapter with bring-your-own token
- [ ] WWSHEMI adapter after documenting its public-source contract
- [ ] Provider health telemetry and rate-limit backoff
- [ ] Canonical employer-link resolver with explicit confidence
- [x] Publish the npm package and MCP Registry entry (0.2.1 live as `@sarutobi-sasuke/jobscout-mcp`, 2026-08-11)
- [x] MCP Registry publish step in release.yml (implemented; live proof awaits the next release)
- [ ] Recruiter/agency and direct-outreach lead sources — or explicitly declare board-listing-only scope

## Later

- [ ] Package provider SDK for third-party adapters
- [ ] Streamable HTTP deployment mode with scoped authentication
- [x] Source yield and duplicate-rate reports
- [ ] Optional hosted service without changing the local-first core
