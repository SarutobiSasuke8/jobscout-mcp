import { searchQuerySchema } from "../src/types.js";

import type { SearchQuery } from "../src/types.js";

/**
 * Build a complete SearchQuery from a partial one.
 *
 * `SearchQuery` is the schema's output type, so every field carrying a default is required on
 * the object the registry receives. Parsing here rather than spelling the defaults out in each
 * test means adding a new defaulted field does not break every existing case.
 */
export function searchQuery(overrides: Partial<SearchQuery> & { query?: string } = {}): SearchQuery {
  return searchQuerySchema.parse({ query: "sales", ...overrides });
}
