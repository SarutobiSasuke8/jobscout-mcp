import { mapUnknownJob } from "./helpers.js";

import type { JobProvider, NormalizedJob, ProviderSearchResult, ProviderStatus, SearchQuery } from "../types.js";

const maxResponseBytes = 5_000_000;

function unwrapCdata(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/u);
  return (match?.[1] ?? trimmed).trim();
}

const namedEntities = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", "\""],
  ["apos", "'"],
  ["nbsp", " "],
]);

function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/giu, (match, body: string) => {
    const token = body.toLocaleLowerCase("en");
    if (!token.startsWith("#")) return namedEntities.get(token) ?? match;
    const codePoint = token.startsWith("#x")
      ? Number.parseInt(token.slice(2), 16)
      : Number.parseInt(token.slice(1), 10);
    if (!Number.isFinite(codePoint) || codePoint <= 0 || codePoint > 0x10_ff_ff) return match;
    try {
      return String.fromCodePoint(codePoint);
    } catch {
      return match;
    }
  });
}

/**
 * Tags are stripped before entities are decoded, never the other way around. A listing
 * containing the literal text `&lt;script&gt;` is quoting markup, not carrying it; decoding
 * first would manufacture a real tag out of escaped prose and then hand it downstream as
 * though the feed had published it.
 */
function cleanText(value: string): string {
  return decodeEntities(value.replace(/<[^>]+>/gu, " ")).replace(/\s+/gu, " ").trim();
}

function extractTag(block: string, tag: string): string | undefined {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "u"));
  const value = match ? cleanText(unwrapCdata(match[1] ?? "")) : "";
  return value || undefined;
}

function extractAllTags(block: string, tag: string): string[] {
  const matches = block.matchAll(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "gu"));
  return [...matches].map((match) => cleanText(unwrapCdata(match[1] ?? ""))).filter(Boolean);
}

function isoDate(pubDate: string | undefined): string | undefined {
  if (!pubDate) return undefined;
  const parsed = new Date(pubDate);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString().slice(0, 10);
}

interface FeedItem {
  title: string;
  company: string;
  location: string;
  is_remote: true;
  job_url: string;
  description?: string;
  categories?: string[];
  date_posted?: string;
  employment_type?: string;
  source_job_id?: string;
}

/**
 * Read one `<item>`, preferring explicit elements over inference.
 *
 * The "Company: Job title" convention in `<title>` is a formatting habit of the feed, not a
 * guarantee, so an explicit `<company>` element wins when the feed supplies one and the split
 * is only a fallback. A title with no colon yields company `Unknown` rather than being
 * discarded: a listing with a weaker company label is still a real vacancy.
 */
function parseItem(block: string): FeedItem | undefined {
  const rawTitle = extractTag(block, "title");
  const link = extractTag(block, "link");
  if (!rawTitle || !link) return undefined;

  const explicitCompany = extractTag(block, "company");
  const colonIndex = rawTitle.indexOf(":");
  const prefix = colonIndex === -1 ? undefined : rawTitle.slice(0, colonIndex).trim() || undefined;
  const remainder = colonIndex === -1 ? undefined : rawTitle.slice(colonIndex + 1).trim() || undefined;
  const company = explicitCompany ?? prefix ?? "Unknown";

  // Only strip the prefix when it is the company label rather than part of the role name.
  // "Example Corp: Senior Engineer" splits; "Engineer: Platform" alongside an explicit
  // <company> element does not, because there the colon belongs to the job title.
  const prefixIsCompanyLabel = prefix !== undefined && remainder !== undefined
    && (explicitCompany === undefined || prefix.toLocaleLowerCase("en") === explicitCompany.toLocaleLowerCase("en"));
  const title = prefixIsCompanyLabel ? remainder : rawTitle.trim();
  if (!title) return undefined;

  const categories = [...extractAllTags(block, "category"), ...extractAllTags(block, "type")];
  const description = extractTag(block, "description");
  const region = extractTag(block, "region");
  const employmentType = extractTag(block, "type");
  const datePosted = isoDate(extractTag(block, "pubDate"));
  const guid = extractTag(block, "guid");

  return {
    title,
    company,
    location: region ?? "Remote",
    is_remote: true,
    job_url: link,
    ...(description ? { description } : {}),
    ...(categories.length ? { categories } : {}),
    ...(datePosted ? { date_posted: datePosted } : {}),
    ...(employmentType ? { employment_type: employmentType } : {}),
    ...(guid ? { source_job_id: guid } : {}),
  };
}

/** How many of the query's terms this listing mentions. Zero means it is not a match at all. */
function relevance(item: FeedItem, terms: string[]): number {
  if (!terms.length) return 1;
  const haystack = [item.title, item.company, item.description ?? "", ...(item.categories ?? [])]
    .join(" ")
    .toLocaleLowerCase("en");
  return terms.filter((term) => haystack.includes(term)).length;
}

/**
 * We Work Remotely publishes RSS, not a keyword search endpoint, so the whole feed arrives and
 * the query is applied here.
 *
 * Matching is deliberately OR-with-ranking rather than plain OR. A two-word query against a
 * whole-feed download matches a large share of the feed on either word, and `limit` then
 * truncates that set in feed order — so a search for "product manager" could return nothing but
 * unrelated managers and never reach the product roles. Scoring by matched-term count and
 * sorting before the caller slices makes the truncation keep the closest matches. The sort is
 * stable, so listings on equal scores stay in the feed's own recency order.
 */
export function parseWeWorkRemotelyRss(xml: string, query: string): ProviderSearchResult {
  const blocks = xml.match(/<item>[\s\S]*?<\/item>/gu) ?? [];
  const terms = query.trim().toLocaleLowerCase("en").split(/\s+/u).filter(Boolean);

  const scored: Array<{ job: NormalizedJob; score: number }> = [];
  let rejected = 0;

  for (const block of blocks) {
    const item = parseItem(block);
    // An item this parser cannot read is counted, never ignored. These counts are the only
    // signal an operator gets that the feed's shape has drifted away from what we expect.
    if (!item) {
      rejected += 1;
      continue;
    }
    const score = relevance(item, terms);
    if (score === 0) continue;
    const job = mapUnknownJob("weworkremotely", { ...item });
    if (job) scored.push({ job, score });
    else rejected += 1;
  }

  scored.sort((left, right) => right.score - left.score);
  return { jobs: scored.map((entry) => entry.job), records_rejected: rejected };
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
      notes: `Public RSS feed, fetched in full and filtered client-side because RSS exposes no keyword search. Currently reading ${this.feedUrl}; set WWR_RSS_URL to a category feed to narrow it.`,
    };
  }

  async search(query: SearchQuery): Promise<ProviderSearchResult> {
    if (!this.enabled) return { jobs: [], records_rejected: 0 };
    const feedUrl = new URL(this.feedUrl);
    if (feedUrl.protocol !== "https:" && feedUrl.protocol !== "http:") throw new Error("WWR_RSS_URL must use http or https.");
    const response = await this.fetcher(feedUrl, {
      headers: {
        accept: "application/rss+xml, application/xml, text/xml",
        // Identify the client rather than arriving as an anonymous default agent.
        "user-agent": "jobscout-mcp (+https://github.com/SarutobiSasuke8/jobscout-mcp)",
      },
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
