# SessionWoy local backend (Phase 4d). Multi-arch (arm64 / amd64).
# bookworm-slim (glibc) so better-sqlite3's prebuilt native binary works; build tools are only in the
# build stage, as a fallback in case no prebuilt binary matches.
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY migrations ./migrations
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
EXPOSE 3004
HEALTHCHECK --interval=10s --timeout=3s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3004)+'/health',{headers:{host:'127.0.0.1:'+(process.env.PORT||3004)}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
