import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openRegistry } from "../src/registry/database.ts";
import { createRepositoryService } from "../src/repositories/service.ts";
import type { RunCommandOptions } from "../src/process/run.ts";

function createFixture(defaultBranch = "trunk") {
  const directory = mkdtempSync(join(tmpdir(), "codefleet-service-"));
  const registry = openRegistry(join(directory, "data"));
  const commands: RunCommandOptions[] = [];
  let commit = "abc123";
  const graphify = {
    check: async () => undefined,
    extract: async (path: string) => {
      mkdirSync(join(path, "graphify-out"), { recursive: true });
      writeFileSync(join(path, "graphify-out", "graph.json"), "{}");
    },
    query: async (_path: string, _query: string, signal?: AbortSignal) => {
      if (signal?.aborted) throw Object.assign(new Error("명령 실행이 취소됨"), { code: "PROCESS_ABORTED" });
      return "NODE Redis";
    },
  };
  const runCommand = async (options: RunCommandOptions) => {
    commands.push(options);
    if (options.args[0] === "ls-remote") {
      return { stdout: defaultBranch ? `ref: refs/heads/${defaultBranch}\tHEAD\n` : "", stderr: "" };
    }
    if (options.args.includes("rev-parse")) return { stdout: `${commit}\n`, stderr: "" };
    return { stdout: "", stderr: "" };
  };
  return { directory, registry, commands, graphify, runCommand, setCommit: (value: string) => { commit = value; } };
}

test("기본 브랜치를 감지해 staging 색인을 활성 디렉터리로 교체한다", async () => {
  const fixture = createFixture();
  const config = [{ id: "orders", cloneUrl: "https://github.com/example/orders.git" }];

  try {
    const service = createRepositoryService({
      registry: fixture.registry,
      graphify: fixture.graphify,
      dataDirectory: fixture.registry.dataDirectory,
      runCommand: fixture.runCommand,
    });
    await service.syncAll(config);

    assert.equal(fixture.commands[0]?.args.join(" "), "ls-remote --symref https://github.com/example/orders.git HEAD");
    assert.deepEqual(fixture.commands[1]?.args, ["check-ref-format", "--branch", "trunk"]);
    assert.deepEqual(fixture.commands[2]?.args.slice(0, 7), ["clone", "--depth=1", "--single-branch", "--no-tags", "--branch", "trunk", "--"]);
    assert.equal(existsSync(join(fixture.registry.repositoriesDirectory, "orders", "graphify-out", "graph.json")), true);
    const [record] = fixture.registry.listRepositories();
    assert.deepEqual({ ...record, indexedAt: null }, {
      id: "orders", branch: "trunk", state: "ready", indexedCommit: "abc123", indexedAt: null, lastError: null,
    });
    assert.match(record?.indexedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    fixture.registry.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("기본 브랜치를 감지하지 못하면 clone 없이 degraded 처리한다", async () => {
  const fixture = createFixture("");

  try {
    const service = createRepositoryService({ registry: fixture.registry, graphify: fixture.graphify, dataDirectory: fixture.registry.dataDirectory, runCommand: fixture.runCommand });
    await service.syncAll([{ id: "orders", cloneUrl: "https://github.com/example/orders.git" }]);

    assert.equal(fixture.commands.some((command) => command.args[0] === "clone"), false);
    assert.deepEqual(fixture.registry.listRepositories()[0], {
      id: "orders", branch: "", state: "degraded", indexedCommit: null, indexedAt: null, lastError: "DEFAULT_BRANCH_UNRESOLVED",
    });
  } finally {
    fixture.registry.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("교체 또는 검색 실패 뒤에도 이전 색인과 잠금을 유지한다", async () => {
  const fixture = createFixture();
  const config = [{ id: "orders", cloneUrl: "https://github.com/example/orders.git" }];

  try {
    const service = createRepositoryService({ registry: fixture.registry, graphify: fixture.graphify, dataDirectory: fixture.registry.dataDirectory, runCommand: fixture.runCommand });
    await service.syncAll(config);
    writeFileSync(join(fixture.registry.repositoriesDirectory, "orders", "keep.txt"), "old-index");
    fixture.setCommit("def456");
    const markReady = fixture.registry.markReady;
    let failOnce = true;
    fixture.registry.markReady = (...args) => {
      if (failOnce) {
        failOnce = false;
        throw new Error("database write failed");
      }
      markReady(...args);
    };
    await service.syncAll(config);

    assert.equal(existsSync(join(fixture.registry.repositoriesDirectory, "orders", "keep.txt")), true);
    assert.equal(fixture.registry.listRepositories()[0]?.indexedCommit, "abc123");
    fixture.graphify.query = async () => { throw Object.assign(new Error("timeout"), { code: "PROCESS_TIMEOUT" }); };
    assert.equal((await service.search("redis", ["orders"])).warnings[0]?.code, "PROCESS_TIMEOUT");
    fixture.graphify.query = async () => "NODE Redis";
    assert.deepEqual((await service.search("redis", ["orders"])).results.map(({ repositoryId }) => repositoryId), ["orders"]);
  } finally {
    fixture.registry.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});
