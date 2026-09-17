import { createServer as createHttpServer } from "node:http";
import { pathToFileURL } from "node:url";

import { loadEnvironment } from "./config/environment.ts";
import { openRegistry, type Registry } from "./registry/database.ts";

export function createServer(registry: Registry) {
  return createHttpServer((request, response) => {
    let pathname: string;
    try {
      pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    } catch {
      response.writeHead(400);
      response.end();
      return;
    }

    if (request.method === "GET" && pathname === "/healthz") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }

    if (request.method === "GET" && pathname === "/readyz") {
      const ready = registry.isReady();
      if (ready) {
        response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ status: "ready" }));
        return;
      }

      response.writeHead(503, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ status: "not_ready" }));
      return;
    }

    response.writeHead(404);
    response.end();
  });
}

export function start(config = loadEnvironment(process.env)) {
  const registry = openRegistry(config.dataDirectory);
  const server = createServer(registry);
  server.listen(config.port, "0.0.0.0");

  return { server, registry };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const application = start();
  const stop = () => application.server.close(() => application.registry.close());

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
