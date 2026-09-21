import assert from "node:assert/strict";
import test from "node:test";

import { withRepositoryLock } from "../src/repositories/lock.ts";

test("같은 저장소는 직렬화하고 실패 뒤 잠금을 반환한다", async () => {
  const events: string[] = [];
  await Promise.all([
    withRepositoryLock("orders", async () => {
      events.push("first-start");
      await new Promise((resolve) => setTimeout(resolve, 10));
      events.push("first-end");
    }),
    withRepositoryLock("orders", async () => {
      events.push("second");
    }),
  ]);
  assert.deepEqual(events, ["first-start", "first-end", "second"]);

  await assert.rejects(withRepositoryLock("orders", async () => { throw new Error("fail"); }));
  await assert.doesNotReject(withRepositoryLock("orders", async () => undefined));
});

test("다른 저장소는 서로 기다리지 않는다", async () => {
  const result = await Promise.race([
    withRepositoryLock("orders", async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return "orders";
    }),
    withRepositoryLock("catalog", async () => "catalog"),
  ]);
  assert.equal(result, "catalog");
});
