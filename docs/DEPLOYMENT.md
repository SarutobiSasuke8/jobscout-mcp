# Remote deployment (Streamable HTTP)

JobScout can run as a hosted MCP server over Streamable HTTP, in addition to the local stdio server. This page covers the entrypoint, the container, local testing and the gaps that stop it being a public service. Nothing here deploys anything.

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
- **Body limit** of 1 MiB per request.
- **Loopback by default.** `HOST` defaults to `127.0.0.1`. The Dockerfile sets `0.0.0.0` so the container is reachable.

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | Listen port |
| `HOST` | `127.0.0.1` | Listen address |
| `JOBSCOUT_HTTP_BEARER_TOKEN` | unset | If set, `/mcp` needs `Authorization: Bearer <token>`. For a private deployment only. Supply it from the host's secret store, never from the repository. |
| `JOBSCOUT_ENABLE_*` and provider URLs | see `.env.example` | Choose which sources are active |

## Container

```bash
docker build -t jobscout-mcp .
docker run --rm -p 8080:8080 -e JOBSCOUT_ENABLE_HIMALAYAS=true jobscout-mcp
curl http://localhost:8080/health
```

The image runs as the unprivileged `node` user and has a health check against `/health`. The Dockerfile was written but its build was **not run** in the session that produced it, because the Docker daemon was not running. Build it once before relying on it. The same server was tested directly with Node (see below).

## Local test

```bash
npm run build
PORT=8099 node dist/src/http-server.js &
curl -s localhost:8099/health
curl -s -X POST localhost:8099/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Automated coverage is in `test/remote-http.test.ts`: health, routing, initialise, tool listing, a search with no sources enabled, the 405 cases, malformed bodies, bearer-token gating, the JobSpy override, and a real-socket round trip.

## Gaps before this can be public

These need things that cannot be created from the repository, and none are faked here.

| Gap | Needed |
|---|---|
| Public HTTPS URL | A domain, DNS and a TLS-terminating host or platform. Not registered, not deployed. |
| Domain verification | Done in the OpenAI submission portal against the live domain. |
| OAuth | A registered client and an authorisation server for existing-account sign-in. The only control today is the optional shared bearer token. |
| Rate limiting and abuse controls | Not built. Put a gateway or platform limiter in front of the service. |
| Origin and Host checks | The SDK marks its built-in DNS-rebinding options as deprecated in favour of middleware. Apply them at the gateway. |
| Logging policy | Decide log retention and align the [privacy policy](discover/privacy.md). |
| Server registry entry | `server.json` lists only the npm package. A `remotes` entry needs the live URL. |
