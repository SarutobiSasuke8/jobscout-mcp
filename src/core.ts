import { createHash } from "node:crypto";

import { normalizedJobSchema } from "./types.js";

import type { NormalizedJob } from "./types.js";

function compact(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

function identityPart(value: string): string {
  return compact(value).toLocaleLowerCase("en").replace(/[^a-z0-9]+/gu, " ").trim();
}

function canonicalKey(job: Omit<NormalizedJob, "id"> | NormalizedJob): string {
  if (job.canonical_url) return `url:${job.canonical_url.replace(/\/$/u, "")}`;
  return ["job", identityPart(job.company), identityPart(job.title), identityPart(job.location)].join(":");
}

export function fingerprint(job: Omit<NormalizedJob, "id"> | NormalizedJob): string {
  return createHash("sha256").update(canonicalKey(job)).digest("hex");
}

export function normalizeJob(job: Omit<NormalizedJob, "id"> & { id?: string }): NormalizedJob {
  return normalizedJobSchema.parse({
    ...job,
    id: job.id ?? fingerprint(job),
    title: compact(job.title),
    company: compact(job.company),
    location: compact(job.location || "Unknown"),
    tags: [...new Set(job.tags.map(compact).filter(Boolean))],
  });
}

function chooseText(left?: string, right?: string): string | undefined {
  if (!left) return right;
  if (!right) return left;
  return right.length > left.length ? right : left;
}

function mergeJobs(left: NormalizedJob, right: NormalizedJob): NormalizedJob {
  const provenance = new Map<string, NormalizedJob["provenance"][number]>();
  for (const item of [...left.provenance, ...right.provenance]) {
    provenance.set(`${item.provider}|${item.discovery_url ?? ""}|${item.source_job_id ?? ""}`, item);
  }

  const merged = {
    ...left,
    id: fingerprint(left),
    description: chooseText(left.description, right.description),
    canonical_url: left.canonical_url ?? right.canonical_url,
    date_posted: left.date_posted ?? right.date_posted,
    employment_type: left.employment_type ?? right.employment_type,
    remote: left.remote ?? right.remote,
    salary: left.salary ?? right.salary,
    tags: [...new Set([...left.tags, ...right.tags])],
    provenance: [...provenance.values()],
  };
  return normalizeJob(merged);
}

export function deduplicateJobs(input: NormalizedJob[]): NormalizedJob[] {
  const jobs = new Map<string, NormalizedJob>();
  for (const candidate of input.map((job) => normalizeJob(job))) {
    const key = canonicalKey(candidate);
    const existing = jobs.get(key);
    jobs.set(key, existing ? mergeJobs(existing, candidate) : candidate);
  }
  return [...jobs.values()];
}
