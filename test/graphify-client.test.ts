import assert from "node:assert/strict";
import test from "node:test";

import { createGraphifyClient } from "../src/graphify/client.ts";
import type { RunCommandOptions } from "../src/process/run.ts";

test("Graphify 명령과 자식 환경을 고정한다", async () => {
  const calls: RunCommandOptions[] = [];
  const client = createGraphifyClient("/opt/graphify/bin/graphify", async (options) => {
    calls.push(options);
    return { stdout: "NODE Redis", stderr: "" };
  });

  await client.check();
  await client.extract("/data/.staging/orders");
  const output = await client.query(
    "/data/repositories/orders/graphify-out/graph.json",
    "redis; $(touch /tmp/nope)",
  );

  const expectedEnvironment = Object.fromEntries(
    ["PATH", "HOME", "LANG", "LC_ALL", "SSH_AUTH_SOCK"]
      .filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key]]),
  );
  assert.equal(output, "NODE Redis");
  assert.deepEqual(calls[0], {
    executable: "/opt/graphify/bin/graphify",
    args: ["--version"],
    timeoutMs: 10_000,
    maxOutputBytes: 1_048_576,
    env: expectedEnvironment,
  });
  assert.deepEqual(calls[1], {
    executable: "/opt/graphify/bin/graphify",
    args: ["extract", "/data/.staging/orders", "--code-only", "--no-viz"],
    cwd: "/data/.staging/orders",
    timeoutMs: 600_000,
    maxOutputBytes: 1_048_576,
    env: expectedEnvironment,
  });
  assert.deepEqual(calls[2]?.args, [
    "query",
    "redis; $(touch /tmp/nope)",
    "--graph",
    "/data/repositories/orders/graphify-out/graph.json",
  ]);
  assert.equal(calls[2]?.env.CODEFLEET_API_TOKEN, undefined);
});
