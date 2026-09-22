import { timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";

import { loadEnvironment } from "./config/environment.ts";
import { loadRepositories } from "./config/repositories.ts";
import { createGraphifyClient } from "./graphify/client.ts";
import { openApiDocument, swaggerUiAssets, swaggerUiHtml, swaggerUiInitializer } from "./openapi.ts";
import { runCommand } from "./process/run.ts";
import { createRepositoryService, type SearchOutcome } from "./repositories/service.ts";
import { openRegistry, type Registry } from "./registry/database.ts";

const MAX_BODY_BYTES = 16 * 1024;

type RepositorySearch = Readonly<{
  search(query: string, repositoryIds?: readonly string[], signal?: AbortSignal): Promise<SearchOutcome>;
}>;

type ServerDependencies = Readonly<{
  registry: Registry;
  repositories: RepositorySearch;
  apiToken: string;
  isGraphifyReady: () => boolean | Promise<boolean>;
}>;

export function createReadinessProbe(check: () => void | Promise<void>, ttlMs = 5_000, now = Date.now) {
  let expiresAt = 0;
  let cached = false;
  let checking: Promise<boolean> | undefined;
  return async (): Promise<boolean> => {
    if (now() < expiresAt) return cached;
    checking ??= Promise.resolve().then(check).then(
      () => true,
      () => false,
    ).then((result) => {
      cached = result;
      expiresAt = now() + ttlMs;
      return result;
    }).finally(() => { checking = undefined; });
    return checking;
  };
}

class RequestError extends Error {
  readonly status: number;

  constructor(status: number) {
    super("요청이 올바르지 않음");
    this.status = status;
  }
}

function writeJson(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

function writeDocument(response: ServerResponse, contentType: string, body: string | Buffer, cacheControl = "no-store") {
  response.writeHead(200, {
    "cache-control": cacheControl,
    "content-type": contentType,
    "content-security-policy": "default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self' 'unsafe-inline'",
  });
  response.end(body);
}

function writeRequestError(response: ServerResponse, status: number) {
  writeJson(response, status, { error: { code: "INVALID_REQUEST", message: "요청이 올바르지 않음", retryable: false } });
}

function authenticate(request: IncomingMessage, response: ServerResponse, apiToken: string): boolean {
  const header = request.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    writeJson(response, 401, { error: { code: "AUTHENTICATION_REQUIRED", message: "인증이 필요함", retryable: false } });
    return false;
  }
  const actual = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(apiToken);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    writeJson(response, 403, { error: { code: "AUTHENTICATION_FAILED", message: "인증에 실패함", retryable: false } });
    return false;
  }
  return true;
}

function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const declaredSize = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredSize) && declaredSize > MAX_BODY_BYTES) {
    request.pause();
    return Promise.reject(new RequestError(413));
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const finish = (error?: Error, body?: unknown) => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("aborted", onAborted);
      if (error) reject(error);
      else resolve(body);
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        request.pause();
        finish(new RequestError(413));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      try {
        finish(undefined, JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        finish(new RequestError(400));
      }
    };
    const onError = () => finish(new RequestError(400));
    const onAborted = () => finish(new RequestError(400));
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    request.once("aborted", onAborted);
  });
}

function validateSearch(value: unknown): { query: string; repositoryIds?: string[] } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new RequestError(400);
  const { query, repositoryIds } = value as Record<string, unknown>;
  if (typeof query !== "string" || query.trim() === "" || query.length > 1_000) throw new RequestError(400);
  if (repositoryIds === undefined) return { query };
  if (!Array.isArray(repositoryIds) || repositoryIds.some((id) => typeof id !== "string")) {
    throw new RequestError(400);
  }
  const uniqueIds = [...new Set(repositoryIds)];
  if (uniqueIds.length > 64) throw new RequestError(400);
  return { query, repositoryIds: uniqueIds };
}

function unavailable(outcome: SearchOutcome) {
  const codes = [...new Set(outcome.warnings.map(({ code }) => code))];
  const code = codes.length === 1 ? codes[0]! : "SEARCH_UNAVAILABLE";
  const warning = codes.length === 1 ? outcome.warnings[0] : undefined;
  return {
    error: {
      code,
      message: warning?.message ?? "코드 그래프 검색을 완료할 수 없음",
      retryable: code !== "REPOSITORY_NOT_FOUND" && code !== "SEARCH_ABORTED",
    },
    warnings: outcome.warnings,
  };
}

export function createServer(dependencies: ServerDependencies) {
  return createHttpServer(async (request, response) => {
    let pathname: string;
    try {
      pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    } catch {
      writeRequestError(response, 400);
      return;
    }

    if (request.method === "GET" && pathname === "/") {
      response.writeHead(308, { location: "/docs/" });
      response.end();
      return;
    }
    if (request.method === "GET" && pathname === "/healthz") {
      writeJson(response, 200, { status: "ok" });
      return;
    }
    if (request.method === "GET" && pathname === "/readyz") {
      const ready = dependencies.registry.isReady() && await dependencies.isGraphifyReady();
      writeJson(response, ready ? 200 : 503, { status: ready ? "ready" : "not_ready" });
      return;
    }
    if (request.method === "GET" && pathname === "/openapi.json") {
      writeJson(response, 200, openApiDocument);
      return;
    }
    if (request.method === "GET" && pathname === "/docs") {
      response.writeHead(308, { location: "/docs/" });
      response.end();
      return;
    }
    if (request.method === "GET" && pathname === "/docs/") {
      writeDocument(response, "text/html; charset=utf-8", swaggerUiHtml);
      return;
    }
    if (request.method === "GET" && pathname === "/docs/swagger-initializer.js") {
      writeDocument(response, "text/javascript; charset=utf-8", swaggerUiInitializer);
      return;
    }
    const swaggerAsset = request.method === "GET" ? swaggerUiAssets.get(pathname) : undefined;
    if (swaggerAsset) {
      writeDocument(response, swaggerAsset.contentType, swaggerAsset.body, "public, max-age=86400");
      return;
    }
    const protectedRoute = (request.method === "GET" && pathname === "/repositories")
      || (request.method === "POST" && pathname === "/search");
    if (!protectedRoute) {
      response.writeHead(404);
      response.end();
      return;
    }
    if (!authenticate(request, response, dependencies.apiToken)) return;
    if (request.method === "GET" && pathname === "/repositories") {
      writeJson(response, 200, { repositories: dependencies.registry.listRepositories() });
      return;
    }

    const controller = new AbortController();
    const abort = () => controller.abort();
    request.once("aborted", abort);
    request.once("close", () => { if (!request.complete) abort(); });
    response.once("close", () => { if (!response.writableEnded) abort(); });
    try {
      const input = validateSearch(await readJsonBody(request));
      const outcome = await dependencies.repositories.search(input.query, input.repositoryIds, controller.signal);
      if (outcome.results.length === 0) {
        writeJson(response, 503, unavailable(outcome));
        return;
      }
      writeJson(response, 200, { query: input.query, ...outcome });
    } catch (error) {
      if (error instanceof RequestError) writeRequestError(response, error.status);
      else writeJson(response, 503, { error: { code: "SEARCH_UNAVAILABLE", message: "코드 그래프 검색을 완료할 수 없음", retryable: true } });
    } finally {
      request.off("aborted", abort);
    }
  });
}

export type Application = Readonly<{ server: ReturnType<typeof createHttpServer>; registry: Registry }>;

export async function start(config = loadEnvironment(process.env)): Promise<Application> {
  const repositories = loadRepositories(config.repositoriesFile);
  const registry = openRegistry(config.dataDirectory);
  try {
    registry.reconcile(repositories);
    const graphify = createGraphifyClient(config.graphifyBinary);
    const isGraphifyReady = createReadinessProbe(() => graphify.check());
    const server = createServer({
      registry,
      repositories: createRepositoryService({ registry, graphify, dataDirectory: config.dataDirectory, runCommand, maxConcurrentQueries: config.maxConcurrentQueries }),
      apiToken: config.apiToken,
      isGraphifyReady,
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, "0.0.0.0", () => {
        server.off("error", reject);
        resolve();
      });
    });
    return { server, registry };
  } catch (error) {
    registry.close();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const application = await start();
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    application.server.close(() => application.registry.close());
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
