import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { findJobRecords, mapUnknownJob } from "./helpers.js";

import type { JobProvider, NormalizedJob, ProviderStatus, SearchQuery } from "../types.js";

export class JobSpyProvider implements JobProvider {
  constructor(
    private readonly enabled: boolean,
    private readonly pythonExecutable: string,
    private readonly timeoutMs: number,
  ) {}

  status(): ProviderStatus {
    return {
      id: "jobspy",
      label: "JobSpy",
      enabled: this.enabled,
      authentication: "none",
      notes: "Optional scraper dependency. Availability and site terms vary by source.",
    };
  }

  async search(query: SearchQuery): Promise<NormalizedJob[]> {
    if (!this.enabled) return [];
    const bridgeCandidates = [
      new URL("../../python/jobspy_bridge.py", import.meta.url),
      new URL("../../../python/jobspy_bridge.py", import.meta.url),
    ].map((url) => fileURLToPath(url));
    const bridge = bridgeCandidates.find(existsSync);
    if (!bridge) throw new Error("JobSpy bridge was not found in the source or distribution layout.");
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(this.pythonExecutable, [bridge], { shell: false, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`JobSpy timed out after ${this.timeoutMs}ms.`));
      }, this.timeoutMs);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.on("data", (chunk: string) => { stderr += chunk; });
      child.on("error", (error) => { clearTimeout(timer); reject(error); });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(stdout);
        else reject(new Error(`JobSpy bridge exited ${code ?? "unknown"}: ${stderr.slice(0, 1_000)}`));
      });
      child.stdin.end(JSON.stringify({
        search_term: query.query,
        ...(query.location ? { location: query.location } : {}),
        is_remote: query.remote_only,
        ...(query.hours_old ? { hours_old: query.hours_old } : {}),
        results_wanted: query.limit,
      }));
    });

    const payload = JSON.parse(output) as unknown;
    return findJobRecords(payload)
      .map((item) => mapUnknownJob("jobspy", item))
      .filter((job): job is NormalizedJob => job !== undefined)
      .slice(0, query.limit);
  }
}
