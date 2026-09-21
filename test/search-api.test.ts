import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openRegistry } from "../src/registry/database.ts";
import { createServer } from "../src/server.ts";

async function listen(server: Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("테스트 서버 주소를 확인할 수 없음");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server) {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function fixture(search: (query: string, repositoryIds?: readonly string[], signal?: AbortSignal) => Promise<{
  results: readonly { repositoryId: string; indexedCommit: string; indexedAt: string; output: string }[];
  warnings: readonly { repositoryId: string; code: string; message: string }[];
}>) {
  const directory = mkdtempSync(join(tmpdir(), "codefleet-api-"));
  const registry = openRegistry(join(directory, "data"));
  registry.reconcile([
    { id: "orders", cloneUrl: "https://github.com/example/orders.git", branch: "main" },
    { id: "catalog", cloneUrl: "https://github.com/example/catalog.git", branch: "main" },
  ]);
  registry.markReady("orders", "main", "abc", "2026-09-21T00:00:00.000Z");
  registry.markReady("catalog", "main", "def", "2026-09-21T00:00:00.000Z");
  return {
    directory,
    registry,
    server: createServer({ registry, repositories: { search }, apiToken: "secret", isGraphifyReady: () => true }),
  };
}

test("보호된 API는 Bearer 토큰과 본문 상한을 요구한다", async () => {
  const value = fixture(async () => ({ results: [], warnings: [] }));

  try {
    const baseUrl = await listen(value.server);
    assert.equal((await fetch(`${baseUrl}/repositories`)).status, 401);
    assert.equal((await fetch(`${baseUrl}/repositories`, { headers: { authorization: "Bearer wrong" } })).status, 403);
    const repositories = await fetch(`${baseUrl}/repositories`, { headers: { authorization: "Bearer secret" } });
    assert.equal(repositories.status, 200);
    assert.deepEqual(await repositories.json(), { repositories: value.registry.listRepositories() });
    const tooLarge = await fetch(`${baseUrl}/search`, {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify({ query: "x".repeat(16 * 1024) }),
    });
    assert.equal(tooLarge.status, 413);
  } finally {
    await close(value.server);
    value.registry.close();
    rmSync(value.directory, { recursive: true, force: true });
  }
});

test("검색 입력을 검증하고 저장소별 부분 실패를 보존한다", async () => {
  const indexedAt = "2026-09-21T00:00:00.000Z";
  const value = fixture(async () => ({
    results: [{ repositoryId: "orders", indexedCommit: "abc", indexedAt, output: "NODE Redis" }],
    warnings: [{ repositoryId: "catalog", code: "GRAPHIFY_TIMEOUT", message: "코드 그래프 검색 시간이 초과됨" }],
  }));

  try {
    const baseUrl = await listen(value.server);
    const headers = { authorization: "Bearer secret", "content-type": "application/json" };
    for (const body of [
      { query: "" },
      { query: "x".repeat(1_001) },
      { query: "redis", repositoryIds: "orders" },
      { query: "redis", repositoryIds: ["unknown"] },
    ]) {
      const response = await fetch(`${baseUrl}/search`, { method: "POST", headers, body: JSON.stringify(body) });
      assert.equal(response.status, 400);
    }
    const response = await fetch(`${baseUrl}/search`, { method: "POST", headers, body: JSON.stringify({ query: "redis", repositoryIds: ["orders", "catalog"] }) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      query: "redis",
      results: [{ repositoryId: "orders", indexedCommit: "abc", indexedAt, output: "NODE Redis" }],
      warnings: [{ repositoryId: "catalog", code: "GRAPHIFY_TIMEOUT", message: "코드 그래프 검색 시간이 초과됨" }],
    });
  } finally {
    await close(value.server);
    value.registry.close();
    rmSync(value.directory, { recursive: true, force: true });
  }
});

test("모든 저장소 검색이 실패하면 503을 반환한다", async () => {
  const value = fixture(async () => ({ results: [], warnings: [{ repositoryId: "orders", code: "GRAPHIFY_TIMEOUT", message: "코드 그래프 검색 시간이 초과됨" }] }));

  try {
    const baseUrl = await listen(value.server);
    const response = await fetch(`${baseUrl}/search`, {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify({ query: "redis" }),
    });
    assert.equal(response.status, 503);
  } finally {
    await close(value.server);
    value.registry.close();
    rmSync(value.directory, { recursive: true, force: true });
  }
});
