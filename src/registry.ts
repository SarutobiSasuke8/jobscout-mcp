import { deduplicateJobs } from "./core.js";
import { HimalayasProvider } from "./providers/himalayas.js";
import { JobSpyProvider } from "./providers/jobspy.js";

import type { JobProvider, ProviderFailure, ProviderStatus, SearchQuery, SearchResult } from "./types.js";

function enabled(value: string | undefined): boolean {
  return value?.toLocaleLowerCase("en") === "true";
}

/** Sites python-jobspy can query. Anything outside this list is dropped rather than forwarded. */
const knownJobSpySites = ["indeed", "linkedin", "glassdoor", "google", "zip_recruiter", "bayt", "naukri"] as const;

/**
 * Which sites JobSpy queries is a disclosure question, not just a configuration one: enabling
 * this provider sends automated requests from the operator's own machine to whichever sites are
 * listed here. The default is deliberately the single least contentious source; adding
 * LinkedIn, Glassdoor or Google is an explicit, documented opt-in. See docs/PROVIDERS.md.
 */
export function resolveJobSpySites(value: string | undefined): string[] {
  const requested = (value ?? "")
    .split(",")
    .map((item) => item.trim().toLocaleLowerCase("en"))
    .filter(Boolean)
    .filter((item): item is (typeof knownJobSpySites)[number] => (knownJobSpySites as readonly string[]).includes(item));
  return requested.length ? [...new Set(requested)] : ["indeed"];
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown provider failure";
  return message.replace(/[\r\n\t]+/gu, " ").slice(0, 500);
}

function isFreshEnough(datePosted: string | undefined, hoursOld: number | undefined, now = Date.now()): boolean {
  if (!datePosted || hoursOld === undefined) return true;
  return now - Date.parse(`${datePosted}T23:59:59.999Z`) <= hoursOld * 60 * 60 * 1_000;
}

export class ProviderRegistry {
  constructor(private readonly providers: JobProvider[]) {}

  statuses(): ProviderStatus[] {
    return this.providers.map((provider) => provider.status());
  }

  async search(query: SearchQuery): Promise<SearchResult> {
    const knownSources = new Set(this.providers.map((provider) => provider.status().id));
    const unknownSources = (query.sources ?? []).filter((source) => !knownSources.has(source));
    const selected = this.providers.filter((provider) => {
      const status = provider.status();
      return status.enabled && (!query.sources || query.sources.includes(status.id));
    });
    const settled = await Promise.allSettled(selected.map(async (provider) => ({
      provider: provider.status().id,
      jobs: await provider.search(query),
    })));
    const failures: ProviderFailure[] = [];
    const jobs = [];
    for (const [index, result] of settled.entries()) {
      const provider = selected[index]?.status().id ?? "unknown";
      if (result.status === "fulfilled") jobs.push(...result.value.jobs);
      else failures.push({ provider, error: errorMessage(result.reason) });
    }
    return {
      jobs: deduplicateJobs(jobs)
        .filter((job) => !query.remote_only || job.remote === true)
        .filter((job) => isFreshEnough(job.date_posted, query.hours_old))
        .slice(0, query.limit),
      failures,
      providers_queried: selected.map((provider) => provider.status().id),
      unknown_sources: unknownSources,
    };
  }
}

export function createProviderRegistry(environment: NodeJS.ProcessEnv = process.env): ProviderRegistry {
  return new ProviderRegistry([
    new HimalayasProvider(
      enabled(environment.JOBSCOUT_ENABLE_HIMALAYAS),
      environment.HIMALAYAS_MCP_URL ?? "https://mcp.himalayas.app/mcp",
    ),
    new JobSpyProvider(
      enabled(environment.JOBSCOUT_ENABLE_JOBSPY),
      environment.JOBSPY_PYTHON ?? "python",
      Math.max(1_000, Math.min(120_000, Number(environment.JOBSPY_TIMEOUT_MS ?? 45_000) || 45_000)),
      resolveJobSpySites(environment.JOBSPY_SITES),
      environment.JOBSPY_COUNTRY?.trim() || undefined,
    ),
  ]);
}
