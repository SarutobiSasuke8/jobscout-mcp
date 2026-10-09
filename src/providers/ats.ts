import { mapUnknownJob, queryTerms, relevanceScore } from "./helpers.js";
import { fetchTextResource } from "./http.js";
import { employerSourceIds } from "../types.js";

import type { UnknownRecord } from "./helpers.js";
import type { ResponseCache } from "./http.js";
import type { JobProvider, NormalizedJob, ProviderSearchResult, ProviderStatus, SearchQuery } from "../types.js";

/**
 * Shared machinery for the official applicant tracking system (ATS) adapters.
 *
 * Greenhouse, Ashby and Lever each publish a public, unauthenticated job-board API per company.
 * None of them offers a cross-company search: you ask for one employer's board by its token and
 * receive every open requisition on it. So these providers are configured with an explicit list
 * of company boards, fetch each board whole, and apply the query client-side, exactly as the
 * whole-feed providers do.
 *
 * What they add over the boards and aggregators is first-party provenance: the requisition URL
 * comes from the employer's own ATS, so it is recorded as both the discovery URL and the
 * canonical employer link. Deduplication then prefers it over any board copy of the same job.
 */

/** Board responses carry full descriptions; large employers publish several megabytes. */
export const atsMaxResponseBytes = 10_000_000;

/** An operator configuring hundreds of boards is a crawler, not a job search. */
export const maxBoardsPerProvider = 25;

/** Boards fetched at once per provider. Polite to the vendor, quick enough for a chat turn. */
const boardConcurrency = 4;

/** Provider ids whose canonical URLs are first-party requisition links. */
export const atsProviderIds = employerSourceIds;

export interface AtsBoard {
  /** The vendor's board identifier, as it appears in the public board URL. */
  token: string;
  /** Employer display name, when the operator supplied one. */
  company?: string;
}

export interface BoardListResolution {
  boards: AtsBoard[];
  /** Entries that were not used: malformed, duplicated or past the per-provider cap. */
  ignored: string[];
}

/**
 * Board tokens are path segments in a vendor URL. Anything outside this alphabet is refused
 * rather than encoded, so a configuration value can never reach a different path or host.
 */
const tokenPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;

/**
 * Parse a comma-separated board list. Each entry is `token` or `token=Company Name`.
 *
 * The display name matters for deduplication: Lever and Ashby responses do not name the
 * employer, and a board copy of the same job is only merged when the employer names agree.
 * Without a name the token itself is used, which is right for single-word employers.
 */
export function resolveBoardList(value: string | undefined): BoardListResolution {
  const boards: AtsBoard[] = [];
  const ignored: string[] = [];
  const seen = new Set<string>();
  for (const raw of (value ?? "").split(",")) {
    const entry = raw.trim();
    if (!entry) continue;
    const separator = entry.indexOf("=");
    const token = (separator === -1 ? entry : entry.slice(0, separator)).trim();
    const company = separator === -1 ? undefined : entry.slice(separator + 1).replace(/\s+/gu, " ").trim().slice(0, 120);
    const key = token.toLocaleLowerCase("en");
    if (!tokenPattern.test(token) || seen.has(key) || boards.length >= maxBoardsPerProvider) {
      ignored.push(entry.slice(0, 120));
      continue;
    }
    seen.add(key);
    boards.push({ token, ...(company ? { company } : {}) });
  }
  return { boards, ignored };
}

/** Fallback employer name when neither the operator nor the payload supplies one. */
export function companyFromToken(token: string): string {
  const words = token.replace(/[._-]+/gu, " ").trim();
  return words.charAt(0).toLocaleUpperCase("en") + words.slice(1);
}

/** A UTC calendar date from an ISO timestamp or epoch milliseconds. */
export function isoDate(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  if (typeof value === "string" && !value.trim()) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString().slice(0, 10);
}

export type SalaryInterval = "hour" | "day" | "week" | "month" | "year";

/** Map a vendor's free-form pay interval ("1 YEAR", "per-year-salary") onto the schema's set. */
export function salaryInterval(value: unknown): SalaryInterval | undefined {
  if (typeof value !== "string") return undefined;
  const lower = value.toLocaleLowerCase("en");
  for (const interval of ["hour", "day", "week", "month", "year"] as const) {
    if (lower.includes(interval)) return interval;
  }
  return undefined;
}

export interface BoardParseResult {
  /** Source records in the shape `mapUnknownJob` reads. */
  records: UnknownRecord[];
  /** Entries that were present but unreadable. Skipped-by-design entries are not counted. */
  rejected: number;
}

export interface AtsVendor {
  id: (typeof atsProviderIds)[number];
  label: string;
  /** Environment variable names, used in status notes and error messages. */
  enableVariable: string;
  boardsVariable: string;
  baseVariable: string;
  /** Host shown in status notes so an operator knows exactly what is contacted. */
  termsUrl: string;
  boardUrl(base: string, token: string): string;
  /** Parse one board's JSON payload. Throws when the payload shape is unrecognisable. */
  parseBoard(payload: unknown, board: AtsBoard): BoardParseResult;
}

/**
 * Score, map and rank one provider's records across all its boards. The sort is stable, so
 * equal scores keep board order, then the board's own order.
 */
export function rankBoardRecords(provider: string, records: UnknownRecord[], query: string): ProviderSearchResult {
  const terms = queryTerms(query);
  const scored: Array<{ job: NormalizedJob; score: number }> = [];
  let rejected = 0;
  for (const source of records) {
    const tags = Array.isArray(source.tags) ? source.tags.filter((tag): tag is string => typeof tag === "string") : [];
    const score = relevanceScore(
      [source.title as string | undefined, source.company as string | undefined, source.description as string | undefined, source.location as string | undefined, ...tags],
      terms,
    );
    if (score === 0) continue;
    const job = mapUnknownJob(provider, source);
    if (job) scored.push({ job, score });
    else rejected += 1;
  }
  scored.sort((left, right) => right.score - left.score);
  return { jobs: scored.map((entry) => entry.job), records_rejected: rejected };
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array<PromiseSettledResult<R>>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = items[index] as T;
      try {
        results[index] = { status: "fulfilled", value: await task(item) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function reasonText(reason: unknown): string {
  return (reason instanceof Error ? reason.message : "request failed").replace(/[\r\n\t]+/gu, " ").slice(0, 200);
}

export class AtsBoardProvider implements JobProvider {
  constructor(
    private readonly vendor: AtsVendor,
    private readonly enabledFlag: boolean,
    private readonly boards: AtsBoard[],
    private readonly ignored: string[],
    private readonly apiBase: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly cache?: ResponseCache,
  ) {}

  status(): ProviderStatus {
    const { vendor } = this;
    const configured = this.boards.length
      ? `Configured boards: ${this.boards.map((board) => board.token).join(", ")}.`
      : `No boards configured; set ${vendor.boardsVariable} to a comma-separated list of company board tokens (token or token=Company Name). Nothing is queried until at least one is set.`;
    const ignored = this.ignored.length ? ` Ignored entries: ${this.ignored.join(", ")}.` : "";
    return {
      id: vendor.id,
      label: vendor.label,
      enabled: this.enabledFlag && this.boards.length > 0,
      authentication: "none",
      transport: "http-api",
      coverage: ["general", "ai", "web3"],
      // Each board is downloaded whole; the API has no location or keyword parameter.
      location_filtering: "none",
      // Employer sources are kept off the free search so a gateway can gate them by tool name.
      search_tool: "jobscout_search_employers",
      notes: `Official ${vendor.label} public job-board API (${new URL(this.apiBase).host}), read only for the company boards you list, never for anyone else's. Enable with ${vendor.enableVariable}=true. ${configured}${ignored} Each board is fetched whole and filtered client-side, not scoped by location. The requisition URL comes from the employer's own ATS and is recorded as the canonical employer link. Terms: ${vendor.termsUrl}`,
    };
  }

  async search(query: SearchQuery): Promise<ProviderSearchResult> {
    if (!this.status().enabled) return { jobs: [], records_rejected: 0 };
    const { vendor } = this;

    const settled = await mapWithConcurrency(this.boards, boardConcurrency, async (board) => {
      const { body, warnings } = await fetchTextResource({
        fetcher: this.fetcher,
        url: vendor.boardUrl(this.apiBase, board.token),
        accept: "application/json",
        label: `${vendor.label} board "${board.token}"`,
        configName: vendor.baseVariable,
        maxBytes: atsMaxResponseBytes,
        ...(this.cache ? { cache: this.cache } : {}),
      });
      let payload: unknown;
      try {
        payload = JSON.parse(body) as unknown;
      } catch {
        throw new Error(`${vendor.label} board "${board.token}" returned a response that was not valid JSON.`);
      }
      return { parsed: vendor.parseBoard(payload, board), warnings };
    });

    const records: UnknownRecord[] = [];
    const warnings: string[] = [];
    const failures: string[] = [];
    let rejected = 0;
    for (const [index, result] of settled.entries()) {
      const token = this.boards[index]?.token ?? "unknown";
      if (result.status === "fulfilled") {
        records.push(...result.value.parsed.records);
        rejected += result.value.parsed.rejected;
        warnings.push(...result.value.warnings);
      } else {
        failures.push(`${token}: ${reasonText(result.reason)}`);
      }
    }

    // Every board failing is a provider failure. Some failing is lost coverage, which the
    // caller must hear about or a missing employer reads as "no openings there".
    if (failures.length === this.boards.length) {
      throw new Error(`${vendor.label}: every configured board failed (${failures.join("; ")}).`);
    }
    for (const failure of failures) warnings.push(`${vendor.label} board ${failure}; that employer's openings are missing from these results.`);

    const ranked = rankBoardRecords(vendor.id, records, query.query);
    return {
      jobs: ranked.jobs.slice(0, query.limit),
      records_rejected: rejected + ranked.records_rejected,
      ...(warnings.length ? { warnings } : {}),
    };
  }
}
