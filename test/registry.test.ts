import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { openRegistry } from "../src/registry/database.ts";

test("레지스트리를 열면 데이터 디렉터리와 최초 스키마를 준비한다", () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "codefleet-"));

  try {
    const dataDirectory = join(temporaryDirectory, "data");
    const registry = openRegistry(dataDirectory);

    assert.equal(existsSync(join(dataDirectory, "codefleet.db")), true);
    assert.equal(existsSync(join(dataDirectory, "repositories")), true);
    assert.equal(existsSync(join(dataDirectory, ".trash")), true);
    assert.equal(
      (registry.database.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version,
      2,
    );
    assert.equal(
      (registry.database.prepare("PRAGMA journal_mode").get() as { journal_mode: string })
        .journal_mode,
      "wal",
    );

    registry.close();
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("닫힌 레지스트리는 준비되지 않은 상태를 반환한다", () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "codefleet-"));

  try {
    const registry = openRegistry(join(temporaryDirectory, "data"));

    assert.equal(registry.isReady(), true);
    registry.close();
    assert.equal(registry.isReady(), false);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("필수 데이터 디렉터리가 없으면 준비되지 않은 상태를 반환한다", () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "codefleet-"));

  try {
    const registry = openRegistry(join(temporaryDirectory, "data"));

    rmSync(registry.repositoriesDirectory, { recursive: true });

    assert.equal(registry.isReady(), false);
    registry.close();
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("v1 레지스트리를 migration하고 설정 변경 뒤에도 활성 색인 provenance를 유지한다", () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "codefleet-"));

  try {
    const dataDirectory = join(temporaryDirectory, "data");
    mkdirSync(dataDirectory, { recursive: true });
    const legacy = new DatabaseSync(join(dataDirectory, "codefleet.db"));
    legacy.exec(`
      CREATE TABLE repositories (
        id TEXT PRIMARY KEY, display_name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
        clone_url TEXT NOT NULL, branch TEXT NOT NULL, sync_cron TEXT, enabled INTEGER NOT NULL DEFAULT 1,
        state TEXT NOT NULL, checkout_commit TEXT, indexed_commit TEXT, indexed_at TEXT, last_error TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO repositories VALUES (
        'orders', 'orders', '', 'https://github.com/example/orders.git', 'main', NULL, 1, 'ready',
        'abc123', 'abc123', '2026-09-21T00:00:00.000Z', NULL,
        '2026-09-21T00:00:00.000Z', '2026-09-21T00:00:00.000Z'
      );
      PRAGMA user_version = 1;
    `);
    legacy.close();

    const registry = openRegistry(dataDirectory);
    assert.deepEqual(
      (registry.database.prepare("PRAGMA table_info(repositories)").all() as { name: string }[])
        .map(({ name }) => name)
        .filter((name) => ["indexed_branch", "indexed_clone_url", "active_generation", "sync_generation"].includes(name)),
      ["indexed_branch", "indexed_clone_url", "active_generation", "sync_generation"],
    );
    registry.reconcile([{ id: "orders", cloneUrl: "https://github.com/example/next-orders.git", branch: "release" }]);
    assert.deepEqual(registry.listRepositories(), [{
      id: "orders",
      branch: "main",
      state: "ready",
      indexedCommit: "abc123",
      indexedAt: "2026-09-21T00:00:00.000Z",
      lastError: null,
    }]);
    assert.deepEqual(registry.getRepositoryIndex("orders"), {
      id: "orders",
      branch: "main",
      state: "ready",
      indexedCommit: "abc123",
      indexedAt: "2026-09-21T00:00:00.000Z",
      lastError: null,
      activeGeneration: null,
    });

    assert.equal(
      (registry.database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
      2,
    );

    registry.close();
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("오래된 sync 세대는 활성 generation과 오류 상태를 바꾸지 못한다", () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "codefleet-"));

  try {
    const registry = openRegistry(join(temporaryDirectory, "data"));
    registry.reconcile([{ id: "orders", cloneUrl: "https://github.com/example/orders.git", branch: "main" }]);
    const oldToken = registry.beginSync("orders");
    const currentToken = registry.beginSync("orders");
    assert.equal(registry.markReady("orders", oldToken, "main", "https://github.com/example/orders.git", "old", "old-generation", "2026-09-21T00:00:00.000Z"), false);
    assert.equal(registry.markReady("orders", currentToken, "main", "https://github.com/example/orders.git", "new", "new-generation", "2026-09-22T00:00:00.000Z"), true);
    registry.markSyncFailed("orders", oldToken, "GIT_FAILED");
    assert.deepEqual(registry.getRepositoryIndex("orders"), {
      id: "orders",
      branch: "main",
      state: "ready",
      indexedCommit: "new",
      indexedAt: "2026-09-22T00:00:00.000Z",
      lastError: null,
      activeGeneration: "new-generation",
    });

    registry.close();
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("symlink 관리 디렉터리를 거부한다", () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "codefleet-"));

  try {
    const dataDirectory = join(temporaryDirectory, "data");
    const outside = join(temporaryDirectory, "outside");
    mkdirSync(dataDirectory);
    mkdirSync(outside);
    symlinkSync(outside, join(dataDirectory, ".staging"));
    assert.throws(() => openRegistry(dataDirectory), /symlink/);

    assert.equal(existsSync(outside), true);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
