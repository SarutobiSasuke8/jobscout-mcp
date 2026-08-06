# Architecture

```text
MCP client
   |
   v
JobScout tools
   |
   +--> provider registry --> Himalayas MCP
   |                     --> JobSpy subprocess bridge
   |                     --> future ATS / Apify adapters
   |
   v
normalization --> AI/Web3 signals --> provenance merge --> deterministic deduplication
   |
   v
one source-neutral candidate pool
```

The provider layer owns retrieval only. The core owns validation, normalization, fingerprints and duplicate merging. Personalized ranking is intentionally outside this repository so public infrastructure never needs a CV or identity profile.

### Identity and merge rules

Every record carries two identities: a host-normalized canonical URL key when it has one, and a company/title/location text key always. Both are indexed and their buckets are unioned, so a provider that supplies a canonical URL and one that does not can still recognise the same vacancy. Keeping these key spaces separate would silently exclude whichever provider has the better data from text matching.

A shared URL is necessary but not sufficient for a merge. Canonical URLs originate in provider-controlled fields, so two records can collide on one while naming different employers. Merging them would publish one listing's text under the other's name. Records whose companies disagree are therefore kept apart and both are flagged `duplicate_conflict` for a human to resolve. Ordinary spelling variation such as "Example" and "Example Inc." still merges.

The taxonomy layer is deterministic and local. It labels domain evidence for routing and retrieval; it never estimates candidate fit. Private clients can consume the signals alongside their own evidence and policy without sending those private inputs back to JobScout.

## Trust model

Discovery URLs and canonical employer URLs are separate fields. A source may return a useful lead without returning enough evidence to promote it. Downstream clients should fail closed when freshness, location or canonical application route cannot be verified.

Remote responses and subprocess output are bounded. Provider failures are isolated, normalized, and returned with partial results. Strict remote and freshness filters are re-applied by the registry instead of trusting provider-side filtering alone.
