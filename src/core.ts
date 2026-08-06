import { createHash } from "node:crypto";

import { DESCRIPTION_LIMIT, normalizedJobSchema } from "./types.js";
import { classifyJob } from "./taxonomy.js";

import type { NormalizedJob } from "./types.js";

function compact(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

/**
 * Characters removed from untrusted free text before it reaches a model's context.
 *
 * Expressed as code point ranges rather than a regex literal so the set is reviewable without
 * decoding escapes, and so no control character is ever embedded in this source file.
 *
 * - C0/C1 controls, keeping tab (9) and newline (10), which carry real formatting.
 * - U+200B..U+200F zero-width spaces and LTR/RTL marks.
 * - U+202A..U+202E and U+2066..U+2069 bidirectional overrides and isolates.
 * - U+FEFF zero-width no-break space / byte order mark.
 *
 * The last three groups are the ones that matter for injection: they let text hide from, or
 * visually reorder itself for, a human reviewing the same listing a model is reading.
 */
function isStrippedCharacter(codePoint: number): boolean {
  if (codePoint === 9 || codePoint === 10) return false;
  return codePoint < 32
    || (codePoint >= 0x7f && codePoint <= 0x9f)
    || (codePoint >= 0x200b && codePoint <= 0x200f)
    || (codePoint >= 0x202a && codePoint <= 0x202e)
    || (codePoint >= 0x2066 && codePoint <= 0x2069)
    || codePoint === 0xfeff;
}

/**
 * Job descriptions are attacker-controlled text. Unlike the identity fields they keep their
 * line structure, so they are cleaned rather than compacted. This does not stop a downstream
 * model acting on instructions embedded in the prose; nothing at this layer can. It removes
 * the tricks that make such instructions invisible, and bounds the volume.
 */
function sanitizeUntrustedText(value: string): { text: string; truncated: boolean } {
  const cleaned = [...value.normalize("NFKC")]
    .filter((character) => !isStrippedCharacter(character.codePointAt(0) ?? 0))
    .join("")
    .replace(/[ \t]+/gu, " ")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  return cleaned.length > DESCRIPTION_LIMIT
    ? { text: `${cleaned.slice(0, DESCRIPTION_LIMIT).trimEnd()}...`, truncated: true }
    : { text: cleaned, truncated: false };
}

function identityPart(value: string): string {
  return compact(value).toLocaleLowerCase("en").replace(/[^a-z0-9]+/gu, " ").trim();
}

const trackingParameters = new Set(["fbclid", "gclid", "ref", "referrer", "source", "utm_campaign", "utm_content", "utm_medium", "utm_source", "utm_term"]);

export function canonicalizeUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (trackingParameters.has(key.toLocaleLowerCase("en"))) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/u, "");
  return url.toString();
}

function canonicalKey(job: Omit<NormalizedJob, "id"> | NormalizedJob): string {
  if (job.canonical_url) return `url:${canonicalizeUrl(job.canonical_url)}`;
  return ["job", identityPart(job.company), identityPart(job.title), identityPart(job.location)].join(":");
}

export function fingerprint(job: Omit<NormalizedJob, "id"> | NormalizedJob): string {
  return createHash("sha256").update(canonicalKey(job)).digest("hex");
}

export function normalizeJob(job: Omit<NormalizedJob, "id"> & { id?: string }): NormalizedJob {
  const description = job.description === undefined ? undefined : sanitizeUntrustedText(job.description);
  const normalized = {
    ...job,
    title: compact(job.title),
    company: compact(job.company),
    location: compact(job.location || "Unknown"),
    tags: [...new Set(job.tags.map(compact).filter(Boolean))],
    ...(description ? { description: description.text, description_truncated: description.truncated } : {}),
    ...(job.canonical_url ? { canonical_url: canonicalizeUrl(job.canonical_url) } : {}),
  };
  return normalizedJobSchema.parse({
    ...normalized,
    id: fingerprint(normalized),
    signals: classifyJob(normalized),
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
