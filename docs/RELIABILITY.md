# Reliability and duplicate handling

The 2026-10-01 sweep changes duplicate handling conservatively:

- Different direct requisition URLs remain separate, even with the same employer, title and location.
- A board copy without a direct URL merges only when its text identity selects one direct-URL cluster. Ambiguous copies stay visible with `duplicate_conflict`.
- A shared URL naming different employers cannot merge their descriptions. Known legal suffixes may differ; arbitrary name prefixes may not.
- Non-Latin employer names retain their letters in identity keys.
- Truncation flags survive re-normalisation and merges.

`test/deduplication-corpus.test.ts` is a hand-labelled synthetic corpus. Every input order is checked for group membership, provenance retention and unique output IDs. It is regression evidence, not a measured real-world precision or recall score. Conservative matching may leave duplicate vacancies that use different employer URLs.

Identity normalisation changes can alter IDs for non-Latin records and URL conflicts. Consumers should retain provider source IDs and provenance when reconciling historical results rather than treating a fingerprint as a permanent external identifier.

HTTP feeds are read incrementally and cancelled at the byte limit, including responses without a trustworthy Content-Length. Existing transient-failure cache warnings remain explicit.

## Release evidence still needed

A live 2026-10-01 smoke search for `engineer` queried the opt-in We Work Remotely and RemoteOK feeds. It returned 20 dated results with provenance, 0 rejected records, 0 failures and 0 degradation warnings. This is one observation, not an availability or quality benchmark.

Run provider field checks against the versioned package, record empty results separately from source failures and confirm rate-limit behaviour. The registry job follows successful npm publication and uses GitHub OIDC; it still needs a live first run. If it fails after npm succeeds, rerun only the failed registry job rather than republishing an immutable npm version.

Supported scope remains discovery. Personal profiles, ranking and applications stay outside the public engine.
