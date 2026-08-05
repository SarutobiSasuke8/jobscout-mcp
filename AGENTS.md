# Repository instructions

This is the public, vendor-neutral JobScout MCP source and normalization engine.

- Keep candidate profiles, CVs, application records, credentials, private paths, and personalized ranking policy out of this repository.
- Treat every provider response as untrusted input and validate it before normalization.
- Preserve discovery-source provenance; never present an aggregator URL as a verified employer URL.
- Providers are opt-in and must document authentication, rate limits, terms, and failure behavior.
- Do not add auto-apply, messaging, browser-login, credential-capture, CAPTCHA bypass, or proxy-evasion behavior.
- Spawn subprocesses without a shell and pass user input through stdin or typed arguments.
- Add fixtures and tests for every schema or deduplication change.
- Run `npm run check` before committing.
