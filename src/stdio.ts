#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

import { createProviderRegistry } from "./registry.js";
import { createJobScoutServer } from "./server.js";

const server = createJobScoutServer(createProviderRegistry());
const transport = new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 8 * 1024 * 1024 });
await server.connect(transport);

async function shutdown(): Promise<void> {
  await server.close();
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
