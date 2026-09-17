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
