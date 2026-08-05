import { z } from "zod";

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
  discovery_url: z.url().optional(),
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
  employment_type: z.string().trim().max(80).optional(),
  date_posted: z.iso.date().optional(),
  canonical_url: z.url().optional(),
  salary: salarySchema.optional(),
  tags: z.array(z.string().trim().min(1).max(80)).max(100).default([]),
  provenance: z.array(provenanceSchema).min(1).max(50),
});

export type SearchQuery = z.infer<typeof searchQuerySchema>;
export type JobProvenance = z.infer<typeof provenanceSchema>;
export type NormalizedJob = z.infer<typeof normalizedJobSchema>;

export interface ProviderStatus {
  id: string;
  label: string;
  enabled: boolean;
  authentication: "none" | "optional" | "required";
  notes: string;
}

export interface JobProvider {
  status(): ProviderStatus;
  search(query: SearchQuery): Promise<NormalizedJob[]>;
}

export interface ProviderFailure {
  provider: string;
  error: string;
}

export interface SearchResult {
  jobs: NormalizedJob[];
  failures: ProviderFailure[];
  providers_queried: string[];
}
