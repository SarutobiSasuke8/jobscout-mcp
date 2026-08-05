export { deduplicateJobs, fingerprint, normalizeJob } from "./core.js";
export { createProviderRegistry, ProviderRegistry } from "./registry.js";
export { createJobScoutServer } from "./server.js";
export { normalizedJobSchema, searchQuerySchema } from "./types.js";
export type { JobProvider, NormalizedJob, ProviderStatus, SearchQuery, SearchResult } from "./types.js";
