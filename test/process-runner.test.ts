import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { runCommand } from "../src/process/run.ts";

const fixture = fileURLToPath(new URL("../test-fixtures/process-child.mjs", import.meta.url));
const environment = { PATH: process.env.PATH ?? "" };

test("셸 문자를 하나의 인수로 전달한다", async () => {
  const query = "redis; touch /tmp/codefleet-injected `id` $(whoami)";
  const result = await runCommand({
    executable: process.execPath,
    args: [fixture, "argv", query],
    timeoutMs: 1_000,
    maxOutputBytes: 64 * 1024,
    env: environment,
  });

  assert.deepEqual(JSON.parse(result.stdout), [query]);
});

test("stdout과 stderr를 동시에 소비한다", async () => {
  const result = await runCommand({
    executable: process.execPath,
    args: [fixture, "both", "131072"],
    timeoutMs: 2_000,
    maxOutputBytes: 300_000,
    env: environment,
  });

  assert.equal(result.stdout.length, 131_072);
  assert.equal(result.stderr.length, 131_072);
});

test("시간 초과, 출력 초과, spawn 실패와 취소를 안정적인 코드로 거부한다", async () => {
  await assert.rejects(
    runCommand({ executable: process.execPath, args: [fixture, "sleep"], timeoutMs: 10, maxOutputBytes: 1_024, env: environment }),
    { code: "PROCESS_TIMEOUT" },
  );
  await assert.rejects(
    runCommand({ executable: process.execPath, args: [fixture, "both", "1025"], timeoutMs: 1_000, maxOutputBytes: 1_024, env: environment }),
    { code: "PROCESS_OUTPUT_LIMIT" },
  );
  await assert.rejects(
    runCommand({ executable: "/not/a/command", args: [], timeoutMs: 1_000, maxOutputBytes: 1_024, env: environment }),
    { code: "PROCESS_SPAWN_FAILED" },
  );
  await assert.rejects(
    runCommand({ executable: process.execPath, args: [fixture, "sleep"], timeoutMs: 1_000, maxOutputBytes: 1_024, env: environment, signal: AbortSignal.abort() }),
    { code: "PROCESS_ABORTED" },
  );
});
