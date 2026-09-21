# Graphify 기반 CodeFleet API 설계

- 상태: 검토 대기
- 작성일: 2026-09-21
- 대체 문서: `docs/specs/2026-09-17-codefleet-design.md`

## 목적

CodeFleet은 설정 파일에 등록된 여러 Git 저장소를 Graphify로 색인하고,
HTTP API를 통해 구조적으로 연관된 코드 근거를 반환한다. 첫 버전은 코드만
분석하며 LLM, MCP, Zoekt, 관리 화면을 사용하지 않는다.

완료 기준은 다음과 같다.

- 여러 저장소를 하나의 서버에서 검색할 수 있다.
- 결과마다 저장소와 색인 커밋을 확인할 수 있다.
- 색인 실패가 기존 정상 색인을 훼손하지 않는다.
- 관리 기능 없이 설정 파일과 명령으로 운영할 수 있다.

## 제외 범위

- MCP 서버와 MCP 도구
- 저장소 등록·수정·삭제용 API와 관리 화면
- 예약 동기화와 웹훅
- Zoekt 문자열·정규식 검색
- 자연어 의미 확장과 LLM 호출
- Graphify의 시각화 HTML, 문서·PDF·이미지 분석
- 여러 서버 인스턴스의 작업 조정

Zoekt는 `docs/prepare/2026-09-21-zoekt-integration.md`에 별도 보류한다.

## 구성

```text
Client
  |
  | HTTP JSON
  v
CodeFleet (Node.js 24 / TypeScript)
  |- repositories.json 로드
  |- SQLite에 색인 상태 기록
  |- Git 저장소 동기화
  |- Graphify CLI 실행
  `- 저장소별 결과 병합
       |
       v
  /data/repositories/<id>/graphify-out/graph.json
```

Graphify는 별도 SDK로 감싸지 않는다. CodeFleet은 인수 배열과 `shell: false`로
고정 버전의 Graphify CLI를 실행한다. 첫 버전은 Graphify의 검색 결과를 다시
구현하거나 `graph.json` 내부 형식에 직접 의존하지 않는다.

## 저장소 설정

저장소 목록은 프로젝트의 `config/repositories.json`을 기준으로 한다.

```json
{
  "repositories": [
    {
      "id": "orders",
      "cloneUrl": "git@github.com:example/orders.git"
    },
    {
      "id": "catalog",
      "cloneUrl": "git@github.com:example/catalog.git",
      "branch": "release"
    }
  ]
}
```

`id`는 영문 소문자, 숫자, 하이픈만 허용하고 `/data/repositories` 바로 아래의
디렉터리 이름으로 사용한다. 중복 식별자, 상대 경로 조각, URL 사용자 정보는
거부한다. Git 인증 정보는 파일이나 SQLite에 저장하지 않고 실행 환경에서
제공한다.

`branch`는 선택값이다. 값이 있으면 해당 브랜치만 색인한다. 없으면 동기화마다
`git ls-remote --symref <cloneUrl> HEAD`로 원격 HEAD가 가리키는
`refs/heads/<branch>`를 찾아 사용한다. 감지한 이름은 Git 참조 형식으로 다시
검증하고 SQLite와 API 응답에 기록한다. HEAD가 브랜치를 가리키지 않거나 감지할 수
없으면 `main`이나 `master`를 추측하지 않고 저장소를 `degraded`로 표시하며,
운영자가 `branch`를 명시해야 한다.

SQLite는 설정 원본이 아니다. 설정에 있는 저장소의 현재 상태, 체크아웃 커밋,
색인 커밋, 색인 시각, 마지막 오류만 기록한다. 관리 API용 필드는 추가하지 않는다.

## 영구 볼륨 배치

`CODEFLEET_DATA_DIR` 하나를 PVC의 마운트 지점으로 사용한다. SQLite, 활성 체크아웃,
Graphify 색인, staging, trash는 모두 그 아래에 둔다.

```text
/data/                         # 단일 PVC
  codefleet.db
  repositories/
    <repository-id>/
      .git/
      graphify-out/graph.json
      ...source files...
  .staging/
  .trash/
```

`.staging`, `repositories`, `.trash`가 같은 PVC에 있어야 `rename` 기반 교체가
같은 파일 시스템 안에서 원자적으로 동작한다. 설정 파일과 API 토큰은 이미지,
ConfigMap 또는 Secret으로 제공하며 PVC에 저장하지 않는다.

## 색인 동기화

운영자는 `npm run sync`로 설정된 저장소 전체를 동기화한다. 서버 시작 시에는
색인을 자동으로 갱신하지 않는다. 활성 색인이 없는 저장소만 준비되지 않은 상태로
표시한다.

저장소별 동기화 순서는 다음과 같다.

1. 설정 브랜치를 검증하거나 원격 HEAD에서 기본 브랜치를 감지한다.
2. 임시 디렉터리에 대상 브랜치를 깊이 1로 복제한다.
3. 체크아웃 커밋을 읽는다.
4. `graphify extract <path> --code-only --no-viz`를 실행한다.
5. `graphify-out/graph.json`이 존재하고 읽을 수 있는지 확인한다.
6. 새 체크아웃을 활성 디렉터리와 원자적으로 교체한다.
7. 교체가 끝난 뒤 SQLite의 색인 커밋과 시각을 갱신한다.
8. 이전 디렉터리를 정리한다.

복제나 색인이 실패하면 임시 디렉터리만 정리하고 기존 활성 색인을 유지한다.
같은 저장소의 동기화와 검색이 겹칠 때 검색은 교체 전 또는 교체 후의 완전한
디렉터리만 사용한다. 첫 버전은 호스트 자원을 보호하기 위해 저장소 색인을 한 번에
하나만 실행한다.

`--code-only`는 문서와 미디어의 LLM 분석을 제외한다. `--no-viz`는 서버에서 쓰지
않는 `graph.html` 생성을 생략한다. 검색에 필요한 `graph.json`은 유지한다.

## HTTP API

상태 확인을 제외한 API는 `CODEFLEET_API_TOKEN` Bearer 토큰을 요구한다.
토큰과 Git 인증 정보, 검색어 전문은 로그에 남기지 않는다.

### `GET /healthz`

프로세스가 요청을 받을 수 있으면 `200`을 반환한다.

### `GET /readyz`

설정 파일, SQLite, 데이터 디렉터리, Graphify 실행 파일을 사용할 수 있으면
`200`을 반환한다. 개별 저장소의 색인 실패는 전체 서버를 준비되지 않은 상태로
만들지 않는다.

### `GET /repositories`

설정된 저장소별 상태를 반환한다.

```json
{
  "repositories": [
    {
      "id": "orders",
      "branch": "release",
      "state": "ready",
      "indexedCommit": "abc123",
      "indexedAt": "2026-09-21T00:00:00.000Z",
      "lastError": null
    }
  ]
}
```

### `POST /search`

입력:

```json
{
  "query": "redis related sources",
  "repositoryIds": ["orders", "catalog"]
}
```

`query`는 필수다. `repositoryIds`가 없으면 준비된 모든 저장소를 검색한다.
호출자는 파일 시스템 경로나 Graphify 인수를 전달할 수 없다. 질의 길이, 실행 시간,
자식 프로세스 출력 크기에 상한을 둔다.

CodeFleet은 선택된 각 저장소에서 Graphify의 `query` 명령을 실행한다. 첫 버전은
Graphify 출력 문자열을 파싱하지 않고 저장소 메타데이터와 함께 JSON으로 감싼다.

```json
{
  "query": "redis related sources",
  "results": [
    {
      "repositoryId": "orders",
      "indexedCommit": "abc123",
      "indexedAt": "2026-09-21T00:00:00.000Z",
      "output": "Graphify query output"
    }
  ],
  "warnings": []
}
```

한 저장소의 검색 실패가 다른 저장소 결과를 버리지 않는다. 실패한 저장소는
`warnings`에 안정적인 오류 코드와 함께 기록한다. 모든 대상이 실패한 경우에만
요청을 실패로 처리한다.

## 프로세스 경계

Git과 Graphify는 `spawn` 또는 `execFile`에 인수 배열로 전달한다. 셸 문자열을
실행하지 않는다. 실행 파일과 하위 명령은 코드에서 고정하고, 검색어는 한 개의
인수로 전달한다. HTTP 요청은 저장소 경로, 실행 파일, 환경 변수, 추가 명령 옵션을
지정할 수 없다.

저장소 식별자는 설정에 등록된 값만 허용한다. 브랜치는 Git 참조 형식으로 검증하고,
복제 URL은 허용한 스킴과 호스트만 받는다. Git이 지원하는 위치에는 `--` 옵션 종료
구분자를 사용해 `-`로 시작하는 값을 옵션으로 해석하지 못하게 한다. `sh -c`,
`shell: true`, 문자열 명령 조합, `eval`은 사용하지 않는다.

자식 프로세스에는 필요한 환경 변수만 전달하고 `CODEFLEET_API_TOKEN`은 넘기지
않는다. 각 프로세스에는 제한 시간과 stdout·stderr 각각의 출력 상한을 적용한다.
두 출력 스트림은 프로세스 시작 직후 동시에 소비해 파이프 버퍼가 차서 멈추지 않게
한다. 제한 시간이나 출력 상한을 넘으면 정상 종료를 요청하고, 짧은 유예 시간 뒤에도
남아 있으면 강제 종료한다. `error`, `exit`, `close`, 요청 취소의 모든 경로는 하나의
정리 절차로 합쳐 정확히 한 번만 완료한다.

원본 stderr는 서버 로그에만 제한적으로 남기며 API에는 토큰, 경로, Git 인증 정보가
섞인 원문을 반환하지 않는다.

Graphify 버전은 이미지와 검증 환경에서 동일하게 고정한다. 배포물에는 Apache-2.0
라이선스와 Graphify NOTICE를 보존한다.

## 동시성과 데드락 방지

색인 생성은 잠금 없이 임시 디렉터리에서 수행한다. 저장소별 쓰기 잠금은 완성된
색인을 활성 디렉터리와 교체하고 SQLite 상태를 갱신하는 짧은 구간에만 사용한다.
Git 복제, Graphify 실행, 외부 프로세스 종료 대기는 쓰기 잠금을 잡은 상태에서 하지
않는다.

검색은 자식 프로세스가 끝날 때까지 해당 저장소의 읽기 사용권을 유지한다. 교체는
기존 읽기 사용권이 모두 반환된 뒤 수행하며, 교체 이전 디렉터리는 사용 중인 검색이
없을 때만 정리한다. 사용권은 성공, 오류, 제한 시간, 요청 취소를 포함한 모든 경로의
`finally`에서 반환한다.

한 작업은 한 번에 하나의 저장소 잠금만 획득한다. 다중 저장소 검색은 모든 잠금을
먼저 잡지 않고 저장소별 작업을 독립적으로 실행해 순환 대기를 만들지 않는다. 전체
색인 동시 실행 수는 잠금이 아닌 단일 작업 대기열로 제한한다.

## 오류 계약

오류 응답은 다음 필드를 사용한다.

```json
{
  "error": {
    "code": "GRAPHIFY_TIMEOUT",
    "message": "코드 그래프 검색 시간이 초과됨",
    "retryable": true
  }
}
```

첫 버전의 안정적인 오류 코드는 설정 오류, 인증 실패, 알 수 없는 저장소, 준비되지
않은 색인, Git 실패, Graphify 실패, 제한 시간 초과, 출력 초과를 구분한다.

## 검증

- 설정 파서가 정상 설정과 잘못된 식별자·중복·URL을 구분하는지 확인한다.
- 가짜 자식 프로세스로 인수 배열, 제한 시간, 출력 상한, 오류 변환을 확인한다.
- 검색어에 세미콜론, 백틱, 명령 치환 문자열이 있어도 하나의 인수로 전달되고 다른
  명령이나 파일 생성이 발생하지 않는지 확인한다.
- `-`로 시작하는 저장소 식별자·브랜치와 허용하지 않은 URL을 실행 전에 거부하는지
  확인한다.
- stdout과 stderr를 파이프 용량보다 많이 동시에 출력하는 자식 프로세스가 멈추지
  않고 출력 상한 또는 정상 완료로 끝나는지 확인한다.
- 검색 중 색인 교체, 자식 프로세스 오류, 제한 시간, 요청 취소 뒤에도 사용권이
  반환되고 다음 검색과 동기화가 제한 시간 안에 끝나는지 확인한다.
- 임시 Git 저장소 두 개를 실제 Graphify로 색인하고 한 요청에서 양쪽 결과가
  저장소 및 커밋과 함께 반환되는지 확인한다.
- 새 색인 실패 시 이전 색인이 계속 검색되는지 확인한다.
- 저장소 하나의 검색 실패가 다른 결과를 제거하지 않는지 확인한다.
- 타입 검사, 전체 테스트, Docker 이미지 빌드와 컨테이너 상태 확인을 실행한다.

## 예상 프로젝트 구조

```text
config/
  repositories.json
src/
  server.ts
  config/
    environment.ts
    repositories.ts
  graphify/
    client.ts
  registry/
    database.ts
  repositories/
    service.ts
test/
docs/
  prepare/
  specs/
```

MCP, 관리 화면, 범용 검색 공급자 인터페이스는 만들지 않는다. Graphify 외의 두 번째
구현이 실제로 추가될 때만 공통 인터페이스를 검토한다.
