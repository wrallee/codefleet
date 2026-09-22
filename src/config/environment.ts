function commonEnvironment(env: NodeJS.ProcessEnv) {
  const dataDirectory = env.CODEFLEET_DATA_DIR ?? "/data";
  if (dataDirectory.trim() === "") throw new Error("CODEFLEET_DATA_DIR는 비어 있을 수 없음");
  return {
    dataDirectory,
    repositoriesFile: env.CODEFLEET_REPOSITORIES_FILE ?? "config/repositories.json",
    graphifyBinary: env.GRAPHIFY_BIN ?? "graphify",
  };
}

export function loadSyncEnvironment(env: NodeJS.ProcessEnv) {
  return commonEnvironment(env);
}

export function loadEnvironment(env: NodeJS.ProcessEnv) {
  const port = env.PORT === undefined ? 3000 : Number(env.PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT는 1부터 65535 사이의 정수여야 함");
  const maxConcurrentQueries = env.CODEFLEET_MAX_CONCURRENT_QUERIES === undefined ? 4 : Number(env.CODEFLEET_MAX_CONCURRENT_QUERIES);
  if (!Number.isInteger(maxConcurrentQueries) || maxConcurrentQueries < 1 || maxConcurrentQueries > 64) {
    throw new Error("CODEFLEET_MAX_CONCURRENT_QUERIES는 1부터 64 사이의 정수여야 함");
  }
  return { ...commonEnvironment(env), port, maxConcurrentQueries };
}
