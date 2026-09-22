import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUTPUT_LIMIT = 1_048_576;

type Pending = {
  resolve: (value: string) => void;
  reject: (reason: Error) => void;
  signal?: AbortSignal;
  abort: () => void;
};

function workerError(code: "PROCESS_SPAWN_FAILED" | "PROCESS_EXIT_FAILURE" | "PROCESS_OUTPUT_LIMIT" | "PROCESS_ABORTED", message: string) {
  return Object.assign(new Error(message), { code });
}

class PersistentWorker {
  private readonly command: string;
  private readonly args: readonly string[];
  private readonly environment: NodeJS.ProcessEnv;
  private child?: ChildProcessWithoutNullStreams;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closed = false;

  constructor(
    command: string,
    args: readonly string[],
    environment: NodeJS.ProcessEnv,
  ) {
    this.command = command;
    this.args = args;
    this.environment = environment;
  }

  private start(): ChildProcessWithoutNullStreams {
    if (this.closed) throw workerError("PROCESS_EXIT_FAILURE", "Graphify worker가 종료됨");
    if (this.child) return this.child;

    const child = spawn(this.command, [...this.args], {
      env: this.environment,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consume(child, chunk));
    child.stderr.resume();
    child.once("error", () => this.fail(child, workerError("PROCESS_SPAWN_FAILED", "Graphify worker를 시작할 수 없음")));
    child.once("close", () => this.fail(child, workerError("PROCESS_EXIT_FAILURE", "Graphify worker가 종료됨")));
    return child;
  }

  private consume(child: ChildProcessWithoutNullStreams, chunk: string) {
    if (child !== this.child) return;
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > OUTPUT_LIMIT * 2) {
      child.kill("SIGTERM");
      this.fail(child, workerError("PROCESS_OUTPUT_LIMIT", "Graphify worker 출력이 제한을 초과함"));
      return;
    }
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      this.handleLine(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  private handleLine(line: string) {
    let response: { id?: unknown; result?: unknown; error?: unknown };
    try {
      response = JSON.parse(line) as typeof response;
    } catch {
      this.child?.kill("SIGTERM");
      if (this.child) this.fail(this.child, workerError("PROCESS_EXIT_FAILURE", "Graphify worker 응답이 올바르지 않음"));
      return;
    }
    if (typeof response.id !== "number") return;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    pending.signal?.removeEventListener("abort", pending.abort);
    if (typeof response.result === "string" && Buffer.byteLength(response.result) <= OUTPUT_LIMIT) pending.resolve(response.result);
    else if (typeof response.result === "string") pending.reject(workerError("PROCESS_OUTPUT_LIMIT", "Graphify worker 출력이 제한을 초과함"));
    else pending.reject(workerError("PROCESS_EXIT_FAILURE", "Graphify 검색에 실패함"));
  }

  private fail(child: ChildProcessWithoutNullStreams, error: Error) {
    if (child !== this.child) return;
    this.child = undefined;
    this.buffer = "";
    for (const pending of this.pending.values()) {
      pending.signal?.removeEventListener("abort", pending.abort);
      pending.reject(error);
    }
    this.pending.clear();
  }

  query(repositoryPath: string, query: string, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) return Promise.reject(workerError("PROCESS_ABORTED", "Graphify 검색이 취소됨"));
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.start();
    } catch (error) {
      return Promise.reject(error);
    }
    const id = this.nextId++;
    return new Promise<string>((resolve, reject) => {
      const pending: Pending = {
        resolve,
        reject,
        signal,
        abort: () => {
          child.kill("SIGTERM");
          this.fail(child, workerError("PROCESS_ABORTED", "Graphify 검색이 취소됨"));
        },
      };
      this.pending.set(id, pending);
      signal?.addEventListener("abort", pending.abort, { once: true });
      child.stdin.write(`${JSON.stringify({ id, repositoryPath, query })}\n`, (error) => {
        if (error) this.fail(child, workerError("PROCESS_EXIT_FAILURE", "Graphify worker에 요청할 수 없음"));
      });
    });
  }

  close() {
    this.closed = true;
    const child = this.child;
    if (!child) return;
    child.kill("SIGTERM");
    this.fail(child, workerError("PROCESS_EXIT_FAILURE", "Graphify worker가 종료됨"));
  }
}

export type GraphifyQueryWorker = Readonly<{
  query(repositoryPath: string, query: string, signal?: AbortSignal): Promise<string>;
  close(): void;
}>;

export function createGraphifyWorkerPool(options: Readonly<{
  command: string;
  args: readonly string[];
  environment?: NodeJS.ProcessEnv;
  size?: number;
}>): GraphifyQueryWorker {
  const size = Math.max(1, options.size ?? 4);
  const environment = { ...options.environment, PYTHONUNBUFFERED: "1" };
  const workers = Array.from({ length: size }, () => new PersistentWorker(options.command, options.args, environment));
  const assignments = new Map<string, number>();
  let nextWorker = 0;
  return {
    query(repositoryPath, query, signal) {
      let index = assignments.get(repositoryPath);
      if (index === undefined) {
        index = nextWorker;
        nextWorker = (nextWorker + 1) % workers.length;
        assignments.set(repositoryPath, index);
      }
      return workers[index]!.query(repositoryPath, query, signal);
    },
    close() {
      for (const worker of workers) worker.close();
    },
  };
}

export function defaultGraphifyWorker(graphifyBinary: string, environment: NodeJS.ProcessEnv, size: number): GraphifyQueryWorker {
  const python = graphifyBinary.includes("/") ? join(dirname(graphifyBinary), "python") : "python3";
  const script = fileURLToPath(new URL("./worker.py", import.meta.url));
  return createGraphifyWorkerPool({ command: python, args: [script], environment, size });
}
