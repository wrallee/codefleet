import assert from "node:assert/strict";
import test from "node:test";

import { loadEnvironment } from "../src/config/environment.ts";

test("필수 토큰과 함께 기본 실행 설정을 반환한다", () => {
  assert.deepEqual(loadEnvironment({ CODEFLEET_API_TOKEN: "secret" }), {
    dataDirectory: "/data",
    repositoriesFile: "config/repositories.json",
    graphifyBinary: "graphify",
    apiToken: "secret",
    port: 3000,
  });
});

test("비어 있는 API 토큰을 거부한다", () => {
  for (const apiToken of [undefined, "", " ", "\t"]) {
    assert.throws(
      () => loadEnvironment({ CODEFLEET_API_TOKEN: apiToken }),
      /CODEFLEET_API_TOKEN/,
    );
  }
});

test("유효하지 않은 PORT를 거부한다", () => {
  for (const port of ["", "abc", "0", "65536", "1.5"]) {
    assert.throws(() => loadEnvironment({ CODEFLEET_API_TOKEN: "secret", PORT: port }), /PORT/);
  }
});

test("비어 있는 CODEFLEET_DATA_DIR를 거부한다", () => {
  for (const dataDirectory of ["", " ", "\t"]) {
    assert.throws(
      () => loadEnvironment({ CODEFLEET_API_TOKEN: "secret", CODEFLEET_DATA_DIR: dataDirectory }),
      /CODEFLEET_DATA_DIR/,
    );
  }
});
