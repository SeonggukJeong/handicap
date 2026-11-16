# 추출 기본값 (extract-default) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 추출 항목에 `default`를 적으면 값이 없을 때 그 글자가 들어가고(조건 반복 안팎), 시험 실행·모니터 기록에 「기본값」 표시가 뜬다.

**Architecture:** 엔진 `Extract::{Body,Header,Cookie}`에 `default: Option<String>`을 더한다. 기존 `blank_missing_extracts`를 `fill_missing_extracts`로 넓혀 runner·trace의 네 자리(조건 반복 밖 포함)에서 부르고, 엄격한 추출에는 기본값 항목이 있을 때만 쓰는 형제 함수 `evaluate_with_defaults`를 둔다. 기본값이 들어간 이름은 `StepTrace.defaulted`로 화면까지 간다. proto·migration 무변경.

**Tech Stack:** Rust(engine·controller·tui), TypeScript/React(Zod·Zustand·vitest).

REVIEW-GATE: APPROVED

**Spec:** `docs/superpowers/specs/2026-11-16-extract-default-design.md` — 요구사항 R0–R6의 정본. 이 plan과 어긋나면 spec이 이긴다(어긋남 발견 = STOP, 보고).

## Global Constraints

- `default` 없는 추출 항목의 동작·YAML·와이어는 바이트 단위로 지금과 같다(R0). 기존 테스트는 리터럴에 `default: None`/`defaulted: Vec::new()`를 더하는 것 말고는 고치지 않는다 — **예외 하나**: Task 4가 시그니처를 바꾸는 `ui/src/scenario/__tests__/condEmptyEval.test.ts`(인자 모양만 바꾸고 기대값은 그대로).
- 기본값 규칙(R1) — 엔진과 UI가 같은 규칙: ① 빈 문자열 금지 ② `{{` 또는 `${` 금지 ③ 256 코드포인트 이하 ④ 제어 문자 금지. 엔진 거절 문구(네 규칙)는 값을 싣지 않는다. 단 따옴표 없는 `default: 0`·`true`는 serde의 타입 에러(`invalid type: integer `0``)로 거절되어 그 숫자·불리언이 문구에 보인다(문자열은 이 경로에 오지 않는다 — 보안 리뷰에 알린다).
- runner(`execute_steps`)와 trace(`trace_steps`)는 같은 함수(`fill_missing_extracts`)로 채운다.
- UI 문구는 전부 `ui/src/i18n/ko.ts`, TUI 문구는 `crates/tui/src/text.rs` 경유(아래 문구 표 그대로).
- `ui/src`를 건드리는 task는 **테스트 파일을 먼저** 편집한다(`tdd-guard`). `crates/*/src`도 같다 — 각 task의 Step 1이 테스트다.
- 커밋·게이트에 `| tail`·`| head` 금지, `--no-verify` 금지. cargo 영향 커밋은 수 분 걸린다(implementer는 단일 FOREGROUND 호출, timeout 600000ms).
- 줄번호는 편집 전 `grep -n`으로 다시 확인한다(아래 줄번호는 plan 작성 시점 `89ade40a` 기준).

### 문구 표 (byte-exact)

| 키 | 값 |
|---|---|
| `ko.editor.extractDefaultPlaceholder` | `값이 없을 때` |
| `ko.editor.extractDefaultAria(n)` (n = 0부터, 기존 `extractDecodeAria`와 같다) | `` `추출 ${n} 값이 없을 때 쓸 값` `` |
| `ko.editor.extractDefaultHelpAria(n)` | `` `추출 ${n} 기본값 도움말` `` |
| `ko.editor.extractDefaultErrVars` | `기본값에는 {{변수}}나 ${ENV}를 적을 수 없습니다. 적은 글자가 그대로 들어갑니다.` |
| `ko.editor.extractDefaultErrControl` | `기본값에는 줄바꿈·탭 같은 제어 문자를 적을 수 없습니다.` |
| `ko.editor.gateExtractDefaultEmpty(path)` | `` `${path}: 기본값은 비울 수 없습니다(쓰지 않으려면 default 줄을 지우세요)` `` |
| `ko.editor.gateExtractDefaultVars(path)` | `` `${path}: 기본값에는 {{변수}}나 ${"${ENV}"}를 적을 수 없습니다` `` |
| `ko.editor.gateExtractDefaultLong(path)` | `` `${path}: 기본값은 256자까지입니다` `` |
| `ko.editor.gateExtractDefaultControl(path)` | `` `${path}: 기본값에는 제어 문자를 적을 수 없습니다` `` |
| `ko.glossary.extractDefault1` | `응답에 값이 없을 때(JSON null 포함) 이 글자가 대신 들어갑니다. 요청이 실패했거나 응답 검증에 실패했거나 보내지 못한 스텝에서도 들어갑니다.` |
| `ko.glossary.extractDefault2` | `기본값이 들어간 값은 받은 값으로 취급합니다. 뒤 요청 주소에 써도 막히지 않고, 그 스텝은 값 누락 때문에 에러로 세지 않습니다.` |
| `ko.glossary.extractDefault3` | `적은 글자가 그대로 들어갑니다. {{변수}}·${ENV}는 적을 수 없고, 디코딩(base64·JWT)은 적용되지 않습니다.` |
| `ko.glossary.extractDefault4` | `기본값이 쓰였는지는 시험 실행과 모니터 기록의 「기본값」 표시로 봅니다. 부하 실행 리포트에는 표시되지 않습니다.` |
| `ko.common.defaultedTag` | `기본값` |
| `ko.common.defaultedNames(names)` | `` `기본값 사용: ${names}` `` |
| `ko.editor.loopLenientExtractHelp` (끝에 덧붙임) | ` 추출 줄의 「값이 없을 때」에 기본값을 적으면 빈 값 대신 그 글자가 들어가고, 주소에 써도 막히지 않습니다.` |
| `text::defaulted_names(&[String])` (TUI) | `기본값 사용: a, b` (이름을 `, `로 이음) |

Zod 영어 와이어 문구(`problems.ts`가 위 gate 키로 매핑): `default must not be empty` · `default must not contain {{ or ${` · `default too long (max 256)` · `default must not contain control characters`. 엔진 serde 문구도 같은 네 문장 앞에 `extract ` 를 붙인다(`extract default must not be empty` …).

## Review Focus

1. **조건 반복 밖 + 요청 실패/차단** — 기본값이 들어가야 한다(지금 네 자리는 조건 반복 표지로 막혀 있다). → Task 2 테스트 `outside_loop_transport_failure_fills_default`·`outside_loop_blocked_fills_default`.
2. **기본값 없는 항목이 먼저 실패하고 그 뒤에 기본값 항목** — 뒤 항목의 실제 값이 남아야 한다. → Task 1 테스트 `strict_keeps_later_default_item_value_on_err`.
3. **편집 칸에 `{{x}}` 입력** — 편집기가 잠기면 안 된다(`yamlError` null 유지). → Task 4 테스트.
4. **서버가 기본값과 같은 글자를 실제로 보냄** — `defaulted`에 오르면 안 된다. → Task 2 테스트 `server_sent_same_text_is_not_defaulted`.
5. **이름이 겹친 `refresh: request` 변수** — 기본값을 덮으면 안 된다. → Task 2 테스트 `default_stops_request_regen`.
6. **숫자처럼 생긴 기본값(`0`·`0x1F`·`0b101`·`true`·`null`)** — 편집 칸에 적으면 문자열로 저장돼 엔진이 읽어야 한다(`yaml` 라이브러리는 `0x1F`를 따옴표 없이 쓰고 serde_yaml은 정수로 읽는다 — `ui/src/scenario/CLAUDE.md` pick-array 줄). → Task 4 테스트(따옴표 강제) + Task 1 테스트(엔진이 따옴표 붙은 값을 읽는다).

---

### Task 1: 엔진 모델·검증·추출 함수

**Files:**
- Modify: `crates/engine/src/scenario.rs` (`Extract` enum, `grep -n "pub enum Extract" ` ≈ 426)
- Modify: `crates/engine/src/extract.rs` (`evaluate` 28, `evaluate_lenient` 101, `blank_missing_extracts` 177)
- Modify: `crates/engine/src/lib.rs:36` (re-export)
- Modify: `crates/engine/src/runner.rs:25,665,699`, `crates/engine/src/trace.rs:189,523,567` (이름만 — 동작은 Task 2)
- Modify (리터럴에 `default: None`): `crates/engine/src/{extract,scenario,executor}.rs`, `crates/engine/tests/proptests.rs` — 컴파일러가 세는 것이 정본이다(`cargo build --workspace --all-targets`가 빠진 리터럴을 전부 알려 준다; `step_judge.rs`는 `..` 패턴뿐이라 고칠 것이 없다).
- Test: `crates/engine/src/extract.rs` 안 `#[cfg(test)]`, `crates/engine/src/scenario.rs` 안 `#[cfg(test)]`

**Interfaces:**
- Produces:
  - `Extract::{Body,Header,Cookie}`에 필드 `default: Option<String>` — `#[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "…")]`. `Status`에는 없다.
  - `impl Extract { pub fn default_value(&self) -> Option<&str> }` (`Status` → `None`).
  - `pub const EXTRACT_DEFAULT_MAX_CHARS: usize = 256;` (`scenario.rs`)
  - `pub fn validate_extract_default(s: &str) -> Result<(), &'static str>` (`scenario.rs`) — 위 네 문장(`extract default …`) 중 하나. 검사 순서: 빈 값 → `{{`/`${` → 길이 → 제어 문자.
  - `pub struct StrictOutcome { pub extracted: BTreeMap<String, String>, pub error: Option<EngineError> }`
  - `pub fn evaluate_with_defaults(extracts: &[Extract], facts: &ResponseFacts<'_>) -> StrictOutcome`
  - `pub fn has_default(extracts: &[Extract]) -> bool`
  - `pub struct Filled { pub blanked: Vec<String>, pub defaulted: Vec<String> }` (`Default`)
  - `pub fn fill_missing_extracts(step: &HttpStep, extracted: &mut BTreeMap<String, String>, iter_vars: &mut BTreeMap<String, String>, blank: bool) -> Filled` — `blank_missing_extracts`를 **대체**(옛 이름 삭제).
  - `lib.rs` re-export: `fill_missing_extracts`, `evaluate_with_defaults`, `has_default`, `Filled`, `StrictOutcome`.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`scenario.rs` 테스트 모듈:

```rust
#[test]
fn extract_default_roundtrips_and_is_absent_when_none() {
    let y = "- {var: a, from: body, path: $.a, default: none}\n- {var: b, from: header, name: X-B}\n";
    let v: Vec<Extract> = serde_yaml::from_str(y).unwrap();
    assert_eq!(v[0].default_value(), Some("none"));
    assert_eq!(v[1].default_value(), None);
    let out = serde_yaml::to_string(&v).unwrap();
    assert_eq!(out.matches("default:").count(), 1);
}

#[test]
fn extract_default_rejections_are_value_free() {
    let long = "x".repeat(257);
    for (bad, want) in [
        ("\"\"", "extract default must not be empty"),
        ("\"a{{b}}\"", "extract default must not contain {{ or ${"),
        ("\"${SECRET_ENV}\"", "extract default must not contain {{ or ${"),
        (long.as_str(), "extract default too long (max 256)"),
        ("\"a\\nb\"", "extract default must not contain control characters"),
    ] {
        let y = format!("{{var: a, from: cookie, name: c, default: {bad}}}");
        let e = serde_yaml::from_str::<Extract>(&y).unwrap_err().to_string();
        assert!(e.contains(want), "{e}");
        assert!(!e.contains("SECRET_ENV"), "{e}");
    }
    // 256자는 통과, 멀티바이트는 코드포인트로 센다.
    let ok = "가".repeat(256);
    assert!(serde_yaml::from_str::<Extract>(&format!("{{var: a, from: cookie, name: c, default: {ok}}}")).is_ok());
    // 따옴표 붙은 숫자꼴은 문자열로 읽는다(UI가 이렇게 쓴다). 따옴표 없는 `default: 0`은 타입 에러로 거절된다(손 YAML — 수용).
    let v: Extract = serde_yaml::from_str("{var: a, from: cookie, name: c, default: \"0x1F\"}").unwrap();
    assert_eq!(v.default_value(), Some("0x1F"));
    assert!(serde_yaml::from_str::<Extract>("{var: a, from: cookie, name: c, default: 0}").is_err());
    // status에는 default가 없다.
    assert!(serde_yaml::from_str::<Extract>("{var: s, from: status, default: x}").is_err());
}
```

`extract.rs` 테스트 모듈(기존 테스트의 `facts` 만들기 방식을 따른다 — 헬퍼가 없으면 `ResponseFacts { status, headers: &[], set_cookies: &[], body }` 리터럴):

```rust
// 본문 {"a":"A","n":null,"jwt":"x"}  헤더 X-H: hv
#[test]
fn strict_default_items_skip_all_seven_failures() {
    // 일곱 항목 전부 default: Some("d") — 본문 경로 없음($.zz) · JSON null($.n) · 헤더 없음 · 쿠키 없음 ·
    // decode 실패(`decode: base64`, 값 "!!!") · claim 없음(`decode: jwt, claim: $.missing` — 유효한 JWT 픽스처는 이 파일의 기존 jwt 테스트 것을 쓴다)
    // · claim이 null(`claim: $.n`, payload {"n":null}) · (별도 호출) 본문이 JSON이 아님
    // 기대: error == None, extracted에 일곱 이름이 하나도 없다.
}

#[test]
fn strict_keeps_later_default_item_value_on_err() {
    // 선언 순서: [x: body $.zz (default 없음 → 실패), a: body $.a default "d"]
    let o = evaluate_with_defaults(&items, &facts);
    assert_eq!(o.error.unwrap().to_string(), /* evaluate(&items[..1]) 의 에러 문구와 같다 */);
    assert_eq!(o.extracted.get("a").map(String::as_str), Some("A"));
    assert!(!o.extracted.contains_key("x"));
}

#[test]
fn strict_err_drops_values_of_items_without_default() {
    // [k: body $.a (default 없음, 성공), x: body $.zz (default 없음, 실패)] + [a: body $.a default "d"]
    // 기대: error Some, extracted == {"a": "A"} (k는 버린다)
}

#[test]
fn strict_without_failure_matches_evaluate_for_non_default_items() {
    // [k: body $.a, n: body $.n (default 없음 → "" 로 뽑힘), a: body $.n default "d" (null → 건너뜀)]
    // 기대: error None, extracted == {"k":"A","n":""}
}

#[test]
fn fill_table_four_cells_and_duplicate_rule() {
    // step.extract = [a default "d1", a default "d2", b (default 없음), c default "dc"]
    // extracted 시작값 {"c":"C"}
    // blank=true  → extracted/iter_vars: a="d2", b="", c="C"; Filled{blanked:["b"], defaulted:["a"]}
    // blank=false → a="d2", b 없음, c="C"; Filled{blanked:[], defaulted:["a"]}
    // 한 이름을 [default "d1", default 없음]으로 선언하고 못 뽑으면 "d1"(default 있는 마지막 항목).
}
```

주석으로 적은 기대값을 그대로 단언으로 옮긴다. 일곱 실패 테스트는 실패 종류마다 단언 한 줄씩 따로 둔다(어느 실패가 빠졌는지 보이게).

- [ ] **Step 2: 실패 확인** — `cargo test -p handicap-engine --lib extract 2>&1; echo exit=$?` → 컴파일 에러(`default` 필드·함수 없음).

- [ ] **Step 3: 구현**

  - `scenario.rs`: 필드·`default_value()`·`validate_extract_default`·`deserialize_with` 함수(`String`으로 받아 검증 후 `Some`). `char::is_control`로 제어 문자 판정, 길이는 `chars().count()`.
  - `extract.rs` `evaluate_with_defaults`: 모든 항목을 선언 순서로 끝까지 평가한다. `default` 있는 항목은 `evaluate_lenient`와 같은 규칙으로 "못 뽑음"이면 건너뛴다(JSON `null`·`null` claim 포함 — 항목 하나를 너그럽게 평가하는 내부 함수를 `evaluate_lenient`와 공유하도록 뽑아낸다). `default` 없는 항목은 `evaluate`와 같은 규칙·같은 에러 문구(본문 JSON 파싱은 한 번만, 지연). 에러는 첫 번째로 실패한 `default` 없는 항목의 것. 에러가 있으면 `extracted`에는 `default` 있는 항목이 뽑은 값만 남긴다(선언 순서 마지막이 이긴다).
  - `has_default`: `extracts.iter().any(|e| e.default_value().is_some())`.
  - `fill_missing_extracts`: 맨 앞에서 `if !blank && !has_default(&step.extract) { return Filled::default(); }`(조건 반복 밖·기본값 없는 스텝 = 모든 요청의 흔한 경로 — 할당 0, R0). 그 뒤 선언된 이름마다(첫 등장 순서, 중복 제거) `extracted`에 없으면 — 그 이름의 `default` 있는 **마지막** 항목의 값이 있으면 `extracted`·`iter_vars`에 넣고 `defaulted`에, 없고 `blank`면 `""`를 넣고 `blanked`에, 그 밖에는 아무것도 안 한다.
  - `evaluate`·`evaluate_lenient`의 바깥 동작은 그대로(기존 테스트 무수정 통과).
  - 호출부 네 곳은 이름만 바꾼다: `blank_missing_extracts(http, &mut m, iter_vars)` → `fill_missing_extracts(http, &mut m, iter_vars, true).blanked` (조건은 그대로 — 동작 변화 없음).
  - 리터럴 전부에 `default: None`. `tests/proptests.rs`의 `Extract` 생성기(≈53–77)는 `default`도 만든다(`prop::option::of("[a-z0-9_-]{1,12}")`).

- [ ] **Step 4: 통과 확인** — `cargo test -p handicap-engine 2>&1; echo exit=$?` → exit=0. `cargo clippy --workspace --all-targets -- -D warnings; echo exit=$?` → exit=0.

- [ ] **Step 5: 커밋** — `git add crates/engine` → `feat(engine): 추출 항목 default 필드와 채우기 함수 (extract-default)`.

---

### Task 2: 엔진 배선 (executor·runner·trace) + `StepTrace.defaulted`

**Files:**
- Modify: `crates/engine/src/executor.rs:310,659` (엄격한 추출 두 자리)
- Modify: `crates/engine/src/runner.rs` `Step::Http` arm (≈663–701), `crates/engine/src/trace.rs` `Step::Http` arm (≈519–588), `StepTrace` (135)
- Modify (리터럴에 `defaulted: Vec::new()`): `grep -rn "StepTrace {" crates`의 44곳(9파일 — controller `monitor/{check,record,step_judge}.rs`, engine `trace.rs`·`tests/blank_guard_trace.rs`, tui `src/{app,inspect}.rs`·`tests/{inspect_test,pick_test}.rs`)
- Create: `crates/engine/tests/extract_default.rs` (runner), `crates/engine/tests/extract_default_trace.rs` (trace)
- Modify: `crates/engine/CLAUDE.md` (한 줄)

**Interfaces:**
- Consumes: Task 1의 `fill_missing_extracts`·`evaluate_with_defaults`·`has_default`·`Filled`.
- Produces: `StepTrace.defaulted: Vec<String>` — `#[serde(default, skip_serializing_if = "Vec::is_empty")]`, 그 스텝에서 기본값이 들어간 이름(선언 순서, 중복 없음). JSON 키 `defaulted`.

- [ ] **Step 1: 실패하는 통합 테스트를 쓴다**

`tests/extract_default.rs`는 `tests/blank_guard.rs`의 헬퍼(`run_mode`·`Mode::{Closed,Curve,Open}`·`win`·`kind_count`·`received`·`http`·`loop_block`·`scenario_yaml`·`json_resp`)를 복사해 쓴다. `tests/extract_default_trace.rs`는 `tests/blank_guard_trace.rs`를 같은 식으로. wiremock 서버, ULID step id(I·L·O·U 금지).

runner(각 테스트는 `Mode::Closed`로, `us1`만 세 모드 전부):

| 테스트 | 시나리오 | 단언 |
|---|---|---|
| `us1_default_unblocks_url_after_loop_{closed,curve,open}` | 조건 반복(`while: state ne DONE`, repeat 2) 안 `GET /poll` 응답 `{"state":"DONE"}`(orderId 없음 — 반복은 **조건으로** 끝나야 뒤 스텝이 돈다. 최대 횟수로 끝나면 그 실행이 끝난다), 추출 `state: $.state`·`orderId: $.orderId default none`. 반복 뒤 `GET /orders/{{orderId}}` | `received("/orders/none") > 0`, 뒤 스텝 `ErrorKind::BlankVar` 0건 |
| `us2_self_cursor_recovers` | 조건 반복 안 `GET /page/{{cursor}}`(커서는 **경로**에 — `received()`는 경로만 본다. 시나리오 `variables: {cursor: start}`), 추출 `cursor: $.next default restart`(초기값과 **다른** 글자), `state: $.state`. 응답: `/page/start` → `{"state":"WAIT"}`(next 없음), `/page/restart` → `{"state":"DONE","next":"n2"}` | `received("/page/restart") >= 1`, page 스텝 `BlankVar` 0건(기본값을 빼면 2회차가 막혀 BlankVar ≥ 1·`/page/restart` 0 → RED) |
| `us3_outside_loop_missing_field_is_not_error` | 반복 없음. `GET /a` 응답 `{}` 추출 `coupon: $.couponId default none` → `if coupon eq none` then `GET /no-coupon` else `GET /coupon` | `/a` 스텝 에러 0, `/no-coupon` 접수 > 0, `/coupon` 0 |
| `outside_loop_transport_failure_fills_default` | 반복 없음. 죽은 포트로 `GET`(추출 `t: $.t default none`) → `GET {server}/next/{{t}}` | `/next/none` 접수 > 0 (기본값이 없으면 `UnknownVar`로 VU가 죽어 0) |
| `outside_loop_blocked_fills_default` | 조건 반복이 `id`를 비우고(기본값 없음) **조건으로** 끝난다(응답 `{"state":"DONE"}`) → 반복 뒤 `GET /x/{{id}}`(막힘, 추출 `r: $.r default none`) → `GET /y/{{r}}` | `/x/` 0건, `/y/none` 접수 > 0 |
| `default_stops_request_regen` | `variables`에 `refresh: request` 생성 변수 `tok`(기존 `tests/genvars_per_request.rs`의 선언 모양) + 스텝 1 추출 `tok: $.tok default fixed`(응답 `{}`) → 스텝 2·3 `GET /u/{{tok}}` | `/u/fixed`만 접수(2건 이상), 다른 `/u/*` 0 |
| `no_default_behaviour_unchanged` | `us1`에서 `default`만 뺀 시나리오(반복은 조건으로 끝난다) | `/orders/` 접수 0, 뒤 스텝 BlankVar > 0 (지금과 같다) |

trace:

| 테스트 | 단언 |
|---|---|
| `trace_us1_defaulted_marks_step` | `/poll` 행 `defaulted == ["orderId"]`, `extracted["orderId"] == "none"`, 뒤 행 `blocked == None`, 요청 url 끝 `/orders/none` |
| `server_sent_same_text_is_not_defaulted` | 응답 `{"orderId":"none"}` → 그 행 `defaulted`가 비고 JSON에 `defaulted` 키가 없다(`serde_json::to_value`) |
| `trace_us3_outside_loop_ok` | 스텝 `error == None`, `ScenarioTrace.ok == true`, if 판정 행 `branch == "then"` |
| `trace_outside_loop_transport_failure_fills_default` | 실패 행 `defaulted == ["t"]`, 다음 행 요청 url 끝 `/next/none`·`unbound_vars` 빔 |
| `trace_outside_loop_blocked_fills_default` | 막힌 행 `blocked.is_some()`·`defaulted == ["r"]`, 다음 행 url 끝 `/y/none` |
| `trace_us2_self_cursor_recovers` | runner `us2`와 같은 시나리오 → 1회차 page 행 `defaulted == ["cursor"]`, 2회차 page 행 url 끝 `/page/restart`·`blocked == None`, `ended_by_loop == None` |
| `trace_default_stops_request_regen` | runner `default_stops_request_regen`과 같은 시나리오 → 스텝 2·3 행 url 끝이 둘 다 `/u/fixed` |
| `trace_strict_err_keeps_default_item_value` | 한 스텝 추출 `[x: $.zz, a: $.a default d]`, 응답 `{"a":"A"}` → 행 `error.is_some()`, `extracted == {"a":"A"}`, `defaulted` 빔 |

- [ ] **Step 2: 실패 확인** — `cargo test -p handicap-engine --test extract_default --test extract_default_trace 2>&1; echo exit=$?` → 컴파일 에러(`defaulted` 없음). 필드만 먼저 더해 컴파일시키면 `us1`·`us3`·`outside_loop_*`가 FAIL.

- [ ] **Step 3: 구현**

  - `executor.rs` 엄격한 추출 두 자리(310·659) — 같은 모양으로:
    `has_default(&step.extract)`면 `let o = evaluate_with_defaults(..); extracted = o.extracted; if let Some(e) = o.error { error = Some(e.to_string()); }`, 아니면 지금 코드 그대로.
  - `runner.rs`·`trace.rs` `Step::Http` arm, 두 경로(막힘 / 실행) 모두 **조건 반복 표지와 무관하게** 채운다:
    1. 막힌 경로: 빈 맵에 `fill_missing_extracts(http, &mut m, iter_vars, in_loop)` → `rg.mark_written(filled.defaulted.iter())` → `blank_guard::note_step(blanked, &http.id, &m, &filled.blanked)`. (`in_loop` = runner `cond_pass.is_some()`, trace `in_cond_loop`.) runner의 `mark_pass`는 지금처럼 `cond_pass`가 있을 때만.
    2. 실행 경로: `rg.mark_written(outcome.extracted.keys())`(지금 그대로) → `fill_missing_extracts(http, &mut outcome.extracted, iter_vars, in_loop)` → `rg.mark_written(filled.defaulted.iter())` → `note_step(.., &filled.blanked)` → `iter_vars.extend(..)`.
    3. trace는 두 경로의 `StepTrace`에 `defaulted: filled.defaulted`.
  - `rg`는 `Option`이다(`if let Some(rg) = req.as_mut()`). `mark_written`은 `impl IntoIterator<Item = &String>`을 받는다.
  - `StepTrace` 필드 추가 + 44곳 리터럴에 `defaulted: Vec::new()`.
  - `crates/engine/CLAUDE.md` "비움 표" 줄 아래에 한 줄: 채우기는 `fill_missing_extracts` 하나가 runner·trace 네 자리에서 조건 반복 안팎 모두 부른다 / 기본값이 들어간 이름은 `mark_written`에 넣고 비움 표에서 지운다 / 엄격한 추출은 기본값 항목이 있을 때만 `evaluate_with_defaults` (extract-default).

- [ ] **Step 4: 통과 확인** — `cargo test -p handicap-engine 2>&1; echo exit=$?` → exit=0. `cargo build --workspace --all-targets; echo exit=$?` → exit=0.

- [ ] **Step 5: 이빨 실증** — 아래 셋을 **runner와 trace에서 각각**(코드가 따로다 — 모두 여섯 번) 일부러 되돌려 RED를 보고 원복한다(보고서에 테스트 이름과 RED 출력 한 줄씩).
  1. 실행 경로의 채우기를 `if in_loop { … }`로 감싼다 → runner `us3_*`·`outside_loop_transport_failure_*` / trace `trace_us3_*`·`trace_outside_loop_transport_failure_*` RED.
  2. 막힌 경로의 채우기를 `if in_loop { … }`로 감싼다 → `outside_loop_blocked_*` / `trace_outside_loop_blocked_*` RED.
  3. `mark_written(filled.defaulted…)`를 지운다 → `default_stops_request_regen` / `trace_default_stops_request_regen` RED.

- [ ] **Step 6: 커밋** — `git add crates` → `feat(engine): 추출 기본값을 runner·trace에 배선하고 trace에 defaulted를 싣는다 (extract-default)`.

---

### Task 3: 모니터 기록 보존 + TUI 한 줄

**Files:**
- Modify: `crates/controller/src/monitor/record.rs` (테스트만 — `build_record_body` ≈ 83은 `defaulted`를 건드리지 않는다)
- Modify: `crates/tui/src/text.rs` (`blocked_by_blank` ≈ 566 옆), `crates/tui/src/inspect.rs` (`body_lines`의 에러 줄 ≈ 815 뒤)
- Test: `crates/controller/src/monitor/record.rs` 테스트 모듈, `crates/tui/tests/inspect_test.rs`, `crates/tui/src/text.rs` 테스트 모듈

**Interfaces:**
- Consumes: `StepTrace.defaulted`.
- Produces: `pub fn defaulted_names(names: &[String]) -> String` (`text.rs`) → `"기본값 사용: a, b"`.

- [ ] **Step 1: 실패하는 테스트**

```rust
// record.rs — 기존 `extracted`가 비워지는지 보는 테스트(≈520) 옆
#[test]
fn record_keeps_defaulted_names_but_clears_values() {
    // steps[0].extracted = {"orderId": "none"}, steps[0].defaulted = ["orderId"]
    let body = build_record_body(Some(t), 64);
    let s = &body.trace.as_ref().unwrap().steps[0];
    assert!(s.extracted.is_empty());
    assert_eq!(s.defaulted, vec!["orderId".to_string()]);
}

// text.rs
assert_eq!(defaulted_names(&["orderId".into(), "cursor".into()]), "기본값 사용: orderId, cursor");

// inspect_test.rs — 기존 body_lines 테스트의 입력 만들기를 따른다
// defaulted = ["orderId"] → Note 줄 "기본값 사용: orderId"가 요약 줄 뒤, 헤더 줄 앞에 정확히 1개
// defaulted 빔 → 그 줄 없음
// defaulted = ["a\u{202e}b"] → 출력 줄에 U+202E가 없다(sanitize 경유)
```

컨트롤러 저장 경로(R6) 한 건 — `crates/controller/tests/scenario_genvars_gate_test.rs`와 같은 방식으로(새 파일 `scenario_extract_default_gate_test.rs`, 테스트 이름에 `defaulted`가 아니라 `extract_default`를 넣고 Step 2·4에서 `cargo test -p handicap-controller --test scenario_extract_default_gate_test`로 따로 돌린다 — Task 1부터 통과하는 고정용 테스트다): 추출에 `default: "{{x}}"`가 든 YAML을 `POST /api/scenarios` → 400, 응답 문구에 `extract default must not contain`이 있다. `default: none`은 201.

- [ ] **Step 2: 실패 확인** — `cargo test -p handicap-tui -p handicap-controller defaulted 2>&1; echo exit=$?`.

- [ ] **Step 3: 구현** — `text::defaulted_names`. `inspect.rs`: 에러 줄(`l.wrapped(BodyLineKind::Error, e)`) 다음, `timed_out` 줄 앞에 `if !step.defaulted.is_empty() { l.wrapped(BodyLineKind::Note, &text::defaulted_names(&step.defaulted)); }` — `wrapped`가 `sanitize`를 거친다. `record.rs`는 코드 변경 없음(테스트가 "지우지 않는다"를 고정).

- [ ] **Step 4: 통과 확인** — `cargo test -p handicap-tui -p handicap-controller 2>&1; echo exit=$?` → exit=0.

- [ ] **Step 5: 커밋** — `feat(tui): 기록 보기에 기본값 사용 줄 (extract-default)`.

---

### Task 4: UI 모델·편집 칸·경고

**Files:**
- Modify: `ui/src/scenario/model.ts` (`extractDecodeFields` 51, `ExtractModel` 56–100)
- Modify: `ui/src/scenario/problems.ts` (`claim requires decode` 매핑 ≈ 88 뒤)
- Modify: `ui/src/scenario/condEmptyEval.ts` (`directBodyExtractVars` 6, `render` 17, `condWhenBodyVarsEmpty` 85), `ui/src/scenario/loopWarnings.ts:33`
- Modify: `ui/src/components/scenario/Inspector.tsx` (`DraftExtract` ≈ 670, `toExtract` 687, `ExtractEditor` 700–890)
- Modify: `ui/src/scenario/yamlDoc.ts` (`setStepExtract` ≈ 555–559 — `default` 스칼라 따옴표 강제)
- Modify: `ui/src/i18n/ko.ts`
- Test: `ui/src/scenario/__tests__/model.test.ts`, `ui/src/scenario/__tests__/problems.test.ts`(없으면 기존 problems 테스트 파일), `ui/src/scenario/__tests__/condEmptyEval.test.ts`·`loopWarnings.test.ts`(기존 파일), `ui/src/components/scenario/__tests__/Inspector.test.tsx`

**Interfaces:**
- Produces:
  - `ExtractModel` 본문·헤더·쿠키 멤버에 `default: z.string().optional()`; 규칙은 union 전체 `superRefine`에서(`path: ["default"]`, 위 영어 네 문장).
  - `export const EXTRACT_DEFAULT_MAX = 256;`
  - `export function extractDefaultIssue(s: string): "empty" | "vars" | "long" | "control" | null` (`model.ts`) — 순서: 빈 값 → `{{`/`${` → `[...s].length > 256` → 제어 문자(`/\p{Cc}/u`). superRefine과 편집 칸이 같이 쓴다.
  - `directBodyExtractVars`를 `directBodyExtractSubst(loop): Map<string, string>`으로 **바꾼다**(이름 → 못 뽑았을 때 값: 그 이름의 `default` 있는 마지막 항목의 기본값, 없으면 `""`). `condWhenBodyVarsEmpty(cond, subst: Map<string,string>)`.

- [ ] **Step 1: 실패하는 테스트**

`model.test.ts`:
```ts
const base = { var: "a", from: "body", path: "$.a" } as const;
expect(ExtractModel.safeParse({ ...base, default: "none" }).success).toBe(true);
expect(ExtractModel.safeParse({ ...base, default: "가".repeat(256) }).success).toBe(true);
for (const [bad, msg] of [
  ["", "default must not be empty"],
  ["a{{b}}", "default must not contain {{ or ${"],
  ["${X}", "default must not contain {{ or ${"],
  ["x".repeat(257), "default too long (max 256)"],
  ["a\nb", "default must not contain control characters"],
] as const) {
  const r = ExtractModel.safeParse({ ...base, default: bad });
  expect(r.success).toBe(false);
  if (!r.success) expect(r.error.issues[0]).toMatchObject({ path: ["default"], message: msg });
}
expect(ExtractModel.safeParse({ var: "s", from: "status", default: "x" }).success).toBe(false);
```
+ 실 fixture 드리프트 가드: `default: "{{x}}"`가 든 시나리오 YAML을 `parseScenarioDoc`에 넣어 결과 문구가 `ko.editor.gateExtractDefaultVars(…)`를 `toContain`(네 규칙 각각). + YAML round-trip: `default: none`이 든 YAML을 `parseScenarioDoc` → `model.steps[0].extract[0].default === "none"`(정규화가 키를 떨구지 않는다).

`condEmptyEval`/`loopWarnings` 테스트 — 먼저 기존 `condEmptyEval.test.ts`를 새 시그니처로 옮긴다: `new Set(["x"])` 31곳 → `new Map([["x", ""]])`(기대값 무변경), `directBodyExtractVars` 테스트(≈67–87)는 `directBodyExtractSubst`로 이름을 바꾸고 기대를 `Map`(값 `""`)으로. 그 뒤 새 케이스:
```ts
// while: {left: "{{status}}", op: "ne", right: "done"}, 본문 추출 status
// default 없음 → retryOnFailure === true (지금과 같다)
// default "done" → retryOnFailure === false
// default "wait" → retryOnFailure === true
// matches + default "x" → 경고 없음("unknown")
// 같은 이름 두 항목 [default "done", default 없음] → "done"으로 본다
```

`Inspector.test.tsx`(추출 섹션을 펼친 뒤, `beforeEach` localStorage clear — 기존 추출 테스트의 준비를 따른다):
```ts
// 번호는 0부터(기존 extractFromAria(idx)와 같다) — 첫 줄 = (0).
// 1. 본문 추출 줄에 getByLabelText(ko.editor.extractDefaultAria(0)) 입력이 있다. 상태 코드 줄에는 없다.
// 2. "none" 입력 → blur → store model의 extract[0].default === "none", yamlText에 "default: none".
// 3. 비우고 blur → extract[0]에 default 키가 없다, yamlText에 "default" 없음.
// 4. "{{x}}" 입력 → blur → getByRole("alert")에 ko.editor.extractDefaultErrVars,
//    useScenarioEditor.getState().yamlError === null, extract[0].default === "none"(2에서 커밋한 직전 유효 값).
//    이어서 이름 칸을 고쳐 blur → 반영된다(편집이 잠기지 않았다).
// 5. 종류를 header로 바꾸면 default 유지, status로 바꾸면 default 없음.
// 6. 입력의 maxLength === 256.
// 6b. "0x1F" 입력 → blur → yamlText에 `default: "0x1F"`(큰따옴표). "0"·"true"·"null"·"0b101"도 같다.
// 7. getByRole("button", {name: ko.editor.extractDefaultHelpAria(0)}) 클릭 → screen.getByRole("note")에
//    glossary 네 문장이 모두 보인다. 입력의 접근명은 그대로 ko.editor.extractDefaultAria(0).
```

- [ ] **Step 2: 실패 확인** — `cd ui && pnpm test model Inspector condEmptyEval loopWarnings problems; echo exit=$?`.

- [ ] **Step 3: 구현**

  - `ko.ts`: 문구 표의 키 전부.
  - `model.ts`: 필드·`extractDefaultIssue`·superRefine 분기(`e.from !== "status" && e.default !== undefined`).
  - `problems.ts`: 네 영어 문장 → 네 gate 키(기존 분기 뒤, `return seg` 앞).
  - `condEmptyEval.ts`/`loopWarnings.ts`: `Map` 치환. `render`는 `bodyVars.has(name)` 대신 `subst.get(name)`(없으면 unknown). `matches`의 "왼쪽이 `""`일 때만 정규식" 가드는 그대로 둔다.
  - `Inspector.tsx` `ExtractEditor`:
    - `DraftExtract`(본문·헤더·쿠키)에 `default?: string`(칸에 적힌 글자)과 `defaultOk?: string`(직전 유효 값). `draftFromExtract`는 둘 다 `e.default`로 시드.
    - `toExtract`: `default`가 `""`/없음 → 키 없음. `extractDefaultIssue(default) === null` → 그 값. 아니면 `defaultOk`(없으면 키 없음).
    - 입력 칸: `<Input>`(이 편집기의 다른 칸과 같은 프리미티브·같은 `yamlError` 잠금) `aria-label={ko.editor.extractDefaultAria(idx)}`(기존 `extractDecodeAria(idx)`와 같은 0부터 번호), `placeholder`, `maxLength={EXTRACT_DEFAULT_MAX}`, 풀기 선택(와 claim 칸) 뒤. onChange는 draft만, onBlur에 커밋. 커밋에서 값이 유효하면 `defaultOk`도 갱신.
    - 칸 아래 안내: 현재 draft의 `extractDefaultIssue`가 `"vars"`/`"control"`이면 `<p role="alert" className="text-xs text-red-700">`에 해당 문구(blur 뒤에만 — `touched` 플래그).
    - `HelpTip`: 입력 **형제**(라벨·입력 밖), `aria-label={ko.editor.extractDefaultHelpAria(idx)}`, 본문은 glossary 네 줄을 `<span className="block">`으로(`JsonBodyField`의 캐스트 HelpTip ≈ 515와 같은 모양).
    - `setFromKind`: 본문·헤더·쿠키 사이에서는 `default`·`defaultOk` 유지, `status`로 가면 버린다.
    - 줄은 `flex-wrap`으로 줄바꿈되게, 입력에 `min-w-0`.
  - `yamlDoc.ts` `setStepExtract`: `doc.createNode(edit.extract)`로 만든 시퀀스에서 각 항목의 `default` 값 노드를 `Scalar.QUOTE_DOUBLE`로 고정한다(`setVariableGen`의 pick_array 처리와 같은 방식). 기본값이 없는 항목의 YAML은 바이트 단위로 지금과 같아야 한다.
  - `loopLenientExtractHelp`에 문구 표의 문장을 덧붙인다.

- [ ] **Step 4: 통과 확인** — `cd ui && pnpm lint && pnpm test && pnpm build; echo exit=$?` → exit=0.

- [ ] **Step 5: 이빨 실증** — ① `toExtract`가 잘못된 값도 그대로 내보내게 바꾼다 → 테스트 4가 `yamlError !== null`로 RED → 원복. ② `yamlDoc.ts`의 `QUOTE_DOUBLE` 고정을 지운다 → 테스트 6b의 `0b101` 케이스가 RED(`yaml` 라이브러리가 스스로 따옴표를 붙이지 않는 것은 `0b101`뿐이다 — 나머지 넷은 고정을 지워도 통과한다) → 원복.

- [ ] **Step 6: 커밋** — `feat(ui): 추출 줄에 「값이 없을 때」 기본값 칸 (extract-default)`.

---

### Task 5: UI 표지 (시험 실행·모니터)

**Files:**
- Modify: `ui/src/api/schemas.ts` (`StepTraceSchema` ≈ 610)
- Modify: `ui/src/components/scenario/TestRunPanel.tsx` (칩 ≈ 72)
- Modify: `ui/src/components/monitor/CheckRecordDialog.tsx` (스텝 행 ≈ 214), `ui/src/components/monitor/PreviewResult.tsx` (≈ 201)
- Modify: `ui/src/scenario/blockedText.ts`, `ui/src/i18n/ko.ts`(Task 4에서 이미 넣었으면 생략)
- Test: `ui/src/components/scenario/__tests__/TestRunPanel.test.tsx`, `ui/src/components/monitor/__tests__/{CheckRecordDialog,PreviewResult}.test.tsx`, `ui/src/scenario/__tests__/blockedText.test.ts`(없으면 만든다)

**Interfaces:**
- Consumes: 와이어 `defaulted?: string[]`(없으면 키 생략 — `null` 아님).
- Produces: `StepTraceSchema.defaulted: z.array(z.string()).optional()`; `export function defaultedText(step: Pick<StepTrace, "defaulted">): string | null` (`blockedText.ts`) → 비었거나 없으면 `null`, 있으면 `ko.common.defaultedNames(names.join(", "))`.

- [ ] **Step 1: 실패하는 테스트**

```ts
// blockedText.test.ts
expect(defaultedText({})).toBeNull();
expect(defaultedText({ defaulted: [] })).toBeNull();
expect(defaultedText({ defaulted: ["orderId", "cursor"] })).toBe("기본값 사용: orderId, cursor");

// schemas: defaulted 키가 없는 StepTrace와 있는 StepTrace 둘 다 StepTraceSchema.parse 통과.

// TestRunPanel.test.tsx — extracted {orderId:"none", state:"WAIT"}, defaulted ["orderId"]
// orderId 칩 안에 글자 "기본값"이 있고(within(칩)), state 칩에는 없다.
// defaulted 없는 같은 trace → "기본값" 글자가 화면에 없다.

// CheckRecordDialog / PreviewResult — defaulted ["orderId"]인 스텝 행(펼친 상태)에
// "기본값 사용: orderId"가 보이고, defaulted 없는 행에는 없다. 리터럴 문자열로 단언한다(ko 함수 재호출 금지).
```

- [ ] **Step 2: 실패 확인** — `cd ui && pnpm test TestRunPanel CheckRecordDialog PreviewResult blockedText; echo exit=$?`.

- [ ] **Step 3: 구현**
  - `TestRunPanel`: 칩 `이름=값` 뒤, 같은 칩 안에 `defaulted.includes(k)`일 때 `<span className="ml-1 rounded bg-white/70 px-1 text-[10px] font-medium">기본값</span>`(`ko.common.defaultedTag`). 지금의 `chip(text, cls)` 헬퍼가 문자열만 받으면 그 칩만 인라인 JSX로 그린다.
  - `CheckRecordDialog`: 에러 문구 자리 아래에 `defaultedText(step)`가 있으면 한 줄(`text-xs text-slate-600`).
  - `PreviewResult`: `</dl>` **뒤**에 `defaultedText(s)`가 있으면 `<p className="mt-1 break-all text-xs text-slate-600">`(`<dl>` 안에 `<dt>` 없는 `<dd>`를 두지 않는다).

- [ ] **Step 4: 통과 확인** — `cd ui && pnpm lint && pnpm test && pnpm build; echo exit=$?` → exit=0.

- [ ] **Step 5: 커밋** — `feat(ui): 시험 실행·모니터 기록에 기본값 표시 (extract-default)`.

---

## 구현 뒤 (task 아님 — orchestrator)

1. **전체 리뷰** `handicap-reviewer`(와이어 1:1: 엔진 `default`/`defaulted` ↔ Zod, runner↔trace lockstep, 옛 동작에 기대던 소비자 — `blank_missing_extracts` 이름을 쓰던 곳, `directBodyExtractVars`를 쓰던 곳).
2. **보안 리뷰** `security-reviewer` 필수(요청 실행·추출 경로). 초점: 기본값 문구의 값 비노출, 실패한 로그인 뒤 기본 토큰으로 계속 가는 흐름(spec §7 판단 2), 모니터 기록의 이름 노출.
3. **라이브 검증** `/live-verify` — US 척추:

| US | 절차 | 통과 신호 |
|---|---|---|
| US1 | 응답기 `/poll`이 `orderId` 없이 응답, 추출에 `default: none`. 모니터 보드(GUI·TUI)와 부하 run 1회 | 응답기 접수 기록에 `/orders/none`, 「보내지 않음」 0건, 모니터 기록 창에 「기본값 사용: orderId」 |
| US2 | 커서를 한 회차 빼먹는 응답기 | 다음 회차 요청이 기본값 주소로 접수, 반복이 조건으로 끝남(시험 실행에 「여기서 끝났습니다」 없음) |
| US3 | 반복 밖 선택 필드 + if | 시험 실행에서 스텝 에러 없음, then 분기 |
| US4 | 서버가 `none`을 실제로 보내는 경우와 기본값 경우 나란히 | 기본값 쪽 칩에만 「기본값」, GUI 기록 창·TUI 기록 보기에 「기본값 사용」 줄이 한쪽에만 |

   극단값: 256자 기본값 + 긴 변수 이름 여러 개 — 편집 줄·칩·「기본값 사용」 줄·툴팁의 겹침·잘림을 rect로 실측(좁은 인스펙터 폭, 조건 반복 본문 안 스텝). 편집 칸은 새 시나리오(`/scenarios/new`)·저장된 시나리오(`/scenarios/{id}`)·템플릿 화면에서 각각 확인. TUI 칸 그리기는 바꾸지 않았으므로(기록 보기 한 줄만) 칸 개수별 확인은 생략하고 그 근거를 build-log에 적는다.
4. `/finish-slice` — spec §7 판단·§8 연기를 roadmap 새 §B 블록으로(번호는 `grep -n '^### B' docs/roadmap.md`), §B62 (0) 해소 표시, ADR-0056 후속 절, 릴리즈 노트 줄("기본값을 쓴 시나리오는 워커도 새 버전").
