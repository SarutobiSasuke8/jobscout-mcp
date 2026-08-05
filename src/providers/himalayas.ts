import { findJobRecords, mapUnknownJob, record } from "./helpers.js";

import type { JobProvider, NormalizedJob, ProviderStatus, SearchQuery } from "../types.js";

interface RpcResponse {
  result?: unknown;
  error?: { message?: string };
}

function parseRpcResponse(body: string, contentType: string): RpcResponse {
  if (contentType.includes("text/event-stream")) {
    const data = body.split(/\r?\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .find((line) => line && line !== "[DONE]");
    if (!data) throw new Error("Himalayas MCP returned an empty event stream.");
    return JSON.parse(data) as RpcResponse;
  }
  return JSON.parse(body) as RpcResponse;
}

export function parseHimalayasMarkdown(markdown: string): NormalizedJob[] {
  return markdown.split(/\n\s*---\s*\n/gu).map((block) => {
    const title = block.match(/🚀\s+\*\*(.+?)\*\*/u)?.[1]?.trim();
    const company = block.match(/🏢\s+(.+?)(?:\s+✅)?\s*$/mu)?.[1]?.trim();
    const discoveryUrl = block.match(/Apply on Himalayas:\*\*\s+(https?:\/\/\S+)/u)?.[1];
    if (!title || !company || !discoveryUrl) return undefined;
    const workLine = block.split(/\r?\n/u).find((line) => (line.includes("Full-time") || line.includes("Part-time") || line.includes("Contractor")) && line.includes("•"));
    const location = workLine?.split("•").slice(1).join("•").trim().replace(/^🌍\s*/u, "") || "Unknown";
    const salaryLine = block.split(/\r?\n/u).find((line) => line.startsWith("💵"));
    const salaryMatch = salaryLine?.match(/\$([\d,]+)\s*-\s*\$([\d,]+)\s+([A-Z]{3})/u);
    const jobUrl = new URL(discoveryUrl);
    jobUrl.search = "";
    return mapUnknownJob("himalayas", {
      title,
      company,
      location,
      is_remote: /remote/iu.test(location),
      job_url: jobUrl.toString(),
      ...(salaryMatch ? {
        salary_min: Number(salaryMatch[1]?.replace(/,/gu, "")),
        salary_max: Number(salaryMatch[2]?.replace(/,/gu, "")),
        salary_currency: salaryMatch[3],
      } : {}),
    });
  }).filter((job): job is NormalizedJob => job !== undefined);
}

export class HimalayasProvider implements JobProvider {
  constructor(
    private readonly enabled: boolean,
    private readonly endpoint: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  status(): ProviderStatus {
    return {
      id: "himalayas",
      label: "Himalayas MCP",
      enabled: this.enabled,
      authentication: "optional",
      notes: "Public search only. Canonical employer links may require separate verification.",
    };
  }

  private async rpc(payload: Record<string, unknown>, sessionId?: string): Promise<{ response: RpcResponse; sessionId?: string }> {
    const response = await this.fetcher(this.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Himalayas MCP HTTP ${response.status}`);
    const parsed = parseRpcResponse(await response.text(), response.headers.get("content-type") ?? "application/json");
    if (parsed.error) throw new Error(parsed.error.message ?? "Himalayas MCP request failed.");
    const returnedSession = response.headers.get("mcp-session-id") ?? sessionId;
    return { response: parsed, ...(returnedSession ? { sessionId: returnedSession } : {}) };
  }

  async search(query: SearchQuery): Promise<NormalizedJob[]> {
    if (!this.enabled) return [];
    const initialized = await this.rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "jobscout-mcp", version: "0.1.0" },
      },
    });

    const called = await this.rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "search_jobs",
        arguments: {
          keyword: query.query,
          ...(
            query.location && !["remote", "europe", "worldwide"].includes(query.location.toLocaleLowerCase("en"))
              ? { country: query.location }
              : {}
          ),
          ...(!query.location && query.remote_only ? { worldwide: true } : {}),
        },
      },
    }, initialized.sessionId);

    const resultRecord = record(called.response.result);
    let payload: unknown = resultRecord?.structuredContent ?? called.response.result;
    const content = Array.isArray(resultRecord?.content) ? resultRecord.content : [];
    const textBlock = content.map(record).find((item) => item?.type === "text" && typeof item.text === "string");
    if (!findJobRecords(payload).length && typeof textBlock?.text === "string") {
      try { payload = JSON.parse(textBlock.text) as unknown; }
      catch { return parseHimalayasMarkdown(textBlock.text).slice(0, query.limit); }
    }
    return findJobRecords(payload)
      .map((item) => mapUnknownJob("himalayas", item))
      .filter((job): job is NormalizedJob => job !== undefined)
      .slice(0, query.limit);
  }
}
