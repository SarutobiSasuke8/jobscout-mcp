export { canonicalizeUrl, deduplicateJobs, fingerprint, normalizeJob } from "./core.js";
export { classifyJob } from "./taxonomy.js";
export { createProviderRegistry, ProviderRegistry } from "./registry.js";
export { createJobScoutServer } from "./server.js";
export { jobSignalsSchema, normalizedJobSchema, searchQuerySchema } from "./types.js";
export type { JobProvider, JobSignals, NormalizedJob, ProviderStatus, SearchQuery, SearchResult } from "./types.js";
