# Multi-arch (arm64 / amd64) image for the SessionWoy Phase 1 test server.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3003
HEALTHCHECK --interval=10s --timeout=3s CMD wget -qO- http://127.0.0.1:${PORT:-3003}/health || exit 1
CMD ["node", "dist/server.js"]
