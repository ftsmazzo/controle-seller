# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-alpine AS app
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
RUN addgroup -S app && adduser -S app -G app
COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
COPY --from=build --chown=app:app /app/public ./public
USER app
EXPOSE 3000
CMD ["node", "server.js"]

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

# Imagem operacional única: o EasyPanel reutiliza o mesmo artefato para
# app e worker. O serviço app roda migrations no start e sobe o Next.js.
# O worker sobrescreve o comando com `npm run worker` (sem este entrypoint).
FROM app AS runtime
USER root
COPY --from=deps --chown=app:app /app/node_modules ./node_modules
COPY --chown=app:app package.json tsconfig.json ./
COPY --chown=app:app src ./src
COPY --chown=app:app scripts ./scripts
COPY --chown=app:app migrations ./migrations
COPY --chown=app:app scripts/docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh
USER app
CMD ["/app/docker-entrypoint.sh"]
