import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { deduplicateJobs } from "./core.js";
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
  const server = new McpServer({ name: "jobscout-mcp", version: "0.1.0" });

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
