# JSON Body 타입 캐스트 주입 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** JSON request body에서 `{{var:num}}` / `{{var:bool}}`(+선택적 `{{var:str}}`) 캐스트 토큰으로 흐름 변수 문자열을 JSON number/bool로 주입한다.

**Architecture:** 캐스트 파싱은 **JSON leaf 레벨**(`executor.rs::render_json_value`와 trace twin `render_json_collecting`)에서만 일어난다. 새 `cast.rs`가 순수 헬퍼(`parse_cast_leaf` + `coerce_num`/`coerce_bool`)를 제공하고, `template.rs`의 `render`/`render_lenient`/`render_collecting`는 **무변경**(bare 토큰만 넘겨받아 렌더). 캐스트가 없는 시나리오는 출력이 byte-identical(하위호환 불변식). UI는 `BodyModel`에 `.superRefine`을 붙여 잘못된 캐스트를 authoring 시점에 에러로 막는다.

**Tech Stack:** Rust(엔진, `serde_json`, `thiserror`, `wiremock` 테스트), TypeScript/React(`zod` 검증, `vitest`).

**참조 spec:** `docs/superpowers/specs/2026-06-03-json-typed-body-injection-design.md`

---

## ⚠️ 실행 전 필독 (repo 함정)

- **pre-commit hook은 비-`.md` 커밋마다 전체 workspace(`cargo build/clippy/test --workspace`)를 돈다 — 수 분 소요.** 각 엔진/UI 커밋은 `run_in_background`로 돌리고 완료 전 다른 `cargo` 호출을 피한다(같은 `target/` 락 경합).
- **TDD-guard(`.claude/hooks/tdd-guard.sh`)**: `crates/*/src/*.rs` 첫 Write는 워킹트리에 pending **test-path 파일**(`tests/*.rs`/`*_test.rs`/`*.test.ts`…)이 없으면 막힌다. 인라인 `#[cfg(test)]`만 추가하는 *첫* src Write는 pending으로 안 쳐진다. **대응**: 엔진 src를 새로 만드는 Task(1·3·4) 시작 시 orchestrator가 `crates/engine/tests/_tdd_keepalive.rs`에 `#[test] fn keepalive() {}`를 미리 깔아 unblock하고, **명시 경로로만 `git add`**(절대 `-A` 금지), **Task 끝나면 `rm`**(커밋 안 됨). Task 2(`json_cast.rs`)·Task 6(`cast.test.ts`)은 테스트 파일을 먼저 만드니 self-unblock(keepalive 불필요).
- **UI 게이트는 hook이 안 돌린다**: UI 커밋 전 `cd ui && pnpm lint && pnpm test && pnpm build`를 수동으로. 최종 타입 게이트는 `pnpm build`(`tsc -b`)다(`pnpm test`=esbuild는 TS strict를 일부 놓침).
- **로컬 `cargo run` 워커 재빌드**: 이 plan은 엔진 라이브러리만 바꾼다. 매뉴얼 점검 시 `cargo build -p handicap-worker` 필요(controller만 빌드하면 `target/debug/worker`가 안 갱신).

---

## File Structure

| 파일 | 책임 | 변경 |
|---|---|---|
| `crates/engine/src/cast.rs` | 순수 캐스트 헬퍼: `Cast` enum, `parse_cast_leaf`, `coerce_num`, `coerce_bool` + 인라인 테스트 | **Create** (Task 1) |
| `crates/engine/src/lib.rs` | 모듈 등록 `mod cast;` | Modify (Task 1) |
| `crates/engine/tests/json_cast.rs` | wiremock 통합 — number/bool이 와이어로 전송되는지 | **Create** (Task 2) |
| `crates/engine/src/error.rs` | `EngineError::CastFailed` 변형 추가 | Modify (Task 3) |
| `crates/engine/src/executor.rs` | `render_json_value`(strict)에 캐스트 배선 + 인라인 테스트 | Modify (Task 3) |
| `crates/engine/src/executor.rs` | `render_json_collecting`(trace twin, lenient)에 캐스트 배선 + 인라인 테스트 | Modify (Task 4) |
| `ui/src/scenario/cast.ts` | `jsonBodyCastErrors` 순수 검증 함수 | **Create** (Task 6) |
| `ui/src/scenario/model.ts` | `BodyModel`에 `.superRefine` 배선 | Modify (Task 6) |
| `ui/src/scenario/__tests__/cast.test.ts` | 검증 함수 + 모델 통합 테스트 | **Create** (Task 6) |
| docs(ADR·CLAUDE.md·roadmap·spec status) | 결정 기록·함정·로드맵 close | Modify (Task 7) |

**무변경(불변식)**: `template.rs`, proto, controller, worker, migration, `Body::Json` 모델, `execute_step`/`execute_step_traced` 본문(이들은 바뀐 render 함수만 호출).

---

## Task 1: 엔진 — 캐스트 헬퍼 모듈 `cast.rs`

**Files:**
- Create: `crates/engine/src/cast.rs`
- Modify: `crates/engine/src/lib.rs:1` (모듈 등록)
- Keepalive: `crates/engine/tests/_tdd_keepalive.rs` (Task 시작 시 생성, 끝나면 rm)

- [ ] **Step 0: TDD-guard keepalive 설치 (orchestrator)**

```bash
printf '#[test]\nfn keepalive() {}\n' > crates/engine/tests/_tdd_keepalive.rs
```

- [ ] **Step 1: `cast.rs`를 인라인 실패 테스트 + 스텁으로 작성**

`crates/engine/src/cast.rs`:

```rust
//! JSON body 타입 캐스트(`{{var:num}}` / `{{var:bool}}` / `{{var:str}}`) 순수 헬퍼.
//! 캐스트는 JSON 문자열 leaf가 **순수 단일 flow 토큰**일 때만 의미를 가진다
//! (executor.rs::render_json_value / render_json_collecting 에서 호출).
//! 이 모듈은 변수를 렌더하지 않는다 — bare 토큰 문자열을 만들어 주고, 렌더된
//! 결과 문자열의 coerce만 담당한다.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Cast {
    Str,
    Num,
    Bool,
}

/// `s`(trim 후)가 정확히 하나의 flow 토큰 `{{ inner }}`이고 inner가 trailing
/// `:num`/`:bool`/`:str` 캐스트로 끝나면 `(bare_token, cast)`를 반환. 그 외 `None`.
/// `bare_token`은 캐스트 접미사를 뗀 `{{name}}` 형태로, 호출부가 기존 `render`에
/// 그대로 넘길 수 있다.
///
/// - `${env}` 토큰·혼합 문자열·캐스트 없는 토큰·미지원 keyword(`:int` 등)는 `None`
///   → 호출부가 일반 문자열 경로로 처리한다(미지원 keyword는 결국 `UnknownVar`).
pub(crate) fn parse_cast_leaf(s: &str) -> Option<(String, Cast)> {
    let t = s.trim();
    let inner = t.strip_prefix("{{")?.strip_suffix("}}")?;
    // 단일 토큰만: 내부에 또 다른 brace 페어가 있으면 거부.
    if inner.contains("{{") || inner.contains("}}") {
        return None;
    }
    let (name, kw) = inner.rsplit_once(':')?; // 콜론 없으면 캐스트 아님
    let cast = match kw.trim() {
        "str" => Cast::Str,
        "num" => Cast::Num,
        "bool" => Cast::Bool,
        _ => return None, // 미지원 keyword → 캐스트 아님
    };
    let bare = ["{{", name.trim(), "}}"].concat();
    Some((bare, cast))
}

/// 렌더된 문자열을 JSON 숫자로 coerce. JSON number 문법만 통과(leading-zero·
/// `"true"`·`"abc"`·빈 문자열 실패; 앞뒤 공백은 허용). 실패 시 `None`.
pub(crate) fn coerce_num(v: &str) -> Option<serde_json::Value> {
    match serde_json::from_str::<serde_json::Value>(v) {
        Ok(val @ serde_json::Value::Number(_)) => Some(val),
        _ => None,
    }
}

/// 렌더된 문자열을 불리언으로 coerce. 정확히 `"true"`/`"false"`만. 실패 시 `None`.
pub(crate) fn coerce_bool(v: &str) -> Option<serde_json::Value> {
    match v {
        "true" => Some(serde_json::Value::Bool(true)),
        "false" => Some(serde_json::Value::Bool(false)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_pure_num_bool_str() {
        assert_eq!(parse_cast_leaf("{{age:num}}"), Some(("{{age}}".into(), Cast::Num)));
        assert_eq!(parse_cast_leaf("{{ok:bool}}"), Some(("{{ok}}".into(), Cast::Bool)));
        assert_eq!(parse_cast_leaf("{{zip:str}}"), Some(("{{zip}}".into(), Cast::Str)));
    }

    #[test]
    fn parse_trims_and_keeps_name() {
        // 토큰 앞뒤 공백 + 내부 공백 모두 정규화되어 bare는 깔끔한 {{name}}.
        assert_eq!(parse_cast_leaf("  {{ age : num }}  "), Some(("{{age}}".into(), Cast::Num)));
    }

    #[test]
    fn parse_rejects_non_cast() {
        assert_eq!(parse_cast_leaf("{{name}}"), None); // 캐스트 없음
        assert_eq!(parse_cast_leaf("{{age:int}}"), None); // 미지원 keyword
        assert_eq!(parse_cast_leaf("x {{age:num}} y"), None); // 혼합(순수 토큰 아님)
        assert_eq!(parse_cast_leaf("{{a}}{{b:num}}"), None); // 다중 토큰
        assert_eq!(parse_cast_leaf("${X:num}"), None); // env 토큰
        assert_eq!(parse_cast_leaf("literal"), None);
    }

    #[test]
    fn coerce_num_accepts_int_float_signed_exp() {
        assert_eq!(coerce_num("30"), Some(json!(30)));
        assert_eq!(coerce_num("9.5"), Some(json!(9.5)));
        assert_eq!(coerce_num("-5"), Some(json!(-5)));
        assert_eq!(coerce_num("1e3"), Some(json!(1000.0)));
        assert_eq!(coerce_num(" 30 "), Some(json!(30))); // 앞뒤 공백 허용
    }

    #[test]
    fn coerce_num_rejects_non_number() {
        assert_eq!(coerce_num("abc"), None);
        assert_eq!(coerce_num("01234"), None); // leading-zero = JSON 위반
        assert_eq!(coerce_num(""), None);
        assert_eq!(coerce_num("true"), None); // bool은 숫자 아님
        assert_eq!(coerce_num("30 40"), None); // 추가 토큰
    }

    #[test]
    fn coerce_bool_exact_only() {
        assert_eq!(coerce_bool("true"), Some(json!(true)));
        assert_eq!(coerce_bool("false"), Some(json!(false)));
        assert_eq!(coerce_bool("True"), None);
        assert_eq!(coerce_bool("1"), None);
        assert_eq!(coerce_bool(""), None);
    }
}
```

위 스텁은 이미 완성 코드라 곧장 통과한다. **TDD를 엄격히 지키려면** Step 1에서 본문을 `todo!()`로 비우고(시그니처만), Step 2에서 실패 확인 후 Step 3에서 위 본문을 채운다. 둘 중 택1.

- [ ] **Step 2: 모듈 등록 — `crates/engine/src/lib.rs`**

`pub mod aggregator;` 줄(1행) **위 또는 아래**에 알파벳 순으로:

```rust
mod cast;
```

(헬퍼는 `pub(crate)`라 외부 노출 불필요 → `pub mod` 아님.)

- [ ] **Step 3: 테스트 실행 — 통과 확인**

Run: `cargo test -p handicap-engine cast::tests`
Expected: PASS (6 tests)

- [ ] **Step 4: keepalive 제거 + 커밋**

```bash
rm crates/engine/tests/_tdd_keepalive.rs
git add crates/engine/src/cast.rs crates/engine/src/lib.rs
git commit -m "feat(engine): cast helper — parse_cast_leaf + coerce_num/bool"
```
(커밋은 `run_in_background`로; pre-commit이 전체 workspace 빌드.)

---

## Task 2: 엔진 — wiremock 통합 테스트 (number/bool이 와이어로 전송)

이 테스트는 Task 3가 끝나야 **PASS**한다(현재는 `render_json_value`가 문자열만 보내 FAIL). TDD의 "상위 레벨 실패 테스트를 먼저"에 해당 — 먼저 작성해 RED를 본 뒤 Task 3에서 GREEN으로 만든다.

**Files:**
- Create: `crates/engine/tests/json_cast.rs`

- [ ] **Step 1: 통합 테스트 작성**

`crates/engine/tests/json_cast.rs`:

```rust
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use handicap_engine::{MetricFlush, RunPlan, Scenario, run_scenario};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use wiremock::matchers::{body_json, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

/// `{{age:num}}` / `{{vip:bool}}`가 JSON **number/bool**로 타겟에 도달하는지.
/// wiremock Mock이 `body_json`으로 정확한 타입의 본문만 200으로 매칭하므로,
/// 엔진이 문자열("30"/"true")을 보내면 매칭 실패 → wiremock 404 → assert 실패 →
/// error_count > 0. 하니스는 `crates/engine/tests/multi_step.rs`와 동일 형태
/// (bounded 채널이라 run_scenario를 spawn하고 rx를 동시 drain — await-후-drain은
/// 데드락).
#[tokio::test]
async fn casts_send_json_number_and_bool() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/order"))
        .and(body_json(serde_json::json!({ "age": 30, "vip": true })))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;

    let yaml = format!(
        r#"
version: 1
name: cast-flow
variables:
  base: "{}"
  age: "30"
  vip: "true"
steps:
  - id: "01HX0000000000000000000001"
    name: order
    type: http
    request:
      method: POST
      url: "{{{{base}}}}/order"
      body:
        json:
          age: "{{{{age:num}}}}"
          vip: "{{{{vip:bool}}}}"
    assert:
      - status: 200
"#,
        server.uri()
    );

    let scenario = Arc::new(Scenario::from_yaml(&yaml).expect("parses"));
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(64);
    let plan = RunPlan {
        vus: 1,
        ramp_up: Duration::from_secs(0),
        duration: Duration::from_secs(1),
        env: BTreeMap::new(),
        loop_breakdown_cap: 0,
        vu_offset: 0,
        data_binding: None,
    };
    let cancel = CancellationToken::new();
    let cancel_clone = cancel.clone();
    let run = tokio::spawn(async move {
        run_scenario(scenario, plan, tx, cancel_clone)
            .await
            .expect("runs");
    });

    let mut total: u64 = 0;
    let mut errors: u64 = 0;
    while let Some(flush) = rx.recv().await {
        for w in flush.windows {
            total += w.count;
            errors += w.error_count;
        }
    }
    run.await.expect("join");

    assert!(total > 0, "no requests recorded");
    assert_eq!(errors, 0, "casted body did not match (sent as string?)");
}
```

> **하니스 출처**: 위 `RunPlan` 7필드·`run_scenario(Arc<Scenario>, plan, tx, cancel)` 4인자·`Scenario::from_yaml`·spawn-and-drain 패턴은 `crates/engine/tests/multi_step.rs`(2026-06-03 현행)와 1:1 대조해 확정됨. 만약 그 사이 시그니처가 바뀌었으면 multi_step.rs의 현행 호출을 그대로 복사하고 wiremock `body_json` 매칭·`age:num`/`vip:bool` YAML만 유지한다.

- [ ] **Step 2: 실행 — 현재 FAIL 확인 (RED)**

Run: `cargo test -p handicap-engine --test json_cast`
Expected: FAIL — `errors == 0` 단언 실패(또는 `total == 0`), 엔진이 `"30"`/`"true"` 문자열을 보내 `body_json`이 안 맞음.

- [ ] **Step 3: 커밋 (RED 테스트 고정)**

```bash
git add crates/engine/tests/json_cast.rs
git commit -m "test(engine): RED — json cast sends number/bool over the wire"
```
(다음 Task 3가 GREEN으로 만든다. RED 커밋은 진행 상태를 git에 남긴다.)

---

## Task 3: 엔진 — `render_json_value`(strict)에 캐스트 배선 + `CastFailed`

**Files:**
- Modify: `crates/engine/src/error.rs:21` (`Aborted` 위에 변형 추가)
- Modify: `crates/engine/src/executor.rs:44-68` (`render_json_value`) + 상단 `use`
- Modify: `crates/engine/src/executor.rs` 인라인 `mod tests` (테스트 추가)

- [ ] **Step 1: 인라인 실패 테스트 작성 — `executor.rs` `mod tests`**

`crates/engine/src/executor.rs`의 기존 `#[cfg(test)] mod tests` 안에 추가(기존 `render_json_value_recurses_objects_and_arrays_preserving_types` 옆). 헬퍼 `ctx`/`vars` 구성은 같은 모듈의 기존 테스트 패턴을 따른다:

```rust
#[test]
fn json_cast_num_and_bool_coerce() {
    let vars: BTreeMap<String, String> =
        [("age".into(), "30".into()), ("vip".into(), "true".into())]
            .into_iter()
            .collect();
    let env = BTreeMap::new();
    let ctx = TemplateContext { vars: &vars, env: &env, vu_id: 0, iter_id: 0, loop_index: None };
    let input = serde_json::json!({ "age": "{{age:num}}", "vip": "{{vip:bool}}" });
    let out = render_json_value(&input, &ctx).unwrap();
    assert_eq!(out, serde_json::json!({ "age": 30, "vip": true }));
}

#[test]
fn json_cast_str_and_no_cast_stay_string() {
    let vars: BTreeMap<String, String> =
        [("zip".into(), "01234".into()), ("name".into(), "Lee".into())]
            .into_iter()
            .collect();
    let env = BTreeMap::new();
    let ctx = TemplateContext { vars: &vars, env: &env, vu_id: 0, iter_id: 0, loop_index: None };
    let input = serde_json::json!({ "zip": "{{zip:str}}", "name": "{{name}}" });
    let out = render_json_value(&input, &ctx).unwrap();
    assert_eq!(out, serde_json::json!({ "zip": "01234", "name": "Lee" }));
}

#[test]
fn json_cast_failure_errors_strict() {
    let vars: BTreeMap<String, String> = [("age".into(), "abc".into())].into_iter().collect();
    let env = BTreeMap::new();
    let ctx = TemplateContext { vars: &vars, env: &env, vu_id: 0, iter_id: 0, loop_index: None };
    let input = serde_json::json!({ "age": "{{age:num}}" });
    assert!(matches!(render_json_value(&input, &ctx), Err(EngineError::CastFailed { .. })));
}

#[test]
fn json_cast_leading_zero_to_num_fails() {
    let vars: BTreeMap<String, String> = [("zip".into(), "01234".into())].into_iter().collect();
    let env = BTreeMap::new();
    let ctx = TemplateContext { vars: &vars, env: &env, vu_id: 0, iter_id: 0, loop_index: None };
    let input = serde_json::json!({ "zip": "{{zip:num}}" });
    assert!(matches!(render_json_value(&input, &ctx), Err(EngineError::CastFailed { .. })));
}

#[test]
fn json_mixed_leaf_cast_is_unknown_var() {
    // 혼합 leaf는 캐스트 미발동 → 일반 문자열 경로 → render가 "age:num" 변수를 못 찾음.
    let vars = BTreeMap::new();
    let env = BTreeMap::new();
    let ctx = TemplateContext { vars: &vars, env: &env, vu_id: 0, iter_id: 0, loop_index: None };
    let input = serde_json::json!({ "msg": "no {{age:num}} here" });
    assert!(matches!(render_json_value(&input, &ctx), Err(EngineError::UnknownVar(_))));
}

#[test]
fn json_without_casts_is_byte_identical() {
    // 하위호환 불변식: 캐스트 토큰이 없으면 8a 동작 그대로(문자열 leaf 치환, 타입 보존).
    let vars: BTreeMap<String, String> = [("n".into(), "Lee".into())].into_iter().collect();
    let env = BTreeMap::new();
    let ctx = TemplateContext { vars: &vars, env: &env, vu_id: 0, iter_id: 0, loop_index: None };
    let input = serde_json::json!({ "s": "hi {{n}}", "k": 7, "b": false, "z": null });
    let out = render_json_value(&input, &ctx).unwrap();
    assert_eq!(out, serde_json::json!({ "s": "hi Lee", "k": 7, "b": false, "z": null }));
}

#[test]
fn json_cast_str_on_missing_var_still_errors_strict() {
    // :str도 bare 토큰을 strict render → 미바인딩이면 coerce 전에 UnknownVar.
    let vars = BTreeMap::new();
    let env = BTreeMap::new();
    let ctx = TemplateContext { vars: &vars, env: &env, vu_id: 0, iter_id: 0, loop_index: None };
    let input = serde_json::json!({ "zip": "{{zip:str}}" });
    assert!(matches!(render_json_value(&input, &ctx), Err(EngineError::UnknownVar(_))));
}
```

- [ ] **Step 2: 실행 — FAIL 확인**

Run: `cargo test -p handicap-engine json_cast`
Expected: 컴파일 에러(`EngineError::CastFailed` 미정의) 또는 단언 실패.

- [ ] **Step 3: `EngineError::CastFailed` 추가 — `crates/engine/src/error.rs`**

`Aborted` 변형 바로 위에:

```rust
    #[error("template: cannot cast {var} value {value:?} to {cast}")]
    CastFailed {
        var: String,
        cast: &'static str,
        value: String,
    },
```

- [ ] **Step 4: `render_json_value` 캐스트 배선 — `crates/engine/src/executor.rs`**

상단 `use`에 추가(기존 `use crate::error::{EngineError, Result};` 인접):

```rust
use crate::cast::{Cast, coerce_bool, coerce_num, parse_cast_leaf};
```

`render_json_value`(현재 44-68행)의 `Value::String(s) => Value::String(render(s, ctx)?),` arm을 교체:

```rust
        Value::String(s) => match parse_cast_leaf(s) {
            // :str 캐스트 = bare 토큰을 문자열로(접미사만 제거). 캐스트 없음/미지원
            // keyword/혼합/env는 parse_cast_leaf가 None → 원문 s를 그대로 렌더.
            Some((bare, Cast::Str)) => Value::String(render(&bare, ctx)?),
            Some((bare, Cast::Num)) => {
                let r = render(&bare, ctx)?; // strict: 미바인딩이면 여기서 UnknownVar
                coerce_num(&r).ok_or(EngineError::CastFailed {
                    var: bare,
                    cast: "num",
                    value: r,
                })?
            }
            Some((bare, Cast::Bool)) => {
                let r = render(&bare, ctx)?;
                coerce_bool(&r).ok_or(EngineError::CastFailed {
                    var: bare,
                    cast: "bool",
                    value: r,
                })?
            }
            None => Value::String(render(s, ctx)?),
        },
```

(주의: `coerce_num(&r)`가 `&r`를 빌리고 즉시 끝난 뒤 `ok_or`가 `r`/`bare`를 move하므로 borrow 충돌 없음. `ok_or` 사용 — `value`/`var`는 lazy 계산이 아니라 단순 move라 `ok_or_else` 불필요.)

- [ ] **Step 5: 실행 — 인라인 + 통합(Task 2) 통과 확인**

Run: `cargo test -p handicap-engine`
Expected: 새 인라인 6 테스트 + `casts_send_json_number_and_bool`(Task 2) 모두 PASS, 기존 전부 GREEN.

- [ ] **Step 6: 커밋**

```bash
git add crates/engine/src/error.rs crates/engine/src/executor.rs
git commit -m "feat(engine): cast JSON body leaves to number/bool (strict, render_json_value)"
```
(`run_in_background`.)

---

## Task 4: 엔진 — `render_json_collecting`(trace twin, lenient)에 캐스트 배선

부하 경로(`CastFailed`로 실패) vs trace 경로(문자열로 표시하고 진행)의 **의도된 차이**. trace는 절대 Err를 내지 않으므로 coerce 실패 시 렌더된 문자열을 그대로 유지한다.

**Files:**
- Modify: `crates/engine/src/executor.rs:203-226` (`render_json_collecting`)
- Modify: `crates/engine/src/executor.rs` 인라인 `mod tests`

- [ ] **Step 1: 인라인 실패 테스트 작성 — `executor.rs` `mod tests`**

```rust
#[test]
fn trace_json_cast_coerces_and_keeps_string_on_failure() {
    let vars: BTreeMap<String, String> =
        [("age".into(), "30".into()), ("bad".into(), "abc".into())]
            .into_iter()
            .collect();
    let env = BTreeMap::new();
    let ctx = TemplateContext { vars: &vars, env: &env, vu_id: 0, iter_id: 0, loop_index: None };
    let input = serde_json::json!({ "age": "{{age:num}}", "bad": "{{bad:num}}" });
    let mut unbound = Vec::new();
    let out = render_json_collecting(&input, &ctx, &mut unbound);
    // 성공한 캐스트는 number, 실패한 캐스트는 렌더된 문자열 유지(Err 없음).
    assert_eq!(out, serde_json::json!({ "age": 30, "bad": "abc" }));
}
```

- [ ] **Step 2: 실행 — FAIL 확인**

Run: `cargo test -p handicap-engine trace_json_cast`
Expected: FAIL — 현재 `render_json_collecting`은 `"age"`를 문자열 `"30"`으로 둠.

- [ ] **Step 3: `render_json_collecting` 캐스트 배선 — `crates/engine/src/executor.rs`**

`render_json_collecting`(현재 203-226행)의 `Value::String(s) => Value::String(render_collecting(s, ctx, unbound)),` arm을 교체:

```rust
        Value::String(s) => match parse_cast_leaf(s) {
            Some((bare, Cast::Str)) => Value::String(render_collecting(&bare, ctx, unbound)),
            Some((bare, Cast::Num)) => {
                let r = render_collecting(&bare, ctx, unbound);
                coerce_num(&r).unwrap_or(Value::String(r)) // best-effort: 실패 시 문자열
            }
            Some((bare, Cast::Bool)) => {
                let r = render_collecting(&bare, ctx, unbound);
                coerce_bool(&r).unwrap_or(Value::String(r))
            }
            None => Value::String(render_collecting(s, ctx, unbound)),
        },
```

- [ ] **Step 4: 실행 — 통과 확인**

Run: `cargo test -p handicap-engine`
Expected: 새 trace 테스트 + 전체 GREEN.

- [ ] **Step 5: 커밋**

```bash
git add crates/engine/src/executor.rs
git commit -m "feat(engine): trace twin coerces JSON casts best-effort (render_json_collecting)"
```
(`run_in_background`.)

---

## Task 5: 엔진 — 전체 게이트 확인 (clippy/fmt/workspace)

**Files:** 없음(검증만).

- [ ] **Step 1: fmt + clippy + 전체 테스트**

```bash
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```
Expected: 모두 통과. clippy 경고 0. (특히 `assign_op_pattern`/`expect_fun_call` 같은 회귀 없음 — 신규 코드는 `ok_or`/`match` 위주라 안전.)

- [ ] **Step 2: 위반 시 수정 후 재실행**

clippy가 `cast.rs`/`executor.rs`에서 무언가 지적하면(예: `match` 단순화 제안) 수정하고 해당 Task 커밋에 `--amend` 또는 별도 `fix:` 커밋. 게이트가 green일 때만 다음 Task로.

---

## Task 6: UI — `jsonBodyCastErrors` 검증 + `BodyModel.superRefine`

**Files:**
- Create: `ui/src/scenario/cast.ts`
- Create: `ui/src/scenario/__tests__/cast.test.ts`
- Modify: `ui/src/scenario/model.ts:8-13` (`BodyModel`)

> 사전: `cd ui && pnpm install`(워크트리 새로 만들었으면 node_modules 없음).

- [ ] **Step 1: 검증 함수 실패 테스트 작성 — `ui/src/scenario/__tests__/cast.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { jsonBodyCastErrors } from "../cast";
import { ScenarioModel } from "../model";

describe("jsonBodyCastErrors", () => {
  it("accepts valid pure casts and cast-less tokens", () => {
    const body = { age: "{{age:num}}", ok: "{{vip:bool}}", zip: "{{zip:str}}", name: "{{name}}", lit: "hello", n: 7 };
    expect(jsonBodyCastErrors(body)).toEqual([]);
  });

  it("flags an unknown cast keyword", () => {
    const errs = jsonBodyCastErrors({ age: "{{age:int}}" });
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("unknown cast ':int'");
  });

  it("flags a cast inside a non-standalone leaf", () => {
    const errs = jsonBodyCastErrors({ msg: "age is {{age:num}}!" });
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("standalone");
  });

  it("flags an env/system token cast (flow-only in v1)", () => {
    const errs = jsonBodyCastErrors({ n: "${COUNT:num}" });
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("env/system token cast not supported");
  });

  it("does not flag the env default operator :-", () => {
    expect(jsonBodyCastErrors({ host: "${HOST:-num}" })).toEqual([]);
  });

  it("recurses arrays and nested objects", () => {
    const errs = jsonBodyCastErrors({ items: [{ q: "{{q:int}}" }] });
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("unknown cast ':int'");
  });
});

describe("ScenarioModel cast validation", () => {
  const base = (body: unknown) => ({
    version: 1,
    name: "s",
    steps: [
      {
        id: "01HX0000000000000000000001",
        name: "post",
        type: "http",
        request: { method: "POST", url: "/x", body: { kind: "json", value: body } },
      },
    ],
  });

  it("rejects a scenario with an unknown cast", () => {
    const r = ScenarioModel.safeParse(base({ age: "{{age:int}}" }));
    expect(r.success).toBe(false);
  });

  it("accepts a scenario with valid casts", () => {
    const r = ScenarioModel.safeParse(base({ age: "{{age:num}}", ok: "{{v:bool}}" }));
    expect(r.success).toBe(true);
  });
});
```

- [ ] **Step 2: 실행 — FAIL 확인**

Run: `cd ui && pnpm test -- cast`
Expected: FAIL — `../cast` 모듈 없음.

- [ ] **Step 3: 검증 함수 작성 — `ui/src/scenario/cast.ts`**

```ts
/**
 * JSON request body의 캐스트 토큰 검증 (엔진: executor.rs / cast.rs와 짝).
 * v1은 STANDALONE JSON 문자열 leaf의 `{{var:num}}`/`{{var:bool}}`(+선택 `:str`)만
 * 지원한다. 반환 배열이 비면 valid. 캐스트 없는 토큰·리터럴은 절대 flag하지 않는다.
 */
const CAST_KEYWORDS: readonly string[] = ["str", "num", "bool"];

const FLOW_TOKEN = /\{\{\s*([^{}]*?)\s*\}\}/g;
const ENV_TOKEN = /\$\{([^}]*)\}/g;
const PURE_FLOW = /^\{\{\s*([^{}]*?)\s*\}\}$/;

export function jsonBodyCastErrors(value: unknown): string[] {
  const errors: string[] = [];
  walk(value, errors);
  return errors;
}

function walk(v: unknown, errors: string[]): void {
  if (typeof v === "string") checkLeaf(v, errors);
  else if (Array.isArray(v)) for (const item of v) walk(item, errors);
  else if (v !== null && typeof v === "object")
    for (const val of Object.values(v as Record<string, unknown>)) walk(val, errors);
}

function checkLeaf(s: string, errors: string[]): void {
  const pure = PURE_FLOW.exec(s.trim());
  const pureInner = pure ? pure[1] : null;

  let m: RegExpExecArray | null;
  FLOW_TOKEN.lastIndex = 0;
  while ((m = FLOW_TOKEN.exec(s)) !== null) {
    const inner = m[1];
    const cast = trailingCast(inner);
    if (cast === null) continue; // 캐스트 시도 아님
    if (!CAST_KEYWORDS.includes(cast)) {
      errors.push(`unknown cast ':${cast}' in {{${inner}}} — use :num, :bool, or :str`);
    } else if (pureInner !== inner) {
      errors.push(`cast ':${cast}' only applies to a standalone value, not inside "${s}"`);
    }
  }

  ENV_TOKEN.lastIndex = 0;
  while ((m = ENV_TOKEN.exec(s)) !== null) {
    const cast = trailingCast(m[1]);
    if (cast !== null && CAST_KEYWORDS.includes(cast)) {
      errors.push(`env/system token cast not supported yet — flow {{var}} only (in \${${m[1]}})`);
    }
  }
}

/** 토큰 inner의 trailing `:word` 캐스트 keyword, 없으면 null. env 기본값 연산자
 *  `:-default`는 제외(캐스트 콜론은 바로 뒤에 글자, `:-`는 아님). */
function trailingCast(inner: string): string | null {
  const m = /(?:^|[^-]):([A-Za-z][A-Za-z0-9]*)$/.exec(inner);
  return m ? m[1] : null;
}
```

- [ ] **Step 4: `BodyModel`에 `.superRefine` 배선 — `ui/src/scenario/model.ts`**

상단 import 추가(`import { z } from "zod";` 아래):

```ts
import { jsonBodyCastErrors } from "./cast";
```

`BodyModel`(8-12행)을 교체:

```ts
export const BodyModel = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("json"), value: z.unknown() }).strict(),
    z.object({ kind: z.literal("form"), value: z.record(z.string(), z.string()) }).strict(),
    z.object({ kind: z.literal("raw"), value: z.string() }).strict(),
  ])
  .superRefine((body, ctx) => {
    if (body.kind !== "json") return;
    for (const msg of jsonBodyCastErrors(body.value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: msg, path: ["value"] });
    }
  });
export type Body = z.infer<typeof BodyModel>;
```

(`type Body`는 ZodEffects의 infer라 union 타입 그대로 — 변경 없음. `RequestModel.body: BodyModel.optional()`도 그대로 동작.)

> **검증 발동 경로(중요)**: 이 `.superRefine`은 별도 검증기가 아니라 **`ScenarioModel.safeParse`** 안에서 돈다. UI는 `parseScenarioDoc`(`yamlDoc.ts:69`)가 `normalizeForModel`로 `body:{json:…}`을 `{kind:"json", value:…}`로 정규화(`normalizeBody`, `yamlDoc.ts:483` — `value`는 verbatim 통과라 캐스트 토큰 보존)한 뒤 모델을 파싱한다. 따라서 잘못된 캐스트는 **Monaco 입력 즉시가 아니라 YAML↔모델 sync 시점**에 inline 에러로 표시된다. (Monaco-time 검증을 기대하지 말 것.)

- [ ] **Step 5: 실행 — 통과 확인**

Run: `cd ui && pnpm test -- cast`
Expected: PASS (검증 함수 6 + 모델 2).

- [ ] **Step 6: UI 전체 게이트**

Run: `cd ui && pnpm lint && pnpm test && pnpm build`
Expected: 모두 통과. 특히 `pnpm build`(`tsc -b`)가 `BodyModel`→`Body` infer·`BodyModel.optional()` 소비처에서 타입 회귀를 안 냄(ZodEffects가 union infer를 보존). lint `--max-warnings=0`.

- [ ] **Step 7: 커밋**

```bash
git add ui/src/scenario/cast.ts ui/src/scenario/__tests__/cast.test.ts ui/src/scenario/model.ts
git commit -m "feat(ui): validate JSON body casts (Zod superRefine + jsonBodyCastErrors)"
```
(cargo hook도 돌지만 UI 게이트는 Step 6에서 이미 수동 통과.)

---

## Task 7: 문서 — ADR · CLAUDE.md · roadmap · spec status

**Files:**
- Create: `docs/adr/0029-json-body-type-cast-injection.md` (다음 번호 — **0028은 run-level SLO criteria가 선점**, 현행 최대 0028)
- Modify: `CLAUDE.md` ("알아둘 결정들" + 상태 줄)
- Modify: `crates/engine/CLAUDE.md` (템플릿팅 함정 섹션)
- Modify: `ui/CLAUDE.md` (Zod 검증 함정)
- Modify: `docs/roadmap.md` ("JSON 숫자 주입" 항목 close)
- Modify: `docs/superpowers/specs/2026-06-03-json-typed-body-injection-design.md` (상태 → 구현 완료)

- [ ] **Step 1: ADR 작성 — `docs/adr/0029-json-body-type-cast-injection.md`** (MADR 포맷)

```markdown
# 0029. JSON Body 타입 캐스트 주입 (`{{var:num}}`/`{{var:bool}}`)

- 상태: 채택
- 날짜: 2026-06-03

## 맥락

Slice 8a부터 JSON body 문자열 leaf가 템플릿팅되지만 값은 항상 문자열로 나갔다
(`{"age":"{{age}}"}` → `{"age":"30"}`). 흐름 변수가 전부 `String`이라 타겟이
number/bool을 기대하면 표현 불가.

## 결정

flow `{{var}}` 토큰에 명시적 캐스트 접미사(`:num`/`:bool`, 선택적 `:str`)를 두고,
JSON 문자열 leaf가 **순수 단일 토큰일 때만** number/bool로 coerce. 파싱은 JSON leaf
레벨(`executor.rs::render_json_value` + trace twin)에서, `template.rs`는 무변경.
coerce 실패는 엄격 실패(`EngineError::CastFailed`). UI는 Zod `.superRefine`으로
잘못된 캐스트를 authoring 시점에 거부.

거절: ① 자동 형변환(leading-zero·"true" 의도치 않은 변환, 하위호환 깨짐),
② raw-text 템플릿(escape 책임 전가·JSON 주입 위험).

## 범위

v1 = flow `{{}}` + `:num`/`:bool`(+`:str`) + JSON body 한정. 연기: `:json`/변수 기반
null·`${env}`/시스템 토큰 캐스트·nullable 규칙·form/raw/URL 캐스트.

## 결과

proto/controller/worker/migration/`Body::Json` 모델 무변경. 캐스트 없으면 출력
byte-identical(하위호환). 데이터바인딩(8c)과 직교 — 데이터셋 값은 여전히 문자열로
바인딩되고 캐스트가 JSON leaf에서 coerce.
```

- [ ] **Step 2: 루트 `CLAUDE.md` 갱신**

"알아둘 결정들" 목록에 한 줄:

```markdown
- **0029** JSON body 타입 캐스트: flow `{{var:num}}`/`{{var:bool}}`(+`:str`) — 순수 단일 토큰 leaf만 coerce, leaf 레벨 파싱(template.rs 무변경), 엄격 실패, UI Zod 검증. `:json`/null·env 캐스트 연기
```

그리고 최상단 **상태** 단락에 한 문장 추가(현재 Slice 9 완결 문구 뒤): JSON body 타입 캐스트 주입(post-MVP1) 구현 완료.

- [ ] **Step 3: `crates/engine/CLAUDE.md` 함정 추가**

"HTTP 실행 / extract / 템플릿팅" 섹션의 Slice 8a 항목 뒤에:

```markdown
- **JSON 타입 캐스트 `{{var:num}}`/`{{var:bool}}`** (0029): `executor.rs`가 JSON 문자열 leaf가 **순수 단일 flow 토큰 + trailing `:num`/`:bool`/`:str`**일 때만 `cast.rs::parse_cast_leaf`로 캐스트를 떼고, bare 토큰을 기존 `render`로 렌더한 뒤 `coerce_num`/`coerce_bool`. **`template.rs`는 무변경**(캐스트는 leaf 레벨). 부하 경로(`render_json_value`, strict)는 coerce 실패 시 `EngineError::CastFailed`; trace twin(`render_json_collecting`, lenient)은 문자열로 best-effort 유지(Err 없음) — **둘을 lockstep**으로. 캐스트 없으면 byte-identical. 혼합 leaf(`"x {{a:num}} y"`)·env 토큰·미지원 keyword는 `parse_cast_leaf`가 `None` → 일반 문자열 경로(혼합 시 `render`가 `a:num` 변수를 못 찾아 `UnknownVar`). leading-zero `{{zip:num}}`("01234")는 JSON number 위반이라 의도적 실패(ZIP은 `:str`).
```

- [ ] **Step 4: `ui/CLAUDE.md` 함정 추가**

"빌드·타입 게이트" 또는 새 줄로:

```markdown
- **`BodyModel.superRefine`로 JSON 캐스트 검증** (0029): `cast.ts::jsonBodyCastErrors`가 json body value를 재귀 walk하며 미지원 캐스트 keyword(`:int` 등)·혼합 leaf 캐스트·`${env}` 캐스트를 에러로. `discriminatedUnion`의 **멤버**가 아니라 **전체 union에 `.superRefine`**(멤버에 붙이면 ZodEffects라 discriminatedUnion이 거부). `type Body`는 ZodEffects infer라 union 타입 보존 — 소비처(`RequestModel.body`) 무영향. 캐스트 없는 토큰·리터럴은 절대 flag 안 함(false-positive 금지).
```

- [ ] **Step 5: `docs/roadmap.md` 항목 close**

"JSON 숫자 주입" 줄을 완료 표시로 갱신(예: `~~JSON 숫자 주입~~ → 구현 완료(0029, flow `{{var:num}}`/`{{var:bool}}`). :json/null·env는 연기.`).

- [ ] **Step 6: spec status 갱신**

`docs/superpowers/specs/2026-06-03-json-typed-body-injection-design.md` 상단 `- **상태**:`를 "구현 완료(plan 2026-06-03 전 Task 머지)"로.

- [ ] **Step 7: 커밋 (docs-only fast-path)**

```bash
git add docs/adr/0029-json-body-type-cast-injection.md CLAUDE.md crates/engine/CLAUDE.md ui/CLAUDE.md docs/roadmap.md docs/superpowers/specs/2026-06-03-json-typed-body-injection-design.md
git commit -m "docs: ADR-0029 + gotchas + roadmap close for JSON body type casts"
```
Expected: pre-commit이 `docs-only (*.md) change — skipping cargo checks`.

---

## 최종 검증 (머지 전)

- [ ] `cargo fmt --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace` 전부 green.
- [ ] `cd ui && pnpm lint && pnpm test && pnpm build` 전부 green.
- [ ] `git log --oneline` — Task 1·3·4(엔진 feat)·2(test)·6(ui feat)·7(docs) 커밋 존재.
- [ ] 머지 conflict marker 잔여 확인: `grep -rn '^<<<<<<<\|^>>>>>>>' **/*.md` (docs 다중 커밋 안전망).
- [ ] (선택) handicap-reviewer로 whole-feature 리뷰 — 특히 엔진 캐스트 ↔ UI Zod 검증 keyword 1:1(`str`/`num`/`bool`), trace/부하 lockstep, 하위호환 byte-identical.

## 완료 기준 (spec §9 대응)

- [ ] `{{var:num}}`/`{{var:bool}}`가 number/bool로 주입(Task 1·3 + 통합 Task 2).
- [ ] `:str`·캐스트 없는 토큰 = 문자열, no-cast byte-identical(Task 3 `json_without_casts_is_byte_identical`).
- [ ] coerce 실패 = `CastFailed`(부하, Task 3).
- [ ] trace twin이 coerce 표시·실패 시 문자열(Task 4).
- [ ] UI Zod가 미지원 keyword·혼합 leaf·env 캐스트를 authoring 에러로(Task 6).
- [ ] 모든 게이트 green + 로드맵 close + 함정·ADR 기록(Task 5·7).
