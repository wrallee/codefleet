import { runCommand } from "../process/run.ts";
import type { CommandResult, RunCommandOptions } from "../process/run.ts";
import { defaultGraphifyWorker, type GraphifyQueryWorker } from "./worker.ts";

const CHILD_ENV_KEYS = ["PATH", "HOME", "LANG", "LC_ALL", "SSH_AUTH_SOCK"] as const;
const OUTPUT_LIMIT = 1_048_576;

type RunCommand = (options: RunCommandOptions) => Promise<CommandResult>;

function childEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    CHILD_ENV_KEYS
      .filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key]]),
  );
}

export function createGraphifyClient(binary: string, options: Readonly<{
  execute?: RunCommand;
  queryWorker?: GraphifyQueryWorker;
  workerCount?: number;
}> = {}) {
  const env = childEnvironment();
  const execute = options.execute ?? runCommand;
  const queryWorker = options.queryWorker ?? defaultGraphifyWorker(binary, env, options.workerCount ?? 4);

  return {
    async check(): Promise<void> {
      await execute({ executable: binary, args: ["--version"], timeoutMs: 10_000, maxOutputBytes: OUTPUT_LIMIT, env });
    },
    async extract(repositoryPath: string): Promise<void> {
      await execute({
        executable: binary,
        args: ["extract", repositoryPath, "--code-only", "--no-viz"],
        cwd: repositoryPath,
        timeoutMs: 600_000,
        maxOutputBytes: OUTPUT_LIMIT,
        env,
      });
    },
    async query(repositoryPath: string, query: string, signal?: AbortSignal): Promise<string> {
      return queryWorker.query(repositoryPath, query, signal);
    },
    close(): void {
      queryWorker.close();
    },
  };
}
