# Contributing

Open an issue before adding a provider. A provider proposal must document its data source, authentication model, terms considerations, rate limits, failure modes, canonical-link quality and test fixtures.

Every provider or taxonomy change needs positive fixtures, failure behavior, and an ambiguity/negative fixture where relevant. Run:

```bash
npm run check
npm run smoke:mcp
npm run pack:check
```

Do not include scraped personal data, credentials, real CVs or application records in fixtures.
