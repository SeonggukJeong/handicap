# JSON 바디 캐스트 확장 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** JSON 바디에서 `${env}`/시스템 토큰도 `:num`/`:bool`/`:str`로 캐스트하고, 4번째 캐스트 `:json`(값을 JSON으로 파싱 — 객체/배열/숫자/불리언/문자열/null)을 추가하며, JSON 바디 편집기에 캐스트 문법 HelpTip을 단다.

**Architecture:** 엔진 `parse_cast_leaf`를 `{{flow}}`+`${env/sys}` 두 토큰군으로 일반화하고 `Cast::Json`+`coerce_json`을 추가한다(executor는 cast-타입·토큰-군 무관이라 `:json` arm 2개만 추가). UI `cast.ts`는 env 분기를 flow 분기와 동일 규칙으로 통일하고 `"json"` 키워드를 더한다. 발견성은 `JsonBodyField`에 `ko.glossary` 기반 HelpTip 1개.

**Tech Stack:** Rust(engine, `serde_json`) + TypeScript/React(Vite, Zod, vitest, RTL).

## Global Constraints

- **엄격(strict) 캐스트**: coerce 실패 시 부하 경로(`render_json_value`)는 `EngineError::CastFailed`, trace 경로(`render_json_collecting`)는 best-effort 문자열 폴백 — 기존 num/bool과 동형 lockstep. empty/unbound는 silent null이 **아니다**.
- **byte-identical**: 캐스트 없는 leaf·리터럴·기존 flow 캐스트(`{{x:num}}` 등) 출력 불변. `template.rs`(`render`/`render_collecting`)·proto·controller·worker·migration·`Body::Json` 모델·UI 모델(`model.ts`)/Zod/Zustand store 전부 **무변경**.
- **`${VAR:-default}` 비충돌**: 캐스트 키워드 비교 시 선행 `-`를 떼지 않는다(대시 잔류 → str/num/bool/json 어디에도 안 맞음). 경계 `${FOO:-bar:num}`은 마지막 콜론이 캐스트로 해석됨(엔진=UI 동일 판정).
- **flow 단일-토큰 가드는 현행 그대로**(`{{`/`}}` pair) — flow byte-identical. **env 가드는 신규**(내부 `{`/`}`/`$` 마커 거부).
- **lockstep**: 엔진 `parse_cast_leaf`(권위)와 UI `cast.ts` 검증이 같은 판정. 캐스트 키워드 = `["str","num","bool","json"]`.
- **한국어 copy**: 모든 사용자 노출 문구는 `ko.ts`(glossary/editor) 단일 소스(ADR-0035). HelpTip 본문은 `ko.glossary` 문자열 키들을 컴포넌트가 조립(JSX를 ko.ts 값에 넣지 않는다).
- **ULID in fixtures**: I/L/O/U 제외(이미 쓰는 `01HX0000000000000000000001` 패턴).
- **테스트-우선(tdd-guard)**: 각 task의 첫 production 편집 전 pending 테스트 파일이 있어야 한다 — 테스트부터 적는다.
- **커밋**: `git commit`은 단일 foreground 호출(`run_in_background:false`)·폴링 금지. 파이프(`| tail`/`| head`)·`--no-verify` 금지. 커밋 후 `git log -1`로 확인.

---

### Task 1: 엔진 — `${env}`/시스템 토큰 캐스트 + `:json` (R1–R5)

**Files:**
- Modify: `crates/engine/src/cast.rs` (`enum Cast`, `parse_cast_leaf`, 신규 `coerce_json`, `#[cfg(test)]` 테스트)
- Modify: `crates/engine/src/executor.rs` (import + `render_json_value`/`render_json_collecting`에 `Cast::Json` arm + `#[cfg(test)]` 테스트)
- (무변경, 참조만: `crates/engine/src/error.rs` `CastFailed { var, cast: &'static str, value }`, `crates/engine/src/template.rs`)

**Interfaces:**
- Consumes: 기존 `render(&str, &TemplateContext) -> Result<String>`, `render_collecting(&str, &TemplateContext, &mut Vec<String>) -> String`, `EngineError::CastFailed`.
- Produces:
  - `pub(crate) enum Cast { Str, Num, Bool, Json }`
  - `pub(crate) fn parse_cast_leaf(s: &str) -> Option<(String, Cast)>` — flow `{{name:cast}}` 또는 env/시스템 `${name:cast}`의 순수 단일 토큰이면 `(bare, cast)`(bare = `{{name}}` 또는 `${name}`), 그 외 `None`.
  - `pub(crate) fn coerce_json(v: &str) -> Option<serde_json::Value>` — `serde_json::from_str(v).ok()`.

- [ ] **Step 1: `cast.rs` 테스트부터 작성(RED)** — 기존 `parse_rejects_non_cast`에서 `${X:num}` 줄을 삭제하고, 아래 테스트를 `mod tests`에 추가한다.

`crates/engine/src/cast.rs`의 `parse_rejects_non_cast`에서 이 줄을 **삭제**:
```rust
        assert_eq!(parse_cast_leaf("${X:num}"), None); // env 토큰
```

`mod tests` 안(기존 테스트 뒤)에 **추가**:
```rust
    #[test]
    fn parse_env_and_system_token_casts() {
        assert_eq!(
            parse_cast_leaf("${PORT:num}"),
            Some(("${PORT}".into(), Cast::Num))
        );
        assert_eq!(
            parse_cast_leaf("${FLAG:bool}"),
            Some(("${FLAG}".into(), Cast::Bool))
        );
        assert_eq!(
            parse_cast_leaf("${ZIP:str}"),
            Some(("${ZIP}".into(), Cast::Str))
        );
        // 시스템 토큰도 같은 ${} 문법 → 공짜로 지원.
        assert_eq!(
            parse_cast_leaf("${vu_id:num}"),
            Some(("${vu_id}".into(), Cast::Num))
        );
    }

    #[test]
    fn parse_json_cast_flow_and_env() {
        assert_eq!(
            parse_cast_leaf("{{obj:json}}"),
            Some(("{{obj}}".into(), Cast::Json))
        );
        assert_eq!(
            parse_cast_leaf("${cfg:json}"),
            Some(("${cfg}".into(), Cast::Json))
        );
    }

    #[test]
    fn parse_env_default_is_not_a_cast() {
        // `${VAR:-default}` 기본값 연산자는 캐스트가 아님(키워드 후보에 선행 `-` 잔류).
        assert_eq!(parse_cast_leaf("${PORT:-8080}"), None);
        assert_eq!(parse_cast_leaf("${PORT:-num}"), None);
        // 경계(R3): default가 `:keyword`로 *끝나면* 마지막 콜론이 캐스트로 해석됨
        // (엔진=UI 동일 판정이라 seam 어긋남 없음).
        assert_eq!(
            parse_cast_leaf("${FOO:-bar:num}"),
            Some(("${FOO:-bar}".into(), Cast::Num))
        );
    }

    #[test]
    fn parse_env_rejects_multi_and_mixed() {
        assert_eq!(parse_cast_leaf("${a}${b}"), None); // 다중 토큰
        assert_eq!(parse_cast_leaf("x ${a:num} y"), None); // 혼합(순수 토큰 아님)
    }

    #[test]
    fn coerce_json_parses_any_json_value() {
        assert_eq!(coerce_json("{\"a\":1}"), Some(json!({"a":1})));
        assert_eq!(coerce_json("[1,2,3]"), Some(json!([1, 2, 3])));
        assert_eq!(coerce_json("42"), Some(json!(42)));
        assert_eq!(coerce_json("true"), Some(json!(true)));
        assert_eq!(coerce_json("null"), Some(serde_json::Value::Null)); // 변수 기반 null
        assert_eq!(coerce_json("\"hi\""), Some(json!("hi")));
    }

    #[test]
    fn coerce_json_rejects_invalid() {
        assert_eq!(coerce_json(""), None);
        assert_eq!(coerce_json("abc"), None); // bare word는 유효 JSON 아님
        assert_eq!(coerce_json("30 40"), None); // 후행 토큰
    }
```

- [ ] **Step 2: 테스트 실패 확인(RED)**

Run: `cargo test -p handicap-engine --no-run`
Expected: 컴파일 실패 — `Cast::Json` / `coerce_json` 미정의(`cannot find ... in this scope`). (Step 4의 executor 테스트도 같은 미정의 심볼을 참조하니 한 번에 RED.)

- [ ] **Step 3: `cast.rs` 구현** — `enum Cast`에 `Json` 추가, `parse_cast_leaf` 일반화, `coerce_json` 신규.

> **주의**: `Cast::Json`을 enum에 더하면 `executor.rs`의 `match parse_cast_leaf(s)`가 **non-exhaustive(컴파일 에러)**가 된다 — 크레이트는 Step 5(executor arm)까지 컴파일되지 않는다. Step 3–5 사이엔 테스트를 돌리지 말고 Step 6에서 처음 GREEN을 확인한다.

`enum Cast`를 교체:
```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Cast {
    Str,
    Num,
    Bool,
    Json,
}
```

`parse_cast_leaf` 전체를 교체:
```rust
/// `s`(trim 후)가 정확히 하나의 토큰(flow `{{ inner }}` 또는 env/시스템 `${ inner }`)이고
/// inner가 trailing `:num`/`:bool`/`:str`/`:json` 캐스트로 끝나면 `(bare_token, cast)` 반환.
/// `bare_token`은 캐스트 접미사를 뗀 `{{name}}` 또는 `${name}` 형태로, 호출부가 기존 `render`에
/// 그대로 넘긴다. 그 외(캐스트 없음·미지원 keyword·혼합·다중 토큰·`${VAR:-default}`)는 `None`.
pub(crate) fn parse_cast_leaf(s: &str) -> Option<(String, Cast)> {
    let t = s.trim();
    // flow `{{...}}` 또는 env/시스템 `${...}` — 순수 단일 토큰만.
    let (open, close, inner) = if let Some(i) = t.strip_prefix("{{").and_then(|x| x.strip_suffix("}}")) {
        // flow 가드(현행 byte-identical): 내부에 또 다른 brace 페어면 거부.
        if i.contains("{{") || i.contains("}}") {
            return None;
        }
        ("{{", "}}", i)
    } else if let Some(i) = t.strip_prefix("${").and_then(|x| x.strip_suffix('}')) {
        // env 가드(신규): 내부에 또 다른 토큰 마커(`{`/`}`/`$`)면 다중/비순수 → 거부.
        if i.contains('{') || i.contains('}') || i.contains('$') {
            return None;
        }
        ("${", "}", i)
    } else {
        return None;
    };
    let (name, kw) = inner.rsplit_once(':')?; // 콜론 없으면 캐스트 아님
    let cast = match kw.trim() {
        "str" => Cast::Str,
        "num" => Cast::Num,
        "bool" => Cast::Bool,
        "json" => Cast::Json,
        _ => return None, // 미지원 keyword·`-default` → 캐스트 아님
    };
    let bare = [open, name.trim(), close].concat();
    Some((bare, cast))
}
```

`coerce_bool` 아래에 **추가**:
```rust
/// 렌더된 문자열을 임의 JSON 값으로 파싱. 객체/배열/숫자/불리언/문자열/null 전부 허용.
/// 전체가 단일 JSON 값이어야 하며(후행 문자 거부·앞뒤 공백 허용), 실패 시 `None`.
pub(crate) fn coerce_json(v: &str) -> Option<serde_json::Value> {
    serde_json::from_str(v).ok()
}
```

- [ ] **Step 4: `executor.rs` 테스트 작성** — env 캐스트 + `:json`(strict/trace). (Step 2에서 이미 RED를 확인했으므로 추가 RED 실행 없이 바로 작성.)

`crates/engine/src/executor.rs`의 `mod tests`에 **추가**(기존 `json_cast_*` 테스트 뒤):
```rust
    #[test]
    fn json_cast_env_and_system_tokens() {
        let vars: BTreeMap<String, String> = BTreeMap::new();
        let env: BTreeMap<String, String> = [("PORT".into(), "5000".into())].into_iter().collect();
        let ctx = TemplateContext {
            vars: &vars,
            env: &env,
            vu_id: 7,
            iter_id: 0,
            loop_index: None,
        };
        let input = serde_json::json!({ "port": "${PORT:num}", "uid": "${vu_id:num}" });
        let out = render_json_value(&input, &ctx).unwrap();
        assert_eq!(out, serde_json::json!({ "port": 5000, "uid": 7 }));
    }

    #[test]
    fn json_cast_json_parses_object_and_null() {
        let vars: BTreeMap<String, String> = [
            ("obj".into(), r#"{"a":1,"b":[2,3]}"#.into()),
            ("z".into(), "null".into()),
        ]
        .into_iter()
        .collect();
        let env = BTreeMap::new();
        let ctx = TemplateContext {
            vars: &vars,
            env: &env,
            vu_id: 0,
            iter_id: 0,
            loop_index: None,
        };
        let input = serde_json::json!({ "o": "{{obj:json}}", "n": "{{z:json}}" });
        let out = render_json_value(&input, &ctx).unwrap();
        assert_eq!(out, serde_json::json!({ "o": {"a":1,"b":[2,3]}, "n": null }));
    }

    #[test]
    fn json_cast_json_failure_errors_strict() {
        let vars: BTreeMap<String, String> = [("x".into(), "abc".into())].into_iter().collect();
        let env = BTreeMap::new();
        let ctx = TemplateContext {
            vars: &vars,
            env: &env,
            vu_id: 0,
            iter_id: 0,
            loop_index: None,
        };
        let input = serde_json::json!({ "x": "{{x:json}}" });
        assert!(matches!(
            render_json_value(&input, &ctx),
            Err(EngineError::CastFailed { .. })
        ));
    }

    #[test]
    fn json_cast_json_trace_falls_back_to_string() {
        let vars: BTreeMap<String, String> = [("x".into(), "abc".into())].into_iter().collect();
        let env = BTreeMap::new();
        let ctx = TemplateContext {
            vars: &vars,
            env: &env,
            vu_id: 0,
            iter_id: 0,
            loop_index: None,
        };
        let input = serde_json::json!({ "x": "{{x:json}}" });
        let mut unbound = Vec::new();
        let out = render_json_collecting(&input, &ctx, &mut unbound);
        // trace는 lenient → coerce 실패 시 원문 문자열 보존(Err 없음).
        assert_eq!(out, serde_json::json!({ "x": "abc" }));
    }

    #[test]
    fn json_cast_json_does_not_leak_to_siblings() {
        // R9: `:json`은 그 leaf 하나만 파싱된 값으로 치환 — 형제 키로 새지 않는다.
        let vars: BTreeMap<String, String> =
            [("x".into(), r#"{"injected":true}"#.into())].into_iter().collect();
        let env = BTreeMap::new();
        let ctx = TemplateContext {
            vars: &vars,
            env: &env,
            vu_id: 0,
            iter_id: 0,
            loop_index: None,
        };
        let input = serde_json::json!({ "evil": "{{x:json}}", "sibling": "safe", "n": 1 });
        let out = render_json_value(&input, &ctx).unwrap();
        assert_eq!(
            out,
            serde_json::json!({ "evil": {"injected":true}, "sibling": "safe", "n": 1 })
        );
    }
```

- [ ] **Step 5: `executor.rs` 구현** — import + 두 경로에 `Cast::Json` arm. (이 arm을 더해야 Step 3에서 생긴 non-exhaustive match가 해소돼 크레이트가 컴파일된다.)

import 라인 교체(`crates/engine/src/executor.rs` 상단):
```rust
use crate::cast::{Cast, coerce_bool, coerce_json, coerce_num, parse_cast_leaf};
```

`render_json_value`의 `Some((bare, Cast::Bool)) => { ... }` arm **뒤, `None =>` arm 앞**에 추가:
```rust
            Some((bare, Cast::Json)) => {
                let r = render(&bare, ctx)?;
                coerce_json(&r).ok_or(EngineError::CastFailed {
                    var: bare,
                    cast: "json",
                    value: r,
                })?
            }
```

`render_json_collecting`의 `Some((bare, Cast::Bool)) => { ... }` arm **뒤, `None =>` arm 앞**에 추가:
```rust
            Some((bare, Cast::Json)) => {
                let r = render_collecting(&bare, ctx, unbound);
                coerce_json(&r).unwrap_or(Value::String(r)) // best-effort: 실패 시 문자열
            }
```

- [ ] **Step 6: 엔진 테스트 통과 확인(GREEN)** — 여기서 처음으로 크레이트가 컴파일된다(cast+executor 둘 다 반영됨).

Run: `cargo test -p handicap-engine`
Expected: PASS (전체 엔진 테스트 — 신규 + 기존).

- [ ] **Step 7: 워크스페이스 게이트**

Run: `cargo fmt && cargo clippy --workspace -- -D warnings && cargo test -p handicap-engine`
Expected: 모두 통과(경고 0).

- [ ] **Step 8: 커밋**

```bash
git add crates/engine/src/cast.rs crates/engine/src/executor.rs
git commit -m "feat(engine): JSON 바디 캐스트를 \${env}/시스템 토큰 + :json으로 확장 (ADR-0029)"
```
(단일 foreground 호출, 폴링 금지. 커밋 후 `git log -1`로 확인.)

---

### Task 2: UI 검증 — `${env}` 캐스트 통과 + `:json` (R6)

**Files:**
- Modify: `ui/src/scenario/__tests__/cast.test.ts` (env 거부 테스트 flip + 신규 케이스)
- Modify: `ui/src/scenario/cast.ts` (`CAST_KEYWORDS`에 `"json"`, env 분기를 flow 분기와 동일 규칙으로 통일, `PURE_ENV` 추가)

**Interfaces:**
- Consumes: 기존 `jsonBodyCastErrors(value: unknown): string[]`, `trailingCast(inner): string|null`, `BodyModel.superRefine`(`model.ts` 무변경).
- Produces: 동작 변경만 — `${name:num|bool|str|json}`(standalone)은 무에러, `${name:int}`은 "unknown cast", `"a ${name:num} b"`는 "standalone" 에러.

- [ ] **Step 1: `cast.test.ts` 갱신(RED)** — 기존 "flow-only v1" 거부 테스트를 통과 테스트로 flip + 신규.

`ui/src/scenario/__tests__/cast.test.ts`에서 이 테스트(라인 42–46)를 **삭제**:
```ts
  it("flags an env/system token cast (flow-only in v1)", () => {
    const errs = jsonBodyCastErrors({ n: "${COUNT:num}" });
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("env/system token cast not supported");
  });
```

같은 자리에 **추가**:
```ts
  it("accepts a valid env/system token cast", () => {
    expect(jsonBodyCastErrors({ n: "${COUNT:num}", uid: "${vu_id:num}" })).toEqual([]);
  });

  it("accepts a :json cast on flow and env tokens", () => {
    expect(jsonBodyCastErrors({ o: "{{obj:json}}", c: "${cfg:json}" })).toEqual([]);
  });

  it("flags an unknown cast keyword on an env token", () => {
    const errs = jsonBodyCastErrors({ n: "${COUNT:int}" });
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("unknown cast ':int'");
  });

  it("flags a cast inside a non-standalone env leaf", () => {
    const errs = jsonBodyCastErrors({ msg: "n is ${COUNT:num}!" });
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("standalone");
  });

  it("accepts the env default ending in a keyword as a cast (engine/UI lockstep)", () => {
    // `${FOO:-bar:num}` → 엔진·UI 모두 마지막 :num을 캐스트로 본다(R3 경계).
    expect(jsonBodyCastErrors({ x: "${FOO:-bar:num}" })).toEqual([]);
  });
```
(기존 `"does not flag the env default operator :-"` 테스트 — `${HOST:-num}` → `[]` — 는 **그대로 유지**.)

`"accepts valid pure casts and cast-less tokens"` 테스트의 `body`에 `:json` 케이스 한 줄 **추가**:
```ts
      j: "{{cfg:json}}",
```

- [ ] **Step 2: 테스트 실패 확인(RED)**

Run: `cd ui && pnpm test cast`
Expected: 신규 "accepts a valid env/system token cast"·":json cast"·"unknown cast on env"·"non-standalone env"·"FOO:-bar:num" 테스트 FAIL(현 코드는 env 캐스트를 "not supported"로 거부하거나 json을 unknown으로 봄).

- [ ] **Step 3: `cast.ts` 구현** — `"json"` 키워드 + env 분기 통일.

`CAST_KEYWORDS` 교체:
```ts
const CAST_KEYWORDS: readonly string[] = ["str", "num", "bool", "json"];
```

정규식 블록에 `PURE_ENV` **추가**(기존 `PURE_FLOW` 아래):
```ts
const PURE_ENV = /^\$\{([^}]*)\}$/;
```

`checkLeaf` 함수 전체를 교체:
```ts
function checkLeaf(s: string, errors: string[]): void {
  const trimmed = s.trim();
  const pureFlow = PURE_FLOW.exec(trimmed);
  const pureFlowInner = pureFlow ? pureFlow[1] : null;
  const pureEnv = PURE_ENV.exec(trimmed);
  const pureEnvInner = pureEnv ? pureEnv[1] : null;

  let m: RegExpExecArray | null;

  FLOW_TOKEN.lastIndex = 0;
  while ((m = FLOW_TOKEN.exec(s)) !== null) {
    const inner = m[1];
    const cast = trailingCast(inner);
    if (cast === null) continue; // 캐스트 시도 아님
    if (!CAST_KEYWORDS.includes(cast)) {
      errors.push(`unknown cast ':${cast}' in {{${inner}}} — use :num, :bool, :str, or :json`);
    } else if (pureFlowInner !== inner) {
      errors.push(`cast ':${cast}' only applies to a standalone value, not inside "${s}"`);
    }
  }

  ENV_TOKEN.lastIndex = 0;
  while ((m = ENV_TOKEN.exec(s)) !== null) {
    const inner = m[1];
    const cast = trailingCast(inner);
    if (cast === null) continue; // 캐스트 시도 아님(`${VAR:-default}` 포함)
    if (!CAST_KEYWORDS.includes(cast)) {
      errors.push(`unknown cast ':${cast}' in \${${inner}} — use :num, :bool, :str, or :json`);
    } else if (pureEnvInner !== inner) {
      errors.push(`cast ':${cast}' only applies to a standalone value, not inside "${s}"`);
    }
  }
}
```

파일 상단 doc 주석(라인 2–4)을 갱신(선택, 정확성):
```ts
/**
 * JSON request body의 캐스트 토큰 검증 (엔진: executor.rs / cast.rs와 짝).
 * STANDALONE JSON 문자열 leaf의 `{{var:num|bool|str|json}}`/`${var:num|bool|str|json}`을
 * 지원한다(flow·env/시스템 토큰 둘 다). 반환 배열이 비면 valid.
 * 캐스트 없는 토큰·리터럴·`${VAR:-default}`는 절대 flag하지 않는다.
 */
```

- [ ] **Step 4: 테스트 통과 확인(GREEN)**

Run: `cd ui && pnpm test cast`
Expected: PASS (신규 + 기존 cast 테스트 전부).

- [ ] **Step 5: UI 게이트**

Run: `cd ui && pnpm lint && pnpm test && pnpm build`
Expected: lint 경고 0, 전체 테스트 통과, `tsc -b && vite build` 성공.

- [ ] **Step 6: 커밋**

```bash
git add ui/src/scenario/cast.ts ui/src/scenario/__tests__/cast.test.ts
git commit -m "feat(ui): JSON 캐스트 검증을 \${env} 토큰 + :json으로 확장 (cast.ts)"
```

---

### Task 3: 발견성 — JSON 바디 편집기 HelpTip (R7)

**Files:**
- Modify: `ui/src/components/scenario/__tests__/Inspector.test.tsx` (HelpTip 노출 테스트)
- Modify: `ui/src/i18n/ko.ts` (`glossary`에 캐스트 안내 string 키 4개 + `editor`에 `jsonCastLabel`)
- Modify: `ui/src/components/scenario/Inspector.tsx` (`JsonBodyField`에 HelpTip)

**Interfaces:**
- Consumes: `HelpTip({ label, children })`(`ui/src/components/HelpTip.tsx`), `ko`(`ui/src/i18n/ko.ts`).
- Produces: `JsonBodyField`가 `kind==="json"`일 때만 렌더되므로 HelpTip은 JSON 바디에서만 노출.

- [ ] **Step 1: `Inspector.test.tsx` 테스트 작성(RED)** — JSON 바디 선택 시 HelpTip ⓘ + popover 본문 노출.

이 파일엔 이미 셋업 헬퍼 `loadAndSelect()`(라인 47: `setState(getInitialState())` + `loadFromString(VALID_YAML)` + `select("01HX0000000000000000000001")`)가 있다 — **이걸 그대로 쓴다**(렌더는 안 하므로 각 `it` 안에서 `render(<Inspector />)`를 따로 호출, `:66`/`:70` 패턴). `VALID_YAML`의 스텝은 body가 없어 종류 select가 "없음"(`bodyNone`)을 보인다. `ko`/`render`/`screen`/`userEvent`/`Inspector` import는 이 파일에 이미 있다. 파일 끝에 새 `describe` 추가:

```ts
describe("Inspector — JSON 바디 캐스트 HelpTip (R7)", () => {
  beforeEach(() => loadAndSelect());

  it("shows the cast HelpTip only when body kind is JSON", async () => {
    const user = userEvent.setup();
    render(<Inspector />);
    // 본문 종류 = JSON 선택 (기본은 "없음")
    await user.selectOptions(screen.getByDisplayValue(ko.editor.bodyNone), ko.editor.bodyJson);
    // ⓘ 버튼(aria-label = ko.editor.jsonCastLabel) → 클릭 시 popover 본문 노출
    const tip = screen.getByRole("button", { name: ko.editor.jsonCastLabel });
    expect(tip).toBeInTheDocument();
    await user.click(tip);
    expect(screen.getByText(ko.glossary.jsonCastIntro)).toBeInTheDocument();
  });

  it("does NOT show the cast HelpTip for form body", async () => {
    const user = userEvent.setup();
    render(<Inspector />);
    await user.selectOptions(screen.getByDisplayValue(ko.editor.bodyNone), ko.editor.bodyForm);
    expect(
      screen.queryByRole("button", { name: ko.editor.jsonCastLabel }),
    ).not.toBeInTheDocument();
  });
});
```
(주: `loadAndSelect`는 module-scoped store를 만지므로 `beforeEach`로 매 테스트 리셋·로드.)

- [ ] **Step 2: 테스트 실패 확인(RED)**

Run: `cd ui && pnpm test Inspector`
Expected: FAIL — `ko.editor.jsonCastLabel`/`ko.glossary.jsonCastIntro` 미정의(또는 HelpTip 미렌더).

- [ ] **Step 3: `ko.ts` 문구 추가** — glossary 4키 + editor 라벨.

`glossary`의 `varSys` 줄(라인 61) **뒤**에 추가:
```ts
    jsonCastIntro:
      "JSON 값에 변수를 넣을 땐 따옴표 안에 캐스트를 붙입니다 — 그래야 숫자/불리언/JSON으로 들어갑니다.",
    jsonCastTypes:
      "예: \"{{age:num}}\"→숫자, \"{{ok:bool}}\"→불리언, \"{{zip:str}}\"→문자열, \"{{obj:json}}\"→객체/배열/null.",
    jsonCastTokens: "흐름 변수 {{var}}와 환경·시스템 변수 ${VAR} 둘 다 캐스트할 수 있습니다.",
    jsonCastRule:
      "따옴표 안에 캐스트 토큰 하나만 있어야 합니다. :json은 유효한 JSON이어야 하니(객체·배열·숫자·불리언·null·따옴표 친 문자열) 평범한 문자열엔 :str을 쓰세요.",
```

`editor`의 `varCheatSheetLabel` 줄(라인 423) **뒤**(또는 body 키들 근처)에 추가:
```ts
    jsonCastLabel: "JSON 캐스트 도움말",
    jsonCastHint: "변수를 숫자·불리언·JSON으로",
```

- [ ] **Step 4: `Inspector.tsx`에 HelpTip 추가** — `JsonBodyField` 상단.

`JsonBodyField`의 `return (` 직후 최상위 `<div>` 첫 자식으로 HelpTip 행을 추가한다(textarea 위). 현재:
```tsx
  return (
    <div>
      <textarea
        aria-label={ko.editor.jsonBodyAria}
```
를 이렇게 교체:
```tsx
  return (
    <div>
      <div className="mb-1 flex items-center text-xs text-slate-500">
        <span>{ko.editor.jsonCastHint}</span>
        <HelpTip label={ko.editor.jsonCastLabel}>
          <span className="block">{ko.glossary.jsonCastIntro}</span>
          <span className="mt-1 block">{ko.glossary.jsonCastTypes}</span>
          <span className="mt-1 block">{ko.glossary.jsonCastTokens}</span>
          <span className="mt-1 block">{ko.glossary.jsonCastRule}</span>
        </HelpTip>
      </div>
      <textarea
        aria-label={ko.editor.jsonBodyAria}
```

`Inspector.tsx` 상단 import에 `HelpTip`이 없으면 추가(이미 `VarCheatSheet`를 import하나 `HelpTip` 자체는 별도):
```tsx
import { HelpTip } from "../HelpTip";
```
(import 경로는 `Inspector.tsx` 기준 — `VarCheatSheet`가 `"./VarCheatSheet"`이고 `HelpTip`은 `components/HelpTip.tsx`이므로 `"../HelpTip"`. 형제 import 깊이로 확인.)

- [ ] **Step 5: 테스트 통과 확인(GREEN)**

Run: `cd ui && pnpm test Inspector`
Expected: PASS (신규 HelpTip 테스트 + 기존 Inspector 테스트 전부).

- [ ] **Step 6: UI 게이트**

Run: `cd ui && pnpm lint && pnpm test && pnpm build`
Expected: lint 경고 0, 전체 테스트 통과, build 성공.

- [ ] **Step 7: 커밋**

```bash
git add ui/src/i18n/ko.ts ui/src/components/scenario/Inspector.tsx ui/src/components/scenario/__tests__/Inspector.test.tsx
git commit -m "feat(ui): JSON 바디 편집기에 캐스트 문법 HelpTip 추가 (발견성)"
```

---

### Task 4: ADR-0029 개정 (R10)

**Files:**
- Modify: `docs/adr/0029-json-body-type-cast-injection.md` (§범위·§결과)

**Interfaces:** 없음(docs-only).

- [ ] **Step 1: §범위 갱신** — 연기 목록에서 env/시스템·`:json`·변수 기반 null 제거.

`docs/adr/0029-json-body-type-cast-injection.md`의 `## 범위` 단락을 교체:
```markdown
## 범위

v1 = flow `{{}}` + `:num`/`:bool`(+`:str`) + JSON body 한정. **확장(2026-06-29)**: 같은
캐스트를 env/시스템 토큰 `${}`에도 적용 + `:json`(값을 임의 JSON으로 파싱 → 객체/배열/
숫자/불리언/문자열/null·변수 기반 null 포함). 잔여 연기: form/raw/URL 캐스트·empty/unbound→null
같은 nullable 규칙.
```

- [ ] **Step 2: §결과에 `:json` 안전성 한 줄 추가.**

`## 결과` 단락 끝에 추가:
```markdown

`:json`은 순수 단일 토큰 leaf 하나를 파싱된 단일 JSON 값으로 치환할 뿐이라, 형제 키로 새는
문자열 주입이 구조적으로 불가능하다(파싱→serde 재직렬화). env/시스템 토큰 캐스트는
`parse_cast_leaf`가 `${name}` bare를 재구성하고 기존 `render`가 해석 — executor·`render` 무변경.
```

- [ ] **Step 3: 커밋(docs fast-path)**

```bash
git add docs/adr/0029-json-body-type-cast-injection.md
git commit -m "docs(adr-0029): \${env}/시스템 토큰 캐스트 + :json + 변수 기반 null을 구현 범위로 개정"
```

---

## Self-Review

**Spec coverage (R1–R10):**
- R1(env/sys 토큰 파싱) → Task 1 Step 3 `parse_cast_leaf` + Step 1 테스트.
- R2(`Cast::Json`+`coerce_json`) → Task 1 Step 3(cast.rs) + executor arm(Step 5).
- R3(`:-default` 비충돌 + 경계) → Task 1 `parse_env_default_is_not_a_cast`(`${FOO:-bar:num}` 핀).
- R4(strict/trace lockstep) → Task 1 Step 4 `json_cast_json_failure_errors_strict` + `..._trace_falls_back_to_string`.
- R5(변수 기반 null) → Task 1 `coerce_json_parses_any_json_value`("null"→Null) + executor `json_cast_json_parses_object_and_null`.
- R6(UI 검증) → Task 2 전체.
- R7(HelpTip) → Task 3 전체.
- R8(byte-identical/무변경) → flow 가드 현행 유지(Task 1 Step 3) + 기존 테스트 green(각 게이트); model.ts/proto/controller/worker/migration 미터치.
- R9(`:json` 안전) → 구조적(단일 leaf 치환) + Task 1 Step 4 `json_cast_json_does_not_leak_to_siblings` + ADR §결과 + 최종 security-reviewer.
- R10(ADR 개정) → Task 4.

**Placeholder scan:** Task 3 Step 1은 기존 헬퍼 `loadAndSelect()`(Inspector.test.tsx:47) + `render(<Inspector />)`로 핀됨 — placeholder 없음. 그 외 모든 step에 실제 코드/명령/기대출력 존재.

**Type consistency:** `Cast::{Str,Num,Bool,Json}`·`coerce_json`·`parse_cast_leaf` 반환 `(String, Cast)`·`CAST_KEYWORDS`에 `"json"`·`ko.editor.jsonCastLabel`·`ko.glossary.jsonCast{Intro,Types,Tokens,Rule}`가 정의처(Task 1/2/3)와 사용처 전부 일치.

## Execution Handoff

(STOP-gate: 이 plan은 `REVIEW-GATE: APPROVED` 마커 + 커밋 후 `/clear`→fresh 세션에서 `superpowers:subagent-driven-development`로 task별 구현. 같은 세션 구현 금지.)

---

<!-- spec-plan-reviewer: spec 3R 수렴 clean APPROVE; plan 1R APPROVE-WITH-FIXES(A 테스트 헬퍼 핀·B R9 형제 불변식 테스트) → 2 must-fix 반영 + reviewer 사전 조건부 clean. -->
<!-- REVIEW-GATE: APPROVED -->
