import { createCatalogServer } from "./server.ts";

const port = Number(process.env.PORT ?? 8080);
const server = createCatalogServer().listen(port, () => {
  console.log(`catalog: health on :${port}; the catalogue API and MCP server arrive in slice 9`);
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
