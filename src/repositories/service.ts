import { access, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import type { RepositoryConfig } from "../config/repositories.ts";
import type { CommandResult, RunCommandOptions } from "../process/run.ts";
import type { Registry, RepositoryRecord } from "../registry/database.ts";
import { withRepositoryLock } from "./lock.ts";

type RunCommand = (options: RunCommandOptions) => Promise<CommandResult>;

type GraphifyClient = Readonly<{
  check(): Promise<void>;
  extract(repositoryPath: string): Promise<void>;
  query(graphPath: string, query: string, signal?: AbortSignal): Promise<string>;
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

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return "REPOSITORY_SYNC_FAILED";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "저장소 작업에 실패함";
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path !== "" && !path.startsWith("..") && !path.includes(`..${process.platform === "win32" ? "\\" : "/"}`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function ensureDirectory(path: string): Promise<void> {
  if (!(await stat(path)).isDirectory()) throw new Error("관리 디렉터리가 아님");
}

function defaultBranch(output: string): string | undefined {
  return output.match(/^ref: refs\/heads\/([^\s]+)\tHEAD$/m)?.[1];
}

export function createRepositoryService(options: Readonly<{
  registry: Registry;
  graphify: GraphifyClient;
  dataDirectory: string;
  runCommand: RunCommand;
}>) {
  const { registry, graphify, runCommand } = options;
  const dataDirectory = resolve(options.dataDirectory);
  const repositoriesDirectory = join(dataDirectory, "repositories");
  const stagingDirectory = join(dataDirectory, ".staging");
  const trashDirectory = join(dataDirectory, ".trash");
  const git = (args: readonly string[], cwd?: string) => runCommand({
    executable: "git",
    args,
    cwd,
    env: childEnvironment(),
    timeoutMs: 600_000,
    maxOutputBytes: 1_048_576,
  });

  const managedPath = (path: string) => {
    if (!isInside(dataDirectory, path)) throw new Error("관리 경로가 data directory 밖에 있음");
    return path;
  };
  const syncOne = async (config: RepositoryConfig) => {
    const previousRecord = registry.listRepositories().find(({ id }) => id === config.id);
    registry.markSyncing(config.id);
    let staging: string | undefined;
    try {
      await ensureDirectory(stagingDirectory);
      await ensureDirectory(trashDirectory);
      const branch = config.branch ?? defaultBranch((await git(["ls-remote", "--symref", config.cloneUrl, "HEAD"])).stdout);
      if (!branch) {
        registry.markDegraded(config.id, "DEFAULT_BRANCH_UNRESOLVED");
        return;
      }
      await git(["check-ref-format", "--branch", branch]);
      staging = managedPath(await mkdtemp(join(stagingDirectory, `${config.id}-`)));
      await git(["clone", "--depth=1", "--single-branch", "--no-tags", "--branch", branch, "--", config.cloneUrl, staging]);
      const commit = (await git(["-C", staging, "rev-parse", "HEAD"])).stdout.trim();
      await graphify.extract(staging);
      await access(join(staging, "graphify-out", "graph.json"));

      const active = managedPath(join(repositoriesDirectory, config.id));
      const previous = managedPath(join(trashDirectory, `${config.id}-${Date.now()}`));
      const staged = staging;
      await withRepositoryLock(config.id, async () => {
        const hadActive = await exists(active);
        if (hadActive) await rename(active, previous);
        try {
          await rename(staged, active);
          staging = undefined;
          registry.markReady(config.id, branch, commit, new Date().toISOString());
        } catch (error) {
          if (await exists(active)) await rename(active, staged);
          staging = staged;
          if (hadActive && await exists(previous)) await rename(previous, active);
          throw error;
        }
      });
      if (await exists(previous)) await rm(previous, { recursive: true, force: true });
    } catch (error) {
      try {
        if (staging && await exists(staging)) await rm(staging, { recursive: true, force: true });
        if (previousRecord?.state === "ready" && previousRecord.indexedCommit && previousRecord.indexedAt) {
          registry.markReady(config.id, previousRecord.branch, previousRecord.indexedCommit, previousRecord.indexedAt);
        } else {
          registry.markDegraded(config.id, errorCode(error));
        }
      } catch {
        // Keep the original sync error when recovery bookkeeping also fails.
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
      const selected = repositoryIds ? repositoryIds.map((id) => byId.get(id)).filter((record): record is RepositoryRecord => record !== undefined) : records;
      const warnings: Array<{ repositoryId: string; code: string; message: string }> = [];
      for (const id of repositoryIds ?? []) {
        if (!byId.has(id)) warnings.push({ repositoryId: id, code: "REPOSITORY_NOT_FOUND", message: "등록되지 않은 저장소" });
      }
      const outcomes = await Promise.all(selected.map(async (record) => {
        try {
          return await withRepositoryLock(record.id, async () => {
            const current = registry.listRepositories().find(({ id }) => id === record.id);
            if (!current || current.state !== "ready" || !current.indexedCommit || !current.indexedAt) {
              throw Object.assign(new Error("준비되지 않은 저장소"), { code: "REPOSITORY_NOT_READY" });
            }
            const output = await graphify.query(join(repositoriesDirectory, current.id, "graphify-out", "graph.json"), query, signal);
            return { repositoryId: current.id, indexedCommit: current.indexedCommit, indexedAt: current.indexedAt, output };
          });
        } catch (error) {
          warnings.push({ repositoryId: record.id, code: errorCode(error), message: errorMessage(error) });
          return undefined;
        }
      }));
      return { results: outcomes.filter((outcome): outcome is NonNullable<typeof outcome> => outcome !== undefined), warnings };
    },
  };
}
