import assert from "node:assert/strict";
import test from "node:test";

import { fetchTextResource, ResponseCache } from "../src/providers/http.js";

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

function counter(response: () => Response): { fetcher: typeof fetch; calls: () => number } {
  let calls = 0;
  const fetcher = (async () => {
    calls += 1;
    return response();
  }) as unknown as typeof fetch;
  return { fetcher, calls: () => calls };
}

const base = {
  url: "https://example.test/feed",
  accept: "application/json",
  label: "Example",
  configName: "EXAMPLE_URL",
  maxBytes: 5_000_000,
};

void test("a cached response is reused instead of refetched", async () => {
  const cache = new ResponseCache(60_000);
  const { fetcher, calls } = counter(() => jsonResponse("[1]"));
  const first = await fetchTextResource({ ...base, fetcher, cache });
  const second = await fetchTextResource({ ...base, fetcher, cache });
  assert.equal(first.body, "[1]");
  assert.equal(second.body, "[1]");
  assert.equal(calls(), 1, "the second call must be served from cache");
});

void test("a zero TTL disables caching entirely", async () => {
  const cache = new ResponseCache(0);
  const { fetcher, calls } = counter(() => jsonResponse("[1]"));
  await fetchTextResource({ ...base, fetcher, cache });
  await fetchTextResource({ ...base, fetcher, cache });
  assert.equal(calls(), 2);
});

// A rate-limited source returning nothing is indistinguishable from a source with nothing to
// return, so the last good copy is served instead — but never silently.
void test("serves a stale copy with a warning when the source rate-limits", async () => {
  let clock = 1_000;
  const cache = new ResponseCache(60_000, 60 * 60 * 1_000, () => clock);
  const ok = counter(() => jsonResponse("[\"first\"]"));
  await fetchTextResource({ ...base, fetcher: ok.fetcher, cache });

  clock += 120_000; // past freshness, inside the stale grace window
  const limited = counter(() => jsonResponse("rate limited", 429));
  const result = await fetchTextResource({ ...base, fetcher: limited.fetcher, cache });

  assert.equal(result.body, "[\"first\"]");
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0] ?? "", /served the last cached copy/u);
});

void test("a rate limit with nothing cached is a failure, not an empty result", async () => {
  const cache = new ResponseCache(60_000);
  const { fetcher } = counter(() => jsonResponse("rate limited", 429));
  await assert.rejects(fetchTextResource({ ...base, fetcher, cache }), /HTTP 429/u);
});

void test("a stale copy older than the grace window is discarded rather than served", async () => {
  let clock = 1_000;
  const cache = new ResponseCache(60_000, 30_000, () => clock);
  const ok = counter(() => jsonResponse("[\"first\"]"));
  await fetchTextResource({ ...base, fetcher: ok.fetcher, cache });

  clock += 10_000_000;
  const { fetcher } = counter(() => jsonResponse("rate limited", 429));
  await assert.rejects(fetchTextResource({ ...base, fetcher, cache }), /HTTP 429/u);
});

// Only a transient refusal justifies serving an older copy. A 404 means the resource is wrong
// or gone, and quietly answering from cache would hide a misconfigured URL indefinitely.
void test("a non-transient error is not papered over with a stale copy", async () => {
  let clock = 1_000;
  const cache = new ResponseCache(60_000, 60 * 60 * 1_000, () => clock);
  const ok = counter(() => jsonResponse("[\"first\"]"));
  await fetchTextResource({ ...base, fetcher: ok.fetcher, cache });

  clock += 120_000; // past freshness, so the cache cannot short-circuit the request
  const { fetcher } = counter(() => jsonResponse("gone", 404));
  await assert.rejects(fetchTextResource({ ...base, fetcher, cache }), /HTTP 404/u);
});

void test("rejects a non-HTTP scheme naming the setting to fix", async () => {
  const { fetcher } = counter(() => jsonResponse("[]"));
  await assert.rejects(
    fetchTextResource({ ...base, url: "file:///etc/passwd", fetcher }),
    /EXAMPLE_URL must use http or https/u,
  );
});

void test("rejects an oversized body", async () => {
  const { fetcher } = counter(() => jsonResponse("x".repeat(200)));
  await assert.rejects(fetchTextResource({ ...base, maxBytes: 100, fetcher }), /safety limit/u);
});
