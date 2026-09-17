# codefleet

AI 에이전트를 위한 멀티 저장소 코드 탐색 서비스

## 상태

SQLite 레지스트리와 상태 확인 서버까지 구현했다. 저장소 관리와 CodeGraph,
MCP 연동은 다음 단계에서 추가한다. 전체 범위는
[설계 명세](docs/specs/2026-09-17-codefleet-design.md)를 참고한다.

## 로컬 실행

Node.js 24 이상이 필요하다.

```bash
npm ci
CODEFLEET_DATA_DIR=./data PORT=3000 npm start
```

- `GET /healthz`: 프로세스 생존 상태
- `GET /readyz`: SQLite와 데이터 디렉터리 준비 상태

`CODEFLEET_DATA_DIR`의 기본값은 `/data`, `PORT`의 기본값은 `3000`이다.

## 검증

```bash
npm run check
docker build -t codefleet .
```
