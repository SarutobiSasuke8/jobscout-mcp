# Provider contract

Each provider implements:

- stable provider identifier
- human-readable label
- enabled state
- `search(query)` returning normalized candidate records
- bounded timeout and useful failure messages
- documented authentication and provenance behavior
- transport, coverage and optional dependency metadata

Provider failures are returned alongside successful results. One provider outage must reduce coverage rather than fail the entire blended search.

When callers explicitly request unknown provider identifiers, JobScout returns them under `unknown_sources`. Provider results are treated as untrusted: invalid jobs are rejected (and counted in `records_rejected`, never silently dropped), URLs must use HTTP(S), response sizes are bounded, and remote/freshness constraints are enforced again after retrieval. A search against zero enabled providers reports `setup_required: true` rather than posing as an empty market.

## URL semantics

Every record can carry two different kinds of link, and consumers should not conflate them:

- `canonical_url` (top level): the employer application route, present only when the source exposes one (for example python-jobspy's `job_url_direct`). This is the link to prefer when applying.
- `provenance[].discovery_url`: where the record was found — a listing or aggregator page. Always an audit trail, not proof the employer endorsed the listing.

`jobscout_briefing` applies the fallback rule for you (`canonical_url`, else first `discovery_url`) and labels which kind it chose via `url_kind`, so downstream briefings never drop the link or present a discovery page as an apply route.

## Himalayas

Uses the public remote MCP endpoint when explicitly enabled. The adapter requests `search_jobs`; authenticated profile or tracker tools are outside scope.

## JobSpy

Uses `python-jobspy` through the bundled Python bridge. It is optional because scraped job boards can throttle or change without notice.

### Which sites this contacts

Enabling `JOBSCOUT_ENABLE_JOBSPY` causes automated requests to be sent **from your own machine** to the job boards you configure. JobScout does not proxy this traffic and does not contact these sites on your behalf.

By default JobScout queries **Indeed only**. This is deliberately narrower than the set `python-jobspy` supports, so that a wider footprint is always an explicit choice.

Set `JOBSPY_SITES` to a comma-separated list to change it. Recognised values:

| Value | Site |
|---|---|
| `indeed` | Indeed (default) |
| `linkedin` | LinkedIn |
| `glassdoor` | Glassdoor |
| `google` | Google Jobs |
| `zip_recruiter` | ZipRecruiter |
| `bayt` | Bayt |
| `naukri` | Naukri |

Unrecognised values are dropped rather than forwarded. The resolved list is reported in `jobscout_list_sources` so you can always confirm what is actually being queried.

**LinkedIn, Glassdoor and Indeed each restrict automated access in their terms of use.** Adding them is your decision and your responsibility. Consider the rate limits, the account you are signed into elsewhere, and whether automated querying is appropriate for your situation before enabling them.

### Country scoping

Indeed results are country-scoped. JobScout sets no country by default and defers to the `python-jobspy` library default. Set `JOBSPY_COUNTRY` (for example `JOBSPY_COUNTRY=United Kingdom`) to scope Indeed searches explicitly.
