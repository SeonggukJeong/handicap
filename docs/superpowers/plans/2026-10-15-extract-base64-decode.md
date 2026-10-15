# extract-base64-decode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 추출(`extract`)의 body/header/cookie 결과에 선택 후처리 `decode: base64 | jwt` + `claim: <JSONPath>`를 붙여, JWT payload의 claim이나 base64로 감싼 값을 변수로 만들 수 있게 한다.

**Architecture:** 엔진 `Extract` 세 변형에 `Option` 필드 2개를 추가하고(`skip_serializing_if`로 미사용 시 byte-identical), `extract.rs::evaluate`가 원문을 꺼낸 직후 `post_process`로 디코딩·claim 평가를 거친다. 부하/trace 두 경로가 같은 `evaluate`를 쓰므로 실행 경로 코드는 무변경. UI는 Zod 모델 1:1 확장 + 교차 규칙(`claim ⇒ decode`) superRefine + 추출 편집기 컨트롤 2개.

**Tech Stack:** Rust(serde/serde_yaml 0.9/serde_json_path/base64 0.22) · TypeScript/React(Zod 3.25, yaml 2.9, vitest+RTL)

<!-- spec-plan-reviewer: spec 4라운드 APPROVE · plan 2라운드 APPROVE (2026-10-15) -->
REVIEW-GATE: APPROVED

**Spec:** `docs/superpowers/specs/2026-10-15-extract-base64-decode-design.md` (R1–R12, §9 클레임 레저 C1–C17). spec이 정본 — 이 plan과 어긋나면 spec을 따르고 STOP·보고.

## 사용자 스토리 (US)

(spec 앞머리 블록 원문 — 매 brief에 첨부)

- **US1**: QA가 로그인 응답 본문의 JWT(`access_token`) 안에 든 사용자 ID를 다음 요청에 써야 할 때, 추출 편집기에서 디코딩 `JWT`와 claim 경로(`$.sub`)를 지정한다 — 성공하면 미리 실행 결과의 추출 칩에 `user_id=<claim 값>`이 보이고, 실제 부하 run에서 다음 요청의 URL/헤더에 그 값이 실려 나가는 것을 echo 서버 와이어로 확인한다. `Authorization: Bearer eyJ…` 형태로 헤더에서 꺼낸 JWT도 같은 결과를 낸다.
- **US2**: QA가 헤더·쿠키로 오는 base64 값을 쓸 때 형식(표준/URL-safe)이나 패딩을 고르지 않고 디코딩 `base64`만 지정한다 — 성공하면 표준±패딩·URL-safe±패딩 네 변형이 모두 같은 원문으로 디코딩돼 추출 칩에 보인다.
- **US3**: QA가 대상 값이 JWT/base64가 아니거나 claim이 없을 때 미리 실행을 돌린다 — 성공하면 그 스텝의 에러에서 **어느 변수의 추출이 왜 실패했는지**(디코딩 실패 / JWT 아님 / claim 없음)를 구분해 보고, 그 문구에 토큰 원문이나 디코딩된 값은 나오지 않는다.

## Global Constraints

- 워크트리: `/Users/sgj/develop/handicap/.claude/worktrees/extract-base64-decode` (브랜치 `worktree-extract-base64-decode`). 모든 명령은 이 디렉토리 기준.
- `decode`/`claim`이 없는 시나리오는 YAML·엔진 동작·에러 문구 **byte-identical**(R1·R7·R11).
- 에러 문구 = `"{var}: <사유>"`, 사유는 정확히 7종: `not base64` · `not UTF-8 text` · `not a JWT (expected 3 segments)` · `decoded value is not JSON` · `invalid claim path: {claim}` · `claim not found: {claim}` · `claim requires decode`. 하위 라이브러리 에러(`DecodeError`·`serde_json::Error`·`FromUtf8Error`·JSONPath 파싱 에러) Display를 **절대** 섞지 않는다(R6).
- 판정 순서(spec §4.3, 고정): ① claim⇒decode ② (jwt) `Bearer ` 제거·3조각 ③ base64 ④ UTF-8 ⑤ JSON(jwt이거나 claim 있을 때만) ⑥ claim 경로 파싱 ⑦ 쿼리. 원문 추출 실패(`no match`/`no header`/`no cookie`/`body not JSON`)는 ①보다 먼저이며 기존 문구 그대로.
- `Base64TextError`·`JwtShapeError`는 **데이터 없는 변형만**(리뷰 비차단 제안 — 하위 에러 텍스트 운반 경로 원천 차단).
- `status` 추출은 `decode`/`claim`을 받지 않는다(엔진=파싱 거부, UI=`.strict()` 거부, 편집기=컨트롤 미렌더).
- UI 문구는 `ui/src/i18n/ko.ts` 경유(ADR-0035). Zod 커스텀 메시지는 영어 고정 `"claim requires decode"`, issue `path: ["claim"]`.
- 컨트롤러·proto·워커·migration **코드 0-diff**. `Cargo.lock`·`desktop/src-tauri/Cargo.lock` 갱신은 허용(lock 동기화).
- 게이트: cargo-영향 커밋은 pre-commit이 전체 workspace 게이트(fmt·build·clippy `-D warnings`·nextest·doctest) — 커밋 명령은 **파이프 금지**, 결과는 `git log -1`로 확인. UI 커밋은 `pnpm lint && pnpm test && pnpm build` 게이트. `--no-verify` 금지.
- 리뷰 라우팅: Task 1·2(엔진 와이어·추출 경로)는 code-quality 리뷰 `model: opus`(path-gate). Task 3·4는 기본.

## Review Focus

spec이 함의하지만 개별 테스트가 놓치기 쉬운 입력 — 각 줄의 테스트는 소유 task에 추가돼 있다.

1. **실제 IdP JWT의 payload에 `-`/`_`가 섞인 경우** — URL-safe 판별이 실 토큰에서 동작해야 한다 → Task 2 `decode_base64_text_four_variants_same_text`가 `"hello?>~"`(표준 `/`·URL-safe `_`가 나오는 바이트)로 커버, R8 통합 테스트도 `URL_SAFE_NO_PAD`로 만든 payload 사용.
2. **헤더 값 앞뒤 공백·`Bearer` 뒤 공백 여러 개** — `"BEARER  <jwt>"`가 같은 결과 → Task 2 `jwt_bearer_prefix_variants`.
3. **claim이 숫자/객체를 가리킴** — body 추출과 같은 문자열화(`42`→`"42"`, 객체→JSON 텍스트) → Task 2 `claim_stringifies_like_body_extract`.
4. **편집기에서 디코딩을 고른 뒤 `없음`으로 되돌리거나 `status`로 바꿈** — YAML에 고아 `claim`/`decode`가 남지 않음 → Task 4 RTL 2건.
5. **변수명과 payload 키가 같은 이름(`user_id`)일 때 누출 검사 오탐** — 검사는 `{var}: ` 접두·echo된 claim을 제거한 뒤 수행 → Task 2 `assert_no_leak` 헬퍼.

---

## File Structure

| 파일 | 책임 | Task |
|---|---|---|
| `Cargo.toml` (workspace) | `base64 = "0.22"` workspace 의존 추가 | 2 |
| `crates/engine/Cargo.toml` | `base64.workspace = true` | 2 |
| `crates/engine/src/scenario.rs` | `Decode` enum, `Extract` 3변형 필드 추가, 왕복·엄격성 테스트 | 1 |
| `crates/engine/src/extract.rs` | `post_process`·`decode_base64_text`·`jwt_payload` + 단위 테스트 | 1(리터럴만), 2 |
| `crates/engine/src/executor.rs` | 테스트 리터럴 갱신(T1) · R8 통합 테스트(T2) | 1, 2 |
| `crates/engine/tests/proptests.rs` | `arb_extract`가 새 필드 생성 · 리터럴 갱신 | 1 |
| `ui/src/scenario/model.ts` | `ExtractDecodeModel`, `ExtractModel` 필드 + superRefine | 3 |
| `ui/src/scenario/problems.ts` · `ui/src/i18n/ko.ts` | 게이트 한국어 매핑 | 3 |
| `ui/src/scenario/yamlDoc.ts` | `setStepExtract` Edit 타입을 `ReadonlyArray<Extract>`로 | 3 |
| `ui/src/components/scenario/Inspector.tsx` · `ko.ts` | ExtractEditor 디코딩 선택·claim 입력 | 4 |

---

### Task 1: 엔진 와이어 모델 — `Decode` + `Extract` 필드 (R1)

**Files:**
- Modify: `crates/engine/src/scenario.rs` (`Extract` enum ~line 385, pattern at ~654, literals at ~1286·~1313, 테스트 모듈)
- Modify: `crates/engine/src/extract.rs` (evaluate의 match arm 패턴 + 테스트 리터럴 10곳)
- Modify: `crates/engine/src/executor.rs` (테스트 리터럴 ~665·~711)
- Modify: `crates/engine/tests/proptests.rs` (`arb_extract` ~41, 리터럴 ~271-273)

**Interfaces:**
- Produces: `pub enum crate::scenario::Decode { Base64, Jwt }` (serde lowercase, `Copy`), `Extract::{Body{var,path,decode,claim}, Header{var,name,decode,claim}, Cookie{var,name,decode,claim}, Status{var}}` — `decode: Option<Decode>`, `claim: Option<String>`.

- [ ] **Step 1: 실패 테스트 작성** — `scenario.rs` 테스트 모듈(`rejects_extract_with_unknown_from` 바로 뒤)에 추가:

```rust
    #[test]
    fn extract_decode_fields_round_trip() {
        let y = r#"
version: 1
name: x
steps:
  - id: "01HX0000000000000000000001"
    name: x
    type: http
    request: { method: GET, url: "/" }
    extract:
      - var: uid
        from: body
        path: "$.access_token"
        decode: jwt
        claim: "$.sub"
      - var: raw
        from: header
        name: X-Blob
        decode: base64
      - var: c
        from: cookie
        name: SID
        decode: base64
        claim: "$.k"
"#;
        let s = Scenario::from_yaml(y).expect("parses");
        let Step::Http(step) = &s.steps[0] else {
            panic!("expected http step");
        };
        assert_eq!(
            step.extract[0],
            Extract::Body {
                var: "uid".into(),
                path: "$.access_token".into(),
                decode: Some(Decode::Jwt),
                claim: Some("$.sub".into()),
            }
        );
        assert_eq!(
            step.extract[1],
            Extract::Header {
                var: "raw".into(),
                name: "X-Blob".into(),
                decode: Some(Decode::Base64),
                claim: None,
            }
        );
        let yaml = s.to_yaml().unwrap();
        assert!(yaml.contains("decode: jwt"), "{yaml}");
        assert!(yaml.contains("decode: base64"), "{yaml}");
        assert_eq!(Scenario::from_yaml(&yaml).unwrap(), s);
    }

    #[test]
    fn extract_without_decode_serializes_no_new_keys() {
        let s = Scenario::from_yaml(TWO_STEP_FIXTURE).unwrap();
        let yaml = s.to_yaml().unwrap();
        assert!(!yaml.contains("decode"), "{yaml}");
        assert!(!yaml.contains("claim"), "{yaml}");
    }

    #[test]
    fn rejects_status_extract_with_decode() {
        let y = r#"
version: 1
name: x
steps:
  - id: "01HX0000000000000000000001"
    name: x
    type: http
    request: { method: GET, url: "/" }
    extract:
      - var: s
        from: status
        decode: base64
"#;
        assert!(Scenario::from_yaml(y).is_err());
    }

    #[test]
    fn rejects_unknown_decode_value() {
        let y = r#"
version: 1
name: x
steps:
  - id: "01HX0000000000000000000001"
    name: x
    type: http
    request: { method: GET, url: "/" }
    extract:
      - var: t
        from: body
        path: "$.a"
        decode: base64url
"#;
        assert!(Scenario::from_yaml(y).is_err());
    }
```

- [ ] **Step 2: RED 확인** — `cargo test -p handicap-engine --lib scenario::tests::extract_decode 2>&1 | tail -5` → 컴파일 에러(`Decode` 없음, 변형에 `decode` 필드 없음). (컴파일 실패 = RED. 단 `rejects_status_extract_with_decode`/`rejects_unknown_decode_value`는 변경 전에도 통과하는 **엄격성 핀**이다 — 회귀 가드이지 RED 대상이 아님.)

- [ ] **Step 3: 모델 구현** — `scenario.rs`의 `Extract` 정의를 교체:

```rust
/// Post-extract decoding (extract-base64-decode). Data-less enum → derive
/// round-trips in serde_yaml 0.9 (same class as `CompareOp`/`CookieJarMode`).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Decode {
    Base64,
    Jwt,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "from", rename_all = "lowercase", deny_unknown_fields)]
pub enum Extract {
    Body {
        var: String,
        path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        decode: Option<Decode>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        claim: Option<String>,
    },
    Header {
        var: String,
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        decode: Option<Decode>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        claim: Option<String>,
    },
    Cookie {
        var: String,
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        decode: Option<Decode>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        claim: Option<String>,
    },
    // No decode for status: a 3-digit code has nothing to decode (spec §3.6);
    // enum-level deny_unknown_fields rejects `decode` here at parse time.
    Status { var: String },
}
```

(기존 `Extract` 위의 doc 주석이 있으면 유지. `impl Extract { fn var }`는 `..` 패턴이라 무변경.)

- [ ] **Step 4: 컴파일러가 가리키는 사이트 전수 수정** — `cargo build -p handicap-engine --tests 2>&1 | grep -E "^error" -A6 | head -80`로 목록을 얻고 기계적으로 고친다:
  - **struct 리터럴**(`Extract::Body { var: …, path: … }` 등): `decode: None, claim: None,`을 추가. 대상(2026-10-15 실측): `extract.rs` 테스트 10곳, `scenario.rs` ~1286·~1313, `executor.rs` ~665·~711, `tests/proptests.rs` ~271-272. `Status`는 무변경.
  - **필드를 나열하는 패턴**: `..`를 붙인다 — `scenario.rs` ~654 `Extract::Body { var, path } =>` → `Extract::Body { var, path, .. } =>`.
  - **`extract.rs::evaluate`의 match arm**: 이 task에선 동작 무변경 — `Extract::Body { var, path } =>` → `Extract::Body { var, path, .. } =>`, Header/Cookie도 `..` 추가(디코딩은 Task 2).
  - **단언·기대값은 한 줄도 바꾸지 않는다**(R7). `git diff -U0 | grep -E '^[+-].*assert'` 출력이 Step 5 시점에 Step 1에서 추가한 테스트의 assert 줄뿐이어야 한다.

- [ ] **Step 5: proptests 확장** — `tests/proptests.rs`의 import에 `Decode`를 추가(기존 `use handicap_engine::scenario::{ … }` 목록에)하고 `arb_extract`를 교체:

```rust
fn arb_decode() -> impl Strategy<Value = Decode> {
    prop_oneof![Just(Decode::Base64), Just(Decode::Jwt)]
}

fn arb_extract() -> impl Strategy<Value = Extract> {
    prop_oneof![
        (
            arb_ident(),
            "[a-zA-Z_][a-zA-Z0-9_.$]{0,16}",
            option::of(arb_decode()),
            option::of("\\$\\.[a-z]{1,8}"),
        )
            .prop_map(|(var, path, decode, claim)| Extract::Body {
                var,
                path: format!("${path}"),
                decode,
                claim,
            }),
        (
            arb_ident(),
            "[A-Za-z][A-Za-z0-9-]{0,20}",
            option::of(arb_decode()),
            option::of("\\$\\.[a-z]{1,8}"),
        )
            .prop_map(|(var, name, decode, claim)| Extract::Header {
                var,
                name,
                decode,
                claim
            }),
        (
            arb_ident(),
            "[A-Za-z][A-Za-z0-9_]{0,20}",
            option::of(arb_decode()),
            option::of("\\$\\.[a-z]{1,8}"),
        )
            .prop_map(|(var, name, decode, claim)| Extract::Cookie {
                var,
                name,
                decode,
                claim
            }),
        arb_ident().prop_map(|var| Extract::Status { var }),
    ]
}
```

(serde 왕복 프로퍼티라 `claim`만 있고 `decode` 없는 조합도 **와이어상 유효**하게 생성된다 — 교차 규칙은 평가 시점 검사(Task 2)이지 파싱 규칙이 아니므로 맞다.)

- [ ] **Step 6: GREEN** — `cargo test -p handicap-engine 2>&1 | grep -E "test result|FAILED|panicked" | head -20` → 전부 ok. `cargo clippy -p handicap-engine --tests -- -D warnings 2>&1 | tail -3` 클린. `cargo build --workspace --tests 2>&1 | tail -2` 클린(컨트롤러·워커가 `Extract` 리터럴을 안 쓰는지 재확인 — spec C1).

- [ ] **Step 7: 커밋 (단일 FOREGROUND, timeout 600000)** — 먼저 `cargo fmt --all && cargo fmt --all --check; echo fmt=$?`(=0; 인라인 코드는 rustfmt-clean을 보장하지 않으므로 반드시 포맷 후 커밋).

```bash
git add crates/engine/src/scenario.rs crates/engine/src/extract.rs crates/engine/src/executor.rs crates/engine/tests/proptests.rs
git diff --cached --name-only
git commit -m "feat(engine): Extract에 decode/claim 와이어 필드 추가 (R1)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git log -1 --oneline
```

---

### Task 2: 엔진 디코딩·claim 처리 + 부하/trace 동치 (R3–R8)

**Files:**
- Modify: `Cargo.toml` (`[workspace.dependencies]`), `crates/engine/Cargo.toml` (`[dependencies]`)
- Modify: `crates/engine/src/extract.rs`
- Modify: `crates/engine/src/executor.rs` (테스트 모듈에 R8 통합 테스트)

**Interfaces:**
- Consumes: Task 1의 `Decode`·`Extract` 필드.
- Produces: `extract::evaluate` 시그니처 **무변경**. 모듈-private `fn post_process(var: &str, raw: String, decode: Option<Decode>, claim: Option<&str>) -> Result<String>`, `fn decode_base64_text(s: &str) -> std::result::Result<String, Base64TextError>`, `fn jwt_payload(s: &str) -> std::result::Result<&str, JwtShapeError>`.

- [ ] **Step 1: 의존성** — 루트 `Cargo.toml` `[workspace.dependencies]`에 알파벳 위치로 `base64 = "0.22"`, `crates/engine/Cargo.toml` `[dependencies]`에 `base64.workspace = true`. `cargo build -p handicap-engine 2>&1 | tail -2` → `Cargo.lock`이 기존 `base64 0.22.1`로 해석되는지 확인(`git diff Cargo.lock | head -20` — 새 패키지 블록 없이 engine 의존 목록에 `"base64 0.22.1"` 한 줄 추가만 기대).

- [ ] **Step 2: 실패 테스트 작성** — `extract.rs` `mod tests`에 추가(기존 테스트 뒤). 상단 `use super::*;` 아래에 `use crate::scenario::Decode; use base64::Engine as _; use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD};`:

```rust
    fn header_facts<'a>(headers: &'a [(String, String)]) -> ResponseFacts<'a> {
        ResponseFacts {
            status: 200,
            headers,
            set_cookies: &[],
            body: b"",
        }
    }

    fn hdr(var: &str, decode: Decode, claim: Option<&str>) -> Extract {
        Extract::Header {
            var: var.into(),
            name: "X-V".into(),
            decode: Some(decode),
            claim: claim.map(Into::into),
        }
    }

    fn eval_header(value: &str, x: Extract) -> Result<BTreeMap<String, String>> {
        let headers = vec![("X-V".to_string(), value.to_string())];
        evaluate(&[x], &header_facts(&headers))
    }

    fn err_msg(r: Result<BTreeMap<String, String>>) -> String {
        match r {
            Err(EngineError::ExtractFailed(m)) => m,
            other => panic!("expected ExtractFailed, got {other:?}"),
        }
    }

    /// R6: strip author text (`{var}: ` prefix + echoed claim) then require
    /// no 4-char window of any secret to remain. Fixtures are chosen so no
    /// secret shares a 4-char run with the fixed reason literals.
    fn assert_no_leak(msg: &str, var: &str, claim: Option<&str>, secrets: &[&str]) {
        let mut rest = msg
            .strip_prefix(&format!("{var}: "))
            .unwrap_or_else(|| panic!("missing var prefix: {msg:?}"))
            .to_string();
        if let Some(c) = claim {
            rest = rest.replace(c, "");
        }
        for s in secrets {
            let chars: Vec<char> = s.chars().collect();
            for w in chars.windows(4) {
                let sub: String = w.iter().collect();
                assert!(!rest.contains(&sub), "leaked {sub:?} in {msg:?}");
            }
        }
    }

    fn jwt_with(payload_json: &str) -> String {
        format!(
            "eyJhbGciOiJub25lIn0.{}.c2ln",
            URL_SAFE_NO_PAD.encode(payload_json)
        )
    }

    #[test]
    fn decode_base64_text_four_variants_same_text() {
        let original = "hello?>~"; // bytes that make '/' (standard) vs '_' (url-safe)
        let variants = [
            STANDARD.encode(original),
            STANDARD_NO_PAD.encode(original),
            URL_SAFE.encode(original),
            URL_SAFE_NO_PAD.encode(original),
        ];
        assert!(variants[0].contains('/') && variants[2].contains('_'));
        for v in variants {
            let out = eval_header(&v, hdr("t", Decode::Base64, None)).unwrap();
            assert_eq!(out.get("t").map(String::as_str), Some(original), "variant {v}");
        }
    }

    #[test]
    fn decode_base64_edge_pins() {
        // over-padding is tolerated by trim_end_matches('=')
        let out = eval_header("QQ=====", hdr("t", Decode::Base64, None)).unwrap();
        assert_eq!(out.get("t").map(String::as_str), Some("A"));
        // non-canonical trailing bits rejected by base64 0.22 defaults
        let m = err_msg(eval_header("AAAAQR", hdr("t", Decode::Base64, None)));
        assert_eq!(m, "t: not base64");
    }

    #[test]
    fn decode_base64_failures_are_value_free() {
        for (input, reason) in [
            ("ab+c-d__", "not base64"), // mixed alphabets
            ("!!!!", "not base64"),
            ("/w==", "not UTF-8 text"), // 0xFF
        ] {
            let m = err_msg(eval_header(input, hdr("blob", Decode::Base64, None)));
            assert_no_leak(&m, "blob", None, &[input]);
            assert_eq!(m, format!("blob: {reason}"), "input {input}");
        }
    }

    #[test]
    fn jwt_bearer_prefix_variants() {
        let jwt = jwt_with(r#"{"sub":"u-9f3k"}"#);
        for v in [
            jwt.clone(),
            format!("Bearer {jwt}"),
            format!("bearer {jwt}"),
            format!("BEARER  {jwt}"),
        ] {
            let out = eval_header(&v, hdr("uid", Decode::Jwt, Some("$.sub"))).unwrap();
            assert_eq!(out.get("uid").map(String::as_str), Some("u-9f3k"), "{v}");
        }
    }

    #[test]
    fn jwt_without_claim_yields_payload_text_verbatim() {
        let payload = r#"{"sub":"u-9f3k","n":42}"#;
        let out = eval_header(&jwt_with(payload), hdr("p", Decode::Jwt, None)).unwrap();
        assert_eq!(out.get("p").map(String::as_str), Some(payload));
    }

    #[test]
    fn jwt_shape_and_json_failures_are_value_free() {
        for input in ["aaaa.bbbb", "aaaa.bbbb.cccc.dddd"] {
            let m = err_msg(eval_header(input, hdr("uid", Decode::Jwt, None)));
            assert_no_leak(&m, "uid", None, &[input]);
            assert_eq!(m, "uid: not a JWT (expected 3 segments)");
        }
        let token = format!("eyJh.{}.c2ln", URL_SAFE_NO_PAD.encode("plain text"));
        let m = err_msg(eval_header(&token, hdr("uid", Decode::Jwt, None)));
        assert_no_leak(&m, "uid", None, &[&token, "plain text"]);
        assert_eq!(m, "uid: decoded value is not JSON");
    }

    #[test]
    fn claim_stringifies_like_body_extract() {
        let jwt = jwt_with(r#"{"sub":"u-9f3k","n":42,"o":{"k":"zz"}}"#);
        let cases = [("$.sub", "u-9f3k"), ("$.n", "42"), ("$.o", r#"{"k":"zz"}"#)];
        for (claim, want) in cases {
            let out = eval_header(&jwt, hdr("v", Decode::Jwt, Some(claim))).unwrap();
            assert_eq!(out.get("v").map(String::as_str), Some(want), "{claim}");
        }
    }

    #[test]
    fn claim_failures_are_value_free() {
        let payload = r#"{"sub":"u-9f3k"}"#;
        let jwt = jwt_with(payload);
        let m = err_msg(eval_header(&jwt, hdr("uid", Decode::Jwt, Some("$["))));
        assert_no_leak(&m, "uid", Some("$["), &[&jwt, payload]);
        assert_eq!(m, "uid: invalid claim path: $[");

        let m = err_msg(eval_header(&jwt, hdr("uid", Decode::Jwt, Some("$.nope"))));
        assert_no_leak(&m, "uid", Some("$.nope"), &[&jwt, payload]);
        assert_eq!(m, "uid: claim not found: $.nope");

        // base64 + claim on non-JSON decoded text
        let blob = STANDARD.encode("plain text");
        let m = err_msg(eval_header(&blob, hdr("b", Decode::Base64, Some("$.k"))));
        assert_no_leak(&m, "b", Some("$.k"), &[&blob, "plain text"]);
        assert_eq!(m, "b: decoded value is not JSON");
    }

    #[test]
    fn claim_without_decode_is_rejected_at_eval() {
        let headers = vec![("X-V".to_string(), "zq9Xw8".to_string())];
        let x = Extract::Header {
            var: "h".into(),
            name: "X-V".into(),
            decode: None,
            claim: Some("$.k".into()),
        };
        let m = err_msg(evaluate(&[x], &header_facts(&headers)));
        assert_no_leak(&m, "h", Some("$.k"), &["zq9Xw8"]);
        assert_eq!(m, "h: claim requires decode");
    }

    #[test]
    fn cookie_and_body_paths_decode_too() {
        let set_cookies = vec![format!("SID={}; Path=/", STANDARD.encode("tok:42"))];
        let facts = ResponseFacts {
            status: 200,
            headers: &[],
            set_cookies: &set_cookies,
            body: b"",
        };
        let x = Extract::Cookie {
            var: "sid".into(),
            name: "SID".into(),
            decode: Some(Decode::Base64),
            claim: None,
        };
        let out = evaluate(&[x], &facts).unwrap();
        assert_eq!(out.get("sid").map(String::as_str), Some("tok:42"));

        let body = format!(r#"{{"access_token":"{}"}}"#, jwt_with(r#"{"sub":"u-9f3k"}"#));
        let x = Extract::Body {
            var: "uid".into(),
            path: "$.access_token".into(),
            decode: Some(Decode::Jwt),
            claim: Some("$.sub".into()),
        };
        let out = evaluate(&[x], &body_facts(&body)).unwrap();
        assert_eq!(out.get("uid").map(String::as_str), Some("u-9f3k"));
    }

    #[test]
    fn raw_extract_failure_precedes_decode_and_keeps_old_text() {
        // Fixed pin (passes before the feature too). R7 + order: missing header fails before any decode step, old wording.
        let x = Extract::Header {
            var: "x".into(),
            name: "X-None".into(),
            decode: Some(Decode::Jwt),
            claim: Some("$.sub".into()),
        };
        let m = err_msg(evaluate(&[x], &body_facts("")));
        assert_eq!(m, "no header: X-None");
    }
```

- [ ] **Step 3: RED 확인** — `cargo test -p handicap-engine --lib extract::tests 2>&1 | grep -E "test result|FAILED|panicked" | head -20` → 새 테스트들이 FAIL(디코딩 미구현이라 원문이 그대로 들어가거나 `claim requires decode` 미발화). 기존 테스트는 ok. 단 `raw_extract_failure_precedes_decode_and_keeps_old_text`는 **고정 핀**(변경 전에도 통과 — 순서·기존 문구 보존 가드)이라 이 시점 통과가 정상.

- [ ] **Step 4: 구현** — `extract.rs` 상단 import:

```rust
use base64::Engine as _;
use base64::engine::general_purpose::{STANDARD_NO_PAD, URL_SAFE_NO_PAD};

use crate::error::{EngineError, Result};
use crate::scenario::{Decode, Extract};
```

`evaluate`의 세 arm 교체(Status arm 무변경):

```rust
            Extract::Body {
                var,
                path,
                decode,
                claim,
            } => {
                let json = match body_json.as_ref() {
                    Some(v) => v,
                    None => {
                        let v: serde_json::Value =
                            serde_json::from_slice(facts.body).map_err(|e| {
                                EngineError::ExtractFailed(format!("body not JSON: {e}"))
                            })?;
                        body_json = Some(v);
                        body_json.as_ref().unwrap()
                    }
                };
                let value = jsonpath_first(json, path)
                    .ok_or_else(|| EngineError::ExtractFailed(format!("no match: {path}")))?;
                let v = post_process(var, stringify(&value), *decode, claim.as_deref())?;
                out.insert(var.clone(), v);
            }
            Extract::Header {
                var,
                name,
                decode,
                claim,
            } => {
                let value = facts
                    .headers
                    .iter()
                    .find(|(k, _)| k.eq_ignore_ascii_case(name))
                    .map(|(_, v)| v.clone())
                    .ok_or_else(|| EngineError::ExtractFailed(format!("no header: {name}")))?;
                let v = post_process(var, value, *decode, claim.as_deref())?;
                out.insert(var.clone(), v);
            }
            Extract::Cookie {
                var,
                name,
                decode,
                claim,
            } => {
                let value = facts
                    .set_cookies
                    .iter()
                    .find_map(|sc| parse_cookie_value(sc, name))
                    .ok_or_else(|| EngineError::ExtractFailed(format!("no cookie: {name}")))?;
                let v = post_process(var, value, *decode, claim.as_deref())?;
                out.insert(var.clone(), v);
            }
```

(기존 `body not JSON: {e}` 문구는 R7 보존 대상이라 손대지 않는다 — 신규 경로에만 값-free 규칙 적용.)

`parse_cookie_value` 아래에 헬퍼 추가:

```rust
/// Why base64 text decoding failed. Data-less on purpose: base64's
/// `DecodeError` Display echoes input bytes, so no library error may ride
/// into the (user-visible) extract failure message — spec §3.3 / R6.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Base64TextError {
    NotBase64,
    NotUtf8,
}

/// The value is not a 3-segment compact JWT. Data-less (see above).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct JwtShapeError;

/// R3: trim, drop trailing `=`, pick the alphabet by its distinguishing
/// characters (`-`/`_` url-safe, `+`/`/` standard, neither → standard), decode
/// unpadded, require UTF-8.
fn decode_base64_text(s: &str) -> std::result::Result<String, Base64TextError> {
    let t = s.trim().trim_end_matches('=');
    let url_safe = t.contains(['-', '_']);
    let standard = t.contains(['+', '/']);
    let bytes = match (url_safe, standard) {
        (true, true) => return Err(Base64TextError::NotBase64),
        (true, false) => URL_SAFE_NO_PAD.decode(t),
        _ => STANDARD_NO_PAD.decode(t),
    }
    .map_err(|_| Base64TextError::NotBase64)?;
    String::from_utf8(bytes).map_err(|_| Base64TextError::NotUtf8)
}

/// R4: strip a case-insensitive `Bearer ` prefix (and extra spaces), then
/// require exactly three `.`-separated segments; return the payload segment.
fn jwt_payload(s: &str) -> std::result::Result<&str, JwtShapeError> {
    let t = s.trim();
    let t = match t.get(..7) {
        Some(p) if p.eq_ignore_ascii_case("bearer ") => t[7..].trim_start(),
        _ => t,
    };
    let mut parts = t.split('.');
    match (parts.next(), parts.next(), parts.next(), parts.next()) {
        (Some(_), Some(payload), Some(_), None) => Ok(payload),
        _ => Err(JwtShapeError),
    }
}

/// Optional decode + claim on an already-extracted raw value (spec §4.3).
/// Check order is fixed so multi-fault inputs report deterministically:
/// claim⇒decode → jwt shape → base64 → UTF-8 → JSON → claim parse → query.
/// Messages are `"{var}: <fixed reason>"` — never the value, never a library
/// error's Display (R6).
fn post_process(
    var: &str,
    raw: String,
    decode: Option<Decode>,
    claim: Option<&str>,
) -> Result<String> {
    let fail = |reason: &str| EngineError::ExtractFailed(format!("{var}: {reason}"));
    let Some(decode) = decode else {
        return match claim {
            Some(_) => Err(fail("claim requires decode")),
            None => Ok(raw),
        };
    };
    let segment = match decode {
        Decode::Base64 => raw.as_str(),
        Decode::Jwt => jwt_payload(&raw).map_err(|_| fail("not a JWT (expected 3 segments)"))?,
    };
    let text = decode_base64_text(segment).map_err(|e| match e {
        Base64TextError::NotBase64 => fail("not base64"),
        Base64TextError::NotUtf8 => fail("not UTF-8 text"),
    })?;
    if decode == Decode::Base64 && claim.is_none() {
        return Ok(text);
    }
    let json: serde_json::Value =
        serde_json::from_str(&text).map_err(|_| fail("decoded value is not JSON"))?;
    let Some(claim) = claim else {
        return Ok(text); // jwt without claim → payload JSON text verbatim (R5)
    };
    let path = serde_json_path::JsonPath::parse(claim)
        .map_err(|_| fail(&format!("invalid claim path: {claim}")))?;
    let first = path
        .query(&json)
        .first()
        .cloned()
        .ok_or_else(|| fail(&format!("claim not found: {claim}")))?;
    Ok(stringify(&first))
}
```

- [ ] **Step 4b: 테스트 모듈 중복 import 정리** — 부모 모듈이 이제 `base64::Engine as _`를 import하므로 Step 2에서 테스트 모듈에 넣은 `use base64::Engine as _;`는 `use super::*`와 겹쳐 **unused import**가 된다(clippy `-D warnings` → pre-commit 거부). 그 한 줄을 삭제한다. 이후 `cargo clippy -p handicap-engine --tests -- -D warnings 2>&1 | grep -E "^(warning|error)" -A4 | head -20`로 테스트 모듈에 남은 unused import가 없는지 확인(있으면 그 줄만 삭제).

- [ ] **Step 5: GREEN** — `cargo test -p handicap-engine --lib extract::tests 2>&1 | grep -E "test result|FAILED|panicked"` → 전부 ok. 기존 extract 테스트 단언 무변경 확인: `git diff HEAD -U0 -- crates/engine/src/extract.rs | grep -E '^-.*assert'` → 출력 없음.

- [ ] **Step 6: R6 이빨 실증(커밋 안 함)** — `post_process` 첫 줄에 `let echo = raw.clone();`를 넣고 `fail` 클로저를 `|reason: &str| EngineError::ExtractFailed(format!("{var}: {reason} [{echo}]"))`로 임시 변경(값 누출 회귀 흉내) → `cargo test -p handicap-engine --lib extract::tests 2>&1 | grep -E "FAILED|panicked|test result"` → `decode_base64_failures_are_value_free`·`jwt_shape_and_json_failures_are_value_free`·`claim_failures_are_value_free`·`claim_without_decode_is_rejected_at_eval`가 **FAIL**하는지 확인 → 원복 → GREEN 재확인. FAIL한 테스트명과 **실패 메시지 종류**(`assert_no_leak`의 `leaked "…"`여야 함 — `assert_eq` left/right diff가 먼저 나오면 P5 순서가 깨진 것)를 보고서에 기록.

- [ ] **Step 7: R8 통합 테스트** — `executor.rs` `mod tests`의 import 줄 `use crate::scenario::{Body, DisabledRows, Extract, HttpMethod, HttpStep, Request};`에 `Decode`를 추가하고, `extract_token_from_body_succeeds` 뒤에:

```rust
    #[tokio::test]
    async fn decode_jwt_claim_same_in_load_and_trace() {
        use base64::Engine as _;
        use base64::engine::general_purpose::URL_SAFE_NO_PAD;
        let payload = URL_SAFE_NO_PAD.encode(r#"{"sub":"u-9f3k","tenant":"t_1"}"#);
        let jwt = format!("eyJhbGciOiJub25lIn0.{payload}.c2ln");
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/login"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("Authorization", format!("Bearer {jwt}").as_str())
                    .set_body_string(format!(r#"{{"access_token":"{jwt}"}}"#)),
            )
            .mount(&server)
            .await;

        let step = HttpStep {
            id: "01HX0000000000000000000001".into(),
            name: "login".into(),
            request: Request {
                method: HttpMethod::Post,
                url: format!("{}/login", server.uri()),
                headers: BTreeMap::new(),
                body: None,
                disabled: DisabledRows::default(),
            },
            assert: vec![],
            extract: vec![
                Extract::Body {
                    var: "uid".into(),
                    path: "$.access_token".into(),
                    decode: Some(Decode::Jwt),
                    claim: Some("$.sub".into()),
                },
                Extract::Header {
                    var: "tenant".into(),
                    name: "Authorization".into(),
                    decode: Some(Decode::Jwt),
                    claim: Some("$.tenant".into()),
                },
            ],
            timeout_seconds: None,
            think_time: None,
        };
        let vars = BTreeMap::new();
        let env = empty_env();
        let ctx = TemplateContext {
            vars: &vars,
            env: &env,
            vu_id: 0,
            iter_id: 0,
            loop_index: None,
        };
        let client = VuClient::new(crate::scenario::CookieJarMode::Off).unwrap();
        let load = execute_step(&client, &step, &ctx).await.unwrap();
        assert!(load.error.is_none(), "load error: {:?}", load.error);
        assert_eq!(load.extracted.get("uid").map(String::as_str), Some("u-9f3k"));
        assert_eq!(load.extracted.get("tenant").map(String::as_str), Some("t_1"));
        let trace = execute_step_traced(&client, &step, &ctx).await;
        assert!(trace.error.is_none(), "trace error: {:?}", trace.error);
        assert_eq!(trace.extracted, load.extracted);
    }
```

`cargo test -p handicap-engine --lib executor::tests::decode_jwt 2>&1 | grep -E "test result|FAILED|panicked"` → ok.

- [ ] **Step 8: 워크스페이스 확인** — `cargo build --workspace --tests 2>&1 | tail -2`, `cargo clippy --workspace --tests -- -D warnings 2>&1 | tail -3` 클린. `git status --short`로 `desktop/src-tauri/Cargo.lock` 변경 여부 확인 — 이 workspace 빌드로는 안 바뀐다(별도 workspace); 변경이 생겼다면 함께 커밋, 없으면 그대로 둔다(spec §5: 갱신 "허용", 강제 아님).

- [ ] **Step 9: 커밋 (단일 FOREGROUND, timeout 600000)** — 먼저 `cargo fmt --all && cargo fmt --all --check; echo fmt=$?`(=0).

```bash
git add Cargo.toml Cargo.lock crates/engine/Cargo.toml crates/engine/src/extract.rs crates/engine/src/executor.rs
git diff --cached --name-only
git commit -m "feat(engine): 추출 base64/JWT 디코딩 + claim (R3–R8)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git log -1 --oneline
```

---

### Task 3: UI 와이어 모델 — Zod + 게이트 매핑 + Edit 타입 (R2, R10, R11-yamlDoc, R12)

**Files:**
- Modify: `ui/src/scenario/model.ts` (`ExtractModel` ~46-75)
- Modify: `ui/src/scenario/problems.ts` (`formatSegment`, `return seg;` 직전)
- Modify: `ui/src/i18n/ko.ts` (`editor` 블록, `gateRepeatMin` 뒤)
- Modify: `ui/src/scenario/yamlDoc.ts` (import ~14-21, `Edit` union `setStepExtract` ~88-97)
- Test: `ui/src/scenario/__tests__/model.test.ts`, `ui/src/scenario/__tests__/problems.test.ts`, `ui/src/scenario/__tests__/yamlDoc.test.ts`

**Interfaces:**
- Produces: `export const ExtractDecodeModel = z.enum(["base64","jwt"])`, `export type ExtractDecode = "base64" | "jwt"`, `Extract` 타입의 body/header/cookie 변형에 `decode?: ExtractDecode; claim?: string`, `ko.editor.gateExtractClaimNeedsDecode(path: string): string`.

- [ ] **Step 1: 실패 테스트 작성 (테스트 파일 먼저 — tdd-guard)**

`model.test.ts`의 `describe("ExtractModel", …)` 블록 끝에 추가:

```ts
  it("accepts decode/claim on body/header/cookie", () => {
    for (const c of [
      { var: "u", from: "body", path: "$.t", decode: "jwt", claim: "$.sub" },
      { var: "u", from: "header", name: "X", decode: "base64" },
      { var: "u", from: "cookie", name: "S", decode: "base64", claim: "$.k" },
    ]) {
      expect(() => ExtractModel.parse(c)).not.toThrow();
    }
  });

  it("rejects decode on status, unknown decode values, and claim without decode", () => {
    expect(() => ExtractModel.parse({ var: "s", from: "status", decode: "base64" })).toThrow();
    expect(() =>
      ExtractModel.parse({ var: "u", from: "body", path: "$.t", decode: "base64url" }),
    ).toThrow();
    const r = ExtractModel.safeParse({ var: "u", from: "header", name: "X", claim: "$.sub" });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].path).toEqual(["claim"]);
      expect(r.error.issues[0].message).toBe("claim requires decode");
    }
  });
```

`problems.test.ts` — `describe("실-Zod 드리프트 가드 — 신규 클래스 (parseScenarioDoc 경유)"` 블록 안(기존 `it` 뒤)에 추가:

```ts
  it("extract claim without decode → 한국어 게이트 문구", () => {
    const err = gateError(`version: 1
name: s
steps:
  - type: http
    id: ${ULID_A}
    name: x
    request: { method: GET, url: /x }
    extract:
      - var: uid
        from: header
        name: Authorization
        claim: $.sub
`);
    expect(formatGateMessages(err)).toContain(
      ko.editor.gateExtractClaimNeedsDecode("steps.0.extract.0.claim"),
    );
  });
```

`yamlDoc.test.ts` — `it("round-trips extract through model+doc edits"` 뒤에 추가:

```ts
  it("round-trips extract decode/claim through doc edits (R10)", () => {
    const out = parseScenarioDoc(VALID_YAML);
    if ("error" in out) throw new Error("expected ok");
    applyEdit(out.doc, {
      type: "setStepExtract",
      stepId: "01HX0000000000000000000001",
      extract: [
        { var: "uid", from: "body", path: "$.access_token", decode: "jwt", claim: "$.sub" },
        { var: "blob", from: "header", name: "X-Blob", decode: "base64" },
      ],
    });
    const round = serializeDoc(out.doc);
    const out2 = parseScenarioDoc(round);
    if ("error" in out2) throw new Error(`re-parse failed: ${out2.error}`);
    const s0 = out2.model.steps[0];
    if (s0.type !== "http") throw new Error("expected http step");
    expect(s0.extract).toEqual([
      { var: "uid", from: "body", path: "$.access_token", decode: "jwt", claim: "$.sub" },
      { var: "blob", from: "header", name: "X-Blob", decode: "base64" },
    ]);
  });

  // 고정 핀(변경 전에도 통과): yaml 2.9 createNode가 undefined 값 키를 생략함을 못 박는다.
  it("undefined decode/claim keys are not written (R11)", () => {
    const out = parseScenarioDoc(VALID_YAML);
    if ("error" in out) throw new Error("expected ok");
    applyEdit(out.doc, {
      type: "setStepExtract",
      stepId: "01HX0000000000000000000001",
      extract: [{ var: "t", from: "body", path: "$.a", decode: undefined, claim: undefined }],
    });
    const round = serializeDoc(out.doc);
    expect(round).not.toContain("decode");
    expect(round).not.toContain("claim");
  });
```

- [ ] **Step 2: RED 확인** — `cd ui && pnpm test model problems yamlDoc 2>&1 | grep -E "✓|×|Test Files|Tests " | tail -15` → 새 테스트 FAIL(필드 미지원·`gateExtractClaimNeedsDecode` 없음). 단 `undefined decode/claim keys are not written`은 고정 핀이라 이 시점에도 통과가 정상. (`pnpm test <name>` — `--` 붙이지 말 것.)

- [ ] **Step 3: 구현**

`model.ts` — `ExtractModel` 정의를 교체:

```ts
export const ExtractDecodeModel = z.enum(["base64", "jwt"]);
export type ExtractDecode = z.infer<typeof ExtractDecodeModel>;

// extract-base64-decode: optional post-extract decoding (engine `Decode`).
// No `.default()` — nested default leaks `T | undefined` into parents (ui/CLAUDE.md).
const extractDecodeFields = {
  decode: ExtractDecodeModel.optional(),
  claim: z.string().min(1).optional(),
};

export const ExtractModel = z
  .discriminatedUnion("from", [
    z
      .object({
        var: z.string().min(1),
        from: z.literal("body"),
        path: z.string().min(1),
        ...extractDecodeFields,
      })
      .strict(),
    z
      .object({
        var: z.string().min(1),
        from: z.literal("header"),
        name: z.string().min(1),
        ...extractDecodeFields,
      })
      .strict(),
    z
      .object({
        var: z.string().min(1),
        from: z.literal("cookie"),
        name: z.string().min(1),
        ...extractDecodeFields,
      })
      .strict(),
    z
      .object({
        var: z.string().min(1),
        from: z.literal("status"),
      })
      .strict(),
  ])
  // Cross-field rule on the WHOLE union (a member-level refine makes a
  // ZodEffects that discriminatedUnion rejects — same as BodyModel/StepModel).
  // English wire text; problems.ts maps it to Korean.
  .superRefine((e, ctx) => {
    if (e.from !== "status" && e.claim !== undefined && e.decode === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["claim"],
        message: "claim requires decode",
      });
    }
  });
export type Extract = z.infer<typeof ExtractModel>;
```

`ko.ts` — `gateRepeatMin` 줄 뒤:

```ts
    gateExtractClaimNeedsDecode: (path: string) =>
      `${path}: claim 경로를 쓰려면 디코딩(base64/JWT)을 먼저 선택해야 합니다`,
```

`problems.ts` — `formatSegment`의 `return seg;` 직전:

```ts
  m = /^(.+): claim requires decode$/.exec(seg);
  if (m) return ko.editor.gateExtractClaimNeedsDecode(m[1]);
```

`yamlDoc.ts` — `./model` import 목록에 `type Extract,` 추가하고, `Edit` union의 `setStepExtract` 변형을:

```ts
  | {
      type: "setStepExtract";
      stepId: string;
      extract: ReadonlyArray<Extract>;
    }
```

- [ ] **Step 4: GREEN + 전체 게이트** — `cd ui && pnpm test model problems yamlDoc 2>&1 | grep -E "Test Files|Tests "` → 전부 pass. 이어서 파이프 없이 종료코드 캡처: `cd /Users/sgj/develop/handicap/.claude/worktrees/extract-base64-decode/ui && pnpm lint > /tmp/eb64-lint.log 2>&1; echo lint=$?; pnpm test > /tmp/eb64-test.log 2>&1; echo test=$?; pnpm build > /tmp/eb64-build.log 2>&1; echo build=$?` → 셋 다 0. (`tsc -b`가 `Extract` 소비처 — `ExtractConfirmRow`·store `addStepExtract`·`Inspector` — 의 타입을 재확인한다; `Inspector.tsx`의 `draftFromExtract`가 `as DraftExtract` 캐스트라 아직 통과해야 정상. 실패하면 그 에러를 보고서에 그대로.)

- [ ] **Step 5: 커밋 (단일 FOREGROUND)**

```bash
git add ui/src/scenario/model.ts ui/src/scenario/problems.ts ui/src/i18n/ko.ts ui/src/scenario/yamlDoc.ts ui/src/scenario/__tests__/model.test.ts ui/src/scenario/__tests__/problems.test.ts ui/src/scenario/__tests__/yamlDoc.test.ts
git diff --cached --name-only
git commit -m "feat(ui): Extract decode/claim Zod 모델 + 게이트 매핑 (R2, R10, R12)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git log -1 --oneline
```

---

### Task 4: 추출 편집기 — 디코딩 선택 + claim 입력 (R9, R11)

**Files:**
- Modify: `ui/src/components/scenario/Inspector.tsx` (`DraftExtract` ~663-672, `ExtractEditor` ~674-822)
- Modify: `ui/src/i18n/ko.ts` (`editor` 블록, `extractFromAria` ~794 근처)
- Test: `ui/src/components/scenario/__tests__/Inspector.test.tsx` (`describe("Inspector — ExtractEditor"`)

**Interfaces:**
- Consumes: Task 3의 `Extract`(decode/claim 포함), `ExtractDecode`.
- Produces: ko 키 `extractDecodeAria(n)`, `extractClaimAria(n)`, `extractDecodeNone`, `extractDecodeBase64`, `extractDecodeJwt`.

- [ ] **Step 1: 실패 테스트 작성 (테스트 먼저 — tdd-guard)** — `Inspector.test.tsx` 상단 `VALID_YAML` 아래에 픽스처 추가:

```ts
const DECODE_YAML = `version: 1
name: "demo"
cookie_jar: auto
variables: {}
steps:
  - id: "01HX0000000000000000000001"
    name: "login"
    type: http
    request:
      method: POST
      url: "/login"
    extract:
      - var: uid
        from: header
        name: Authorization
        decode: jwt
        claim: $.sub
`;
```

`describe("Inspector — ExtractEditor"` 블록 끝에 추가:

```ts
  function extractSectionOf() {
    return screen.getByRole("group", { name: "값 추출" });
  }

  async function addHeaderRow(user: ReturnType<typeof userEvent.setup>) {
    render(<Inspector />);
    await user.click(screen.getByRole("button", { name: ko.editor.extractsLegend }));
    const sec = extractSectionOf();
    await user.click(within(sec).getByRole("button", { name: /추가/i }));
    await user.type(within(sec).getByPlaceholderText("var"), "uid");
    await user.selectOptions(within(sec).getByLabelText(ko.editor.extractFromAria(0)), "header");
    await user.type(
      within(sec).getByPlaceholderText(ko.editor.headerNamePlaceholder),
      "Authorization",
    );
    await user.tab();
    return sec;
  }

  it("decode select writes decode and reveals claim; claim commits on blur (R9)", async () => {
    const user = userEvent.setup();
    const sec = await addHeaderRow(user);
    expect(within(sec).queryByLabelText(ko.editor.extractClaimAria(0))).toBeNull();

    await user.selectOptions(within(sec).getByLabelText(ko.editor.extractDecodeAria(0)), "jwt");
    expect(useScenarioEditor.getState().yamlText).toMatch(/decode:\s*jwt/);

    const claim = within(sec).getByLabelText(ko.editor.extractClaimAria(0));
    await user.type(claim, "$.sub");
    expect(useScenarioEditor.getState().yamlText).not.toMatch(/claim:/); // onBlur commit
    await user.tab();
    expect(useScenarioEditor.getState().yamlError).toBeNull();
    expect(useScenarioEditor.getState().yamlText).toMatch(/claim:\s*"?\$\.sub"?/);
  });

  it("choosing 없음 removes both decode and claim keys (R9/R11)", async () => {
    useScenarioEditor.getState().loadFromString(DECODE_YAML);
    useScenarioEditor.getState().select("01HX0000000000000000000001");
    const user = userEvent.setup();
    render(<Inspector />);
    await user.click(screen.getByRole("button", { name: ko.editor.extractsLegend }));
    const sec = extractSectionOf();
    expect(within(sec).getByLabelText(ko.editor.extractClaimAria(0))).toHaveValue("$.sub");

    await user.selectOptions(
      within(sec).getByLabelText(ko.editor.extractDecodeAria(0)),
      ko.editor.extractDecodeNone,
    );
    expect(useScenarioEditor.getState().yamlError).toBeNull();
    const yaml = useScenarioEditor.getState().yamlText;
    expect(yaml).not.toMatch(/decode:/);
    expect(yaml).not.toMatch(/claim:/);
    expect(yaml).toMatch(/name:\s*Authorization/);
  });

  it("switching to cookie keeps decode; status drops decode/claim (R9)", async () => {
    useScenarioEditor.getState().loadFromString(DECODE_YAML);
    useScenarioEditor.getState().select("01HX0000000000000000000001");
    const user = userEvent.setup();
    render(<Inspector />);
    await user.click(screen.getByRole("button", { name: ko.editor.extractsLegend }));
    const sec = extractSectionOf();
    const from = within(sec).getByLabelText(ko.editor.extractFromAria(0));

    await user.selectOptions(from, "cookie");
    expect(useScenarioEditor.getState().yamlText).toMatch(/decode:\s*jwt/);

    await user.selectOptions(from, "status");
    expect(useScenarioEditor.getState().yamlError).toBeNull();
    const yaml = useScenarioEditor.getState().yamlText;
    expect(yaml).toMatch(/from:\s*status/);
    expect(yaml).not.toMatch(/decode:/);
    expect(yaml).not.toMatch(/claim:/);
    expect(within(sec).queryByLabelText(ko.editor.extractDecodeAria(0))).toBeNull();
  });

  it("empty claim is not written (R11)", async () => {
    const user = userEvent.setup();
    const sec = await addHeaderRow(user);
    await user.selectOptions(within(sec).getByLabelText(ko.editor.extractDecodeAria(0)), "base64");
    const claim = within(sec).getByLabelText(ko.editor.extractClaimAria(0));
    await user.type(claim, "x");
    await user.clear(claim); // draft claim === "" (not undefined) — the case R11 guards
    await user.tab();
    // A `claim: ""` write fails Zod .min(1) and dispatch only sets yamlError
    // (yamlText unchanged) — so this null check is what gives the test teeth.
    expect(useScenarioEditor.getState().yamlError).toBeNull();
    const yaml = useScenarioEditor.getState().yamlText;
    expect(yaml).toMatch(/decode:\s*base64/);
    expect(yaml).not.toMatch(/claim:/);
  });

  it("new decode controls are disabled while the YAML buffer is broken", async () => {
    useScenarioEditor.getState().loadFromString(DECODE_YAML);
    useScenarioEditor.getState().select("01HX0000000000000000000001");
    const user = userEvent.setup();
    render(<Inspector />);
    await user.click(screen.getByRole("button", { name: ko.editor.extractsLegend }));
    act(() => {
      useScenarioEditor.getState().setPendingYamlText("version: 1\nname: t\nsteps: [\n");
      useScenarioEditor.getState().commitPendingYaml();
    });
    const sec = extractSectionOf();
    expect(within(sec).getByLabelText(ko.editor.extractDecodeAria(0))).toBeDisabled();
    expect(within(sec).getByLabelText(ko.editor.extractClaimAria(0))).toBeDisabled();
  });
```

(`act`는 이 파일 import에 이미 있다. 기존 `loadAndSelect()` beforeEach가 `VALID_YAML`을 먼저 로드하므로 DECODE_YAML 케이스는 위처럼 재로드.)

- [ ] **Step 2: RED 확인** — `cd ui && pnpm test Inspector.test 2>&1 | grep -E "✓|×|Tests " | tail -12` → 새 5건 FAIL(ko 키·컨트롤 없음).

- [ ] **Step 3: ko 키** — `ko.ts` `editor` 블록의 `extractFromAria` 줄 뒤:

```ts
    extractDecodeAria: (n: number) => `추출 ${n} 디코딩`,
    extractClaimAria: (n: number) => `추출 ${n} claim 경로`,
    extractDecodeNone: "디코딩 없음",
    extractDecodeBase64: "base64",
    extractDecodeJwt: "JWT",
```

- [ ] **Step 4: 편집기 구현** — `Inspector.tsx`:

(a) 파일 상단의 `import type { … } from "../../scenario/model";` 블록(`Extract, HttpMethod, …`)에 `ExtractDecode,`를 추가(이미 `import type` 블록이라 인라인 `type` 수식어를 붙이면 TS 에러).

(b) `DraftExtract`/`draftFromExtract` 교체 + 정규화 헬퍼:

```ts
// Draft type mirrors Extract but allows empty strings during editing.
type DecodeDraft = { decode?: ExtractDecode; claim?: string };
type DraftExtract =
  | ({ var: string; from: "body"; path: string } & DecodeDraft)
  | ({ var: string; from: "header"; name: string } & DecodeDraft)
  | ({ var: string; from: "cookie"; name: string } & DecodeDraft)
  | { var: string; from: "status" };

function draftFromExtract(e: Extract): DraftExtract {
  return e as DraftExtract;
}

// R11: never write `decode: undefined`/`claim: ""` — only present, non-empty keys.
function decodeFields(d: DraftExtract): DecodeDraft {
  if (d.from === "status" || !d.decode) return {};
  return d.claim ? { decode: d.decode, claim: d.claim } : { decode: d.decode };
}

function toExtract(d: DraftExtract): Extract {
  switch (d.from) {
    case "body":
      return { var: d.var, from: "body", path: d.path, ...decodeFields(d) };
    case "header":
      return { var: d.var, from: "header", name: d.name, ...decodeFields(d) };
    case "cookie":
      return { var: d.var, from: "cookie", name: d.name, ...decodeFields(d) };
    case "status":
      return { var: d.var, from: "status" };
  }
}
```

(c) `ExtractEditor` 안: `const yamlError = useScenarioEditor((s) => s.yamlError);` 추가(기존 `renameEpoch` 셀렉터 옆).

(d) `commitDrafts`의 `}) as Extract[];` → `}).map(toExtract);`, `remove`의 `setStepExtract(step.id, list as Extract[]);` → `setStepExtract(step.id, list.map(toExtract));`.

(e) `setFromKind`를 decode/claim 보존형으로:

```ts
  const setFromKind = (idx: number, from: Extract["from"]) => {
    const x = drafts[idx];
    const keep = decodeFields(x);
    const list = drafts.slice();
    if (from === "body")
      list[idx] = { var: x.var, from, path: (x as { path?: string }).path ?? "$.", ...keep };
    else if (from === "header")
      list[idx] = { var: x.var, from, name: (x as { name?: string }).name ?? "", ...keep };
    else if (from === "cookie")
      list[idx] = { var: x.var, from, name: (x as { name?: string }).name ?? "", ...keep };
    else list[idx] = { var: x.var, from: "status" };
    setDrafts(list);
    commitDrafts(list); // structural change — commit immediately
  };

  // Decode choice is structural (like from-kind): commit immediately. "" = none →
  // drop both keys (R9/R11).
  const setDecode = (idx: number, value: string) => {
    const x = drafts[idx];
    if (x.from === "status") return;
    const next = { ...x };
    if (value === "") {
      delete next.decode;
      delete next.claim;
    } else {
      next.decode = value as ExtractDecode;
    }
    const list = drafts.slice();
    list[idx] = next;
    setDrafts(list);
    commitDrafts(list);
  };
```

(구조분해 `const { decode: _d, claim: _c, ...rest } = x`는 쓰지 않는다 — 이 저장소 eslint `no-unused-vars`는 `argsIgnorePattern`만 설정돼 `_` 접두 구조분해 변수도 에러다.)

(f) 렌더: body/header/cookie의 두 번째 필드 블록들(`x.from === "body"`·`header||cookie`) **뒤**, `status` 블록 **앞**에 추가:

```tsx
            {x.from !== "status" && (
              <div className="w-fit">
                <Select
                  size="sm"
                  aria-label={ko.editor.extractDecodeAria(idx)}
                  value={x.decode ?? ""}
                  disabled={yamlError !== null}
                  onChange={(e) => setDecode(idx, e.target.value)}
                >
                  <option value="">{ko.editor.extractDecodeNone}</option>
                  <option value="base64">{ko.editor.extractDecodeBase64}</option>
                  <option value="jwt">{ko.editor.extractDecodeJwt}</option>
                </Select>
              </div>
            )}
            {x.from !== "status" && x.decode && (
              <div className="flex-1 min-w-[96px]">
                <Input
                  size="sm"
                  placeholder="$.sub"
                  aria-label={ko.editor.extractClaimAria(idx)}
                  className="font-mono"
                  value={x.claim ?? ""}
                  disabled={yamlError !== null}
                  onChange={(e) => updateDraft(idx, { ...x, claim: e.target.value })}
                  onBlur={commitFromBlur}
                />
              </div>
            )}
```

- [ ] **Step 5: GREEN** — `cd ui && pnpm test Inspector.test 2>&1 | grep -E "Tests |×"` → 전부 pass(기존 ExtractEditor 테스트 포함).

- [ ] **Step 6: 이빨 실증(커밋 안 함)** — (1) `decodeFields`의 `d.claim ? … : …` 분기를 `{ decode: d.decode, claim: d.claim }`(빈 문자열 통과)로 바꿔 `empty claim is not written` FAIL 확인 → 원복. (2) `setFromKind`의 status 분기를 `list[idx] = { var: x.var, from: "status", ...keep } as DraftExtract;`로, **동시에** `toExtract`의 status case를 `return d as Extract;`로 바꿔(둘 다 바꿔야 YAML까지 도달 — `decodeFields`가 status에 `{}`를 돌려주고 `toExtract`가 재구성하는 이중 방어) `switching to cookie keeps decode; status drops…` FAIL 확인(Zod `.strict()` 거부 → `yamlError` 비-null) → 원복. 둘 중 하나만 바꾸면 GREEN이 정상(층상 방어) — 그 사실도 보고서에 기록. 두 FAIL 테스트명을 보고서에 기록.

- [ ] **Step 7: 전체 UI 게이트** — `cd /Users/sgj/develop/handicap/.claude/worktrees/extract-base64-decode/ui && pnpm lint > /tmp/eb64-lint.log 2>&1; echo lint=$?; pnpm test > /tmp/eb64-test.log 2>&1; echo test=$?; pnpm build > /tmp/eb64-build.log 2>&1; echo build=$?` → 셋 다 0.

- [ ] **Step 8: 커밋 (단일 FOREGROUND)**

```bash
git add ui/src/components/scenario/Inspector.tsx ui/src/i18n/ko.ts ui/src/components/scenario/__tests__/Inspector.test.tsx
git diff --cached --name-only
git commit -m "feat(ui): 추출 편집기 디코딩 선택·claim 입력 (R9, R11)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git log -1 --oneline
```

---

## 이후 단계 (orchestrator, task 아님)

1. 최종 whole-branch 리뷰 `handicap-reviewer`(와이어 1:1: engine serde ↔ UI Zod — `Decode` lowercase 값·`status` 무필드·`claim` 경로) + `security-reviewer`(추출·trace 경로 — finish-slice §0 grep이 판정).
2. 라이브 검증(`/live-verify`, **워커 재빌드 필수**): spec §6 US 표(US1 본문+헤더 JWT·echo 와이어 / US2 4변형 / US3 값-free 에러 / 저장·새로고침 존속).
3. `/finish-slice`: build-log·roadmap(§7 연기: 슬라이스 2 인코딩·퍼센트 인코딩 쿠키·`from: var`·`+추출` JWT 제안·Inspector 기존 입력 yamlError 게이트)·상태줄.
