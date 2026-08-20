import { deduplicateJobs } from "./core.js";
import { HimalayasProvider } from "./providers/himalayas.js";
import { LennysJobsProvider, defaultEndpoint, defaultPartnerId, defaultSiteUrl } from "./providers/lennysjobs.js";
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
    const statuses = this.providers.map((provider) => provider.status());
    const knownSources = new Set(statuses.map((status) => status.id));
    const unknownSources = (query.sources ?? []).filter((source) => !knownSources.has(source));
    const providersDisabled = statuses.filter((status) => !status.enabled).map((status) => status.id);
    const selected = this.providers.filter((provider) => {
      const status = provider.status();
      return status.enabled && (!query.sources || query.sources.includes(status.id));
    });
    const settled = await Promise.allSettled(selected.map(async (provider) => ({
      provider: provider.status().id,
      result: await provider.search(query),
    })));
    const failures: ProviderFailure[] = [];
    const jobs = [];
    let recordsRejected = 0;
    for (const [index, result] of settled.entries()) {
      const provider = selected[index]?.status().id ?? "unknown";
      if (result.status === "fulfilled") {
        jobs.push(...result.value.result.jobs);
        recordsRejected += result.value.result.records_rejected;
      } else failures.push({ provider, error: errorMessage(result.reason) });
    }
    const finalJobs = deduplicateJobs(jobs)
      .filter((job) => !query.remote_only || job.remote === true)
      .filter((job) => isFreshEnough(job.date_posted, query.hours_old))
      .slice(0, query.limit);
    // A search against zero enabled providers must say so. Without the flag, a fresh install
    // returns an empty success and the calling agent tells its user "no jobs matched" — false,
    // because nothing was searched. This was the first thing a first-run test tripped over.
    const setupRequired = selected.length === 0;
    return {
      jobs: finalJobs,
      failures,
      providers_queried: selected.map((provider) => provider.status().id),
      unknown_sources: unknownSources,
      providers_disabled: providersDisabled,
      records_rejected: recordsRejected,
      undated_records: finalJobs.filter((job) => !job.date_posted).length,
      ...(setupRequired ? {
        setup_required: true,
        message: providersDisabled.length
          ? `No providers are enabled, so nothing was searched. Available providers: ${providersDisabled.join(", ")}. Enable at least one (for example JOBSCOUT_ENABLE_HIMALAYAS=true) and retry; jobscout_list_sources explains what each provider contacts.`
          : "No providers matched this request, so nothing was searched. Call jobscout_list_sources to see what is configured.",
      } : {}),
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
    new LennysJobsProvider(
      enabled(environment.JOBSCOUT_ENABLE_LENNYSJOBS),
      environment.LENNYSJOBS_ENDPOINT?.trim() || defaultEndpoint,
      environment.LENNYSJOBS_PARTNER_ID?.trim() || defaultPartnerId,
      environment.LENNYSJOBS_SITE_URL?.trim() || defaultSiteUrl,
      Math.max(1_000, Math.min(60_000, Number(environment.LENNYSJOBS_TIMEOUT_MS ?? 20_000) || 20_000)),
    ),
  ]);
}
