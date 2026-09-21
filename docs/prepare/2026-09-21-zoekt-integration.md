# Zoekt 연동 준비

- 상태: 미착수
- 작성일: 2026-09-21
- 선행 조건: Graphify 기반 다중 저장소 API 운영 검증

## 목적

Graphify 구조 검색으로 찾기 어려운 원문 문자열, 부분 문자열, 정규식과 파일·라인
근거를 Zoekt로 보완한다. 이 문서는 현재 작업 계획이 아니라 후속 개발 경계를
기록한다.

## 예정 범위

- `zoekt-webserver -rpc`의 JSON HTTP API 연동
- 저장소와 색인 커밋을 기준으로 Graphify·Zoekt 결과 연결
- Zoekt 파일·라인 결과를 Graphify 노드의 탐색 시작점으로 사용
- `LEXICAL`, `STRUCTURAL` 근거 구분
- `repo + commit + path + symbol` 기준 중복 제거

## 착수 조건

- Graphify API의 동기화, 실패 복구, 다중 저장소 검색이 운영에서 안정적일 것
- 실제 검색 기록에서 원문 검색 부족 사례가 확인될 것
- Zoekt 프로세스와 색인의 추가 자원 비용을 수용할 수 있을 것

착수 전에는 Zoekt 의존성, 실행 파일, 설정, 빈 어댑터를 프로젝트에 추가하지 않는다.
