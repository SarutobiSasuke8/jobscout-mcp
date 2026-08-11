import { normalizeJob } from "../core.js";

import type { NormalizedJob, ProviderSearchResult } from "../types.js";

export type UnknownRecord = Record<string, unknown>;

export function record(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : undefined;
}

export function textValue(source: UnknownRecord, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export function numberValue(source: UnknownRecord, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return undefined;
}

export function booleanValue(source: UnknownRecord, keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

/**
 * Collect short string entries from list-shaped fields. Providers expose these as tags,
 * categories or department names; they are the classifier's highest-precision input because
 * a board tag is a deliberate label, not incidental prose. A comma-separated string is
 * accepted too, since some sources flatten their lists.
 */
export function stringArrayValue(source: UnknownRecord, keys: string[]): string[] {
  const collected: string[] = [];
  for (const key of keys) {
    const value = source[key];
    const items = Array.isArray(value)
      ? value
      : typeof value === "string" && value.includes(",") ? value.split(",") : [];
    for (const item of items) {
      if (typeof item === "string" && item.trim() && item.trim().length <= 80) collected.push(item.trim());
    }
  }
  return [...new Set(collected)].slice(0, 100);
}

function httpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function mapUnknownJob(provider: string, source: UnknownRecord): NormalizedJob | undefined {
  const title = textValue(source, ["title", "job_title", "name"]);
  const company = textValue(source, ["company", "company_name", "organization"]);
  if (!title || !company) return undefined;

  const discoveryUrl = httpUrl(textValue(source, ["url", "job_url", "listing_url"]));
  const canonicalUrl = httpUrl(textValue(source, ["canonical_url", "apply_url", "job_url_direct"]));
  const sourceJobId = textValue(source, ["id", "job_id", "source_job_id"]);
  const datePosted = textValue(source, ["date_posted", "posted_at", "published_at"]);
  const salaryMin = numberValue(source, ["min_amount", "salary_min", "min_salary"]);
  const salaryMax = numberValue(source, ["max_amount", "salary_max", "max_salary"]);
  const salaryCurrency = textValue(source, ["currency", "salary_currency"]);
  const salaryInterval = textValue(source, ["interval", "salary_interval"]);
  const parsedDate = datePosted?.match(/^\d{4}-\d{2}-\d{2}/u)?.[0];
  const interval = salaryInterval && ["hour", "day", "week", "month", "year", "unknown"].includes(salaryInterval)
    ? salaryInterval as "hour" | "day" | "week" | "month" | "year" | "unknown"
    : undefined;

  try {
    return normalizeJob({
    title,
    company,
    location: textValue(source, ["location", "job_location", "city"]) ?? "Unknown",
    ...(booleanValue(source, ["remote", "is_remote"]) === undefined ? {} : { remote: booleanValue(source, ["remote", "is_remote"]) }),
    ...(textValue(source, ["description", "job_description", "details"]) ? { description: textValue(source, ["description", "job_description", "details"]) } : {}),
    ...(textValue(source, ["employment_type", "job_type"]) ? { employment_type: textValue(source, ["employment_type", "job_type"]) } : {}),
    ...(parsedDate ? { date_posted: parsedDate } : {}),
    ...(canonicalUrl ? { canonical_url: canonicalUrl } : {}),
    ...(salaryMin !== undefined || salaryMax !== undefined || salaryCurrency || interval ? {
      salary: {
        ...(salaryMin !== undefined ? { min: salaryMin } : {}),
        ...(salaryMax !== undefined ? { max: salaryMax } : {}),
        ...(salaryCurrency ? { currency: salaryCurrency } : {}),
        ...(interval ? { interval } : {}),
      },
    } : {}),
    tags: stringArrayValue(source, ["tags", "keywords", "categories", "skills", "departments"]),
    provenance: [{
      provider,
      ...(discoveryUrl ? { discovery_url: discoveryUrl } : {}),
      ...(sourceJobId ? { source_job_id: sourceJobId } : {}),
      captured_at: new Date().toISOString(),
    }],
    });
  } catch {
    return undefined;
  }
}

/**
 * Map raw source records into normalized jobs, counting what validation drops instead of
 * silently discarding it. Every provider ends its search with this exact step, so the count
 * lives here rather than being re-implemented (or forgotten) per provider.
 */
export function mapJobRecords(provider: string, records: UnknownRecord[], limit: number): ProviderSearchResult {
  const jobs = records
    .map((item) => mapUnknownJob(provider, item))
    .filter((job): job is NormalizedJob => job !== undefined);
  return { jobs: jobs.slice(0, limit), records_rejected: records.length - jobs.length };
}

export function findJobRecords(value: unknown): UnknownRecord[] {
  if (Array.isArray(value)) {
    const direct = value.map(record).filter((item): item is UnknownRecord => item !== undefined);
    if (direct.some((item) => textValue(item, ["title", "job_title"]))) return direct;
    return value.flatMap(findJobRecords);
  }
  const candidate = record(value);
  if (!candidate) return [];
  for (const key of ["jobs", "results", "data", "items"]) {
    if (candidate[key] !== undefined) {
      const found = findJobRecords(candidate[key]);
      if (found.length) return found;
    }
  }
  return [];
}
