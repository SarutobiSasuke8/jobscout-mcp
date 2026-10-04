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

## Disclosure fields

A search result reports what was actually done, not only what was found:

- `location_unfiltered` names providers that were queried but could not apply the requested `location`. Whole-feed sources have no location parameter to pass upstream, so their results are unscoped rather than empty. Each provider declares this as `location_filtering` in `jobscout_list_sources`.
- `warnings` names providers that returned degraded results — a stale cached copy after a rate limit, for example. A warning is not a failure: the results are real but thinner or older than a healthy run.
- `records_rejected_by_provider` attributes dropped records to the source that produced them. The aggregate says something drifted; only the breakdown says where to look. `undated_records` stays aggregate, because a deduplicated record can carry provenance from several sources at once and attributing it to one would be a guess.

## Caching

Providers that download a whole feed share a short-lived response cache keyed by URL, so several searches in one conversation cost one fetch rather than several. Entries hold public listings only — never anything about the person searching. Configure with `JOBSCOUT_FEED_CACHE_TTL_MS` (default 300000, `0` disables, clamped to one hour).

A past-freshness copy is retained briefly beyond the TTL and served if the source rate-limits or times out, always accompanied by a warning. Non-transient failures such as a 404 are never answered from cache: that would hide a misconfigured URL indefinitely.

## URL semantics

Every record can carry two different kinds of link, and consumers should not conflate them:

- `canonical_url` (top level): the employer application route, present only when the source exposes one (for example python-jobspy's `job_url_direct`). This is the link to prefer when applying.
- `provenance[].discovery_url`: where the record was found — a listing or aggregator page. Always an audit trail, not proof the employer endorsed the listing.

`jobscout_briefing` applies the fallback rule for you (`canonical_url`, else first `discovery_url`) and labels which kind it chose via `url_kind`, so downstream briefings never drop the link or present a discovery page as an apply route.

## Himalayas

Uses the public remote MCP endpoint when explicitly enabled. The adapter requests `search_jobs`; authenticated profile or tracker tools are outside scope.

## We Work Remotely

Uses the public We Work Remotely RSS feed (`https://weworkremotely.com/remote-jobs.rss` by default). No authentication and no rate-limit concerns beyond normal RSS fetching, but RSS has no keyword search endpoint, so JobScout downloads the feed and filters by `query` client-side rather than sending the query to We Work Remotely.

Set `WWR_RSS_URL` to a category-specific feed (for example `https://weworkremotely.com/categories/remote-programming-jobs.rss`) to narrow what gets fetched instead of the combined feed.

Item titles on this feed follow a "Company: Job title" convention; a listing that omits the colon is recorded with company `Unknown` rather than dropped.

## RemoteOK

Uses the public JSON endpoint (`https://remoteok.com/api` by default, overridable with `REMOTEOK_API_URL`). No authentication. The endpoint returns the latest listings rather than answering a keyword query, so JobScout filters and ranks client-side.

Two behaviours are worth knowing:

- **Attribution.** RemoteOK's API terms ask for a link back to the listing. The feed carries this as a notice object in the first array position, which JobScout skips as metadata. Every record keeps its `provenance[].discovery_url`, so attribution is available wherever results are republished.
- **Apply links.** RemoteOK's `apply_url` is often a redirect on its own domain. Those are recorded as provenance only and never as `canonical_url`, because that field means the employer's application route and is the primary deduplication identity — treating a redirect as canonical would both imply employer endorsement and give each listing an identity that could never merge with the same vacancy from another source. An `apply_url` pointing at a genuine employer domain is kept as `canonical_url`.

Salary figures are published as bare numbers with no currency field, so they are passed through without a currency rather than assuming one.

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
