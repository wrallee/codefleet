export function loadEnvironment(env: NodeJS.ProcessEnv) {
  const dataDirectory = env.CODEFLEET_DATA_DIR ?? "/data";
  if (dataDirectory.trim() === "") {
    throw new Error("CODEFLEET_DATA_DIR는 비어 있을 수 없음");
  }

  const port = env.PORT === undefined ? 3000 : Number(env.PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT는 1부터 65535 사이의 정수여야 함");
  }

  return {
    dataDirectory,
    port,
  };
}
