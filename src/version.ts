/**
 * Single source of truth for the server's version string.
 *
 * It previously appeared verbatim in the MCP server identity, the Himalayas client handshake
 * and the package metadata, and had already drifted once. `test/version.test.ts` asserts this
 * constant still matches package.json, so the duplication cannot silently return.
 */
export const VERSION = "0.2.1";
