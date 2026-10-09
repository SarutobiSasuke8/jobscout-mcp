# Caddy with the per-IP rate limit module. Stock Caddy has no rate limiter, so this adds
# github.com/mholt/caddy-ratelimit (by Caddy's author) at a pinned commit. Bump both pins
# together and re-run the local load test (docs/DEPLOYMENT.md) before deploying.
ARG CADDY_VERSION=2.11.4
FROM caddy:${CADDY_VERSION}-builder AS build
RUN xcaddy build \
  --with github.com/mholt/caddy-ratelimit@5625512f24f6f59d6f64fb3aafe5eecff0b286db

FROM caddy:${CADDY_VERSION}
COPY --from=build /usr/bin/caddy /usr/bin/caddy
