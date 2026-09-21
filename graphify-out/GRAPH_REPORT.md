# Graph Report - graphify-api  (2026-09-22)

## Corpus Check
- 34 files · ~13,089 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 7 file(s) not represented in the graph (top: (none) 7)

## Summary
- 200 nodes · 339 edges · 16 communities (12 shown, 4 thin omitted)
- Extraction: 97% EXTRACTED · 3% INFERRED · 0% AMBIGUOUS · INFERRED: 9 edges (avg confidence: 0.92)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `2049d044`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- package.json
- compilerOptions
- database.ts
- 공통 제약
- CodeFleet 설계 명세
- graphify-integration.test.ts
- Graphify 기반 CodeFleet API 설계
- 검토 중점
- Zoekt 연동 준비
- service.ts
- AGENTS.md
- process-child.mjs
- server.ts
- CodeFleet
- CacheRepository
- Third-party notices

## God Nodes (most connected - your core abstractions)
1. `CodeFleet 설계 명세` - 18 edges
2. `createRepositoryService()` - 15 edges
3. `openRegistry()` - 13 edges
4. `Graphify 기반 CodeFleet API 설계` - 13 edges
5. `createServer()` - 11 edges
6. `compilerOptions` - 11 edges
7. `runCommand()` - 10 edges
8. `createGraphifyClient()` - 8 edges
9. `start()` - 8 edges
10. `loadRepositories()` - 7 edges

## Surprising Connections (you probably didn't know these)
- `작업 2: SQLite 레지스트리 초기화` --references--> `openRegistry()`  [INFERRED]
  docs/plans/2026-09-17-runtime-registry-foundation.md → src/registry/database.ts
- `작업 2: SQLite 레지스트리 초기화` --references--> `Registry`  [INFERRED]
  docs/plans/2026-09-17-runtime-registry-foundation.md → src/registry/database.ts
- `Task 4: 인증된 다중 저장소 HTTP 검색 API` --references--> `writeJson()`  [INFERRED]
  docs/plans/2026-09-21-graphify-api-implementation.md → src/server.ts
- `Task 4: 인증된 다중 저장소 HTTP 검색 API` --references--> `authenticate()`  [INFERRED]
  docs/plans/2026-09-21-graphify-api-implementation.md → src/server.ts
- `Task 4: 인증된 다중 저장소 HTTP 검색 API` --references--> `readJsonBody()`  [INFERRED]
  docs/plans/2026-09-21-graphify-api-implementation.md → src/server.ts

## Import Cycles
- None detected.

## Communities (16 total, 4 thin omitted)

### Community 0 - "package.json"
Cohesion: 0.11
Nodes (18): description, devDependencies, @types/node, typescript, engines, node, name, private (+10 more)

### Community 1 - "compilerOptions"
Cohesion: 0.15
Nodes (12): compilerOptions, allowImportingTsExtensions, erasableSyntaxOnly, module, moduleResolution, noEmit, skipLibCheck, strict (+4 more)

### Community 2 - "database.ts"
Cohesion: 0.12
Nodes (21): ref_node_assert, ref_node_events, ref_node_fs, ref_node_http, ref_node_os, ref_node_path, ref_node_sqlite, ref_node_test (+13 more)

### Community 3 - "공통 제약"
Cohesion: 0.25
Nodes (7): 공통 제약, 실행 기반과 레지스트리 구현 계획, 작업 1: TypeScript 실행 및 검증 환경, 작업 2: SQLite 레지스트리 초기화, 작업 3: 설정과 상태 확인 서버, 작업 4: 컨테이너와 사용 문서, Registry

### Community 4 - "CodeFleet 설계 명세"
Cohesion: 0.10
Nodes (20): `codefleet_explore`, `codefleet_repositories`, CodeFleet 설계 명세, HTTP 엔드포인트, MCP 계약, 검증, 구조, 동시성과 프로세스 안전 (+12 more)

### Community 5 - "graphify-integration.test.ts"
Cohesion: 0.14
Nodes (20): ref_node_child_process, ref_node_url, loadEnvironment(), CHILD_ENV_KEYS, childEnvironment(), createGraphifyClient(), RunCommand, CommandError (+12 more)

### Community 6 - "Graphify 기반 CodeFleet API 설계"
Cohesion: 0.11
Nodes (17): `GET /healthz`, `GET /readyz`, `GET /repositories`, Graphify 기반 CodeFleet API 설계, HTTP API, `POST /search`, 검증, 구성 (+9 more)

### Community 7 - "검토 중점"
Cohesion: 0.18
Nodes (9): Graphify 기반 CodeFleet API 구현 계획, Task 1: 정적 저장소 설정과 실행 환경, Task 2: 데드락과 셸 주입을 막는 Graphify 프로세스 경계, Task 3: 저장소 상태, 직렬 잠금, 원자적 색인 교체, Task 5: 실제 Graphify 검증과 실행 이미지, 검토 중점, 공통 제약, 최종 검증 (+1 more)

### Community 8 - "Zoekt 연동 준비"
Cohesion: 0.40
Nodes (4): Zoekt 연동 준비, 목적, 예정 범위, 착수 조건

### Community 9 - "service.ts"
Cohesion: 0.23
Nodes (11): tails, withRepositoryLock(), childEnvironment(), createRepositoryService(), defaultBranch(), ensureDirectory(), errorCode(), exists() (+3 more)

### Community 12 - "server.ts"
Cohesion: 0.24
Nodes (13): Task 4: 인증된 다중 저장소 HTTP 검색 API, ref_node_crypto, SearchOutcome, Application, authenticate(), createServer(), readJsonBody(), RepositorySearch (+5 more)

### Community 13 - "CodeFleet"
Cohesion: 0.33
Nodes (5): API, CodeFleet, Repository configuration, Run, Verification

## Knowledge Gaps
- **90 isolated node(s):** `name`, `version`, `private`, `description`, `type` (+85 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 109 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **4 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Task 4: 인증된 다중 저장소 HTTP 검색 API` connect `server.ts` to `검토 중점`?**
  _High betweenness centrality (0.054) - this node is a cross-community bridge._
- **Why does `검토 중점` connect `검토 중점` to `server.ts`?**
  _High betweenness centrality (0.051) - this node is a cross-community bridge._
- **Why does `openRegistry()` connect `graphify-integration.test.ts` to `database.ts`, `공통 제약`, `server.ts`?**
  _High betweenness centrality (0.031) - this node is a cross-community bridge._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _90 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `package.json` be split into smaller, more focused modules?**
  _Cohesion score 0.10526315789473684 - nodes in this community are weakly interconnected._
- **Should `database.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.125 - nodes in this community are weakly interconnected._
- **Should `CodeFleet 설계 명세` be split into smaller, more focused modules?**
  _Cohesion score 0.09523809523809523 - nodes in this community are weakly interconnected._