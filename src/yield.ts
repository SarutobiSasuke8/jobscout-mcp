import { deduplicateJobs } from "./core.js";

import type { NormalizedJob } from "./types.js";

/**
 * What one source actually contributed to a blended pool.
 *
 * The question a multi-source engine has to answer eventually is "which of these sources is
 * earning its place". Adding sources is easy and feels like progress; measuring them is the
 * only way to know whether a source is widening coverage or just restating what another source
 * already found. `unique` is the number that answers it: jobs that would disappear from the
 * pool if this source were removed.
 */
export interface SourceYield {
  source: string;
  /** Jobs in the final pool this source contributed to, including ones it shares with others. */
  jobs: number;
  /** Jobs only this source found. What would be lost by dropping it. */
  unique: number;
  /** Jobs at least one other source also found. */
  shared: number;
  /** shared / jobs, rounded to two places. High means this source mostly restates others. */
  overlap_rate: number;
  /** Contributed jobs whose final record carries an employer application route. */
  with_canonical: number;
  /** Contributed jobs carrying no posting date, so freshness cannot be checked. */
  undated: number;
  /** Contributed jobs flagged as a duplicate conflict: one URL, two employer names. */
  conflicts: number;
}

export interface YieldReport {
  /** Jobs in the pool after deduplication. */
  total_jobs: number;
  /** Jobs found by more than one source. The overlap the blended pool collapsed. */
  multi_source_jobs: number;
  /** Jobs found by exactly one source. */
  single_source_jobs: number;
  /** Jobs carrying an employer application route rather than only a discovery link. */
  with_canonical: number;
  /** Jobs carrying no posting date. */
  undated: number;
  /** Jobs flagged as a duplicate conflict and left unmerged for a human to resolve. */
  conflicts: number;
  sources: SourceYield[];
}

function rate(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part / whole) * 100) / 100;
}

/**
 * Measure what each source contributed to a pool.
 *
 * Input is deduplicated first, so the counts describe the pool a caller would actually act on
 * rather than the raw provider output. Deduplication preserves every contributing provider in
 * `provenance`, which is what makes per-source attribution possible after merging.
 *
 * This measures discovery yield only. It cannot know which roles a human found worth pursuing,
 * so a source with low unique yield is not thereby worthless: one source of three good roles
 * beats another source of three hundred restatements. Read it alongside that judgement, not
 * instead of it.
 */
export function summarizeYield(input: NormalizedJob[]): YieldReport {
  const jobs = deduplicateJobs(input);
  const sources = new Map<string, SourceYield>();

  const bucket = (source: string): SourceYield => {
    const existing = sources.get(source);
    if (existing) return existing;
    const created: SourceYield = {
      source,
      jobs: 0,
      unique: 0,
      shared: 0,
      overlap_rate: 0,
      with_canonical: 0,
      undated: 0,
      conflicts: 0,
    };
    sources.set(source, created);
    return created;
  };

  for (const job of jobs) {
    const contributors = new Set(job.provenance.map((entry) => entry.provider));
    for (const source of contributors) {
      const entry = bucket(source);
      entry.jobs += 1;
      if (contributors.size > 1) entry.shared += 1;
      else entry.unique += 1;
      if (job.canonical_url) entry.with_canonical += 1;
      if (!job.date_posted) entry.undated += 1;
      if (job.duplicate_conflict) entry.conflicts += 1;
    }
  }

  const ranked = [...sources.values()]
    .map((entry) => ({ ...entry, overlap_rate: rate(entry.shared, entry.jobs) }))
    .sort((left, right) => right.jobs - left.jobs || left.source.localeCompare(right.source, "en"));

  const multiSource = jobs.filter((job) => new Set(job.provenance.map((entry) => entry.provider)).size > 1).length;

  return {
    total_jobs: jobs.length,
    multi_source_jobs: multiSource,
    single_source_jobs: jobs.length - multiSource,
    with_canonical: jobs.filter((job) => job.canonical_url).length,
    undated: jobs.filter((job) => !job.date_posted).length,
    conflicts: jobs.filter((job) => job.duplicate_conflict).length,
    sources: ranked,
  };
}
