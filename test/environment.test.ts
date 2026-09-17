import assert from "node:assert/strict";
import test from "node:test";

import { loadEnvironment } from "../src/config/environment.ts";

test("환경 변수가 없으면 기본 실행 설정을 반환한다", () => {
  assert.deepEqual(loadEnvironment({}), {
    dataDirectory: "/data",
    port: 3000,
  });
});

test("유효하지 않은 PORT를 거부한다", () => {
  for (const port of ["", "abc", "0", "65536", "1.5"]) {
    assert.throws(() => loadEnvironment({ PORT: port }), /PORT/);
  }
});

test("비어 있는 CODEFLEET_DATA_DIR를 거부한다", () => {
  for (const dataDirectory of ["", " ", "\t"]) {
    assert.throws(
      () => loadEnvironment({ CODEFLEET_DATA_DIR: dataDirectory }),
      /CODEFLEET_DATA_DIR/,
    );
  }
});
