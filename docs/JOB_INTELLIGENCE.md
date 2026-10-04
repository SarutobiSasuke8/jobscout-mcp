# AI and Web3 job intelligence

JobScout enriches normalized jobs with deterministic, inspectable domain signals. The classifier makes no network calls and does not infer candidate suitability.

```json
{
  "signals": {
    "domains": ["ai", "web3"],
    "categories": ["ai-agents", "web3-protocols", "agentic-commerce"],
    "technologies": ["MCP", "x402", "Base"],
    "matched_terms": ["agentic", "mcp", "x402", "base"],
    "confidence": "high"
  }
}
```

## Design principles

- Rules are versioned in source and produce repeatable results.
- Matching uses normalized complete terms, avoiding substring errors such as treating `database` as `Base`.
- Confidence describes matched domain evidence, not job quality.
- Signals may improve downstream retrieval or private ranking, but never replace reading the listing.
- The public taxonomy contains no candidate profile, personal preference, or private scoring weights.

AI categories cover agents, infrastructure, data/evaluations, safety/governance, and robotics. Web3 categories cover protocols, DeFi, DePIN, wallets/custody, exchanges/markets, developer infrastructure, and gaming/metaverse. Agentic commerce captures the emerging AI × payments overlap.

Each contributed rule should include a positive fixture, an ambiguity negative fixture where relevant, a stable category, and no claim that the signal establishes employer quality or candidate fit.

## Source yield

`jobscout_source_yield` answers the question a multi-source engine eventually has to answer: which sources are earning their place. Adding a source is easy and feels like progress. Measuring one is the only way to tell whether it widened coverage or restated what another source already found.

It deduplicates the supplied pool first, then attributes each surviving job to every source in its provenance. Deduplication preserves contributing providers, which is what makes attribution possible after merging.

| Field | Meaning |
|---|---|
| `jobs` | Jobs in the final pool this source contributed to |
| `unique` | Jobs only this source found — what would be lost by dropping it |
| `shared` | Jobs at least one other source also found |
| `overlap_rate` | `shared / jobs`. A source at `1.0` restated others and added nothing |
| `with_canonical` | Contributed jobs whose final record carries an employer application route |
| `undated` | Contributed jobs with no posting date, so freshness cannot be checked |
| `conflicts` | Contributed jobs flagged as one URL naming two employers |

### What it does not measure

Discovery yield only. It cannot know which roles a human found worth pursuing, so low `unique` does not by itself condemn a source: three good roles beat three hundred restatements. `with_canonical` is measured on the merged record, so it credits every contributor to a job that ended up with an employer route rather than proving which source supplied it.

The tool returns counts and rates, never job text. Measuring your sources should not mean pulling a few hundred listings of untrusted third-party prose back through a model's context.
