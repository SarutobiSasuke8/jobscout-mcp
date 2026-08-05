import { deduplicateJobs } from "./core.js";
import { HimalayasProvider } from "./providers/himalayas.js";
import { JobSpyProvider } from "./providers/jobspy.js";

import type { JobProvider, ProviderFailure, ProviderStatus, SearchQuery, SearchResult } from "./types.js";

function enabled(value: string | undefined): boolean {
  return value?.toLocaleLowerCase("en") === "true";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown provider failure";
}

export class ProviderRegistry {
  constructor(private readonly providers: JobProvider[]) {}

  statuses(): ProviderStatus[] {
    return this.providers.map((provider) => provider.status());
  }

  async search(query: SearchQuery): Promise<SearchResult> {
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
      jobs: deduplicateJobs(jobs).slice(0, query.limit),
      failures,
      providers_queried: selected.map((provider) => provider.status().id),
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
      Number(environment.JOBSPY_TIMEOUT_MS ?? 45_000),
    ),
  ]);
}
