import { randomUUID } from "node:crypto";
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rm, rename } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import type { RepositoryConfig } from "../config/repositories.ts";
import type { CommandResult, RunCommandOptions } from "../process/run.ts";
import type { Registry, RepositoryRecord } from "../registry/database.ts";
import { createQueryLimit } from "./query-limit.ts";

type RunCommand = (options: RunCommandOptions) => Promise<CommandResult>;

type GraphifyClient = Readonly<{
  check(): Promise<void>;
  extract(repositoryPath: string): Promise<void>;
  query(repositoryPath: string, query: string, signal?: AbortSignal): Promise<string>;
}>;

export type SearchOutcome = Readonly<{
  results: readonly Readonly<{ repositoryId: string; indexedCommit: string; indexedAt: string; output: string }> [];
  warnings: readonly Readonly<{ repositoryId: string; code: string; message: string }> [];
}>;

function childEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    ["PATH", "HOME", "LANG", "LC_ALL", "SSH_AUTH_SOCK"]
      .filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key]]),
  );
}

const messages: Record<string, string> = {
  GIT_TIMEOUT: "Git 동기화 시간이 초과됨",
  GIT_OUTPUT_LIMIT: "Git 동기화 출력이 제한을 초과함",
  GIT_UNAVAILABLE: "Git을 시작할 수 없음",
  GIT_FAILED: "Git 동기화에 실패함",
  GRAPHIFY_TIMEOUT: "코드 그래프 검색 시간이 초과됨",
  GRAPHIFY_OUTPUT_LIMIT: "코드 그래프 검색 출력이 제한을 초과함",
  GRAPHIFY_UNAVAILABLE: "코드 그래프 검색을 시작할 수 없음",
  GRAPHIFY_FAILED: "코드 그래프 검색에 실패함",
  SEARCH_ABORTED: "검색이 취소됨",
  REPOSITORY_NOT_READY: "준비되지 않은 저장소",
  REPOSITORY_NOT_FOUND: "등록되지 않은 저장소",
  DEFAULT_BRANCH_UNRESOLVED: "기본 브랜치를 확인할 수 없음",
  REPOSITORY_SYNC_FAILED: "저장소 동기화에 실패함",
};

function rawErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

function errorCode(error: unknown): string {
  const code = rawErrorCode(error);
  return code && Object.hasOwn(messages, code) ? code : "REPOSITORY_SYNC_FAILED";
}

function errorMessage(error: unknown): string {
  return messages[errorCode(error)] ?? "저장소 작업에 실패함";
}

function publicError(kind: "GIT" | "GRAPHIFY", error: unknown): Error & { code: string } {
  const processCode = rawErrorCode(error);
  if (processCode && Object.hasOwn(messages, processCode)) return Object.assign(new Error(messages[processCode]), { code: processCode });
  const code = processCode === "PROCESS_ABORTED" ? "SEARCH_ABORTED" : processCode === "PROCESS_TIMEOUT" ? `${kind}_TIMEOUT`
    : processCode === "PROCESS_OUTPUT_LIMIT" ? `${kind}_OUTPUT_LIMIT`
      : processCode === "PROCESS_SPAWN_FAILED" ? `${kind}_UNAVAILABLE`
        : processCode === "PROCESS_EXIT_FAILURE" ? `${kind}_FAILED` : `${kind}_FAILED`;
  return Object.assign(new Error(messages[code] ?? "저장소 작업에 실패함"), { code });
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !path.includes(`..${process.platform === "win32" ? "\\" : "/"}`));
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function defaultBranch(output: string): string | undefined {
  return output.match(/^ref: refs\/heads\/([^\s]+)\tHEAD$/m)?.[1];
}

function repositoryStorageKey(id: string): string {
  return encodeURIComponent(id);
}

export function createRepositoryService(options: Readonly<{
  registry: Registry;
  graphify: GraphifyClient;
  dataDirectory: string;
  runCommand: RunCommand;
  maxConcurrentQueries?: number;
}>) {
  const { registry, graphify, runCommand } = options;
  const dataDirectory = resolve(registry.dataDirectory);
  const repositoriesDirectory = registry.repositoriesDirectory;
  const stagingDirectory = registry.stagingDirectory;
  const queryLimit = createQueryLimit(options.maxConcurrentQueries ?? 4);
  const git = async (args: readonly string[], cwd?: string) => {
    try {
      return await runCommand({
    executable: "git",
    args,
    cwd,
    env: childEnvironment(),
    timeoutMs: 600_000,
    maxOutputBytes: 1_048_576,
      });
    } catch (error) {
      throw publicError("GIT", error);
    }
  };
  const managedDirectory = async (path: string) => {
    const entry = await lstat(path);
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error("managed directory must not be a symlink");
    const actual = await realpath(path);
    if (!isInside(dataDirectory, actual)) throw new Error("managed directory escapes data directory");
    return actual;
  };
  const makeManagedDirectory = async (path: string) => {
    if (!isInside(dataDirectory, resolve(path))) throw new Error("managed directory escapes data directory");
    await mkdir(path, { recursive: true });
    return managedDirectory(path);
  };
  const graphOutputDirectory = async (repositoryPath: string) => {
    const root = await realpath(repositoryPath);
    const output = join(repositoryPath, "graphify-out");
    const entry = await lstat(output);
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error("graph output must be a directory");
    const actual = await realpath(output);
    if (!isInside(root, actual)) throw new Error("graph output escapes repository directory");
    return actual;
  };
  const validateGraphOutput = async (repositoryPath: string) => {
    const output = await graphOutputDirectory(repositoryPath);
    const graphPath = join(output, "graph.json");
    const entry = await lstat(graphPath);
    if (entry.isSymbolicLink() || !entry.isFile()) throw new Error("graph output must be a regular file");
    const actual = await realpath(graphPath);
    if (!isInside(output, actual)) throw new Error("graph file escapes graph output directory");
    const graph = JSON.parse(await readFile(actual, "utf8")) as unknown;
    if (typeof graph !== "object" || graph === null || !("nodes" in graph) || !("links" in graph)
      || !Array.isArray(graph.nodes) || !Array.isArray(graph.links)) throw new Error("invalid graph output");
  };
  const syncOne = async (config: RepositoryConfig) => {
    const syncGeneration = registry.beginSync(config.id);
    let staging: string | undefined;
    try {
      await managedDirectory(stagingDirectory);
      const branch = config.branch ?? defaultBranch((await git(["ls-remote", "--symref", config.cloneUrl, "HEAD"])).stdout);
      if (!branch) {
        registry.markSyncFailed(config.id, syncGeneration, "DEFAULT_BRANCH_UNRESOLVED");
        return;
      }
      await git(["check-ref-format", "--branch", branch]);
      staging = await mkdtemp(join(stagingDirectory, `${repositoryStorageKey(config.id)}-`));
      await managedDirectory(staging);
      await git(["clone", "--depth=1", "--single-branch", "--no-tags", "--branch", branch, "--", config.cloneUrl, staging]);
      const commit = (await git(["-C", staging, "rev-parse", "HEAD"])).stdout.trim();
      try {
        await rm(join(staging, "graphify-out"), { recursive: true, force: true });
        await mkdir(join(staging, "graphify-out"));
        await graphOutputDirectory(staging);
        await graphify.extract(staging);
        await validateGraphOutput(staging);
      } catch (error) {
        throw publicError("GRAPHIFY", error);
      }

      const repositoryDirectory = await makeManagedDirectory(join(repositoriesDirectory, repositoryStorageKey(config.id)));
      const generationsDirectory = await makeManagedDirectory(join(repositoryDirectory, "generations"));
      const activeGeneration = `${commit}-${randomUUID()}`;
      const destination = join(generationsDirectory, activeGeneration);
      try {
        await validateGraphOutput(staging);
      } catch (error) {
        throw publicError("GRAPHIFY", error);
      }
      await rename(staging, destination);
      staging = undefined;
      // ponytail: immutable generations are retained; add retention cleanup only when PVC usage proves it is needed.
      registry.markReady(config.id, syncGeneration, branch, config.cloneUrl, commit, activeGeneration, new Date().toISOString());
    } catch (error) {
      try {
        if (staging && await exists(staging)) await rm(staging, { recursive: true, force: true });
      } finally {
        registry.markSyncFailed(config.id, syncGeneration, errorCode(error));
      }
    }
  };

  return {
    async syncAll(configs: readonly RepositoryConfig[]): Promise<void> {
      registry.reconcile(configs);
      for (const config of configs) await syncOne(config);
    },
    async search(query: string, repositoryIds?: readonly string[], signal?: AbortSignal): Promise<SearchOutcome> {
      const records = registry.listRepositories();
      const byId = new Map(records.map((record) => [record.id, record]));
      const selectedIds = repositoryIds && [...new Set(repositoryIds)];
      const selected = selectedIds ? selectedIds.map((id) => byId.get(id)).filter((record): record is RepositoryRecord => record !== undefined)
        : records.filter((record) => record.state === "ready");
      const warnings: Array<{ repositoryId: string; code: string; message: string }> = [];
      for (const id of selectedIds ?? []) {
        if (!byId.has(id)) warnings.push({ repositoryId: id, code: "REPOSITORY_NOT_FOUND", message: "등록되지 않은 저장소" });
      }
      const outcomes = await Promise.all(selected.map(async (record) => {
        try {
          const current = registry.getRepositoryIndex(record.id);
          if (!current || current.state !== "ready" || !current.indexedCommit || !current.indexedAt) {
            throw Object.assign(new Error("준비되지 않은 저장소"), { code: "REPOSITORY_NOT_READY" });
          }
          const indexRoot = current.activeGeneration
            ? join(repositoriesDirectory, repositoryStorageKey(current.id), "generations", current.activeGeneration)
            : join(repositoriesDirectory, repositoryStorageKey(current.id));
          let output: string;
          try {
            output = await queryLimit.run(() => graphify.query(indexRoot, query, signal), signal);
          } catch (error) {
            throw publicError("GRAPHIFY", error);
          }
          return { repositoryId: current.id, indexedCommit: current.indexedCommit, indexedAt: current.indexedAt, output };
        } catch (error) {
          warnings.push({ repositoryId: record.id, code: errorCode(error), message: errorMessage(error) });
          return undefined;
        }
      }));
      return { results: outcomes.filter((outcome): outcome is NonNullable<typeof outcome> => outcome !== undefined), warnings };
    },
  };
}
