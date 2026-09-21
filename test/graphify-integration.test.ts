import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createGraphifyClient } from "../src/graphify/client.ts";
import { runCommand } from "../src/process/run.ts";
import { createRepositoryService } from "../src/repositories/service.ts";
import { openRegistry } from "../src/registry/database.ts";

const graphifyBinary = process.env.GRAPHIFY_BIN;
const fixtureRoot = new URL("./fixtures/", import.meta.url);

function git(args: readonly string[], cwd?: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function createRemote(root: string, id: string) {
  const source = join(root, `${id}-source`);
  const remote = join(root, `${id}.git`);
  cpSync(new URL(`${id}/`, fixtureRoot), source, { recursive: true });
  git(["init", "--initial-branch=trunk"], source);
  git(["config", "user.email", "codefleet@example.test"], source);
  git(["config", "user.name", "CodeFleet test"], source);
  git(["add", "."], source);
  git(["commit", "-m", "initial"], source);
  git(["init", "--bare", remote]);
  git(["remote", "add", "origin", remote], source);
  git(["push", "-u", "origin", "trunk"], source);
  return { source, remote };
}

test("Graphify로 두 Git 저장소를 색인하고 오래된 노드를 교체한다", { timeout: 120_000 }, async (context) => {
  if (!graphifyBinary) {
    context.skip("GRAPHIFY_BIN이 설정되지 않음");
    return;
  }

  const root = mkdtempSync(join(tmpdir(), "codefleet-graphify-"));
  const orders = createRemote(root, "orders");
  const catalog = createRemote(root, "catalog");
  const registry = openRegistry(join(root, "data"));
  const service = createRepositoryService({
    registry,
    graphify: createGraphifyClient(graphifyBinary),
    dataDirectory: registry.dataDirectory,
    runCommand,
  });
  const repositories = [
    { id: "orders", cloneUrl: orders.remote, branch: "trunk" },
    { id: "catalog", cloneUrl: catalog.remote, branch: "trunk" },
  ];

  try {
    await service.syncAll(repositories);
    const initial = await service.search("redis related sources");
    assert.deepEqual(initial.warnings, []);
    assert.deepEqual(initial.results.map(({ repositoryId }) => repositoryId).sort(), ["catalog", "orders"]);
    assert.equal(new Set(initial.results.map(({ indexedCommit }) => indexedCommit)).size, 2);
    const initialById = new Map(initial.results.map((result) => [result.repositoryId, result]));
    assert.match(initialById.get("orders")?.output ?? "", /RedisConfig/);
    const catalog = await service.search("CacheRepository", ["catalog"]);
    assert.deepEqual(catalog.warnings, []);
    assert.match(catalog.results[0]?.output ?? "", /CacheRepository/);

    rmSync(join(orders.source, "src", "RedisConfig.ts"));
    writeFileSync(join(orders.source, "src", "HealthConfig.ts"), "export const health = 'ok';\n");
    git(["add", "-A"], orders.source);
    git(["commit", "-m", "remove redis config"], orders.source);
    git(["push"], orders.source);
    await service.syncAll([repositories[0]!]);

    const afterRemoval = await service.search("redis related sources", ["orders"]);
    assert.deepEqual(afterRemoval.warnings, []);
    assert.equal(afterRemoval.results[0]?.output.includes("RedisConfig"), false);
    assert.notEqual(afterRemoval.results[0]?.indexedCommit, initialById.get("orders")?.indexedCommit);
  } finally {
    registry.close();
    rmSync(root, { recursive: true, force: true });
  }
});
