import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
    const active = fixture.registry.getRepositoryIndex("orders");
    assert.ok(active?.activeGeneration);
    assert.equal(existsSync(join(fixture.registry.repositoriesDirectory, "orders", "generations", active.activeGeneration, "graphify-out", "graph.json")), true);
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

test("새 generation 게시 실패와 재색인 뒤에도 이전 색인을 보존한다", async () => {
  const fixture = createFixture();
  const config = [{ id: "orders", cloneUrl: "https://github.com/example/orders.git" }];

  try {
    const service = createRepositoryService({ registry: fixture.registry, graphify: fixture.graphify, dataDirectory: fixture.registry.dataDirectory, runCommand: fixture.runCommand });
    await service.syncAll(config);
    const oldGeneration = fixture.registry.getRepositoryIndex("orders")?.activeGeneration;
    assert.ok(oldGeneration);
    fixture.setCommit("def456");
    const markReady = fixture.registry.markReady;
    let failOnce = true;
    fixture.registry.markReady = (...args) => {
      if (failOnce) {
        failOnce = false;
        throw new Error("database write failed");
      }
      return markReady(...args);
    };
    await service.syncAll(config);

    assert.equal(existsSync(join(fixture.registry.repositoriesDirectory, "orders", "generations", oldGeneration, "graphify-out", "graph.json")), true);
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

test("다른 서비스가 새 generation을 게시해도 진행 중 검색은 이전 generation을 사용한다", async () => {
  const fixture = createFixture();
  const config = [{ id: "orders", cloneUrl: "https://github.com/example/orders.git" }];
  let releaseQuery: () => void = () => undefined;
  let queryStarted!: () => void;
  const started = new Promise<void>((resolve) => { queryStarted = resolve; });
  let queriedPath = "";
  let secondRegistry: ReturnType<typeof openRegistry> | undefined;

  try {
    const firstService = createRepositoryService({ registry: fixture.registry, graphify: fixture.graphify, dataDirectory: fixture.registry.dataDirectory, runCommand: fixture.runCommand });
    await firstService.syncAll(config);
    const old = fixture.registry.getRepositoryIndex("orders");
    assert.ok(old?.activeGeneration);
    fixture.graphify.query = async (path) => {
      queriedPath = path;
      queryStarted();
      await new Promise<void>((resolve) => { releaseQuery = resolve; });
      return "NODE Redis";
    };

    const search = firstService.search("redis", ["orders"]);
    await started;
    secondRegistry = openRegistry(fixture.registry.dataDirectory);
    fixture.setCommit("def456");
    const secondService = createRepositoryService({ registry: secondRegistry, graphify: fixture.graphify, dataDirectory: secondRegistry.dataDirectory, runCommand: fixture.runCommand });
    await Promise.race([
      secondService.syncAll(config),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("새 generation 게시가 검색 잠금에 막힘")), 100)),
    ]);

    releaseQuery();
    const outcome = await search;
    assert.equal(queriedPath, join(fixture.registry.repositoriesDirectory, "orders", "generations", old.activeGeneration, "graphify-out", "graph.json"));
    assert.deepEqual(outcome.results.map(({ indexedCommit }) => indexedCommit), ["abc123"]);
    assert.equal(secondRegistry.getRepositoryIndex("orders")?.indexedCommit, "def456");
  } finally {
    releaseQuery();
    secondRegistry?.close();
    fixture.registry.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("repository symlink를 따라가지 않는다", async () => {
  const fixture = createFixture();
  const config = [{ id: "orders", cloneUrl: "https://github.com/example/orders.git" }];
  const outside = join(fixture.directory, "outside");

  try {
    mkdirSync(outside);
    symlinkSync(outside, join(fixture.registry.repositoriesDirectory, "orders"));
    const service = createRepositoryService({ registry: fixture.registry, graphify: fixture.graphify, dataDirectory: fixture.registry.dataDirectory, runCommand: fixture.runCommand });
    await service.syncAll(config);

    assert.equal(fixture.registry.listRepositories()[0]?.state, "degraded");
    assert.equal(existsSync(join(outside, "graphify-out", "graph.json")), false);
  } finally {
    fixture.registry.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("generations symlink를 따라가지 않는다", async () => {
  const fixture = createFixture();
  const config = [{ id: "orders", cloneUrl: "https://github.com/example/orders.git" }];
  const outside = join(fixture.directory, "outside");

  try {
    const service = createRepositoryService({ registry: fixture.registry, graphify: fixture.graphify, dataDirectory: fixture.registry.dataDirectory, runCommand: fixture.runCommand });
    await service.syncAll(config);
    mkdirSync(outside);
    rmSync(join(fixture.registry.repositoriesDirectory, "orders", "generations"), { recursive: true });
    symlinkSync(outside, join(fixture.registry.repositoriesDirectory, "orders", "generations"));
    fixture.setCommit("def456");
    await service.syncAll(config);

    assert.equal(fixture.registry.listRepositories()[0]?.indexedCommit, "abc123");
    assert.equal(existsSync(join(outside, "def456", "graphify-out", "graph.json")), false);
  } finally {
    fixture.registry.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});
