import assert from "node:assert/strict";
import { createServer } from "node:http";
import net from "node:net";
import test from "node:test";
import tls from "node:tls";

import { RemoteOkProvider } from "../src/providers/remoteok.js";
import { searchQuery } from "./support.js";

import type { AddressInfo } from "node:net";

// These tests prove the no-network guard (test/network-guard.ts) is active. This file does not
// import the guard itself: it relies on the `test` script preloading it with `node --import`,
// so a passing run here shows every test file in the suite ran guarded.

const blocked = /Blocked a real network call/u;

void test("the network guard is preloaded for every test file", () => {
  assert.equal((globalThis as Record<symbol, unknown>)[Symbol.for("jobscout.test.networkGuard")], true, "run the suite with `npm test`, which preloads dist/test/network-guard.js");
});

void test("a real fetch fails the test instead of reaching the internet", async () => {
  await assert.rejects(fetch("https://example.com/"), blocked);
  await assert.rejects(fetch(new URL("https://remoteok.com/api")), blocked);
  await assert.rejects(fetch(new Request("https://boards-api.greenhouse.io/v1/boards/x/jobs")), blocked);
});

void test("a provider built without a stubbed fetcher cannot scrape the live source", async () => {
  // The default fetcher is the global fetch: a test that forgets to stub it fails here.
  const provider = new RemoteOkProvider(true, "https://remoteok.com/api");
  await assert.rejects(provider.search(searchQuery({ query: "engineer" })), blocked);
});

void test("raw TCP and TLS sockets to remote hosts are refused too", () => {
  assert.throws(() => net.connect({ host: "example.com", port: 80 }), blocked);
  assert.throws(() => net.connect(443, "example.com"), blocked);
  assert.throws(() => tls.connect({ host: "example.com", port: 443, servername: "example.com" }), blocked);
});

void test("loopback stays open for the HTTP transport tests", async (t) => {
  const server = createServer((_request, response) => response.end("ok"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { port } = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(await response.text(), "ok");
});
