import { VERSION } from "../version.js";

/** Identify the client rather than arriving as an anonymous default agent. */
const userAgent = `jobscout-mcp/${VERSION} (+https://github.com/SarutobiSasuke8/jobscout-mcp)`;

interface CacheEntry {
  body: string;
  /** When this entry stops being served as fresh. */
  expiresAt: number;
  /** When it stops being usable even as a rate-limit fallback. */
  discardAt: number;
}

/**
 * Short-lived store for whole-feed responses.
 *
 * Sources with no keyword search hand over their entire feed on every call, so a conversation
 * running several searches re-downloads identical public data each time. Caching it cuts that
 * to one fetch per TTL window without weakening the local-first stance: the entries hold public
 * listings keyed by URL, never anything about the person searching.
 *
 * Entries stay retrievable past their freshness deadline so a rate-limited or failing source can
 * still serve its last good copy rather than reporting an empty market. That fallback is always
 * accompanied by a warning; see `fetchTextResource`.
 */
export class ResponseCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(
    private readonly ttlMs: number,
    private readonly staleGraceMs: number = 60 * 60 * 1_000,
    private readonly now: () => number = Date.now,
    private readonly maxEntries: number = 32,
  ) {}

  get enabled(): boolean {
    return this.ttlMs > 0;
  }

  /** A live entry, or undefined when absent, expired or caching is off. */
  fresh(key: string): string | undefined {
    if (!this.enabled) return undefined;
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.now() >= entry.expiresAt) return undefined;
    return entry.body;
  }

  /** A past-freshness entry still inside the grace window, for use when a fetch fails. */
  stale(key: string): string | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.now() >= entry.discardAt) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.body;
  }

  set(key: string, body: string): void {
    if (!this.enabled) return;
    const now = this.now();
    // Re-inserting moves the key to the end of Map iteration order, so the eviction below
    // always drops the least recently written entry.
    this.entries.delete(key);
    this.entries.set(key, { body, expiresAt: now + this.ttlMs, discardAt: now + this.ttlMs + this.staleGraceMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }
}

/** Statuses worth serving a stale copy for: the source is up but refusing us right now. */
function isTransient(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

export interface FetchTextResult {
  body: string;
  warnings: string[];
}

/**
 * Fetch a text resource with the size, timeout and scheme guards every HTTP provider needs.
 *
 * On a transient refusal the last cached copy is served instead of failing, because a
 * rate-limited source returning nothing is indistinguishable to a caller from a source with
 * nothing to return. That substitution is never silent: it is reported as a warning so the
 * caller knows the results are older than they look.
 */
export async function fetchTextResource(options: {
  fetcher: typeof fetch;
  url: string;
  accept: string;
  label: string;
  configName: string;
  maxBytes: number;
  timeoutMs?: number;
  cache?: ResponseCache;
}): Promise<FetchTextResult> {
  const { fetcher, url, accept, label, configName, maxBytes, timeoutMs = 30_000, cache } = options;

  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`${configName} must use http or https.`);
  }

  const cached = cache?.fresh(url);
  if (cached !== undefined) return { body: cached, warnings: [] };

  const oversize = (): Error => new Error(`${label} response exceeded the ${Math.round(maxBytes / 1_000_000)} MB safety limit.`);
  const fallback = (reason: string): FetchTextResult | undefined => {
    const stale = cache?.stale(url);
    if (stale === undefined) return undefined;
    return { body: stale, warnings: [`${label}: ${reason}; served the last cached copy, which may be out of date.`] };
  };

  let response: Response;
  try {
    response = await fetcher(parsed, { headers: { accept, "user-agent": userAgent }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "request failed";
    const recovered = fallback(reason);
    if (recovered) return recovered;
    throw error instanceof Error ? error : new Error(`${label} request failed.`);
  }

  if (!response.ok) {
    if (isTransient(response.status)) {
      const recovered = fallback(`HTTP ${response.status}`);
      if (recovered) return recovered;
    }
    throw new Error(`${label} HTTP ${response.status}`);
  }

  if (Number(response.headers.get("content-length") ?? 0) > maxBytes) throw oversize();
  const body = await response.text();
  if (Buffer.byteLength(body, "utf8") > maxBytes) throw oversize();

  cache?.set(url, body);
  return { body, warnings: [] };
}
