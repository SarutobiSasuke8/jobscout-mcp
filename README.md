# JobScout MCP

A privacy-first, bring-your-own-connections MCP server for searching, normalizing and deduplicating jobs across multiple sources.

JobScout MCP deliberately stops at trustworthy discovery. It does not score candidates, store CVs, contact employers or apply to jobs. Personalized career decisions belong in a separate client such as Career OS.

## Current v0.1

- `jobscout_search_jobs`: search all enabled providers and return one normalized, deduplicated pool
- `jobscout_list_sources`: show provider configuration and health boundaries
- `jobscout_deduplicate`: normalize and deduplicate supplied job records without making network calls
- optional public Himalayas MCP adapter
- optional JobSpy adapter using the clearly MIT-licensed `python-jobspy` package
- strict schemas, source provenance and deterministic fingerprints
- local stdio transport for Codex, Claude Desktop and other MCP clients

## Install

```bash
npm install
cp .env.example .env
npm run check
npm run dev
```

Python JobSpy is optional:

```bash
python -m pip install python-jobspy
```

Then set `JOBSCOUT_ENABLE_JOBSPY=true`. Remote providers are disabled by default.

## Example MCP configuration

```json
{
  "mcpServers": {
    "jobscout": {
      "command": "node",
      "args": ["C:/path/to/jobscout-mcp/dist/src/stdio.js"],
      "env": {
        "JOBSCOUT_ENABLE_HIMALAYAS": "true"
      }
    }
  }
}
```

## Provider philosophy

Job boards and aggregators are discovery sources. Each result retains its discovery URL and an independently supplied canonical employer URL when available. Consumers must verify freshness, location and application routes before acting.

See [architecture](docs/ARCHITECTURE.md), [provider contract](docs/PROVIDERS.md), [security](SECURITY.md) and [roadmap](ROADMAP.md).

## Prior art and attribution

- [JobSpy](https://github.com/speedyapply/JobSpy), MIT licensed, is used as an optional dependency rather than copied.
- [borgius/jobspy-mcp-server](https://github.com/borgius/jobspy-mcp-server) demonstrated early demand for a JobSpy MCP wrapper. No source code from that repository is copied in v0.1 because its package metadata says MIT but the repository does not currently expose a root licence file.

## Licence

Apache-2.0. Third-party dependencies retain their own licences.
