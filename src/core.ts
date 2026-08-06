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

/**
 * Every identity a record can be recognised by.
 *
 * Previously a record had exactly one key: the URL key when it had a canonical_url, the text
 * key otherwise. Those two key spaces never met, so the same vacancy from two providers could
 * not merge. That is not hypothetical: Himalayas supplies its listing as job_url, which maps
 * to discovery_url only and never populates canonical_url, while python-jobspy rows carrying
 * job_url_direct always do. The design was inverted, excluding the provider with better data
 * from text matching. Emitting both keys and unioning the buckets is the fix.
 */
function identityKeys(job: Omit<NormalizedJob, "id"> | NormalizedJob): string[] {
  const keys = [textIdentity(job)];
  if (job.canonical_url) keys.unshift(urlIdentity(job.canonical_url));
  return keys;
}

function primaryIdentity(job: Omit<NormalizedJob, "id"> | NormalizedJob): string {
  return job.canonical_url ? urlIdentity(job.canonical_url) : textIdentity(job);
}

/**
 * Whether two records may be merged at all.
 *
 * A shared URL alone is not sufficient. canonical_url comes from provider-controlled fields
 * with only a protocol check, so two records can collide on it while naming different
 * employers. Merging them publishes one listing's text under the other's name, and because the
 * merge keeps the left record's title and company but the longer description, both orderings
 * are wrong.
 *
 * Legitimate variation must still merge: "Example" and "Example Inc." are the same employer
 * spelled differently by two boards, so a prefix relationship counts as agreement.
 */
function companiesAgree(left: { company: string }, right: { company: string }): boolean {
  const a = identityPart(left.company);
  const b = identityPart(right.company);
  if (!a || !b) return true;
  return a === b || a.startsWith(`${b} `) || b.startsWith(`${a} `);
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
  // Clusters are sparse: an entry becomes undefined once it has been absorbed into another.
  const clusters: Array<NormalizedJob | undefined> = [];
  const owner = new Map<string, number>();

  const claim = (keys: string[], index: number): void => {
    for (const key of keys) if (!owner.has(key)) owner.set(key, index);
  };

  for (const candidate of input.map((job) => normalizeJob(job))) {
    const keys = identityKeys(candidate);
    const mergeable = new Set<number>();
    const conflicting = new Set<number>();

    for (const key of keys) {
      const index = owner.get(key);
      if (index === undefined) continue;
      const cluster = clusters[index];
      if (!cluster) continue;
      if (companiesAgree(cluster, candidate)) mergeable.add(index);
      else conflicting.add(index);
    }

    if (mergeable.size === 0) {
      const index = clusters.length;
      const conflicted = conflicting.size > 0;
      clusters.push(conflicted ? { ...candidate, duplicate_conflict: true } : candidate);
      // Flag the records it collided with too: the ambiguity belongs to both sides.
      for (const other of conflicting) {
        const cluster = clusters[other];
        if (cluster) clusters[other] = { ...cluster, duplicate_conflict: true };
      }
      claim(keys, index);
      // A conflicting key is already owned, so also register company-qualified keys. Without
      // this a third record from the same employer could never find this cluster.
      if (conflicted) claim(keys.map((key) => `${key}|${identityPart(candidate.company)}`), index);
      continue;
    }

    const ordered = [...mergeable].sort((left, right) => left - right);
    const primary = ordered[0];
    const existing = primary === undefined ? undefined : clusters[primary];
    if (primary === undefined || !existing) continue;
    const rest = ordered.slice(1);
    let merged = mergeJobs(existing, candidate);
    for (const other of rest) {
      const cluster = clusters[other];
      if (!cluster) continue;
      merged = mergeJobs(merged, cluster);
      clusters[other] = undefined;
    }
    // A record can bridge two clusters that were previously unrelated, so repoint their keys.
    for (const [key, index] of owner) if (rest.includes(index)) owner.set(key, primary);
    clusters[primary] = merged;
    claim([...keys, ...identityKeys(merged)], primary);
  }

  return clusters.filter((job): job is NormalizedJob => job !== undefined);
}
