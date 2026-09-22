import assert from "node:assert/strict";
import test from "node:test";

import { loadEnvironment, loadSyncEnvironment } from "../src/config/environment.ts";

test("기본 실행 설정을 반환한다", () => {
  assert.deepEqual(loadEnvironment({}), {
    dataDirectory: "/data",
    repositoriesFile: "config/repositories.json",
    graphifyBinary: "graphify",
    port: 3000,
    maxConcurrentQueries: 4,
  });
});

test("sync 설정은 PORT 없이 공통 경로만 읽는다", () => {
  assert.deepEqual(loadSyncEnvironment({}), {
    dataDirectory: "/data",
    repositoriesFile: "config/repositories.json",
    graphifyBinary: "graphify",
  });
});

test("동시 Graphify 검색 상한을 1부터 64로 제한한다", () => {
  assert.equal(loadEnvironment({ CODEFLEET_MAX_CONCURRENT_QUERIES: "64" }).maxConcurrentQueries, 64);
  for (const value of ["", "0", "65", "1.5", "unknown"]) {
    assert.throws(() => loadEnvironment({ CODEFLEET_MAX_CONCURRENT_QUERIES: value }), /CODEFLEET_MAX_CONCURRENT_QUERIES/);
  }
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
