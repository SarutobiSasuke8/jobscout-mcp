import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import type { NormalizedJob } from "../src/types.js";

/**
 * Shared helpers for the recorded-fixture suites. Tests compile to `dist/test`, so fixtures are
 * read from the source tree two levels up, as the existing ATS suite does.
 */

/** The instant every fixture suite pins the clock to, so `captured_at` is exact. */
export const capturedAt = "2026-10-14T08:00:00.000Z";

export function sourceFixture(name: string): string {
  return readFileSync(new URL(`../../test/fixtures/sources/${name}`, import.meta.url), "utf8");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export interface StubFetch {
  fetcher: typeof fetch;
  requests: RecordedRequest[];
}

export type StubRoute = (request: RecordedRequest) => Response;

/**
 * A fetcher that serves recorded bodies by exact URL and records every request it receives.
 * Anything unrouted answers 404, the way the real sources answer an unknown board or path.
 * Nothing here can reach the network.
 */
export function stubFetch(routes: Record<string, StubRoute | StubRoute[]>): StubFetch {
  const requests: RecordedRequest[] = [];
  const queues = new Map(Object.entries(routes).map(([url, route]) => [url, Array.isArray(route) ? [...route] : route]));
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => { headers[key] = value; });
    const request: RecordedRequest = {
      url,
      method: init?.method ?? "GET",
      headers,
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
    };
    requests.push(request);
    const route = queues.get(url);
    const handler = Array.isArray(route) ? route.shift() : route;
    return handler ? handler(request) : new Response("{\"error\":\"not found\"}", { status: 404 });
  }) as typeof fetch;
  return { fetcher, requests };
}

export function jsonResponse(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status: 200, headers: { "content-type": "application/json", ...headers } });
}

/** Everything but `signals`, which is the classifier's output and has its own suite. */
export function withoutSignals(job: NormalizedJob | undefined): Omit<NormalizedJob, "signals"> | undefined {
  if (!job) return undefined;
  const copy: Partial<NormalizedJob> = { ...job };
  delete copy.signals;
  return copy as Omit<NormalizedJob, "signals">;
}

export function byTitle(jobs: NormalizedJob[], title: string): NormalizedJob | undefined {
  return jobs.find((job) => job.title === title);
}
