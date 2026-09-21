import { accessSync, constants, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import type { RepositoryConfig } from "../config/repositories.ts";

const CURRENT_SCHEMA_VERSION = 2;

export type RepositoryRecord = Readonly<{
  id: string;
  branch: string;
  state: "pending" | "syncing" | "ready" | "degraded" | "disabled";
  indexedCommit: string | null;
  indexedAt: string | null;
  lastError: string | null;
}>;

export type RepositoryIndexRecord = RepositoryRecord & Readonly<{ activeGeneration: string | null }>;

type RepositoryRow = {
  id: string;
  branch: string;
  state: RepositoryRecord["state"];
  indexed_commit: string | null;
  indexed_at: string | null;
  last_error: string | null;
  active_generation: string | null;
};

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !path.includes(`..${process.platform === "win32" ? "\\" : "/"}`));
}

function managedDirectory(dataDirectory: string, name: string): string {
  const directory = join(dataDirectory, name);
  mkdirSync(directory, { recursive: true });
  const entry = lstatSync(directory);
  if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error(`managed directory must not be a symlink: ${name}`);
  const actual = realpathSync(directory);
  if (!isInside(dataDirectory, actual)) throw new Error(`managed directory escapes data directory: ${name}`);
  return actual;
}

function toRecord(row: RepositoryRow): RepositoryRecord {
  return {
    id: row.id,
    branch: row.branch,
    state: row.state,
    indexedCommit: row.indexed_commit,
    indexedAt: row.indexed_at,
    lastError: row.last_error,
  };
}

export function openRegistry(configuredDataDirectory: string) {
  mkdirSync(configuredDataDirectory, { recursive: true });
  const dataDirectory = realpathSync(configuredDataDirectory);
  const repositoriesDirectory = managedDirectory(dataDirectory, "repositories");
  const stagingDirectory = managedDirectory(dataDirectory, ".staging");
  const trashDirectory = managedDirectory(dataDirectory, ".trash");
  const database = new DatabaseSync(join(dataDirectory, "codefleet.db"));
  database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");

  const { user_version: schemaVersion } = database.prepare("PRAGMA user_version").get() as { user_version: number };
  if (schemaVersion > CURRENT_SCHEMA_VERSION) {
    database.close();
    throw new Error(`지원하지 않는 레지스트리 스키마 버전: ${schemaVersion}`);
  }
  if (schemaVersion === 0) {
    database.exec(`
      BEGIN;
      CREATE TABLE repositories (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        clone_url TEXT NOT NULL,
        branch TEXT NOT NULL,
        sync_cron TEXT,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        state TEXT NOT NULL CHECK (state IN ('pending', 'syncing', 'ready', 'degraded', 'disabled', 'deleting')),
        checkout_commit TEXT,
        indexed_commit TEXT,
        indexed_at TEXT,
        last_error TEXT,
        indexed_branch TEXT,
        indexed_clone_url TEXT,
        active_generation TEXT,
        sync_generation INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      PRAGMA user_version = 2;
      COMMIT;
    `);
  } else if (schemaVersion === 1) {
    database.exec(`
      BEGIN;
      ALTER TABLE repositories ADD COLUMN indexed_branch TEXT;
      ALTER TABLE repositories ADD COLUMN indexed_clone_url TEXT;
      ALTER TABLE repositories ADD COLUMN active_generation TEXT;
      ALTER TABLE repositories ADD COLUMN sync_generation INTEGER NOT NULL DEFAULT 0;
      UPDATE repositories SET indexed_branch = branch, indexed_clone_url = clone_url WHERE indexed_commit IS NOT NULL;
      PRAGMA user_version = 2;
      COMMIT;
    `);
  }

  let open = true;
  const records = (where = "enabled = 1", parameters: readonly SQLInputValue[] = []): RepositoryRow[] => database.prepare(`
    SELECT id,
      CASE WHEN indexed_commit IS NULL THEN branch ELSE indexed_branch END AS branch,
      state, indexed_commit, indexed_at, last_error, active_generation
    FROM repositories WHERE ${where} ORDER BY id
  `).all(...parameters) as RepositoryRow[];

  return {
    database,
    dataDirectory,
    repositoriesDirectory,
    stagingDirectory,
    trashDirectory,
    isReady() {
      if (!open) return false;
      try {
        database.prepare("SELECT 1").get();
        for (const directory of [dataDirectory, repositoriesDirectory, stagingDirectory, trashDirectory]) accessSync(directory, constants.R_OK | constants.W_OK);
        return true;
      } catch {
        return false;
      }
    },
    close() {
      open = false;
      database.close();
    },
    reconcile(configs: readonly RepositoryConfig[]) {
      const now = new Date().toISOString();
      const upsert = database.prepare(`
        INSERT INTO repositories (id, display_name, clone_url, branch, enabled, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, 1, 'pending', ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          clone_url = excluded.clone_url,
          branch = CASE WHEN excluded.branch = '' THEN repositories.branch ELSE excluded.branch END,
          enabled = 1,
          state = CASE WHEN repositories.state = 'disabled' THEN 'pending' ELSE repositories.state END,
          updated_at = excluded.updated_at
      `);
      database.exec("BEGIN");
      try {
        for (const config of configs) upsert.run(config.id, config.id, config.cloneUrl, config.branch ?? "", now, now);
        if (configs.length === 0) {
          database.prepare("UPDATE repositories SET enabled = 0, state = 'disabled', updated_at = ? WHERE enabled = 1").run(now);
        } else {
          const placeholders = configs.map(() => "?").join(", ");
          database.prepare(`UPDATE repositories SET enabled = 0, state = 'disabled', updated_at = ? WHERE id NOT IN (${placeholders}) AND enabled = 1`).run(now, ...configs.map(({ id }) => id));
        }
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    listRepositories(): RepositoryRecord[] {
      return records().map(toRecord);
    },
    getRepositoryIndex(id: string): RepositoryIndexRecord | undefined {
      const row = records("id = ? AND enabled = 1", [id])[0];
      return row && { ...toRecord(row), activeGeneration: row.active_generation };
    },
    beginSync(id: string): number {
      database.exec("BEGIN IMMEDIATE");
      try {
        const now = new Date().toISOString();
        database.prepare(`
          UPDATE repositories
          SET sync_generation = sync_generation + 1,
              state = CASE WHEN indexed_commit IS NULL THEN 'syncing' ELSE state END,
              last_error = NULL,
              updated_at = ?
          WHERE id = ? AND enabled = 1
        `).run(now, id);
        const row = database.prepare("SELECT sync_generation FROM repositories WHERE id = ? AND enabled = 1").get(id) as { sync_generation: number } | undefined;
        if (!row) throw new Error("등록되지 않은 저장소");
        database.exec("COMMIT");
        return row.sync_generation;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    markReady(id: string, syncGeneration: number, branch: string, cloneUrl: string, commit: string, activeGeneration: string, indexedAt: string): boolean {
      const outcome = database.prepare(`
        UPDATE repositories
        SET indexed_branch = ?, indexed_clone_url = ?, checkout_commit = ?, indexed_commit = ?, active_generation = ?,
            indexed_at = ?, state = 'ready', last_error = NULL, updated_at = ?
        WHERE id = ? AND enabled = 1 AND sync_generation = ?
      `).run(branch, cloneUrl, commit, commit, activeGeneration, indexedAt, indexedAt, id, syncGeneration);
      return outcome.changes > 0;
    },
    markSyncFailed(id: string, syncGeneration: number, code: string) {
      database.prepare(`
        UPDATE repositories
        SET state = CASE WHEN indexed_commit IS NULL THEN 'degraded' ELSE 'ready' END,
            last_error = ?, updated_at = ?
        WHERE id = ? AND enabled = 1 AND sync_generation = ?
      `).run(code, new Date().toISOString(), id, syncGeneration);
    },
  };
}

export type Registry = ReturnType<typeof openRegistry>;
