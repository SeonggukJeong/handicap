# Slice 9a — 엔진 Conditional 노드 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 엔진에 첫 분기 control-flow 노드 `type: if`(평탄 if/elif/else + 재귀 조건 트리 + lenient 평가)를 추가한다. UI·controller·proto·메트릭은 무변경(9b/9c/9d).

**Architecture:** Slice 7 loop이 깐 인프라(internally-tagged `Step` enum, 재귀 `execute_steps` + `StepFlow`, manual serde 패턴)를 재사용·확장한다. 새 타입 `Condition`(map-shape, 수동 serde) + `CompareOp` + `IfStep`/`ElifBranch`, 새 `Step::If` variant. 조건 평가는 **strict `render`와 별개의 lenient resolver**(`render_lenient`)를 써서 미해결 변수를 빈 문자열로 떨어뜨리고 — **조건 평가는 절대 run을 죽이지 않는다**(extract 실패 → 자연스러운 분기). 엔진 타입은 `Vec<Step>`로 자유 중첩 허용, 단일 레벨 강제는 UI Zod(9b)가 담당.

**Tech Stack:** Rust (edition 2024, MSRV 1.85), serde + serde_yaml 0.9, `regex` 1(신규 의존성), tokio, wiremock + proptest(테스트).

**Spec:** `docs/superpowers/specs/2026-05-30-slice-9-conditional-node-design.md` (§2 모델, §3 평가, §4 인터프리터, §8 9a 범위)

---

## 작업 전 필독 (footguns)

- **TDD 순서 강제 훅**: `.claude/hooks/tdd-guard.sh`가 `crates/*/src/*.rs` Write/Edit 시 작업트리에 pending 테스트가 없으면 차단한다. **각 태스크는 테스트를 먼저 쓴다.** `scenario.rs`/`template.rs`는 인라인 `#[cfg(test)] mod tests`가 있어 편집이 자동 통과한다. `runner.rs`는 인라인 테스트가 없으므로, runner.rs를 건드리는 Task 4는 **먼저 `crates/engine/tests/if_node.rs`를 생성**(그게 pending 테스트가 됨)한 다음 runner.rs를 편집한다.
- **serde_yaml 0.9 + map-shape enum round-trip 함정** (엔진 CLAUDE.md): `Condition`은 `{all: [...]}`/`{any: [...]}`/`{left, op, right}` map 모양이라 `derive`가 아니라 **수동 `Serialize`/`Deserialize`**가 필수(`Body`/`Assertion`과 동형). `CompareOp`는 데이터 없는 enum이라 `derive` + `rename_all="lowercase"`로 round-trip OK(`Extract` 부류).
- **`deny_unknown_fields`는 internal 태그 enum 레벨에서 안 먹는다** (엔진 CLAUDE.md): 각 variant 구조체(`IfStep`/`ElifBranch`)에 개별로 `#[serde(deny_unknown_fields)]`를 단다. `HttpStep`/`LoopStep`이 같은 패턴(증명됨).
- **placeholder ULID 함정** (엔진 CLAUDE.md): 테스트 id는 ULID Crockford base32라 `I`/`L`/`O`/`U`를 못 쓴다. 이 플랜의 테스트 id는 숫자만(`01HX0000000000000000000001` 등)이라 안전 — 그대로 복사.
- **dead_code + clippy `-D warnings`**: pre-commit이 `clippy --all-targets -D warnings`를 돈다. 태스크 사이에 prod에서 아직 안 쓰이는 헬퍼(`render_lenient`, `eval_condition`)는 **`pub` + `lib.rs` re-export**로 노출해 dead_code 경고를 피한다(공개 API는 dead_code 린트 제외 — 기존 `pub use ... evaluate as evaluate_extracts` 패턴과 동일).
- **`--no-verify` 금지**. 각 태스크는 green 상태에서만 커밋(pre-commit: fmt/build/clippy/test 전부 통과).
- **워크트리**: 슬라이스 작업은 `.claude/worktrees/<name>` worktree에서. (이 플랜은 worktree 생성을 가정하지 않음 — 실행 시 `superpowers:using-git-worktrees`로 준비.)

---

## File Structure

| 파일 | 역할 | 변경 |
|---|---|---|
| `Cargo.toml` (workspace) | `regex = "1"` workspace 의존성 추가 | Modify |
| `crates/engine/Cargo.toml` | `regex = { workspace = true }` | Modify |
| `crates/engine/src/scenario.rs` | `Condition`/`CompareOp`/`IfStep`/`ElifBranch` 타입 + 수동 serde + `Step::If` variant + `id()`/`name()` arms | Modify |
| `crates/engine/src/template.rs` | `render_lenient`(lenient resolver) + `render`/`render_lenient` = `render_inner(lenient)` 공유 | Modify |
| `crates/engine/src/condition.rs` | **신규** — `eval_condition`/`eval_compare`(op 적용, regex 안전망) | Create |
| `crates/engine/src/runner.rs` | `execute_steps`에 `Step::If` arm(`Box::pin` 재귀, ctx passthrough) | Modify |
| `crates/engine/src/lib.rs` | 새 타입·함수 re-export + `pub mod condition` | Modify |
| `crates/engine/tests/if_node.rs` | **신규** — wiremock 분기 통합(then/elif/else/lenient) | Create |
| `crates/engine/tests/proptests.rs` | `arb_condition`/`arb_if_step` 추가, `arb_step`에 if 포함 | Modify |
| `docs/adr/0023-conditional-node.md` | **신규** ADR | Create |
| `CLAUDE.md` (root) | "알아둘 결정들"에 0023 한 줄 | Modify |
| `crates/engine/CLAUDE.md` | 새 함정 노트 | Modify |

---

## Task 1: `Condition` + `CompareOp` 타입 & 수동 serde

흐름 변수 조건의 잎(`Compare`)과 그룹(`All`/`Any`)을 표현하는 재귀 조건 트리. `Condition`은 map-shape라 수동 serde, `CompareOp`는 데이터 없는 enum이라 derive.

**Files:**
- Modify: `crates/engine/src/scenario.rs` (타입 추가 + 인라인 테스트)
- Modify: `crates/engine/src/lib.rs:17-19` (re-export)

- [ ] **Step 1: 실패하는 round-trip / malformed 테스트를 scenario.rs 인라인 모듈에 추가**

`crates/engine/src/scenario.rs`의 `#[cfg(test)] mod tests { ... }` 안(기존 `body_map_rejects_unknown_variant` 테스트 뒤, 닫는 `}` 앞)에 추가:

```rust
    // ---- Slice 9a: Condition serde ----

    fn cond_round_trip(yaml: &str) -> Condition {
        let c: Condition = serde_yaml::from_str(yaml).expect("cond parses");
        let out = serde_yaml::to_string(&c).expect("cond serializes");
        let c2: Condition = serde_yaml::from_str(&out).expect("cond re-parses");
        assert_eq!(c, c2, "condition must round-trip:\n{out}");
        c
    }

    #[test]
    fn condition_compare_round_trips() {
        let c = cond_round_trip("{ left: \"{{code}}\", op: eq, right: \"200\" }");
        assert_eq!(
            c,
            Condition::Compare {
                left: "{{code}}".into(),
                op: CompareOp::Eq,
                right: Some("200".into()),
            }
        );
    }

    #[test]
    fn condition_exists_omits_right() {
        let c = cond_round_trip("{ left: \"{{token}}\", op: exists }");
        assert_eq!(
            c,
            Condition::Compare {
                left: "{{token}}".into(),
                op: CompareOp::Exists,
                right: None,
            }
        );
        // serialized form must NOT contain a `right:` key for exists.
        let out = serde_yaml::to_string(&c).unwrap();
        assert!(!out.contains("right"), "exists must omit right:\n{out}");
    }

    #[test]
    fn condition_nested_all_any_round_trips() {
        let c = cond_round_trip(
            "all:\n  - { left: \"{{a}}\", op: eq, right: \"1\" }\n  - any:\n      - { left: \"{{b}}\", op: contains, right: \"x\" }\n      - { left: \"{{c}}\", op: gte, right: \"3\" }\n",
        );
        match c {
            Condition::All(v) => {
                assert_eq!(v.len(), 2);
                assert!(matches!(v[0], Condition::Compare { .. }));
                assert!(matches!(v[1], Condition::Any(_)));
            }
            other => panic!("expected All, got {other:?}"),
        }
    }

    #[test]
    fn condition_key_order_independent() {
        // op/left/right in any order must parse to the same Compare.
        let c: Condition =
            serde_yaml::from_str("{ op: ne, right: \"x\", left: \"{{v}}\" }").unwrap();
        assert_eq!(
            c,
            Condition::Compare {
                left: "{{v}}".into(),
                op: CompareOp::Ne,
                right: Some("x".into()),
            }
        );
    }

    #[test]
    fn condition_rejects_malformed_map() {
        // No `all`/`any`/`left` key → cannot disambiguate → error.
        assert!(serde_yaml::from_str::<Condition>("{ op: eq, right: \"1\" }").is_err());
        // Unknown key.
        assert!(serde_yaml::from_str::<Condition>("{ left: \"a\", op: eq, bogus: 1 }").is_err());
        // Mixing group + compare.
        assert!(
            serde_yaml::from_str::<Condition>("{ all: [], left: \"a\", op: eq }").is_err()
        );
    }
```

- [ ] **Step 2: 빌드해서 실패 확인**

Run: `cargo test -p handicap-engine --lib condition_ 2>&1 | tail -20`
Expected: 컴파일 에러 — `cannot find type 'Condition'` / `'CompareOp'` (아직 정의 안 됨).

- [ ] **Step 3: `CompareOp` + `Condition` 타입과 수동 serde 구현**

`crates/engine/src/scenario.rs`의 `Extract` enum 정의 바로 뒤(라인 ~229, `impl Scenario` 앞)에 추가:

```rust
/// Comparison operator for a condition leaf. Data-free enum → `derive` round-trips
/// (same class as the internally-tagged `Extract` struct variants — engine CLAUDE.md).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CompareOp {
    Eq,
    Ne,
    Contains,
    Matches,
    Lt,
    Gt,
    Lte,
    Gte,
    Exists,
    Empty,
}

/// A recursive condition tree: a leaf comparison or an AND/OR group.
///
/// Map-shaped YAML (`{left, op, right?}` / `{all: [...]}` / `{any: [...]}`), so —
/// like [`Body`] and [`Assertion`] — it needs a **manual** `Serialize`/`Deserialize`:
/// serde_yaml 0.9 derive on an externally-tagged enum with map variants emits/expects
/// `!variant value` tags, breaking round-trip (engine CLAUDE.md). The three shapes are
/// disambiguated by key presence (`all` / `any` / `left`); `Compare` always carries
/// `left`, which never collides with `all`/`any`, so there is no ambiguity.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Condition {
    Compare {
        left: String,
        op: CompareOp,
        right: Option<String>,
    },
    All(Vec<Condition>),
    Any(Vec<Condition>),
}

impl Serialize for Condition {
    fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        match self {
            Condition::All(v) => {
                let mut map = s.serialize_map(Some(1))?;
                map.serialize_entry("all", v)?;
                map.end()
            }
            Condition::Any(v) => {
                let mut map = s.serialize_map(Some(1))?;
                map.serialize_entry("any", v)?;
                map.end()
            }
            Condition::Compare { left, op, right } => {
                let n = if right.is_some() { 3 } else { 2 };
                let mut map = s.serialize_map(Some(n))?;
                map.serialize_entry("left", left)?;
                map.serialize_entry("op", op)?;
                if let Some(r) = right {
                    map.serialize_entry("right", r)?;
                }
                map.end()
            }
        }
    }
}

impl<'de> Deserialize<'de> for Condition {
    fn deserialize<D: Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        struct CondVisitor;
        impl<'de> Visitor<'de> for CondVisitor {
            type Value = Condition;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a condition map: {all: [...]}, {any: [...]}, or {left, op, right?}")
            }
            fn visit_map<M: MapAccess<'de>>(
                self,
                mut map: M,
            ) -> std::result::Result<Condition, M::Error> {
                let mut left: Option<String> = None;
                let mut op: Option<CompareOp> = None;
                let mut right: Option<String> = None;
                let mut all: Option<Vec<Condition>> = None;
                let mut any: Option<Vec<Condition>> = None;
                while let Some(key) = map.next_key::<String>()? {
                    match key.as_str() {
                        "all" => {
                            if all.is_some() {
                                return Err(de::Error::duplicate_field("all"));
                            }
                            all = Some(map.next_value()?);
                        }
                        "any" => {
                            if any.is_some() {
                                return Err(de::Error::duplicate_field("any"));
                            }
                            any = Some(map.next_value()?);
                        }
                        "left" => {
                            if left.is_some() {
                                return Err(de::Error::duplicate_field("left"));
                            }
                            left = Some(map.next_value()?);
                        }
                        "op" => {
                            if op.is_some() {
                                return Err(de::Error::duplicate_field("op"));
                            }
                            op = Some(map.next_value()?);
                        }
                        "right" => {
                            if right.is_some() {
                                return Err(de::Error::duplicate_field("right"));
                            }
                            right = Some(map.next_value()?);
                        }
                        other => {
                            return Err(de::Error::unknown_field(
                                other,
                                &["all", "any", "left", "op", "right"],
                            ));
                        }
                    }
                }
                match (all, any, left) {
                    (Some(v), None, None) => {
                        if op.is_some() || right.is_some() {
                            return Err(de::Error::custom(
                                "`all` group cannot also have left/op/right",
                            ));
                        }
                        Ok(Condition::All(v))
                    }
                    (None, Some(v), None) => {
                        if op.is_some() || right.is_some() {
                            return Err(de::Error::custom(
                                "`any` group cannot also have left/op/right",
                            ));
                        }
                        Ok(Condition::Any(v))
                    }
                    (None, None, Some(l)) => {
                        let op = op.ok_or_else(|| de::Error::missing_field("op"))?;
                        Ok(Condition::Compare { left: l, op, right })
                    }
                    (None, None, None) => Err(de::Error::custom(
                        "condition must have `all`, `any`, or `left`",
                    )),
                    _ => Err(de::Error::custom(
                        "condition must be exactly one of: all-group, any-group, or compare",
                    )),
                }
            }
        }
        d.deserialize_map(CondVisitor)
    }
}
```

- [ ] **Step 4: lib.rs에 re-export 추가**

`crates/engine/src/lib.rs:17-19`의 `pub use scenario::{...}` 블록을 수정 — `Condition`, `CompareOp`를 알파벳 순서에 맞게 추가:

```rust
pub use scenario::{
    Assertion, Body, CompareOp, Condition, CookieJarMode, HttpMethod, HttpStep, LoopStep, Request,
    Scenario, Step,
};
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `cargo test -p handicap-engine --lib condition_ 2>&1 | tail -20`
Expected: 6개 `condition_*` 테스트 PASS.

Run: `cargo test -p handicap-engine --lib 2>&1 | tail -5`
Expected: 기존 scenario 테스트 전부 PASS (회귀 없음).

- [ ] **Step 6: 커밋**

```bash
git add crates/engine/src/scenario.rs crates/engine/src/lib.rs
git commit -m "feat(engine): Condition + CompareOp types with manual serde (9a)"
```

---

## Task 2: `render_lenient` — 조건 평가용 lenient resolver

`render`(strict, unknown var fail-fast)와 **별도 경로**. 미해결 토큰(`{{var}}`, 정의 안 된 `${NAME}`, loop 밖 `${loop_index}`) → 빈 문자열. malformed/unclosed marker → literal로 그대로 emit. **절대 `Err`를 내지 않는다**(조건 평가가 run을 못 죽이게). 파싱 로직은 `render_inner(lenient: bool)`로 공유.

**Files:**
- Modify: `crates/engine/src/template.rs` (`render`/`render_lenient`/`render_inner` + 인라인 테스트)
- Modify: `crates/engine/src/lib.rs:20` (re-export)

- [ ] **Step 1: 실패하는 테스트를 template.rs 인라인 모듈에 추가**

`crates/engine/src/template.rs`의 `#[cfg(test)] mod tests`(라인 ~111) 안, 마지막 테스트 뒤·닫는 `}` 앞에 추가:

```rust
    #[test]
    fn lenient_unknown_flow_var_is_empty() {
        let v = BTreeMap::new();
        let env = empty_env();
        let ctx = TemplateContext {
            vars: &v,
            env: &env,
            vu_id: 0,
            iter_id: 0,
            loop_index: None,
        };
        assert_eq!(render_lenient("[{{missing}}]", &ctx), "[]");
    }

    #[test]
    fn lenient_unknown_env_var_is_empty() {
        let v = BTreeMap::new();
        let env = empty_env();
        let ctx = TemplateContext {
            vars: &v,
            env: &env,
            vu_id: 0,
            iter_id: 0,
            loop_index: None,
        };
        assert_eq!(render_lenient("[${NOPE}]", &ctx), "[]");
        // ...but a default still resolves.
        assert_eq!(render_lenient("${NOPE:-fb}", &ctx), "fb");
    }

    #[test]
    fn lenient_loop_index_outside_loop_is_empty() {
        let v = BTreeMap::new();
        let env = empty_env();
        let ctx = TemplateContext {
            vars: &v,
            env: &env,
            vu_id: 0,
            iter_id: 0,
            loop_index: None,
        };
        assert_eq!(render_lenient("i${loop_index}", &ctx), "i");
    }

    #[test]
    fn lenient_resolves_known_vars_same_as_strict() {
        let v = vars(&[("code", "200")]);
        let env: BTreeMap<String, String> = [("H".to_string(), "x".to_string())]
            .into_iter()
            .collect();
        let ctx = TemplateContext {
            vars: &v,
            env: &env,
            vu_id: 7,
            iter_id: 0,
            loop_index: Some(2),
        };
        assert_eq!(
            render_lenient("${H}/{{code}}/${vu_id}/${loop_index}", &ctx),
            "x/200/7/2"
        );
    }

    #[test]
    fn lenient_unclosed_marker_is_literal_and_never_errors() {
        let v = BTreeMap::new();
        let env = empty_env();
        let ctx = TemplateContext {
            vars: &v,
            env: &env,
            vu_id: 0,
            iter_id: 0,
            loop_index: None,
        };
        // No panic, no error path — unclosed braces pass through literally.
        assert_eq!(render_lenient("a{{unclosed", &ctx), "a{{unclosed");
        assert_eq!(render_lenient("b${unclosed", &ctx), "b${unclosed");
    }
```

- [ ] **Step 2: 빌드해서 실패 확인**

Run: `cargo test -p handicap-engine --lib lenient_ 2>&1 | tail -20`
Expected: 컴파일 에러 — `cannot find function 'render_lenient'`.

- [ ] **Step 3: `render`를 `render_inner(lenient)`로 리팩터 + `render_lenient` 추가**

`crates/engine/src/template.rs`의 **라인 15~88(기존 `render` doc comment + 본문) 전체를 아래 블록으로 통째 교체**한다. 새 블록은 `render`(얇은 wrapper) + `render_lenient` + 코어 `render_inner(lenient)`로 구성되고, `render`의 새 doc comment가 기존 라인 15~20의 내용을 포함하므로 별도로 보존할 것은 없다:

```rust
/// Substitute `{{var}}` (from `vars`) and `${NAME}` (system vars or env). Strict:
/// any unresolved token errors (fail-fast at request build time).
/// - `${vu_id}` / `${iter_id}` resolve to their numeric values.
/// - `${loop_index}` resolves to the current 0-based loop index, or errors outside a loop.
/// - `${NAME}` resolves against `ctx.env`; unknown name with no default → error.
/// - `${NAME:-default}` falls back to `default` when `NAME` is absent from env.
/// - Unknown `{{name}}` → error.
pub fn render(input: &str, ctx: &TemplateContext) -> Result<String> {
    render_inner(input, ctx, false)
}

/// Lenient variant for **condition evaluation** (spec §3.1). Shares the parser
/// with [`render`] but every unresolved token (`{{var}}`, undefined `${NAME}`,
/// `${loop_index}` outside a loop) renders to the empty string, and an unclosed
/// `{{`/`${` marker is emitted literally. It never returns `Err` — condition
/// evaluation must never kill a run (extract failure → natural branching). Mirrors
/// the UI `resolveForDisplay` philosophy (preserve/soften unresolved tokens).
pub fn render_lenient(input: &str, ctx: &TemplateContext) -> String {
    // `render_inner(.., true)` provably never returns Err; default-guard is defensive.
    render_inner(input, ctx, true).unwrap_or_default()
}

fn render_inner(input: &str, ctx: &TemplateContext, lenient: bool) -> Result<String> {
    let mut out = String::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut i = 0;
    let mut lit_start = 0;

    while i < bytes.len() {
        if i + 1 < bytes.len() && bytes[i] == b'{' && bytes[i + 1] == b'{' {
            out.push_str(&input[lit_start..i]);
            let end = match find_pair(bytes, i + 2, b"}}") {
                Some(e) => e,
                None => {
                    if lenient {
                        out.push_str(&input[i..]);
                        return Ok(out);
                    }
                    return Err(EngineError::MalformedTemplate(format!(
                        "unclosed {{{{ at byte {i}"
                    )));
                }
            };
            let name = std::str::from_utf8(&bytes[i + 2..end])
                .map_err(|_| EngineError::MalformedTemplate("non-utf8 in {{ }}".into()))?
                .trim();
            match ctx.vars.get(name) {
                Some(value) => out.push_str(value),
                None => {
                    if !lenient {
                        return Err(EngineError::UnknownVar(name.to_string()));
                    }
                    // lenient: push nothing (empty string).
                }
            }
            i = end + 2;
            lit_start = i;
            continue;
        }
        if i + 1 < bytes.len() && bytes[i] == b'$' && bytes[i + 1] == b'{' {
            out.push_str(&input[lit_start..i]);
            let end = match find_byte(bytes, i + 2, b'}') {
                Some(e) => e,
                None => {
                    if lenient {
                        out.push_str(&input[i..]);
                        return Ok(out);
                    }
                    return Err(EngineError::MalformedTemplate(format!(
                        "unclosed ${{ at byte {i}"
                    )));
                }
            };
            let inner = std::str::from_utf8(&bytes[i + 2..end])
                .map_err(|_| EngineError::MalformedTemplate("non-utf8 in ${ }".into()))?;
            let (name, default) = match inner.find(":-") {
                Some(p) => (inner[..p].trim(), Some(inner[p + 2..].to_string())),
                None => (inner.trim(), None),
            };
            let value: Option<String> = match name {
                "vu_id" => Some(ctx.vu_id.to_string()),
                "iter_id" => Some(ctx.iter_id.to_string()),
                "loop_index" => ctx.loop_index.map(|x| x.to_string()),
                other => match ctx.env.get(other) {
                    Some(v) => Some(v.clone()),
                    None => default,
                },
            };
            match value {
                Some(v) => out.push_str(&v),
                None => {
                    if !lenient {
                        return Err(EngineError::UnknownVar(name.to_string()));
                    }
                    // lenient: push nothing.
                }
            }
            i = end + 1;
            lit_start = i;
            continue;
        }
        i += 1;
    }
    out.push_str(&input[lit_start..]);
    Ok(out)
}
```

`find_pair` / `find_byte` 헬퍼(라인 90~109)는 그대로 둔다.

> **주의**: `loop_index`가 `Some(x)`면 `Some(x.to_string())`, `None`이면 `None` → strict는 `Err`, lenient는 빈 문자열. 기존 strict 동작(loop 밖 `${loop_index}` → `UnknownVar`)은 보존된다(`value`가 `None`이고 `!lenient`).

- [ ] **Step 4: lib.rs re-export 갱신**

`crates/engine/src/lib.rs:20`:

```rust
pub use template::{TemplateContext, render, render_lenient};
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `cargo test -p handicap-engine --lib 2>&1 | tail -8`
Expected: 새 `lenient_*` 5개 + 기존 `template` 테스트(`renders_flow_var`, `loop_index_outside_loop_errors` 등) 전부 PASS — strict 경로 회귀 없음.

- [ ] **Step 6: 커밋**

```bash
git add crates/engine/src/template.rs crates/engine/src/lib.rs
git commit -m "feat(engine): render_lenient for condition evaluation (9a)"
```

---

## Task 3: `eval_condition` — 조건 평가 (신규 `condition.rs`)

`Condition` 트리를 `TemplateContext`로 평가해 `bool`. 잎은 lenient render 후 op 적용. `All` 빈 그룹 → true(vacuous), `Any` 빈 그룹 → false. 숫자 비교는 양쪽 f64 파싱(실패 시 false). regex는 런타임 안전망(컴파일 실패 → false + warn).

**Files:**
- Modify: `Cargo.toml` (workspace `regex` 의존성)
- Modify: `crates/engine/Cargo.toml`
- Create: `crates/engine/src/condition.rs`
- Modify: `crates/engine/src/lib.rs` (`pub mod condition` + re-export)

- [ ] **Step 1: `regex` 의존성 추가**

`Cargo.toml`(workspace)의 `[workspace.dependencies]` 블록(라인 11~48), `rand = "0.8"` 뒤에 알파벳 위치 맞춰 추가:

```toml
regex = "1"
```

`crates/engine/Cargo.toml`의 `[dependencies]`(라인 8~23), `reqwest.workspace = true` 앞에 추가:

```toml
regex = { workspace = true }
```

- [ ] **Step 2: 실패하는 단위 테스트와 함께 `condition.rs` 생성**

`crates/engine/src/condition.rs` 신규 작성 — 함수 본문 + 인라인 `#[cfg(test)] mod tests`를 아래대로 한 번에 작성한다. (이 파일이 인라인 테스트를 포함하므로 TDD-guard를 통과한다. "RED를 먼저 보고 싶으면" 두 함수 본문을 `todo!()`로 두고 Step 3에서 panic을 확인한 뒤 Step 4에서 채워도 되지만, **기본 경로는 본문을 채운 채 작성 → Step 4에서 곧장 GREEN 확인**이다.):

```rust
//! Condition evaluation for `type: if` steps (spec §3). Uses the **lenient**
//! template resolver (`render_lenient`) so unresolved variables become `""` and
//! evaluation can never kill a run. Numeric comparisons parse both sides as f64;
//! an unparseable side → false. A bad regex compiles to a lenient `false`.

use crate::scenario::{CompareOp, Condition};
use crate::template::{TemplateContext, render_lenient};

/// Evaluate a condition tree to a boolean.
/// - `All` over an empty group → `true` (vacuous); `Any` over empty → `false`.
pub fn eval_condition(cond: &Condition, ctx: &TemplateContext) -> bool {
    match cond {
        Condition::All(v) => v.iter().all(|c| eval_condition(c, ctx)),
        Condition::Any(v) => v.iter().any(|c| eval_condition(c, ctx)),
        Condition::Compare { left, op, right } => {
            eval_compare(left, *op, right.as_deref(), ctx)
        }
    }
}

fn eval_compare(left: &str, op: CompareOp, right: Option<&str>, ctx: &TemplateContext) -> bool {
    let l = render_lenient(left, ctx);
    match op {
        CompareOp::Exists => !l.is_empty(),
        CompareOp::Empty => l.is_empty(),
        _ => {
            // For all other ops, a missing `right` renders to "" (lenient).
            let r = right.map(|r| render_lenient(r, ctx)).unwrap_or_default();
            match op {
                CompareOp::Eq => l == r,
                CompareOp::Ne => l != r,
                CompareOp::Contains => l.contains(&r),
                CompareOp::Matches => match regex::Regex::new(&r) {
                    Ok(re) => re.is_match(&l),
                    Err(e) => {
                        // Runtime safety net (spec §3.3): bad regex → lenient false.
                        // The authoring guard is UI 9b (`new RegExp` smoke check).
                        tracing::warn!(pattern = %r, error = %e, "invalid regex in condition; treating as false");
                        false
                    }
                },
                CompareOp::Lt | CompareOp::Gt | CompareOp::Lte | CompareOp::Gte => {
                    match (l.parse::<f64>(), r.parse::<f64>()) {
                        (Ok(a), Ok(b)) => match op {
                            CompareOp::Lt => a < b,
                            CompareOp::Gt => a > b,
                            CompareOp::Lte => a <= b,
                            CompareOp::Gte => a >= b,
                            _ => unreachable!("only lt/gt/lte/gte reach here"),
                        },
                        // one side unparseable → false (string "200" < "30" must not lie)
                        _ => false,
                    }
                }
                CompareOp::Exists | CompareOp::Empty => unreachable!("handled above"),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn ctx_with<'a>(
        vars: &'a BTreeMap<String, String>,
        env: &'a BTreeMap<String, String>,
    ) -> TemplateContext<'a> {
        TemplateContext {
            vars,
            env,
            vu_id: 0,
            iter_id: 0,
            loop_index: None,
        }
    }

    fn vars(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn cmp(left: &str, op: CompareOp, right: Option<&str>) -> Condition {
        Condition::Compare {
            left: left.to_string(),
            op,
            right: right.map(str::to_string),
        }
    }

    #[test]
    fn eq_ne_are_string_equality() {
        let v = vars(&[("code", "200")]);
        let e = BTreeMap::new();
        let ctx = ctx_with(&v, &e);
        assert!(eval_condition(&cmp("{{code}}", CompareOp::Eq, Some("200")), &ctx));
        assert!(!eval_condition(
            &cmp("{{code}}", CompareOp::Eq, Some("200.0")),
            &ctx
        ));
        assert!(eval_condition(&cmp("{{code}}", CompareOp::Ne, Some("404")), &ctx));
    }

    #[test]
    fn contains_substring() {
        let v = vars(&[("body", "all ok here")]);
        let e = BTreeMap::new();
        let ctx = ctx_with(&v, &e);
        assert!(eval_condition(
            &cmp("{{body}}", CompareOp::Contains, Some("ok")),
            &ctx
        ));
        assert!(!eval_condition(
            &cmp("{{body}}", CompareOp::Contains, Some("nope")),
            &ctx
        ));
    }

    #[test]
    fn matches_regex_unanchored() {
        let v = vars(&[("s", "abc123")]);
        let e = BTreeMap::new();
        let ctx = ctx_with(&v, &e);
        assert!(eval_condition(&cmp("{{s}}", CompareOp::Matches, Some("[0-9]+")), &ctx));
        assert!(!eval_condition(&cmp("{{s}}", CompareOp::Matches, Some("^[0-9]+$")), &ctx));
    }

    #[test]
    fn bad_regex_is_lenient_false() {
        let v = vars(&[("s", "x")]);
        let e = BTreeMap::new();
        let ctx = ctx_with(&v, &e);
        // unbalanced bracket — Regex::new errors → false, no panic.
        assert!(!eval_condition(&cmp("{{s}}", CompareOp::Matches, Some("[")), &ctx));
    }

    #[test]
    fn numeric_ops_parse_both_sides() {
        let v = vars(&[("n", "200")]);
        let e = BTreeMap::new();
        let ctx = ctx_with(&v, &e);
        // "200" vs "30": numeric 200 > 30 (string compare would be false).
        assert!(eval_condition(&cmp("{{n}}", CompareOp::Gt, Some("30")), &ctx));
        assert!(eval_condition(&cmp("{{n}}", CompareOp::Gte, Some("200")), &ctx));
        assert!(eval_condition(&cmp("{{n}}", CompareOp::Lte, Some("200")), &ctx));
        assert!(!eval_condition(&cmp("{{n}}", CompareOp::Lt, Some("200")), &ctx));
    }

    #[test]
    fn numeric_unparseable_side_is_false() {
        let v = vars(&[("n", "notnum")]);
        let e = BTreeMap::new();
        let ctx = ctx_with(&v, &e);
        assert!(!eval_condition(&cmp("{{n}}", CompareOp::Lt, Some("5")), &ctx));
        assert!(!eval_condition(&cmp("{{n}}", CompareOp::Gt, Some("5")), &ctx));
    }

    #[test]
    fn exists_empty_treat_unbound_as_empty() {
        let v = BTreeMap::new(); // {{token}} unbound → lenient ""
        let e = BTreeMap::new();
        let ctx = ctx_with(&v, &e);
        assert!(!eval_condition(&cmp("{{token}}", CompareOp::Exists, None), &ctx));
        assert!(eval_condition(&cmp("{{token}}", CompareOp::Empty, None), &ctx));

        let v2 = vars(&[("token", "abc")]);
        let ctx2 = ctx_with(&v2, &e);
        assert!(eval_condition(&cmp("{{token}}", CompareOp::Exists, None), &ctx2));
        assert!(!eval_condition(&cmp("{{token}}", CompareOp::Empty, None), &ctx2));
    }

    #[test]
    fn all_any_short_circuit_and_empty_groups() {
        let v = vars(&[("a", "1"), ("b", "2")]);
        let e = BTreeMap::new();
        let ctx = ctx_with(&v, &e);
        let t = cmp("{{a}}", CompareOp::Eq, Some("1"));
        let f = cmp("{{b}}", CompareOp::Eq, Some("9"));
        assert!(eval_condition(&Condition::All(vec![t.clone(), t.clone()]), &ctx));
        assert!(!eval_condition(&Condition::All(vec![t.clone(), f.clone()]), &ctx));
        assert!(eval_condition(&Condition::Any(vec![f.clone(), t.clone()]), &ctx));
        assert!(!eval_condition(&Condition::Any(vec![f.clone(), f.clone()]), &ctx));
        // Empty groups: All → true (vacuous), Any → false.
        assert!(eval_condition(&Condition::All(vec![]), &ctx));
        assert!(!eval_condition(&Condition::Any(vec![]), &ctx));
    }

    #[test]
    fn missing_right_for_non_exists_op_treated_as_empty() {
        let v = vars(&[("x", "")]);
        let e = BTreeMap::new();
        let ctx = ctx_with(&v, &e);
        // left renders "" , right None → "" , eq → true
        assert!(eval_condition(&cmp("{{x}}", CompareOp::Eq, None), &ctx));
    }
}
```

> **NOTE**: 위 코드는 본문을 채운 형태(기본 경로)다. RED 체크포인트를 원하면 `eval_condition`/`eval_compare` 두 본문만 `todo!()`로 두고 Step 4에서 채워라.

- [ ] **Step 3: 모듈 등록 + re-export**

`crates/engine/src/lib.rs` 모듈 선언부(라인 1~9)에 알파벳 순서로 추가:

```rust
pub mod condition;
```

그리고 `eval_condition` re-export — 알파벳 순서로 `pub use aggregator::{...}`(라인 11) 바로 뒤, `pub use dataset::{...}`(라인 12) 앞에 추가:

```rust
pub use condition::eval_condition;
```

> (RED 경로를 택했다면 — 본문이 `todo!()`인 상태: `cargo test -p handicap-engine --lib condition::tests`가 panic(`not yet implemented`)으로 FAIL하는지 먼저 확인한 뒤 Step 4에서 본문을 채운다.)

- [ ] **Step 4: 테스트 GREEN + clippy 확인**

Run: `cargo test -p handicap-engine --lib condition::tests 2>&1 | tail -15`
Expected: `eq_ne_*` / `contains_*` / `matches_*` / `bad_regex_*` / `numeric_*` / `exists_empty_*` / `all_any_*` / `missing_right_*` 등 10개 PASS.

Run: `cargo clippy -p handicap-engine --all-targets -- -D warnings 2>&1 | tail -5`
Expected: 경고 없음(`eval_condition`이 `pub` + 재export라 dead_code 없음).

- [ ] **Step 5: 커밋**

```bash
git add Cargo.toml crates/engine/Cargo.toml crates/engine/src/condition.rs crates/engine/src/lib.rs
git commit -m "feat(engine): eval_condition + regex dep (9a)"
```

---

## Task 4: `IfStep`/`ElifBranch`/`Step::If` variant + 인터프리터 arm

`Step::If` variant를 추가하면 `match step`/`match self`가 non-exhaustive가 되어 `scenario.rs`(id/name)와 `runner.rs`(execute_steps) 모두 컴파일이 깨진다 → **같은 태스크에서 전부 채운다.** `eval_condition`이 이미 있으므로 인터프리터 arm을 곧장 구현하고, wiremock 통합 테스트로 분기 라우팅을 검증한다.

> **동작 표면 노트 (의도된 것)**: 컨트롤러 코드는 무변경이지만, `crates/controller/src/api/scenarios.rs`가 생성 시 `Scenario::from_yaml`로 검증하므로 — 9a 이후 컨트롤러는 손으로 작성한 `type: if` 시나리오를 **수용·실행**하게 된다(UI 9b가 아직 못 그리는데도). 이는 loop 선례와 동일한 의도된 passthrough다(스펙 §3.3: "controller는 9c까지 시나리오 의미를 검증하지 않고 YAML passthrough"). 컨트롤러 변경 불필요.

**Files:**
- Create: `crates/engine/tests/if_node.rs` (wiremock 통합 — TDD-guard 충족용으로 **먼저** 생성)
- Modify: `crates/engine/src/scenario.rs` (`IfStep`/`ElifBranch` + `Step::If` + id/name arms)
- Modify: `crates/engine/src/runner.rs:287` (`execute_steps`의 `Step::If` arm)
- Modify: `crates/engine/src/lib.rs:17-19` (re-export)

- [ ] **Step 1: 실패하는 wiremock 통합 테스트 파일 생성**

`crates/engine/tests/if_node.rs` 신규 작성. (이 파일이 working tree의 pending 테스트가 되어 이후 `runner.rs` 편집의 TDD-guard를 통과시킨다.)

```rust
//! `type: if` end-to-end: drives `execute_steps` branch selection against wiremock.
//!
//! The scenario is fixed-shape: an if node whose `then`/`elif`/`else` each contain
//! one distinct GET. We assert *which* step id recorded a request — the not-taken
//! branches never run, so they have no metric window at all. The lenient test proves
//! an unbound `{{var}}` in the condition falls through to `else` instead of killing
//! the run.
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::time::Duration;

use handicap_engine::{MetricFlush, RunPlan, Scenario, run_scenario};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const THEN_ID: &str = "01HX0000000000000000000002";
const ELIF_ID: &str = "01HX0000000000000000000003";
const ELSE_ID: &str = "01HX0000000000000000000004";

/// Stub /then, /elif, /else (all 200), run the scenario for one VU / short window,
/// return step_id -> total count.
async fn run_and_count(yaml: &str) -> HashMap<String, u64> {
    let scenario = Arc::new(Scenario::from_yaml(yaml).expect("parses"));
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(64);
    let plan = RunPlan {
        vus: 1,
        ramp_up: Duration::from_secs(0),
        duration: Duration::from_millis(400),
        env: BTreeMap::new(),
        loop_breakdown_cap: 0,
        data_binding: None,
    };
    let cancel = CancellationToken::new();
    let run = tokio::spawn(async move { run_scenario(scenario, plan, tx, cancel).await });
    let mut counts: HashMap<String, u64> = HashMap::new();
    let mut errors: u64 = 0;
    while let Some(f) = rx.recv().await {
        for w in f.windows {
            *counts.entry(w.step_id).or_default() += w.count;
            errors += w.error_count;
        }
    }
    run.await.expect("join").expect("run ok");
    assert_eq!(errors, 0, "no HTTP errors expected (all paths stubbed 200)");
    counts
}

/// Build the canonical if/elif/else scenario with caller-supplied `cond` (top if)
/// and `elif_cond` (single elif). All three branch bodies are static GETs.
fn scenario_yaml(base: &str, cond: &str, elif_cond: &str) -> String {
    format!(
        r#"
version: 1
name: branchy
variables:
  base: "{base}"
steps:
  - id: "01HX0000000000000000000001"
    name: branch
    type: if
    cond: {cond}
    then:
      - id: "{THEN_ID}"
        name: then-step
        type: http
        request: {{ method: GET, url: "{{{{base}}}}/then" }}
        assert: [ {{ status: 200 }} ]
    elif:
      - cond: {elif_cond}
        then:
          - id: "{ELIF_ID}"
            name: elif-step
            type: http
            request: {{ method: GET, url: "{{{{base}}}}/elif" }}
            assert: [ {{ status: 200 }} ]
    else:
      - id: "{ELSE_ID}"
        name: else-step
        type: http
        request: {{ method: GET, url: "{{{{base}}}}/else" }}
        assert: [ {{ status: 200 }} ]
"#
    )
}

async fn server() -> MockServer {
    let s = MockServer::start().await;
    for p in ["/then", "/elif", "/else"] {
        Mock::given(method("GET"))
            .and(path(p))
            .respond_with(ResponseTemplate::new(200))
            .mount(&s)
            .await;
    }
    s
}

#[tokio::test]
async fn then_branch_taken_when_cond_true() {
    let s = server().await;
    // top cond true → only /then runs.
    let yaml = scenario_yaml(
        &s.uri(),
        "{ left: \"1\", op: eq, right: \"1\" }",
        "{ left: \"a\", op: eq, right: \"a\" }",
    );
    let counts = run_and_count(&yaml).await;
    assert!(counts.get(THEN_ID).copied().unwrap_or(0) > 0, "then ran");
    assert_eq!(counts.get(ELIF_ID), None, "elif must not run");
    assert_eq!(counts.get(ELSE_ID), None, "else must not run");
}

#[tokio::test]
async fn elif_branch_taken_when_only_elif_true() {
    let s = server().await;
    // top false, elif true → only /elif runs.
    let yaml = scenario_yaml(
        &s.uri(),
        "{ left: \"1\", op: eq, right: \"2\" }",
        "{ left: \"a\", op: eq, right: \"a\" }",
    );
    let counts = run_and_count(&yaml).await;
    assert_eq!(counts.get(THEN_ID), None, "then must not run");
    assert!(counts.get(ELIF_ID).copied().unwrap_or(0) > 0, "elif ran");
    assert_eq!(counts.get(ELSE_ID), None, "else must not run");
}

#[tokio::test]
async fn else_branch_taken_when_all_false() {
    let s = server().await;
    // top false, elif false → /else runs.
    let yaml = scenario_yaml(
        &s.uri(),
        "{ left: \"1\", op: eq, right: \"2\" }",
        "{ left: \"a\", op: eq, right: \"b\" }",
    );
    let counts = run_and_count(&yaml).await;
    assert_eq!(counts.get(THEN_ID), None, "then must not run");
    assert_eq!(counts.get(ELIF_ID), None, "elif must not run");
    assert!(counts.get(ELSE_ID).copied().unwrap_or(0) > 0, "else ran");
}

#[tokio::test]
async fn unbound_var_in_cond_falls_through_lenient() {
    let s = server().await;
    // {{ghost}} is unbound → lenient "" , "" eq "x" false , elif "" eq "y" false → else.
    // A strict resolver would error and kill the run; lenient must just branch.
    let yaml = scenario_yaml(
        &s.uri(),
        "{ left: \"{{ghost}}\", op: eq, right: \"x\" }",
        "{ left: \"{{ghost}}\", op: eq, right: \"y\" }",
    );
    let counts = run_and_count(&yaml).await;
    assert!(
        counts.get(ELSE_ID).copied().unwrap_or(0) > 0,
        "unbound cond must fall through to else, run must not die"
    );
}
```

- [ ] **Step 2: 실패 확인 (parse 단계에서 RED)**

Run: `cargo test -p handicap-engine --test if_node 2>&1 | tail -15`
Expected: `Scenario::from_yaml(...).expect("parses")` panic — `type: if`가 아직 `Step`에 없어 역직렬화 실패. (모든 테스트 FAIL.)

- [ ] **Step 3: `IfStep`/`ElifBranch` 타입 + `Step::If` variant 추가**

`crates/engine/src/scenario.rs`의 `Step` enum(라인 40~45)에 variant 추가:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Step {
    Http(HttpStep),
    Loop(LoopStep),
    If(IfStep),
}
```

`impl Step`의 `id()`/`name()`(라인 47~60)에 arm 추가:

```rust
impl Step {
    pub fn id(&self) -> &str {
        match self {
            Step::Http(h) => &h.id,
            Step::Loop(l) => &l.id,
            Step::If(i) => &i.id,
        }
    }
    pub fn name(&self) -> &str {
        match self {
            Step::Http(h) => &h.name,
            Step::Loop(l) => &l.name,
            Step::If(i) => &i.name,
        }
    }
}
```

`LoopStep` 정의(라인 74~82) 바로 뒤에 `IfStep`/`ElifBranch` 추가:

```rust
/// Branch control-flow node. `then` runs when `cond` is true; otherwise the first
/// `elif` whose cond is true runs; otherwise `else` (a top-level catch-all). The
/// engine type uses `Vec<Step>` for free nesting (single-level / mutual-1-level is
/// the UI Zod gate — 9b/9c), same as `LoopStep.do_`. Per-variant
/// `deny_unknown_fields` (internal `type` tag does not enforce it — engine CLAUDE.md).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ElifBranch {
    pub cond: Condition,
    #[serde(rename = "then")]
    pub then_: Vec<Step>,
}
```

- [ ] **Step 4: lib.rs re-export 갱신**

`crates/engine/src/lib.rs:17-19`:

```rust
pub use scenario::{
    Assertion, Body, CompareOp, Condition, CookieJarMode, ElifBranch, HttpMethod, HttpStep, IfStep,
    LoopStep, Request, Scenario, Step,
};
```

- [ ] **Step 5: `execute_steps`에 `Step::If` arm 추가**

`crates/engine/src/runner.rs`의 `execute_steps` `match step`(라인 287~334)에서 `Step::Loop(lp) => { ... }` arm 뒤에 추가. 그리고 파일 상단 `use`에 `eval_condition`을 추가한다.

`crates/engine/src/runner.rs:15` 부근의 use 블록 수정:

```rust
use crate::condition::eval_condition;
use crate::scenario::{Scenario, Step};
```

`match step` 안에 arm 추가:

```rust
            Step::If(if_step) => {
                // Pick the branch. `ctx` borrows `iter_vars` immutably; scope it in a
                // block so the borrow ends before we pass `iter_vars` mutably to the
                // recursive call. `taken` borrows the scenario (`if_step`), not iter_vars.
                let taken: &[Step] = {
                    let ctx = TemplateContext {
                        vars: iter_vars,
                        env: env.as_ref(),
                        vu_id,
                        iter_id,
                        loop_index,
                    };
                    if eval_condition(&if_step.cond, &ctx) {
                        &if_step.then_
                    } else {
                        let mut branch: &[Step] = &if_step.else_;
                        for e in &if_step.elif {
                            if eval_condition(&e.cond, &ctx) {
                                branch = &e.then_;
                                break;
                            }
                        }
                        branch
                    }
                };
                // Pass the *incoming* loop_index through unchanged — the If arm makes no
                // new scope, so an if-in-loop's branch children still see the loop index
                // (spec §4). Box::pin the recursion (If/Loop arms only — hot path unboxed).
                let flow = Box::pin(execute_steps(
                    client, taken, iter_vars, agg, deadline, env, vu_id, iter_id, loop_index,
                    cancel,
                ))
                .await?;
                match flow {
                    StepFlow::Continue => {}
                    other => return Ok(other),
                }
            }
```

> **borrow 함정**: `ctx`(iter_vars 불변 차용)는 반드시 블록으로 스코핑해 `taken` 계산 후 drop돼야 한다. 그래야 이어지는 재귀 호출에 `iter_vars`를 `&mut`로 넘길 수 있다. 블록을 빼면 "cannot borrow `*iter_vars` as mutable because it is also borrowed as immutable" 컴파일 에러.
>
> **deadline/cancel 함정**: arm 안에 별도 deadline 체크를 넣지 마라. `execute_steps`의 `for step in steps` 루프 머리(라인 281~286)가 매 스텝 전에 이미 검사하고, 재귀 호출도 자기 루프 머리에서 검사하므로 "분기 진입 전 + 스텝 사이"가 모두 커버된다(loop arm은 `0..repeat`로 for-머리를 재진입 안 해 별도 검사가 필요했지만, if arm은 한 번만 재귀하므로 불필요).

- [ ] **Step 6: 통합 테스트 + 전체 엔진 테스트 GREEN 확인**

Run: `cargo test -p handicap-engine --test if_node 2>&1 | tail -15`
Expected: 4개 테스트(`then_/elif_/else_branch_taken`, `unbound_var_..._lenient`) PASS.

Run: `cargo test -p handicap-engine 2>&1 | tail -8`
Expected: 전체 엔진 테스트(unit + integration) PASS, 회귀 없음.

Run: `cargo clippy -p handicap-engine --all-targets -- -D warnings 2>&1 | tail -5`
Expected: 경고 없음.

- [ ] **Step 7: 커밋**

```bash
git add crates/engine/src/scenario.rs crates/engine/src/runner.rs crates/engine/src/lib.rs crates/engine/tests/if_node.rs
git commit -m "feat(engine): IfStep variant + execute_steps If arm (9a)"
```

---

## Task 5: proptest — condition / if-step round-trip

`Scenario` YAML round-trip 속성에 `if` 스텝(재귀 조건 트리 포함)을 끼워 넣어, 수동 serde 계약을 fuzz로 고정한다. 분기는 http-only로 한정(생성기 재귀 무한 방지 — loop의 `arb_step`와 동일 패턴).

**Files:**
- Modify: `crates/engine/tests/proptests.rs`

- [ ] **Step 1: import + 생성기 추가, `arb_step`에 if 포함**

`crates/engine/tests/proptests.rs`의 import(라인 9~11)를 수정해 새 타입을 가져온다:

```rust
use handicap_engine::scenario::{
    Assertion, Body, CompareOp, Condition, CookieJarMode, ElifBranch, Extract, HttpMethod,
    HttpStep, IfStep, LoopStep, Request, Step,
};
```

`arb_step`(라인 87~98) 정의 **앞**에 생성기들을 추가:

```rust
fn arb_compare_op() -> impl Strategy<Value = CompareOp> {
    prop_oneof![
        Just(CompareOp::Eq),
        Just(CompareOp::Ne),
        Just(CompareOp::Contains),
        Just(CompareOp::Matches),
        Just(CompareOp::Lt),
        Just(CompareOp::Gt),
        Just(CompareOp::Lte),
        Just(CompareOp::Gte),
        Just(CompareOp::Exists),
        Just(CompareOp::Empty),
    ]
}

fn arb_compare() -> impl Strategy<Value = Condition> {
    (
        "(\\{\\{[a-z]{1,5}\\}\\}|[a-z0-9]{0,8})",
        arb_compare_op(),
        option::of("[a-z0-9]{0,8}"),
    )
        .prop_map(|(left, op, right)| Condition::Compare { left, op, right })
}

// One level of grouping over leaves — bounded so the generator terminates.
fn arb_condition() -> impl Strategy<Value = Condition> {
    prop_oneof![
        3 => arb_compare(),
        1 => vec(arb_compare(), 1..3).prop_map(Condition::All),
        1 => vec(arb_compare(), 1..3).prop_map(Condition::Any),
    ]
}

fn arb_if_step() -> impl Strategy<Value = Step> {
    (
        "[0-9A-HJKMNP-TV-Z]{26}",
        arb_ident(),
        arb_condition(),
        vec(arb_http_step().prop_map(Step::Http), 1..3),
        vec(
            (
                arb_condition(),
                vec(arb_http_step().prop_map(Step::Http), 1..2),
            )
                .prop_map(|(cond, then_)| ElifBranch { cond, then_ }),
            0..2,
        ),
        vec(arb_http_step().prop_map(Step::Http), 0..2),
    )
        .prop_map(|(id, name, cond, then_, elif, else_)| {
            Step::If(IfStep {
                id,
                name,
                cond,
                then_,
                elif,
                else_,
            })
        })
}
```

`arb_step`의 `prop_oneof!`(라인 88~97)에 if를 한 줄 추가:

```rust
fn arb_step() -> impl Strategy<Value = Step> {
    prop_oneof![
        4 => arb_http_step().prop_map(Step::Http),
        1 => (
            "[0-9A-HJKMNP-TV-Z]{26}",
            arb_ident(),
            1u32..4u32,
            vec(arb_http_step().prop_map(Step::Http), 1..3),
        )
            .prop_map(|(id, name, repeat, do_)| Step::Loop(LoopStep { id, name, repeat, do_ })),
        1 => arb_if_step(),
    ]
}
```

- [ ] **Step 2: 기존 round-trip 속성이 if를 커버하는지 실행**

`scenario_yaml_round_trip`(라인 125~130)은 `arb_scenario` → `arb_step`을 쓰므로 if 스텝을 자동 포함한다. 별도 테스트 추가 불필요.

Run: `cargo test -p handicap-engine --test proptests 2>&1 | tail -15`
Expected: `scenario_yaml_round_trip` 포함 전부 PASS. (혹시 실패하면 수동 serde 계약 위반 — Task 1/4의 serde를 재점검.)

- [ ] **Step 3: 커밋**

```bash
git add crates/engine/tests/proptests.rs
git commit -m "test(engine): proptest if-step + condition round-trip (9a)"
```

---

## Task 6: 문서 — ADR-0023 + CLAUDE.md 갱신

스펙 §11: 구현 시작 시 ADR-0023 추가, 루트 CLAUDE.md "알아둘 결정들"·엔진 CLAUDE.md 함정 갱신.

> **`docs/roadmap.md`는 9a에서 갱신하지 않는다.** 스펙 §11이 roadmap 갱신(§A1 완료 이동)을 지시하지만, 9a만으로 Conditional 노드는 미완(9b UI / 9c 중첩 / 9d 메트릭 미구현)이므로 A1을 "완료"로 옮기면 거짓이 된다. roadmap 갱신은 **마지막 하위 슬라이스(9d)** 에서 한다. 9a는 ADR-0023 + 두 CLAUDE.md만 건드린다.

**Files:**
- Create: `docs/adr/0023-conditional-node.md`
- Modify: `CLAUDE.md` (root, "알아둘 결정들")
- Modify: `crates/engine/CLAUDE.md`

- [ ] **Step 1: ADR-0023 작성**

`docs/adr/0023-conditional-node.md` 신규 작성:

```markdown
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

## Considered Options

1. **평탄 if/elif/else + 구조화 조건 트리** (선택).
2. **재귀-중첩 else로 elif 표현** (`else: [ - type: if ... ]`) — catch-all else가
   깊이 묻혀 가독성 나쁨. 거절.
3. **조건식 문자열 DSL** (`if: "{{x}}==1 && ..."`) — 파서/검증/캔버스 빌더가 모두
   복잡, 구조화 트리로 충분. 거절(§연기).

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
- 분기 메트릭 breakdown 결정(전용 per-branch 카운터, cap 없음)은 9d 구현 시 이 ADR에 반영.

## Links

- Spec `docs/superpowers/specs/2026-05-30-slice-9-conditional-node-design.md`
- ADR-0020 (control-flow loop) — 같은 컨테이너/재귀 패턴
- ADR-0021 (loop 메트릭 breakdown) — 9d 분기 breakdown이 동형 파이프라인
- ADR-0014 (변수 표기) — `{{var}}` 흐름 변수, lenient 평가
- ADR-0017 (리포트 스코프) — 메트릭은 step_id 집계, 라벨은 UI
```

- [ ] **Step 2: 루트 CLAUDE.md "알아둘 결정들"에 한 줄 추가**

`CLAUDE.md`의 "알아둘 결정들" 목록에서 `0022` 줄 뒤에 추가:

```markdown
- **0023** Conditional 노드: 평탄 if/elif/else + 재귀 조건 트리 + lenient 평가 + 상호 1레벨 중첩 (9a 엔진 출하, UI/중첩/메트릭은 9b–9d)
```

- [ ] **Step 3: 엔진 CLAUDE.md 함정 노트 추가**

`crates/engine/CLAUDE.md`의 "## 시나리오 모델 / serde" 섹션 마지막 bullet 뒤에 추가:

```markdown
- **`Condition`(if 노드 조건)도 map-shape 수동 serde** (Slice 9a): `{all: [...]}`/`{any: [...]}`/`{left, op, right?}` 세 모양이라 `Body`/`Assertion`과 같은 부류 — derive 금지, 수동 `Serialize`/`Deserialize`. visitor는 키 존재(`all`/`any`/`left`)로 변형을 구별하고, 키 순서 무관(`{op, right, left}`도 OK)하게 `Option` 누적 후 disambiguate. `left`/`all`/`any` 어느 것도 없으면(예: `{op: eq}`) `de::Error::custom`로 거부. `CompareOp`는 데이터 없는 enum이라 derive + `rename_all="lowercase"`로 round-trip OK. `IfStep`/`ElifBranch`는 `HttpStep`/`LoopStep`처럼 개별 `#[serde(deny_unknown_fields)]`.
```

`crates/engine/CLAUDE.md`의 "## 제어 흐름 (loop, `execute_steps`)" 섹션에 추가:

```markdown
- **조건 평가는 lenient·infallible** (Slice 9a): `if`/`elif` 조건은 `template.rs::render_lenient`(strict `render`와 `render_inner(lenient)` 코어 공유)로 평가 — 미해결 `{{var}}`/`${NAME}`/loop 밖 `${loop_index}` → 빈 문자열, unclosed marker → literal, **절대 `Err` 안 냄**. `eval_condition`(`condition.rs`)은 이걸 써서 extract 실패/미바인딩이 run을 죽이는 대신 자연 분기하게 한다. 숫자 op(lt/gt/lte/gte)는 양쪽 f64 파싱(한쪽 실패 → false), `matches`는 `regex::Regex::new` 컴파일 실패 시 lenient false + warn(authoring 검증은 UI 9b). `exists`/`empty`는 미바인딩과 빈 문자열을 동일 취급.
- **`Step::If` arm은 들어온 `ctx`(loop_index)를 분기 자식에 그대로 넘긴다** (Slice 9a): 새 스코프를 만들지 않으므로 if-in-loop에서 분기 안 http가 바깥 loop의 `loop_index`를 본다. arm 안에서 `ctx`(iter_vars 불변 차용)는 **블록으로 스코핑**해 `taken: &[Step]` 계산 직후 drop — 안 그러면 이어지는 재귀에 `iter_vars`를 `&mut`로 못 넘긴다(borrow 에러). deadline/cancel은 `execute_steps` for-루프 머리가 이미 검사하므로 arm 안 추가 검사 불필요(loop arm과 달리 if는 재귀 1회).
```

- [ ] **Step 4: 검증 (docs-only — cargo 검사 skip)**

Run: `git diff --stat`
Expected: 3개 `.md` 파일만 변경. (pre-commit이 docs-only 커밋은 cargo 검사를 skip — 루트 CLAUDE.md.)

- [ ] **Step 5: 커밋**

```bash
git add docs/adr/0023-conditional-node.md CLAUDE.md crates/engine/CLAUDE.md
git commit -m "docs: ADR-0023 conditional node + engine gotchas (9a)"
```

---

## Self-Review (작성자 체크리스트 결과)

**Spec coverage (§8 9a 요구사항 ↔ 태스크):**
- `Condition`(수동 serde) + `CompareOp` → Task 1 ✓
- `IfStep`/`ElifBranch`, `Step::If` → Task 4 ✓
- `regex` 의존성 → Task 3 ✓
- lenient resolver(`template.rs`) → Task 2 ✓
- `eval_condition` → Task 3 ✓
- `execute_steps`의 `Step::If` arm → Task 4 ✓
- 테스트: scenario round-trip(수동 serde·중첩 AND/OR) → Task 1 + Task 5 ✓; `eval_condition` 단위(각 op·lenient·빈 그룹) → Task 3 ✓; wiremock 통합(then/elif/else) → Task 4 ✓; proptest(condition round-trip) → Task 5 ✓
- **UI·controller·proto·메트릭 무변경** → 어느 태스크도 `ui/`·`crates/controller`·`crates/proto`·`crates/worker`를 건드리지 않음 ✓
- ADR-0023 + CLAUDE.md → Task 6 ✓

**Type consistency:** `Condition`/`CompareOp`(Task 1) → `IfStep.cond`/`ElifBranch.cond`(Task 4) → `eval_condition(&Condition, &TemplateContext)`(Task 3) → proptest `arb_condition`(Task 5) 전부 동일 시그니처. `render_lenient(&str, &TemplateContext) -> String`(Task 2)를 `eval_compare`(Task 3)가 사용. `Step::If(IfStep)`의 필드명(`then_`/`elif`/`else_`, serde rename `then`/`else`)이 Task 4·5·통합 테스트에서 일관.

**Placeholder scan:** TBD/TODO/"적절한 에러 처리" 류 없음. 모든 코드 스텝에 완전한 코드 블록 포함. 테스트 id는 유효 ULID 모양(숫자만).

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-30-slice-9a-engine-conditional.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — 태스크마다 fresh subagent 디스패치, 태스크 사이 두 단계 리뷰(spec compliance → code quality), 빠른 반복. (워크트리에서 진행 시 subagent prompt 첫 줄에 `cd <worktree 절대경로>` 명시 — 루트 CLAUDE.md.)

**2. Inline Execution** — 이 세션에서 `executing-plans`로 배치 실행 + 체크포인트 리뷰.

**어느 방식으로 진행할까요?**
