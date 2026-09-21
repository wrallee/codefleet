import { pathToFileURL } from "node:url";

import { loadSyncEnvironment } from "./config/environment.ts";
import { loadRepositories } from "./config/repositories.ts";
import { createGraphifyClient } from "./graphify/client.ts";
import { runCommand } from "./process/run.ts";
import { openRegistry } from "./registry/database.ts";
import { createRepositoryService } from "./repositories/service.ts";

export async function sync(): Promise<void> {
  const environment = loadSyncEnvironment(process.env);
  const registry = openRegistry(environment.dataDirectory);
  try {
    await createRepositoryService({
      registry,
      graphify: createGraphifyClient(environment.graphifyBinary),
      dataDirectory: environment.dataDirectory,
      runCommand,
    }).syncAll(loadRepositories(environment.repositoriesFile));
  } finally {
    registry.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await sync();
}
