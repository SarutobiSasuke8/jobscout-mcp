# Installation

## Requirements

- Node.js 22.13 or newer
- an MCP host with local stdio support
- network access only for the providers you explicitly enable
- Python and `python-jobspy` only when using JobSpy

## Run directly from GitHub

```bash
npm exec --yes --package=github:SarutobiSasuke8/jobscout-mcp -- jobscout-mcp
```

### Codex

```bash
codex mcp add jobscout --env JOBSCOUT_ENABLE_HIMALAYAS=true -- npm exec --yes --package=github:SarutobiSasuke8/jobscout-mcp -- jobscout-mcp
```

### Claude Desktop or another JSON-configured MCP host

```json
{
  "mcpServers": {
    "jobscout": {
      "command": "npm",
      "args": ["exec", "--yes", "--package=github:SarutobiSasuke8/jobscout-mcp", "--", "jobscout-mcp"],
      "env": {
        "JOBSCOUT_ENABLE_HIMALAYAS": "true"
      }
    }
  }
}
```

On Windows, use `npm.cmd` if the host does not resolve `npm` automatically. A cold GitHub install can take tens of seconds; npm publication will make repeated setup faster and simpler. Cursor can use the same JSON server entry in its MCP configuration.

## Local development

```bash
git clone https://github.com/SarutobiSasuke8/jobscout-mcp.git
cd jobscout-mcp
npm install
cp .env.example .env
npm run check
npm run dev
```

For a built local configuration, use `node` with the absolute path to `dist/src/stdio.js`.

## Enable JobSpy

```bash
python -m pip install python-jobspy
```

Then set `JOBSCOUT_ENABLE_JOBSPY=true` and optionally `JOBSPY_PYTHON=python`. JobSpy's underlying sites can throttle, change, or impose their own terms. JobScout returns provider failure details without discarding results from other working sources.

## Provider environment variables

| Variable | Default | Purpose |
|---|---|---|
| `JOBSCOUT_ENABLE_HIMALAYAS` | `false` | Enable public Himalayas MCP job search |
| `HIMALAYAS_MCP_URL` | `https://mcp.himalayas.app/mcp` | Override the remote MCP endpoint |
| `JOBSCOUT_ENABLE_JOBSPY` | `false` | Enable the Python JobSpy bridge |
| `JOBSPY_PYTHON` | `python` | Select the Python executable |
| `JOBSPY_TIMEOUT_MS` | `45000` | Set subprocess timeout, bounded to 1–120 seconds |

## Verify the server

```bash
npm run check
npm run smoke:mcp
```

The smoke test launches the server with the official MCP Inspector and calls `tools/list`.

## Troubleshooting

- **No results and no failures:** check `jobscout_list_sources`; all providers are disabled by default.
- **JobSpy bridge missing:** install `python-jobspy` and confirm `JOBSPY_PYTHON` identifies the intended interpreter.
- **Remote-only search omits unknown-location jobs:** strict remote filtering only retains jobs explicitly marked remote.
- **A source is listed under `unknown_sources`:** the requested provider identifier is not installed in this build.
- **An aggregator URL is returned:** treat it as discovery provenance and verify the canonical employer or ATS route before applying.
