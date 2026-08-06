import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { deduplicateJobs } from "./core.js";
import { classifyJob } from "./taxonomy.js";
import { normalizedJobSchema, searchQuerySchema } from "./types.js";

import type { CallToolResult } from "@modelcontextprotocol/server";
import type { ProviderRegistry } from "./registry.js";

function result(value: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

function failure(error: unknown): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: error instanceof Error ? error.message : "Unknown error" }],
  };
}

export function createJobScoutServer(registry: ProviderRegistry): McpServer {
  const server = new McpServer({ name: "jobscout-mcp", version: "0.2.0" });

  server.registerTool(
    "jobscout_list_sources",
    {
      title: "List JobScout sources",
      description: "Show configured discovery providers, authentication boundaries and enabled state.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    () => result({ sources: registry.statuses() }),
  );

  server.registerTool(
    "jobscout_search_jobs",
    {
      title: "Search jobs",
      description: "Search enabled providers and return one normalized, deduplicated pool with source failures and provenance.",
      inputSchema: searchQuerySchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false },
    },
    async (input) => {
      try {
        return result(await registry.search(searchQuerySchema.parse(input)) as unknown as Record<string, unknown>);
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "jobscout_classify_jobs",
    {
      title: "Classify AI and Web3 job signals",
      description: "Deterministically identify AI, agentic and Web3 domain signals in supplied jobs without contacting a provider.",
      inputSchema: z.object({
        jobs: z.array(z.object({
          title: z.string().trim().min(1).max(300),
          company: z.string().trim().min(1).max(300),
          location: z.string().trim().max(5_000).default("Unknown"),
          description: z.string().trim().max(100_000).optional(),
          tags: z.array(z.string().trim().min(1).max(80)).max(100).default([]),
        })).min(1).max(1_000),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    ({ jobs }) => result({ jobs: jobs.map((job, index) => ({ index, signals: classifyJob(job) })) }),
  );

  server.registerTool(
    "jobscout_deduplicate",
    {
      title: "Deduplicate job records",
      description: "Normalize and merge supplied JobScout records without contacting any provider.",
      inputSchema: z.object({ jobs: z.array(normalizedJobSchema).max(1_000) }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    ({ jobs }) => result({ jobs: deduplicateJobs(jobs), input_count: jobs.length }),
  );

  return server;
}
