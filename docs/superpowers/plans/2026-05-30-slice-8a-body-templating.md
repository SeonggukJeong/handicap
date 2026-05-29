# Slice 8a — Body Templating Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `{{var}}`/`${ENV}` 템플릿 치환을 HTTP 요청의 **form body 값**과 **JSON body 문자열 leaf**에도 적용한다(현재는 url·headers·raw body만 치환됨).

**Architecture:** `crates/engine/src/executor.rs::execute_step`의 body match arm만 수정한다. `Body::Form(map)`은 각 값을 `render`해 새 맵으로, `Body::Json(value)`는 `serde_json::Value`를 재귀 walk하며 **문자열 leaf만** `render`(number/bool/null·object 키는 그대로 보존). `Body::Raw`는 무변경. 데이터 주입(8c)의 전제조건이며 그 자체로 독립 출하 가능하다. 템플릿 토큰이 없으면 출력은 바이트 단위로 동일(하위 호환).

**Tech Stack:** Rust (edition 2024, MSRV 1.85), `serde_json`, `reqwest`, 테스트는 `wiremock` + `#[tokio::test]`.

**참조 spec:** `docs/superpowers/specs/2026-05-30-slice-8-data-driven-design.md` §1(8a)·§8(8a).

---

## File Structure

- **Modify**: `crates/engine/src/executor.rs`
  - body match arm(`execute_step` 내 `if let Some(body) = &step.request.body` 블록, 현재 라인 69–78)에서 Form/Json을 렌더.
  - 새 비공개 헬퍼 `render_json_value(&serde_json::Value, &TemplateContext) -> Result<serde_json::Value>` 추가.
  - 인라인 `#[cfg(test)] mod tests`에 테스트 2개 추가(파일에 이미 wiremock 테스트 모듈 존재 → tdd-guard 통과).
- **Modify**: `CLAUDE.md` — "Slice 7에서 배운 함정들" 다음에 짧은 동작 변경 노트(form/JSON body가 이제 템플릿팅됨).

`crates/engine/src/template.rs::render(input: &str, ctx: &TemplateContext) -> Result<String>`와 `Body`(`scenario.rs`)는 이미 존재 — 신규 모듈 없음.

> **함정(spec §11)**: 이 변경은 엔진 크레이트를 건드린다. 수동 점검 시 `cargo run -p handicap-controller`는 `target/debug/worker`를 다시 빌드하지 않으므로, 워커 경유 확인 전 `cargo build -p handicap-worker`를 먼저 실행할 것. (이 슬라이스는 단위 테스트로 검증되므로 필수는 아님.)

---

## Task 1: Form body 값 템플릿팅

**Files:**
- Modify: `crates/engine/src/executor.rs:70-77` (body match arm의 `Body::Form`)
- Test: `crates/engine/src/executor.rs` 인라인 `mod tests`

- [ ] **Step 1: 실패하는 테스트 작성**

`crates/engine/src/executor.rs`의 `mod tests` 안(마지막 `}` 직전)에 추가. 상단 `use` 도 함께 보강:

```rust
    // mod tests 상단 use 블록에 추가:
    use crate::scenario::Body;
    use wiremock::matchers::{body_string_contains, body_json};
```

```rust
    #[tokio::test]
    async fn form_body_values_are_templated() {
        let server = MockServer::start().await;
        // 치환이 됐을 때만(user=alice) 200, 아니면 매칭 실패로 404.
        Mock::given(method("POST"))
            .and(path("/login"))
            .and(body_string_contains("user=alice"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&server)
            .await;

        let mut form = BTreeMap::new();
        form.insert("user".to_string(), "{{username}}".to_string());
        let step = HttpStep {
            id: "01HX0000000000000000000010".into(),
            name: "login".into(),
            request: Request {
                method: HttpMethod::Post,
                url: format!("{}/login", server.uri()),
                headers: BTreeMap::new(),
                body: Some(Body::Form(form)),
            },
            assert: vec![],
            extract: vec![],
        };
        let mut vars = BTreeMap::new();
        vars.insert("username".to_string(), "alice".to_string());
        let env = empty_env();
        let ctx = TemplateContext {
            vars: &vars,
            env: &env,
            vu_id: 0,
            iter_id: 0,
            loop_index: None,
        };
        let client = VuClient::new(crate::scenario::CookieJarMode::Off).unwrap();
        let outcome = execute_step(&client, &step, &ctx).await.unwrap();
        assert_eq!(outcome.status, 200, "form value must be templated to user=alice");
        assert!(outcome.error.is_none(), "no error: {:?}", outcome.error);
    }
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cargo test -p handicap-engine form_body_values_are_templated`
Expected: FAIL — 현재 form은 `user={{username}}`(URL 인코딩됨)로 전송되어 매처 불일치 → status 404.

- [ ] **Step 3: 최소 구현 — Form arm 렌더**

`crates/engine/src/executor.rs`의 body match(현재):

```rust
    if let Some(body) = &step.request.body {
        req = match body {
            Body::Json(v) => req.json(v),
            Body::Form(map) => req.form(map),
            Body::Raw(s) => {
                let rendered = render(s, ctx)?;
                req.body(rendered)
            }
        };
    }
```

`Body::Form` arm을 다음으로 교체:

```rust
            Body::Form(map) => {
                let mut rendered = BTreeMap::new();
                for (k, v) in map {
                    rendered.insert(k.clone(), render(v, ctx)?);
                }
                req.form(&rendered)
            }
```

(`reqwest`의 `form`은 호출 시점에 즉시 직렬화하므로 지역 `rendered` 참조 수명 문제 없음.)

- [ ] **Step 4: 테스트 통과 확인**

Run: `cargo test -p handicap-engine form_body_values_are_templated`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add crates/engine/src/executor.rs
git commit -m "feat(engine): template form body values (8a)"
```

---

## Task 2: JSON body 문자열 leaf 템플릿팅 (number/bool 보존)

**Files:**
- Modify: `crates/engine/src/executor.rs` (body match arm의 `Body::Json` + 새 헬퍼 `render_json_value`)
- Test: `crates/engine/src/executor.rs` 인라인 `mod tests`

- [ ] **Step 1: 실패하는 테스트 작성**

`mod tests` 안에 추가(Task 1에서 `body_json` use는 이미 추가됨):

```rust
    #[tokio::test]
    async fn json_body_string_leaves_are_templated_numbers_preserved() {
        let server = MockServer::start().await;
        // user는 치환되어 "alice", age는 number 30 그대로여야 매칭 → 200.
        Mock::given(method("POST"))
            .and(path("/signup"))
            .and(body_json(serde_json::json!({ "user": "alice", "age": 30 })))
            .respond_with(ResponseTemplate::new(200))
            .mount(&server)
            .await;

        let step = HttpStep {
            id: "01HX0000000000000000000011".into(),
            name: "signup".into(),
            request: Request {
                method: HttpMethod::Post,
                url: format!("{}/signup", server.uri()),
                headers: BTreeMap::new(),
                body: Some(Body::Json(serde_json::json!({
                    "user": "{{username}}",
                    "age": 30
                }))),
            },
            assert: vec![],
            extract: vec![],
        };
        let mut vars = BTreeMap::new();
        vars.insert("username".to_string(), "alice".to_string());
        let env = empty_env();
        let ctx = TemplateContext {
            vars: &vars,
            env: &env,
            vu_id: 0,
            iter_id: 0,
            loop_index: None,
        };
        let client = VuClient::new(crate::scenario::CookieJarMode::Off).unwrap();
        let outcome = execute_step(&client, &step, &ctx).await.unwrap();
        assert_eq!(
            outcome.status, 200,
            "JSON string leaf must template (user=alice) and number 30 must be preserved"
        );
        assert!(outcome.error.is_none(), "no error: {:?}", outcome.error);
    }
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cargo test -p handicap-engine json_body_string_leaves_are_templated_numbers_preserved`
Expected: FAIL — 현재 JSON은 `{"user":"{{username}}","age":30}`로 전송 → `body_json` 불일치 → status 404.

- [ ] **Step 3: 최소 구현 — 헬퍼 + Json arm**

`crates/engine/src/executor.rs`의 `execute_step` **함수 정의 위(또는 파일 내 적당한 비공개 위치)** 에 헬퍼 추가:

```rust
/// Recursively render `{{var}}`/`${ENV}` in every string leaf of a JSON value.
/// Numbers, booleans, null, and object keys are preserved unchanged.
fn render_json_value(
    value: &serde_json::Value,
    ctx: &TemplateContext<'_>,
) -> Result<serde_json::Value> {
    use serde_json::Value;
    Ok(match value {
        Value::String(s) => Value::String(render(s, ctx)?),
        Value::Array(items) => {
            let mut out = Vec::with_capacity(items.len());
            for item in items {
                out.push(render_json_value(item, ctx)?);
            }
            Value::Array(out)
        }
        Value::Object(map) => {
            let mut out = serde_json::Map::with_capacity(map.len());
            for (k, v) in map {
                out.insert(k.clone(), render_json_value(v, ctx)?);
            }
            Value::Object(out)
        }
        // Number / Bool / Null — preserved as-is.
        other => other.clone(),
    })
}
```

body match의 `Body::Json` arm을 교체:

```rust
            Body::Json(v) => {
                let rendered = render_json_value(v, ctx)?;
                req.json(&rendered)
            }
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cargo test -p handicap-engine json_body_string_leaves_are_templated_numbers_preserved`
Expected: PASS

- [ ] **Step 5: 전체 엔진 테스트로 회귀 없음 확인**

Run: `cargo test -p handicap-engine`
Expected: PASS (기존 테스트 전부 통과 — `{{}}` 없는 body는 동작 불변).

- [ ] **Step 6: 커밋**

```bash
git add crates/engine/src/executor.rs
git commit -m "feat(engine): template JSON body string leaves, preserve types (8a)"
```

---

## Task 3: 문서 노트 + 워크스페이스 게이트 + 성능 확인

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: CLAUDE.md 동작 변경 노트 추가**

`CLAUDE.md`의 "## Slice 7-1에서 배운 함정들" 섹션 끝(마지막 불릿 다음)에 추가:

```markdown

## Slice 8a에서 배운 함정들

- **form/JSON body가 이제 템플릿팅된다**: `executor.rs`는 8a부터 `Body::Form` 값 전체와 `Body::Json` 문자열 leaf에 `render`를 적용한다(이전엔 url·header·`Body::Raw`만). JSON은 number/bool/null·object 키를 보존하고 문자열 leaf만 치환(`render_json_value`). 따라서 `{{var}}`/`${ENV}`를 form·JSON body에 써도 동작한다. 숫자 주입(`{"age": {{age}}}`로 number)은 미지원 — 값은 문자열로만 들어간다.
```

- [ ] **Step 2: 워크스페이스 전체 게이트**

Run: `just build && just lint && just test`
Expected: 전부 PASS (fmt·clippy `-D warnings`·workspace 테스트). pre-commit 훅과 동일 게이트.

- [ ] **Step 3: 커밋**

```bash
git add CLAUDE.md
git commit -m "docs(claude-md): 8a form/JSON body templating behavior note"
```

- [ ] **Step 4: 성능 회귀 확인(측정 — RED/GREEN 아님)**

8a는 템플릿 토큰이 있을 때만 추가 작업을 한다(form 맵 재구성 / JSON walk는 요청당 1회). 처리량 회귀가 없는지 확인:

Run: `just bench-throughput` (있으면). 또는 기존 baseline(post-Slice-6 ~20,389 RPS / p95 17ms)과 비교해 run-to-run 변동(±5–7%) 범위 내인지 확인.
Expected: 측정 가능한 회귀 없음. 결과를 8a 머지 커밋 메시지나 spec §10에 한 줄로 기록.

> `just bench-throughput`이 없거나 환경상 어려우면 이 스텝은 스킵하고 그 사실을 기록(8a의 코드 경로는 토큰 없을 때 no-op에 가까움).

---

## Self-Review (작성자 체크 결과)

- **Spec 커버리지**: spec §1(8a) "form 각 값 + JSON 문자열 leaf render, 타입·키 보존, 하위 호환" → Task 1(form)·Task 2(json+헬퍼)로 전부 커버. §8(8a) "단위 테스트: form 값 치환, 중첩 JSON 문자열 leaf 치환+number 보존, 미바인딩 무변경" → form 테스트 + json+number 테스트 + Task 2 Step 5(기존 테스트로 미변경 확인). §13(8a) A/B 회귀 → Task 3 Step 4. ✓
- **Placeholder 스캔**: 모든 코드 스텝에 실제 코드·명령·기대 출력 포함. TBD/TODO 없음. ✓
- **타입 일관성**: `render(&str, &TemplateContext) -> Result<String>`(기존), 새 `render_json_value(&serde_json::Value, &TemplateContext<'_>) -> Result<serde_json::Value>`. `Body::{Form(BTreeMap<String,String>), Json(serde_json::Value), Raw(String)}`(기존). `TemplateContext` 필드(vars/env/vu_id/iter_id/loop_index)는 기존 테스트와 동일. 테스트 ULID는 Crockford base32(`I/L/O/U` 회피) 준수. ✓
- **중첩 JSON 문자열 leaf**: spec이 "중첩"을 명시 — `render_json_value`가 Array/Object 재귀하므로 커버(별도 테스트는 단순화를 위해 1-depth로 두되 재귀 구현이 보장). 필요 시 중첩 객체 테스트 추가 가능.
