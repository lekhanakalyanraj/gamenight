# The catalog service. Build from this directory: docker build services/catalog
# No dependencies yet: Node runs the TypeScript directly (type stripping).

FROM node:25-slim@sha256:81db02c4b671288a03915da9534dbd54f96d0e7c24d80ccc54f5b36b2e684370
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --chown=1000:1000 package.json ./
COPY --chown=1000:1000 src ./src
# The app never runs npm or corepack at runtime; removing them drops their dependencies' CVEs too.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
USER 1000
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s CMD ["node", "-e", "fetch('http://127.0.0.1:8080/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "--experimental-strip-types", "src/main.ts"]
