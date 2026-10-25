import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";

import { exportJWK, generateKeyPair, SignJWT } from "jose";

import type { JWK, JWTPayload } from "jose";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Test-only OAuth 2.1 authorisation server.
 *
 * It mirrors the contract of the operator's real issuer (the JobScout Pro account service): RFC
 * 8414 metadata, RFC 7591 public-client registration, authorisation code with PKCE S256 only,
 * ES256 `at+jwt` access tokens with `iss`, `aud`, `sub`, `exp`, `scope` and `plan`, and a JWKS.
 * Sign-in is replaced by a fixed test account, because the account system is not part of this
 * repository. It exists so the resource server can be tested end to end over real sockets.
 */

export interface TestIssuer {
  issuer: string;
  audience: string;
  metadata: Record<string, unknown>;
  /** Sign an access token directly, with optional claim and header overrides. */
  mint(claims?: JWTPayload, header?: { typ?: string; omitSubject?: boolean }): Promise<string>;
  close(): Promise<void>;
}

const b64url = (buffer: Buffer): string => buffer.toString("base64url");
export const pkceChallenge = (verifier: string): string => b64url(createHash("sha256").update(verifier).digest());
export const newVerifier = (): string => b64url(randomBytes(32));

interface Code {
  clientId: string;
  redirectUri: string;
  challenge: string;
  used: boolean;
}

export async function startTestIssuer(options: { audience?: string; metadataOverrides?: Record<string, unknown> } = {}): Promise<TestIssuer> {
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  const kid = "test-key-1";
  const publicJwk: JWK = { ...(await exportJWK(publicKey)), kid, alg: "ES256", use: "sig" };
  const clients = new Map<string, string[]>();
  const codes = new Map<string, Code>();
  const audience = options.audience ?? "mcp-host-gateway";

  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const metadata: Record<string, unknown> = {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    jwks_uri: `${issuer}/.well-known/jwks.json`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["jobscout"],
    ...options.metadataOverrides,
  };

  const mint = async (claims: JWTPayload = {}, header: { typ?: string; omitSubject?: boolean } = {}): Promise<string> => {
    const now = Math.floor(Date.now() / 1000);
    const jwt = new SignJWT({ scope: "jobscout", plan: "free", client_id: "cli_test", ...claims })
      .setProtectedHeader({ alg: "ES256", kid, typ: header.typ ?? "at+jwt" })
      .setIssuer(typeof claims.iss === "string" ? claims.iss : issuer)
      .setAudience(claims.aud ?? audience);
    if (!header.omitSubject) jwt.setSubject(typeof claims.sub === "string" ? claims.sub : "usr_test");
    return jwt
      .setIssuedAt(now)
      .setExpirationTime(typeof claims.exp === "number" ? claims.exp : now + 600)
      .sign(privateKey);
  };

  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };
  const readBody = async (req: IncomingMessage): Promise<string> => {
    let data = "";
    for await (const chunk of req) data += String(chunk);
    return data;
  };

  server.on("request", (req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", issuer);
      if (req.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") return send(res, 200, metadata);
      if (req.method === "GET" && url.pathname === "/.well-known/jwks.json") return send(res, 200, { keys: [publicJwk] });

      if (req.method === "POST" && url.pathname === "/oauth/register") {
        const body = JSON.parse(await readBody(req)) as { redirect_uris?: string[] };
        if (!Array.isArray(body.redirect_uris) || body.redirect_uris.length === 0) return send(res, 400, { error: "invalid_redirect_uri" });
        const clientId = `cli_${b64url(randomBytes(8))}`;
        clients.set(clientId, body.redirect_uris);
        return send(res, 201, { client_id: clientId, redirect_uris: body.redirect_uris, token_endpoint_auth_method: "none" });
      }

      if (req.method === "GET" && url.pathname === "/oauth/authorize") {
        const params = url.searchParams;
        const registered = clients.get(params.get("client_id") ?? "");
        const redirectUri = params.get("redirect_uri") ?? "";
        if (!registered?.includes(redirectUri)) return send(res, 400, { error: "invalid_request", error_description: "unknown client or redirect" });
        const back = new URL(redirectUri);
        const state = params.get("state");
        if (state) back.searchParams.set("state", state);
        const challenge = params.get("code_challenge") ?? "";
        if (params.get("response_type") !== "code") back.searchParams.set("error", "unsupported_response_type");
        else if (params.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/u.test(challenge)) back.searchParams.set("error", "invalid_request");
        else {
          // The real issuer signs the person in here (magic link). The test account is already signed in.
          const code = b64url(randomBytes(16));
          codes.set(code, { clientId: params.get("client_id") ?? "", redirectUri, challenge, used: false });
          back.searchParams.set("code", code);
        }
        res.writeHead(302, { location: back.href });
        return res.end();
      }

      if (req.method === "POST" && url.pathname === "/oauth/token") {
        const form = new URLSearchParams(await readBody(req));
        if (form.get("grant_type") !== "authorization_code") return send(res, 400, { error: "unsupported_grant_type" });
        const entry = codes.get(form.get("code") ?? "");
        if (!entry || entry.used) return send(res, 400, { error: "invalid_grant", error_description: "code is not valid" });
        entry.used = true;
        if (entry.clientId !== form.get("client_id") || entry.redirectUri !== form.get("redirect_uri")) return send(res, 400, { error: "invalid_grant" });
        if (pkceChallenge(form.get("code_verifier") ?? "") !== entry.challenge) return send(res, 400, { error: "invalid_grant", error_description: "PKCE verification failed" });
        const access = await mint({ client_id: entry.clientId });
        return send(res, 200, { access_token: access, token_type: "Bearer", expires_in: 600, scope: "jobscout" }, { "cache-control": "no-store" });
      }

      return send(res, 404, { error: "not_found" });
    })().catch(() => send(res, 500, { error: "server_error" }));
  });

  return {
    issuer,
    audience,
    metadata,
    mint,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
