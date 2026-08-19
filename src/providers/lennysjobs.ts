import { findJobRecords, mapJobRecords, record, stringArrayValue, textValue } from "./helpers.js";

import type { JobProvider, ProviderSearchResult, ProviderStatus, SearchQuery } from "../types.js";

const maxResponseBytes = 5_000_000;
const maxRecords = 1_000;

/**
 * Lenny's Job Board publishes its listings at `https://www.lennysjobs.com/jobs/<id>`. That
 * page pattern is the only part of the site this adapter assumes; the feed it reads is
 * supplied by the operator, because the board exposes no documented public API and JobScout
 * does not ship endpoints it has not verified.
 */
export const defaultSiteUrl = "https://www.lennysjobs.com";

function httpEndpoint(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Lenny's Job Board feed URL must use http or https.");
  return url;
}

/** Build the public listing page for a record that carries an id but no link of its own. */
function listingUrl(siteUrl: string, id: string | undefined): string | undefined {
  if (!id || !/^[A-Za-z0-9_-]{1,240}$/u.test(id)) return undefined;
  try {
    return new URL(`/jobs/${id}`, siteUrl).toString();
  } catch {
    return undefined;
  }
}

/**
 * Flatten one feed record into the flat shape `mapUnknownJob` understands.
 *
 * Board feeds of this kind nest the employer and the location as objects, which the shared
 * mapper reads as absent rather than as a company name. Flattening here keeps that handling
 * in one place instead of loosening the shared mapper for every provider.
 *
 * The board link is deliberately emitted as `job_url` (discovery) and never as
 * `canonical_url`. An aggregator link is where a record was found, not proof that the employer
 * published it, and JobScout's URL contract depends on that distinction holding.
 */
export function flattenLennysJobsRecord(source: Record<string, unknown>, siteUrl = defaultSiteUrl): Record<string, unknown> {
  const company = record(source.company) ?? record(source.organization) ?? record(source.employer);
  const location = record(source.location);
  const id = textValue(source, ["id", "job_id", "uuid", "slug"]);
  const discovery = textValue(source, ["url", "job_url", "listing_url", "public_url"]) ?? listingUrl(siteUrl, id);
  const locationText = location ? textValue(location, ["name", "label", "city", "text"]) : textValue(source, ["location", "job_location", "city"]);
  const remote = typeof source.remote === "boolean" ? source.remote
    : typeof source.is_remote === "boolean" ? source.is_remote
    : locationText ? /remote/iu.test(locationText) : undefined;

  // `apply_url` is dropped rather than forwarded: on a board of this kind it is the board's own
  // apply flow, and the shared mapper would promote it to `canonical_url` — the field JobScout
  // reserves for a verified employer application route. An explicit `canonical_url` or
  // `job_url_direct` in the feed is kept, because those name the employer route deliberately.
  const rest = { ...source };
  delete rest.apply_url;

  return {
    ...rest,
    ...(company ? { company: textValue(company, ["name", "title", "label"]) } : {}),
    ...(textValue(source, ["companyName", "company_name"]) && !company ? { company: textValue(source, ["companyName", "company_name"]) } : {}),
    ...(locationText ? { location: locationText } : {}),
    ...(remote === undefined ? {} : { remote }),
    ...(discovery ? { job_url: discovery } : {}),
    ...(id ? { source_job_id: id } : {}),
    tags: stringArrayValue(source, ["tags", "categories", "skills", "departments", "functions", "roles", "seniority"]),
  };
}

/**
 * Keep records that mention any query term.
 *
 * The feed is a whole-board export rather than a search endpoint, so without this a search for
 * "product manager" would hand back every listing on the board and let deduplication decide
 * what survived. Matching on any term rather than all of them is the deliberate choice: a
 * caller asking for "senior product manager AI" wants the near misses surfaced, not an empty
 * result because one word was absent. Terms shorter than three characters are ignored so that
 * "AI" style noise words do not silently widen the filter to everything.
 */
export function matchesQuery(source: Record<string, unknown>, query: string): boolean {
  const terms = query.toLocaleLowerCase("en").split(/[^a-z0-9+#.]+/iu).filter((term) => term.length >= 3);
  if (!terms.length) return true;
  const haystack = [
    textValue(source, ["title", "job_title", "name"]) ?? "",
    textValue(source, ["company", "company_name", "companyName"]) ?? "",
    textValue(source, ["description", "job_description", "details"]) ?? "",
    stringArrayValue(source, ["tags", "categories", "skills", "departments", "functions", "roles", "seniority"]).join(" "),
  ].join(" ").toLocaleLowerCase("en");
  return terms.some((term) => haystack.includes(term));
}

/** Pure feed -> normalized projection, so the mapping is testable without a network call. */
export function parseLennysJobsFeed(payload: unknown, query: SearchQuery, siteUrl = defaultSiteUrl): ProviderSearchResult {
  const records = findJobRecords(payload)
    .slice(0, maxRecords)
    .map((item) => flattenLennysJobsRecord(item, siteUrl))
    .filter((item) => matchesQuery(item, query.query));
  return mapJobRecords("lennysjobs", records, query.limit);
}

export class LennysJobsProvider implements JobProvider {
  constructor(
    private readonly enabled: boolean,
    private readonly feedUrl: string | undefined,
    private readonly siteUrl: string = defaultSiteUrl,
    private readonly queryParameter: string | undefined = undefined,
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
      notes: this.feedUrl
        ? "Reads an operator-supplied public JSON feed of the board and filters it locally. Board links are discovery URLs; resolve the employer or ATS listing before applying."
        : "No feed URL is configured. Set LENNYSJOBS_FEED_URL to the public JSON endpoint you have verified for the board; JobScout ships no default endpoint for this source.",
    };
  }

  async search(query: SearchQuery): Promise<ProviderSearchResult> {
    if (!this.enabled) return { jobs: [], records_rejected: 0 };
    // A configuration gap must be loud. Returning an empty success here would let the blended
    // pool report "searched, found nothing" for a source that was never contacted.
    if (!this.feedUrl) throw new Error("Lenny's Job Board is enabled but LENNYSJOBS_FEED_URL is not set, so nothing was requested.");

    const endpoint = httpEndpoint(this.feedUrl);
    if (this.queryParameter) endpoint.searchParams.set(this.queryParameter, query.query);

    const response = await this.fetcher(endpoint.toString(), {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`Lenny's Job Board feed HTTP ${response.status}`);
    if (Number(response.headers.get("content-length") ?? 0) > maxResponseBytes) throw new Error("Lenny's Job Board feed exceeded the 5 MB safety limit.");
    const body = await response.text();
    if (Buffer.byteLength(body, "utf8") > maxResponseBytes) throw new Error("Lenny's Job Board feed exceeded the 5 MB safety limit.");

    let payload: unknown;
    try {
      payload = JSON.parse(body) as unknown;
    } catch {
      throw new Error("Lenny's Job Board feed did not return JSON. LENNYSJOBS_FEED_URL must point at a JSON endpoint, not an HTML page.");
    }
    return parseLennysJobsFeed(payload, query, this.siteUrl);
  }
}
