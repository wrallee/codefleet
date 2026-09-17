import { accessSync, constants, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const CURRENT_SCHEMA_VERSION = 1;

export function openRegistry(dataDirectory: string) {
  const repositoriesDirectory = join(dataDirectory, "repositories");
  const trashDirectory = join(dataDirectory, ".trash");

  mkdirSync(repositoriesDirectory, { recursive: true });
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
    trashDirectory,
    isReady() {
      if (!open) return false;

      try {
        database.prepare("SELECT 1").get();
        accessSync(dataDirectory, constants.R_OK | constants.W_OK);
        accessSync(repositoriesDirectory, constants.R_OK | constants.W_OK);
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
  };
}

export type Registry = ReturnType<typeof openRegistry>;
