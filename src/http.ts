import { timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";

import type { ReadableStream as NodeWebStream } from "node:stream/web";

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";

import { createProviderRegistry } from "./registry.js";
import { createJobScoutServer } from "./server.js";
import { VERSION } from "./version.js";

import type { IncomingMessage, ServerResponse } from "node:http";
import type { ProviderRegistry } from "./registry.js";

/**
 * Streamable HTTP entrypoint for hosted deployments.
 *
 * The server is stateless: every POST builds a fresh MCP server and transport, answers with a
 * plain JSON response and closes both. JobScout holds no profile or session, so there is nothing
 * to resume, and stateless mode lets any number of replicas serve any request.
 *
 * Authentication is not implemented here. A public directory listing needs OAuth with a
 * registered client, which requires a live domain and is documented as a gap in
 * docs/DEPLOYMENT.md. The optional bearer token below only protects a private deployment.
 */

export const MCP_PATH = "/mcp";
export const HEALTH_PATH = "/health";
export const MAX_BODY_BYTES = 1024 * 1024;

export interface HttpHandlerOptions {
  /** Builds the provider registry for each request. Defaults to the environment-driven registry. */
  registryFactory?: () => ProviderRegistry;
  /** When set, MCP requests must carry `Authorization: Bearer <token>`. /health stays open. */
  bearerToken?: string | undefined;
}

/** Environment for hosted mode. JobSpy scrapes from the host's own address, so it is never enabled remotely. */
export function hostedEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...environment, JOBSCOUT_ENABLE_JOBSPY: "false" };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

function tokenMatches(header: string | null, expected: string): boolean {
  const match = /^Bearer (.+)$/u.exec(header ?? "");
  if (!match?.[1]) return false;
  const given = Buffer.from(match[1]);
  const wanted = Buffer.from(expected);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

/** Web-standard request handler. Kept separate from Node plumbing so tests can call it directly. */
export function createFetchHandler(options: HttpHandlerOptions = {}): (request: Request) => Promise<Response> {
  const registryFactory = options.registryFactory ?? (() => createProviderRegistry(hostedEnvironment()));
  return async (request) => {
    const { pathname } = new URL(request.url);

    if (pathname === HEALTH_PATH) {
      if (request.method !== "GET" && request.method !== "HEAD") return json(405, { error: "method_not_allowed" }, { allow: "GET, HEAD" });
      return json(200, { status: "ok", name: "jobscout-mcp", version: VERSION, transport: "streamable-http" });
    }

    if (pathname !== MCP_PATH) return json(404, { error: "not_found" });

    if (options.bearerToken && !tokenMatches(request.headers.get("authorization"), options.bearerToken)) {
      return json(401, { error: "unauthorized" }, { "www-authenticate": 'Bearer realm="jobscout-mcp"' });
    }

    // Stateless mode has no server-initiated stream and no session to delete.
    if (request.method !== "POST") return json(405, { error: "method_not_allowed" }, { allow: "POST" });

    const server = createJobScoutServer(registryFactory());
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true, maxRequestBodySize: MAX_BODY_BYTES });
    try {
      await server.connect(transport);
      return await transport.handleRequest(request);
    } catch {
      return json(500, { error: "internal_error" });
    } finally {
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  };
}

function toWebRequest(incoming: IncomingMessage): Request {
  const host = incoming.headers.host ?? "localhost";
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  const method = incoming.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  const init: RequestInit & { duplex?: "half" } = { method, headers };
  if (hasBody) {
    init.body = Readable.toWeb(incoming) as unknown as ReadableStream;
    init.duplex = "half";
  }
  return new Request(new URL(incoming.url ?? "/", `http://${host}`), init);
}

/** Node `http` listener wrapping the fetch handler. */
export function createNodeListener(options: HttpHandlerOptions = {}): (incoming: IncomingMessage, outgoing: ServerResponse) => void {
  const handle = createFetchHandler(options);
  return (incoming, outgoing) => {
    void (async () => {
      let response: Response;
      try {
        response = await handle(toWebRequest(incoming));
      } catch {
        response = json(400, { error: "bad_request" });
      }
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      if (!response.body || incoming.method === "HEAD") {
        outgoing.end();
        return;
      }
      Readable.fromWeb(response.body as unknown as NodeWebStream).pipe(outgoing);
    })();
  };
}
