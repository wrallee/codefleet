import { runCommand } from "../process/run.ts";
import type { CommandResult, RunCommandOptions } from "../process/run.ts";

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

export function createGraphifyClient(binary: string, execute: RunCommand = runCommand) {
  const env = childEnvironment();

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
    async query(graphPath: string, query: string, signal?: AbortSignal): Promise<string> {
      const result = await execute({
        executable: binary,
        args: ["query", query, "--graph", graphPath],
        timeoutMs: 600_000,
        maxOutputBytes: OUTPUT_LIMIT,
        env,
        signal,
      });
      return result.stdout;
    },
  };
}
