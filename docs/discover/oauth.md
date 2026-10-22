# OAuth for existing-account sign-in

Design record for README gap 2 of [JobScout Discover](README.md). Decided 2026-10-23.

## Decision

JobScout MCP is an **OAuth 2.1 resource server only**. It does not run a second authorisation server or keep accounts. The one issuer is the operator's account service, JobScout Pro, which already holds the accounts and plans, runs the sign-in, and is the issuer that [mcp-host-gateway](https://github.com/SarutobiSasuke8/mcp-host-gateway) trusts. ChatGPT (or Claude) is the OAuth client and registers itself with that issuer.

What this repository adds, in `src/oauth.ts`:

| Piece | Behaviour |
|---|---|
| Issuer check at startup | Fetches the issuer's RFC 8414 metadata and refuses to start unless it offers authorisation code with PKCE `S256` only: `plain` absent, no implicit or password grant, `grant_types_supported` stated, a JWKS, a registration route (RFC 7591 dynamic registration or a client ID metadata document) and https endpoints. It also refuses to start if the JWKS publishes no keys. |
| `/.well-known/oauth-protected-resource` | RFC 9728 metadata: `resource` (the public `/mcp` URL), `authorization_servers` (the issuer), `scopes_supported`, `bearer_methods_supported`. Served at both the path-suffixed location (`/.well-known/oauth-protected-resource/mcp`) and the bare one. |
| `/.well-known/oauth-authorization-server` | The issuer's metadata, verbatim, for clients that still look for it on the resource origin. |
| Token validation on `/mcp` | Each bearer token is verified as an RFC 9068 JWT access token against the issuer's JWKS: signature (asymmetric algorithms only, `ES256` by default), `typ: at+jwt`, `iss`, `aud`, `exp`, `sub` and the required scope (`jobscout`). Failure answers `401` (or `403` for a missing scope) with a `WWW-Authenticate: Bearer` challenge carrying `resource_metadata`. |
| Tool security schemes | Every tool's `_meta.securitySchemes` declares `oauth2` with the scope, plus `noauth` in optional mode, as the OpenAI Apps SDK asks. |
| Modes | `required`: every call needs a token. `optional`: calls without an `Authorization` header are served anonymously, and a call that presents a token must present a valid one. Discover should use `optional`, because the free tier needs no account ([monetisation](../MONETISATION.md)). |

Authorisation code and PKCE are enforced by the issuer, which is where the code is issued and redeemed. This server enforces them by refusing to trust an issuer that does not, and by accepting only tokens that issuer signed.

## Why not an authorisation server here

- **One account store.** "Existing-account sign-in" means accounts that already exist. They live in JobScout Pro. A second server here would need its own users, sessions and keys, and would drift.
- **One issuer for both paths.** The gateway already verifies JobScout Pro's ES256 JWTs. With the same issuer, a token works whether a deployment puts the gateway in front or not.
- **The MCP authorisation model separates the roles.** The MCP server is a resource server and points at its authorisation server through protected resource metadata. The MCP SDK ships the resource-server helpers this module uses (`requireBearerAuth`, `buildOAuthProtectedResourceMetadata`).
- **No secrets.** A resource server needs only public values: the issuer URL, the audience and the issuer's public keys. Nothing in this repository or its environment is a credential.

## Topologies

1. **Direct (this recipe).** Caddy sends `/mcp` and the discovery paths to JobScout MCP, which validates tokens itself. JobScout Pro serves `/oauth/*` and `/.well-known/jwks.json` on the same host. Set `JOBSCOUT_OAUTH_AUDIENCE` to the audience the issuer mints (JobScout Pro mints `mcp-host-gateway` unless its `TOKEN_AUDIENCE` is changed).
2. **Behind mcp-host-gateway.** The gateway validates the same tokens and applies plan limits. JobScout MCP stays behind it on the compose network with OAuth off (the gateway can send a shared upstream header if needed). JobScout Pro already publishes protected resource metadata for this case.

Plan limits are not enforced by JobScout MCP in either topology. The token's `plan` claim reaches tool handlers as `AuthInfo.extra.plan`, but entitlement stays with the gateway.

## Configuration

Environment variable names only. None is a secret. See `.env.example` and `deploy/.env.example`.

| Variable | Default | Purpose |
|---|---|---|
| `JOBSCOUT_OAUTH_ISSUER` | unset (OAuth off) | Issuer identifier, exactly as its metadata states it |
| `JOBSCOUT_OAUTH_RESOURCE_URL` | required with the issuer | Public URL of `/mcp`, used as the RFC 9728 `resource` |
| `JOBSCOUT_OAUTH_AUDIENCE` | the resource URL | Expected `aud` claim |
| `JOBSCOUT_OAUTH_MODE` | `required` | `required` or `optional` |
| `JOBSCOUT_OAUTH_SCOPES` | `jobscout` | Scopes every token must carry |
| `JOBSCOUT_OAUTH_ALGORITHMS` | `ES256` | Accepted JWS algorithms; `none` and `HS*` are refused |
| `JOBSCOUT_OAUTH_JWKS_URL` | the metadata's `jwks_uri` | Override for the key set |
| `JOBSCOUT_OAUTH_ALLOW_INSECURE` | `false` | Allows http on loopback only, for local tests |

OAuth and `JOBSCOUT_HTTP_BEARER_TOKEN` cannot be set together; the server refuses to start. A partial OAuth configuration, an unreachable issuer, or an issuer that fails the checks above also stops startup, so `/mcp` is never left open by mistake.

## Tests

`test/oauth.test.ts`, against a test-only issuer in `test/oauth-issuer.ts` that mirrors JobScout Pro's contract over real sockets (sign-in is replaced by a fixed test account):

- the full client flow: `401` challenge, protected resource metadata, issuer metadata, dynamic registration, authorisation with PKCE `S256`, token exchange, then a successful `tools/list`;
- the issuer contract: no PKCE, `plain`, a wrong verifier and a replayed code are all refused;
- token validation: expired, wrong audience, wrong issuer, wrong `typ`, missing scope (`403`), missing `sub`, an unpublished signing key, `HS256` algorithm confusion, a tampered payload, garbage and a non-Bearer header;
- issuer metadata rules, fail-closed startup, environment parsing, both modes and the tool security schemes.

JobScout Pro's own authorisation server, sign-in and refresh-token rotation are tested in its repository. A run against the real issuer and against ChatGPT needs the live domain (gap 1).

## Still open

- **The ChatGPT linking prompt in optional mode.** The Apps SDK shows its sign-in prompt for a tool when that tool returns an error carrying `_meta["mcp/www_authenticate"]`. No JobScout tool needs an account yet; which tools are Pro-only is still the operator's decision. Until then, in optional mode, users connect anonymously, and `required` mode is the way to force sign-in on connect.
- **Redirect URI allowlist.** The ChatGPT redirect URI from the connector's management page must be accepted by the issuer. JobScout Pro accepts any https redirect a client registers, so nothing is needed today; check this again if that policy tightens.
- **Live end-to-end run** against `https://jobscout.mcprack.dev` once it is deployed, and a real demo account (gap 3).
