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
