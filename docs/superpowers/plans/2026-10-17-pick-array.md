# 선택 배열 생성 변수 (pick-array) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 5번째 생성 변수 `pick_array`(길이 N 배열에서 후보 자리 중 k개를 반복마다 랜덤 선택해 `pick`, 나머지 `rest`)를 엔진 게이트·평가와 변수 패널 팝업 편집기로 출하한다.

**Architecture:** 엔진은 `crates/engine/src/genvars.rs`의 기존 wire-struct+`TryFrom` 게이트와 `seed_iter_vars` 단일 헬퍼에 변형 1개를 더한다(진입점 배선 0). UI는 순수 모듈 `pickArray.ts`(범위·리터럴 파서/포매터·샘플러) → Zod 멤버·요약 → 팝업 `PickArrayDialog`(draft→적용 1회 커밋) → `VariablesPanel`/`GenVarEditor` 배선 순으로 쌓는다. 엔진↔UI 판정은 공유 벡터 파일 `testdata/pick_array_vectors.json`으로 양방향 lockstep.

**Tech Stack:** Rust(serde/serde_yaml 0.9/serde_json/rand 0.8), React+TS, Zod 3, `yaml` 2.x Document API, vitest+RTL, fast-check.

**Spec:** `docs/superpowers/specs/2026-10-17-pick-array-design.md` (US1~US5 = 그 문서 `## 사용자 스토리 (US)` 블록). **목업:** `docs/superpowers/mockups/2026-10-17-pick-array-mockup.html` — 시각·흐름 참조만, **목업 JS 로직 복사 금지**(빈 항목 허용·`change` 이벤트 길이 규칙이 spec과 다름).

## Global Constraints

- 사용자 노출 문구는 전부 `ui/src/i18n/ko.ts` 경유(ADR-0035). **값이 불리언이어야 한다는 인상을 주는 문구 금지** — "true 개수"·"true 자리"·"불리언 배열" 금지(값 형식 프리셋 라벨 `true / false`·예시 값 자체는 예외). 타입명 = `선택 배열`.
- YAML 키·순서: `gen, length, min, max, positions?, pick?, rest?`. `positions` 생략 = 전체 자리, `pick` 생략 = `true`, `rest` 생략 = `false`.
- 검증(엔진·Zod 동일): `1 ≤ length ≤ 1000` · `0 ≤ min ≤ max ≤ length` · positions 문자열 ≤ 4096자 · positions 문법(§4.3) · 후보 ≥ 1 · `min ≤ 후보 수` · pick/rest는 bool·유한 number·string·null. `max > 후보 수`는 허용(평가 시 상한, UI 경고).
- positions 문법: 쉼표 분리 → 항목 trim → `N` 또는 `N-M`(하이픈 주변 공백 허용), 숫자는 ASCII 1~4자리, `1 ≤ N ≤ M ≤ length`, 빈 항목 거부, 빈 문자열/공백만 = 빈 집합(후보 0 규칙으로 거부). 정규형 = 오름차순·연속 병합·`", "` 구분.
- UI 커밋 경계: 팝업 안 편집은 로컬 draft만, **store/YAML 쓰기는 `적용` 1회**. 취소·✕·ESC·바깥 클릭 = 폐기.
- `yamlError !== null`이면 새 어포던스(`편집`·`편집…`·`배열로 추가`·타입 select) 전부 disabled.
- 커밋 규칙: cargo-영향 커밋은 `run_in_background` 금지 아님 — **implementer는 단일 FOREGROUND 호출(timeout 600000)**로 커밋. `git commit … | tail` 금지, `--no-verify` 금지, 커밋 후 `git log -1`로 확인. `testdata/` 단독 커밋은 게이트를 안 타므로 항상 `crates/`·`ui/` 파일과 같이 스테이징.
- 회귀 가드를 표방하는 테스트는 brief가 지목한 경우 **고의 회귀→RED→원복→GREEN**을 실행하고 결과를 리포트에 적는다.

## Review Focus

1. 손으로 쓴 YAML의 비정형 positions(`"1 - 3"`·`"007"`·`" 3 , 1 "`)가 엔진·UI 모두 수용되고 패널 요약이 올바른 후보 수를 보인다 → Task 1·3 벡터(공유 파일)에 포함.
2. 길이 1000·전체 후보에서 팝업이 1000칸을 그리고 칸 1개 토글이 텍스트를 정규형으로 바꾼다(성능·정합) → Task 5 RTL "length 1000" 케이스.
3. `선택 배열` → 다른 타입(UUID)으로 타입 select 전환 시 즉시 커밋되고 pick_array 키(`positions`/`pick`/`rest`)가 YAML에 남지 않는다 → Task 6 GenVarEditor 케이스.
4. 선택 배열 변수의 rename이 spec 전체(맵 노드)를 보존한다 → Task 4 yamlDoc 케이스.
5. 캐스트 없는 `"{{flags}}"`·혼합 leaf `"x{{flags:json}}"`·env `"${F:json}"`로만 쓰인 미정의 변수엔 `배열로 추가`가 **안** 뜬다 → Task 3 `jsonCastVarNames` + Task 6 패널 케이스.

## 모델 라우팅 (orchestrator용)

Task 1·2 = engine path-gate → code-quality 리뷰 `model: opus`. Task 3~6 = UI → 기본 Sonnet 리뷰(단 Task 5·6 code-quality는 a11y/포커스 미묘성으로 `model: opus` 권장). 모든 subagent prompt 첫 줄: `cd /Users/sgj/develop/handicap/.claude/worktrees/genvar-array`.

---

### Task 1: 엔진 — pick_array 모델·게이트·평가 + 공유 벡터

**Files:**
- Create: `testdata/pick_array_vectors.json`
- Create: `crates/engine/tests/pick_array.rs`
- Modify: `crates/engine/src/genvars.rs` (GenSpec·GenSpecWire·TryFrom·Serialize·eval·seed_iter_vars)
- Modify: `crates/engine/src/lib.rs:28` (re-export)

**Interfaces:**
- Produces: `pub struct PickArrayGen { pub length: u32, pub min: u32, pub max: u32, pub positions: Option<String>, pub pick: Option<serde_json::Value>, pub rest: Option<serde_json::Value>, pub(crate) candidates: Vec<u32> }` + `impl PickArrayGen { pub fn candidates(&self) -> &[u32] }` · `GenSpec::PickArray(PickArrayGen)` · `pub fn parse_positions(text: &str, length: u32) -> Result<Vec<u32>, String>` · `pub const PICK_ARRAY_MAX_LEN: u32 = 1000;` · `pub const POSITIONS_MAX_CHARS: usize = 4096;` — 모두 `handicap_engine::`에서 re-export.

- [ ] **Step 1: 공유 벡터 파일 작성**

`testdata/pick_array_vectors.json` (Task 3·4의 vitest도 이 파일을 읽는다 — 수정 시 세 테스트가 함께 돈다):

```json
{
  "positions": [
    { "text": "1-5, 8, 12-20", "length": 30, "expect": "accept", "set": [1,2,3,4,5,8,12,13,14,15,16,17,18,19,20], "canonical": "1-5, 8, 12-20" },
    { "text": "8", "length": 30, "expect": "accept", "set": [8], "canonical": "8" },
    { "text": " 3 , 1 ", "length": 30, "expect": "accept", "set": [1,3], "canonical": "1, 3" },
    { "text": "1-5,3-8", "length": 30, "expect": "accept", "set": [1,2,3,4,5,6,7,8], "canonical": "1-8" },
    { "text": "1 - 3", "length": 30, "expect": "accept", "set": [1,2,3], "canonical": "1-3" },
    { "text": "007", "length": 30, "expect": "accept", "set": [7], "canonical": "7" },
    { "text": "5, 4, 3", "length": 30, "expect": "accept", "set": [3,4,5], "canonical": "3-5" },
    { "text": "30", "length": 30, "expect": "accept", "set": [30], "canonical": "30" },
    { "text": "1-10", "length": 10, "expect": "accept", "set": [1,2,3,4,5,6,7,8,9,10], "canonical": "1-10" },
    { "text": "", "length": 30, "expect": "accept", "set": [], "canonical": "" },
    { "text": "   ", "length": 30, "expect": "accept", "set": [], "canonical": "" },
    { "text": "0", "length": 30, "expect": "reject" },
    { "text": "31", "length": 30, "expect": "reject" },
    { "text": "3-31", "length": 30, "expect": "reject" },
    { "text": "5-3", "length": 30, "expect": "reject" },
    { "text": "a", "length": 30, "expect": "reject" },
    { "text": "1,,2", "length": 30, "expect": "reject" },
    { "text": "1,", "length": 30, "expect": "reject" },
    { "text": ",1", "length": 30, "expect": "reject" },
    { "text": "-5", "length": 30, "expect": "reject" },
    { "text": "1-", "length": 30, "expect": "reject" },
    { "text": "1-2-3", "length": 30, "expect": "reject" },
    { "text": "1.5", "length": 30, "expect": "reject" },
    { "text": "+1", "length": 30, "expect": "reject" },
    { "text": "00001", "length": 30, "expect": "reject" },
    { "text": "１", "length": 30, "expect": "reject" },
    { "text": "1 2", "length": 30, "expect": "reject" }
  ],
  "generators": [
    { "yaml": "{gen: pick_array, length: 10, min: 1, max: 3}", "expect": "accept" },
    { "yaml": "{gen: pick_array, length: 30, min: 2, max: 3, positions: \"1-5, 8, 12-20\"}", "expect": "accept" },
    { "yaml": "{gen: pick_array, length: 10, min: 0, max: 0}", "expect": "accept" },
    { "yaml": "{gen: pick_array, length: 10, min: 1, max: 1, positions: 8}", "expect": "accept" },
    { "yaml": "{gen: pick_array, length: 10, min: 1, max: 10, positions: \"1-3\"}", "expect": "accept" },
    { "yaml": "{gen: pick_array, length: 4, min: 1, max: 2, pick: 1, rest: 0}", "expect": "accept" },
    { "yaml": "{gen: pick_array, length: 4, min: 1, max: 2, pick: \"True\", rest: \"False\"}", "expect": "accept" },
    { "yaml": "{gen: pick_array, length: 4, min: 1, max: 2, pick: \"Y\", rest: null}", "expect": "accept" },
    { "yaml": "{gen: pick_array, length: 4, min: 1, max: 2, pick: 1.5}", "expect": "accept" },
    { "yaml": "{gen: pick_array, length: 1000, min: 0, max: 1000}", "expect": "accept" },
    { "yaml": "{gen: pick_array, min: 1, max: 2}", "expect": "reject" },
    { "yaml": "{gen: pick_array, length: 10, max: 2}", "expect": "reject" },
    { "yaml": "{gen: pick_array, length: 10, min: 1}", "expect": "reject" },
    { "yaml": "{gen: pick_array, length: 0, min: 0, max: 0}", "expect": "reject" },
    { "yaml": "{gen: pick_array, length: 1001, min: 0, max: 0}", "expect": "reject" },
    { "yaml": "{gen: pick_array, length: 10, min: -1, max: 2}", "expect": "reject" },
    { "yaml": "{gen: pick_array, length: 10, min: 3, max: 2}", "expect": "reject" },
    { "yaml": "{gen: pick_array, length: 10, min: 1, max: 11}", "expect": "reject" },
    { "yaml": "{gen: pick_array, length: 10, min: 0, max: 1, positions: \"\"}", "expect": "reject" },
    { "yaml": "{gen: pick_array, length: 10, min: 1, max: 1, positions: \"0\"}", "expect": "reject" },
    { "yaml": "{gen: pick_array, length: 10, min: 1, max: 1, positions: \"1,,2\"}", "expect": "reject" },
    { "yaml": "{gen: pick_array, length: 10, min: 4, max: 4, positions: \"1-3\"}", "expect": "reject" },
    { "yaml": "{gen: pick_array, length: 4, min: 1, max: 2, pick: [1]}", "expect": "reject" },
    { "yaml": "{gen: pick_array, length: 4, min: 1, max: 2, rest: {a: 1}}", "expect": "reject" },
    { "yaml": "{gen: pick_array, length: 4, min: 1, max: 2, pick: .inf}", "expect": "reject" },
    { "yaml": "{gen: pick_array, length: 4, min: 1, max: 2, pick: .nan}", "expect": "reject" },
    { "yaml": "{gen: pick_array, length: 4, min: 1, max: 2, format: x}", "expect": "reject" },
    { "yaml": "{gen: pick_array, length: 4, min: 1, max: 2, step: 2}", "expect": "reject" },
    { "yaml": "{gen: pick_array, length: 4, min: 1, max: 2, foo: 1}", "expect": "reject" },
    { "yaml": "{gen: uuid, pick: 1}", "expect": "reject" },
    { "yaml": "{gen: date, positions: \"1\"}", "expect": "reject" },
    { "yaml": "{gen: random_int, min: 1, max: 2, rest: 0}", "expect": "reject" },
    { "yaml": "{gen: random_string, length: 3, positions: \"1\"}", "expect": "reject" },
    { "yaml": "{gen: pick_array, length: 10, min: 1, max: 1, positions: 0x8}", "expect": "known_divergence" }
  ]
}
```

`known_divergence` = 엔진 거부·UI 수용(spec §4.1 — 저장 시 가시적 400).

- [ ] **Step 2: 실패하는 엔진 통합 테스트 작성**

`crates/engine/tests/pick_array.rs`:

```rust
// pick-array (spec 2026-10-17): 게이트·평가·왕복. 판정 벡터는 testdata/pick_array_vectors.json —
// UI vitest(pickArray.test.ts·pickArrayVectors.test.ts)가 같은 파일을 읽어 양방향 lockstep.
use std::collections::{BTreeMap, HashSet};

use handicap_engine::{GenSpec, VarDecl, parse_positions, seed_iter_vars};
use rand::SeedableRng;
use rand::rngs::StdRng;
use serde::Deserialize;
use serde_json::Value;

const VECTORS: &str = include_str!("../../../testdata/pick_array_vectors.json");

#[derive(Deserialize)]
struct Vectors {
    positions: Vec<PosVec>,
    generators: Vec<GenVec>,
}
#[derive(Deserialize)]
struct PosVec {
    text: String,
    length: u32,
    expect: String,
    #[serde(default)]
    set: Vec<u32>,
}
#[derive(Deserialize)]
struct GenVec {
    yaml: String,
    expect: String,
}

fn vectors() -> Vectors {
    serde_json::from_str(VECTORS).unwrap()
}

#[test]
fn positions_vectors() {
    for v in vectors().positions {
        let got = parse_positions(&v.text, v.length);
        match v.expect.as_str() {
            "accept" => assert_eq!(got.as_deref(), Ok(&v.set[..]), "text={:?}", v.text),
            "reject" => assert!(got.is_err(), "should reject {:?}, got {got:?}", v.text),
            other => panic!("unknown expect {other}"),
        }
    }
}

#[test]
fn generator_vectors() {
    for v in vectors().generators {
        let got = serde_yaml::from_str::<VarDecl>(&v.yaml);
        match v.expect.as_str() {
            "accept" => assert!(got.is_ok(), "should accept {}: {:?}", v.yaml, got.err()),
            // known_divergence: 엔진은 원문(`0x8`)을 문법 오류로 거부한다(UI만 수용).
            "reject" | "known_divergence" => assert!(got.is_err(), "should reject {}", v.yaml),
            other => panic!("unknown expect {other}"),
        }
    }
}

#[test]
fn positions_over_4096_chars_rejected_and_at_limit_accepted() {
    // "1, " 반복으로 정확히 4096자 / 4097자 — 길이 상한 판정은 문법보다 먼저.
    let at = format!("{}1", "1, ".repeat(1365)); // 1365*3 + 1 = 4096
    assert_eq!(at.len(), 4096);
    assert_eq!(parse_positions(&at, 10).unwrap(), vec![1]);
    let over = format!("{at} ");
    assert_eq!(over.len(), 4097);
    assert!(parse_positions(&over, 10).is_err());
}

fn one(spec: &str) -> BTreeMap<String, VarDecl> {
    serde_yaml::from_str(&format!("x: {spec}")).unwrap()
}

fn eval(m: &BTreeMap<String, VarDecl>, rng: &mut StdRng) -> Vec<Value> {
    serde_json::from_str(&seed_iter_vars(m, rng)["x"]).unwrap()
}

#[test]
fn eval_respects_count_range_and_candidates() {
    let m = one(r#"{gen: pick_array, length: 30, min: 2, max: 3, positions: "1-5, 8, 12-20"}"#);
    let cand: HashSet<usize> = [1, 2, 3, 4, 5, 8, 12, 13, 14, 15, 16, 17, 18, 19, 20]
        .iter()
        .map(|p| p - 1)
        .collect();
    let mut rng = StdRng::seed_from_u64(7);
    let mut counts = HashSet::new();
    let mut distinct = HashSet::new();
    for _ in 0..400 {
        let arr = eval(&m, &mut rng);
        assert_eq!(arr.len(), 30);
        let picked: Vec<usize> = (0..30).filter(|&i| arr[i] == Value::Bool(true)).collect();
        for (i, v) in arr.iter().enumerate() {
            if !picked.contains(&i) {
                assert_eq!(v, &Value::Bool(false), "비선택 자리는 rest");
            }
        }
        assert!((2..=3).contains(&picked.len()), "{picked:?}");
        assert!(picked.iter().all(|i| cand.contains(i)), "{picked:?}");
        counts.insert(picked.len());
        distinct.insert(picked);
    }
    assert_eq!(counts, HashSet::from([2, 3]), "k가 [min,max] 양 끝을 모두 낸다");
    assert!(distinct.len() > 50, "반복마다 다른 배열");
}

#[test]
fn eval_clamps_max_to_candidates_and_zero_count() {
    let m = one(r#"{gen: pick_array, length: 10, min: 1, max: 10, positions: "1-3"}"#);
    let mut rng = StdRng::seed_from_u64(1);
    let mut max_seen = 0;
    for _ in 0..200 {
        let n = eval(&m, &mut rng).iter().filter(|v| **v == Value::Bool(true)).count();
        assert!((1..=3).contains(&n));
        max_seen = max_seen.max(n);
    }
    assert_eq!(max_seen, 3);
    let z = one("{gen: pick_array, length: 5, min: 0, max: 0}");
    assert_eq!(eval(&z, &mut rng), vec![Value::Bool(false); 5]);
}

#[test]
fn eval_preserves_value_types_including_null() {
    let mut rng = StdRng::seed_from_u64(3);
    let nums = eval(&one("{gen: pick_array, length: 4, min: 2, max: 2, pick: 1, rest: 0}"), &mut rng);
    assert_eq!(nums.iter().filter(|v| **v == Value::from(1)).count(), 2);
    assert_eq!(nums.iter().filter(|v| **v == Value::from(0)).count(), 2);
    let strs = eval(
        &one(r#"{gen: pick_array, length: 4, min: 1, max: 1, pick: "True", rest: "False"}"#),
        &mut rng,
    );
    assert_eq!(strs.iter().filter(|v| **v == Value::from("True")).count(), 1);
    assert_eq!(strs.iter().filter(|v| **v == Value::from("False")).count(), 3);
    // 명시 null은 기본(false)으로 떨어지지 않는다 (spec §4.1 — round-trip만으로는 공허)
    let nul = eval(&one(r#"{gen: pick_array, length: 3, min: 1, max: 1, pick: "Y", rest: null}"#), &mut rng);
    assert_eq!(nul.iter().filter(|v| v.is_null()).count(), 2);
    assert_eq!(nul.iter().filter(|v| **v == Value::from("Y")).count(), 1);
    let f = eval(&one("{gen: pick_array, length: 2, min: 2, max: 2, pick: 1.5}"), &mut rng);
    assert_eq!(f, vec![Value::from(1.5), Value::from(1.5)]);
}

#[test]
fn roundtrip_preserves_string_vs_typed_values() {
    for spec in [
        r#"{gen: pick_array, length: 30, min: 2, max: 3, positions: "1-5, 8"}"#,
        r#"{gen: pick_array, length: 4, min: 1, max: 2, pick: "True", rest: "1"}"#,
        "{gen: pick_array, length: 4, min: 1, max: 2, pick: 1, rest: null}",
        "{gen: pick_array, length: 4, min: 1, max: 2, pick: true, rest: false}",
        "{gen: pick_array, length: 10, min: 1, max: 1, positions: 8}",
    ] {
        let m = one(spec);
        let out = serde_yaml::to_string(&m).unwrap();
        let back: BTreeMap<String, VarDecl> = serde_yaml::from_str(&out).unwrap();
        assert_eq!(back, m, "spec={spec} out={out}");
    }
    // 방출 순서·생략 규칙: 기본 생략 필드는 키 자체가 없다
    let out = serde_yaml::to_string(&one("{gen: pick_array, length: 10, min: 1, max: 3}")).unwrap();
    assert!(!out.contains("positions") && !out.contains("pick") && !out.contains("rest"), "{out}");
    let g = out.find("gen").unwrap();
    let l = out.find("length").unwrap();
    let mi = out.find("min").unwrap();
    let ma = out.find("max").unwrap();
    assert!(g < l && l < mi && mi < ma, "{out}");
}

#[test]
fn candidates_accessor_full_range_when_positions_absent() {
    match &one("{gen: pick_array, length: 4, min: 1, max: 2}")["x"] {
        VarDecl::Gen(GenSpec::PickArray(g)) => assert_eq!(g.candidates(), &[1, 2, 3, 4]),
        other => panic!("{other:?}"),
    }
}
```

- [ ] **Step 3: 테스트가 실패하는지 확인**

Run: `cargo test -p handicap-engine --test pick_array`
Expected: 컴파일 실패(`parse_positions`·`GenSpec::PickArray` 미정의).

- [ ] **Step 4: `genvars.rs` 구현**

(a) 상수·도메인 타입 — `RandomStringGen` 정의 바로 아래에 추가하고 `GenSpec`에 변형 추가:

```rust
pub const PICK_ARRAY_MAX_LEN: u32 = 1000;
pub const POSITIONS_MAX_CHARS: usize = 4096;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PickArrayGen {
    pub length: u32,
    pub min: u32,
    pub max: u32,
    /// 검증된 원문 보존(emit용, 엔진은 정규화하지 않는다). None = 전체 자리.
    pub positions: Option<String>,
    /// None = true. 존재하면 명시 null도 Some(Value::Null) (present_value).
    pub pick: Option<serde_json::Value>,
    /// None = false.
    pub rest: Option<serde_json::Value>,
    /// 파싱 결과 — 1-based, 오름차순, 중복 없음, 비어 있지 않음.
    pub(crate) candidates: Vec<u32>,
}

impl PickArrayGen {
    pub fn candidates(&self) -> &[u32] {
        &self.candidates
    }
}
```

`pub enum GenSpec`에 `PickArray(PickArrayGen),`를 `RandomString` 다음에 추가.

(b) wire 필드 — `GenSpecWire`의 `length` 필드 아래에:

```rust
    #[serde(default)]
    positions: Option<String>,
    #[serde(default, deserialize_with = "present_value")]
    pick: Option<serde_json::Value>,
    #[serde(default, deserialize_with = "present_value")]
    rest: Option<serde_json::Value>,
```

그리고 `parse_offset_secs` 위에 헬퍼:

```rust
/// pick/rest: 키가 **존재하면** 항상 Some — 평문 `null`도 Some(Value::Null)(serde_yaml의
/// deserialize_option은 null을 None으로 보내므로 Option<Value> 기본 경로를 쓰지 않는다).
/// serde_yaml::Value로 받아 스칼라만 수동 변환 — 비유한 f64는 변환 **전에** 거부한다
/// (Value::deserialize/serde_json::to_value 경로는 .inf/.nan을 조용히 Null로 만든다).
fn present_value<'de, D: Deserializer<'de>>(d: D) -> Result<Option<serde_json::Value>, D::Error> {
    use serde_yaml::Value as Y;
    let v = Y::deserialize(d)?;
    let out = match v {
        Y::Null => serde_json::Value::Null,
        Y::Bool(b) => serde_json::Value::Bool(b),
        Y::String(s) => serde_json::Value::String(s),
        Y::Number(n) => {
            if let Some(i) = n.as_i64() {
                serde_json::Value::from(i)
            } else if let Some(u) = n.as_u64() {
                serde_json::Value::from(u)
            } else {
                let f = n.as_f64().unwrap_or(f64::NAN);
                serde_json::Number::from_f64(f)
                    .map(serde_json::Value::Number)
                    .ok_or_else(|| de::Error::custom("pick/rest 숫자는 유한해야 한다"))?
            }
        }
        _ => {
            return Err(de::Error::custom(
                "pick/rest는 스칼라(불리언·숫자·문자열·null)만 받는다",
            ));
        }
    };
    Ok(Some(out))
}

/// 자리 범위 문법(spec §4.3) — "1-5, 8" → [1,2,3,4,5,8]. 빈/공백 문자열 = Ok(빈 집합)
/// (후보 0은 호출부가 거부). 오류 문구는 값-free(항목 번호만).
pub fn parse_positions(text: &str, length: u32) -> Result<Vec<u32>, String> {
    if text.len() > POSITIONS_MAX_CHARS {
        return Err(format!("positions는 {POSITIONS_MAX_CHARS}자 이하"));
    }
    if text.trim().is_empty() {
        return Ok(Vec::new());
    }
    fn num(s: &str) -> Option<u32> {
        let s = s.trim();
        if s.is_empty() || s.len() > 4 || !s.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        s.parse().ok()
    }
    let mut mark = vec![false; length as usize];
    for (i, raw) in text.split(',').enumerate() {
        let item = raw.trim();
        let (a, b) = match item.split_once('-') {
            Some((x, y)) => (num(x), num(y)),
            None => (num(item), num(item)),
        };
        let (Some(a), Some(b)) = (a, b) else {
            return Err(format!("positions {}번째 항목을 읽을 수 없다", i + 1));
        };
        if a > b {
            return Err(format!("positions {}번째 항목: 앞 번호가 더 크다", i + 1));
        }
        if a < 1 || b > length {
            return Err(format!("positions {}번째 항목: 자리는 1~{length}", i + 1));
        }
        for p in a..=b {
            mark[(p - 1) as usize] = true;
        }
    }
    Ok((1..=length).filter(|p| mark[(p - 1) as usize]).collect())
}
```

(c) allow-list 회귀 함정: `TryFrom`의 기존 4개 arm `deny(...)` 조건 각각 끝에 `|| w.positions.is_some() || w.pick.is_some() || w.rest.is_some()`를 추가한다(문구 불변). 그리고 `"random_string"` arm 다음에 새 arm:

```rust
            "pick_array" => {
                deny(
                    w.format.is_some() || w.offset.is_some() || w.tz.is_some() || w.step.is_some(),
                    "pick_array 생성기는 format/offset/tz/step을 받지 않는다",
                )?;
                let length = w
                    .length
                    .ok_or_else(|| "pick_array는 length가 필수".to_string())?;
                if !(1..=PICK_ARRAY_MAX_LEN).contains(&length) {
                    return Err(format!("length는 1~{PICK_ARRAY_MAX_LEN}: {length}"));
                }
                let (min, max) = match (w.min, w.max) {
                    (Some(a), Some(b)) => (a, b),
                    _ => return Err("pick_array는 min·max가 필수".into()),
                };
                if min < 0 {
                    return Err(format!("min은 0 이상: {min}"));
                }
                if min > max {
                    return Err(format!("min({min}) > max({max})"));
                }
                if max > i64::from(length) {
                    return Err(format!("max({max}) > length({length})"));
                }
                let candidates = match &w.positions {
                    Some(p) => parse_positions(p, length)?,
                    None => (1..=length).collect(),
                };
                if candidates.is_empty() {
                    return Err("positions: 선택될 수 있는 자리가 없다".into());
                }
                if min as usize > candidates.len() {
                    return Err(format!("min({min}) > 후보 수({})", candidates.len()));
                }
                Ok(GenSpec::PickArray(PickArrayGen {
                    length,
                    min: min as u32,
                    max: max as u32,
                    positions: w.positions,
                    pick: w.pick,
                    rest: w.rest,
                    candidates,
                }))
            }
```

(d) Serialize — `impl Serialize for GenSpec`의 match에 arm 추가(주석의 방출 규칙 줄에 `(pick_array) length·min·max 항상·positions/pick/rest는 Some만` 추가):

```rust
            GenSpec::PickArray(g) => {
                let n = 4
                    + g.positions.is_some() as usize
                    + g.pick.is_some() as usize
                    + g.rest.is_some() as usize;
                let mut m = s.serialize_map(Some(n))?;
                m.serialize_entry("gen", "pick_array")?;
                m.serialize_entry("length", &g.length)?;
                m.serialize_entry("min", &g.min)?;
                m.serialize_entry("max", &g.max)?;
                if let Some(p) = &g.positions {
                    m.serialize_entry("positions", p)?;
                }
                if let Some(v) = &g.pick {
                    m.serialize_entry("pick", v)?;
                }
                if let Some(v) = &g.rest {
                    m.serialize_entry("rest", v)?;
                }
                m.end()
            }
```

(e) 평가 — `eval_random_string` 아래:

```rust
pub(crate) fn eval_pick_array(g: &PickArrayGen, rng: &mut StdRng) -> String {
    // 검증: 1 ≤ 후보 수, min ≤ 후보 수, min ≤ max → lo ≤ hi, k ≤ 후보 수(sample panic 불가).
    let c = g.candidates.len();
    let hi = (g.max as usize).min(c);
    let lo = (g.min as usize).min(hi);
    let k = rng.gen_range(lo..=hi);
    let pick = g.pick.clone().unwrap_or(serde_json::Value::Bool(true));
    let rest = g.rest.clone().unwrap_or(serde_json::Value::Bool(false));
    let mut out = vec![rest; g.length as usize];
    for idx in rand::seq::index::sample(rng, c, k).iter() {
        out[(g.candidates[idx] - 1) as usize] = pick.clone();
    }
    serde_json::to_string(&out).unwrap_or_default()
}
```

`seed_iter_vars`의 match에 `VarDecl::Gen(GenSpec::PickArray(g)) => eval_pick_array(g, rng),` 추가.

(f) `crates/engine/src/lib.rs:28`을 다음으로 교체:

```rust
pub use genvars::{
    GenSpec, PICK_ARRAY_MAX_LEN, POSITIONS_MAX_CHARS, PickArrayGen, RandomIntGen,
    RandomStringGen, VarDecl, parse_positions, seed_iter_vars,
};
```

(`cargo fmt`가 정렬을 바꾸면 그대로 둔다.)

- [ ] **Step 5: 테스트 통과 확인**

Run: `cargo test -p handicap-engine --test pick_array` → 전부 PASS. 이어서 `cargo test -p handicap-engine genvars` → 기존 genvars 단위 테스트 PASS(allow-list 변경 회귀 없음).

- [ ] **Step 6: 이빨 실증 (리포트에 기록)**

(1) 기존 `"uuid"` arm의 `|| w.pick.is_some()` 항을 임시 삭제 → `generator_vectors`가 `{gen: uuid, pick: 1}`로 RED → 원복. (2) `pick` 필드의 `deserialize_with = "present_value"`를 임시 삭제 → `eval_preserves_value_types_including_null`이 RED → 원복. (3) `eval_pick_array`의 `lo..=hi`를 `lo..hi`로 임시 변경 → `eval_respects_count_range_and_candidates`가 RED(k=3 미발생) → 원복.

- [ ] **Step 7: 커밋 (FOREGROUND, 600000ms)**

```bash
git add testdata/pick_array_vectors.json crates/engine/tests/pick_array.rs crates/engine/src/genvars.rs crates/engine/src/lib.rs
git diff --cached --name-only
git commit -m "feat(engine): pick_array 선택 배열 생성기 — 게이트·평가·공유 벡터"
git log -1 --oneline
```

---

### Task 2: 엔진 통합 — JSON 바디 와이어·컨트롤러 게이트·proptest

**Files:**
- Modify: `crates/engine/tests/genvars_wiring.rs` (테스트 추가)
- Modify: `crates/controller/tests/scenario_genvars_gate_test.rs` (테스트 추가)
- Modify: `crates/engine/tests/proptests.rs:210-258` (`arb_var_decl`)

**Interfaces:**
- Consumes: Task 1의 `GenSpec::PickArray`, `seed_iter_vars`(내부), 기존 `run_scenario`·`trace_scenario`.

- [ ] **Step 1: JSON 바디 와이어 테스트 작성** — `genvars_wiring.rs` 끝에 추가(기존 `run_and_collect`는 쿼리만 수집하므로 별 헬퍼 없이 독립 테스트):

```rust
const PICK_BODY: &str = "version: 1
name: p
variables:
  flags: {gen: pick_array, length: 6, min: 1, max: 2, positions: \"2-4\", pick: 1, rest: 0}
steps:
  - id: \"01HX0000000000000000000001\"
    name: a
    type: http
    request:
      method: POST
      url: \"{URI}/p\"
      body:
        json:
          flags: \"{{flags:json}}\"
";

fn assert_pick_body(body: &[u8]) {
    let v: serde_json::Value = serde_json::from_slice(body).unwrap();
    let arr = v["flags"].as_array().expect("문자열이 아니라 진짜 배열");
    assert_eq!(arr.len(), 6);
    let ones: Vec<usize> = (0..6).filter(|&i| arr[i] == serde_json::json!(1)).collect();
    assert!((1..=2).contains(&ones.len()), "{arr:?}");
    assert!(ones.iter().all(|i| (1..=3).contains(i)), "후보 2-4(0-based 1..=3): {arr:?}");
    assert!(arr.iter().all(|x| x == &serde_json::json!(1) || x == &serde_json::json!(0)));
}

#[tokio::test]
async fn pick_array_json_body_closed_loop() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;
    let scenario =
        Arc::new(Scenario::from_yaml(&PICK_BODY.replace("{URI}", &server.uri())).unwrap());
    let plan = RunPlan {
        vus: 1,
        ramp_up: Duration::ZERO,
        duration: Duration::from_millis(300),
        env: Default::default(),
        loop_breakdown_cap: 0,
        vu_offset: 0,
        data_bindings: vec![],
        http_timeout: Duration::from_secs(30),
        think_time: None,
        think_seed: None,
        target_rps: None,
        max_in_flight: None,
        stages: None,
        measure_phases: false,
        vu_stages: None,
        ramp_down: RampDown::Graceful,
        graceful_ramp_down: None,
        connect_timeout: None,
    };
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(64);
    let h = tokio::spawn(run_scenario(scenario, plan, tx, CancellationToken::new()));
    while rx.recv().await.is_some() {}
    h.await.unwrap().unwrap();
    let reqs = server.received_requests().await.unwrap();
    assert!(reqs.len() >= 2);
    for r in &reqs {
        assert_pick_body(&r.body);
    }
    let distinct: std::collections::HashSet<_> = reqs.iter().map(|r| r.body.clone()).collect();
    assert!(distinct.len() >= 2, "반복마다 다른 배열");
}

#[tokio::test]
async fn pick_array_json_body_trace() {
    use handicap_engine::{TraceOptions, trace_scenario};
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;
    let scenario = Scenario::from_yaml(&PICK_BODY.replace("{URI}", &server.uri())).unwrap();
    let opts = TraceOptions {
        env: Default::default(),
        max_requests: 5,
        max_wall: Duration::from_secs(5),
        apply_think_time: false,
    };
    let _ = trace_scenario(&scenario, &opts).await;
    let reqs = server.received_requests().await.unwrap();
    assert_eq!(reqs.len(), 1);
    assert_pick_body(&reqs[0].body);
}
```

- [ ] **Step 2: 컨트롤러 게이트 테스트 작성** — `scenario_genvars_gate_test.rs`의 `// ---- POST /api/test-runs: 422 ----` 섹션 위에 추가:

```rust
// ---- pick_array (spec 2026-10-17) ----

#[tokio::test]
async fn create_accepts_pick_array_and_get_preserves_it() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);
    let yaml = scenario_with_var(
        "pick-ok",
        r#"{gen: pick_array, length: 30, min: 2, max: 3, positions: "1-5, 8", pick: "Y", rest: "N"}"#,
    );
    let (status, created) = post_scenario(&app, &yaml).await;
    assert_eq!(status, StatusCode::CREATED, "body: {created}");
    let id = created["id"].as_str().unwrap();
    let (status, fetched) = get_scenario(&app, id).await;
    assert_eq!(status, StatusCode::OK);
    let y = fetched["yaml"].as_str().unwrap();
    assert!(y.contains("pick_array") && y.contains("1-5, 8"), "got: {y}");
}

#[tokio::test]
async fn create_rejects_pick_array_max_over_length() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);
    let yaml = scenario_with_var("pick-bad", "{gen: pick_array, length: 10, min: 1, max: 11}");
    let (status, body) = post_scenario(&app, &yaml).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "body: {body}");
    let msg = body["error"].as_str().unwrap();
    assert!(msg.contains("max(11)") && msg.contains("length(10)"), "got: {msg}");
}

#[tokio::test]
async fn test_run_rejects_pick_array_without_candidates_with_422() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);
    let yaml = scenario_with_var(
        "pick-tr-bad",
        r#"{gen: pick_array, length: 10, min: 0, max: 1, positions: ""}"#,
    );
    let (status, body) = post_test_run(&app, &yaml).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "body: {body}");
}
```

- [ ] **Step 3: proptest 확장** — `proptests.rs`의 `arb_var_decl` `prop_oneof!` 마지막 항목(`(1u32..=64).prop_map(...)`) 뒤에 추가(candidates가 `pub(crate)`라 serde 경유로만 구성):

```rust
        // pick_array: serde 경유 구성(candidates 캐시가 pub(crate)) — 유효 파라미터만.
        (
            1u32..=40,
            prop_oneof![Just(None), Just(Some("1")), Just(Some("1-3, 5"))],
            prop_oneof![
                Just(None),
                Just(Some(serde_yaml::Value::from("True"))),
                Just(Some(serde_yaml::Value::Number(1.into()))),
                Just(Some(serde_yaml::Value::Null)),
            ],
        )
            .prop_map(|(len, pos, pick)| {
                let length = len.max(5); // "1-3, 5"가 유효하도록
                let mut m = serde_yaml::Mapping::new();
                m.insert("gen".into(), "pick_array".into());
                m.insert("length".into(), serde_yaml::Value::Number(u64::from(length).into()));
                m.insert("min".into(), serde_yaml::Value::Number(1.into()));
                m.insert("max".into(), serde_yaml::Value::Number(2.into()));
                if let Some(p) = pos {
                    m.insert("positions".into(), p.into());
                }
                if let Some(v) = pick {
                    m.insert("pick".into(), v);
                }
                serde_yaml::from_value::<VarDecl>(serde_yaml::Value::Mapping(m)).unwrap()
            }),
```

- [ ] **Step 4: 실행**

Run: `cargo test -p handicap-engine --test genvars_wiring pick_array` / `cargo test -p handicap-controller --test scenario_genvars_gate_test pick_array` / `cargo test -p handicap-engine --test proptests` → 전부 PASS.

- [ ] **Step 5: 이빨 실증** — 와이어 테스트: PICK_BODY의 `"{{flags:json}}"`을 임시로 `"{{flags}}"`로 바꾸면 `as_array().expect` RED(문자열로 나감) → 원복.

- [ ] **Step 6: 커밋 (FOREGROUND, 600000ms)**

```bash
git add crates/engine/tests/genvars_wiring.rs crates/controller/tests/scenario_genvars_gate_test.rs crates/engine/tests/proptests.rs
git diff --cached --name-only
git commit -m "test(engine,controller): pick_array JSON 바디 와이어·게이트 400/422·proptest"
git log -1 --oneline
```

---

### Task 3: UI 순수 모듈 — 범위·리터럴 파서/포매터·샘플러·`:json` 참조 스캔

**Files:**
- Create: `ui/src/scenario/pickArray.ts`
- Create: `ui/src/scenario/__tests__/pickArray.test.ts`
- Modify: `ui/src/scenario/cast.ts:11` (`PURE_FLOW` export)
- Modify: `ui/src/scenario/scanVars.ts` (`jsonCastVarNames` 추가)
- Modify: `ui/src/scenario/__tests__/scanVars.test.ts` (테스트 추가)

**Interfaces:**
- Produces (`pickArray.ts`, 의존: 없음 — genVars.ts가 이것을 import하므로 역방향 import 금지):
  - `PICK_ARRAY_MAX_LEN = 1000`, `POSITIONS_MAX_CHARS = 4096`
  - `type PositionsError = { kind: "tooLong" } | { kind: "badItem"; index: number } | { kind: "outOfRange"; index: number } | { kind: "reversed"; index: number }` (index는 1-based 항목 번호)
  - `parsePositions(text: string, length: number): { ok: true; set: number[] } | { ok: false; error: PositionsError }`
  - `formatPositions(set: readonly number[]): string`
  - `isFullRange(set: readonly number[], length: number): boolean`
  - `trimPositionsForLength(text: string, baseLength: number, newLength: number): string`
  - `type JsonScalar = boolean | number | string | null`
  - `parseValueLiteral(text: string): { ok: true; value: JsonScalar } | { ok: false; reason: "empty" | "badQuoted" | "nonFinite" }`
  - `formatValueLiteral(v: JsonScalar): string`
  - `jsonScalarKind(v: JsonScalar): "boolean" | "number" | "string" | "null"`
  - `VALUE_PRESETS: ReadonlyArray<{ pick: JsonScalar; rest: JsonScalar }>` + `presetIndexOf(pick: JsonScalar, rest: JsonScalar): number`
  - `type PickParams = { length: number; min: number; max: number; positions?: string; pick?: JsonScalar; rest?: JsonScalar }`
  - `candidatesOf(p: PickParams): number[] | null` (positions 무효면 null)
  - `samplePickArray(p: PickParams, rand: () => number): string | null`
- Produces (`scanVars.ts`): `jsonCastVarNames(scenario: Scenario): Set<string>`

- [ ] **Step 1: 실패하는 테스트 작성** — `ui/src/scenario/__tests__/pickArray.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  VALUE_PRESETS,
  candidatesOf,
  formatPositions,
  formatValueLiteral,
  isFullRange,
  parsePositions,
  parseValueLiteral,
  presetIndexOf,
  samplePickArray,
  trimPositionsForLength,
  type JsonScalar,
} from "../pickArray";
import { seededRand } from "../genVars";

type PosVec = { text: string; length: number; expect: string; set?: number[]; canonical?: string };
const VECTORS = JSON.parse(
  readFileSync(path.resolve(__dirname, "../../../../testdata/pick_array_vectors.json"), "utf8"),
) as { positions: PosVec[] };

describe("parsePositions / formatPositions — 공유 벡터(엔진 lockstep)", () => {
  for (const v of VECTORS.positions) {
    it(`${v.expect}: ${JSON.stringify(v.text)} (len ${v.length})`, () => {
      const r = parsePositions(v.text, v.length);
      if (v.expect === "accept") {
        expect(r).toEqual({ ok: true, set: v.set });
        if (r.ok) expect(formatPositions(r.set)).toBe(v.canonical);
      } else {
        expect(r.ok).toBe(false);
      }
    });
  }

  it("4096자 경계: 4096 수용, 4097 tooLong", () => {
    const at = `${"1, ".repeat(1365)}1`;
    expect(at.length).toBe(4096);
    expect(parsePositions(at, 10)).toEqual({ ok: true, set: [1] });
    expect(parsePositions(`${at} `, 10)).toEqual({ ok: false, error: { kind: "tooLong" } });
  });

  it("오류 종류와 1-based 항목 번호", () => {
    expect(parsePositions("1, x", 10)).toEqual({ ok: false, error: { kind: "badItem", index: 2 } });
    expect(parsePositions("1, 11", 10)).toEqual({ ok: false, error: { kind: "outOfRange", index: 2 } });
    expect(parsePositions("5-3", 10)).toEqual({ ok: false, error: { kind: "reversed", index: 1 } });
  });

  it("프로퍼티: format→parse→format 고정점 (numRuns 40)", () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.integer({ min: 1, max: 60 }), { maxLength: 30 }), (xs) => {
        const f = formatPositions(xs);
        const back = parsePositions(f, 60);
        expect(back.ok).toBe(true);
        if (back.ok) {
          expect(back.set).toEqual([...xs].sort((a, b) => a - b));
          expect(formatPositions(back.set)).toBe(f);
        }
      }),
      { numRuns: 40 },
    );
  });

  it("isFullRange / trimPositionsForLength", () => {
    expect(isFullRange([1, 2, 3], 3)).toBe(true);
    expect(isFullRange([1, 3], 3)).toBe(false);
    expect(trimPositionsForLength("1-30", 30, 25)).toBe("1-25"); // 전체 → 새 전체
    expect(trimPositionsForLength("1-5, 8, 12-20", 30, 10)).toBe("1-5, 8"); // 일부 → 범위 밖 제거
    expect(trimPositionsForLength("1-5, 28", 30, 25)).toBe("1-5");
    expect(trimPositionsForLength("1 - 3", 30, 30)).toBe("1 - 3"); // 같은 길이 = 원문 그대로
    expect(trimPositionsForLength("x", 30, 10)).toBe("x"); // 파싱 실패 = 원문 그대로
  });
});

describe("parseValueLiteral / formatValueLiteral", () => {
  it("규칙(spec §5)", () => {
    expect(parseValueLiteral(" true ")).toEqual({ ok: true, value: true });
    expect(parseValueLiteral("null")).toEqual({ ok: true, value: null });
    expect(parseValueLiteral("1")).toEqual({ ok: true, value: 1 });
    expect(parseValueLiteral("-1.5e2")).toEqual({ ok: true, value: -150 });
    expect(parseValueLiteral('"1"')).toEqual({ ok: true, value: "1" });
    expect(parseValueLiteral("Y")).toEqual({ ok: true, value: "Y" });
    expect(parseValueLiteral("True")).toEqual({ ok: true, value: "True" });
    expect(parseValueLiteral("")).toEqual({ ok: false, reason: "empty" });
    expect(parseValueLiteral('"a"b"')).toEqual({ ok: false, reason: "badQuoted" });
    expect(parseValueLiteral("1e999")).toEqual({ ok: false, reason: "nonFinite" });
  });

  it("포매터는 파서 기준으로 따옴표를 붙인다", () => {
    expect(formatValueLiteral(true)).toBe("true");
    expect(formatValueLiteral(1)).toBe("1");
    expect(formatValueLiteral(null)).toBe("null");
    expect(formatValueLiteral("Y")).toBe("Y");
    expect(formatValueLiteral("1")).toBe('"1"');
    expect(formatValueLiteral("true")).toBe('"true"');
    expect(formatValueLiteral("1e999")).toBe('"1e999"');
    expect(formatValueLiteral(" a")).toBe('" a"');
    expect(formatValueLiteral("")).toBe('""');
  });

  it("프로퍼티: 왕복 불변식 (-0 제외, numRuns 40)", () => {
    const scalar = fc.oneof(
      fc.boolean(),
      fc.constant(null),
      fc.double({ noNaN: true, noDefaultInfinity: true }).filter((n) => !Object.is(n, -0)),
      fc.string(),
    ) as fc.Arbitrary<JsonScalar>;
    fc.assert(
      fc.property(scalar, (v) => {
        expect(parseValueLiteral(formatValueLiteral(v))).toEqual({ ok: true, value: v });
      }),
      { numRuns: 40 },
    );
  });

  it("프리셋 인덱스", () => {
    expect(VALUE_PRESETS).toHaveLength(4);
    expect(presetIndexOf(true, false)).toBe(0);
    expect(presetIndexOf("True", "False")).toBe(1);
    expect(presetIndexOf(1, 0)).toBe(2);
    expect(presetIndexOf("Y", "N")).toBe(3);
    expect(presetIndexOf("1", "0")).toBe(-1); // 문자열 "1"은 숫자 프리셋 아님
    expect(presetIndexOf(true, null)).toBe(-1);
  });
});

describe("samplePickArray", () => {
  it("길이·개수·후보·값 타입 불변식 (엔진 분포와 동일 규칙)", () => {
    const p = { length: 30, min: 2, max: 3, positions: "1-5, 8, 12-20", pick: 1, rest: 0 };
    const cand = new Set(candidatesOf(p)!);
    const rand = seededRand(42);
    const counts = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const arr = JSON.parse(samplePickArray(p, rand)!) as number[];
      expect(arr).toHaveLength(30);
      const picked = arr.flatMap((x, idx) => (x === 1 ? [idx + 1] : []));
      expect(picked.every((q) => cand.has(q))).toBe(true);
      expect(arr.every((x) => x === 0 || x === 1)).toBe(true);
      counts.add(picked.length);
    }
    expect([...counts].sort()).toEqual([2, 3]);
  });

  it("max > 후보 수면 후보 수로 상한, positions 무효면 null", () => {
    const rand = seededRand(1);
    for (let i = 0; i < 50; i++) {
      const arr = JSON.parse(
        samplePickArray({ length: 10, min: 1, max: 10, positions: "1-3" }, rand)!,
      ) as boolean[];
      expect(arr.filter(Boolean).length).toBeLessThanOrEqual(3);
    }
    expect(samplePickArray({ length: 10, min: 1, max: 1, positions: "x" }, rand)).toBeNull();
  });
});
```

`ui/src/scenario/__tests__/scanVars.test.ts` 끝에 추가(파일 상단 import에 `jsonCastVarNames` 추가, 시나리오 로딩은 그 파일의 기존 헬퍼/`parseScenarioDoc` 관례를 따른다 — 아래는 `parseScenarioDoc` 사용 예):

```ts
describe("jsonCastVarNames", () => {
  it("JSON 바디의 순수 {{x:json}}만 모은다 — 중첩 컨테이너 포함, 혼합·캐스트없음·env 제외", () => {
    const parsed = parseScenarioDoc(`version: 1
name: j
steps:
  - id: "01HX0000000000000000000001"
    name: a
    type: http
    request:
      method: POST
      url: "http://x"
      body:
        json:
          a: "{{seats:json}}"
          b: "{{plain}}"
          c: "x{{mixed:json}}"
          d: "\${ENVV:json}"
          e: { deep: [" {{ nested : json }} "] }
          f: "{{numy:num}}"
  - id: "01HX0000000000000000000002"
    name: L
    type: loop
    repeat: 1
    do:
      - id: "01HX0000000000000000000003"
        name: inner
        type: http
        request:
          method: POST
          url: "http://x"
          body: { json: { g: "{{inloop:json}}" } }
`);
    if (!("model" in parsed)) throw new Error("parse failed");
    expect(jsonCastVarNames(parsed.model)).toEqual(new Set(["seats", "nested", "inloop"]));
  });
});
```

(`parseScenarioDoc`가 scanVars.test.ts에 아직 import돼 있지 않으면 `import { parseScenarioDoc } from "../yamlDoc";`를 추가. 템플릿 리터럴 안 `${`는 `\${`로 이스케이프.)

- [ ] **Step 2: 실패 확인** — Run: `cd ui && pnpm test pickArray` / `pnpm test scanVars` → import 실패로 FAIL.

- [ ] **Step 3: `cast.ts:11` export** — `const PURE_FLOW =`를 `export const PURE_FLOW =`로.

- [ ] **Step 4: `ui/src/scenario/pickArray.ts` 작성**

```ts
// 선택 배열(pick_array) 순수 헬퍼 — 엔진 crates/engine/src/genvars.rs와 lockstep
// (판정 벡터: testdata/pick_array_vectors.json). 무의존: genVars.ts가 이 모듈을 import한다.

export const PICK_ARRAY_MAX_LEN = 1000;
export const POSITIONS_MAX_CHARS = 4096;

export type PositionsError =
  | { kind: "tooLong" }
  | { kind: "badItem"; index: number }
  | { kind: "outOfRange"; index: number }
  | { kind: "reversed"; index: number };

export type PositionsResult = { ok: true; set: number[] } | { ok: false; error: PositionsError };

const NUM = /^[0-9]{1,4}$/;

export function parsePositions(text: string, length: number): PositionsResult {
  if (text.length > POSITIONS_MAX_CHARS) return { ok: false, error: { kind: "tooLong" } };
  if (text.trim() === "") return { ok: true, set: [] };
  const mark = new Array<boolean>(Math.max(0, length)).fill(false);
  const items = text.split(",");
  for (let i = 0; i < items.length; i++) {
    const item = items[i].trim();
    const dash = item.indexOf("-");
    const [x, y] = dash === -1 ? [item, item] : [item.slice(0, dash), item.slice(dash + 1)];
    const xs = x.trim();
    const ys = y.trim();
    if (!NUM.test(xs) || !NUM.test(ys)) return { ok: false, error: { kind: "badItem", index: i + 1 } };
    const a = Number(xs);
    const b = Number(ys);
    if (a > b) return { ok: false, error: { kind: "reversed", index: i + 1 } };
    if (a < 1 || b > length) return { ok: false, error: { kind: "outOfRange", index: i + 1 } };
    for (let p = a; p <= b; p++) mark[p - 1] = true;
  }
  const set: number[] = [];
  for (let p = 1; p <= length; p++) if (mark[p - 1]) set.push(p);
  return { ok: true, set };
}

export function formatPositions(set: readonly number[]): string {
  const xs = [...new Set(set)].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < xs.length; ) {
    let j = i;
    while (j + 1 < xs.length && xs[j + 1] === xs[j] + 1) j++;
    out.push(i === j ? `${xs[i]}` : `${xs[i]}-${xs[j]}`);
    i = j + 1;
  }
  return out.join(", ");
}

export function isFullRange(set: readonly number[], length: number): boolean {
  return set.length === length && set.every((p, i) => p === i + 1);
}

/** 길이 변경 시 positions 깎기 규칙(spec §6.3). 같은 길이·파싱 실패면 원문 그대로. */
export function trimPositionsForLength(text: string, baseLength: number, newLength: number): string {
  if (newLength === baseLength) return text;
  const r = parsePositions(text, baseLength);
  if (!r.ok) return text;
  if (isFullRange(r.set, baseLength)) return `1-${newLength}`;
  return formatPositions(r.set.filter((p) => p <= newLength));
}

export type JsonScalar = boolean | number | string | null;
export type LiteralResult =
  | { ok: true; value: JsonScalar }
  | { ok: false; reason: "empty" | "badQuoted" | "nonFinite" };

const JSON_NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;

export function parseValueLiteral(text: string): LiteralResult {
  const t = text.trim();
  if (t === "") return { ok: false, reason: "empty" };
  if (t.startsWith('"')) {
    try {
      const v: unknown = JSON.parse(t);
      return typeof v === "string" ? { ok: true, value: v } : { ok: false, reason: "badQuoted" };
    } catch {
      return { ok: false, reason: "badQuoted" };
    }
  }
  if (t === "true") return { ok: true, value: true };
  if (t === "false") return { ok: true, value: false };
  if (t === "null") return { ok: true, value: null };
  if (JSON_NUMBER.test(t)) {
    const n = Number(t);
    return Number.isFinite(n) ? { ok: true, value: n } : { ok: false, reason: "nonFinite" };
  }
  return { ok: true, value: t };
}

export function formatValueLiteral(v: JsonScalar): string {
  if (typeof v !== "string") return JSON.stringify(v);
  const r = parseValueLiteral(v);
  return r.ok && r.value === v ? v : JSON.stringify(v);
}

export function jsonScalarKind(v: JsonScalar): "boolean" | "number" | "string" | "null" {
  if (v === null) return "null";
  return typeof v as "boolean" | "number" | "string";
}

export const VALUE_PRESETS: ReadonlyArray<{ pick: JsonScalar; rest: JsonScalar }> = [
  { pick: true, rest: false },
  { pick: "True", rest: "False" },
  { pick: 1, rest: 0 },
  { pick: "Y", rest: "N" },
];

export function presetIndexOf(pick: JsonScalar, rest: JsonScalar): number {
  return VALUE_PRESETS.findIndex((p) => Object.is(p.pick, pick) && Object.is(p.rest, rest));
}

export type PickParams = {
  length: number;
  min: number;
  max: number;
  positions?: string;
  pick?: JsonScalar;
  rest?: JsonScalar;
};

export function candidatesOf(p: PickParams): number[] | null {
  if (p.positions === undefined) return Array.from({ length: p.length }, (_, i) => i + 1);
  const r = parsePositions(p.positions, p.length);
  return r.ok ? r.set : null;
}

/** 엔진 eval_pick_array와 같은 분포: k ~ U[min, min(max, c)], 후보 비복원 균등. */
export function samplePickArray(p: PickParams, rand: () => number): string | null {
  const cand = candidatesOf(p);
  if (cand === null || cand.length === 0) return null;
  const hi = Math.min(p.max, cand.length);
  const lo = Math.min(p.min, hi);
  const k = lo + Math.floor(rand() * (hi - lo + 1));
  const pool = [...cand];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const pick = p.pick === undefined ? true : p.pick;
  const rest = p.rest === undefined ? false : p.rest;
  const out: JsonScalar[] = new Array<JsonScalar>(p.length).fill(rest);
  for (const q of pool.slice(0, k)) out[q - 1] = pick;
  return JSON.stringify(out);
}
```

- [ ] **Step 5: `scanVars.ts`에 `jsonCastVarNames` 추가** (파일 상단 import에 `PURE_FLOW`(from `./cast`)·`flattenHttpSteps`(from `./model`, 이미 있으면 생략) 추가):

```ts
/** JSON 바디에서 **순수 단일 flow 토큰** `"{{x:json}}"`으로 쓰인 변수의 base 이름(pick-array
 *  spec §5) — 미정의 행의 `배열로 추가` 노출 조건. 혼합 leaf·캐스트 없음·env 토큰은 제외. */
export function jsonCastVarNames(scenario: Scenario): Set<string> {
  const out = new Set<string>();
  const walk = (v: unknown): void => {
    if (typeof v === "string") {
      const m = PURE_FLOW.exec(v.trim());
      if (m) {
        const { base, cast } = splitFlowToken(m[1]);
        if (cast === "json") out.add(base);
      }
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x);
    } else if (v !== null && typeof v === "object") {
      for (const x of Object.values(v as Record<string, unknown>)) walk(x);
    }
  };
  for (const s of flattenHttpSteps(scenario.steps)) {
    const b = s.request.body;
    if (b && b.kind === "json") walk(b.value);
  }
  return out;
}
```

- [ ] **Step 6: 통과 확인** — `cd ui && pnpm test pickArray` · `pnpm test scanVars` → PASS.

- [ ] **Step 7: 이빨 실증** — (1) `parsePositions`의 빈 항목 거부를 우회(`if (item === "") continue;` 임시 삽입) → 벡터 `"1,,2"` RED → 원복. (2) `formatValueLiteral`을 `typeof v === "string" ? v : JSON.stringify(v)`로 임시 변경 → 왕복 프로퍼티 RED → 원복.

- [ ] **Step 8: 게이트+커밋 (FOREGROUND)**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/genvar-array/ui && pnpm lint; echo exit=$?
cd /Users/sgj/develop/handicap/.claude/worktrees/genvar-array/ui && pnpm build; echo exit=$?
cd /Users/sgj/develop/handicap/.claude/worktrees/genvar-array
git add ui/src/scenario/pickArray.ts ui/src/scenario/__tests__/pickArray.test.ts ui/src/scenario/cast.ts ui/src/scenario/scanVars.ts ui/src/scenario/__tests__/scanVars.test.ts
git diff --cached --name-only
git commit -m "feat(ui): pick-array 순수 헬퍼(범위·리터럴·샘플러)·jsonCastVarNames"
git log -1 --oneline
```

---

### Task 4: UI 모델 — Zod 멤버·요약/라벨·yamlDoc 왕복·공유 벡터 양방향

**Files:**
- Modify: `ui/src/scenario/genVars.ts` (Zod·`PickArraySpec`·`PICK_ARRAY_DEFAULT`·switch 4곳)
- Modify: `ui/src/i18n/ko.ts` (genType·요약 키)
- Create: `ui/src/scenario/__tests__/pickArrayVectors.test.ts`
- Modify: `ui/src/scenario/__tests__/genVars.test.ts`, `ui/src/scenario/__tests__/yamlDoc.test.ts` (테스트 추가)

**Interfaces:**
- Consumes: Task 3 `pickArray.ts` 전부.
- Produces (`genVars.ts`): `type PickArraySpec = Extract<GenSpec, { gen: "pick_array" }>` · `PICK_ARRAY_DEFAULT: PickArraySpec = { gen: "pick_array", length: 10, min: 1, max: 3 }` · `isPickArray(v: VarDeclValue): v is PickArraySpec` · `genTypeLabel`/`canonicalGenKey`/`genParamsSummary`/`sampleFor`가 pick_array 처리.
- Produces (`ko.ts` `ko.editor`): `genTypePickArray: "선택 배열"`, `pickSummary(length, min, max, candidates: number | null, values: string | null): string`.

- [ ] **Step 1: 실패하는 테스트 작성**

`ui/src/scenario/__tests__/pickArrayVectors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { GenSpecModel } from "../genVars";

// 생성기 판정 벡터 — 엔진 crates/engine/tests/pick_array.rs와 같은 파일, 양방향:
// accept ⇔ Zod 성공, reject ⇔ Zod 실패, known_divergence = UI 수용(엔진만 거부, spec §4.1).
const VECTORS = JSON.parse(
  readFileSync(path.resolve(__dirname, "../../../../testdata/pick_array_vectors.json"), "utf8"),
) as { generators: { yaml: string; expect: string }[] };

describe("GenSpecModel ↔ 엔진 공유 벡터", () => {
  for (const v of VECTORS.generators) {
    it(`${v.expect}: ${v.yaml}`, () => {
      const r = GenSpecModel.safeParse(parse(v.yaml));
      expect(r.success).toBe(v.expect !== "reject");
    });
  }

  it("positions 숫자 스칼라는 문자열로 정규화", () => {
    const r = GenSpecModel.safeParse(parse("{gen: pick_array, length: 10, min: 1, max: 1, positions: 8}"));
    expect(r.success && r.data.gen === "pick_array" && r.data.positions).toBe("8");
  });

  it("positions 4097자 거부(문법 검사보다 먼저)", () => {
    const at = `${"1, ".repeat(1365)}1`;
    expect(GenSpecModel.safeParse({ gen: "pick_array", length: 10, min: 1, max: 1, positions: at }).success).toBe(true);
    expect(GenSpecModel.safeParse({ gen: "pick_array", length: 10, min: 1, max: 1, positions: `${at} ` }).success).toBe(false);
  });
});
```

`genVars.test.ts`에 추가(기존 import 블록에 `genParamsSummary, genTypeLabel, canonicalGenKey, sampleFor` 등이 없으면 추가):

```ts
describe("pick_array 표시", () => {
  const base = { gen: "pick_array" as const, length: 30, min: 2, max: 3 };
  it("라벨·요약(불리언 전제 문구 없음)", () => {
    expect(genTypeLabel(base)).toBe("선택 배열");
    expect(genParamsSummary(base)).toBe("30칸 · 2~3개 선택 · 전체 자리");
    expect(genParamsSummary({ ...base, min: 2, max: 2, positions: "1-5, 8" })).toBe(
      "30칸 · 2개 선택 · 후보 6자리",
    );
    expect(genParamsSummary({ ...base, pick: 1, rest: 0 })).toBe("30칸 · 2~3개 선택 · 전체 자리 · 1/0");
    expect(genParamsSummary({ ...base, pick: "1", rest: "0" })).toBe(
      '30칸 · 2~3개 선택 · 전체 자리 · "1"/"0"',
    );
    expect(genParamsSummary(base)).not.toMatch(/true|불리언/);
  });
  it("canonicalGenKey는 값 타입을 구분", () => {
    expect(canonicalGenKey({ ...base, pick: 1 })).not.toBe(canonicalGenKey({ ...base, pick: "1" }));
  });
  it("sampleFor는 JSON 배열 문자열", () => {
    const s = sampleFor(base, new Date(), () => 0.5);
    expect(s.kind).toBe("ok");
    if (s.kind === "ok") expect(JSON.parse(s.text)).toHaveLength(30);
  });
});
```

`yamlDoc.test.ts`에 추가(그 파일의 기존 store/edit 헬퍼 관례를 따른다 — 아래는 store 직접 사용 예; 파일 상단에 `useScenarioEditor` import가 없으면 추가):

```ts
describe("pick_array YAML 왕복", () => {
  it("문자열 값은 따옴표로 보존되고 기본값·전체 positions는 키 생략", () => {
    const s = useScenarioEditor.getState();
    s.resetEmpty();
    s.setVariableGen("flags", { gen: "pick_array", length: 4, min: 1, max: 2, pick: "True", rest: "1" });
    const y = useScenarioEditor.getState().yamlText;
    expect(y).toMatch(/pick: "True"|pick: 'True'/);
    expect(y).toMatch(/rest: "1"|rest: '1'/);
    const v = useScenarioEditor.getState().model!.variables.flags;
    expect(v).toEqual({ gen: "pick_array", length: 4, min: 1, max: 2, pick: "True", rest: "1" });
    s.setVariableGen("g", { gen: "pick_array", length: 4, min: 1, max: 2 });
    const y2 = useScenarioEditor.getState().yamlText;
    const gBlock = y2.slice(y2.indexOf("g:"));
    expect(gBlock).not.toMatch(/positions|pick|rest/);
  });
  it("rename은 pick_array 맵 전체를 보존", () => {
    const s = useScenarioEditor.getState();
    s.resetEmpty();
    s.setVariableGen("flags", { gen: "pick_array", length: 6, min: 1, max: 2, positions: "2-4", pick: 1, rest: 0 });
    s.renameVariable("flags", "seats");
    expect(useScenarioEditor.getState().model!.variables.seats).toEqual({
      gen: "pick_array", length: 6, min: 1, max: 2, positions: "2-4", pick: 1, rest: 0,
    });
  });
});
```

(`renameVariable`의 실제 시그니처/반환은 `ui/src/scenario/store.ts`에서 확인 후 맞춘다 — 반환값이 있으면 무시.)

- [ ] **Step 2: 실패 확인** — `cd ui && pnpm test pickArrayVectors` · `pnpm test genVars` · `pnpm test yamlDoc` → FAIL.

- [ ] **Step 3: `ko.ts`** — `ko.editor`의 `genTypeRandomString` 다음 줄에 `genTypePickArray: "선택 배열",`, `genMinMaxConflict` 다음에:

```ts
    // ── 선택 배열 (pick-array) — 값이 불리언이라는 전제 문구 금지(spec §3) ──
    pickSummary: (
      length: number,
      min: number,
      max: number,
      candidates: number | null,
      values: string | null,
    ) =>
      `${length}칸 · ${min === max ? `${min}개 선택` : `${min}~${max}개 선택`} · ${
        candidates === null ? "전체 자리" : `후보 ${candidates}자리`
      }${values ? ` · ${values}` : ""}`,
```

- [ ] **Step 4: `genVars.ts`**

(a) import 추가: `import { POSITIONS_MAX_CHARS, PICK_ARRAY_MAX_LEN, candidatesOf, formatValueLiteral, isFullRange, parsePositions, samplePickArray } from "./pickArray";`

(b) `RandomStringGenModel` 다음:

```ts
const JsonScalarModel = z.union([z.boolean(), z.number().finite(), z.string(), z.null()]);
const PickArrayGenModel = z
  .object({
    gen: z.literal("pick_array"),
    length: z.number().int().min(1).max(PICK_ARRAY_MAX_LEN),
    min: z.number().int().min(0),
    max: z.number().int().min(0),
    // yaml 패키지는 `positions: 8`을 숫자로 읽는다 — 엔진(serde_yaml 평문 스칼라=문자열)과
    // 맞추려 정수를 문자열로 정규화(spec §4.1). 필드 레벨 transform이라 멤버는 ZodObject 유지.
    positions: z.union([z.string(), z.number().int()]).transform(String).optional(),
    pick: JsonScalarModel.optional(),
    rest: JsonScalarModel.optional(),
  })
  .strict();
```

(c) `GenSpecModel`의 discriminatedUnion 배열에 `PickArrayGenModel` 추가, `superRefine` 본문에 추가:

```ts
    if (v.gen === "pick_array") {
      if (v.min > v.max)
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "min > max", path: ["min"] });
      if (v.max > v.length)
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "max > length", path: ["max"] });
      if (v.positions !== undefined && v.positions.length > POSITIONS_MAX_CHARS) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "positions too long", path: ["positions"] });
        return;
      }
      const cand =
        v.positions === undefined ? null : parsePositions(v.positions, v.length);
      if (cand !== null && !cand.ok) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "positions invalid", path: ["positions"] });
        return;
      }
      const c = cand === null ? v.length : cand.set.length;
      if (c === 0)
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "no candidates", path: ["positions"] });
      else if (v.min > c)
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "min > candidates", path: ["min"] });
    }
```

(d) 타입·기본값·가드 — `export type VarDeclValue` 다음:

```ts
export type PickArraySpec = Extract<GenSpec, { gen: "pick_array" }>;
export const PICK_ARRAY_DEFAULT: PickArraySpec = { gen: "pick_array", length: 10, min: 1, max: 3 };
export function isPickArray(v: VarDeclValue): v is PickArraySpec {
  return typeof v !== "string" && v.gen === "pick_array";
}
```

(e) switch 4곳에 case 추가:

```ts
    // genTypeLabel
    case "pick_array":
      return ko.editor.genTypePickArray;
```
```ts
    // canonicalGenKey
    case "pick_array":
      return `pa:${spec.length}:${spec.min}:${spec.max}:${spec.positions ?? ""}:${JSON.stringify(spec.pick ?? true)}:${JSON.stringify(spec.rest ?? false)}`;
```
```ts
    // genParamsSummary
    case "pick_array": {
      const cand = candidatesOf(spec);
      const full = cand === null || isFullRange(cand, spec.length);
      const pick = spec.pick === undefined ? true : spec.pick;
      const rest = spec.rest === undefined ? false : spec.rest;
      const values =
        pick === true && rest === false
          ? null
          : `${formatValueLiteral(pick)}/${formatValueLiteral(rest)}`;
      return ko.editor.pickSummary(spec.length, spec.min, spec.max, full ? null : cand!.length, values);
    }
```
```ts
    // sampleFor
    case "pick_array": {
      const text = samplePickArray(spec, rand);
      return text === null ? { kind: "unsupported" } : { kind: "ok", text };
    }
```

- [ ] **Step 5: 통과 확인** — `pnpm test pickArrayVectors` · `pnpm test genVars` · `pnpm test yamlDoc` → PASS. 그다음 `pnpm build` — `positions` transform으로 `GenSpec`(output)·input 타입이 갈려 깨지는 소비처가 있으면 output 타입(`GenSpec`)을 쓰도록 고친다(예상: 없음 — yamlDoc·store는 output 형을 받는다).

- [ ] **Step 6: 이빨 실증** — `superRefine`의 `max > length` 분기를 임시 삭제 → 벡터 `{… min: 1, max: 11}` RED → 원복.

- [ ] **Step 7: 게이트+커밋 (FOREGROUND)**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/genvar-array/ui && pnpm lint; echo exit=$?
cd /Users/sgj/develop/handicap/.claude/worktrees/genvar-array/ui && pnpm test; echo exit=$?
cd /Users/sgj/develop/handicap/.claude/worktrees/genvar-array/ui && pnpm build; echo exit=$?
cd /Users/sgj/develop/handicap/.claude/worktrees/genvar-array
git add ui/src/scenario/genVars.ts ui/src/i18n/ko.ts ui/src/scenario/__tests__/pickArrayVectors.test.ts ui/src/scenario/__tests__/genVars.test.ts ui/src/scenario/__tests__/yamlDoc.test.ts
git diff --cached --name-only
git commit -m "feat(ui): pick_array Zod 모델·요약·yaml 왕복 + 엔진 공유 벡터 양방향"
git log -1 --oneline
```

---

### Task 5: UI 팝업 — `PickArrayDialog`

**Files:**
- Create: `ui/src/components/scenario/PickArrayDialog.tsx`
- Create: `ui/src/components/scenario/__tests__/PickArrayDialog.test.tsx`
- Modify: `ui/src/i18n/ko.ts` (`pick*` 팝업 문구)

**Interfaces:**
- Consumes: Task 3 `pickArray.ts`, Task 4 `PickArraySpec`·`hashSeed`·`seededRand`, `components/Modal.tsx`(`open/onClose/title/children`), `components/Button.tsx`(`variant`), `components/ui/Input.tsx`(`size="sm"`·`numeric`).
- Produces: `export function PickArrayDialog(props: { name: string; initial: PickArraySpec; onApply: (spec: PickArraySpec) => void; onCancel: () => void }): JSX.Element` — 부모가 열림 여부를 마운트로 제어(열려 있을 때만 렌더; 내부 `Modal open`). `onCancel`은 취소·✕·ESC·바깥 클릭 공통.

- [ ] **Step 1: 실패하는 RTL 테스트 작성** (tdd-guard: 테스트 파일 편집이 첫 production 편집보다 먼저) — `PickArrayDialog.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PickArrayDialog } from "../PickArrayDialog";
import { ko } from "../../../i18n/ko";
import type { PickArraySpec } from "../../../scenario/genVars";

const BASE: PickArraySpec = { gen: "pick_array", length: 30, min: 2, max: 3, positions: "1-5, 8, 12-20" };

function setup(initial: PickArraySpec = BASE) {
  const onApply = vi.fn();
  const onCancel = vi.fn();
  render(<PickArrayDialog name="flags" initial={initial} onApply={onApply} onCancel={onCancel} />);
  const dialog = screen.getByRole("dialog");
  const posInput = within(dialog).getByRole("textbox", { name: ko.editor.pickSectionPositions });
  const grid = within(dialog).getByRole("group", { name: ko.editor.pickGridAria });
  const apply = within(dialog).getByRole("button", { name: ko.editor.pickApply });
  return { onApply, onCancel, dialog, posInput, grid, apply };
}
const cell = (grid: HTMLElement, i: number) =>
  within(grid).getByRole("button", { name: ko.editor.pickCellAria(i) });

describe("PickArrayDialog", () => {
  it("텍스트 → 칸 동기화", async () => {
    const user = userEvent.setup();
    const { posInput, grid } = setup();
    expect(cell(grid, 8)).toHaveAttribute("aria-pressed", "true");
    expect(cell(grid, 9)).toHaveAttribute("aria-pressed", "false");
    await user.clear(posInput);
    await user.type(posInput, "9");
    expect(cell(grid, 9)).toHaveAttribute("aria-pressed", "true");
    expect(cell(grid, 8)).toHaveAttribute("aria-pressed", "false");
  });

  it("칸 클릭 → 텍스트 정규형, Shift+클릭 = 범위", async () => {
    const user = userEvent.setup();
    const { posInput, grid } = setup();
    await user.click(cell(grid, 6));
    expect(posInput).toHaveValue("1-6, 8, 12-20");
    await user.keyboard("{Shift>}");
    await user.click(cell(grid, 10));
    await user.keyboard("{/Shift}");
    expect(posInput).toHaveValue("1-10, 12-20");
  });

  it("적용 전에는 onApply 없음, 적용 시 spec 1회 (전체 positions·기본값 키 생략)", async () => {
    const user = userEvent.setup();
    const { onApply, dialog, apply } = setup({ gen: "pick_array", length: 5, min: 1, max: 2 });
    await user.click(within(dialog).getByRole("button", { name: ko.editor.pickNone }));
    expect(onApply).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: ko.editor.pickAll }));
    await user.click(apply);
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledWith({ gen: "pick_array", length: 5, min: 1, max: 2 });
  });

  it("취소·ESC는 onCancel, onApply 없음", async () => {
    const user = userEvent.setup();
    const { onApply, onCancel, dialog } = setup();
    await user.click(within(dialog).getByRole("button", { name: ko.common.cancel }));
    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onApply).not.toHaveBeenCalled();
  });

  it("무효 설정에서 적용 disabled — 후보 0·최소>최대·최대>길이·최소>후보, 경고는 허용", async () => {
    const user = userEvent.setup();
    const { dialog, posInput, apply } = setup();
    const min = within(dialog).getByRole("spinbutton", { name: ko.editor.pickFieldMin });
    const max = within(dialog).getByRole("spinbutton", { name: ko.editor.pickFieldMax });
    await user.clear(posInput);
    expect(apply).toBeDisabled();
    expect(within(dialog).getByText(ko.editor.pickErrNoCandidates)).toBeInTheDocument();
    await user.type(posInput, "1-3");
    expect(apply).toBeEnabled();
    await user.clear(max);
    await user.type(max, "1");
    expect(apply).toBeDisabled(); // min 2 > max 1
    await user.clear(max);
    await user.type(max, "31");
    expect(apply).toBeDisabled(); // max > length
    await user.clear(max);
    await user.type(max, "10");
    expect(apply).toBeEnabled(); // max > 후보 3 = 경고만
    expect(within(dialog).getByText(ko.editor.pickWarnMaxGtCandidates(3))).toBeInTheDocument();
    await user.clear(min);
    await user.type(min, "4");
    expect(apply).toBeDisabled(); // min > 후보
  });

  it("문법 오류 동안 칸은 비활성·전체는 활성, 빈 문자열이면 칸 활성", async () => {
    const user = userEvent.setup();
    const { dialog, posInput, grid } = setup();
    await user.clear(posInput);
    await user.type(posInput, "1,,2");
    expect(cell(grid, 1)).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: ko.editor.pickAll })).toBeEnabled();
    expect(within(dialog).getByText(ko.editor.pickErrBadItem(2))).toBeInTheDocument();
    await user.clear(posInput);
    expect(cell(grid, 1)).toBeEnabled();
  });

  it("길이 재입력 중간값에서 positions를 깎지 않는다 (30 → 25)", async () => {
    const user = userEvent.setup();
    const { dialog, posInput } = setup();
    const len = within(dialog).getByRole("spinbutton", { name: ko.editor.pickFieldLength });
    await user.clear(len);
    await user.type(len, "25"); // "2"를 거쳐도
    expect(posInput).toHaveValue("1-5, 8, 12-20");
    await user.tab(); // 커밋
    expect(posInput).toHaveValue("1-5, 8, 12-20"); // 25 이내라 보존
    await user.clear(len);
    await user.type(len, "10");
    await user.tab();
    expect(posInput).toHaveValue("1-5, 8");
  });

  it("무효 길이를 고친 직후 적용 첫 클릭이 동작 (live 길이로 활성 판정)", async () => {
    const user = userEvent.setup();
    const { onApply, dialog, apply } = setup({ gen: "pick_array", length: 5, min: 1, max: 2 });
    const len = within(dialog).getByRole("spinbutton", { name: ko.editor.pickFieldLength });
    await user.clear(len);
    await user.type(len, "0");
    expect(apply).toBeDisabled();
    await user.clear(len);
    await user.type(len, "6");
    await user.click(apply); // 길이 칸에 포커스가 남은 채 바로 클릭
    expect(onApply).toHaveBeenCalledWith({ gen: "pick_array", length: 6, min: 1, max: 2 });
  });

  it("값 형식: 기본 접힘, 프리셋 선택, 직접 입력 무효면 적용 disabled", async () => {
    const user = userEvent.setup();
    const { onApply, dialog, apply } = setup({ gen: "pick_array", length: 4, min: 1, max: 1 });
    const toggle = within(dialog).getByRole("button", { name: ko.editor.pickValuesToggle("true", "false") });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    await user.click(within(dialog).getByRole("radio", { name: /1 \/ 0/ }));
    await user.click(apply);
    expect(onApply).toHaveBeenLastCalledWith({ gen: "pick_array", length: 4, min: 1, max: 1, pick: 1, rest: 0 });
  });

  it("직접 입력: 타입 표시·null 보존·빈 값 disabled", async () => {
    const user = userEvent.setup();
    const { onApply, dialog, apply } = setup({ gen: "pick_array", length: 4, min: 1, max: 1, pick: "Y", rest: null });
    // 기본이 아니면 펼친 채로 열리고 직접 입력이 선택돼 있다
    const pick = within(dialog).getByRole("textbox", { name: ko.editor.pickFieldPick });
    const rest = within(dialog).getByRole("textbox", { name: ko.editor.pickFieldRest });
    expect(pick).toHaveValue("Y");
    expect(rest).toHaveValue("null");
    await user.clear(pick);
    expect(apply).toBeDisabled();
    await user.type(pick, '"1"');
    await user.click(apply);
    expect(onApply).toHaveBeenLastCalledWith({ gen: "pick_array", length: 4, min: 1, max: 1, pick: "1", rest: null });
  });

  it("roving: 그리드 Tab 정지 1개, 화살표 이동, Home/End", async () => {
    const user = userEvent.setup();
    const { grid } = setup({ gen: "pick_array", length: 12, min: 1, max: 1 });
    const tabbable = within(grid).getAllByRole("button").filter((b) => b.tabIndex === 0);
    expect(tabbable).toHaveLength(1);
    cell(grid, 1).focus();
    await user.keyboard("{ArrowRight}");
    expect(cell(grid, 2)).toHaveFocus();
    await user.keyboard("{End}");
    expect(cell(grid, 12)).toHaveFocus();
    await user.keyboard("{Home}");
    expect(cell(grid, 1)).toHaveFocus();
    expect(within(grid).getAllByRole("button").filter((b) => b.tabIndex === 0)).toHaveLength(1);
  });

  it("Space는 네이티브 활성화로 1회만 토글", async () => {
    const user = userEvent.setup();
    const { posInput, grid } = setup({ gen: "pick_array", length: 5, min: 0, max: 1, positions: "1" });
    cell(grid, 3).focus();
    await user.keyboard(" ");
    expect(posInput).toHaveValue("1, 3");
  });

  it("길이 1000: 1000칸 렌더·토글이 텍스트를 정규형으로", async () => {
    const user = userEvent.setup();
    const { posInput, grid } = setup({ gen: "pick_array", length: 1000, min: 0, max: 5 });
    expect(within(grid).getAllByRole("button")).toHaveLength(1000);
    await user.click(cell(grid, 500));
    expect(posInput).toHaveValue("1-499, 501-1000");
  });

  it("사용 안내와 미리보기(유효 시 JSON 배열)", () => {
    const { dialog } = setup({ gen: "pick_array", length: 4, min: 1, max: 1 });
    expect(within(dialog).getByText(ko.editor.pickUsageHint("flags"))).toBeInTheDocument();
    const pre = within(dialog).getByTestId("pick-preview");
    expect(JSON.parse(pre.textContent!)).toHaveLength(4);
  });

  it("불리언 전제 문구가 없다", () => {
    const { dialog } = setup();
    expect(dialog.textContent).not.toMatch(/true 개수|true 자리|불리언 배열|true 후보/);
  });
});
```

- [ ] **Step 2: ko 키 추가** — `ko.editor`의 `pickSummary` 다음에:

```ts
    pickDialogTitle: (name: string) => `${name} · 선택 배열`,
    pickSectionSize: "크기",
    pickFieldLength: "배열 길이 (1~1000)",
    pickFieldMin: "선택 개수 최소",
    pickFieldMax: "선택 개수 최대",
    pickSectionPositions: "선택될 수 있는 자리",
    pickPositionsHint: "쉼표와 범위로 · 예: 1-5, 8, 12-20 · 후보가 아닌 자리는 항상 나머지 자리 값",
    pickAll: "전체",
    pickNone: "모두 끄기",
    pickLegendOn: "선택 후보",
    pickLegendOff: "항상 나머지 자리 값",
    pickLegendRange: "Shift+클릭 = 범위",
    pickGridAria: "선택될 수 있는 자리 칸 (Shift+클릭으로 범위)",
    pickCellAria: (i: number) => `${i}번 자리`,
    pickValuesToggle: (pick: string, rest: string) => `값 형식: ${pick} / ${rest}`,
    pickValuesAria: "값 형식",
    pickValueCustom: "직접 입력",
    pickFieldPick: "선택 자리 값",
    pickFieldRest: "나머지 자리 값",
    pickValueKind: { boolean: "불리언", number: "숫자", string: "문자열", null: "null" } as const,
    pickValueKindHint: "true·false·null·숫자는 그 타입으로, 나머지는 문자열로 · 숫자를 문자열로 보내려면 \"1\"",
    pickPreviewTitle: "미리보기 (반복마다 새로 뽑힘)",
    pickPreviewReroll: "↻ 다시 뽑기",
    pickPreviewInvalid: "설정을 고치면 예시가 나와요",
    pickUsageHint: (name: string) => `JSON 바디에서 "{{${name}:json}}" 로 쓰면 배열로 들어갑니다.`,
    pickApply: "적용",
    pickErrLength: "길이는 1~1000 사이 정수예요",
    pickErrCount: "선택 개수는 0 이상 정수예요",
    pickErrMinGtMax: "최소가 최대보다 커요",
    pickErrMaxGtLength: "최대가 길이보다 커요",
    pickErrNoCandidates: "선택될 수 있는 자리를 1개 이상 지정하세요",
    pickErrMinGtCandidates: (c: number) => `후보가 ${c}자리뿐이라 최소 개수를 채울 수 없어요`,
    pickWarnMaxGtCandidates: (c: number) => `후보가 ${c}자리라 최대 ${c}개까지만 선택돼요`,
    pickErrTooLong: "자리 목록이 너무 길어요 (4096자 이하)",
    pickErrBadItem: (i: number) => `${i}번째 항목을 읽을 수 없어요 · 예: 1-5, 8`,
    pickErrOutOfRange: (i: number, len: number) => `${i}번째 항목: 자리는 1~${len}`,
    pickErrReversed: (i: number) => `${i}번째 항목: 앞 번호가 더 커요`,
    pickErrValueEmpty: "값을 입력하세요",
    pickErrValueQuoted: "따옴표 문자열이 올바르지 않아요",
    pickErrValueNonFinite: "너무 큰 숫자예요",
```

- [ ] **Step 3: 실패 확인** — `cd ui && pnpm test PickArrayDialog` → import 실패 FAIL.

- [ ] **Step 4: `PickArrayDialog.tsx` 구현**

```tsx
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Modal } from "../Modal";
import { Button } from "../Button";
import { Input } from "../ui/Input";
import { ko } from "../../i18n/ko";
import { hashSeed, seededRand, type PickArraySpec } from "../../scenario/genVars";
import {
  PICK_ARRAY_MAX_LEN,
  VALUE_PRESETS,
  formatPositions,
  formatValueLiteral,
  isFullRange,
  jsonScalarKind,
  parsePositions,
  parseValueLiteral,
  presetIndexOf,
  samplePickArray,
  trimPositionsForLength,
  type JsonScalar,
  type LiteralResult,
  type PositionsError,
} from "../../scenario/pickArray";

/** 선택 배열 편집 팝업(spec §6.3). draft는 전부 로컬 — store 쓰기는 onApply 1회뿐.
 *  목업(docs/superpowers/mockups/2026-10-17-pick-array-mockup.html)은 시각 참조만. */

type ValueMode = number | "custom"; // 0..3 = VALUE_PRESETS 인덱스

const intText = (t: string): number | null => (/^\s*\d+\s*$/.test(t) ? Number(t.trim()) : null);
const lengthOf = (t: string): number | null => {
  const n = intText(t);
  return n !== null && n >= 1 && n <= PICK_ARRAY_MAX_LEN ? n : null;
};

function positionsErrorText(e: PositionsError, length: number): string {
  switch (e.kind) {
    case "tooLong":
      return ko.editor.pickErrTooLong;
    case "badItem":
      return ko.editor.pickErrBadItem(e.index);
    case "outOfRange":
      return ko.editor.pickErrOutOfRange(e.index, length);
    case "reversed":
      return ko.editor.pickErrReversed(e.index);
  }
}

function literalErrorText(r: LiteralResult): string | null {
  if (r.ok) return null;
  return r.reason === "empty"
    ? ko.editor.pickErrValueEmpty
    : r.reason === "badQuoted"
      ? ko.editor.pickErrValueQuoted
      : ko.editor.pickErrValueNonFinite;
}

export function PickArrayDialog({
  name,
  initial,
  onApply,
  onCancel,
}: {
  name: string;
  initial: PickArraySpec;
  onApply: (spec: PickArraySpec) => void;
  onCancel: () => void;
}) {
  const initPick: JsonScalar = initial.pick === undefined ? true : initial.pick;
  const initRest: JsonScalar = initial.rest === undefined ? false : initial.rest;
  const initPreset = presetIndexOf(initPick, initRest);

  const [lengthText, setLengthText] = useState(String(initial.length));
  const [committedLength, setCommittedLength] = useState(initial.length);
  const [minText, setMinText] = useState(String(initial.min));
  const [maxText, setMaxText] = useState(String(initial.max));
  const [positionsText, setPositionsText] = useState(initial.positions ?? `1-${initial.length}`);
  const [valueMode, setValueMode] = useState<ValueMode>(initPreset === -1 ? "custom" : initPreset);
  const [pickText, setPickText] = useState(formatValueLiteral(initPick));
  const [restText, setRestText] = useState(formatValueLiteral(initRest));
  const [valuesOpen, setValuesOpen] = useState(initPreset !== 0);
  const [tick, setTick] = useState(0);
  const anchorRef = useRef<number | null>(null);

  // live 길이(무효면 마지막 유효) — 활성 판정·칸 수. 깎기 규칙은 비파괴 미리보기로만.
  const liveLength = lengthOf(lengthText) ?? committedLength;
  const effText = trimPositionsForLength(positionsText, committedLength, liveLength);
  const pos = parsePositions(effText, liveLength);

  const commitLength = () => {
    const n = lengthOf(lengthText);
    if (n === null) return;
    setPositionsText(trimPositionsForLength(positionsText, committedLength, n));
    setCommittedLength(n);
  };

  const minN = intText(minText);
  const maxN = intText(maxText);
  const pickRes: LiteralResult =
    valueMode === "custom" ? parseValueLiteral(pickText) : { ok: true, value: VALUE_PRESETS[valueMode].pick };
  const restRes: LiteralResult =
    valueMode === "custom" ? parseValueLiteral(restText) : { ok: true, value: VALUE_PRESETS[valueMode].rest };

  const sizeError =
    lengthOf(lengthText) === null
      ? ko.editor.pickErrLength
      : minN === null || maxN === null
        ? ko.editor.pickErrCount
        : minN > maxN
          ? ko.editor.pickErrMinGtMax
          : maxN > liveLength
            ? ko.editor.pickErrMaxGtLength
            : null;
  const posError = !pos.ok
    ? positionsErrorText(pos.error, liveLength)
    : pos.set.length === 0
      ? ko.editor.pickErrNoCandidates
      : null;
  const c = pos.ok ? pos.set.length : 0;
  const countVsCand =
    pos.ok && c > 0 && minN !== null && maxN !== null && sizeError === null
      ? minN > c
        ? { level: "error" as const, text: ko.editor.pickErrMinGtCandidates(c) }
        : maxN > c
          ? { level: "warn" as const, text: ko.editor.pickWarnMaxGtCandidates(c) }
          : null
      : null;

  const spec: PickArraySpec | null =
    sizeError === null &&
    posError === null &&
    countVsCand?.level !== "error" &&
    pickRes.ok &&
    restRes.ok &&
    pos.ok
      ? {
          gen: "pick_array",
          length: liveLength,
          min: minN!,
          max: maxN!,
          ...(isFullRange(pos.set, liveLength) ? {} : { positions: formatPositions(pos.set) }),
          ...(pickRes.value === true ? {} : { pick: pickRes.value }),
          ...(restRes.value === false ? {} : { rest: restRes.value }),
        }
      : null;

  const preview = useMemo(
    () =>
      spec ? samplePickArray(spec, seededRand(hashSeed(`${name}|${tick}|${JSON.stringify(spec)}`))) : null,
    // spec은 매 렌더 새 객체 — 내용 키로 메모
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [name, tick, JSON.stringify(spec)],
  );

  const toggle = (i: number, range: boolean) => {
    if (!pos.ok) return;
    const set = new Set(pos.set);
    const turnOn = !set.has(i);
    const from = range && anchorRef.current !== null ? Math.min(anchorRef.current, i) : i;
    const to = range && anchorRef.current !== null ? Math.max(anchorRef.current, i) : i;
    for (let j = from; j <= to; j++) {
      if (turnOn) set.add(j);
      else set.delete(j);
    }
    anchorRef.current = i;
    setPositionsText(formatPositions([...set]));
  };

  const pickShown = pickRes.ok ? formatValueLiteral(pickRes.value) : pickText;
  const restShown = restRes.ok ? formatValueLiteral(restRes.value) : restText;
  const apply = () => {
    if (spec) onApply(spec); // 클릭 시점 재검증 — spec은 이 렌더의 draft 기준
  };

  return (
    <Modal open onClose={onCancel} title={ko.editor.pickDialogTitle(name)}>
      <div className="flex flex-col gap-4 text-sm">
        <section className="flex flex-col gap-1.5">
          <h3 className="text-xs font-semibold text-slate-500">{ko.editor.pickSectionSize}</h3>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(7rem,1fr))] gap-x-3 gap-y-1">
            <label className="flex flex-col gap-0.5">
              <span className="text-[11px] text-slate-400">{ko.editor.pickFieldLength}</span>
              <Input
                size="sm"
                numeric
                type="number"
                min={1}
                max={PICK_ARRAY_MAX_LEN}
                aria-label={ko.editor.pickFieldLength}
                value={lengthText}
                onChange={(e) => setLengthText(e.target.value)}
                onBlur={commitLength}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitLength();
                }}
              />
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="text-[11px] text-slate-400">{ko.editor.pickFieldMin}</span>
              <Input size="sm" numeric type="number" min={0} aria-label={ko.editor.pickFieldMin} value={minText} onChange={(e) => setMinText(e.target.value)} />
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="text-[11px] text-slate-400">{ko.editor.pickFieldMax}</span>
              <Input size="sm" numeric type="number" min={0} aria-label={ko.editor.pickFieldMax} value={maxText} onChange={(e) => setMaxText(e.target.value)} />
            </label>
          </div>
          {sizeError && <p className="text-xs text-red-600">{sizeError}</p>}
          {countVsCand && (
            <p className={countVsCand.level === "error" ? "text-xs text-red-600" : "self-start rounded bg-amber-50 px-1.5 text-xs text-amber-700"}>
              {countVsCand.text}
            </p>
          )}
        </section>

        <section className="flex flex-col gap-1.5">
          <h3 className="text-xs font-semibold text-slate-500">{ko.editor.pickSectionPositions}</h3>
          <Input
            size="sm"
            className="font-mono"
            aria-label={ko.editor.pickSectionPositions}
            aria-invalid={posError !== null || undefined}
            value={positionsText}
            onChange={(e) => setPositionsText(e.target.value)}
          />
          {posError ? (
            <p className="text-xs text-red-600">{posError}</p>
          ) : (
            <p className="text-xs text-slate-400">{ko.editor.pickPositionsHint}</p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" onClick={() => setPositionsText(`1-${liveLength}`)}>
              {ko.editor.pickAll}
            </Button>
            <Button variant="secondary" disabled={!pos.ok} onClick={() => setPositionsText("")}>
              {ko.editor.pickNone}
            </Button>
            <span className="ml-auto flex flex-wrap gap-3 text-[11px] text-slate-400">
              <span><span aria-hidden="true" className="mr-1 inline-block h-2 w-2 rounded-sm bg-accent-600" />{ko.editor.pickLegendOn}</span>
              <span><span aria-hidden="true" className="mr-1 inline-block h-2 w-2 rounded-sm border border-slate-300" />{ko.editor.pickLegendOff}</span>
              <span>{ko.editor.pickLegendRange}</span>
            </span>
          </div>
          <PositionGrid
            length={liveLength}
            selected={pos.ok ? new Set(pos.set) : new Set()}
            disabled={!pos.ok}
            onToggle={toggle}
          />
        </section>

        <section className="flex flex-col gap-1.5">
          <button
            type="button"
            aria-expanded={valuesOpen}
            onClick={() => setValuesOpen((o) => !o)}
            className="self-start text-left text-xs font-semibold text-slate-500 hover:text-accent-600"
          >
            <span aria-hidden="true">{valuesOpen ? "▾ " : "▸ "}</span>
            {ko.editor.pickValuesToggle(pickShown, restShown)}
          </button>
          {valuesOpen && (
            <div role="radiogroup" aria-label={ko.editor.pickValuesAria} className="flex flex-col gap-1 pl-4">
              {VALUE_PRESETS.map((p, i) => (
                <label key={i} className="flex items-center gap-2 text-xs">
                  <input type="radio" name={`pick-values-${name}`} checked={valueMode === i} onChange={() => setValueMode(i)} />
                  <code>{`${formatValueLiteral(p.pick)} / ${formatValueLiteral(p.rest)}`}</code>
                  <span className="text-slate-400">{ko.editor.pickValueKind[jsonScalarKind(p.pick)]}</span>
                </label>
              ))}
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="radio"
                  name={`pick-values-${name}`}
                  checked={valueMode === "custom"}
                  onChange={() => {
                    if (valueMode !== "custom") {
                      setPickText(formatValueLiteral(VALUE_PRESETS[valueMode].pick));
                      setRestText(formatValueLiteral(VALUE_PRESETS[valueMode].rest));
                    }
                    setValueMode("custom");
                  }}
                />
                {ko.editor.pickValueCustom}
              </label>
              {valueMode === "custom" && (
                <div className="grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-x-3 gap-y-1">
                  {(
                    [
                      [ko.editor.pickFieldPick, pickText, setPickText, pickRes],
                      [ko.editor.pickFieldRest, restText, setRestText, restRes],
                    ] as const
                  ).map(([label, text, setText, res]) => (
                    <label key={label} className="flex flex-col gap-0.5">
                      <span className="text-[11px] text-slate-400">
                        {label}
                        {res.ok ? ` · ${ko.editor.pickValueKind[jsonScalarKind(res.value)]}` : ""}
                      </span>
                      <Input size="sm" className="font-mono" aria-label={label} aria-invalid={!res.ok || undefined} value={text} onChange={(e) => setText(e.target.value)} />
                      {!res.ok && <span className="text-xs text-red-600">{literalErrorText(res)}</span>}
                    </label>
                  ))}
                  <p className="col-span-full text-[11px] text-slate-400">{ko.editor.pickValueKindHint}</p>
                </div>
              )}
            </div>
          )}
        </section>

        <section className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <h3 className="text-xs font-semibold text-slate-500">{ko.editor.pickPreviewTitle}</h3>
            <Button variant="secondary" className="ml-auto" disabled={!spec} onClick={() => setTick((t) => t + 1)}>
              {ko.editor.pickPreviewReroll}
            </Button>
          </div>
          <div data-testid="pick-preview" className="max-h-24 overflow-y-auto break-all rounded border border-slate-200 bg-slate-50 px-2 py-1 font-mono text-xs">
            {preview ?? ko.editor.pickPreviewInvalid}
          </div>
          <p className="text-xs text-slate-500">{ko.editor.pickUsageHint(name)}</p>
        </section>

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel}>
            {ko.common.cancel}
          </Button>
          <Button onClick={apply} disabled={spec === null}>
            {ko.editor.pickApply}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** roving-tabindex 칸 그리드 — Tab 정지 1개. 토글은 네이티브 버튼 활성화(Space/Enter→click),
 *  keydown은 이동과 Shift+Space(범위, preventDefault로 네이티브 click 억제)만. */
function PositionGrid({
  length,
  selected,
  disabled,
  onToggle,
}: {
  length: number;
  selected: ReadonlySet<number>;
  disabled: boolean;
  onToggle: (i: number, range: boolean) => void;
}) {
  const [active, setActive] = useState(1);
  const gridRef = useRef<HTMLDivElement>(null);
  const cellRefs = useRef(new Map<number, HTMLButtonElement>());
  const current = Math.min(active, length);

  const move = (to: number) => {
    const n = Math.max(1, Math.min(length, to));
    setActive(n);
    cellRefs.current.get(n)?.focus();
  };
  const cols = () => {
    const g = gridRef.current;
    if (!g) return 1;
    return getComputedStyle(g).gridTemplateColumns.split(" ").filter(Boolean).length || 1;
  };
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const delta: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols(), ArrowUp: -cols() };
    if (e.key in delta) {
      e.preventDefault();
      move(i + delta[e.key]);
    } else if (e.key === "Home") {
      e.preventDefault();
      move(1);
    } else if (e.key === "End") {
      e.preventDefault();
      move(length);
    } else if (e.key === " " && e.shiftKey) {
      e.preventDefault();
      onToggle(i, true);
    }
  };

  return (
    <div
      ref={gridRef}
      role="group"
      aria-label={ko.editor.pickGridAria}
      className={`grid max-h-44 grid-cols-[repeat(auto-fill,minmax(2.1rem,1fr))] gap-[3px] overflow-y-auto overflow-x-hidden rounded border border-slate-200 bg-slate-50 p-1 ${disabled ? "opacity-50" : ""}`}
    >
      {Array.from({ length }, (_, k) => k + 1).map((i) => (
        <button
          key={i}
          type="button"
          ref={(el) => {
            if (el) cellRefs.current.set(i, el);
            else cellRefs.current.delete(i);
          }}
          tabIndex={i === current ? 0 : -1}
          aria-pressed={selected.has(i)}
          aria-label={ko.editor.pickCellAria(i)}
          disabled={disabled}
          onFocus={() => setActive(i)}
          onClick={(e) => onToggle(i, e.shiftKey)}
          onKeyDown={(e) => onKeyDown(e, i)}
          onKeyUp={(e) => {
            if (e.key === " " && e.shiftKey) e.preventDefault();
          }}
          className={`h-6 min-w-0 rounded-sm border font-mono text-[10px] tabular-nums ${
            selected.has(i) ? "border-accent-600 bg-accent-600 text-white" : "border-slate-300 bg-white text-slate-400"
          }`}
        >
          {i}
        </button>
      ))}
    </div>
  );
}
```

메모: positions 입력의 `value`는 **항상 `positionsText`**다 — 길이 칸 편집 중의 깎기는 `effText`(비파괴 미리보기)로 **검증과 칸 그리드에만** 반영하고 텍스트는 길이 커밋(blur/Enter) 때 바뀐다("30 → 25" 테스트가 이 계약을 핀). `onChange`는 `positionsText`를 쓴다(길이 칸에서 포커스가 옮겨오며 이미 커밋됨).

- [ ] **Step 5: 통과 확인** — `pnpm test PickArrayDialog` → PASS. 실패 케이스가 있으면 테스트 의도(spec §6.3)를 기준으로 구현을 고친다(테스트를 약화하지 말 것).

- [ ] **Step 6: 이빨 실증** — (1) `onChange`가 길이 규칙을 키마다 적용하도록 임시 변경(`onChange={(e)=>{setLengthText(e.target.value); const n=lengthOf(e.target.value); if(n){setPositionsText(trimPositionsForLength(positionsText, committedLength, n)); setCommittedLength(n);}}}`) → "30 → 25" 케이스 RED → 원복. (2) `tabIndex={i === current ? 0 : -1}`을 `tabIndex={0}`으로 → roving 케이스 RED → 원복. (3) PositionGrid `onKeyDown`에 `else if (e.key === " ") onToggle(i, false);` 추가 → Space 1회 토글 케이스 RED → 원복.

- [ ] **Step 7: 게이트+커밋 (FOREGROUND)**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/genvar-array/ui && pnpm lint; echo exit=$?
cd /Users/sgj/develop/handicap/.claude/worktrees/genvar-array/ui && pnpm build; echo exit=$?
cd /Users/sgj/develop/handicap/.claude/worktrees/genvar-array
git add ui/src/components/scenario/PickArrayDialog.tsx ui/src/components/scenario/__tests__/PickArrayDialog.test.tsx ui/src/i18n/ko.ts
git diff --cached --name-only
git commit -m "feat(ui): PickArrayDialog — 텍스트↔칸 동기화·draft→적용·roving 그리드"
git log -1 --oneline
```

(`eslint-disable-next-line`이 미사용 directive로 lint 에러가 나면 주석을 지우고 deps를 그대로 둔다 — `ui/CLAUDE.md` 미사용 directive 함정.)

---

### Task 6: UI 배선 — 변수 패널·GenVarEditor·배열로 추가·포커스

**Files:**
- Modify: `ui/src/components/scenario/VariablesPanel.tsx`
- Modify: `ui/src/components/scenario/GenVarEditor.tsx`
- Modify: `ui/src/i18n/ko.ts` (버튼 문구)
- Modify: `ui/src/components/scenario/__tests__/VariablesPanel.test.tsx`, `ui/src/components/scenario/__tests__/GenVarEditor.test.tsx` (테스트 추가)

**Interfaces:**
- Consumes: Task 3 `jsonCastVarNames`, Task 4 `PickArraySpec`·`PICK_ARRAY_DEFAULT`·`isPickArray`, Task 5 `PickArrayDialog`.
- Produces: `GenVarEditor` 신규 optional prop `onOpenPickArray?: (initial: PickArraySpec, origin: "edit" | "switch") => void`.

- [ ] **Step 1: 실패하는 테스트 작성** (tdd-guard: 테스트 먼저)

`GenVarEditor.test.tsx`에 추가:

```tsx
describe("GenVarEditor — pick_array", () => {
  const props = {
    name: "flags",
    disabled: false,
    sampleTick: 0,
    onSampleRefresh: () => {},
  };
  it("타입 select에서 선택 배열 → 커밋 없이 onOpenPickArray(default, 'switch')", async () => {
    const user = userEvent.setup();
    const onCommitGen = vi.fn();
    const onCommitStatic = vi.fn();
    const onOpenPickArray = vi.fn();
    render(
      <GenVarEditor {...props} value="x" onCommitGen={onCommitGen} onCommitStatic={onCommitStatic} onOpenPickArray={onOpenPickArray} />,
    );
    await user.selectOptions(screen.getByRole("combobox", { name: ko.editor.genFieldType("flags") }), "pick_array");
    expect(onOpenPickArray).toHaveBeenCalledWith({ gen: "pick_array", length: 10, min: 1, max: 3 }, "switch");
    expect(onCommitGen).not.toHaveBeenCalled(); // random_string 낙하 회귀 가드
    expect(onCommitStatic).not.toHaveBeenCalled();
  });
  it("pick_array 값이면 인라인 필드 대신 편집… 버튼", async () => {
    const user = userEvent.setup();
    const onOpenPickArray = vi.fn();
    const spec = { gen: "pick_array" as const, length: 6, min: 1, max: 2 };
    render(
      <GenVarEditor {...props} value={spec} onCommitGen={vi.fn()} onCommitStatic={vi.fn()} onOpenPickArray={onOpenPickArray} />,
    );
    await user.click(screen.getByRole("button", { name: ko.editor.pickEditOpenAria("flags") }));
    expect(onOpenPickArray).toHaveBeenCalledWith(spec, "edit");
  });
  it("선택 배열 → UUID 전환은 즉시 커밋되고 pick 키가 남지 않는다", async () => {
    const user = userEvent.setup();
    const onCommitGen = vi.fn();
    render(
      <GenVarEditor {...props} value={{ gen: "pick_array", length: 6, min: 1, max: 2, pick: 1 }} onCommitGen={onCommitGen} onCommitStatic={vi.fn()} onOpenPickArray={vi.fn()} />,
    );
    await user.selectOptions(screen.getByRole("combobox", { name: ko.editor.genFieldType("flags") }), "uuid");
    expect(onCommitGen).toHaveBeenCalledWith({ gen: "uuid" });
  });
});
```

`VariablesPanel.test.tsx`에 추가:

```tsx
describe("VariablesPanel — pick_array", () => {
  const JSON_REF = `version: 1
name: p
steps:
  - id: "01HX0000000000000000000001"
    name: a
    type: http
    request:
      method: POST
      url: "http://x"
      body:
        json:
          seats: "{{seats:json}}"
          plain: "{{plainvar}}"
`;
  it("접힘 행: 배지·요약·편집 → 팝업, 적용 시 store 1회 갱신·취소 시 불변", async () => {
    const user = userEvent.setup();
    useScenarioEditor.getState().setVariableGen("flags", { gen: "pick_array", length: 30, min: 2, max: 3 });
    render(<VariablesPanel />);
    expect(screen.getByText("선택 배열")).toBeInTheDocument();
    expect(screen.getByText("30칸 · 2~3개 선택 · 전체 자리")).toBeInTheDocument();
    const before = useScenarioEditor.getState().yamlText;
    await user.click(screen.getByRole("button", { name: ko.editor.pickEditAria("flags") }));
    const dialog = screen.getByRole("dialog");
    await user.clear(within(dialog).getByRole("textbox", { name: ko.editor.pickSectionPositions }));
    await user.type(within(dialog).getByRole("textbox", { name: ko.editor.pickSectionPositions }), "1-5");
    expect(useScenarioEditor.getState().yamlText).toBe(before); // 적용 전 불변
    await user.click(within(dialog).getByRole("button", { name: ko.common.cancel }));
    expect(useScenarioEditor.getState().yamlText).toBe(before); // 취소 후 불변
    expect(screen.getByRole("button", { name: ko.editor.pickEditAria("flags") })).toHaveFocus(); // Modal 기본 복원
    await user.click(screen.getByRole("button", { name: ko.editor.pickEditAria("flags") }));
    const d2 = screen.getByRole("dialog");
    const pos = within(d2).getByRole("textbox", { name: ko.editor.pickSectionPositions });
    await user.clear(pos);
    await user.type(pos, "1-5");
    await user.click(within(d2).getByRole("button", { name: ko.editor.pickApply }));
    expect(useScenarioEditor.getState().model!.variables.flags).toEqual({
      gen: "pick_array", length: 30, min: 2, max: 3, positions: "1-5",
    });
  });

  it("배열로 추가: :json 순수 참조에만 노출, 적용=선언+편집 버튼 포커스, 취소=미선언", async () => {
    const user = userEvent.setup();
    useScenarioEditor.getState().loadFromString(JSON_REF);
    render(<VariablesPanel />);
    expect(screen.queryByRole("button", { name: ko.editor.pickDeclareAria("plainvar") })).toBeNull();
    const declare = screen.getByRole("button", { name: ko.editor.pickDeclareAria("seats") });
    await user.click(declare);
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: ko.common.cancel }));
    expect(useScenarioEditor.getState().model!.variables).not.toHaveProperty("seats");
    expect(declare).toHaveFocus();
    await user.click(declare);
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: ko.editor.pickApply }));
    expect(useScenarioEditor.getState().model!.variables.seats).toEqual({
      gen: "pick_array", length: 10, min: 1, max: 3,
    });
    expect(screen.getByRole("button", { name: ko.editor.pickEditAria("seats") })).toHaveFocus();
  });

  it("yamlError 동안 편집·배열로 추가 disabled", () => {
    useScenarioEditor.getState().loadFromString(JSON_REF);
    useScenarioEditor.getState().setVariableGen("flags", { gen: "pick_array", length: 4, min: 1, max: 1 });
    render(<VariablesPanel />);
    const s = useScenarioEditor.getState();
    s.setPendingYamlText(`${s.yamlText}\n  : : broken`);
    s.commitPendingYaml();
    expect(screen.getByRole("button", { name: ko.editor.pickEditAria("flags") })).toBeDisabled();
    expect(screen.getByRole("button", { name: ko.editor.pickDeclareAria("seats") })).toBeDisabled();
  });
});
```

(`setPendingYamlText`/`commitPendingYaml`·`loadFromString`의 실제 이름은 `ui/src/scenario/store.ts`에서 확인 후 맞춘다 — `ui/src/components/scenario/CLAUDE.md` yamlError RTL 락인 이디엄 참조. 깨진 YAML 문자열은 그 파일의 기존 yamlError 테스트가 쓰는 것을 재사용해도 된다.)

- [ ] **Step 2: ko 키** — `pickErrValueNonFinite` 다음:

```ts
    pickEdit: "편집",
    pickEditAria: (name: string) => `${name} 선택 배열 편집`,
    pickEditOpen: "편집…",
    pickEditOpenAria: (name: string) => `${name} 선택 배열 편집…`,
    pickDeclare: "배열로 추가",
    pickDeclareAria: (name: string) => `${name} 배열로 추가`,
```

- [ ] **Step 3: 실패 확인** — `pnpm test GenVarEditor` · `pnpm test VariablesPanel` → FAIL.

- [ ] **Step 4: `GenVarEditor.tsx`**

(a) import에 `PICK_ARRAY_DEFAULT, type PickArraySpec`(from `../../scenario/genVars`) 추가. props 타입·구조분해에 `onOpenPickArray?: (initial: PickArraySpec, origin: "edit" | "switch") => void;` 추가.

(b) `changeKind`를 교체:

```tsx
  const changeKind = (k: VarKind) => {
    if (k === kind) return;
    if (k === "static") return onCommitStatic("");
    // pick_array는 즉시 커밋하지 않고 팝업으로(적용 시 커밋·취소 시 원래 타입 유지 — spec §6.1).
    // 아래 삼항 체인은 미지 kind를 random_string으로 떨어뜨리므로 이 분기가 반드시 먼저여야 한다.
    if (k === "pick_array") {
      onOpenPickArray?.(PICK_ARRAY_DEFAULT, "switch");
      return;
    }
    onCommitGen(
      k === "date"
        ? { gen: "date", format: "%Y-%m-%d", tz: "Asia/Seoul" }
        : k === "random_int"
          ? { gen: "random_int", min: 1, max: 100 }
          : k === "uuid"
            ? { gen: "uuid" }
            : { gen: "random_string", length: 8 },
    );
  };
```

(c) 타입 select의 `<option value="random_string">` 다음에 `<option value="pick_array">{ko.editor.genTypePickArray}</option>`.

(d) `{strSpec && (…)}` 블록 다음에:

```tsx
      {spec?.gen === "pick_array" && (
        <button
          type="button"
          aria-label={ko.editor.pickEditOpenAria(name)}
          disabled={disabled}
          onClick={() => onOpenPickArray?.(spec, "edit")}
          className="self-start rounded border border-accent-200 bg-accent-50 px-2 py-0.5 text-xs text-accent-700 hover:bg-accent-100 disabled:opacity-40"
        >
          {ko.editor.pickEditOpen}
        </button>
      )}
```

(`accent-*` 토큰이 Tailwind config에 없으면 `indigo-*`로 — ADR-0043 accent=indigo.)

- [ ] **Step 5: `VariablesPanel.tsx`**

(a) import 추가: `PickArrayDialog`(from `./PickArrayDialog`), `isPickArray, PICK_ARRAY_DEFAULT, type PickArraySpec`(from `../../scenario/genVars`), `jsonCastVarNames`(from `../../scenario/scanVars`).

(b) 컴포넌트 밖 모듈 상수: `const EMPTY_NAMES: ReadonlySet<string> = new Set();`

(c) state — `pendingDelete` 선언 근처:

```tsx
  // 선택 배열 팝업(spec §6.3) — 진입 4곳(접힘 편집·펼침 편집…·타입 select·배열로 추가)의 단일 소유.
  const [pickDialog, setPickDialog] = useState<{
    name: string;
    initial: PickArraySpec;
    origin: "edit" | "switch" | "declare";
  } | null>(null);
  // declare 적용만 트리거(배열로 추가)가 행 전이로 사라진다 → 새 행의 편집 버튼으로 1회 포커스.
  // 다른 경로는 Modal 기본 복원(트리거 생존)이라 이 플래그를 세우지 않는다(var-delete-confirm 이디엄).
  const focusPickEditRef = useRef<string | null>(null);
  const pickEditRefs = useRef(new Map<string, HTMLButtonElement>());
  const jsonCastNames = useMemo(() => (model ? jsonCastVarNames(model) : EMPTY_NAMES), [model]);

  useEffect(() => {
    if (pickDialog !== null || focusPickEditRef.current === null) return;
    const name = focusPickEditRef.current;
    focusPickEditRef.current = null;
    pickEditRefs.current.get(name)?.focus();
  }, [pickDialog]);
```

(d) 접힘 생성기 행(`isGenSpec(row.value) ? (…)` 분기)의 `<GenSampleLine …/>` 다음, 같은 `div` 안에:

```tsx
                    {isPickArray(row.value) && (
                      <button
                        type="button"
                        ref={(el) => {
                          if (el) pickEditRefs.current.set(row.name, el);
                          else pickEditRefs.current.delete(row.name);
                        }}
                        aria-label={ko.editor.pickEditAria(row.name)}
                        disabled={yamlError !== null}
                        onClick={() => {
                          if (!isPickArray(row.value)) return;
                          setUsageNav(null);
                          setPickDialog({ name: row.name, initial: row.value, origin: "edit" });
                        }}
                        className="self-start text-xs text-accent-600 hover:underline disabled:opacity-40"
                      >
                        {ko.editor.pickEdit}
                      </button>
                    )}
```

(e) 펼침 `<GenVarEditor …>`에 prop 추가:

```tsx
                    onOpenPickArray={(initial, origin) => {
                      setUsageNav(null);
                      setPickDialog({ name: row.name, initial, origin });
                    }}
```

(f) 미정의 행의 기존 `선언 추가` 버튼 다음에(같은 `row.candidates.length === 0` 조건 안이 아니라 별도 조건으로):

```tsx
              {row.candidates.length === 0 && jsonCastNames.has(row.name) && (
                <button
                  type="button"
                  aria-label={ko.editor.pickDeclareAria(row.name)}
                  disabled={yamlError !== null}
                  onClick={() => {
                    setUsageNav(null);
                    setPickDialog({ name: row.name, initial: PICK_ARRAY_DEFAULT, origin: "declare" });
                  }}
                  className="shrink-0 text-xs text-accent-600 hover:underline disabled:opacity-40"
                >
                  {ko.editor.pickDeclare}
                </button>
              )}
```

(g) `{pendingDelete && model && (…)}` 다음에:

```tsx
      {pickDialog && (
        <PickArrayDialog
          name={pickDialog.name}
          initial={pickDialog.initial}
          onCancel={() => setPickDialog(null)}
          onApply={(spec) => {
            setVariableGen(pickDialog.name, spec);
            if (pickDialog.origin === "declare") focusPickEditRef.current = pickDialog.name;
            setPickDialog(null);
          }}
        />
      )}
```

- [ ] **Step 6: 통과 확인** — `pnpm test GenVarEditor` · `pnpm test VariablesPanel` → PASS. 이어서 전체 `pnpm test` 1회(targeted≠full).

- [ ] **Step 7: 이빨 실증** — (1) `changeKind`의 `pick_array` 분기를 삭제 → GenVarEditor "커밋 없이" 케이스 RED(`random_string` 커밋) → 원복. (2) `focusPickEditRef.current = …` 줄을 삭제 → 배열로 추가 "편집 버튼 포커스" 단언 RED → 원복. (3) `jsonCastNames.has(row.name) &&`를 삭제 → `plainvar`에 버튼 노출로 RED → 원복.

- [ ] **Step 8: 게이트+커밋 (FOREGROUND)**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/genvar-array/ui && pnpm lint; echo exit=$?
cd /Users/sgj/develop/handicap/.claude/worktrees/genvar-array/ui && pnpm test; echo exit=$?
cd /Users/sgj/develop/handicap/.claude/worktrees/genvar-array/ui && pnpm build; echo exit=$?
cd /Users/sgj/develop/handicap/.claude/worktrees/genvar-array
git add ui/src/components/scenario/VariablesPanel.tsx ui/src/components/scenario/GenVarEditor.tsx ui/src/i18n/ko.ts ui/src/components/scenario/__tests__/VariablesPanel.test.tsx ui/src/components/scenario/__tests__/GenVarEditor.test.tsx
git diff --cached --name-only
git commit -m "feat(ui): 변수 패널 선택 배열 배선 — 편집 팝업·타입 전환·배열로 추가·경로별 포커스"
git log -1 --oneline
```

---

## 구현 후 (orchestrator — plan task 아님)

1. **최종 리뷰**: `handicap-reviewer`(whole-branch, BASE = 이 plan 커밋 직후 `git merge-base master HEAD`) + `finish-slice §0` grep으로 `security-reviewer` 판정(diff가 `genvars.rs` 파싱 게이트를 건드리므로 매치 예상 — 판단으로 확인).
2. **라이브 검증 (`/live-verify`)** — spec §8 표가 척추. 백엔드: 워크트리에서 `cargo build -p handicap-worker --bin worker && cargo build -p handicap-controller --bin controller`, 로깅 echo 서버(요청 바디를 찍는 변형 — 번들 `responder.py`는 안 찍는다).
   - US1: `flags: {gen: pick_array, length: 10, min: 2, max: 3}` + 바디 `"flags": "{{flags:json}}"` → run 후 echo 로그의 바디가 JSON 배열·개수 범위·반복 간 상이, test-run trace 동일.
   - US2: `positions: "2-4"`, `pick: 1, rest: 0`(pick≠rest) → 다반복에서 1의 위치 ⊆ {2,3,4}.
   - US3: 프리셋 `"Y"/"N"`·`1/0`·직접 입력 `null` → 와이어 JSON 타입 + 저장 후 `GET /api/scenarios/{id}`의 `yaml`에서 `"Y"` 따옴표 보존.
   - US4: 기본 레이아웃(변수 열 210px)에서 길이 1000 변수: 행의 각 텍스트 요소 `getBoundingClientRect().right ≤` 변수 열 `right`, 팝업 그리드 `scrollHeight > clientHeight` && `scrollWidth ≤ clientWidth`, 팝업 편집 중·취소 후 store `yamlText` 불변·dirty 표시 없음, 무효 설정 적용 disabled. 키보드: Tab이 그리드에 1번만 머무름, 화살표 ↑/↓(열 수 계산 — jsdom 미검증분), Shift+Space 범위가 **1회만** 토글되는지(네이티브 click 억제 실측).
   - US5: 바디 `"{{seats:json}}"` 먼저 → 미정의 행에 `배열로 추가` 존재(`{{plain}}` 변수엔 없음) → 적용 시 선언·편집 버튼 포커스 / 취소 시 미선언.
   - 두 진입 화면 `/scenarios/new`·`/scenarios/{id}` 모두.
3. `/finish-slice`.
