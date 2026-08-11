import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { findJobRecords, mapJobRecords } from "./helpers.js";

import type { JobProvider, ProviderSearchResult, ProviderStatus, SearchQuery } from "../types.js";

export class JobSpyProvider implements JobProvider {
  constructor(
    private readonly enabled: boolean,
    private readonly pythonExecutable: string,
    private readonly timeoutMs: number,
    private readonly sites: string[] = ["indeed"],
    private readonly country?: string,
  ) {}

  status(): ProviderStatus {
    // The resolved site list is disclosed here rather than left implicit. A caller cannot
    // reason about the terms it is accepting, or the traffic it is generating, without being
    // told which sites this provider actually contacts.
    return {
      id: "jobspy",
      label: "JobSpy",
      enabled: this.enabled,
      authentication: "none",
      transport: "subprocess",
      coverage: ["general", "ai", "web3"],
      optional_dependency: "python-jobspy",
      notes: `Optional scraper dependency. When enabled, sends automated requests from this machine to: ${this.sites.join(", ")}. Configure with JOBSPY_SITES. Indeed results are country-scoped via JOBSPY_COUNTRY (currently ${this.country ?? "the python-jobspy default"}). You are responsible for each site's terms of use.`,
    };
  }

  async search(query: SearchQuery): Promise<ProviderSearchResult> {
    if (!this.enabled) return { jobs: [], records_rejected: 0 };
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
      let settled = false;
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill();
        reject(error);
      };
      const timer = setTimeout(() => {
        fail(new Error(`JobSpy timed out after ${this.timeoutMs}ms.`));
      }, this.timeoutMs);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (Buffer.byteLength(stdout, "utf8") > 10_000_000) fail(new Error("JobSpy output exceeded the 10 MB safety limit."));
      });
      child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-4_000); });
      child.on("error", fail);
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 0) resolve(stdout);
        else reject(new Error(`JobSpy bridge exited ${code ?? "unknown"}: ${stderr.slice(0, 1_000)}`));
      });
      child.stdin.end(JSON.stringify({
        search_term: query.query,
        site_name: this.sites,
        ...(this.country ? { country_indeed: this.country } : {}),
        ...(query.location ? { location: query.location } : {}),
        is_remote: query.remote_only,
        ...(query.hours_old ? { hours_old: query.hours_old } : {}),
        results_wanted: query.limit,
      }));
    });

    const payload = JSON.parse(output) as unknown;
    return mapJobRecords("jobspy", findJobRecords(payload), query.limit);
  }
}
