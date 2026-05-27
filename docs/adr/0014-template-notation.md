# 0014. 시나리오 변수·env·시스템 변수 표기 분리

- **상태**: Accepted
- **날짜**: 2026-05-27

## Context

시나리오 YAML 안에서 동적 값을 표기해야 한다: (a) 이전 스텝에서 추출한 흐름 변수, (b) 환경별 env (BASE_URL 등), (c) 시스템이 주입하는 변수 (`vu_id`, `iter_id`). 한 표기로 통일할지, 출처별 표기를 분리할지 결정 필요.

## Decision Drivers

- 코드 리뷰 시 값의 출처가 즉시 드러나는가
- YAML/JSON 파서와 충돌 없는가 (예: `${...}`는 일부 YAML processor와 충돌)
- 표준 (mustache, jinja 등) 친숙도
- 후속 단계 표현식 확장 여지

## Considered Options

1. **출처별 분리** — `{{var}}` 흐름 변수, `${ENV}` env var, `${vu_id}` 시스템
2. **모두 `${...}` 통일** — k6/Locust 스타일
3. **mustache `{{}}` 통일**
4. **JavaScript 표현식 평가** — 강력하지만 GUI 표현 불가

## Decision

**옵션 1: 출처별 분리.** 표기가 곧 출처를 알려준다.

## Consequences

**Positive**
- `{{token}}`은 흐름 변수, `${USERNAME}`은 환경 — 한눈에 식별
- 잘못된 사용(env에서 흐름 변수 참조 등)이 정적 검사로 검출 가능
- mustache `{{}}`와 shell-like `${}`는 둘 다 익숙

**Negative / Trade-offs**
- 사용자가 두 표기를 학습해야 함 (작은 비용)
- 후속에 표현식(예: `${math: x+1}`) 추가 시 시스템 변수 표기(`${vu_id}`)와 충돌 가능 — 시스템 변수를 `sys.vu_id` 같은 prefix로 옮기는 마이그레이션 경로 미리 열어둠
- 두 표기 모두 strict parser 필요 (이스케이프 규칙 명세화)
