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
normalization --> provenance merge --> deterministic deduplication
   |
   v
one source-neutral candidate pool
```

The provider layer owns retrieval only. The core owns validation, normalization, fingerprints and duplicate merging. Personalized ranking is intentionally outside this repository so public infrastructure never needs a CV or identity profile.

## Trust model

Discovery URLs and canonical employer URLs are separate fields. A source may return a useful lead without returning enough evidence to promote it. Downstream clients should fail closed when freshness, location or canonical application route cannot be verified.
