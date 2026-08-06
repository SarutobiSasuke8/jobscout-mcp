# Security policy

## Boundaries

JobScout MCP treats provider responses, descriptions, URLs and search terms as untrusted data. The Node process never executes text returned by a job source.

- Providers are disabled unless explicitly enabled.
- The JobSpy bridge uses `spawn` without a shell and accepts JSON through stdin.
- Job URLs are restricted to HTTP(S), and canonical URLs remove common tracking parameters before fingerprinting.
- Remote responses, subprocess output, provider errors and execution time are bounded.
- Secrets must come from process environment variables and must never be committed.
- Results preserve provenance and do not imply that an application URL is canonical unless a provider supplied it as such.
- The server contains no auto-apply, messaging, arbitrary URL-fetch, arbitrary command, filesystem-write or browser-login tool.

## What this server cannot protect you from

The boundaries above describe the JobScout process. They do not, and cannot, describe the model you connect it to.

JobScout's purpose is to move third-party text into a model's context. That text is written by whoever posted the job. **A job listing is untrusted input, and an MCP server is a pipe into a model that usually holds other tools.** If a listing contains text designed to be read as an instruction, JobScout will faithfully deliver it, because delivering listings is what it does.

What JobScout does about this:

- Descriptions are truncated to 4,000 characters, so one listing cannot flood a context window.
- Control characters, zero-width characters and bidirectional overrides are stripped from descriptions, so injected text cannot hide from a human reading the same record.
- Every tool result carries an explicit notice that job text is untrusted and that instructions inside it must be treated as data.
- Every tool is marked `readOnlyHint`, and the server holds no credentials, writes no files and cannot apply to anything.

What it cannot do:

- It cannot stop a downstream model from acting on a convincing instruction embedded in a job description.
- It cannot verify that an employer wrote the text attributed to them.
- It cannot prevent a merged record from combining text discovered under the same URL from different sources. Check `provenance` before trusting an employer attribution.

If you connect JobScout to an agent that also holds credentials, private data, or the ability to send messages or spend money, that combination is your security boundary to design, not JobScout's. Treat every field it returns as hostile prose that happens to be shaped like a job.

Report vulnerabilities through a private GitHub security advisory. Do not include credentials, private candidate data, or active exploit details in a public issue.
