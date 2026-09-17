# 실행 기반과 레지스트리 구현 계획

> **에이전트 작업 지침:** 이 계획은 `superpowers:executing-plans`를 사용해 작업별로 구현한다. 각 동작은 실패 테스트를 먼저 확인한 뒤 최소 구현으로 통과시킨다.

**목표:** CodeFleet이 SQLite 레지스트리를 초기화하고 상태 확인 HTTP 엔드포인트를 제공하는 최소 실행 기반을 만든다.

**구조:** Node.js 24의 내장 HTTP 서버와 `node:sqlite`를 사용한다. `src/server.ts`는 프로세스 시작과 조립만 담당하고, 환경 설정과 레지스트리 초기화는 각각 독립된 모듈에 둔다.

**기술:** Node.js 24, TypeScript, `node:test`, `node:sqlite`

**명세:** `docs/specs/2026-09-17-codefleet-design.md`

## 공통 제약

- 문서는 한국어로 작성한다.
- 런타임 의존성을 추가하지 않는다.
- 데이터 디렉터리 기본값은 `/data`, HTTP 포트 기본값은 `3000`이다.
- SQLite는 WAL 모드와 `user_version` 기반 순방향 마이그레이션을 사용한다.
- 상태 확인 엔드포인트에는 인증을 요구하지 않는다.

---

### 작업 1: TypeScript 실행 및 검증 환경

**파일:**

- 수정: `package.json`
- 수정: `tsconfig.json`
- 생성: `package-lock.json`

**제공 명령:**

- `npm start`: `src/server.ts` 실행
- `npm test`: Node 내장 테스트 실행
- `npm run typecheck`: TypeScript 정적 검사
- `npm run check`: 정적 검사와 테스트 실행

- [x] `typescript`와 `@types/node`만 개발 의존성으로 설치한다.
- [x] Node.js 24가 직접 TypeScript를 실행하도록 `erasableSyntaxOnly`, `allowImportingTsExtensions`, `noEmit`을 설정한다.
- [x] `npm run check`가 빈 테스트 상태에서도 실행되는지 확인한다.

### 작업 2: SQLite 레지스트리 초기화

**파일:**

- 생성: `test/registry.test.ts`
- 구현: `src/registry/database.ts`

**인터페이스:**

- 제공: `openRegistry(dataDirectory: string): Registry`
- `Registry`는 `database`, `dataDirectory`, `repositoriesDirectory`, `trashDirectory`, `isReady()`, `close()`를 제공한다.

- [x] 임시 디렉터리에서 레지스트리를 열면 데이터베이스와 `repositories`, `.trash`가 생성되고 `user_version=1`, `journal_mode=wal`이 되는 실패 테스트를 작성한다.
- [x] 테스트가 빈 구현 때문에 실패하는지 확인한다.
- [x] `openRegistry`에 디렉터리 생성, WAL 설정, 최초 마이그레이션을 구현한다. 최초 스키마는 명세의 저장소 필드를 가진 `repositories` 테이블 하나만 만든다.
- [x] 레지스트리를 닫은 뒤 `isReady()`가 `false`를 반환하는 테스트와 구현을 추가한다.
- [x] 레지스트리 테스트와 정적 검사를 통과시킨다.

### 작업 3: 설정과 상태 확인 서버

**파일:**

- 생성: `src/config/environment.ts`
- 생성: `test/server.test.ts`
- 구현: `src/server.ts`

**인터페이스:**

- 제공: `loadEnvironment(env): { dataDirectory: string; port: number }`
- 제공: `createServer(registry): http.Server`
- 제공: `start(): { server: http.Server; registry: Registry }`

- [x] `GET /healthz`가 `200`과 `{"status":"ok"}`를 반환하는 실패 테스트를 작성하고 실패를 확인한다.
- [x] `GET /readyz`가 열린 레지스트리에는 `200`, 닫힌 레지스트리에는 `503`을 반환하는 실패 테스트를 작성하고 실패를 확인한다.
- [x] 그 외 경로가 `404`를 반환하는 실패 테스트를 작성하고 실패를 확인한다.
- [x] Node 내장 HTTP 서버에 세 경로만 구현하고 테스트를 통과시킨다.
- [x] 잘못된 `PORT`를 거부하고 기본 설정을 반환하는 환경 설정 테스트와 최소 구현을 추가한다.
- [x] 직접 실행할 때만 서버를 시작하고 종료 신호에서 HTTP 서버와 레지스트리를 닫는다.

### 작업 4: 컨테이너와 사용 문서

**파일:**

- 생성: `Dockerfile`
- 생성: `.dockerignore`
- 수정: `README.md`
- 수정: `docs/specs/2026-09-17-codefleet-design.md`

- [x] 빌드 단계에서 `npm run check`를 실행하고 실행 단계에서는 Node.js 24로 `src/server.ts`를 시작하는 다단계 Dockerfile을 작성한다.
- [x] README에 현재 구현 범위, 로컬 실행, 환경 변수, 상태 확인 경로를 기록한다.
- [x] 설계 명세의 프로젝트 구조에 `config/environment.ts`와 이 단계의 테스트 파일을 반영한다.
- [x] `npm run check`와 `docker build`를 실행해 최종 결과를 검증한다.
