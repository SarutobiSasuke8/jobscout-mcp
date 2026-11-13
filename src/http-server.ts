#!/usr/bin/env node
import { createServer } from "node:http";

import { createNodeListener } from "./http.js";
import { initialiseOAuth, oauthConfigFromEnv } from "./oauth.js";

import type { OAuthGuard } from "./oauth.js";

const port = Number(process.env.PORT ?? 8080);
// Loopback by default. Container deployments set HOST=0.0.0.0 explicitly (the Dockerfile does).
const host = process.env.HOST ?? "127.0.0.1";
const bearerToken = process.env.JOBSCOUT_HTTP_BEARER_TOKEN?.trim() || undefined;

async function main(): Promise<void> {
  // Fail closed: a half-configured or unreachable issuer stops the server rather than leaving /mcp open.
  const oauthConfig = oauthConfigFromEnv();
  if (oauthConfig && bearerToken) {
    throw new Error("Set either JOBSCOUT_OAUTH_ISSUER or JOBSCOUT_HTTP_BEARER_TOKEN, not both.");
  }
  let oauth: OAuthGuard | undefined;
  if (oauthConfig) oauth = await initialiseOAuth(oauthConfig);

  const server = createServer(createNodeListener({ bearerToken, oauth }));
  server.requestTimeout = 60_000;
  server.headersTimeout = 15_000;

  server.listen(port, host, () => {
    const mode = oauth ? `OAuth resource server for issuer ${oauthConfig?.issuer}` : bearerToken ? "shared bearer token" : "no authentication";
    console.error(`jobscout-mcp streamable HTTP listening on http://${host}:${port}/mcp (health: /health, auth: ${mode})`);
  });

  function shutdown(): void {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  console.error(`jobscout-mcp HTTP server did not start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
