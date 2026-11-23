FROM node:22.22.2-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src/ ./src/
COPY scripts/ ./scripts/
COPY contracts/ ./contracts/
COPY migrations/ ./migrations/
RUN npm run build && npm prune --omit=dev

FROM node:22.22.2-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production HOST=:: PORT=4000

COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules/ ./node_modules/
COPY --from=build --chown=node:node /app/dist/ ./dist/
COPY --from=build --chown=node:node /app/contracts/ ./contracts/
COPY --from=build --chown=node:node /app/migrations/ ./migrations/

USER node
EXPOSE 4000
CMD ["node", "dist/src/index.js"]
