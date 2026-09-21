import { timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";

import { loadEnvironment } from "./config/environment.ts";
import { loadRepositories } from "./config/repositories.ts";
import { createGraphifyClient } from "./graphify/client.ts";
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
  isGraphifyReady: () => boolean;
}>;

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

function validateSearch(value: unknown, knownIds: ReadonlySet<string>): { query: string; repositoryIds?: string[] } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new RequestError(400);
  const { query, repositoryIds } = value as Record<string, unknown>;
  if (typeof query !== "string" || query.trim() === "" || query.length > 1_000) throw new RequestError(400);
  if (repositoryIds === undefined) return { query };
  if (!Array.isArray(repositoryIds) || repositoryIds.some((id) => typeof id !== "string" || !knownIds.has(id))) {
    throw new RequestError(400);
  }
  return { query, repositoryIds };
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

    if (request.method === "GET" && pathname === "/healthz") {
      writeJson(response, 200, { status: "ok" });
      return;
    }
    if (request.method === "GET" && pathname === "/readyz") {
      const ready = dependencies.registry.isReady() && dependencies.isGraphifyReady();
      writeJson(response, ready ? 200 : 503, { status: ready ? "ready" : "not_ready" });
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
      const input = validateSearch(await readJsonBody(request), new Set(dependencies.registry.listRepositories().map(({ id }) => id)));
      const outcome = await dependencies.repositories.search(input.query, input.repositoryIds, controller.signal);
      if (outcome.results.length === 0) {
        writeJson(response, 503, { error: { code: "SEARCH_UNAVAILABLE", message: "코드 그래프 검색을 완료할 수 없음", retryable: true } });
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
    let graphifyReady = true;
    try {
      await graphify.check();
    } catch {
      graphifyReady = false;
    }
    const server = createServer({
      registry,
      repositories: createRepositoryService({ registry, graphify, dataDirectory: config.dataDirectory, runCommand }),
      apiToken: config.apiToken,
      isGraphifyReady: () => graphifyReady,
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
