ARG NODE_IMAGE=node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
FROM ${NODE_IMAGE} AS dependencies
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/backend/package.json apps/backend/package.json
COPY apps/frontend/package.json apps/frontend/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN npm ci

FROM dependencies AS build
COPY apps ./apps
COPY packages ./packages
RUN npm run build

# Disposable checks use the pinned application toolchain and matching Chromium.
FROM dependencies AS browser-dependencies
RUN npx playwright install --with-deps chromium

FROM browser-dependencies AS verification
COPY --from=build /app/apps ./apps
COPY --from=build /app/packages ./packages
COPY eslint.config.js playwright.config.ts tsconfig.e2e.json ./
COPY e2e ./e2e
ENV NODE_ENV=test DEPLOYMENT_PROFILE=test AUTH_MODE=TEST_USER REQUIRE_TEST_DATABASE=1
CMD ["npm", "run", "verify:ci"]

# Run migrations and the explicit bootstrap command from this separate image.
FROM build AS migrator
ENV NODE_ENV=production
USER node
CMD ["npm", "run", "migrate:deploy"]

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
COPY package.json package-lock.json ./
COPY apps/backend/package.json apps/backend/package.json
COPY apps/frontend/package.json apps/frontend/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN npm ci --omit=dev --omit=optional && npm cache clean --force
COPY --from=build /app/apps/backend/dist ./apps/backend/dist
COPY --from=build /app/apps/frontend/dist ./apps/frontend/dist
COPY --from=build /app/packages/contracts/dist ./packages/contracts/dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/backend/dist/server.js"]
