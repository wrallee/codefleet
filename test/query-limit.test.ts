import assert from "node:assert/strict";
import test from "node:test";

import { createQueryLimit } from "../src/repositories/query-limit.ts";

test("FIFO 상한은 대기 중 취소 작업 없이 다음 검색을 시작한다", async () => {
  const limit = createQueryLimit(2);
  const started: number[] = [];
  let active = 0;
  let peak = 0;
  const releases: Array<() => void> = [];
  const work = (id: number) => async () => {
    started.push(id);
    active += 1;
    peak = Math.max(peak, active);
    await new Promise<void>((resolve) => releases.push(resolve));
    active -= 1;
    return id;
  };
  const aborted = new AbortController();
  const first = limit.run(work(1));
  const second = limit.run(work(2));
  const third = limit.run(work(3), aborted.signal);
  const fourth = limit.run(work(4));

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [1, 2]);
  aborted.abort();
  await assert.rejects(third, { code: "SEARCH_ABORTED" });
  releases.shift()?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [1, 2, 4]);
  assert.equal(peak, 2);
  releases.shift()?.();
  releases.shift()?.();
  assert.deepEqual(await Promise.all([first, second, fourth]), [1, 2, 4]);
});
