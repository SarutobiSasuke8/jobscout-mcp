import { z } from "zod";

export const httpUrlSchema = z.url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
}, "URL must use http or https");

export const jobDomainSchema = z.enum(["ai", "web3"]);
export const jobCategorySchema = z.enum([
  "ai-agents",
  "ai-infrastructure",
  "ai-data-evals",
  "ai-safety-governance",
  "robotics",
  "web3-protocols",
  "defi",
  "depin",
  "wallets-custody",
  "exchanges-markets",
  "web3-developer-infrastructure",
  "gaming-metaverse",
  "agentic-commerce",
]);

export const jobSignalsSchema = z.object({
  domains: z.array(jobDomainSchema).max(2),
  categories: z.array(jobCategorySchema).max(20),
  technologies: z.array(z.string().trim().min(1).max(80)).max(50),
  matched_terms: z.array(z.string().trim().min(1).max(80)).max(100),
  confidence: z.enum(["none", "low", "medium", "high"]),
});

export const searchQuerySchema = z.object({
  query: z.string().trim().min(1).max(240),
  location: z.string().trim().min(1).max(160).optional(),
  remote_only: z.boolean().default(false),
  hours_old: z.number().int().min(1).max(24 * 90).optional(),
  limit: z.number().int().min(1).max(100).default(25),
  sources: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
});

export const provenanceSchema = z.object({
  provider: z.string().trim().min(1).max(60),
  discovery_url: httpUrlSchema.optional(),
  source_job_id: z.string().trim().min(1).max(240).optional(),
  captured_at: z.iso.datetime(),
});

export const salarySchema = z.object({
  min: z.number().finite().nonnegative().optional(),
  max: z.number().finite().nonnegative().optional(),
  currency: z.string().trim().min(3).max(8).optional(),
  interval: z.enum(["hour", "day", "week", "month", "year", "unknown"]).optional(),
});

export const normalizedJobSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/u),
  title: z.string().trim().min(1).max(300),
  company: z.string().trim().min(1).max(300),
  location: z.string().trim().max(5_000).default("Unknown"),
  remote: z.boolean().optional(),
  description: z.string().trim().max(100_000).optional(),
  /** True when the description was shortened to DESCRIPTION_LIMIT during normalization. */
  description_truncated: z.boolean().optional(),
  /**
   * True when another record shared this record's canonical URL but named a different company.
   * The records are deliberately NOT merged in that case, because merging would publish one
   * listing's text under the other's employer name. Surface both and let a human decide.
   */
  duplicate_conflict: z.boolean().optional(),
  employment_type: z.string().trim().max(80).optional(),
  date_posted: z.iso.date().optional(),
  canonical_url: httpUrlSchema.optional(),
  salary: salarySchema.optional(),
  tags: z.array(z.string().trim().min(1).max(80)).max(100).default([]),
  signals: jobSignalsSchema.optional(),
  provenance: z.array(provenanceSchema).min(1).max(50),
});

/**
 * Job descriptions are attacker-controlled text that ends up inside a tool-enabled model's
 * context. A 100,000 character description across a 100 result page is a third of a million
 * characters of untrusted input in one tool call, which is both a cost problem and the ideal
 * carrier for an injected instruction. Nothing legitimate needs more than a few thousand.
 */
export const DESCRIPTION_LIMIT = 4_000;

export type SearchQuery = z.infer<typeof searchQuerySchema>;
export type JobProvenance = z.infer<typeof provenanceSchema>;
export type NormalizedJob = z.infer<typeof normalizedJobSchema>;
export type JobSignals = z.infer<typeof jobSignalsSchema>;

export interface ProviderStatus {
  id: string;
  label: string;
  enabled: boolean;
  authentication: "none" | "optional" | "required";
  transport?: "remote-mcp" | "subprocess" | "http-api";
  coverage?: Array<"general" | "ai" | "web3">;
  optional_dependency?: string;
  notes: string;
}

/**
 * What a provider hands back to the registry. `records_rejected` counts source records that
 * failed validation and were dropped during normalization. The Operator guide promises that
 * provider failures are never silently swallowed; without this count, schema-invalid records
 * vanished with no trace and that promise was false.
 */
export interface ProviderSearchResult {
  jobs: NormalizedJob[];
  records_rejected: number;
}

export interface JobProvider {
  status(): ProviderStatus;
  search(query: SearchQuery): Promise<ProviderSearchResult>;
}

export interface ProviderFailure {
  provider: string;
  error: string;
}

export interface SearchResult {
  jobs: NormalizedJob[];
  failures: ProviderFailure[];
  providers_queried: string[];
  /** Enabled-but-unknown source ids the caller asked for. */
  unknown_sources: string[];
  /** Configured providers that are currently disabled. Explains thin results honestly. */
  providers_disabled: string[];
  /** Source records dropped during validation across all queried providers. */
  records_rejected: number;
  /** Returned jobs carrying no date_posted; freshness filters cannot vouch for these. */
  undated_records: number;
  /**
   * True when the search ran against zero enabled providers. Without this flag a fresh
   * install returns an empty success and the calling agent tells its user "no jobs matched",
   * which is false: nothing was searched. `message` carries the setup guidance.
   */
  setup_required?: boolean;
  message?: string;
}
