import { createServer, type Server } from "node:http";

/** The catalog's HTTP server. For now it only reports healthy; slice 9 adds the catalogue API and MCP. */
export function createCatalogServer(): Server {
  return createServer((request, response) => {
    if (request.method === "GET" && request.url === "/healthz") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ status: "ok", service: "catalog" }));
      return;
    }
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
  });
}
