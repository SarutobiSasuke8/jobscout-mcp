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

The taxonomy layer is deterministic and local. It labels domain evidence for routing and retrieval; it never estimates candidate fit. Private clients can consume the signals alongside their own evidence and policy without sending those private inputs back to JobScout.

## Trust model

Discovery URLs and canonical employer URLs are separate fields. A source may return a useful lead without returning enough evidence to promote it. Downstream clients should fail closed when freshness, location or canonical application route cannot be verified.

Remote responses and subprocess output are bounded. Provider failures are isolated, normalized, and returned with partial results. Strict remote and freshness filters are re-applied by the registry instead of trusting provider-side filtering alone.
