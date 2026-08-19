import { mapUnknownJob } from "./helpers.js";

import type { JobProvider, NormalizedJob, ProviderSearchResult, ProviderStatus, SearchQuery } from "../types.js";

const maxResponseBytes = 5_000_000;

function unwrapCdata(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/u);
  return (match?.[1] ?? trimmed).trim();
}

function extractTag(block: string, tag: string): string | undefined {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "u"));
  return match ? unwrapCdata(match[1] ?? "") : undefined;
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]+>/gu, " ").replace(/&nbsp;/gu, " ").replace(/\s+/gu, " ").trim();
}

function isoDate(pubDate: string | undefined): string | undefined {
  if (!pubDate) return undefined;
  const parsed = new Date(pubDate);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString().slice(0, 10);
}

/**
 * We Work Remotely publishes RSS, not a keyword search endpoint, so every item in the feed
 * comes back and callers filter client-side. Title parsing depends on the feed's own
 * "Company: Job title" convention; a feed change that drops the colon degrades to an
 * "Unknown" company rather than a dropped record, matching this provider's records_rejected
 * discipline elsewhere.
 */
export function parseWeWorkRemotelyRss(xml: string, query: string): ProviderSearchResult {
  const blocks = xml.match(/<item>[\s\S]*?<\/item>/gu) ?? [];
  const needle = query.trim().toLocaleLowerCase("en");
  const terms = needle ? needle.split(/\s+/u).filter(Boolean) : [];

  const jobs = blocks.map((block) => {
    const rawTitle = extractTag(block, "title");
    const link = extractTag(block, "link");
    if (!rawTitle || !link) return undefined;
    const colonIndex = rawTitle.indexOf(":");
    const company = colonIndex === -1 ? "Unknown" : rawTitle.slice(0, colonIndex).trim();
    const title = colonIndex === -1 ? rawTitle.trim() : rawTitle.slice(colonIndex + 1).trim();
    const description = extractTag(block, "description");
    const plainDescription = description ? stripHtml(description) : undefined;
    const region = extractTag(block, "region");
    const category = extractTag(block, "category");
    const datePosted = isoDate(extractTag(block, "pubDate"));

    if (terms.length) {
      const haystack = `${title} ${plainDescription ?? ""}`.toLocaleLowerCase("en");
      if (!terms.some((term) => haystack.includes(term))) return undefined;
    }

    return mapUnknownJob("weworkremotely", {
      title,
      company,
      location: region || "Remote",
      is_remote: true,
      job_url: link,
      ...(plainDescription ? { description: plainDescription } : {}),
      ...(category ? { categories: [category] } : {}),
      ...(datePosted ? { date_posted: datePosted } : {}),
    });
  }).filter((job): job is NormalizedJob => job !== undefined);

  // Items dropped by the query filter are a deliberate narrowing, not a parse failure, so only
  // items that survived filtering but failed validation count as rejected.
  const survivedFilter = terms.length
    ? blocks.filter((block) => {
      const rawTitle = extractTag(block, "title");
      const description = extractTag(block, "description");
      const title = rawTitle?.includes(":") ? rawTitle.slice(rawTitle.indexOf(":") + 1).trim() : rawTitle?.trim();
      const haystack = `${title ?? ""} ${description ? stripHtml(description) : ""}`.toLocaleLowerCase("en");
      return terms.some((term) => haystack.includes(term));
    }).length
    : blocks.length;

  return { jobs, records_rejected: survivedFilter - jobs.length };
}

export class WeWorkRemotelyProvider implements JobProvider {
  constructor(
    private readonly enabled: boolean,
    private readonly feedUrl: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  status(): ProviderStatus {
    return {
      id: "weworkremotely",
      label: "We Work Remotely",
      enabled: this.enabled,
      authentication: "none",
      transport: "http-api",
      coverage: ["general"],
      notes: "Public RSS feed, filtered client-side (no keyword search endpoint). Configure with WWR_RSS_URL to point at a specific category feed.",
    };
  }

  async search(query: SearchQuery): Promise<ProviderSearchResult> {
    if (!this.enabled) return { jobs: [], records_rejected: 0 };
    const feedUrl = new URL(this.feedUrl);
    if (feedUrl.protocol !== "https:" && feedUrl.protocol !== "http:") throw new Error("WWR_RSS_URL must use http or https.");
    const response = await this.fetcher(feedUrl, {
      headers: { accept: "application/rss+xml, application/xml, text/xml" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`We Work Remotely RSS HTTP ${response.status}`);
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (declaredLength > maxResponseBytes) throw new Error("We Work Remotely RSS response exceeded the 5 MB safety limit.");
    const body = await response.text();
    if (Buffer.byteLength(body, "utf8") > maxResponseBytes) throw new Error("We Work Remotely RSS response exceeded the 5 MB safety limit.");
    const { jobs, records_rejected } = parseWeWorkRemotelyRss(body, query.query);
    return { jobs: jobs.slice(0, query.limit), records_rejected };
  }
}
