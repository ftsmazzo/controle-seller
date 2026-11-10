# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM deps AS worker
WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src
USER node
CMD ["npm", "run", "worker"]

FROM deps AS migrate
WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY migrations ./migrations
USER node
CMD ["npm", "run", "migrate"]

# Imagem única usada pelo EasyPanel (app + worker no mesmo artefato).
# Mesmo com comando forçado `node server.js`, o wrapper ESM aplica migrations.
FROM node:22-alpine AS app
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
RUN addgroup -S app && adduser -S app -G app
COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
COPY --from=build --chown=app:app /app/public ./public
COPY --from=deps --chown=app:app /app/node_modules ./node_modules
COPY --chown=app:app package.json tsconfig.json ./
COPY --chown=app:app src ./src
COPY --chown=app:app scripts ./scripts
COPY --chown=app:app migrations ./migrations
USER root
# CACHE_BUST força o EasyPanel a reconstruir esta camada (evita server.js CJS antigo).
ARG CACHE_BUST=2026-03-10-login-fix
RUN echo "cache_bust=${CACHE_BUST}" \
  && test -f /app/scripts/server-with-migrate.mjs \
  && mv /app/server.js /app/server.next.js \
  && cp /app/scripts/server-with-migrate.mjs /app/server.js \
  && grep -q "import { spawnSync }" /app/server.js \
  && grep -qv "require('node:child_process')" /app/server.js \
  && cp /app/scripts/docker-entrypoint.sh /app/docker-entrypoint.sh \
  && chmod +x /app/docker-entrypoint.sh \
  && chown app:app /app/server.js /app/server.next.js /app/docker-entrypoint.sh
USER app
EXPOSE 3000
CMD ["node", "server.js"]

FROM app AS runtime
CMD ["node", "server.js"]
