import net from "node:net";

/**
 * No test may reach the internet.
 *
 * Every provider takes an injectable fetcher, and the tests pass recorded fixtures through it.
 * A provider built without one falls back to the global `fetch`, and a test that forgets to
 * stub it would quietly scrape a live board in CI: slow, flaky, and against the spirit of the
 * providers' terms. This module closes that gap. It is preloaded for every test file by the
 * `test` script (`node --import`), and imported directly by the fixture suites so they stay
 * guarded when run on their own.
 *
 * Loopback stays open: the HTTP transport tests run a real server on 127.0.0.1.
 */

export const networkGuardMarker = Symbol.for("jobscout.test.networkGuard");

const loopbackHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function isLoopbackHost(host: string | undefined): boolean {
  if (host === undefined || host === "") return true;
  const lower = host.toLocaleLowerCase("en");
  return loopbackHosts.has(lower) || lower.endsWith(".localhost") || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(lower);
}

export class BlockedNetworkError extends Error {
  constructor(target: string) {
    super(`Blocked a real network call to ${target} during tests. Stub the provider's fetcher with a recorded fixture instead.`);
    this.name = "BlockedNetworkError";
  }
}

function requestTarget(input: unknown): URL | undefined {
  try {
    if (input instanceof Request) return new URL(input.url);
    if (input instanceof URL) return input;
    if (typeof input === "string") return new URL(input);
  } catch {
    return undefined;
  }
  return undefined;
}

/** Host and port from the overloaded `socket.connect` arguments, or undefined for IPC paths. */
function socketTarget(args: unknown[]): { host?: string; port?: unknown } | undefined {
  const [first, second] = args;
  // `net.connect` and `tls.connect` pass their already-normalised `[options, callback]` array.
  if (Array.isArray(first)) return socketTarget(first);
  if (first !== null && typeof first === "object") {
    const options = first as { host?: string; port?: unknown; path?: string };
    if (options.path !== undefined) return undefined;
    return { ...(options.host !== undefined ? { host: options.host } : {}), port: options.port };
  }
  if (typeof first === "string" && Number.isNaN(Number(first))) return undefined;
  return { ...(typeof second === "string" ? { host: second } : {}), port: first };
}

const state = globalThis as typeof globalThis & { [networkGuardMarker]?: true };

if (!state[networkGuardMarker]) {
  state[networkGuardMarker] = true;

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const target = requestTarget(input);
    if (!target || !isLoopbackHost(target.hostname)) throw new BlockedNetworkError(target?.host ?? String(input));
    return realFetch(input, init);
  }) as typeof fetch;

  // A second line behind fetch: anything opening a TCP or TLS socket goes through here.
  const realConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(this: net.Socket, ...args: unknown[]) {
    const target = socketTarget(args);
    if (target && !isLoopbackHost(target.host)) throw new BlockedNetworkError(`${target.host}:${String(target.port)}`);
    return (realConnect as (...rest: unknown[]) => net.Socket).apply(this, args);
  } as typeof net.Socket.prototype.connect;
}
