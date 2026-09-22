import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadRepositories } from "../src/config/repositories.ts";

function writeConfig(value: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), "codefleet-repositories-"));
  const filePath = join(directory, "repositories.json");
  writeFileSync(filePath, JSON.stringify(value));
  return filePath;
}

test("저장소 설정을 읽는다", () => {
  const filePath = writeConfig({
    repositories: [
      { id: "orders", cloneUrl: "git@github.com:example/orders.git", branch: "main" },
      { cloneUrl: "https://github.com/example/catalog.git" },
      { cloneUrl: "https://github.gmarket.com/a-front-api/front-api.git", branch: "main" },
    ],
  });

  assert.deepEqual(loadRepositories(filePath), [
    { id: "orders", cloneUrl: "git@github.com:example/orders.git", branch: "main" },
    { id: "example/catalog", cloneUrl: "https://github.com/example/catalog.git" },
    { id: "a-front-api/front-api", cloneUrl: "https://github.gmarket.com/a-front-api/front-api.git", branch: "main" },
  ]);
});

test("중복 또는 옵션처럼 보이는 저장소 설정을 거부한다", () => {
  for (const repositories of [
    [
      { id: "orders", cloneUrl: "https://github.com/a/b.git", branch: "main" },
      { id: "orders", cloneUrl: "https://github.com/a/c.git", branch: "main" },
    ],
    [{ id: "-config", cloneUrl: "https://github.com/a/b.git", branch: "main" }],
    [{ id: "orders", cloneUrl: "https://evil.example/a/b.git", branch: "main" }],
    [{ id: "orders", cloneUrl: "https://github.com/a/b.git", branch: "--upload-pack=x" }],
  ]) {
    assert.throws(() => loadRepositories(writeConfig({ repositories })));
  }
});
