# Graphify API 운영 안전성 보강 설계

## 목표

Graphify API의 정상 경로는 유지하면서 별도 API·sync 프로세스, 설정 변경, 프로세스
중단, 관리 경로 변조에서도 기존 정상 색인과 실제 색인 provenance를 잃지 않게 한다.
MCP, 관리 화면, Zoekt 런타임 구현은 범위에 포함하지 않는다.

## 불변 generation과 활성 포인터

색인은 다음처럼 고유한 generation 디렉터리에 저장한다.

```text
/data/
  codefleet.db
  .staging/<repository-id>-<random>/
  repositories/<repository-id>/generations/<generation-id>/
```

Git clone과 Graphify extract는 `.staging`에서 끝낸다. 검증된 staging을 새 generation으로
한 번 rename한 뒤 SQLite의 `active_generation`, `indexed_commit`, `indexed_branch`,
`indexed_clone_url`, `indexed_at`을 한 트랜잭션에서 갱신한다. 검색은 한 번 읽은 활성
generation 경로와 같은 행의 provenance만 사용한다.

generation은 게시 후 수정하거나 즉시 삭제하지 않는다. 따라서 API 서버와 별도 sync
프로세스가 잠금을 공유하지 않아도 진행 중인 검색 경로가 사라지지 않는다. 프로세스가
rename 전 종료되면 staging만 남고, rename 후 DB 갱신 전에 종료되면 참조되지 않는
generation만 남는다. 두 경우 모두 기존 활성 포인터는 유효하다.

첫 버전은 이전 generation과 고아 staging을 자동 삭제하지 않는다.
`ponytail:` 주석으로 PVC 사용량이 실제 문제가 될 때 별도의 보존 기간 기반 정리를
추가한다고 기록한다. 데이터 안전성에 영향을 주는 정리 로직을 동기화 경로에 넣지 않는다.

기존 v1 레이아웃 `repositories/<id>/graphify-out/graph.json`은
`active_generation IS NULL`인 legacy 활성 색인으로 읽는다. 다음 동기화부터 generation
레이아웃으로 전환하며 legacy 디렉터리는 삭제하지 않는다.

## 동시 sync와 상태

SQLite 행에 단조 증가하는 `sync_generation`을 둔다. sync 시작은 한 트랜잭션에서 값을
증가시키고 토큰을 반환한다. 성공·실패 기록은 해당 토큰이 현재 값과 같은 경우에만
반영한다. 따라서 여러 sync 프로세스가 겹쳐도 나중에 시작한 작업보다 오래된 결과가
활성 포인터를 덮어쓰지 못한다. 크래시로 영구 잠금이 남지 않는다.

기존 활성 색인이 있으면 sync 중에도 `state=ready`를 유지한다. 활성 색인이 없는 최초
동기화만 `syncing`으로 표시한다. refresh 실패 시 기존 활성 색인과 provenance를 유지하고
`lastError`만 안정적인 오류 코드로 갱신한다.

설정의 clone URL·branch와 색인의 clone URL·branch를 별도 열로 저장한다. `reconcile`은
설정 값만 바꾸며 색인 provenance를 고치지 않는다. `/repositories`의 `branch`는 활성
색인이 있으면 `indexed_branch`, 없으면 설정 branch를 반환한다.

## 관리 경로

data root는 시작 시 실제 경로로 정규화한다. `repositories`, `.staging`, `.trash`, 저장소
root, `generations`는 `lstat`으로 실제 디렉터리인지 확인하고 symlink를 거부한다. 생성된
경로는 `realpath` 기준으로 data root 내부인지 확인한 뒤 rename한다. HTTP 입력은 어떤
파일 시스템 경로도 지정할 수 없다. clone이 제공한 `graphify-out`은 색인 전에 제거하고,
게시 직전까지 내부의 일반 `graph.json`과 필수 배열을 재검증한다.

## 검색 부하와 오류 계약

명시적인 `repositoryIds`는 중복을 제거하고 최대 64개만 허용한다. ID를 생략한 전체
검색은 모든 준비된 저장소를 대상으로 하되 Graphify 자식 프로세스는 서비스 인스턴스
전체에서 FIFO semaphore로 제한한다. `CODEFLEET_MAX_CONCURRENT_QUERIES` 기본값은 4,
허용 범위는 1~64다. 대기 중 요청 취소도 슬롯을 소비하지 않고 종료한다.

Git과 Graphify 호출부에서 프로세스 오류를 다음 공개 코드로 변환한다.

- `GIT_TIMEOUT`, `GIT_OUTPUT_LIMIT`, `GIT_UNAVAILABLE`, `GIT_FAILED`
- `GRAPHIFY_TIMEOUT`, `GRAPHIFY_OUTPUT_LIMIT`, `GRAPHIFY_UNAVAILABLE`, `GRAPHIFY_FAILED`
- `SEARCH_ABORTED`, `REPOSITORY_NOT_READY`, `REPOSITORY_NOT_FOUND`

일부 저장소 실패는 성공 결과와 `warnings`를 함께 반환한다. 모든 저장소가 실패하면
단일 실패는 해당 코드, 복수의 서로 다른 실패는 `SEARCH_UNAVAILABLE`을 반환하되
`warnings`를 버리지 않는다. 임의의 OS·라이브러리 오류 코드는 공개하지 않고
`REPOSITORY_SYNC_FAILED`로 정규화한다. Graphify query에는 generation을 작업 디렉터리로
두고 상대 graph 경로를 전달한다. stderr, 토큰, clone URL, 내부 경로는 응답에 포함하지 않는다.

## 준비 상태와 실행 환경

`/readyz`는 Graphify 실행 가능 여부를 5초 TTL로 다시 확인한다. 일시적인 시작 실패와
실행 중 바이너리 손실이 TTL 이후 반영된다. sync 설정 로더는 API 토큰과 PORT를 요구하지
않고 data root, repository 설정 파일, Graphify 바이너리만 읽는다.

런타임 컨테이너는 Node 이미지의 `node` 사용자로 실행한다. 이미지의 `/data`는 UID/GID
1000이 쓸 수 있게 만들고, Kubernetes PVC는 `runAsUser: 1000`, `runAsGroup: 1000`,
`fsGroup: 1000` 또는 동등한 소유권 설정이 필요하다고 문서화한다.

## 검증

- 독립 Registry·RepositoryService 인스턴스로 검색 중 별도 sync를 실행하고 기존 검색이
  같은 generation과 commit을 끝까지 반환하는지 확인한다.
- 설정 branch 변경 직후 기존 색인의 indexed branch와 commit이 유지되는지 확인한다.
- rename 뒤 DB 게시 실패와 오래된 sync 토큰 완료가 활성 포인터를 바꾸지 않는지 확인한다.
- symlink 관리 디렉터리와 clone의 `graphify-out`을 거부하거나 교체하고 외부 디렉터리를 변경하지 않는지 확인한다.
- 손상되거나 일반 파일이 아닌 `graph.json`을 게시하지 않고 검색 결과에 내부 경로를 노출하지 않는지 확인한다.
- 중복 ID, 65개 ID, FIFO 동시 실행 상한, 대기 중 취소를 확인한다.
- Git·Graphify·timeout·output-limit·unknown repository 오류 코드와 전체 실패 warnings를
  확인한다.
- 실제 Graphify 통합 테스트에서 최초 결과에 `RedisConfig`가 있고 재색인 뒤 사라지는지
  확인한다.
- readiness TTL 회복, 토큰 없는 sync 설정, non-root 컨테이너와 PVC 쓰기를 확인한다.
