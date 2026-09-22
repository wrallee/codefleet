import assert from "node:assert/strict";
import test from "node:test";

import { createGraphifyWorkerPool } from "../src/graphify/worker.ts";

test("저장소별 Graphify worker를 재사용한다", async () => {
  const pool = createGraphifyWorkerPool({
    command: process.execPath,
    args: ["test-fixtures/graphify-worker.mjs"],
    environment: process.env,
    size: 2,
  });

  try {
    const first = await pool.query("/data/repositories/orders", "redis");
    const second = await pool.query("/data/repositories/orders", "cache");
    const other = await pool.query("/data/repositories/catalog", "catalog");
    assert.equal(first.split(":")[0], second.split(":")[0]);
    assert.notEqual(first.split(":")[0], other.split(":")[0]);
    assert.match(second, /orders:cache$/);
  } finally {
    pool.close();
  }
});
