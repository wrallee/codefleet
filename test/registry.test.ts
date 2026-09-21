import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
      1,
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

test("설정을 조정하고 색인 상태를 기록한다", () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "codefleet-"));

  try {
    const registry = openRegistry(join(temporaryDirectory, "data"));
    registry.reconcile([{ id: "orders", cloneUrl: "https://github.com/example/orders.git", branch: "main" }]);
    assert.deepEqual(registry.listRepositories().map(({ id, state }) => ({ id, state })), [
      { id: "orders", state: "pending" },
    ]);

    registry.markSyncing("orders");
    registry.markReady("orders", "main", "abc123", "2026-09-21T00:00:00.000Z");
    assert.deepEqual(registry.listRepositories(), [{
      id: "orders",
      branch: "main",
      state: "ready",
      indexedCommit: "abc123",
      indexedAt: "2026-09-21T00:00:00.000Z",
      lastError: null,
    }]);

    registry.reconcile([]);
    assert.deepEqual(registry.listRepositories(), []);
    registry.close();
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
