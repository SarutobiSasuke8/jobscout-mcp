# Remote deployment (Streamable HTTP)

JobScout can run as a hosted MCP server over Streamable HTTP, in addition to the local stdio server. This page covers the entrypoint, the container, the single-VPS hosting recipe in [`deploy/`](../deploy) for JobScout Discover at `https://jobscout.mcprack.dev`, and the operator runbook. Nothing here deploys anything: the host name is a placeholder until its DNS record exists.

## Entrypoint

```bash
npm run build
PORT=8080 JOBSCOUT_ENABLE_HIMALAYAS=true npm run start:http
```

The installed package also provides the `jobscout-mcp-http` binary.

| Path | Method | Behaviour |
|---|---|---|
| `/health` | GET, HEAD | `200` with `{"status":"ok","name":"jobscout-mcp","version":"...","transport":"streamable-http"}`. Never requires a token. |
| `/mcp` | POST | MCP over Streamable HTTP, answered with a plain JSON response. |
| `/mcp` | GET, DELETE | `405`. The server is stateless: no session to resume or delete. |
| anything else | any | `404`. |

Design choices:

- **Stateless.** Each request builds a fresh server and transport. JobScout holds no profile or session, so replicas are interchangeable and nothing is kept between requests.
- **JobSpy is always off when hosted.** It scrapes from the host's own address and is for a user's own machine. `JOBSCOUT_ENABLE_JOBSPY` is forced to `false` by the HTTP entrypoint.
- **Body limit** of 1 MiB per request in the app. The proxy applies a tighter cap (below).
- **Loopback by default.** `HOST` defaults to `127.0.0.1`. The Dockerfile sets `0.0.0.0` so the container is reachable.

### App configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | Listen port |
| `HOST` | `127.0.0.1` | Listen address |
| `JOBSCOUT_HTTP_BEARER_TOKEN` | unset | If set, `/mcp` needs `Authorization: Bearer <token>`. For a private deployment only, never for the anonymous public service. Supply it from the host's secret store, never from the repository. |
| `JOBSCOUT_ENABLE_*` and provider URLs | see `.env.example` | Choose which sources are active |

## Hosting recipe (single VPS)

```
client (ChatGPT, Codex, Claude, curl)
   │  HTTPS :443 (HTTP :80 only redirects and answers ACME)
   ▼
caddy   TLS, per-IP rate limits, request-size cap, /privacy /terms /, access logs
   │  HTTP on the private compose network
   ▼
jobscout   the existing Dockerfile, port 8080, not published on the host
```

### Files

| File | Purpose |
|---|---|
| `deploy/compose.yaml` | Two services: `jobscout` (built from the root `Dockerfile`) and `caddy` (built from `deploy/caddy/Dockerfile`). Volumes `caddy_data` and `caddy_config` hold certificates and ACME state. |
| `deploy/Caddyfile` | Routes, limits, health listener, page rendering. Every tunable is an environment variable with a default. |
| `deploy/caddy/Dockerfile` | Caddy 2.11.4 plus `github.com/mholt/caddy-ratelimit` at a pinned commit. |
| `deploy/site/` | `index.html` (landing), `privacy.html`, `terms.html`. The last two render `docs/discover/privacy.md` and `terms.md` at request time, so the published policy is always the text in the repository. |
| `deploy/.env.example` | Production settings. Copy to `deploy/.env` on the server. |
| `deploy/local.env` | Local trial settings: plain HTTP on port 8088 and a low rate limit. |
| `deploy/scripts/check-endpoint.mjs` | External operator check (`npm run deploy:check -- <url>`). |
| `deploy/scripts/load-test.mjs` | Rate-limit and size-cap load script (`npm run deploy:load -- <url> ...`). |

### Why Caddy, not nginx plus certbot

- **Certificates are built in.** Caddy obtains and renews Let's Encrypt certificates itself, with OCSP stapling and an HTTP to HTTPS redirect, from nothing more than the host name. nginx needs a certbot container or cron job, a bootstrap step (nginx cannot start its TLS server block before the first certificate exists) and a reload hook after each renewal. For a single VPS run by one operator, fewer moving parts is the main safety property.
- **One small config.** Routes, limits, health and page rendering fit in one Caddyfile with environment-driven defaults, which the tests check against this page.
- **The public pages need no build step.** Caddy's `templates` and `markdown` render the policy drafts straight from `docs/discover/`.
- **The trade-off:** stock Caddy has no rate limiter, so the image adds the `caddy-ratelimit` module (maintained by Caddy's author) through `xcaddy`, pinned to a commit. nginx's `limit_req` is built in. A custom build is a smaller ongoing cost than certificate plumbing, and the image build is two lines.

### Limits

Per-IP limits use a sliding window keyed on the client address (`{client_ip}`). Over the limit, Caddy answers `429 Too Many Requests` with a `Retry-After` header and the request never reaches the app. A body over the cap gets `413`.

| Setting | Default | Applies to |
|---|---|---|
| `JOBSCOUT_MCP_RATE_EVENTS` | `60` | Requests per window per IP on `/mcp` |
| `JOBSCOUT_MCP_RATE_WINDOW` | `1m` | Window for the `/mcp` limit |
| `JOBSCOUT_MCP_MAX_BODY` | `64KB` | Largest accepted `/mcp` request body |
| `JOBSCOUT_SITE_RATE_EVENTS` | `120` | Requests per window per IP on `/health`, `/`, `/privacy`, `/terms` (each route has its own zone) |
| `JOBSCOUT_SITE_RATE_WINDOW` | `1m` | Window for the page and health limits |

Pages and `/health` also cap bodies at 1 KB. Caddy itself times out slow headers (10 s), slow bodies (30 s) and idle connections (2 min), and waits up to 90 s for the app to start answering a search.

Why these numbers: one search tool call can fan out to every enabled job source, so `/mcp` is the expensive route. 60 calls a minute is far above what one person's assistant session makes, and low enough that a single address cannot push sustained load onto the sources. 64 KB is many times the largest legitimate tool call (search parameters are a few hundred bytes), and well under the app's own 1 MiB limit.

**Shared addresses.** ChatGPT and other hosted assistants call the server from their own platform addresses, so many users can share one IP. Watch the access log for `429` on `/mcp` after launch. If real traffic hits the limit, raise `JOBSCOUT_MCP_RATE_EVENTS` in `deploy/.env` and run `docker compose up -d caddy`. Per-user limits need identity, which is the job of `mcp-host-gateway` (below), not of the anonymous edge.

### Health checks

| Check | What it proves | How |
|---|---|---|
| App container | The Node server answers `/health` | `HEALTHCHECK` in the root `Dockerfile`, every 30 s. Compose starts Caddy only once this is healthy. |
| Proxy container | Caddy is up, independent of the app | `wget http://127.0.0.1:2020/healthz` inside the Caddy container (loopback listener, not published). |
| Proxy route | TLS, routing and the app together | `GET https://jobscout.mcprack.dev/health` is proxied to the app's `/health`. Caddy also polls the upstream `/health` every 30 s. |
| External | The whole public surface, from outside | `npm run deploy:check -- https://jobscout.mcprack.dev` (health, `/`, `/privacy`, `/terms`, MCP `initialize` and `tools/list`, the 405 and 404 cases, certificate days left; exit code 1 on any failure, so it can run from cron or an uptime monitor). |

`docker compose ps` shows both health states.

### Local trial without a domain

Plain HTTP behind the documented flag (`JOBSCOUT_SITE_ADDRESS=:80` in `deploy/local.env`):

```bash
cd deploy
docker compose --env-file local.env up --build
# in another shell, from the repository root
npm run deploy:check -- http://localhost:8088
npm run deploy:load -- http://localhost:8088 --requests 40 --expect-limit 20
npx -y @modelcontextprotocol/inspector@2.1.0 --cli http://localhost:8088/mcp --transport http --method tools/list
```

For TLS from Caddy's internal CA instead, set `JOBSCOUT_SITE_ADDRESS=localhost` and use `https://localhost:8443` with `--insecure` on the scripts. The load test fails unless exactly the configured number of calls succeed and every other call gets `429` with `Retry-After`; it also sends one 128 KB body and expects `413`. Run it against a fresh proxy (the window is sliding) and never against a production host other people are using.

Without Docker, the same Caddyfile runs against the Node server directly:

```bash
npm run build
PORT=8099 node dist/src/http-server.js &
JOBSCOUT_SITE_ADDRESS=:8088 JOBSCOUT_UPSTREAM=127.0.0.1:8099 \
JOBSCOUT_SITE_ROOT=./deploy/site JOBSCOUT_CONTENT_ROOT=./docs/discover \
JOBSCOUT_MCP_RATE_EVENTS=20 caddy run --config deploy/Caddyfile --adapter caddyfile
```

`caddy` here must be a build with the rate-limit module: `xcaddy build v2.11.4 --with github.com/mholt/caddy-ratelimit@5625512f24f6f59d6f64fb3aafe5eecff0b286db`.

### Optional: fronting with mcp-host-gateway

The default anonymous path is Caddy alone, because [mcp-host-gateway](https://github.com/SarutobiSasuke8/mcp-host-gateway) requires a bearer token on every call and ChatGPT directory users will not have one. For signed-in or paid access later, run the gateway as a third service on the same compose network and give it its own route, leaving `/mcp` anonymous:

```caddyfile
handle_path /gateway/* {
	reverse_proxy gateway:8787
}
```

with the gateway's upstream set to `http://jobscout:8080/mcp` and its `tools_allow` list using the real tool names from `tools/list` (`jobscout_search_jobs`, `jobscout_list_sources` and so on). The gateway then does per-identity limits and entitlement, and Caddy keeps TLS and the per-IP backstop. The port and config shape come from the gateway's own README; check them there before wiring it in. Not part of this recipe and not tested here.

## Operator runbook

All values below are placeholders. No secrets are needed for the anonymous service; keep `deploy/.env` out of git.

### 1. DNS record

Add one record at the DNS provider for `mcprack.dev`:

| Type | Name | Value | TTL |
|---|---|---|---|
| `A` | `jobscout` | `<VPS IPv4 address>` | 300 |
| `AAAA` (only if the VPS has IPv6 and the firewall allows it) | `jobscout` | `<VPS IPv6 address>` | 300 |

If the zone uses a CDN proxy (for example an orange-cloud setting), turn it off for this record: Caddy needs direct HTTP-01 or TLS-ALPN-01 reachability to issue the certificate, and per-IP limits would otherwise see the CDN's addresses. Check propagation with `dig +short jobscout.mcprack.dev`.

### 2. First boot

On a VPS with Docker Engine and the compose plugin, ports 80 and 443 (TCP) and 443 (UDP, optional, for HTTP/3) open to the internet:

```bash
git clone https://github.com/SarutobiSasuke8/jobscout-mcp.git
cd jobscout-mcp
git checkout <release tag or reviewed commit>
cd deploy
cp .env.example .env        # edit sources and limits; set JOBSCOUT_IMAGE_TAG to the tag above
docker compose up -d --build
docker compose ps           # both services should reach "healthy"
```

### 3. Certificates

Issuance is automatic on first boot once DNS resolves to the VPS: Caddy requests a Let's Encrypt certificate for `JOBSCOUT_SITE_ADDRESS` and renews it about 30 days before expiry. Watch it happen with `docker compose logs -f caddy` (look for `certificate obtained successfully`). Certificates and the ACME account live in the `caddy_data` volume; back it up, and never delete it casually, because repeated re-issuance can hit Let's Encrypt rate limits. No contact email is configured; to add one, put `email <address>` in the global block of the Caddyfile. Then confirm from outside:

```bash
npm run deploy:check -- https://jobscout.mcprack.dev
npm run check:plugin -- --live
```

### 4. Upgrade

```bash
cd jobscout-mcp
git fetch --tags
git checkout <new tag>
cd deploy
sed -i 's/^JOBSCOUT_IMAGE_TAG=.*/JOBSCOUT_IMAGE_TAG=<new tag>/' .env
docker compose up -d --build
npm run deploy:check -- https://jobscout.mcprack.dev
```

Changing only limits or pages needs no rebuild: edit `deploy/.env` or `deploy/site/` and run `docker compose up -d caddy` (or `docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile` for a Caddyfile-only change).

### 5. Rollback

Images are tagged by `JOBSCOUT_IMAGE_TAG`, so the previous build stays on the host until pruned.

```bash
cd jobscout-mcp
git checkout <previous tag>
cd deploy
sed -i 's/^JOBSCOUT_IMAGE_TAG=.*/JOBSCOUT_IMAGE_TAG=<previous tag>/' .env
docker compose up -d          # reuses the existing image; add --build if it was pruned
npm run deploy:check -- https://jobscout.mcprack.dev
```

To take the service offline entirely: `docker compose down` (keeps the certificate volume). The plugin manifest URLs will then fail, which is visible to directory reviewers, so prefer rolling back.

### 6. Logs

| What | Where | Retention |
|---|---|---|
| Caddy access log (JSON: time, client IP, method, path, status, duration; `Authorization` redacted, bodies never logged) | `docker compose logs caddy` | Docker `json-file` driver, 5 files of 10 MB per container |
| App log (startup line, errors) | `docker compose logs jobscout` | Same rotation |
| Certificate events | `docker compose logs caddy` | Same rotation |

On disk the files are under `/var/lib/docker/containers/<id>/`. Search terms travel in POST bodies, so they do not appear in access logs. Client IP addresses do; state the retention above in the privacy policy (`docs/discover/privacy.md`, "Retention") before publication.

## Container only

```bash
docker build -t jobscout-mcp .
docker run --rm -p 8080:8080 -e JOBSCOUT_ENABLE_HIMALAYAS=true jobscout-mcp
curl http://localhost:8080/health
```

The image runs as the unprivileged `node` user and has a health check against `/health`.

## Local test of the app alone

```bash
npm run build
PORT=8099 node dist/src/http-server.js &
curl -s localhost:8099/health
curl -s -X POST localhost:8099/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Automated coverage is in `test/remote-http.test.ts` (health, routing, initialise, tool listing, the 405 cases, malformed bodies, bearer-token gating, the JobSpy override, a real-socket round trip) and `test/deploy-config.test.ts` (the limits on this page match the Caddyfile, compose and `.env.example` defaults; `/mcp` is limited before it is proxied; the pages and their sources exist; the app is not published on the host).

## Gaps before this is public

| Gap | Needed |
|---|---|
| DNS and deployment | The `jobscout.mcprack.dev` record and a VPS running this recipe. Not done. |
| Docker run of the recipe | The compose stack has not yet been brought up with Docker. The proxy config was run with a locally built Caddy against the Node server (see the pull request that added `deploy/`). |
| Domain verification | Done in the OpenAI submission portal against the live domain. |
| OAuth | A registered client and an authorisation server for existing-account sign-in. The anonymous service has no accounts. |
| Policy text | `docs/discover/privacy.md` and `terms.md` are drafts with placeholders and are served as such. They need the operator's details, the log retention above and legal review. |
| Server registry entry | `server.json` lists only the npm package. A `remotes` entry needs the live URL. |
