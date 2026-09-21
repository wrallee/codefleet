import { accessSync, constants, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { RepositoryConfig } from "../config/repositories.ts";

const CURRENT_SCHEMA_VERSION = 1;

export type RepositoryRecord = Readonly<{
  id: string;
  branch: string;
  state: "pending" | "syncing" | "ready" | "degraded" | "disabled";
  indexedCommit: string | null;
  indexedAt: string | null;
  lastError: string | null;
}>;

type RepositoryRow = {
  id: string;
  branch: string;
  state: RepositoryRecord["state"];
  indexed_commit: string | null;
  indexed_at: string | null;
  last_error: string | null;
};

export function openRegistry(dataDirectory: string) {
  const repositoriesDirectory = join(dataDirectory, "repositories");
  const stagingDirectory = join(dataDirectory, ".staging");
  const trashDirectory = join(dataDirectory, ".trash");

  mkdirSync(repositoriesDirectory, { recursive: true });
  mkdirSync(stagingDirectory, { recursive: true });
  mkdirSync(trashDirectory, { recursive: true });

  const database = new DatabaseSync(join(dataDirectory, "codefleet.db"));
  database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");

  const { user_version: schemaVersion } = database
    .prepare("PRAGMA user_version")
    .get() as { user_version: number };

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
        state TEXT NOT NULL CHECK (
          state IN ('pending', 'syncing', 'ready', 'degraded', 'disabled', 'deleting')
        ),
        checkout_commit TEXT,
        indexed_commit TEXT,
        indexed_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      PRAGMA user_version = 1;
      COMMIT;
    `);
  }

  let open = true;

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
        accessSync(dataDirectory, constants.R_OK | constants.W_OK);
        accessSync(repositoriesDirectory, constants.R_OK | constants.W_OK);
        accessSync(stagingDirectory, constants.R_OK | constants.W_OK);
        accessSync(trashDirectory, constants.R_OK | constants.W_OK);
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
        INSERT INTO repositories (
          id, display_name, clone_url, branch, enabled, state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 1, 'pending', ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          clone_url = excluded.clone_url,
          branch = CASE WHEN excluded.branch = '' THEN repositories.branch ELSE excluded.branch END,
          enabled = 1,
          state = CASE WHEN repositories.state = 'disabled' THEN 'pending' ELSE repositories.state END,
          updated_at = excluded.updated_at
      `);
      database.exec("BEGIN");
      try {
        for (const config of configs) {
          upsert.run(config.id, config.id, config.cloneUrl, config.branch ?? "", now, now);
        }
        if (configs.length === 0) {
          database.prepare("UPDATE repositories SET enabled = 0, state = 'disabled', updated_at = ? WHERE enabled = 1").run(now);
        } else {
          const placeholders = configs.map(() => "?").join(", ");
          database.prepare(`UPDATE repositories SET enabled = 0, state = 'disabled', updated_at = ? WHERE id NOT IN (${placeholders}) AND enabled = 1`)
            .run(now, ...configs.map((config) => config.id));
        }
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    listRepositories(): RepositoryRecord[] {
      const rows = database.prepare(`
        SELECT id, branch, state, indexed_commit, indexed_at, last_error
        FROM repositories WHERE enabled = 1 ORDER BY id
      `).all() as RepositoryRow[];
      return rows.map((row) => ({
        id: row.id,
        branch: row.branch,
        state: row.state,
        indexedCommit: row.indexed_commit,
        indexedAt: row.indexed_at,
        lastError: row.last_error,
      }));
    },
    markSyncing(id: string) {
      database.prepare("UPDATE repositories SET state = 'syncing', last_error = NULL, updated_at = ? WHERE id = ? AND enabled = 1")
        .run(new Date().toISOString(), id);
    },
    markReady(id: string, branch: string, commit: string, indexedAt: string) {
      database.prepare(`
        UPDATE repositories
        SET branch = ?, state = 'ready', checkout_commit = ?, indexed_commit = ?, indexed_at = ?, last_error = NULL, updated_at = ?
        WHERE id = ? AND enabled = 1
      `).run(branch, commit, commit, indexedAt, indexedAt, id);
    },
    markDegraded(id: string, message: string) {
      database.prepare("UPDATE repositories SET state = 'degraded', last_error = ?, updated_at = ? WHERE id = ? AND enabled = 1")
        .run(message, new Date().toISOString(), id);
    },
  };
}

export type Registry = ReturnType<typeof openRegistry>;
