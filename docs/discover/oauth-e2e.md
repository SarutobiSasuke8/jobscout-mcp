# Discover: local end-to-end OAuth test

Issue [#48](https://github.com/SarutobiSasuke8/jobscout-mcp/issues/48). This test proves the Discover sign-in path works across the two real services before hosting (#43) and the demo account (#42). JobScout Pro is the issuer and JobScout MCP is the resource server. No test double sits in between.

## What it runs

`scripts/oauth-e2e.mjs` starts, all on `127.0.0.1` with random ports:

- **JobScout Pro** (issuer) from a sibling checkout, in development mode with the console mailer and the mock billing provider. Its SQLite database is in a temporary directory, and `SIGNING_KEY_SECRET` is 32 random bytes generated for the run. Access tokens last 60 seconds.
- **Three JobScout MCP HTTP servers** with OAuth `required`, all trusting that issuer:
  - the real one, audience `mcp-host-gateway`;
  - one that expects a different audience;
  - one that also requires a scope the issuer never grants (`jobscout:admin`).

The script then plays the MCP client. It uses the same calls ChatGPT or Claude make, with the magic-link email read from the issuer's console output. Child processes get a minimal environment, so nothing from your shell or a `.env` file leaks in. Everything is deleted at the end. Nothing in the repository is a secret.

## How to run

You need both checkouts side by side, each built from its PR branch:

```bash
git -C ../jobscout-pro checkout claude/jobscout-pro-v1
npm --prefix ../jobscout-pro ci
npm --prefix ../jobscout-pro run build
npm ci
npm run test:oauth-e2e
```

- `JOBSCOUT_PRO_DIR=/path/to/jobscout-pro` points at another checkout.
- `npm run test:oauth-e2e -- --skip-expiry` skips the 67-second wait for the expiry case.
- `JOBSCOUT_OAUTH_E2E_OUTPUT=results.json` also writes the results as JSON.

The command exits 1 if any case fails. It is not part of `npm run check` or CI, because it needs the private jobscout-pro checkout.

## Cases

| # | Case | Expected |
|---|---|---|
| 1 | Unauthenticated `tools/list` | 401 with `resource_metadata` in `WWW-Authenticate` |
| 2 | Protected resource metadata (RFC 9728) | `resource` is the `/mcp` URL; `authorization_servers` names the issuer |
| 3 | Issuer metadata (RFC 8414) | PKCE methods are exactly `["S256"]`, with a registration endpoint and a non-empty JWKS |
| 4 | Dynamic client registration (RFC 7591) | 201 with a `client_id` (public client, `none` auth) |
| 5 | Magic-link sign-in | Session cookie set |
| 6 | `/oauth/authorize` with PKCE S256 and `resource` = the MCP URL | Consent, then a code with `state` and `iss` (RFC 9207) |
| 7 | Token exchange | ES256 `at+jwt`, `aud=mcp-host-gateway`, `scope=jobscout`, 60 s lifetime |
| 8 | Authorised `tools/list` and `tools/call jobscout_list_sources` | 200, all tools listed, tool succeeds |
| N1 | Replay of a redeemed code | 400 `invalid_grant` |
| N2 | `code_challenge_method=plain` | Refused at `/authorize` (no consent page, no code) |
| N3 | Wrong `code_verifier` | 400 `invalid_grant` |
| N4 | Missing `code_verifier` | 400 |
| N5 | Valid token at a server expecting another audience | 401 `invalid_token` |
| N6 | Valid token at a server requiring an extra scope | 403 `insufficient_scope` |
| N7 | Token with an edited payload (signature no longer matches) | 401 |
| N8 | Token after expiry (60 s + 5 s clock tolerance) | 401 `invalid_token` |

CIMD (client ID metadata documents) is not covered: JobScout Pro advertises dynamic registration only, which is the path ChatGPT uses today.

## Results, 25 October 2026

The test ran on Windows 11 with Node 22.22.1, against jobscout-mcp `claude/jobscout-oauth-20261022` and jobscout-pro `claude/jobscout-pro-v1` plus the fix below. **16 passed, 0 failed.**

### Interop bug found and fixed

On the first run, step 6 failed. The issuer redirected with `error=invalid_target`, "resource must be on this host". JobScout Pro accepted an RFC 8707 `resource` only on its own origin. MCP clients send the `resource` from the server's protected resource metadata. So a JobScout MCP served from any other origin, such as its own host or port, could never get a token. The same-host Caddy recipe in [oauth.md](oauth.md) was not affected.

The fix is on jobscout-pro PR #2: a new `EXTRA_RESOURCE_ORIGINS` setting. It takes a comma-separated list of origins, with no paths, and must be https in production. The issuer's own origin is always allowed. Config and authorisation tests cover it. The harness sets it to the three MCP origins. Token `aud` is unchanged: it is still `TOKEN_AUDIENCE`, so the resource server keeps checking `JOBSCOUT_OAUTH_AUDIENCE=mcp-host-gateway`.

### Not covered

- The real hosted issuer and a real ChatGPT connection. Those need the live domain (#43) and the demo account (#42).
- Refresh-token rotation through the resource server. The issuer's own tests cover it.
