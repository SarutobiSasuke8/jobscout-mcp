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

## Lenny's Job Board

Reads a public JSON feed of [Lenny's Job Board](https://www.lennysjobs.com/) over HTTP when explicitly enabled, then normalizes and filters it locally. Coverage is product, growth, design and engineering roles at tech companies and startups, which is the lane the other two providers cover least well.

### You supply the endpoint

**JobScout ships no default feed URL for this source.** The board publishes no documented public API, and this project does not bake in an endpoint it has not verified. Set `LENNYSJOBS_FEED_URL` to a JSON endpoint you have confirmed yourself and are entitled to read; until you do, an enabled provider reports a visible failure rather than an empty success, so a search never poses as "nothing matched" for a source that was never contacted.

Optional settings:

| Variable | Default | Purpose |
|---|---|---|
| `JOBSCOUT_ENABLE_LENNYSJOBS` | `false` | Enable the provider |
| `LENNYSJOBS_FEED_URL` | _(unset, required)_ | Public JSON feed to read. HTTP(S) only |
| `LENNYSJOBS_QUERY_PARAM` | _(unset)_ | Query-string parameter to forward the search term in, if your endpoint supports server-side search. Unset means the whole feed is fetched and filtered locally |
| `LENNYSJOBS_SITE_URL` | `https://www.lennysjobs.com` | Base used to build a listing link for records that carry an id but no URL |
| `LENNYSJOBS_TIMEOUT_MS` | `20000` | Request timeout, bounded to 1–60 seconds |

### Local filtering

A whole-board feed is not a search endpoint, so JobScout filters it after retrieval. A record is kept when **any** query term of three or more characters appears in its title, company, tags or description. Near misses are surfaced deliberately: a search for "senior product manager AI" should not return nothing because one word was absent. Set `LENNYSJOBS_QUERY_PARAM` if your endpoint can do the narrowing itself.

### URLs

Board links are recorded as `provenance[].discovery_url`. This provider never promotes a board apply flow to `canonical_url`; only an explicit `canonical_url` or `job_url_direct` in the feed is treated as an employer application route. Resolve the employer or ATS listing before applying.

### Terms

Reading a feed is your decision and your responsibility. Respect the board's terms of use and its rate limits, and do not point this provider at anything behind authentication.
