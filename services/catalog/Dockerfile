# The catalog service. Build from the repo root (it installs from the workspace lockfile):
#   docker build -f services/catalog/Dockerfile .
# Node runs the TypeScript directly (type stripping), so there's no build step.

FROM node:22-trixie-slim@sha256:b26b04c123d9ff8ab646ceb18b9d75a1173acf64b9a401094b906d27b29338d4 AS deps
WORKDIR /repo
COPY package.json package-lock.json ./
COPY services/catalog/package.json services/catalog/
RUN npm ci --workspace @gamenight/catalog --include-workspace-root=false --omit=dev --ignore-scripts

FROM node:22-trixie-slim@sha256:b26b04c123d9ff8ab646ceb18b9d75a1173acf64b9a401094b906d27b29338d4
# Debian's security updates, so a fix published after the base image was built still ships (the image scan
# fails on any fixable high or critical vulnerability; upstream rebuilds can take days).
RUN apt-get update && apt-get upgrade -y --no-install-recommends && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=deps --chown=1000:1000 /repo/node_modules ./node_modules
COPY --chown=1000:1000 services/catalog/package.json ./
COPY --chown=1000:1000 services/catalog/src ./src
# The app never runs npm, corepack or yarn at runtime; removing them drops their dependencies' CVEs too.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
           /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg
USER 1000
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s CMD ["node", "-e", "fetch('http://127.0.0.1:8080/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "--experimental-strip-types", "src/main.ts"]
