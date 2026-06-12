# 0036 — 스텝 템플릿: 독립 top-level 리소스 + 복사-삽입 스냅샷

- Status: accepted
- Date: 2026-06-12

## Context

공통 플로우(로그인 = POST /login → GET /me 등)를 시나리오마다 손으로 재작성하는
통증. 원 아이디어는 "여러 시나리오를 순서대로 조합해 긴 시나리오처럼 run"(참조 기반
조합)이었으나, 참조 추종·변수/쿠키 핸드오프·run 시점 합성·step id 충돌 등 설계
부담이 커서 스텝 템플릿화로 단순화하기로 사용자가 결정.

## Decision

- **전용 top-level 리소스** `step_templates`(migration 0015, UNIQUE name) + CRUD
  REST(`/api/step-templates`) — environments(ADR-0025) 패턴 미러. 팀 공유.
- **복사-삽입 스냅샷**: 템플릿 = 최상위 스텝 시퀀스(Step[] — http/loop/if/parallel
  서브트리 포함)의 YAML 텍스트. 삽입 시 클라이언트가 모든 스텝 id를 새 ULID로
  재발급(노드-레벨 구조-인지 walk, 주석 보존). 원본 추종 없음.
- **검증 분담**: 서버는 엔진 serde `Vec<Step>` 파싱 + 비어있지 않음만(422; 스텝 id
  ULID 유효성 불검증 — 재발급으로 무관). 엄격 검증(UI 중첩 규칙)은 삽입 시
  UI Zod 게이트(재발급 *뒤*). 기존 lenient-engine / strict-UI 스탠스.
- **이름 충돌**: 409 `ConflictJson {error, id}` — UI가 그 id로 덮어쓰기 PUT.
- **DELETE 무가드**: 복사 시맨틱이라 참조가 없음(environments와 동일 논리).
- **엔진·워커·proto 무변경.**

## Consequences

- 참조 기반 시나리오 조합(원본 수정 전파)은 별도 미래 슬라이스 — 이 결정이 막지
  않음(템플릿은 그때도 유효한 보완 기능).
- 변수 파라미터화 없음(v1): `{{var}}`/`${ENV}` 토큰은 as-is 복사, 삽입 후 검증
  배너·치트시트가 안내.
- 관리 표면은 삽입 모달 내 최소(삭제)로 시작 — 라이브러리가 커지면 `/templates`
  페이지(EnvironmentsPage 미러)로 확장(roadmap §B 기록).
