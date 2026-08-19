import { mapJobRecords, record, stringArrayValue, textValue } from "./helpers.js";

import type { JobProvider, ProviderSearchResult, ProviderStatus, SearchQuery } from "../types.js";

const maxResponseBytes = 5_000_000;

/**
 * Lenny's Job Board is a partner view over TrueUp's job index: the board's own page calls
 * TrueUp's search endpoint with `trueupPartnerId: "lenny"`, and that partner id is what scopes
 * the pool to the board rather than to all of TrueUp. Both values are recorded here because
 * they are what the board itself sends; neither is a guess.
 *
 * This is an undocumented endpoint belonging to a third party, not a published API with terms
 * inviting use. That is why the provider is disabled by default and says so in its status: an
 * operator opts in knowingly, and an upstream change breaks a source nobody was relying on
 * silently.
 */
export const defaultEndpoint = "https://arc.trueup.io/jobs/search";
export const defaultPartnerId = "lenny";
export const defaultSiteUrl = "https://www.lennysjobs.com";

/** The board asks for highlight markers around matched terms. Strip them before normalization. */
const highlightMarkers = /__\/?ais-highlight__/gu;

function clean(value: string | undefined): string | undefined {
  return value?.replace(highlightMarkers, "").trim() || undefined;
}

/**
 * Build the Algolia-shaped request the board sends.
 *
 * Only the primary query is issued. The board pairs it with a second, hit-less query used to
 * populate its own facet sidebar; that result carries no jobs, so requesting it here would be
 * pure overhead.
 */
export function buildSearchBody(query: SearchQuery, partnerId: string): string {
  const facetFilters: string[][] = [];
  if (query.location) facetFilters.push([`job_locations_combined:${query.location}`]);
  return JSON.stringify([{
    indexName: "job",
    params: {
      query: query.query,
      hitsPerPage: Math.min(query.limit, 100),
      page: 0,
      ...(facetFilters.length ? { facetFilters } : {}),
      trueupRequestVersion: 2,
      trueupPartnerId: partnerId,
    },
  }]);
}

/** Board listing page for a hit, built from the record id the index returns. */
function listingUrl(siteUrl: string, id: string | undefined): string | undefined {
  if (!id || !/^[A-Za-z0-9_-]{1,240}$/u.test(id)) return undefined;
  try {
    return new URL(`/jobs/${id}`, siteUrl).toString();
  } catch {
    return undefined;
  }
}

/**
 * Flatten one search hit into the flat shape `mapUnknownJob` understands.
 *
 * The tag and location field names are the index's own: they are the facet attributes the
 * board requests by name, so they are known rather than inferred. Title, company and employer
 * link are read through several spellings because the hit shape is not documented anywhere.
 */
export function flattenHit(hit: Record<string, unknown>, siteUrl = defaultSiteUrl): Record<string, unknown> {
  const company = record(hit.company);
  const id = textValue(hit, ["objectID", "id", "job_id", "slug"]);
  const locations = stringArrayValue(hit, ["job_locations_combined", "locations"]);
  const companyName = company
    ? textValue(company, ["name", "title"])
    : textValue(hit, ["company", "company_name", "companyName", "employer"]);
  const description = clean(textValue(hit, ["description", "job_description", "summary"]));
  const datePosted = textValue(hit, ["date_posted", "posted_at", "published_at", "first_seen_at"]);
  // Only a field naming the employer's own route may become canonical_url. The board's listing
  // page is provenance, never an apply route.
  const employerUrl = textValue(hit, ["job_url_direct", "canonical_url", "employer_url"]);
  const discoveryUrl = listingUrl(siteUrl, id);

  return {
    title: clean(textValue(hit, ["title", "job_title", "name"])),
    company: clean(companyName),
    location: clean(locations.join("; ")) ?? textValue(hit, ["location", "job_location"]) ?? "Unknown",
    ...(locations.some((entry) => /remote/iu.test(entry)) ? { remote: true } : {}),
    ...(description ? { description } : {}),
    ...(datePosted ? { date_posted: datePosted } : {}),
    ...(employerUrl ? { canonical_url: employerUrl } : {}),
    ...(discoveryUrl ? { job_url: discoveryUrl } : {}),
    ...(id ? { source_job_id: id } : {}),
    tags: stringArrayValue(hit, ["job_subcategories_all", "themes", "description_tags", "level", "company_stage"]),
  };
}

/** Pure response -> normalized projection, so the mapping is testable without a network call. */
export function parseSearchResponse(payload: unknown, query: SearchQuery, siteUrl = defaultSiteUrl): ProviderSearchResult {
  const results = record(payload)?.results;
  const first = Array.isArray(results) ? record(results[0]) : undefined;
  const hits = Array.isArray(first?.hits) ? first.hits : [];
  const records = hits
    .map(record)
    .filter((hit): hit is Record<string, unknown> => hit !== undefined)
    .map((hit) => flattenHit(hit, siteUrl));
  return mapJobRecords("lennysjobs", records, query.limit);
}

export class LennysJobsProvider implements JobProvider {
  constructor(
    private readonly enabled: boolean,
    private readonly endpoint: string = defaultEndpoint,
    private readonly partnerId: string = defaultPartnerId,
    private readonly siteUrl: string = defaultSiteUrl,
    private readonly timeoutMs: number = 20_000,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  status(): ProviderStatus {
    return {
      id: "lennysjobs",
      label: "Lenny's Job Board",
      enabled: this.enabled,
      authentication: "none",
      transport: "http-api",
      coverage: ["general", "ai"],
      notes: `Queries TrueUp's search endpoint, which powers the board, scoped to partner "${this.partnerId}". This is an undocumented third-party endpoint rather than a published API: it can change or stop without notice, and enabling it is your decision. Board links are discovery URLs; resolve the employer or ATS listing before applying.`,
    };
  }

  async search(query: SearchQuery): Promise<ProviderSearchResult> {
    if (!this.enabled) return { jobs: [], records_rejected: 0 };
    const endpoint = new URL(this.endpoint);
    if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") throw new Error("Lenny's Job Board endpoint must use http or https.");

    const response = await this.fetcher(endpoint.toString(), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: buildSearchBody(query, this.partnerId),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`Lenny's Job Board search HTTP ${response.status}`);
    if (Number(response.headers.get("content-length") ?? 0) > maxResponseBytes) throw new Error("Lenny's Job Board response exceeded the 5 MB safety limit.");
    const body = await response.text();
    if (Buffer.byteLength(body, "utf8") > maxResponseBytes) throw new Error("Lenny's Job Board response exceeded the 5 MB safety limit.");

    let payload: unknown;
    try {
      payload = JSON.parse(body) as unknown;
    } catch {
      throw new Error("Lenny's Job Board search did not return JSON.");
    }
    return parseSearchResponse(payload, query, this.siteUrl);
  }
}
