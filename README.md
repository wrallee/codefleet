# CodeFleet

CodeFleet는 여러 Git 저장소를 Graphify로 색인하고 구조 기반 검색 결과를 HTTP JSON으로
반환한다. 현재 MCP 서버와 관리 화면은 제공하지 않는다.

## Repository configuration

`config/repositories.json`에 GitHub HTTPS 또는 SSH clone URL을 등록한다. `branch`를
생략하면 동기화 때 원격 HEAD를 감지하며, 감지에 실패해도 `main`이나 `master`를
추측하지 않는다.

```json
{
  "repositories": [
    {
      "id": "orders",
      "cloneUrl": "git@github.com:example/orders.git",
      "branch": "main"
    }
  ]
}
```

`CODEFLEET_DATA_DIR` 하나를 PVC 마운트 지점으로 사용한다. SQLite, 활성 checkout,
Graphify graph, staging, trash가 모두 그 아래에 저장된다.

## Run

Node.js 24 이상과 Graphify CLI가 필요하다.

```bash
npm ci
export CODEFLEET_API_TOKEN=replace-with-a-secret
export CODEFLEET_DATA_DIR=./data
export GRAPHIFY_BIN=graphify
npm run sync
npm start
```

환경 변수 기본값은 `CODEFLEET_DATA_DIR=/data`, `GRAPHIFY_BIN=graphify`, `PORT=3000`,
`CODEFLEET_MAX_CONCURRENT_QUERIES=4`이다. 동시 검색 상한은 1~64로 지정할 수 있다.
`CODEFLEET_API_TOKEN`은 필수다.

컨테이너는 UID/GID 1000(`node`)으로 실행된다. Kubernetes PVC는 `runAsUser: 1000`,
`runAsGroup: 1000`, `fsGroup: 1000` 또는 동등한 소유권으로 `/data` 쓰기를 허용해야 한다.

## API

`GET /healthz`는 프로세스 상태, `GET /readyz`는 SQLite·데이터 디렉터리·Graphify CLI
준비 상태를 반환한다. 그 외 엔드포인트에는 Bearer 토큰이 필요하다.

```bash
curl -H "Authorization: Bearer $CODEFLEET_API_TOKEN" http://localhost:3000/repositories

curl -X POST http://localhost:3000/search \
  -H "Authorization: Bearer $CODEFLEET_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"query":"redis related sources","repositoryIds":["orders"]}'
```

## Verification

```bash
npm run check
docker build -t codefleet:graphify .
docker run --rm codefleet:graphify /opt/graphify/bin/graphify --version
```
