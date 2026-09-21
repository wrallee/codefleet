# Graphify 기반 CodeFleet API 구현 계획

> **구현 작업자:** 이 계획은 `superpowers:executing-plans`를 사용해 작업별로 순서대로 실행한다. 각 단계는 체크박스로 진행 상태를 기록한다.

**목표:** 설정 파일에 등록된 여러 Git 저장소를 Graphify로 안전하게 색인하고 검색하는 HTTP JSON API를 만든다.

**구조:** Node.js 서버가 JSON 설정과 SQLite 상태를 관리하고, Git과 Graphify CLI를 셸 없이 자식 프로세스로 실행한다. 색인은 임시 디렉터리에서 완성한 뒤 저장소별 잠금 안에서 교체하며, 검색 결과는 저장소와 색인 커밋 정보로 감싸 반환한다.

**기술:** Node.js 24, TypeScript 7, `node:http`, `node:sqlite`, `node:child_process`, `node:test`, Graphify `graphifyy==0.9.65`, Git

**명세:** `docs/specs/2026-09-21-graphify-api-design.md`

## 공통 제약

- `main`의 현재 코드만 기준으로 하며 `codex/apply-graft`의 코드와 커밋을 가져오지 않는다.
- 공개 인터페이스는 HTTP JSON API뿐이다. MCP와 관리 화면은 만들지 않는다.
- 저장소 설정 원본은 `config/repositories.json`, 실행 상태 원본은 기존 SQLite다.
- SQLite, 활성 체크아웃, Graphify 색인, `.staging`, `.trash`는 `CODEFLEET_DATA_DIR`
  하나 아래에 두고 단일 PVC를 그 디렉터리에 마운트한다.
- `branch`가 없는 저장소는 매 동기화에서 원격 HEAD를 감지한다. 감지 실패 시
  `main`이나 `master`를 추측하지 않고 오류 처리한다.
- Graphify는 `graphifyy==0.9.65` CLI만 사용하고 내부 Python 모듈이나 `graph.json` 구조를 직접 사용하지 않는다.
- 코드 색인은 `graphify extract <path> --code-only --no-viz`로 실행한다.
- Git과 Graphify는 `spawn`에 인수 배열과 `shell: false`를 사용한다. 요청값으로 실행 파일, 경로, 환경 변수, 추가 옵션을 받지 않는다.
- 자식 프로세스에 `CODEFLEET_API_TOKEN`을 전달하지 않는다.
- 저장소별 잠금은 한 번에 하나만 잡는다. Git 복제와 Graphify 실행 중에는 잠금을 잡지 않는다.
- 첫 버전은 저장소 색인을 직렬 실행하고 같은 저장소의 검색도 직렬화한다. `ponytail:` 주석에 같은 저장소의 처리량이 문제가 될 때 읽기/쓰기 잠금으로 바꾼다고 기록한다.
- `GET /healthz`와 `GET /readyz`를 제외한 API는 Bearer 인증을 요구한다.
- 외부 입력 길이와 자식 프로세스 실행 시간 및 출력 크기를 제한한다.
- 구현에 새 npm 운영 의존성을 추가하지 않는다.

## 검토 중점

- 검색어에 `;`, 백틱, `$()`가 포함돼도 하나의 인수로만 전달되고 다른 명령이 실행되지 않아야 한다. Task 2에서 고정한다.
- 자식 프로세스가 stdout과 stderr를 동시에 많이 출력해도 파이프 데드락 없이 완료되거나 출력 상한 오류로 끝나야 한다. Task 2에서 고정한다.
- 검색 오류·시간 초과·요청 취소 뒤에도 저장소 잠금이 반환돼 다음 검색과 색인이 진행돼야 한다. Task 3에서 고정한다.
- 활성 디렉터리 교체나 SQLite 갱신이 실패하면 기존 정상 색인이 복구돼야 한다. Task 3에서 고정한다.
- 여러 저장소 중 일부 검색만 실패하면 성공 결과는 유지되고 실패 저장소만 경고로 반환돼야 한다. Task 4에서 고정한다.

---

### Task 1: 정적 저장소 설정과 실행 환경

**파일:**

- 생성: `config/repositories.json`
- 생성: `src/config/repositories.ts`
- 수정: `src/config/environment.ts`
- 삭제: `src/admin/routes.ts`
- 삭제: `src/codegraph/client.ts`
- 삭제: `src/mcp/server.ts`
- 생성: `test/repositories-config.test.ts`
- 수정: `test/environment.test.ts`

**인터페이스:**

- 생성: `RepositoryConfig = { id: string; cloneUrl: string; branch?: string }`
- 생성: `loadRepositories(filePath: string): RepositoryConfig[]`
- 변경: `loadEnvironment(env)`가 `dataDirectory`, `repositoriesFile`, `graphifyBinary`, `apiToken`, `port`를 반환한다.

- [ ] **Step 1: 설정 파서의 실패 테스트를 작성한다**

`test/repositories-config.test.ts`에 임시 JSON 파일을 만드는 작은 헬퍼와 아래 사례를 작성한다.

```ts
test("저장소 설정을 읽는다", () => {
  const path = writeConfig({
    repositories: [
      { id: "orders", cloneUrl: "git@github.com:example/orders.git", branch: "main" },
      { id: "catalog", cloneUrl: "https://github.com/example/catalog.git" },
    ],
  });

  assert.deepEqual(loadRepositories(path), [
    { id: "orders", cloneUrl: "git@github.com:example/orders.git", branch: "main" },
    { id: "catalog", cloneUrl: "https://github.com/example/catalog.git" },
  ]);
});

test("중복 또는 옵션처럼 보이는 저장소 설정을 거부한다", () => {
  for (const repositories of [
    [{ id: "orders", cloneUrl: "https://github.com/a/b.git", branch: "main" },
     { id: "orders", cloneUrl: "https://github.com/a/c.git", branch: "main" }],
    [{ id: "-config", cloneUrl: "https://github.com/a/b.git", branch: "main" }],
    [{ id: "orders", cloneUrl: "https://evil.example/a/b.git", branch: "main" }],
    [{ id: "orders", cloneUrl: "https://github.com/a/b.git", branch: "--upload-pack=x" }],
  ]) {
    assert.throws(() => loadRepositories(writeConfig({ repositories })));
  }
});
```

- [ ] **Step 2: 환경 변수 테스트를 새 계약에 맞춘다**

`test/environment.test.ts`에서 기본값과 비어 있는 토큰 거부를 확인한다.

```ts
assert.deepEqual(loadEnvironment({ CODEFLEET_API_TOKEN: "secret" }), {
  dataDirectory: "/data",
  repositoriesFile: "config/repositories.json",
  graphifyBinary: "graphify",
  apiToken: "secret",
  port: 3000,
});
assert.throws(() => loadEnvironment({}), /CODEFLEET_API_TOKEN/);
assert.throws(() => loadEnvironment({ CODEFLEET_API_TOKEN: " " }), /CODEFLEET_API_TOKEN/);
```

- [ ] **Step 3: 새 테스트가 실패하는지 확인한다**

Run: `node --test test/repositories-config.test.ts test/environment.test.ts`

Expected: `src/config/repositories.ts`가 없고 새 환경 필드도 없어 실패한다.

- [ ] **Step 4: 최소 설정 파서를 구현한다**

`src/config/repositories.ts`는 `readFileSync`와 `JSON.parse`만 사용한다. `id`는
`/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/`, 브랜치가 있을 때만 비어 있지 않고 `-`로
시작하지 않는 값인지 1차 확인한다. URL은 아래 두 형식만 허용한다.

```ts
const HTTPS_GITHUB = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/;
const SSH_GITHUB = /^git@github\.com:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/;

export type RepositoryConfig = Readonly<{
  id: string;
  cloneUrl: string;
  branch?: string;
}>;

export function loadRepositories(filePath: string): RepositoryConfig[] {
  const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
  // 객체 모양, 배열, 문자열 필드, 정규식, 중복 ID를 순서대로 검사해 새 배열을 반환한다.
}
```

`config/repositories.json`의 초기 내용은 실제 저장소를 추측하지 않고 다음으로 둔다.

```json
{
  "repositories": []
}
```

- [ ] **Step 5: 환경 설정을 구현하고 빈 자리표시자를 삭제한다**

`src/config/environment.ts`에 다음 기본값과 검증을 추가한다.

```ts
const repositoriesFile = env.CODEFLEET_REPOSITORIES_FILE ?? "config/repositories.json";
const graphifyBinary = env.GRAPHIFY_BIN ?? "graphify";
const apiToken = env.CODEFLEET_API_TOKEN;
if (!apiToken || apiToken.trim() === "") {
  throw new Error("CODEFLEET_API_TOKEN은 비어 있을 수 없음");
}
```

관리·CodeGraph·MCP 자리표시자 세 파일은 구현 예정 파일처럼 보이지 않도록 삭제한다.

- [ ] **Step 6: 설정 테스트와 전체 타입 검사를 실행한다**

Run: `node --test test/repositories-config.test.ts test/environment.test.ts && npm run typecheck`

Expected: 모든 테스트와 타입 검사가 통과한다.

- [ ] **Step 7: 커밋한다**

```bash
git add config/repositories.json src/config src/admin/routes.ts src/codegraph/client.ts src/mcp/server.ts test/repositories-config.test.ts test/environment.test.ts
git commit -m "feat: load static repository configuration"
```

---

### Task 2: 데드락과 셸 주입을 막는 Graphify 프로세스 경계

**파일:**

- 생성: `src/process/run.ts`
- 생성: `src/graphify/client.ts`
- 생성: `test-fixtures/process-child.mjs`
- 생성: `test/process-runner.test.ts`
- 생성: `test/graphify-client.test.ts`

**인터페이스:**

- 생성: `runCommand(options: RunCommandOptions): Promise<CommandResult>`
- 생성: `createGraphifyClient(binary, runCommandFn)`
- 생성된 Graphify client 메서드:
  - `check(): Promise<void>`
  - `extract(repositoryPath: string): Promise<void>`
  - `query(graphPath: string, query: string, signal?: AbortSignal): Promise<string>`

```ts
type RunCommandOptions = Readonly<{
  executable: string;
  args: readonly string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
}>;

type CommandResult = Readonly<{ stdout: string; stderr: string }>;
```

- [ ] **Step 1: 자식 프로세스 안전성 테스트를 작성한다**

`test-fixtures/process-child.mjs`는 전달받은 모드에 따라 argv 출력, stdout/stderr 대량
출력, 무한 대기를 수행한다. `test/process-runner.test.ts`는 다음을 확인한다.

```ts
test("셸 문자를 하나의 인수로 전달한다", async () => {
  const query = "redis; touch /tmp/codefleet-injected `id` $(whoami)";
  const result = await runCommand({
    executable: process.execPath,
    args: [fixture, "argv", query],
    timeoutMs: 1_000,
    maxOutputBytes: 64 * 1024,
    env: { PATH: process.env.PATH ?? "" },
  });
  assert.deepEqual(JSON.parse(result.stdout), [query]);
});

test("stdout과 stderr를 동시에 소비한다", async () => {
  const result = await runCommand({
    executable: process.execPath,
    args: [fixture, "both", "131072"],
    timeoutMs: 2_000,
    maxOutputBytes: 300_000,
    env: { PATH: process.env.PATH ?? "" },
  });
  assert.equal(result.stdout.length, 131072);
  assert.equal(result.stderr.length, 131072);
});
```

시간 초과, 출력 초과, spawn `error`, 이미 취소된 `AbortSignal`도 각각 안정적인 코드로
한 번만 reject되는지 검사한다.

- [ ] **Step 2: Graphify 명령 구성 테스트를 작성한다**

가짜 `runCommandFn`에 전달된 인수 전체를 기록한다.

```ts
assert.deepEqual(calls[0], {
  executable: "/opt/graphify/bin/graphify",
  args: ["extract", "/data/.staging/orders", "--code-only", "--no-viz"],
  cwd: "/data/.staging/orders",
  timeoutMs: 600_000,
  maxOutputBytes: 1_048_576,
  env: expectedChildEnvironment,
});

assert.deepEqual(calls[1]?.args, [
  "query",
  "redis; $(touch /tmp/nope)",
  "--graph",
  "/data/repositories/orders/graphify-out/graph.json",
]);
```

- [ ] **Step 3: 새 테스트가 실패하는지 확인한다**

Run: `node --test test/process-runner.test.ts test/graphify-client.test.ts`

Expected: 두 구현 파일이 없어 실패한다.

- [ ] **Step 4: 출력 스트림을 즉시 소비하는 실행기를 구현한다**

`src/process/run.ts`는 `spawn` 직후 stdout과 stderr에 `data` 리스너를 붙인다.
각 스트림의 바이트를 따로 계산하고 상한을 넘으면 종료를 시작한다.

```ts
const child = spawn(options.executable, options.args, {
  cwd: options.cwd,
  env: options.env,
  shell: false,
  stdio: ["ignore", "pipe", "pipe"],
});

let settled = false;
const finish = (error?: Error) => {
  if (settled) return;
  settled = true;
  clearTimeout(timeout);
  options.signal?.removeEventListener("abort", abort);
  error ? reject(error) : resolve({ stdout, stderr });
};
```

종료는 `SIGTERM` 후 1초 유예하고 남아 있으면 `SIGKILL`한다. `error`는 spawn 실패,
`close`는 최종 종료 처리에 사용하며 `exit`만으로 promise를 끝내지 않는다. 오류에는
`PROCESS_TIMEOUT`, `PROCESS_OUTPUT_LIMIT`, `PROCESS_SPAWN_FAILED`,
`PROCESS_EXIT_FAILURE`, `PROCESS_ABORTED` 중 하나의 코드를 둔다.

- [ ] **Step 5: 최소 Graphify client를 구현한다**

자식 환경은 현재 환경 전체를 복사하지 않고 다음 키만 존재할 때 전달한다.

```ts
const CHILD_ENV_KEYS = ["PATH", "HOME", "LANG", "LC_ALL", "SSH_AUTH_SOCK"] as const;
```

`check()`는 `graphify --version`, `extract()`와 `query()`는 Step 2의 인수만 사용한다.
검색어는 어떤 전처리나 셸 이스케이프도 하지 않고 배열의 한 원소로 전달한다.

- [ ] **Step 6: 프로세스 및 Graphify client 테스트를 실행한다**

Run: `node --test test/process-runner.test.ts test/graphify-client.test.ts && npm run typecheck`

Expected: 대량 양방향 출력 테스트가 2초 안에 끝나고 모든 테스트가 통과한다.

- [ ] **Step 7: 커밋한다**

```bash
git add src/process/run.ts src/graphify/client.ts test-fixtures/process-child.mjs test/process-runner.test.ts test/graphify-client.test.ts
git commit -m "feat: add safe Graphify process boundary"
```

---

### Task 3: 저장소 상태, 직렬 잠금, 원자적 색인 교체

**파일:**

- 수정: `src/registry/database.ts`
- 생성: `src/repositories/lock.ts`
- 구현: `src/repositories/service.ts`
- 생성: `src/sync.ts`
- 수정: `package.json`
- 수정: `test/registry.test.ts`
- 생성: `test/repository-lock.test.ts`
- 생성: `test/repository-service.test.ts`

**인터페이스:**

- Registry 생성 메서드:
  - `reconcile(configs: RepositoryConfig[]): void`
  - `listRepositories(): RepositoryRecord[]`
  - `markSyncing(id: string): void`
  - `markReady(id: string, branch: string, commit: string, indexedAt: string): void`
  - `markDegraded(id: string, message: string): void`
- 생성: `withRepositoryLock<T>(id: string, work: () => Promise<T>): Promise<T>`
- 생성: `createRepositoryService({ registry, graphify, dataDirectory, runCommand })`
- 서비스 메서드:
  - `syncAll(configs: RepositoryConfig[]): Promise<void>`
  - `search(query: string, repositoryIds?: string[], signal?: AbortSignal): Promise<SearchOutcome>`

```ts
type RepositoryRecord = Readonly<{
  id: string;
  branch: string;
  state: "pending" | "syncing" | "ready" | "degraded" | "disabled";
  indexedCommit: string | null;
  indexedAt: string | null;
  lastError: string | null;
}>;

type SearchOutcome = Readonly<{
  results: readonly Readonly<{
    repositoryId: string;
    indexedCommit: string;
    indexedAt: string;
    output: string;
  }>[];
  warnings: readonly Readonly<{
    repositoryId: string;
    code: string;
    message: string;
  }>[];
}>;
```

- [ ] **Step 1: 레지스트리 조정 테스트를 작성한다**

설정을 SQLite에 넣고 제거된 설정은 검색 목록에서 제외되는지 확인한다. 기존 테이블의
불필요한 관리 필드는 마이그레이션으로 삭제하지 않고 쓰지 않는다.

```ts
registry.reconcile([
  { id: "orders", cloneUrl: "https://github.com/example/orders.git", branch: "main" },
]);
assert.deepEqual(registry.listRepositories().map(({ id, state }) => ({ id, state })), [
  { id: "orders", state: "pending" },
]);
```

- [ ] **Step 2: 저장소 잠금 회귀 테스트를 작성한다**

같은 저장소 작업은 직렬, 다른 저장소 작업은 독립 실행되는지 확인한다. 첫 작업이
throw하거나 취소돼도 두 번째 작업이 제한 시간 안에 완료돼야 한다.

```ts
await assert.rejects(() => withRepositoryLock("orders", async () => { throw new Error("fail"); }));
await assert.doesNotReject(() => Promise.race([
  withRepositoryLock("orders", async () => undefined),
  scheduler.wait(500).then(() => { throw new Error("lock leaked"); }),
]));
```

구현에는 다음 한계 주석을 남긴다.

```ts
// ponytail: same-repository operations are serialized; replace with a read/write gate only if measured query throughput requires it.
```

- [ ] **Step 3: 동기화와 검색 실패 테스트를 작성한다**

가짜 Git·Graphify 실행기로 다음 순서를 고정한다.

- branch가 없으면 `git ls-remote --symref <url> HEAD`가 돌려준
  `ref: refs/heads/trunk\tHEAD`에서 `trunk`를 선택한다.
- `HEAD` symref가 없거나 `refs/heads/` 형식이 아니면 `DEFAULT_BRANCH_UNRESOLVED`로
  degraded 처리하고 clone을 실행하지 않는다.
- Git 브랜치 검증: `git check-ref-format --branch <branch>`
- 복제: `git clone --depth=1 --single-branch --no-tags --branch <branch> -- <url> <staging>`
- 커밋 확인: `git -C <staging> rev-parse HEAD`
- Graphify 색인
- 그래프 파일 확인
- 활성 디렉터리 교체
- SQLite `ready` 기록

교체 두 번째 rename 또는 `markReady`를 강제로 실패시켜 이전 활성 디렉터리와 이전
DB 커밋이 복구되는지 검사한다. 검색 중 Graphify query가 실패하거나 취소된 뒤 같은
저장소의 다음 `syncAll`이 완료되는지도 검사한다.

- [ ] **Step 4: 테스트가 실패하는지 확인한다**

Run: `node --test test/registry.test.ts test/repository-lock.test.ts test/repository-service.test.ts`

Expected: 새 메서드와 구현이 없어 실패한다.

- [ ] **Step 5: 기존 SQLite에 최소 상태 연산을 추가한다**

`reconcile`은 한 트랜잭션에서 설정 항목을 upsert하고, 설정에서 제거된 항목은
`enabled=0`, `state='disabled'`로 바꾼다. 설정의 `branch`가 없으면 기존에 감지한
브랜치를 덮어쓰지 않는다. `markReady`는 해석된 브랜치와 checkout/indexed commit을
저장하고 오류를 지운다. API에 원본 SQLite 객체를 노출하지 않는다.

- [ ] **Step 6: 저장소별 promise 체인 잠금을 구현한다**

Map에 저장소별 마지막 promise를 두고, 이전 promise의 성공·실패와 무관하게 다음
작업이 실행되도록 연결한다. 현재 작업의 `finally`에서 자신이 마지막일 때만 Map에서
삭제한다. 잠금 구현은 재진입을 지원하지 않으며 서비스는 잠금 안에서 같은 잠금을
다시 호출하지 않는다.

- [ ] **Step 7: staging 색인과 원자 교체를 구현한다**

`/data/.staging`과 `/data/.trash`는 실제 디렉터리인지 확인한다. 임시 디렉터리는
`mkdtemp`로 만들고, 활성·이전·staging 경로가 모두 data root 바로 아래인지 확인한
뒤에만 rename 또는 재귀 삭제한다.

Graphify와 Git은 잠금 밖에서 실행한다. branch가 명시되지 않았으면 staging 생성 전에
원격 HEAD를 감지하고, 감지한 이름을 `git check-ref-format --branch`로 검증한다.
완성된 staging만 잠금 안에서 다음 순서로 교체한다.

```ts
await withRepositoryLock(id, async () => {
  if (existsSync(active)) await rename(active, previous);
  try {
    await rename(staging, active);
    registry.markReady(id, branch, commit, new Date().toISOString());
  } catch (error) {
    if (existsSync(active)) await rename(active, staging);
    if (existsSync(previous)) await rename(previous, active);
    throw error;
  }
});
```

이전 디렉터리는 잠금을 반환한 뒤 검증된 trash 경로에서 정리한다. 실패 시 기존 활성
색인을 유지하고 `markDegraded`를 시도하되 원래 오류를 잃지 않는다.

- [ ] **Step 8: 검색과 수동 sync 진입점을 구현한다**

검색은 선택된 각 저장소의 잠금 안에서 Graphify query를 실행하고 메타데이터를 붙인다.
저장소 간 실행은 `Promise.allSettled`로 독립 처리한다. `src/sync.ts`는 환경과 설정을
읽고 `syncAll`을 호출한 뒤 DB를 닫는다. `package.json`에 아래 스크립트를 추가한다.

```json
"sync": "node src/sync.ts"
```

- [ ] **Step 9: 저장소 테스트와 타입 검사를 실행한다**

Run: `node --test test/registry.test.ts test/repository-lock.test.ts test/repository-service.test.ts && npm run typecheck`

Expected: 교체 실패·검색 실패·취소 테스트를 포함해 모두 통과한다.

- [ ] **Step 10: 커밋한다**

```bash
git add src/registry/database.ts src/repositories src/sync.ts package.json test/registry.test.ts test/repository-lock.test.ts test/repository-service.test.ts
git commit -m "feat: sync Graphify repository indexes"
```

---

### Task 4: 인증된 다중 저장소 HTTP 검색 API

**파일:**

- 수정: `src/server.ts`
- 수정: `test/server.test.ts`
- 생성: `test/search-api.test.ts`

**인터페이스:**

- 변경: `createServer({ registry, repositories, apiToken, isGraphifyReady })`
- 변경: `start(config = loadEnvironment(process.env)): Promise<Application>`
- 공개 경로: `GET /healthz`, `GET /readyz`, `GET /repositories`, `POST /search`

- [ ] **Step 1: 인증과 요청 크기 테스트를 작성한다**

`GET /repositories`와 `POST /search`는 토큰 누락 시 401, 틀린 토큰은 403을 반환한다.
토큰 비교는 길이를 먼저 확인한 뒤 `timingSafeEqual`을 사용한다. 본문은 16 KiB를
넘기면 연결을 계속 읽지 않고 413을 반환한다.

```ts
const response = await fetch(`${baseUrl}/search`, {
  method: "POST",
  headers: { authorization: "Bearer wrong", "content-type": "application/json" },
  body: JSON.stringify({ query: "redis" }),
});
assert.equal(response.status, 403);
```

- [ ] **Step 2: 검색 입력과 부분 실패 테스트를 작성한다**

빈 검색어, 1,001자를 넘는 검색어, 문자열이 아닌 `repositoryIds`, 등록되지 않은 ID를
400으로 거부한다. 두 저장소 중 하나가 실패하면 200과 성공 결과 하나, 경고 하나를
반환하고, 모두 실패하면 503을 반환한다.

```ts
assert.deepEqual(await response.json(), {
  query: "redis",
  results: [{ repositoryId: "orders", indexedCommit: "abc", indexedAt, output: "NODE Redis" }],
  warnings: [{ repositoryId: "catalog", code: "GRAPHIFY_TIMEOUT", message: "코드 그래프 검색 시간이 초과됨" }],
});
```

- [ ] **Step 3: 준비 상태와 저장소 목록 테스트를 작성한다**

`/readyz`는 DB·데이터 디렉터리·설정·Graphify 실행 가능 여부가 모두 참일 때만 200을
반환한다. 개별 저장소가 pending/degraded인 것은 전체 준비 상태를 503으로 만들지
않는다. `/repositories`는 clone URL과 로컬 경로를 반환하지 않는다.

- [ ] **Step 4: 새 API 테스트가 실패하는지 확인한다**

Run: `node --test test/server.test.ts test/search-api.test.ts`

Expected: 새 의존성 계약과 두 API가 없어 실패한다.

- [ ] **Step 5: native HTTP 처리만으로 API를 구현한다**

작은 `writeJson`, `readJsonBody`, `authenticate` 함수는 `src/server.ts` 안에 둔다.
본문을 문자열로 합치기 전에 누적 바이트를 검사한다. JSON 파싱 오류와 잘못된 모양은
400으로 통일하되 내부 오류 원문은 응답하지 않는다.

요청의 `close`와 `aborted` 이벤트를 하나의 `AbortController`에 연결하고 검색 서비스에
signal을 전달한다. 응답 종료 뒤 중복 write를 하지 않도록 한 경로에서만 응답한다.

- [ ] **Step 6: start에서 실제 의존성을 조립한다**

시작 순서는 환경 로드, 저장소 설정 로드, SQLite open/reconcile, Graphify `check`,
repository service 생성, HTTP listen이다. 설정 또는 SQLite 준비 실패는 포트를 열지
않고 종료한다. Graphify `check` 실패는 프로세스를 끝내지 않고 readiness를 false로
보관해 `/healthz`는 200, `/readyz`는 503을 반환하게 한다. 종료 시 새 요청을 받지
않고 서버 close 후 DB를 닫는다.

- [ ] **Step 7: API 테스트와 전체 단위 검증을 실행한다**

Run: `node --test test/server.test.ts test/search-api.test.ts && npm run check`

Expected: 인증·본문 상한·부분 실패·취소 테스트를 포함한 전체 검증이 통과한다.

- [ ] **Step 8: 커밋한다**

```bash
git add src/server.ts test/server.test.ts test/search-api.test.ts
git commit -m "feat: expose authenticated Graphify search API"
```

---

### Task 5: 실제 Graphify 검증과 실행 이미지

**파일:**

- 수정: `Dockerfile`
- 수정: `.dockerignore`
- 수정: `README.md`
- 생성: `THIRD_PARTY_NOTICES.md`
- 생성: `test/graphify-integration.test.ts`
- 생성: `test/fixtures/orders/src/RedisConfig.ts`
- 생성: `test/fixtures/catalog/src/CacheRepository.ts`

**인터페이스:**

- Docker 실행 환경에 `/opt/graphify/bin/graphify`가 존재한다.
- `GRAPHIFY_BIN` 기본값은 로컬 `graphify`, Docker 환경 값은 위 절대 경로다.
- 통합 테스트는 `GRAPHIFY_BIN`이 없으면 명시적으로 skip하고, 최종 Docker 검증에서는 skip 없이 실행한다.

- [ ] **Step 1: 실제 다중 저장소 통합 테스트를 작성한다**

두 fixture 저장소를 임시 bare remote로 만들고 각각 커밋한다. 운영 설정 파서는 로컬
경로를 거부하므로, 테스트는 검증된 `RepositoryConfig[]`를 repository service에 직접
전달한다. `syncAll` 뒤 `search("redis related sources")`가 두 저장소의 ID와 서로 다른
indexed commit을 반환하는지 확인한다. catalog fixture도 Redis 호출 또는 import를
포함해 질의의 직접 seed가 존재하게 한다.

한 저장소의 새 커밋에서 `RedisConfig`를 제거하고 다시 색인한 뒤 제거된 노드가 새
결과에 남지 않는지도 확인한다. 테스트 제한 시간은 120초로 명시한다.

- [ ] **Step 2: Graphify가 있는 환경에서 테스트가 실패하는지 확인한다**

Run: `GRAPHIFY_BIN="$(command -v graphify)" node --test test/graphify-integration.test.ts`

Expected: Docker/runtime 준비 전에는 Graphify 실행 파일이 없으면 skip되고, 설치된
환경에서는 누락된 이미지 설정 또는 실제 연동 문제로 실패한다. skip 결과를 실제
통합 성공으로 간주하지 않는다.

- [ ] **Step 3: Docker 이미지에 고정 Graphify와 Git을 설치한다**

실행 단계에 Python venv와 Git을 설치하고 패키지 버전을 고정한다.

```dockerfile
RUN apt-get update \
 && apt-get install -y --no-install-recommends git openssh-client ca-certificates python3 python3-venv \
 && python3 -m venv /opt/graphify \
 && /opt/graphify/bin/pip install --no-cache-dir graphifyy==0.9.65 \
 && rm -rf /var/lib/apt/lists/*
ENV GRAPHIFY_BIN=/opt/graphify/bin/graphify
```

verify 단계에도 같은 Graphify 설치를 두고 실제 통합 테스트를 실행한다. Docker에는
`config/repositories.json`, `package.json`, 잠금 파일과 필요한 소스만 복사한다.

- [ ] **Step 4: 라이선스와 운영 문서를 추가한다**

`THIRD_PARTY_NOTICES.md`에 Graphify 이름, 고정 버전, Apache-2.0, 원본 저장소 URL,
설치된 wheel의 `LICENSE`, `LICENSE-MIT`, `NOTICE` 위치를 기록한다. Docker 검증에서
`/opt/graphify/lib/python*/site-packages/graphifyy-*.dist-info/licenses/` 아래 세 파일이
포함됐는지 확인한다.

README에는 다음만 기록한다.

- `config/repositories.json` 작성 형식
- `CODEFLEET_API_TOKEN`, `CODEFLEET_DATA_DIR`, `GRAPHIFY_BIN`
- `npm run sync`, `npm start`
- `/healthz`, `/readyz`, `/repositories`, `/search` 예시
- MCP와 관리 화면은 제공하지 않는다는 현재 범위

- [ ] **Step 5: 전체 로컬 검증을 실행한다**

Run: `npm run check`

Expected: 타입 검사와 모든 단위 테스트가 통과한다. Graphify가 로컬에 없으면 통합
테스트 하나만 명시적으로 skip된다.

- [ ] **Step 6: Docker 이미지와 실제 Graphify 통합을 검증한다**

Run: `docker build -t codefleet:graphify .`

Expected: verify 단계에서 실제 Graphify 통합 테스트가 skip 없이 통과하고 이미지가
완성된다.

Run: `docker run --rm codefleet:graphify /opt/graphify/bin/graphify --version`

Expected: `0.9.65`를 출력한다.

Run: `docker run --rm codefleet:graphify sh -c 'test -f /opt/graphify/lib/python*/site-packages/graphifyy-*.dist-info/licenses/LICENSE && test -f /opt/graphify/lib/python*/site-packages/graphifyy-*.dist-info/licenses/NOTICE'`

Expected: 종료 코드 0.

- [ ] **Step 7: 커밋한다**

```bash
git add Dockerfile .dockerignore README.md THIRD_PARTY_NOTICES.md test/graphify-integration.test.ts test/fixtures
git commit -m "test: verify Graphify API end to end"
```

---

## 최종 검증

- [ ] `npm run check`가 실패와 예기치 않은 skip 없이 끝나는지 확인한다. 로컬 Graphify
  부재로 인한 통합 테스트 skip은 Docker 검증 성공으로 대체한다.
- [ ] `docker build -t codefleet:graphify .`의 실제 Graphify 통합 테스트가 통과하는지 확인한다.
- [ ] Docker verify 단계의 로컬 bare Git fixture로 실제 색인과 검색이 저장소 ID 및
  indexed commit을 반환하는지 확인한다.
- [ ] 악성 검색 문자열이 다른 명령이나 파일을 만들지 않는지 컨테이너에서도 확인한다.
- [ ] `git status --short`에 계획 밖 변경이나 생성 파일이 없는지 확인한다.
- [ ] 구현 커밋 전체를 명세와 대조해 MCP, 관리 화면, Zoekt 코드가 추가되지 않았는지 확인한다.
