import type { NormalizedJob } from "./types.js";

/**
 * Briefing-ready projection of a normalized job.
 *
 * Exists because every consumer (morning briefs, research agents) was re-normalizing records
 * into its own shape, and one of them dropped job URLs entirely because the payload shape was
 * not standardized (jobscout-mcp#3). Defining the shape once, at the source, removes that
 * class of consumer bug.
 *
 * This is a pure projection: it must never introduce a claim that is not in the record.
 */
export interface BriefingEntry {
  title: string;
  company: string;
  location: string;
  remote?: boolean;
  salary?: NormalizedJob["salary"];
  /** Best link for a reader: the employer application route when known, else where the job was discovered. */
  url: string | null;
  /** Which kind of link `url` is. Consumers wanting only verified employer routes filter on "canonical". */
  url_kind: "canonical" | "discovery" | "none";
  /** One compact line a consumer can drop straight into a briefing. */
  one_line: string;
}

const currencySymbols: Record<string, string> = { USD: "$", GBP: "£", EUR: "€" };

function compactAmount(amount: number): string {
  if (amount >= 1_000 && amount % 100 === 0) {
    const thousands = amount / 1_000;
    return Number.isInteger(thousands) ? `${thousands}K` : `${thousands.toFixed(1)}K`;
  }
  return String(amount);
}

function salaryText(salary: NormalizedJob["salary"]): string | undefined {
  if (!salary || (salary.min === undefined && salary.max === undefined)) return undefined;
  const symbol = salary.currency ? currencySymbols[salary.currency] ?? `${salary.currency} ` : "";
  const parts = [salary.min, salary.max]
    .filter((value): value is number => value !== undefined)
    .map((value) => `${symbol}${compactAmount(value)}`);
  const range = [...new Set(parts)].join("-");
  return salary.interval && salary.interval !== "unknown" && salary.interval !== "year" ? `${range}/${salary.interval}` : range;
}

export function toBriefingEntry(job: NormalizedJob): BriefingEntry {
  const discoveryUrl = job.provenance.find((item) => item.discovery_url)?.discovery_url;
  const url = job.canonical_url ?? discoveryUrl ?? null;
  const salary = salaryText(job.salary);
  const pieces = [
    `${job.title} at ${job.company}`,
    ...(job.location && job.location !== "Unknown" ? [job.location] : []),
    ...(salary ? [salary] : []),
    ...(job.remote === true ? ["remote"] : []),
  ];
  return {
    title: job.title,
    company: job.company,
    location: job.location,
    ...(job.remote === undefined ? {} : { remote: job.remote }),
    ...(job.salary ? { salary: job.salary } : {}),
    url,
    url_kind: job.canonical_url ? "canonical" : discoveryUrl ? "discovery" : "none",
    one_line: pieces.join(", "),
  };
}
