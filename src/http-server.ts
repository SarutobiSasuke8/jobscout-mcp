#!/usr/bin/env node
import { createServer } from "node:http";

import { createNodeListener } from "./http.js";

const port = Number(process.env.PORT ?? 8080);
// Loopback by default. Container deployments set HOST=0.0.0.0 explicitly (the Dockerfile does).
const host = process.env.HOST ?? "127.0.0.1";
const bearerToken = process.env.JOBSCOUT_HTTP_BEARER_TOKEN?.trim() || undefined;

const server = createServer(createNodeListener({ bearerToken }));
server.requestTimeout = 60_000;
server.headersTimeout = 15_000;

server.listen(port, host, () => {
  console.error(`jobscout-mcp streamable HTTP listening on http://${host}:${port}/mcp (health: /health)`);
});

function shutdown(): void {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
