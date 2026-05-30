# ADR-0023 — Conditional 노드: 평탄 if/elif/else + 재귀 조건 트리 + lenient 평가

* Status: Accepted
* Date: 2026-05-30
* Deciders: handicap maintainers
* Tags: scenario-model, engine, ui, control-flow

## Context

Slice 7이 첫 control-flow 노드 `type: loop`(ADR-0020)을 도입했다. 다음 조각은
첫 **분기** 노드 `type: if`다 (MVP 설계 §4.5의 "conditional" 후보). loop이 깐
인프라(internally-tagged `Step` enum, 재귀 `execute_steps` + `StepFlow`, manual
serde, UI subflow 컨테이너)를 재사용·확장한다. 범위가 커서 4개 하위 슬라이스
(9a 엔진 / 9b UI authoring / 9c 상호 1레벨 중첩 / 9d 분기 메트릭 breakdown)로
나눈다.

설계 명세: `docs/superpowers/specs/2026-05-30-slice-9-conditional-node-design.md`.

## Decision Drivers

- loop과 같은 "하위 스텝을 담고 실행 규칙이 다른 컨테이너 + 재귀 entry" 패턴 재사용.
- 모두-거짓 catch-all(`else`)이 항상 한곳(맨 위)에 보일 것.
- 조건 평가가 extract 실패/미바인딩으로 run을 죽이지 않을 것(자연스러운 분기).
- 직렬화 YAML이 round-trip 깨지지 않을 것(serde_yaml 0.9 map-shape enum 함정 회피).

## Considered Options

1. **평탄 if/elif/else + 구조화 조건 트리** (선택).
2. **재귀-중첩 else로 elif 표현** (`else: [ - type: if ... ]`) — catch-all else가
   깊이 묻혀 가독성 나쁨. 거절.
3. **조건식 문자열 DSL** (`if: "{{x}}==1 && ..."`) — 파서/검증/캔버스 빌더가 모두
   복잡, 구조화 트리로 충분. 거절(아래 §명시적 연기).

## Decision

**`type: if` = 평탄 if/elif/else + 재귀 조건 트리.**

- **else가 최상위**(평탄). 재귀-중첩으로 elif를 표현하면 catch-all else가 가장
  깊은 곳에 묻혀 혼란 → `elif`를 평탄 명시 리스트(`Vec<ElifBranch>`)로 둔다.
- **조건 트리** `Condition` = 잎(`Compare {left, op, right?}`) + 그룹(`All`/`Any`).
  단일 조건이면 래퍼 없이 `cond: {left, op, right}`만. map-shape라 `Body`/`Assertion`처럼
  **수동 serde**(derive는 `!variant` 태그 emit → round-trip 깨짐). `CompareOp`는
  데이터 없는 enum이라 derive로 OK.
- **연산자**: eq/ne(문자열 동치), contains, matches(정규식, 비앵커, `regex` 의존성),
  lt/gt/lte/gte(양쪽 f64 파싱, 한쪽 실패 → false), exists/empty(렌더값 비어있음 여부 —
  미바인딩과 빈 문자열을 동일 취급).
- **lenient 평가**: 조건 평가는 strict `render`와 별도인 `render_lenient`를 쓴다.
  미해결 토큰(`{{var}}`, 정의 안 된 `${NAME}`, loop 밖 `${loop_index}`) → 빈 문자열.
  **어떤 경우에도 run을 죽이지 않는다.** 잘못된 정규식은 lenient false + 1회 warn 로그
  (런타임 안전망 — authoring 검증은 UI 9b).
- **엔진 인터프리터**: `execute_steps`의 `Step::If` arm이 `cond` true → `then`,
  아니면 첫 true `elif`, 모두 false → `else`를 재귀 실행. loop arm처럼 `Box::pin`
  재귀(If/Loop arm만 박싱, flat http hot-path 무영향). 들어온 `loop_index`를
  분기 자식에 그대로 전달(새 스코프 없음) → if-in-loop에서 분기 안 http가 인덱스 보존.
- **중첩(상호 1레벨, 9c)**: 엔진 타입은 `Vec<Step>`로 자유 재귀 허용. 단일/상호 1레벨
  게이트(loop.do → http+if, if 분기 → http+loop, if-in-if·loop-in-loop 제외)는
  **UI Zod + 캔버스**가 담당(loop의 "엔진 재귀 / UI single-level" 패턴 계승).
- **컨트롤러 무변경**: 시나리오는 YAML 문자열로 워커에 전달, 엔진이 해석. 9c까지
  controller는 시나리오 의미를 검증하지 않고 passthrough(loop과 동일).

## Consequences

**Positive**
- loop과 같은 컨테이너 패턴·재귀 entry 재사용. 직렬화된 모든 스텝에 `type:` 박힘.
- 조건 평가가 run을 못 죽이므로, extract 실패/미바인딩이 자연스러운 분기로 흡수된다.
- hot path 무영향: If/Loop arm만 `Box::pin`, flat http는 추가 박스 0개.

**Negative / Trade-offs**
- 엔진 타입(`Vec<Step>`)이 UI 스키마보다 느슨 — 중첩 게이트가 타입이 아니라 UI 두 곳
  (Zod + 캔버스)에서 강제(loop과 동일 트레이드오프).
- 흐름 변수가 전부 문자열이라 조건은 문자열/f64 비교까지만(숫자 주입·형변환 미지원).

## 명시적 연기 (Out of scope, future slices)

- **if-in-if**, **loop-in-loop**, 더 깊은 자유 중첩 GUI.
- 조건식 문자열 DSL · 정규식 플래그(대소문자 무시 등).
- 분기별 **레이턴시** breakdown(9d는 counts-only, 7-1과 동일 한도).
- 분기 메트릭 breakdown 결정(전용 per-branch 카운터, cap 없음)은 9d ADR(또는 이 ADR 개정)에서 결정.

## Links

- Spec `docs/superpowers/specs/2026-05-30-slice-9-conditional-node-design.md`
- ADR-0020 (control-flow loop) — 같은 컨테이너/재귀 패턴
- ADR-0021 (loop 메트릭 breakdown) — 9d 분기 breakdown이 동형 파이프라인
- ADR-0014 (변수 표기) — `{{var}}` 흐름 변수, lenient 평가
- ADR-0017 (리포트 스코프) — 메트릭은 step_id 집계, 라벨은 UI
