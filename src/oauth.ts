import {
  OAuthError,
  OAuthErrorCode,
  buildOAuthProtectedResourceMetadata,
  getOAuthProtectedResourceMetadataUrl,
  requireBearerAuth,
} from "@modelcontextprotocol/server";
import { createRemoteJWKSet, errors as joseErrors, jwtVerify } from "jose";

import type { AuthInfo, OAuthMetadata, OAuthProtectedResourceMetadata, OAuthTokenVerifier } from "@modelcontextprotocol/server";
import type { JWTPayload, JWTVerifyGetKey } from "jose";

/**
 * OAuth 2.1 resource server for the hosted MCP endpoint.
 *
 * JobScout does not run its own authorisation server or account store. Existing accounts live
 * with one issuer (for the operator's hosted deployment, the JobScout Pro account service, which
 * is also the issuer mcp-host-gateway trusts). This module:
 *
 * - discovers that issuer's RFC 8414 metadata at startup and refuses to start unless it
 *   enforces authorisation code with PKCE S256 only (no `plain`, no implicit or password grant);
 * - serves RFC 9728 protected resource metadata pointing clients at the issuer, plus the
 *   issuer's metadata verbatim at `/.well-known/oauth-authorization-server` for clients that
 *   still probe the resource origin;
 * - verifies every MCP request's bearer token as a signed JWT access token (RFC 9068) against
 *   the issuer's JWKS: signature, `typ`, `iss`, `aud`, `exp`, `sub` and the required scopes.
 *
 * Only public material is involved (issuer URL, audience, public keys), so no secret is read.
 * See docs/discover/oauth.md for the design record.
 */

export const AUTHORIZATION_SERVER_METADATA_PATH = "/.well-known/oauth-authorization-server";
export const PROTECTED_RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";
export const DEFAULT_SCOPES = ["jobscout"];
export const DEFAULT_ALGORITHMS = ["ES256"];
/** RFC 9068 access-token media type. Stops an ID token or other JWT from the same issuer being replayed here. */
export const ACCESS_TOKEN_TYP = "at+jwt";
const CLOCK_TOLERANCE_SECONDS = 5;
const DISCOVERY_TIMEOUT_MS = 5_000;

export class OAuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthConfigError";
  }
}

/**
 * required: every MCP call needs a valid token (ChatGPT asks the user to sign in on connect).
 * optional: anonymous calls are served as before; a call that presents a token must present a
 * valid one. Tools then declare both noauth and oauth2 security schemes.
 */
export type OAuthMode = "required" | "optional";

export interface OAuthConfig {
  mode: OAuthMode;
  /** Issuer identifier, exactly as the authorisation server's metadata states it. */
  issuer: string;
  /** Public URL of this MCP endpoint, used as the RFC 9728 `resource`. */
  resourceUrl: URL;
  /** Expected `aud` claim. */
  audience: string;
  /** Scopes every token must carry. */
  requiredScopes: string[];
  /** Accepted JWS algorithms. */
  algorithms: string[];
  /** Overrides the metadata's `jwks_uri`. */
  jwksUrl?: URL | undefined;
  /** Allows http issuer and endpoint URLs. Local testing only. */
  allowInsecure: boolean;
}

function list(value: string | undefined, fallback: string[]): string[] {
  const items = (value ?? "").split(/[\s,]+/u).map((item) => item.trim()).filter(Boolean);
  return items.length ? items : fallback;
}

function parseUrl(value: string, name: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new OAuthConfigError(`${name} is not a valid URL`);
  }
}

function isLoopback(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
}

function requireSecureUrl(url: URL, name: string, allowInsecure: boolean): void {
  if (url.protocol === "https:") return;
  if (url.protocol === "http:" && allowInsecure && isLoopback(url)) return;
  throw new OAuthConfigError(`${name} must use https${allowInsecure ? " (http is allowed only on loopback)" : ""}`);
}

/**
 * Read OAuth settings from the environment. Returns undefined when OAuth is not configured
 * (JOBSCOUT_OAUTH_ISSUER unset). A partial configuration is an error, never a silent fallback
 * to an open endpoint.
 */
export function oauthConfigFromEnv(environment: NodeJS.ProcessEnv = process.env): OAuthConfig | undefined {
  const issuer = environment.JOBSCOUT_OAUTH_ISSUER?.trim();
  const resource = environment.JOBSCOUT_OAUTH_RESOURCE_URL?.trim();
  if (!issuer) {
    if (resource || environment.JOBSCOUT_OAUTH_AUDIENCE?.trim()) {
      throw new OAuthConfigError("JOBSCOUT_OAUTH_ISSUER is required when any other JOBSCOUT_OAUTH_* setting is present");
    }
    return undefined;
  }
  if (!resource) throw new OAuthConfigError("JOBSCOUT_OAUTH_RESOURCE_URL is required when JOBSCOUT_OAUTH_ISSUER is set");
  const allowInsecure = environment.JOBSCOUT_OAUTH_ALLOW_INSECURE?.trim().toLowerCase() === "true";
  const issuerUrl = parseUrl(issuer, "JOBSCOUT_OAUTH_ISSUER");
  requireSecureUrl(issuerUrl, "JOBSCOUT_OAUTH_ISSUER", allowInsecure);
  const resourceUrl = parseUrl(resource, "JOBSCOUT_OAUTH_RESOURCE_URL");
  requireSecureUrl(resourceUrl, "JOBSCOUT_OAUTH_RESOURCE_URL", allowInsecure);
  if (resourceUrl.hash) throw new OAuthConfigError("JOBSCOUT_OAUTH_RESOURCE_URL must not contain a fragment");
  const jwks = environment.JOBSCOUT_OAUTH_JWKS_URL?.trim();
  const jwksUrl = jwks ? parseUrl(jwks, "JOBSCOUT_OAUTH_JWKS_URL") : undefined;
  if (jwksUrl) requireSecureUrl(jwksUrl, "JOBSCOUT_OAUTH_JWKS_URL", allowInsecure);
  const algorithms = list(environment.JOBSCOUT_OAUTH_ALGORITHMS, DEFAULT_ALGORITHMS);
  const mode = (environment.JOBSCOUT_OAUTH_MODE?.trim().toLowerCase() || "required") as OAuthMode;
  if (mode !== "required" && mode !== "optional") throw new OAuthConfigError("JOBSCOUT_OAUTH_MODE must be required or optional");
  if (algorithms.some((alg) => alg.toLowerCase() === "none" || alg.startsWith("HS"))) {
    throw new OAuthConfigError("JOBSCOUT_OAUTH_ALGORITHMS must list asymmetric algorithms only (no none, no HS*)");
  }
  return {
    mode,
    issuer,
    resourceUrl,
    audience: environment.JOBSCOUT_OAUTH_AUDIENCE?.trim() || resourceUrl.href,
    requiredScopes: list(environment.JOBSCOUT_OAUTH_SCOPES, DEFAULT_SCOPES),
    algorithms,
    jwksUrl,
    allowInsecure,
  };
}

/** RFC 8414 section 3: the well-known segment goes between the host and any issuer path. */
export function authorizationServerMetadataUrl(issuer: string): URL {
  const url = new URL(issuer);
  const path = url.pathname.replace(/\/+$/u, "");
  url.pathname = `${AUTHORIZATION_SERVER_METADATA_PATH}${path}`;
  url.search = "";
  url.hash = "";
  return url;
}

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? (value as string[]) : undefined;
}

/**
 * Check that the issuer's metadata describes an OAuth 2.1 server ChatGPT and other MCP clients
 * can use: authorisation code with PKCE S256 only, a way to register clients, and a JWKS.
 * Returns every problem at once so an operator can fix them in one pass.
 */
export function validateAuthorizationServerMetadata(metadata: unknown, config: Pick<OAuthConfig, "issuer" | "jwksUrl" | "allowInsecure">): OAuthMetadata {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new OAuthConfigError("authorisation server metadata is not a JSON object");
  }
  const meta = metadata as Record<string, unknown>;
  const problems: string[] = [];

  // RFC 8414 section 3.3: the issuer in the document must equal the one it was fetched for.
  if (meta.issuer !== config.issuer) problems.push(`issuer is ${JSON.stringify(meta.issuer)}, expected ${JSON.stringify(config.issuer)}`);

  const endpoints = ["authorization_endpoint", "token_endpoint", ...(config.jwksUrl ? [] : ["jwks_uri"])];
  for (const field of [...endpoints, "registration_endpoint"]) {
    const value = meta[field];
    if (value === undefined && field === "registration_endpoint") continue;
    if (typeof value !== "string") {
      problems.push(`${field} is missing`);
      continue;
    }
    try {
      requireSecureUrl(new URL(value), field, config.allowInsecure);
    } catch (error) {
      problems.push(error instanceof Error ? error.message : `${field} is not a valid URL`);
    }
  }

  const responseTypes = strings(meta.response_types_supported);
  if (!responseTypes?.includes("code")) problems.push("response_types_supported must include code");
  if (responseTypes?.some((type) => type !== "code")) problems.push("response_types_supported must not offer implicit or hybrid response types");

  // Absent grant_types_supported defaults to authorization_code and implicit (RFC 8414), and
  // OAuth 2.1 removes implicit, so the list must be explicit.
  const grants = strings(meta.grant_types_supported);
  if (!grants) problems.push("grant_types_supported must be stated explicitly");
  else {
    if (!grants.includes("authorization_code")) problems.push("grant_types_supported must include authorization_code");
    for (const removed of ["implicit", "password"]) if (grants.includes(removed)) problems.push(`grant_types_supported must not include ${removed}`);
  }

  const pkce = strings(meta.code_challenge_methods_supported);
  if (!pkce?.includes("S256")) problems.push("code_challenge_methods_supported must include S256");
  if (pkce?.includes("plain")) problems.push("code_challenge_methods_supported must not include plain");

  // ChatGPT registers itself: dynamic client registration or a client ID metadata document.
  if (typeof meta.registration_endpoint !== "string" && meta.client_id_metadata_document_supported !== true) {
    problems.push("registration_endpoint (RFC 7591) or client_id_metadata_document_supported is required so clients can register");
  }

  if (problems.length) throw new OAuthConfigError(`authorisation server metadata rejected: ${problems.join("; ")}`);
  return meta as unknown as OAuthMetadata;
}

/** Fetch and validate the issuer's metadata. Fails closed on any network, status or content problem. */
export async function discoverAuthorizationServer(
  config: Pick<OAuthConfig, "issuer" | "jwksUrl" | "allowInsecure">,
  fetchImpl: typeof fetch = fetch,
): Promise<OAuthMetadata> {
  const url = authorizationServerMetadataUrl(config.issuer);
  let response: Response;
  try {
    response = await fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS) });
  } catch (error) {
    throw new OAuthConfigError(`authorisation server metadata fetch failed for ${url.href}: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  if (!response.ok) throw new OAuthConfigError(`authorisation server metadata at ${url.href} returned HTTP ${response.status}`);
  const body: unknown = await response.json().catch(() => undefined);
  return validateAuthorizationServerMetadata(body, config);
}

function scopesOf(payload: JWTPayload): string[] {
  if (typeof payload.scope === "string") return payload.scope.split(" ").filter(Boolean);
  const scp = strings(payload.scp);
  return scp ?? [];
}

function invalidToken(message: string): OAuthError {
  return new OAuthError(OAuthErrorCode.InvalidToken, message);
}

/** JWT access-token verifier for the SDK's bearer-auth gate. */
export function createJwtVerifier(options: { issuer: string; audience: string; algorithms: string[]; keys: JWTVerifyGetKey; resourceUrl?: URL }): OAuthTokenVerifier {
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(token, options.keys, {
          issuer: options.issuer,
          audience: options.audience,
          algorithms: options.algorithms,
          typ: ACCESS_TOKEN_TYP,
          requiredClaims: ["exp", "sub"],
          clockTolerance: CLOCK_TOLERANCE_SECONDS,
        }));
      } catch (error) {
        if (error instanceof joseErrors.JWTExpired) throw invalidToken("token expired");
        if (error instanceof joseErrors.JWTClaimValidationFailed) throw invalidToken(`token claim invalid (${error.claim})`);
        if (error instanceof joseErrors.JWSSignatureVerificationFailed) throw invalidToken("token signature invalid");
        if (error instanceof joseErrors.JOSEError) throw invalidToken(`token rejected (${error.code})`);
        throw invalidToken("token could not be verified");
      }
      const clientId = typeof payload.client_id === "string" ? payload.client_id : typeof payload.azp === "string" ? payload.azp : "unknown";
      const info: AuthInfo = {
        token,
        clientId,
        scopes: scopesOf(payload),
        extra: { subject: payload.sub, ...(typeof payload.plan === "string" ? { plan: payload.plan } : {}) },
      };
      if (typeof payload.exp === "number") info.expiresAt = payload.exp;
      if (options.resourceUrl) info.resource = options.resourceUrl;
      return info;
    },
  };
}

export interface OAuthGuard {
  /** Answers the well-known discovery paths, or returns undefined for any other path. */
  metadataResponse(request: Request): Response | undefined;
  /** Verifies the bearer token: the request's AuthInfo, or the 401/403 challenge to return. */
  authenticate(request: Request): Promise<AuthInfo | Response>;
  readonly mode: OAuthMode;
  /** OpenAI Apps SDK per-tool auth declaration, merged into each tool's _meta. */
  readonly toolMeta: Record<string, unknown>;
  readonly resourceMetadataUrl: string;
  readonly protectedResourceMetadata: OAuthProtectedResourceMetadata;
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, mcp-protocol-version",
};

function documentResponse(request: Request, body: unknown): Response {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers: { ...CORS, allow: "GET, HEAD, OPTIONS", "content-type": "application/json" } });
  }
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...CORS, "content-type": "application/json", "cache-control": "public, max-age=300" },
  });
}

/** Build the guard from validated metadata and a key source. Synchronous, so tests can inject keys. */
export function createOAuthGuard(config: OAuthConfig, metadata: OAuthMetadata, keys: JWTVerifyGetKey): OAuthGuard {
  const protectedResourceMetadata: OAuthProtectedResourceMetadata = {
    ...buildOAuthProtectedResourceMetadata({
      oauthMetadata: metadata,
      resourceServerUrl: config.resourceUrl,
      scopesSupported: config.requiredScopes,
      resourceName: "JobScout",
      dangerouslyAllowInsecureIssuerUrl: config.allowInsecure,
    }),
    bearer_methods_supported: ["header"],
  };
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(config.resourceUrl);
  const suffixedPath = new URL(resourceMetadataUrl).pathname;
  const gate = requireBearerAuth({
    verifier: createJwtVerifier({ issuer: config.issuer, audience: config.audience, algorithms: config.algorithms, keys, resourceUrl: config.resourceUrl }),
    requiredScopes: config.requiredScopes,
    resourceMetadataUrl,
  });
  const oauth2 = { type: "oauth2", scopes: config.requiredScopes };
  const securitySchemes = config.mode === "optional" ? [{ type: "noauth" }, oauth2] : [oauth2];
  return {
    mode: config.mode,
    toolMeta: { securitySchemes },
    resourceMetadataUrl,
    protectedResourceMetadata,
    metadataResponse(request) {
      const path = new URL(request.url).pathname.replace(/\/+$/u, "");
      // Both the RFC 9728 path-suffixed location and the bare one, which some clients probe first.
      if (path === suffixedPath || path === PROTECTED_RESOURCE_METADATA_PATH) return documentResponse(request, protectedResourceMetadata);
      if (path === AUTHORIZATION_SERVER_METADATA_PATH) return documentResponse(request, metadata);
      return undefined;
    },
    authenticate: gate,
  };
}

/** Production wiring: discover the issuer, check its JWKS publishes keys, then build the guard. */
export async function initialiseOAuth(config: OAuthConfig, fetchImpl: typeof fetch = fetch): Promise<OAuthGuard> {
  const metadata = await discoverAuthorizationServer(config, fetchImpl);
  const jwksUrl = config.jwksUrl ?? new URL(String(metadata.jwks_uri));
  let keys: unknown;
  try {
    const response = await fetchImpl(jwksUrl, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    keys = ((await response.json()) as { keys?: unknown }).keys;
  } catch (error) {
    throw new OAuthConfigError(`JWKS fetch failed for ${jwksUrl.href}: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  if (!Array.isArray(keys) || keys.length === 0) throw new OAuthConfigError(`JWKS at ${jwksUrl.href} published no keys`);
  return createOAuthGuard(config, metadata, createRemoteJWKSet(jwksUrl, { cooldownDuration: 30_000, timeoutDuration: DISCOVERY_TIMEOUT_MS }));
}
