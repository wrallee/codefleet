import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

export type RunCommandOptions = Readonly<{
  executable: string;
  args: readonly string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
}>;

export type CommandResult = Readonly<{ stdout: string; stderr: string }>;

type CommandErrorCode =
  | "PROCESS_TIMEOUT"
  | "PROCESS_OUTPUT_LIMIT"
  | "PROCESS_SPAWN_FAILED"
  | "PROCESS_EXIT_FAILURE"
  | "PROCESS_ABORTED";

export class CommandError extends Error {
  readonly code: CommandErrorCode;

  constructor(code: CommandErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export function runCommand(options: RunCommandOptions): Promise<CommandResult> {
  if (options.signal?.aborted) {
    return Promise.reject(new CommandError("PROCESS_ABORTED", "명령 실행이 취소됨"));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let failure: CommandError | undefined;
    let timeout: NodeJS.Timeout | undefined;
    let forceKill: NodeJS.Timeout | undefined;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;

    const finish = (error?: CommandError) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      options.signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    };

    let child: ChildProcess | undefined;
    const stop = (error: CommandError) => {
      if (failure || settled) return;
      failure = error;
      child?.kill("SIGTERM");
      forceKill = setTimeout(() => child?.kill("SIGKILL"), 1_000);
    };
    const abort = () => stop(new CommandError("PROCESS_ABORTED", "명령 실행이 취소됨"));

    try {
      child = spawn(options.executable, options.args, {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      finish(new CommandError("PROCESS_SPAWN_FAILED", "명령을 시작할 수 없음"));
      return;
    }
    if (!child) {
      finish(new CommandError("PROCESS_SPAWN_FAILED", "명령을 시작할 수 없음"));
      return;
    }

    const consume = (chunks: Buffer[], isStdout: boolean, chunk: Buffer) => {
      const buffer = Buffer.from(chunk);
      if (isStdout) stdoutBytes += buffer.length;
      else stderrBytes += buffer.length;
      if (stdoutBytes > options.maxOutputBytes || stderrBytes > options.maxOutputBytes) {
        stop(new CommandError("PROCESS_OUTPUT_LIMIT", "명령 출력이 제한을 초과함"));
        return;
      }
      chunks.push(buffer);
    };

    child.stdout?.on("data", (chunk: Buffer) => consume(stdout, true, chunk));
    child.stderr?.on("data", (chunk: Buffer) => consume(stderr, false, chunk));
    child.once("error", () => finish(new CommandError("PROCESS_SPAWN_FAILED", "명령을 시작할 수 없음")));
    child.once("close", (code) => {
      if (failure) finish(failure);
      else if (code === 0) finish();
      else finish(new CommandError("PROCESS_EXIT_FAILURE", "명령이 실패함"));
    });

    options.signal?.addEventListener("abort", abort, { once: true });
    timeout = setTimeout(() => stop(new CommandError("PROCESS_TIMEOUT", "명령 실행 시간이 초과됨")), options.timeoutMs);
  });
}
