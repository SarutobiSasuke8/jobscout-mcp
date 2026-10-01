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
  return compact(value).toLocaleLowerCase("en").replace(/[^\p{L}\p{N}+#]+/gu, " ").trim();
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

/** Host-normalised URL identity: www and scheme differences are not different jobs. */
function urlIdentity(value: string): string {
  const url = new URL(canonicalizeUrl(value));
  const host = url.host.toLocaleLowerCase("en").replace(/^www\./u, "");
  return `url:${host}${url.pathname}${url.search}`;
}

/**
 * Text identity. Location tokens are sorted so "Remote, Europe" and "Europe - Remote" agree,
 * which providers spell inconsistently for the same vacancy.
 */
function textIdentity(job: Omit<NormalizedJob, "id"> | NormalizedJob): string {
  const location = identityPart(job.location).split(" ").filter(Boolean).sort().join(" ");
  return ["job", identityPart(job.company), identityPart(job.title), location].join(":");
}

function primaryIdentity(job: Omit<NormalizedJob, "id"> | NormalizedJob): string {
  return job.canonical_url ? urlIdentity(job.canonical_url) : textIdentity(job);
}

/** Only known legal suffixes may differ; arbitrary employer-name prefixes are unsafe. */
function companyIdentity(value: string): string {
  const normalized = identityPart(value);
  return normalized.replace(/(?: (?:inc|incorporated|ltd|limited|llc|plc|corp|corporation))+$/u, "");
}

function companiesAgree(left: { company: string }, right: { company: string }): boolean {
  const a = companyIdentity(left.company);
  return Boolean(a) && a === companyIdentity(right.company);
}

export function fingerprint(job: Omit<NormalizedJob, "id"> | NormalizedJob): string {
  return createHash("sha256").update(primaryIdentity(job)).digest("hex");
}

export function normalizeJob(job: Omit<NormalizedJob, "id"> & { id?: string }): NormalizedJob {
  const description = job.description === undefined ? undefined : sanitizeUntrustedText(job.description);
  const normalized = {
    ...job,
    title: compact(job.title),
    company: compact(job.company),
    location: compact(job.location || "Unknown"),
    tags: [...new Set(job.tags.map(compact).filter(Boolean))],
    ...(description ? { description: description.text, description_truncated: description.truncated || job.description_truncated === true } : {}),
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
    description_truncated: (right.description?.length ?? 0) > (left.description?.length ?? 0)
      ? right.description_truncated : left.description_truncated,
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
  interface Cluster { job: NormalizedJob; textKeys: Set<string>; first: number }
  const clusters: Cluster[] = [];
  const textOnly = new Map<string, Cluster>();
  const records = input.map((job) => normalizeJob(job));

  // Resolve direct-URL identities first. A text-only record must never bridge two
  // different requisitions, irrespective of which provider finished first.
  for (const [index, candidate] of records.entries()) {
    const textKey = textIdentity(candidate);
    if (!candidate.canonical_url) {
      const existing = textOnly.get(textKey);
      if (existing) existing.job = mergeJobs(existing.job, candidate);
      else textOnly.set(textKey, {job: candidate, textKeys: new Set([textKey]), first: index});
      continue;
    }
    const urlKey = urlIdentity(candidate.canonical_url);
    const sameUrl = clusters.filter(cluster => urlIdentity(cluster.job.canonical_url!) === urlKey);
    const existing = sameUrl.find(cluster => companiesAgree(cluster.job, candidate));
    if (existing) {
      existing.job = mergeJobs(existing.job, candidate);
      existing.textKeys.add(textKey);
    } else {
      clusters.push({job: candidate, textKeys: new Set([textKey]), first: index});
    }
    if (sameUrl.some(cluster => !companiesAgree(cluster.job, candidate))) {
      for (const cluster of clusters) {
        if (urlIdentity(cluster.job.canonical_url!) === urlKey) cluster.job.duplicate_conflict = true;
      }
    }
  }

  const unmatched: Cluster[] = [];
  for (const [key, candidate] of textOnly) {
    const matches = clusters.filter(cluster => cluster.textKeys.has(key) && companiesAgree(cluster.job, candidate.job));
    const match = matches[0];
    if (matches.length === 1 && match) {
      match.job = mergeJobs(match.job, candidate.job);
      match.first = Math.min(match.first, candidate.first);
    } else {
      if (matches.length > 1) {
        candidate.job.duplicate_conflict = true;
        for (const cluster of matches) cluster.job.duplicate_conflict = true;
      }
      unmatched.push(candidate);
    }
  }

  const result = [...clusters, ...unmatched].sort((a, b) => a.first - b.first).map(cluster => cluster.job);
  // Conflicting employers can share a source-supplied URL. Keep both records
  // addressable instead of returning duplicate ids under different names.
  const counts = new Map<string, number>();
  for (const job of result) counts.set(job.id, (counts.get(job.id) ?? 0) + 1);
  return result.map(job => (counts.get(job.id) ?? 0) > 1
    ? {...job, id: createHash("sha256").update(`${job.id}|${companyIdentity(job.company)}`).digest("hex")}
    : job);
}
