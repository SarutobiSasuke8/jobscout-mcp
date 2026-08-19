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

Queries the search endpoint behind [Lenny's Job Board](https://www.lennysjobs.com/) when explicitly enabled. Coverage is product, growth, design and engineering roles at tech companies and startups, which is the lane the other two providers cover least well.

### Where the data actually comes from

The board is a partner view over [TrueUp](https://www.trueup.io/)'s job index. Its page posts an Algolia-shaped query to `https://arc.trueup.io/jobs/search` with `trueupPartnerId: "lenny"`, and that partner id is what scopes results to this board rather than to all of TrueUp. JobScout sends the same request.

**This is an undocumented third-party endpoint, not a published API.** No terms invite programmatic use, no version guarantee exists, and it can change or stop without notice. Enabling this provider is your decision and your responsibility: consider the rate at which you query it, and treat a sudden failure as expected rather than exceptional. `jobscout_list_sources` states the same thing at runtime.

| Variable | Default | Purpose |
|---|---|---|
| `JOBSCOUT_ENABLE_LENNYSJOBS` | `false` | Enable the provider |
| `LENNYSJOBS_ENDPOINT` | `https://arc.trueup.io/jobs/search` | Search endpoint to post to. HTTP(S) only |
| `LENNYSJOBS_PARTNER_ID` | `lenny` | Partner scope. Changing this changes which board's pool you get |
| `LENNYSJOBS_SITE_URL` | `https://www.lennysjobs.com` | Base used to build a listing link from a record id |
| `LENNYSJOBS_TIMEOUT_MS` | `20000` | Request timeout, bounded to 1–60 seconds |

### Query translation

The search term is passed through as the index query and `limit` becomes `hitsPerPage`, capped at the index's 100-hit page ceiling. A `location` becomes a `job_locations_combined` facet filter. Remote and freshness constraints are enforced by the registry after retrieval, as they are for every provider.

Only the hit-bearing query is issued. The board pairs it with a second, hit-less query that populates its own facet sidebar; that response carries no jobs, so JobScout does not request it.

### Fields and URLs

Location and tags are read from the index's own attributes — `job_locations_combined`, `job_subcategories_all`, `themes`, `description_tags`, `level`, `company_stage` — which are the facet names the board itself requests. Highlight markers the board asks for around matched terms are stripped before normalization.

Board listing links are recorded as `provenance[].discovery_url`. `canonical_url` is set only when a hit names the employer's own route. Resolve the employer or ATS listing before applying.
