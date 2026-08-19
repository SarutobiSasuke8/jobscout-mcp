import { mapUnknownJob, plainText, queryTerms, record, relevanceScore, stringArrayValue, textValue } from "./helpers.js";

import type { UnknownRecord } from "./helpers.js";
import type { JobProvider, NormalizedJob, ProviderSearchResult, ProviderStatus, SearchQuery } from "../types.js";

const maxResponseBytes = 5_000_000;

/**
 * Hosts whose "apply" links are RemoteOK's own tracked redirects rather than an employer route.
 *
 * This distinction is not cosmetic. `canonical_url` is documented as the employer application
 * route and is the primary dedup identity, so accepting `https://remoteok.com/l/{id}` would do
 * two wrong things at once: present an aggregator redirect as though the employer endorsed it,
 * and give every RemoteOK listing a unique identity that can never merge with the same vacancy
 * found elsewhere. Such links stay provenance, and the record simply carries no canonical URL.
 */
const aggregatorHosts = new Set(["remoteok.com", "remoteok.io", "remoteok.org"]);

function isEmployerRoute(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const host = new URL(value).host.toLocaleLowerCase("en").replace(/^www\./u, "");
    return !aggregatorHosts.has(host);
  } catch {
    return false;
  }
}

function isoDate(entry: UnknownRecord): string | undefined {
  const date = textValue(entry, ["date", "date_posted", "published_at"]);
  if (date) {
    const parsed = new Date(date);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  }
  const epoch = entry.epoch;
  const seconds = typeof epoch === "number" ? epoch : Number(epoch);
  if (Number.isFinite(seconds) && seconds > 0) return new Date(seconds * 1_000).toISOString().slice(0, 10);
  return undefined;
}

/**
 * RemoteOK's feed opens with a legal/attribution notice object rather than a job. It is
 * metadata, not a malformed listing, so it is skipped without inflating `records_rejected` —
 * that counter exists to signal real shape drift.
 */
function isLegalNotice(entry: UnknownRecord): boolean {
  return entry.legal !== undefined && textValue(entry, ["position", "title"]) === undefined;
}

function toSourceRecord(entry: UnknownRecord): UnknownRecord | undefined {
  // RemoteOK names the role `position`; `title` is accepted too in case that ever changes.
  const title = textValue(entry, ["position", "title"]);
  const company = textValue(entry, ["company", "company_name"]);
  const discoveryUrl = textValue(entry, ["url", "job_url"]);
  if (!title || !company || !discoveryUrl) return undefined;

  const applyUrl = textValue(entry, ["apply_url"]);
  const description = textValue(entry, ["description"]);
  const location = textValue(entry, ["location"]);

  return {
    title: plainText(title),
    company: plainText(company),
    // RemoteOK lists only remote work; a blank location means unrestricted, not unknown.
    location: location ? plainText(location) : "Remote",
    is_remote: true,
    url: discoveryUrl,
    ...(isEmployerRoute(applyUrl) ? { apply_url: applyUrl } : {}),
    ...(description ? { description: plainText(description) } : {}),
    ...(isoDate(entry) ? { date_posted: isoDate(entry) } : {}),
    ...(textValue(entry, ["id", "slug"]) ? { id: textValue(entry, ["id", "slug"]) } : {}),
    tags: stringArrayValue(entry, ["tags"]),
    // Salary is published as bare numbers with no currency field. Rather than assume one, the
    // amounts are passed through uncurrencied so nothing claims a denomination the source
    // never stated.
    ...(entry.salary_min !== undefined ? { salary_min: entry.salary_min } : {}),
    ...(entry.salary_max !== undefined ? { salary_max: entry.salary_max } : {}),
  };
}

/**
 * RemoteOK's public endpoint returns the latest listings, not a keyword search, so the query is
 * applied here and results are ranked by matched-term count before the caller slices to
 * `limit`. The sort is stable, so equal scores keep the source's own recency order.
 */
export function parseRemoteOkPayload(payload: unknown, query: string): ProviderSearchResult {
  const entries = Array.isArray(payload)
    ? payload.map(record).filter((item): item is UnknownRecord => item !== undefined)
    : [];
  const terms = queryTerms(query);

  const scored: Array<{ job: NormalizedJob; score: number }> = [];
  let rejected = 0;

  for (const entry of entries) {
    if (isLegalNotice(entry)) continue;
    const source = toSourceRecord(entry);
    if (!source) {
      rejected += 1;
      continue;
    }
    const score = relevanceScore(
      [source.title as string, source.company as string, source.description as string | undefined, ...(source.tags as string[])],
      terms,
    );
    if (score === 0) continue;
    const job = mapUnknownJob("remoteok", source);
    if (job) scored.push({ job, score });
    else rejected += 1;
  }

  scored.sort((left, right) => right.score - left.score);
  return { jobs: scored.map((entry) => entry.job), records_rejected: rejected };
}

export class RemoteOkProvider implements JobProvider {
  constructor(
    private readonly enabled: boolean,
    private readonly apiUrl: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  status(): ProviderStatus {
    return {
      id: "remoteok",
      label: "RemoteOK",
      enabled: this.enabled,
      authentication: "none",
      transport: "http-api",
      coverage: ["general", "ai", "web3"],
      notes: "Public JSON endpoint returning the latest listings; the query is applied client-side because the endpoint offers no keyword search. RemoteOK's API terms ask for attribution back to the listing, so keep the discovery URL when republishing. Apply links on RemoteOK's own domain are recorded as provenance, not as employer application routes.",
    };
  }

  async search(query: SearchQuery): Promise<ProviderSearchResult> {
    if (!this.enabled) return { jobs: [], records_rejected: 0 };
    const apiUrl = new URL(this.apiUrl);
    if (apiUrl.protocol !== "https:" && apiUrl.protocol !== "http:") throw new Error("REMOTEOK_API_URL must use http or https.");
    const response = await this.fetcher(apiUrl, {
      headers: {
        accept: "application/json",
        // Identify the client rather than arriving as an anonymous default agent.
        "user-agent": "jobscout-mcp (+https://github.com/SarutobiSasuke8/jobscout-mcp)",
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`RemoteOK HTTP ${response.status}`);
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (declaredLength > maxResponseBytes) throw new Error("RemoteOK response exceeded the 5 MB safety limit.");
    const body = await response.text();
    if (Buffer.byteLength(body, "utf8") > maxResponseBytes) throw new Error("RemoteOK response exceeded the 5 MB safety limit.");

    let payload: unknown;
    try {
      payload = JSON.parse(body) as unknown;
    } catch {
      throw new Error("RemoteOK returned a response that was not valid JSON.");
    }
    if (!Array.isArray(payload)) throw new Error("RemoteOK returned an unexpected payload shape; expected an array of listings.");

    const { jobs, records_rejected } = parseRemoteOkPayload(payload, query.query);
    return { jobs: jobs.slice(0, query.limit), records_rejected };
  }
}
