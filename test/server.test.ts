import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { request, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openRegistry } from "../src/registry/database.ts";
import { createServer, start } from "../src/server.ts";

function testServer(registry: ReturnType<typeof openRegistry>, isGraphifyReady = () => true) {
  return createServer({
    registry,
    repositories: { search: async () => ({ results: [], warnings: [] }) },
    apiToken: "test-token",
    isGraphifyReady,
  });
}

async function listen(server: Server) {
  server.listen(0, "127.0.0.1");
  return waitForListening(server);
}

async function waitForListening(server: Server) {
  if (!server.listening) await once(server, "listening");

  const address = server.address();
  if (!address || typeof address === "string") throw new Error("테스트 서버 주소를 확인할 수 없음");

  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server) {
  if (!server.listening) return;

  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function requestPath(baseUrl: string, path: string) {
  const url = new URL(baseUrl);

  return new Promise<IncomingMessage>((resolve, reject) => {
    const clientRequest = request(
      {
        hostname: url.hostname,
        port: url.port,
        path,
        signal: AbortSignal.timeout(1_000),
      },
      resolve,
    );
    clientRequest.on("error", reject);
    clientRequest.end();
  });
}

test("GET /healthz는 프로세스 생존 상태를 반환한다", async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "codefleet-"));
  const registry = openRegistry(join(temporaryDirectory, "data"));
  const server = testServer(registry);

  try {
    const baseUrl = await listen(server);
    const response = await fetch(`${baseUrl}/healthz`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok" });
  } finally {
    await close(server);
    registry.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("GET /readyz는 열린 레지스트리에 준비 상태를 반환한다", async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "codefleet-"));
  const registry = openRegistry(join(temporaryDirectory, "data"));
  const server = testServer(registry);

  try {
    const baseUrl = await listen(server);
    const response = await fetch(`${baseUrl}/readyz`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ready" });
  } finally {
    await close(server);
    registry.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("GET /readyz는 닫힌 레지스트리에 서비스 불가 상태를 반환한다", async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "codefleet-"));
  const registry = openRegistry(join(temporaryDirectory, "data"));
  registry.close();
  const server = testServer(registry);

  try {
    const baseUrl = await listen(server);
    const response = await fetch(`${baseUrl}/readyz`);

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { status: "not_ready" });
  } finally {
    await close(server);
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("알 수 없는 경로는 찾을 수 없음 상태를 반환한다", async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "codefleet-"));
  const registry = openRegistry(join(temporaryDirectory, "data"));
  const server = testServer(registry);

  try {
    const baseUrl = await listen(server);
    const response = await fetch(`${baseUrl}/missing`, { signal: AbortSignal.timeout(1_000) });

    assert.equal(response.status, 404);
  } finally {
    await close(server);
    registry.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("유효하지 않은 요청 대상은 프로세스를 종료하지 않고 잘못된 요청으로 응답한다", async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "codefleet-"));
  const registry = openRegistry(join(temporaryDirectory, "data"));
  const server = testServer(registry);

  try {
    const baseUrl = await listen(server);
    const response = await requestPath(baseUrl, "//[");

    assert.equal(response.statusCode, 400);
    assert.equal(server.listening, true);
    response.resume();
  } finally {
    await close(server);
    registry.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("start는 설정된 데이터 디렉터리로 서버를 시작한다", async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "codefleet-"));
  const application = await start({
    dataDirectory: join(temporaryDirectory, "data"),
    repositoriesFile: "config/repositories.json",
    graphifyBinary: process.execPath,
    apiToken: "test-token",
    port: 0,
    maxConcurrentQueries: 4,
  });

  try {
    const baseUrl = await waitForListening(application.server);
    const response = await fetch(`${baseUrl}/readyz`);

    assert.equal(response.status, 200);
    assert.equal(application.registry.dataDirectory, join(temporaryDirectory, "data"));
  } finally {
    await close(application.server);
    application.registry.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("GET /readyz는 Graphify를 실행할 수 없으면 준비되지 않은 상태를 반환한다", async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "codefleet-"));
  const registry = openRegistry(join(temporaryDirectory, "data"));
  const server = testServer(registry, () => false);

  try {
    const baseUrl = await listen(server);
    const response = await fetch(`${baseUrl}/readyz`);

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { status: "not_ready" });
  } finally {
    await close(server);
    registry.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
