# Slice 9 — Conditional 노드 설계

* Status: Draft (brainstorming 완료, 구현 전)
* Date: 2026-05-30
* 관련 ADR: ADR-0020(control-flow loop), ADR-0021(loop 메트릭 breakdown), ADR-0014(변수 표기), ADR-0016(VU per tokio task), ADR-0017(리포트 스코프)
* 후속 ADR: ADR-0023(conditional 노드) — 구현 시 추가

## 1. 개요 · 목표

첫 **분기 control-flow 노드** `type: if` 를 end-to-end 추가한다. Slice 7 loop가 깐
인프라를 재사용·확장한다:

- internally-tagged `Step` enum (`#[serde(tag="type")]`)
- 재귀 인터프리터 `execute_steps(steps, ctx)` + `StepFlow` 신호
- React Flow 부모/자식 subflow 컨테이너
- Zod discriminated union + `flattenHttpSteps` 헬퍼

흐름 변수는 전부 문자열(`BTreeMap<String,String>`)이므로 조건은 **문자열 비교**가
기반이며, 숫자 비교는 양쪽을 파싱한다.

이 기능은 범위가 커서 **4개 하위 슬라이스(9a–9d)** 로 쪼갠다(§8). 이 문서는 네 슬라이스
공통의 설계 문서이고, 각 슬라이스는 자신의 plan(`docs/superpowers/plans/`)으로 구현한다.

## 2. 시나리오 모델

### 2.1 YAML 형태 (Python식 if / elif / else + 재귀 조건 트리)

```yaml
- type: if
  id: "01HX0000000000000000000001"
  name: branch-on-status
  cond:
    all:                                     # AND (또는 any = OR)
      - { left: "{{code}}", op: eq, right: "200" }
      - any:                                 # 중첩 그룹
          - { left: "{{body}}", op: contains, right: "ok" }
          - { left: "{{retries}}", op: gte, right: "3" }
  then:
    - { id: "01HX0000000000000000000002", name: checkout, type: http,
        request: { method: POST, url: "/checkout" }, assert: [] }
  elif:                                      # optional, 평탄 리스트
    - cond: { left: "{{code}}", op: eq, right: "404" }
      then:
        - { id: "01HX0000000000000000000003", name: retry, type: http,
            request: { method: GET, url: "/retry" }, assert: [] }
  else:                                      # optional, 최상위 catch-all
    - { id: "01HX0000000000000000000004", name: report, type: http,
        request: { method: POST, url: "/report-error" }, assert: [] }
```

핵심 결정:

- **else가 최상위**다. "모두 거짓일 때"가 항상 한곳(맨 위)에 보인다. 재귀-중첩
  (`else: [ - type: if ... ]`)으로 elif를 표현하면 catch-all else가 가장 깊은 곳에
  묻혀 혼란스럽다 — 그래서 elif를 **평탄한 명시 리스트**로 둔다.
- 단일 조건이면 `cond` 에 `all`/`any` 래퍼 없이 `cond: { left, op, right }` 만 써도 된다
  (가장 흔한 케이스가 깔끔). elif·else는 둘 다 생략 가능(= 단순 then-only / if-else).

### 2.2 엔진 타입 (`crates/engine/src/scenario.rs`)

```rust
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Step {
    Http(HttpStep),
    Loop(LoopStep),
    If(IfStep),               // 신규
}

#[serde(deny_unknown_fields)]
pub struct IfStep {
    pub id: String,
    pub name: String,
    pub cond: Condition,
    #[serde(rename = "then")]
    pub then_: Vec<Step>,
    #[serde(default)]
    pub elif: Vec<ElifBranch>,
    #[serde(rename = "else", default)]
    pub else_: Vec<Step>,
}

#[serde(deny_unknown_fields)]
pub struct ElifBranch {
    pub cond: Condition,
    #[serde(rename = "then")]
    pub then_: Vec<Step>,
}

// 재귀 조건 트리. 잎(Compare) + 그룹(All/Any). 수동 serde (§2.3).
pub enum Condition {
    Compare { left: String, op: CompareOp, right: Option<String> },
    All(Vec<Condition>),      // {all: [...]}  = AND
    Any(Vec<Condition>),      // {any: [...]}  = OR
}

#[serde(rename_all = "lowercase")]   // 단순 enum — derive 가능
pub enum CompareOp {
    Eq, Ne, Contains, Matches, Lt, Gt, Lte, Gte, Exists, Empty,
}
```

`Step`/`IfStep`은 loop과 같은 이유로 각 variant 구조체에 개별 `#[serde(deny_unknown_fields)]`
(internal 태그는 enum 레벨 strict를 강제하지 않음 — 엔진 CLAUDE.md). 엔진 타입은 `Vec<Step>`
으로 느슨(자유 중첩)하고, 중첩 게이트는 UI Zod가 담당(§5).

### 2.3 `Condition` 수동 serde (함정 회피)

`Condition`은 map-shape 변형(`{all: [...]}` / `{any: [...]}` / `{left, op, right}`)이다.
엔진 CLAUDE.md에 박힌 함정 — **serde_yaml 0.9에서 externally-tagged enum + map variant는
round-trip이 깨진다**(`!variant value` 태그 emit, 사용자/UI의 `{variant: value}` 맵
역직렬화 실패) — 때문에 `Body`/`Assertion`과 동일하게 **수동 `Serialize`/`Deserialize`**
를 구현한다. 역직렬화 visitor 규칙:

- 맵에 키 `all` → `All`, 키 `any` → `Any`
- 그 외(키 `left` 존재) → `Compare { left, op, right? }`
- `right`는 `exists`/`empty`에서 생략 가능(`Option`, `skip_serializing_if`).

`CompareOp`는 단순(데이터 없는) enum이라 `derive`로 round-trip OK(`Extract`의 internally-tagged
struct variant가 OK인 것과 동일 부류). round-trip 통합 테스트로 계약 고정.

## 3. 조건 평가 (lenient)

### 3.1 lenient resolver

조건 평가는 **관대(lenient) resolver**를 쓴다 — 엔진 `template.rs::render`(strict,
unknown var에 fail-fast)와 **별도 경로**이며, UI `resolveForDisplay`(미해결 토큰 보존)와
같은 철학이다. 규칙: 모든 미해결 토큰(`{{var}}`, 정의 안 된 `${NAME}`, loop 밖 `${loop_index}`)
→ **빈 문자열 `""`**. **조건 평가는 어떤 경우에도 run을 죽이지 않는다.** extract 실패로
변수가 없을 때 자연스럽게 분기하기 위함.

구현은 `template.rs`에 lenient 변형(예: `render_lenient`)을 추가해 파싱 로직을 공유한다.

### 3.2 `eval_condition(cond, ctx) -> bool`

- `Compare`: `left`·`right`를 lenient render 후 op 적용.
- `All(v)`: 모든 자식이 true(빈 그룹 → **true**, vacuous).
- `Any(v)`: 하나라도 true(빈 그룹 → **false**).
- (UI는 빈 그룹을 만들지 못하게 막지만 엔진 의미는 위로 고정.)

### 3.3 연산자 의미

| op | 의미 | 비고 |
|---|---|---|
| `eq` / `ne` | 렌더된 문자열 동치/부정 | `"200" eq "200.0"` → false (문자열) |
| `contains` | `left` ⊇ `right` 부분문자열 | |
| `matches` | 정규식 `is_match`(Rust `regex`, **비앵커**) | 새 의존성 `regex` |
| `lt`/`gt`/`lte`/`gte` | 양쪽 **f64 파싱** 후 수치 비교 | 한쪽이라도 파싱 실패 → **false** |
| `exists` | 렌더값 ≠ `""` | `right` 무시 |
| `empty` | 렌더값 == `""` | `right` 무시 |

- 숫자 비교는 **반드시 파싱**한다(문자열 `"200" < "30"`은 사전순으로 틀린 결과).
- `exists`/`empty`는 "미바인딩"과 "빈 문자열"을 **의도적으로 동일 취급**한다(extract 실패 ≈ 빈 값).
- **잘못된 정규식**: (a) authoring 검증 — UI(9b)가 `new RegExp` 스모크 체크, (b) 런타임
  안전망 — 엔진은 정규식 컴파일 실패 시 그 비교를 **lenient false** + 1회 로그. (controller는
  9c까지 시나리오 의미를 검증하지 않고 YAML passthrough — loop과 동일.)

## 4. 엔진 인터프리터

`execute_steps`에 `Step::If` arm 추가(loop과 같이 `Box::pin` 재귀 — If/Loop arm에서만
박싱하므로 flat http hot-path 무영향):

1. `eval_condition(&if.cond, ctx)` → true면 `then_`를 재귀 `execute_steps`.
2. false면 `elif`를 **순서대로** 평가, 첫 true의 `then`을 실행하고 멈춤.
3. 모두 false면 `else_` 실행(비었으면 no-op).

`StepFlow`(Continue / DeadlineReached / Aborted)를 그대로 상위로 전파. deadline·cancel
체크는 loop과 동일하게 분기 진입 전·스텝 사이에서.

`${loop_index}`는 단일 loop 레벨 유지(중첩 loop 없음, §5) → `TemplateContext`의 스칼라
하나로 충분. if-in-loop이면 안쪽 if·그 자식 http가 바깥 loop의 `loop_index`를 본다.

## 5. 중첩 게이트 (상호 1레벨, "Y")

엔진은 `Vec<Step>` 자유 재귀라 타입상 무제한. 게이트는 **UI Zod + 캔버스**가 담당
(loop의 "엔진 재귀 / UI single-level" 패턴 계승):

| 위치 | 허용 child | 제외 |
|---|---|---|
| 최상위 `steps` | http, loop, if | — |
| `loop.do` | http, **if** | loop (loop-in-loop, 기존 유지) |
| `if` 분기 (`then` / `elif[].then` / `else`) | http, **loop** | if (if-in-if) |

- 잎은 항상 http.
- 허용 조합: **if-in-loop**, **loop-in-if** (상호 1레벨).
- 제외: **if-in-if**, **loop-in-loop**, 더 깊은 중첩.
- 이유: 데이터-드리븐 loop에서 행마다 분기(8c+loop+if), 분기 안에서 반복 — 둘 다 부하 테스트의
  고가치 조합. if-in-if는 elif로 대부분 대체되므로 제외해 슬라이스를 한정.

## 6. UI

### 6.1 Zod 모델 (`ui/src/scenario/model.ts`)

- `ConditionModel`: `z.lazy`로 재귀 **`z.union`** — `{left, op, right?}` | `{all: Condition[]}` | `{any: Condition[]}`. 세 변형은 공유 discriminant 키가 없어 `discriminatedUnion`이 아니라 키 존재(`all`/`any`/`left`)로 구별하는 `z.union`이다. Rust 수동 serde가 내는 JSON과 **1:1 매치**(8c `Mapping` 함정과 동일 — round-trip 통합 테스트로 고정).
- `CompareOpModel`: enum.
- `ElifBranchModel`: `{cond, then}`.
- `IfStepModel`: `type:"if"`, `cond`, `then`, `elif`(default []), `else`(default []).
- `StepModel` union에 if 추가.
- 게이트(§5): `LoopStepModel.do` → http+if, `IfStepModel`의 then/elif[].then/else → http+loop. (9b는 분기 http-only로 시작, 9c에서 게이트 완화.)

### 6.2 캔버스 — 세로 적층 존

if 노드 = React Flow 컨테이너. 헤더에 `if` + 조건 요약, 그 아래 **THEN / ELIF… / ELSE
밴드**를 세로로 적층, 각 밴드가 자식 노드를 담는다. elif가 늘어도 아래로만 자라 폭이 일정하고
loop의 세로 컨테이너와 일관. 부모 노드에 명시 width/height(자식 수로 높이 계산) — loop 패턴.
중첩(9c)은 밴드 안에 loop 컨테이너(또는 loop 바디 안에 if 컨테이너)가 또 들어가는
**subflow depth**(loop이 연기했던 레이아웃)를 두 방향에서 구현.

### 6.3 인스펙터 — 재귀 조건 빌더

if 노드 선택 시 인스펙터에 조건 트리 편집기: 그룹마다 `match` ALL/ANY 토글, 비교 행
(`left` 입력 / `op` 드롭다운 / `right` 입력 / `×`), `+조건`(행 추가)·`+그룹`(하위 all/any
그룹 추가). `exists`/`empty` 선택 시 `right` 칸 숨김. 입력 commit은 onBlur, 로컬 state는
onChange(`ExtractEditor` 표준 패턴 — UI CLAUDE.md). 이 트리가 그대로 `cond` YAML로 round-trip.

### 6.4 양방향 sync · 헬퍼

- `yaml` Document API targeted edit으로 조건/분기 편집(코멘트 보존 한도는 loop과 동일 — 스텝 통째 교체 시 내부 코멘트 소실).
- **`flattenHttpSteps`**: if 분기 3종(then/elif[].then/else) + loop 바디를 **양방향 재귀**하도록 확장(report 라벨링·inspector·data-binding 스캔이 모두 재사용).
- **`scanFlowVars`(8c DataBindingPanel)**: if 분기 안 http 스텝의 `{{var}}`도 스캔(아니면 분기 안 변수가 바인딩 패널에 안 보임). `flattenHttpSteps` 재사용으로 자연 해결.

## 7. 분기 메트릭 breakdown (전용 파이프라인, 7-1 스타일)

per-step count만으로는 "빈 분기로 fall-through한 비율"이 안 보이므로 **전용 분기 결정
카운터**를 둔다(Slice 7-1 loop breakdown과 동형 파이프라인):

```
엔진 Aggregator: per-(if_id, branch) count
  branch ∈ { then, elif_0, elif_1, …, else, none }   # none = 무매치 & else 없음/빈
      → MetricFlush.branch_stats (delta)
      → gRPC MetricBatch.branch_stats
      → controller run_if_metrics 테이블 (migration 0005, CREATE TABLE IF NOT EXISTS 멱등)
        UPSERT-accumulate
      → ReportStep.branch_breakdown
      → UI StepStatsTable drill-down (if 노드 행 caret)
```

- **cap 불필요**: loop_index(무한)와 달리 branch 집합은 if 노드당 유한(then + elif 수 +
  else/none). overflow sentinel 없음.
- `runs` 테이블 무변경(프로파일은 `profile_json`). proto는 `branch_stats` 추가(exhaustive
  match 주의 — controller CLAUDE.md).

## 8. 슬라이스 분할 (9a–9d)

작게 쪼갠다. 각 하위 슬라이스는 독립 출하 가능하고 자신의 plan을 가진다.

### 9a — 엔진: 조건 모델 + 평가 + if 인터프리터
- `Condition`(수동 serde) + `CompareOp` + `IfStep`/`ElifBranch`, `Step::If`.
- `regex` 의존성 추가.
- lenient resolver(`template.rs`), `eval_condition`.
- `execute_steps`의 `Step::If` arm.
- 테스트: scenario round-trip(수동 serde·중첩 AND/OR), `eval_condition` 단위(각 op·lenient·
  빈 그룹), wiremock 통합(then/elif/else 경로), proptest(condition round-trip).
- **UI·controller·proto·메트릭 무변경** (8a처럼 엔진 단독 출하). branch 메트릭은 9d.

### 9b — UI authoring (single-level, 분기 http-only)
- Zod(`ConditionModel` 재귀 + `IfStepModel` + elif), `StepModel` union, `flattenHttpSteps` if 확장.
- 캔버스 if 컨테이너(세로 적층 존), 인스펙터 재귀 조건 빌더.
- 양방향 sync(조건/분기 편집), `scanFlowVars` if 확장.
- 분기는 **http-only로 시작**(중첩은 9c).
- 테스트: RTL(빌더 트리·캔버스 렌더), fast-check YAML round-trip, `pnpm build`(tsc 게이트).

### 9c — 상호 컨테이너 중첩 (Y)
- Zod 게이트 완화: `loop.do` → http+if, `if` 분기 → http+loop.
- 캔버스 중첩 subflow depth 렌더(두 방향), `flattenHttpSteps` 양방향 확인.
- 테스트: 중첩 round-trip, 캔버스 중첩 렌더 RTL.

### 9d — 분기 메트릭 breakdown
- 엔진 `Aggregator` per-(if_id, branch), `MetricFlush.branch_stats`.
- proto `MetricBatch.branch_stats`, controller `run_if_metrics`(migration 0005), `ReportStep.branch_breakdown`.
- UI StepStatsTable drill-down.
- 테스트: aggregator 단위, controller report 통합, e2e smoke.
- ADR-0023 메트릭 결정 업데이트.

## 9. 테스트 전략 (요약)

- **엔진(9a)**: round-trip(수동 serde), `eval_condition` 단위 매트릭스, wiremock 분기 통합, proptest.
- **UI(9b/9c)**: RTL + fast-check round-trip + `pnpm build` tsc 게이트(discriminated union·Zod default 누출 주의 — UI CLAUDE.md).
- **메트릭(9d)**: aggregator 단위 + controller 통합 + e2e smoke.
- 모든 단계 pre-commit hook(fmt/build/clippy/test) 통과. UI는 `pnpm test && pnpm build` 수동.

## 10. 명시적 연기 (out of scope)

- **if-in-if**(분기 안 if), **loop-in-loop**, 더 깊은 자유 중첩 GUI.
- 조건식 **문자열 DSL**(`if: "{{x}}==1 && ..."`) — 구조화 트리로 충분.
- 중첩 loop `${loop_index}` 스코프된 이름.
- 숫자 주입/형변환(조건은 문자열/f64 비교까지) · 정규식 플래그(대소문자 무시 등).
- 분기별 **레이턴시** breakdown(9d는 counts-only, 7-1과 동일 한도).

## 11. ADR

구현 시작 시 **ADR-0023**(conditional 노드: 평탄 if/elif/else + 재귀 조건 트리 + lenient
평가 + 상호 1레벨 중첩) 추가, 9d에서 메트릭 결정(전용 per-branch breakdown, cap 없음) 반영.
루트 CLAUDE.md "알아둘 결정들"·도메인 CLAUDE.md 함정·`docs/roadmap.md`(§A1 완료 이동, §B 연기 항목 추가) 갱신.
