# Hosted Streamable HTTP build of JobScout MCP. Local only until an operator deploys it.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
# Skip the `prepare` build hook until the sources are present.
RUN npm ci --ignore-scripts
COPY src ./src
RUN npx tsc -p tsconfig.json && npm prune --omit=dev --ignore-scripts

FROM node:22-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist/src ./dist/src
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/src/http-server.js"]
