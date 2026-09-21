# Graphify API 운영 안전성 보강 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 리뷰에서 확인된 프로세스 간 색인 수명주기, provenance, 오류 계약, 검색 부하, 경로 및 런타임 문제를 모두 수정한다.

**Architecture:** 완성된 색인을 불변 generation 디렉터리에 게시하고 SQLite가 활성 generation과 동일한 provenance를 가리키게 한다. sync 세대 번호로 오래된 작업의 게시를 차단하며, 검색은 삭제되지 않는 generation을 사용하므로 프로세스 간 메모리 잠금이 필요 없다. API 검색 프로세스 수는 취소 가능한 FIFO 제한기로 제어한다.

**Tech Stack:** Node.js 24, TypeScript 7, `node:http`, `node:sqlite`, `node:fs`, `node:test`, Graphify 0.9.65, Docker

**Spec:** `docs/specs/2026-09-22-graphify-api-hardening-design.md`

## 공통 제약

- MCP, 관리 화면, Zoekt 런타임 코드를 추가하지 않는다.
- `CODEFLEET_DATA_DIR` 아래 SQLite, staging, checkout, generation만 사용한다.
- Git과 Graphify는 인수 배열과 `shell: false`로만 실행한다.
- 기존 v1 고정 경로 색인은 다음 성공 sync까지 검색할 수 있어야 한다.
- 이전 generation은 자동 삭제하지 않는다.
- 외부 API에 stderr, 토큰, clone URL, 내부 경로를 반환하지 않는다.
- 새 런타임 의존성을 추가하지 않는다.

## 검토 중점

- API 서버 검색 중 별도 sync 프로세스가 새 generation을 게시해도 진행 중 검색 경로가 유지되어야 한다. Task 1에서 고정한다.
- 설정 branch가 바뀌어도 성공 sync 전까지 이전 indexed branch와 commit을 표시해야 한다. Task 1에서 고정한다.
- 오래된 sync 또는 게시 직전 실패가 활성 포인터를 바꾸지 않아야 한다. Task 1에서 고정한다.
- 중복·대량 저장소 요청과 동시에 들어온 여러 요청이 전역 Graphify 프로세스 상한을 넘지 않아야 한다. Task 2에서 고정한다.
- symlink 관리 경로와 readiness 일시 장애가 각각 안전한 실패와 TTL 이후 회복으로 이어져야 한다. Task 1과 Task 3에서 고정한다.

---

### Task 1: 불변 generation과 정확한 색인 provenance

**Files:**

- Modify: `src/registry/database.ts`
- Modify: `src/repositories/service.ts`
- Delete: `src/repositories/lock.ts`
- Modify: `test/registry.test.ts`
- Modify: `test/repository-service.test.ts`
- Delete: `test/repository-lock.test.ts`

**Interfaces:**

- `Registry.beginSync(id: string): number`
- `Registry.markReady(id, syncGeneration, branch, cloneUrl, commit, activeGeneration, indexedAt): boolean`
- `Registry.markSyncFailed(id: string, syncGeneration: number, code: string): void`
- `Registry.getRepositoryIndex(id: string): RepositoryIndexRecord | undefined`
- `RepositoryIndexRecord`은 공개 `RepositoryRecord`에 `activeGeneration: string | null`만 추가한다.

- [ ] **Step 1: v2 migration과 provenance 실패 테스트를 작성한다**

`test/registry.test.ts`에 v1 DB를 만든 뒤 다시 열어 `indexed_branch`,
`indexed_clone_url`, `active_generation`, `sync_generation`이 추가되는지 검사한다. 설정을
`main`에서 `release`로 reconcile한 직후 공개 branch와 indexed commit은 기존 값을 유지해야 한다.

```ts
registry.reconcile([{ id: "orders", cloneUrl: OLD_URL, branch: "main" }]);
const token = registry.beginSync("orders");
assert.equal(registry.markReady("orders", token, "main", OLD_URL, "abc123", "g1", NOW), true);
registry.reconcile([{ id: "orders", cloneUrl: NEW_URL, branch: "release" }]);
assert.deepEqual(registry.listRepositories()[0], {
  id: "orders", branch: "main", state: "ready",
  indexedCommit: "abc123", indexedAt: NOW, lastError: null,
});
```

- [ ] **Step 2: sync 세대 fencing 실패 테스트를 작성한다**

같은 저장소에서 두 토큰을 발급하고 오래된 토큰의 성공·실패 기록이 최신 토큰이나 기존
활성 색인을 바꾸지 않는지 확인한다.

```ts
const oldToken = registry.beginSync("orders");
const newToken = registry.beginSync("orders");
assert.equal(registry.markReady("orders", oldToken, "main", OLD_URL, "old", "old-g", NOW), false);
assert.equal(registry.markReady("orders", newToken, "main", OLD_URL, "new", "new-g", NOW), true);
registry.markSyncFailed("orders", oldToken, "GIT_FAILED");
assert.equal(registry.listRepositories()[0]?.indexedCommit, "new");
```

- [ ] **Step 3: 독립 서비스 검색·sync와 게시 실패 테스트를 작성한다**

같은 data root를 연 Registry 두 개와 RepositoryService 두 개를 만든다. 첫 서비스의 query를
대기시킨 동안 둘째 서비스가 새 generation을 게시하고, 첫 검색이 이전 graph 경로와
commit으로 끝나는지 검사한다. `markReady`가 false 또는 throw하는 경우 기존 포인터와
검색이 유지되고 완성된 새 디렉터리는 참조되지 않은 채 남아야 한다.

- [ ] **Step 4: symlink 관리 디렉터리 실패 테스트를 작성한다**

외부 임시 디렉터리를 가리키는 `.staging` symlink를 만든 뒤 registry open 또는 sync가
거부되고 외부 파일이 유지되는지 확인한다. `repositories/<id>`와 `generations`에도 같은
검사를 적용한다.

- [ ] **Step 5: 새 테스트가 기존 구현에서 실패하는지 확인한다**

Run: `node --test test/registry.test.ts test/repository-service.test.ts`

Expected: migration 열 부재, 잘못된 branch 표시, 공유되지 않는 잠금 또는 새 Registry API
부재, symlink 허용으로 실패한다.

- [ ] **Step 6: SQLite v2와 sync fencing을 구현한다**

`PRAGMA busy_timeout = 5000`을 설정하고 v1에서 다음 열을 추가한다.

```sql
ALTER TABLE repositories ADD COLUMN indexed_branch TEXT;
ALTER TABLE repositories ADD COLUMN indexed_clone_url TEXT;
ALTER TABLE repositories ADD COLUMN active_generation TEXT;
ALTER TABLE repositories ADD COLUMN sync_generation INTEGER NOT NULL DEFAULT 0;
UPDATE repositories
SET indexed_branch = branch, indexed_clone_url = clone_url
WHERE indexed_commit IS NOT NULL;
PRAGMA user_version = 2;
```

`beginSync`은 `BEGIN IMMEDIATE` 안에서 `sync_generation`을 증가시킨다. 활성 색인이 없는
행만 `syncing`으로 바꾼다. `markReady`와 `markSyncFailed`는
`WHERE id = ? AND sync_generation = ?` fencing 조건을 사용한다.

- [ ] **Step 7: 관리 디렉터리 검증을 구현한다**

data root는 `realpathSync`로 고정한다. 관리 하위 디렉터리는 `lstat`으로 symlink와 파일을
거부하고 `realpath`가 root 내부인지 확인한다. 생성한 repository root와 `generations`도
게시 직전에 다시 확인한다.

- [ ] **Step 8: 불변 generation 게시와 검색을 구현한다**

staging 검증 뒤 `${commit}-${randomUUID()}` generation으로 rename하고, DB 게시가 성공한
경우에만 활성화한다. 검색은 `activeGeneration`이 있으면 generation 경로, 없으면 v1 고정
경로를 사용한다. 기존 디렉터리는 삭제하지 않는다.

```ts
// ponytail: immutable generations are retained; add retention cleanup only when PVC usage proves it is needed.
```

프로세스 로컬 `withRepositoryLock`과 해당 테스트를 삭제한다.

- [ ] **Step 9: Task 1 검증을 실행한다**

Run: `node --test test/registry.test.ts test/repository-service.test.ts && npm run typecheck`

Expected: 모두 통과한다.

- [ ] **Step 10: 커밋한다**

```bash
git add src/registry/database.ts src/repositories test/registry.test.ts test/repository-service.test.ts
git commit -m "fix: make Graphify index publication crash-safe"
```

### Task 2: 검색 상한과 안정적인 오류 계약

**Files:**

- Create: `src/repositories/query-limit.ts`
- Modify: `src/repositories/service.ts`
- Modify: `src/server.ts`
- Modify: `src/config/environment.ts`
- Create: `test/query-limit.test.ts`
- Modify: `test/environment.test.ts`
- Modify: `test/search-api.test.ts`
- Modify: `test/repository-service.test.ts`

**Interfaces:**

- `createQueryLimit(maxConcurrent: number).run(work, signal): Promise<T>`
- `createRepositoryService`에 `maxConcurrentQueries: number`를 추가한다.
- `CODEFLEET_MAX_CONCURRENT_QUERIES` 기본값 4, 범위 1~64.
- 명시적 `repositoryIds` 최대 64개, 중복 제거 후 입력 순서 유지.

- [ ] **Step 1: FIFO 상한과 대기 취소 실패 테스트를 작성한다**

최대 2인 제한기에 작업 4개를 넣고 활성 작업 수가 2를 넘지 않으며 시작 순서가 FIFO인지
검사한다. 세 번째 대기 작업을 abort한 뒤 네 번째가 슬롯을 받고 취소 작업은
`SEARCH_ABORTED`로 끝나야 한다.

- [ ] **Step 2: 요청 선택과 오류 응답 실패 테스트를 작성한다**

`test/search-api.test.ts`에서 중복 ID가 한 번만 검색되고, 65개 ID가 400으로 거부되며,
알 수 없는 ID가 `REPOSITORY_NOT_FOUND`를 반환하는지 검사한다. 모든 저장소가 실패하면
503 응답이 `warnings`를 유지하고 단일 실패 코드를 최상위 `error.code`로 사용하는지 검사한다.

- [ ] **Step 3: Git·Graphify 오류 변환 실패 테스트를 작성한다**

`PROCESS_TIMEOUT`, `PROCESS_OUTPUT_LIMIT`, `PROCESS_SPAWN_FAILED`,
`PROCESS_EXIT_FAILURE`, `PROCESS_ABORTED`를 Git과 Graphify 경로에 각각 주입하고 공개 코드가
설계 표와 일치하는지 확인한다. 메시지에 clone URL, path, stderr가 없는지도 검사한다.

- [ ] **Step 4: 새 테스트가 실패하는지 확인한다**

Run: `node --test test/query-limit.test.ts test/environment.test.ts test/search-api.test.ts test/repository-service.test.ts`

Expected: 제한기·설정 부재, 중복 실행, 일반 오류 코드 때문에 실패한다.

- [ ] **Step 5: 최소 FIFO 제한기를 구현한다**

활성 카운터와 resolver queue만 사용한다. 대기 중 abort listener를 제거하고, 성공·오류의
`finally`에서 정확히 한 슬롯만 반환한다. 별도 패키지는 추가하지 않는다.

- [ ] **Step 6: 오류와 선택 계약을 구현한다**

Git/Graphify 호출부에서 프로세스 코드를 공개 코드로 변환한다. HTTP `RequestError`는
status, code, message, retryable을 보관한다. 전체 실패 응답은 다음 형태를 사용한다.

```json
{
  "error": { "code": "GRAPHIFY_TIMEOUT", "message": "코드 그래프 검색 시간이 초과됨", "retryable": true },
  "warnings": [{ "repositoryId": "orders", "code": "GRAPHIFY_TIMEOUT", "message": "코드 그래프 검색 시간이 초과됨" }]
}
```

- [ ] **Step 7: Task 2 검증을 실행한다**

Run: `node --test test/query-limit.test.ts test/environment.test.ts test/search-api.test.ts test/repository-service.test.ts && npm run typecheck`

Expected: 모두 통과한다.

- [ ] **Step 8: 커밋한다**

```bash
git add src/config/environment.ts src/repositories src/server.ts test
git commit -m "fix: bound Graphify searches and preserve error contracts"
```

### Task 3: readiness, sync 설정, non-root 런타임

**Files:**

- Modify: `src/config/environment.ts`
- Modify: `src/sync.ts`
- Modify: `src/server.ts`
- Modify: `test/environment.test.ts`
- Modify: `test/server.test.ts`
- Modify: `Dockerfile`
- Modify: `README.md`

**Interfaces:**

- `loadSyncEnvironment(env)`는 data directory, repositories file, Graphify binary만 반환한다.
- `createReadinessProbe(check, ttlMs = 5_000, now = Date.now)`는 `Promise<boolean>`을 반환한다.
- Docker runtime UID/GID는 1000이다.

- [ ] **Step 1: 토큰 없는 sync 설정과 readiness TTL 실패 테스트를 작성한다**

`CODEFLEET_API_TOKEN` 없이 `loadSyncEnvironment`가 성공하는지 검사한다. readiness check가
첫 실패를 캐시하고 5초 전에는 재호출하지 않으며 5초 뒤 성공으로 회복하는지 fake clock과
check 함수로 확인한다.

- [ ] **Step 2: 새 테스트가 실패하는지 확인한다**

Run: `node --test test/environment.test.ts test/server.test.ts`

Expected: 새 함수가 없어 실패한다.

- [ ] **Step 3: 공통·서버 환경 로더와 TTL probe를 구현한다**

공통 설정 파싱은 내부 함수로 한 번만 구현한다. `sync.ts`는 `loadSyncEnvironment`, 서버는
기존 `loadEnvironment`를 사용한다. readiness probe는 동시에 들어온 재검사를 하나의
Promise로 합친다.

- [ ] **Step 4: non-root Docker와 운영 문서를 구현한다**

runtime stage 전에 `/data`를 `node:node` 소유로 만들고 최종 stage에 `USER node`를 둔다.
README에 Kubernetes UID/GID/fsGroup 1000과 PVC 소유권 요구사항을 추가한다.

- [ ] **Step 5: Task 3 검증을 실행한다**

Run: `node --test test/environment.test.ts test/server.test.ts && npm run typecheck`

Run: `docker build --progress=plain -t codefleet:graphify .`

Run: `docker run --rm codefleet:graphify sh -c 'test "$(id -u)" = 1000 && touch /data/write-test'`

Expected: 테스트, 이미지 빌드, non-root PVC 쓰기가 모두 성공한다.

- [ ] **Step 6: 커밋한다**

```bash
git add src/config/environment.ts src/sync.ts src/server.ts test/environment.test.ts test/server.test.ts Dockerfile README.md
git commit -m "fix: harden Graphify API runtime readiness"
```

### Task 4: 실제 Graphify 회귀 검증과 문서 동기화

**Files:**

- Modify: `test/graphify-integration.test.ts`
- Modify: `docs/specs/2026-09-21-graphify-api-design.md`
- Modify: `docs/plans/2026-09-21-graphify-api-implementation.md`
- Modify: `graphify-out/GRAPH_REPORT.md`
- Modify: `graphify-out/graph.html`
- Modify: `graphify-out/graph.json`
- Modify: `graphify-out/manifest.json`

- [ ] **Step 1: 실제 Graphify 양성 assertion을 먼저 추가한다**

최초 검색 결과에서 orders 출력에 `RedisConfig`, catalog 출력에 `CacheRepository`가 실제로
포함되는지 검사한다. 재색인 뒤 orders 출력에 `RedisConfig`가 없고 새 indexed commit이
반환되는지 검사한다.

- [ ] **Step 2: assertion이 현재 Graphify 결과에서 유효한지 실행한다**

Run: `GRAPHIFY_BIN=/home/wrallee/.local/bin/graphify node --test test/graphify-integration.test.ts`

Expected: 양성·삭제 assertion이 모두 통과한다. 실패하면 Graphify 실제 출력에 맞춰 검색어와
assertion을 조정하되 단순 `false` 검사만 남기지 않는다.

- [ ] **Step 3: 기존 설계와 계획을 실제 구현 계약에 맞춘다**

원자 교체·프로세스 로컬 잠금 설명을 immutable generation·sync fencing으로 교체하고,
오류 코드, 검색 상한, readiness TTL, non-root 운영 요구사항을 반영한다.

- [ ] **Step 4: 전체 검증을 실행한다**

Run: `GRAPHIFY_BIN=/home/wrallee/.local/bin/graphify npm run check`

Expected: 실패와 skip 없이 통과한다.

Run: `docker build --progress=plain -t codefleet:graphify .`

Expected: Docker verify stage의 실제 Graphify 통합 테스트와 라이선스 검사가 통과한다.

- [ ] **Step 5: Graphify 프로젝트 그래프를 갱신한다**

Run: `graphify update .`

Expected: 변경된 소스와 테스트가 `graphify-out`에 반영된다.

- [ ] **Step 6: 최종 범위와 diff를 확인한다**

Run: `git diff --check && git status --short && rg -n -i 'mcp|zoekt' src config Dockerfile package.json`

Expected: whitespace 오류가 없고, MCP·Zoekt 런타임 코드가 없다.

- [ ] **Step 7: 구현과 생성물을 분리해 커밋한다**

```bash
git add test/graphify-integration.test.ts docs/specs/2026-09-21-graphify-api-design.md docs/plans/2026-09-21-graphify-api-implementation.md
git commit -m "test: verify crash-safe Graphify generations"
git add graphify-out/GRAPH_REPORT.md graphify-out/graph.html graphify-out/graph.json graphify-out/manifest.json
git commit -m "chore: refresh Graphify index"
```
