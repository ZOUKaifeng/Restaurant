FROM node:22.22.2-bookworm-slim AS build
WORKDIR /workspace/frontend

COPY frontend/package.json frontend/package-lock.json ./
COPY frontend/index.html frontend/tsconfig.json frontend/vite.config.ts ./
COPY frontend/src/ ./src/
COPY frontend/public/ ./public/
COPY backend/src/billing-types.ts backend/src/ai-usage-types.ts /workspace/backend/src/
RUN npm ci && npm run build

FROM caddy:2.10.2-alpine AS runtime
ENV PORT=8080
COPY frontend/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /workspace/frontend/dist/ /srv/
EXPOSE 8080
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
