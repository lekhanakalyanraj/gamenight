# The web app as a self-contained Next.js server. Build from the repo root:
#   docker build -f apps/web/Dockerfile .
# Configuration (SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, ...) is read at runtime, so one image runs anywhere.

FROM node:25-slim@sha256:81db02c4b671288a03915da9534dbd54f96d0e7c24d80ccc54f5b36b2e684370 AS build
WORKDIR /repo
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY packages/db-types/package.json packages/db-types/
# Only the web app's dependencies; scripts off (nothing here needs them, and it skips the Supabase CLI download).
RUN npm ci --workspace @gamenight/web --include-workspace-root=false --ignore-scripts
COPY packages/db-types packages/db-types
COPY apps/web apps/web
RUN npm run build --workspace @gamenight/web

FROM node:25-slim@sha256:81db02c4b671288a03915da9534dbd54f96d0e7c24d80ccc54f5b36b2e684370
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3100 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=1000:1000 /repo/apps/web/.next/standalone ./
COPY --from=build --chown=1000:1000 /repo/apps/web/.next/static ./apps/web/.next/static
# The app never runs npm or corepack at runtime; removing them drops their dependencies' CVEs too.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
USER 1000
EXPOSE 3100
HEALTHCHECK --interval=15s --timeout=3s CMD ["node", "-e", "fetch('http://127.0.0.1:3100/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "apps/web/server.js"]
