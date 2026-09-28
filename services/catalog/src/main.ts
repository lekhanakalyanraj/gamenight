import { postgresGames } from "./games.ts";
import { createCatalogServer } from "./server.ts";

const port = Number(process.env.PORT ?? 8080);
const databaseUrl = process.env.CATALOG_DATABASE_URL;
const serviceToken = process.env.CATALOG_SERVICE_TOKEN;
const deps = databaseUrl && serviceToken ? { games: postgresGames(databaseUrl), serviceToken } : undefined;

const server = createCatalogServer(deps).listen(port, () => {
  console.log(`catalog on :${port}${deps ? " (games API enabled)" : " (health only: set CATALOG_DATABASE_URL and CATALOG_SERVICE_TOKEN)"}`);
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
