# Installation

## Requirements

- Node.js 22.13 or newer
- an MCP host with local stdio support
- network access only for the providers you explicitly enable
- Python and `python-jobspy` only when using JobSpy

## Run from npm

```bash
npm exec --yes --package=@sarutobi-sasuke/jobscout-mcp -- jobscout-mcp
```

### Codex

```bash
codex mcp add jobscout --env JOBSCOUT_ENABLE_HIMALAYAS=true -- npm exec --yes --package=@sarutobi-sasuke/jobscout-mcp -- jobscout-mcp
```

### Claude Desktop or another JSON-configured MCP host

```json
{
  "mcpServers": {
    "jobscout": {
      "command": "npm",
      "args": ["exec", "--yes", "--package=@sarutobi-sasuke/jobscout-mcp", "--", "jobscout-mcp"],
      "env": {
        "JOBSCOUT_ENABLE_HIMALAYAS": "true"
      }
    }
  }
}
```

## Run directly from GitHub

Useful for pinning to a commit or testing an unreleased branch instead of the published package:

```bash
npm exec --yes --package=github:SarutobiSasuke8/jobscout-mcp -- jobscout-mcp
```

On Windows, use `npm.cmd` if the host does not resolve `npm` automatically. A cold GitHub install can take tens of seconds; the npm package above is faster for repeated setup. Cursor can use the same JSON server entry in its MCP configuration.

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

Then set `JOBSCOUT_ENABLE_JOBSPY=true` and optionally `JOBSPY_PYTHON=python`. JobScout returns provider failure details without discarding results from other working sources.

> **Before you enable this.** JobSpy sends automated requests **from your own machine** to job boards. JobScout defaults to **Indeed only**. You can widen this with `JOBSPY_SITES` to include LinkedIn, Glassdoor, Google Jobs, ZipRecruiter, Bayt or Naukri, but LinkedIn, Glassdoor and Indeed each restrict automated access in their terms of use, and that decision is yours. `jobscout_list_sources` always reports the sites currently configured. See [PROVIDERS.md](PROVIDERS.md#which-sites-this-contacts).

## Provider environment variables

| Variable | Default | Purpose |
|---|---|---|
| `JOBSCOUT_ENABLE_HIMALAYAS` | `false` | Enable public Himalayas MCP job search |
| `HIMALAYAS_MCP_URL` | `https://mcp.himalayas.app/mcp` | Override the remote MCP endpoint |
| `JOBSCOUT_ENABLE_JOBSPY` | `false` | Enable the Python JobSpy bridge. Sends automated requests from this machine to the sites in `JOBSPY_SITES` |
| `JOBSPY_PYTHON` | `python` | Select the Python executable |
| `JOBSPY_TIMEOUT_MS` | `45000` | Set subprocess timeout, bounded to 1–120 seconds |
| `JOBSPY_SITES` | `indeed` | Comma-separated sites to query: `indeed`, `linkedin`, `glassdoor`, `google`, `zip_recruiter`, `bayt`, `naukri`. Unrecognised values are dropped |
| `JOBSPY_COUNTRY` | _(unset)_ | Country scope for Indeed. Unset defers to the `python-jobspy` default |

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
