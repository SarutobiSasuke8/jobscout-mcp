# Security policy

## Boundaries

JobScout MCP treats provider responses, descriptions, URLs and search terms as untrusted data. It never executes text returned by a job source.

- Providers are disabled unless explicitly enabled.
- The JobSpy bridge uses `spawn` without a shell and accepts JSON through stdin.
- Secrets must come from process environment variables and must never be committed.
- Results preserve provenance and do not imply that an application URL is canonical unless a provider supplied it as such.
- The server contains no auto-apply, messaging, arbitrary URL-fetch, arbitrary command, filesystem-write or browser-login tool.

Report vulnerabilities through a private GitHub security advisory after the repository is published.
