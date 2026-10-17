# 생성 변수 "요청마다 새로 뽑기" (`refresh: request`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 생성 변수 선언에 `refresh: request`를 더하면, 그 변수를 참조하는 HTTP 요청이 나가기 직전마다 새 값으로 다시 평가된다(생략 = 지금처럼 반복당 1회).

**Architecture:** 엔진 모델은 `VarDecl::Gen { spec, refresh }`로 넓히고(YAML `refresh` 키, 공통·선택). 실행 시작 시 1회 `RequestGenPlan`이 "스텝별 참조하는 refresh 변수"를 렌더러 수집 경로로 미리 계산하고, 반복마다 `ReqGen`(생성기 rng + 죽은 집합)을 만들어 `execute_steps`/`trace_steps`의 `Step::Http` arm이 요청 직전에 대상 변수만 재평가한다. 데이터셋 주입·추출이 실제로 쓴 키는 그 반복 동안 재평가 중지. UI는 Zod 공통 `refresh` 필드 + 펼침 편집기 체크박스 + 접힘 행 `요청마다` 배지.

**Tech Stack:** Rust(serde_yaml 0.9, rand 0.8, tokio, wiremock 테스트) · TypeScript/React(Zod 3, `yaml` Document API, vitest + RTL).

**Spec:** `docs/superpowers/specs/2026-10-17-genvar-per-request-design.md` (spec-plan-reviewer APPROVE 2라운드)

**Plan review:** spec-plan-reviewer clean APPROVE 3라운드(2026-10-17).

REVIEW-GATE: APPROVED

## Global Constraints

- YAML 키 `refresh`, 값은 문자열 `request` | `iteration`만. 명시 `null`·빈 값·그 밖의 값은 엔진·UI 모두 거부(spec §4.1·§5).
- 엔진 방출: `refresh: request`일 때만 **맨 끝 키**로 방출, `iteration`은 방출하지 않음. UI 작성기도 같은 규칙(해제 = 키 삭제, `refresh`는 항상 마지막 키).
- 5종 생성기(date·random_int·uuid·random_string·pick_array) 모두 수용. 정적 변수엔 붙일 자리 없음.
- 옵션 미사용 시나리오: 엔진 `to_yaml` 결과·부하 실행 경로·UI 작성 YAML 모두 지금과 byte-identical.
- 생성기 rng는 think rng와 공유 금지(분기 생성기 시드도 부모 **생성기** rng에서).
- template.rs·cast.rs 무변경. executor.rs의 기존 함수 본문 무변경(새 함수 추가만). proto·migration·worker src 0-diff. controller는 프로덕션 코드 0-diff(인라인 테스트만 추가).
- 사용자 노출 문구는 전부 `ui/src/i18n/ko.ts` 경유(ADR-0035), HelpTip 본문은 `ko.glossary`.
- 문구(spec §3): 체크박스 `요청마다 새로 뽑기` · 접힘 배지 `요청마다` · ↻ title(켬) `다시 뽑기 — 실행 시 요청마다 새 값이 생성됩니다` · 팝업 미리보기 제목(켬) `미리보기 (요청마다 새로 뽑힘)` · HelpTip `켜면 이 변수를 쓰는 요청이 나갈 때마다 새 값을 뽑습니다. 끄면 반복(시나리오 1회 실행) 동안 같은 값을 씁니다.` + `같은 이름을 데이터셋이나 추출 값이 채우면 그 값이 우선합니다.`
- **Rust 커밋 전 항상 `cargo fmt --all`** — pre-commit이 `cargo fmt --all -- --check`로 거부한다(plan 인라인 Rust는 rustfmt 모양이 아니어도 된다 — fmt가 맞춘다).
- 커밋 규칙(루트 CLAUDE.md): cargo-영향 커밋은 수 분 걸리는 전체 게이트 — implementer는 단일 FOREGROUND 호출(timeout 600000)로 커밋, `git commit … | tail` 파이프 금지, `--no-verify` 금지, 커밋 후 `git log -1`로 landed 확인. `testdata/`는 pre-commit 게이트 경로 밖이므로 벡터 편집은 항상 `crates/`·`ui/` 파일과 같은 커밋에.

## Review Focus

1. **손으로 쓴 `refresh: iteration`** — 체크박스는 꺼진 상태로 보이고, 켰다 끄면 키가 사라진다(값 `iteration`이 남지 않는다). → Task 4 테스트.
2. **`if` 조건에서만 참조되는 refresh 변수** — 요청이 없으니 재평가되지 않고 반복 시작 값을 보며, run이 죽지 않는다. → Task 3 테스트.
3. **refresh 변수와 같은 이름의 env 토큰(`${f}`)** — env 사용처 때문에 재평가 대상이 되면 안 된다(과대 판정이지만 spec이 명시적으로 금지). → Task 2 테스트.
4. **같은 스텝이 refresh 변수를 참조하면서 같은 이름으로 추출** — 요청 직전 재평가로 새 값이 나가고, 추출 이후 스텝은 추출 값을 받는다. → Task 3 테스트(`extract_written_key_stops_regeneration`가 이 모양).
5. **생성기 → 다른 생성기 타입 전환·팝업 적용** — 켜 둔 `refresh`가 조용히 사라지지 않는다. → Task 4·5 테스트.

---

## 사실 확인 명령 (claims-ledger — 디스패치 전 orchestrator가 재실행)

| 주장 | 명령 | 기대 |
|---|---|---|
| `seed_iter_vars` 호출 4곳 | `grep -n "seed_iter_vars(" crates/engine/src/runner.rs crates/engine/src/trace.rs` | runner 3 + trace 1 |
| `VarDecl::Gen(` 패턴 사이트 | `grep -rn 'VarDecl::Gen' crates/ --include='*.rs'` | genvars.rs 10 + proptests.rs 3 + pick_array.rs 1, controller/worker 0 |
| `execute_steps(` 호출 | `grep -n 'execute_steps(' crates/engine/src/runner.rs` | 정의 1 + 비재귀 3(run_vu·run_vu_curve·run_arrival) + 재귀 3(loop·if·parallel) |
| `trace_steps(` 호출 | `grep -n 'trace_steps(' crates/engine/src/trace.rs` | 정의 1 + trace_once 1 + 재귀 3(loop·if·parallel) — orchestrator 실측 `:260/:388/:429/:460` |
| `render_json_collecting`은 private | `grep -n 'fn render_json_collecting' crates/engine/src/executor.rs` | `fn render_json_collecting(`(pub 없음) |
| Zod 5 멤버 `.strict()` | `grep -n '\.strict()' ui/src/scenario/genVars.ts` | 5줄 |
| 팝업 적용 spec 리터럴 | `grep -n 'gen: "pick_array",' ui/src/components/scenario/PickArrayDialog.tsx` | 1줄(`:182`) |
| `GenSpec` 직렬화 외부 소비처 없음 | `grep -rn 'GenSpec' crates/ --include='*.rs' \| grep -v 'crates/engine/src/genvars.rs' \| grep -i 'serial\|to_string\|to_value'` | 출력 없음 |
| 팝업 길이 칸 접근명 | `grep -n 'aria-label={ko.editor.pickFieldLength}' ui/src/components/scenario/PickArrayDialog.tsx` | 1줄(기존 테스트도 `spinbutton` + `pickFieldLength`로 집음) |

---

### Task 1: 와이어 모델 — `refresh` 키 (엔진 모델·방출 + UI Zod + 공유 벡터 + strip-think 왕복)

**Files:**
- Modify: `crates/engine/src/genvars.rs` (Refresh·VarDecl·wire·deserializer·Serialize 리팩터·`eval_gen`·인라인 테스트)
- Modify: `crates/engine/src/lib.rs:28-31` (export `Refresh`)
- Modify: `crates/engine/tests/proptests.rs:205-287` (refresh 차원 + 패턴)
- Modify: `crates/engine/tests/pick_array.rs:254` (패턴)
- Modify: `testdata/pick_array_vectors.json` (`generators`에 refresh 벡터)
- Modify: `ui/src/scenario/genVars.ts:17-63` (5 멤버에 `refresh`)
- Modify: `crates/controller/src/api/runs.rs` 인라인 `mod strip_think_tests` (테스트 1건)
- Test: 위 인라인/통합 테스트 + `ui/src/scenario/__tests__/pickArrayVectors.test.ts`(무수정 — 벡터로 자동 확장)

**Interfaces:**
- Produces (engine): `pub enum Refresh { Iteration, Request }`(`#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]`, 기본 `Iteration`) · `pub enum VarDecl { Static(String), Gen { spec: GenSpec, refresh: Refresh } }` · `pub(crate) fn eval_gen(spec: &GenSpec, rng: &mut StdRng, now: DateTime<Utc>) -> String`
- Produces (UI): `GenSpec` 각 변형에 `refresh?: "iteration" | "request"`

- [ ] **Step 1: 공유 벡터에 refresh 케이스 추가 (RED 유발)**

`testdata/pick_array_vectors.json`의 `generators` 배열 끝(마지막 `known_divergence` 항목 뒤 — 그 항목 끝에 쉼표를 붙인다)에 추가. 추가 후 `python3 -c "import json;json.load(open('testdata/pick_array_vectors.json'))"`로 JSON 유효성 확인:

```json
    {"yaml": "{gen: uuid, refresh: request}", "expect": "accept"},
    {"yaml": "{gen: uuid, refresh: iteration}", "expect": "accept"},
    {"yaml": "{gen: date, format: unix_ms, refresh: request}", "expect": "accept"},
    {"yaml": "{gen: random_int, min: 1, max: 9, refresh: request}", "expect": "accept"},
    {"yaml": "{gen: random_string, length: 8, refresh: request}", "expect": "accept"},
    {"yaml": "{gen: pick_array, length: 10, min: 1, max: 3, refresh: request}", "expect": "accept"},
    {"yaml": "{gen: uuid, refresh: Request}", "expect": "reject"},
    {"yaml": "{gen: uuid, refresh: true}", "expect": "reject"},
    {"yaml": "{gen: uuid, refresh: step}", "expect": "reject"},
    {"yaml": "{gen: uuid, refresh: null}", "expect": "reject"},
    {"yaml": "{gen: uuid, refresh: }", "expect": "reject"},
    {"yaml": "{refresh: request}", "expect": "reject"}
```

(`{gen: uuid, refresh: }`는 `yaml` 패키지가 `refresh: null`로 읽음 — orchestrator 실측: `node -e 'require("yaml").parse("{gen: uuid, refresh: }")'` → `{"gen":"uuid","refresh":null}`.)

- [ ] **Step 2: 엔진 인라인 테스트 추가 (RED)**

`crates/engine/src/genvars.rs`의 `mod tests` 끝(`seed_iter_vars_mixes_static_and_generated_and_regenerates` 뒤)에 추가:

```rust
    // ---- refresh (spec 2026-10-17-genvar-per-request §4.1) ----
    #[test]
    fn refresh_parses_default_and_request() {
        let m = parse("a: {gen: uuid}\nb: {gen: uuid, refresh: request}\nc: {gen: uuid, refresh: iteration}")
            .unwrap();
        assert_eq!(m["a"], VarDecl::Gen { spec: GenSpec::Uuid, refresh: Refresh::Iteration });
        assert_eq!(m["b"], VarDecl::Gen { spec: GenSpec::Uuid, refresh: Refresh::Request });
        assert_eq!(m["c"], VarDecl::Gen { spec: GenSpec::Uuid, refresh: Refresh::Iteration });
    }
    #[test]
    fn refresh_rejects_null_empty_and_unknown() {
        for bad in [
            "x: {gen: uuid, refresh: null}",
            "x: {gen: uuid, refresh: }",
            "x: {gen: uuid, refresh: Request}",
            "x: {gen: uuid, refresh: true}",
            "x: {refresh: request}",
        ] {
            assert!(parse(bad).is_err(), "should reject: {bad}");
        }
    }
    #[test]
    fn refresh_request_emits_last_and_iteration_omitted() {
        let m = parse(
            "p: {gen: pick_array, length: 4, min: 1, max: 2, rest: 0, refresh: request}\n\
             d: {gen: date, format: unix_ms, refresh: iteration}",
        )
        .unwrap();
        let out = serde_yaml::to_string(&m).unwrap();
        let p_line = out.lines().skip_while(|l| !l.starts_with("p:")).take(8).collect::<Vec<_>>().join("\n");
        // refresh가 p 맵의 마지막 키(rest 뒤)
        assert!(p_line.find("rest").unwrap() < p_line.find("refresh: request").unwrap(), "{out}");
        // iteration은 방출하지 않음
        assert!(!out.contains("iteration"), "{out}");
        assert_eq!(parse(&out).unwrap(), m);
    }
    #[test]
    fn no_refresh_scenario_emits_byte_identically() {
        // 옵션 미사용 선언은 방출이 refresh 도입 전과 같아야 한다(키 순서·키 집합).
        let m = parse("q: {gen: random_int, min: 1, max: 9, step: 2}\nu: {gen: uuid}").unwrap();
        assert_eq!(
            serde_yaml::to_string(&m).unwrap(),
            "q:\n  gen: random_int\n  min: 1\n  max: 9\n  step: 2\nu:\n  gen: uuid\n"
        );
    }
```

기존 테스트 3곳의 패턴을 새 형태로 바꾼다(그대로 두면 컴파일 에러 — Step 4 구현 전엔 RED 상태 유지가 정상):
- `VarDecl::Gen(GenSpec::Date(g)) => {` (date_defaults_applied) → `VarDecl::Gen { spec: GenSpec::Date(g), .. } => {`
- `VarDecl::Gen(GenSpec::Date(g)) => g,` 2곳 → `VarDecl::Gen { spec: GenSpec::Date(g), .. } => g,`

`crates/engine/tests/pick_array.rs:254`:
```rust
        VarDecl::Gen { spec: GenSpec::PickArray(g), .. } => assert_eq!(g.candidates(), &[1, 2, 3, 4]),
```

`crates/engine/tests/proptests.rs` — import에 `Refresh` 추가(`use handicap_engine::{GenSpec, RandomIntGen, RandomStringGen, Refresh, Scenario, VarDecl, evaluate_extracts};`), 기존 `fn arb_var_decl()`을 `fn arb_var_decl_base()`로 개명하고 그 안의 3패턴을 바꾼다:
```rust
            VarDecl::Gen {
                spec: GenSpec::RandomInt(RandomIntGen {
                    min,
                    max: max.max(min),
                    step,
                }),
                refresh: Refresh::Iteration,
            }
        }),
        Just(VarDecl::Gen { spec: GenSpec::Uuid, refresh: Refresh::Iteration }),
        (1u32..=64).prop_map(|length| VarDecl::Gen {
            spec: GenSpec::RandomString(RandomStringGen { length }),
            refresh: Refresh::Iteration,
        }),
```
그리고 그 아래에 새 래퍼:
```rust
// refresh 차원(spec 2026-10-17-genvar-per-request §9): 생성기면 절반 확률로 Request.
// round-trip이 `refresh: request` 방출·재파싱까지 덮는다.
fn arb_var_decl() -> impl Strategy<Value = VarDecl> {
    (arb_var_decl_base(), any::<bool>()).prop_map(|(d, per_request)| match d {
        VarDecl::Gen { spec, .. } if per_request => VarDecl::Gen {
            spec,
            refresh: Refresh::Request,
        },
        other => other,
    })
}
```

- [ ] **Step 3: 컨트롤러 strip-think 왕복 테스트 추가 (RED)**

`crates/controller/src/api/runs.rs`의 `mod strip_think_tests` 안, `YAML_THINK` 정의 바로 뒤에 상수와 테스트 추가:

```rust
    const YAML_THINK_REFRESH: &str = r#"
version: 1
name: t
default_think_time: { min_ms: 500, max_ms: 500 }
variables:
  f: { gen: uuid, refresh: request }
steps:
  - id: 01HX0000000000000000000AAA
    type: http
    name: s1
    request: { method: GET, url: "http://x/?f={{f}}" }
"#;

    #[test]
    fn open_ignore_strip_keeps_refresh_request() {
        // maybe_strip_think는 엔진 Serialize로 재직렬화하는 유일한 소비처(spec §4.1) —
        // refresh가 빠지면 이 run만 조용히 반복 단위로 돌아간다.
        let out = maybe_strip_think(YAML_THINK_REFRESH, &open_profile(false));
        assert_ne!(out, YAML_THINK_REFRESH, "strip 경로를 실제로 탔어야 한다");
        assert!(out.contains("refresh: request"), "{out}");
        let sc = Scenario::from_yaml(&out).unwrap();
        assert!(matches!(
            sc.variables["f"],
            handicap_engine::VarDecl::Gen { refresh: handicap_engine::Refresh::Request, .. }
        ));
    }
```

- [ ] **Step 4: UI Zod 확인 — 벡터 테스트 RED 확인**

Run: `cd /Users/sgj/develop/handicap/.claude/worktrees/pick-array-per-request/ui && pnpm test pickArrayVectors; echo exit=$?`
Expected: FAIL — `accept: {gen: uuid, refresh: request}` 등 accept 벡터 6건 실패(`.strict()`가 `refresh` 거부).

- [ ] **Step 5: 엔진 구현**

`crates/engine/src/genvars.rs`:

(a) `VarDecl` 정의(17-21행)를 교체:
```rust
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VarDecl {
    Static(String),
    Gen { spec: GenSpec, refresh: Refresh },
}

/// 생성 변수 평가 시점 (spec 2026-10-17-genvar-per-request §4.1). 기본 = 반복 시작 1회.
/// `Request`면 그 변수를 참조하는 HTTP 요청 직전마다 다시 평가된다(`reqgen.rs`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Refresh {
    #[default]
    Iteration,
    Request,
}
```

(b) `GenSpecWire`(86-108행)의 `rest` 필드 뒤에 추가:
```rust
    #[serde(default, deserialize_with = "present_refresh")]
    refresh: Option<Refresh>,
```

(c) `present_positions` 함수(150-160행) 뒤에 추가:
```rust
/// refresh: 키가 **있으면** 문자열 "request"|"iteration"만. 명시 null·빈 값도 거부 —
/// Option<String> 기본 경로는 null을 None(=생략)으로 조용히 받아 UI(Zod enum은 null 거부)와
/// 갈린다(positions 선례, spec §4.1).
fn present_refresh<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Refresh>, D::Error> {
    use serde_yaml::Value as Y;
    match Y::deserialize(d)? {
        Y::String(s) if s == "request" => Ok(Some(Refresh::Request)),
        Y::String(s) if s == "iteration" => Ok(Some(Refresh::Iteration)),
        _ => Err(de::Error::custom("refresh는 request 또는 iteration")),
    }
}
```

(d) `visit_map`(402-407행)을 교체:
```rust
            fn visit_map<M: MapAccess<'de>>(self, m: M) -> Result<VarDecl, M::Error> {
                let mut wire = GenSpecWire::deserialize(de::value::MapAccessDeserializer::new(m))?;
                // refresh는 5종 공통 키 — per-gen allow-list(TryFrom) 밖에서 떼어낸다.
                let refresh = wire.refresh.take().unwrap_or_default();
                GenSpec::try_from(wire)
                    .map(|spec| VarDecl::Gen { spec, refresh })
                    .map_err(de::Error::custom)
            }
```

(e) `impl Serialize for VarDecl` + `impl Serialize for GenSpec`(413-486행)을 아래로 통째 교체 — 각 arm의 방출 키·순서·조건은 기존과 동일(맵 열기/닫기만 바깥으로 이동):
```rust
impl Serialize for VarDecl {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            VarDecl::Static(v) => s.serialize_str(v),
            VarDecl::Gen { spec, refresh } => {
                // refresh는 Request일 때만, 항상 맨 끝 키(spec §4.1). Iteration은 방출 안 함 —
                // 옵션 미사용 선언은 도입 전과 byte-identical.
                let per_request = *refresh == Refresh::Request;
                let mut m = s.serialize_map(Some(spec.entry_count() + per_request as usize))?;
                spec.serialize_entries(&mut m)?;
                if per_request {
                    m.serialize_entry("refresh", "request")?;
                }
                m.end()
            }
        }
    }
}

impl GenSpec {
    /// 방출 맵 항목 수(gen 포함, refresh 제외) — serialize_map 길이 힌트.
    fn entry_count(&self) -> usize {
        match self {
            GenSpec::Date(g) => 2 + g.offset.is_some() as usize + g.tz.is_some() as usize,
            GenSpec::RandomInt(g) => 3 + (g.step != 1) as usize,
            GenSpec::Uuid => 1,
            GenSpec::RandomString(_) => 2,
            GenSpec::PickArray(g) => {
                4 + g.positions.is_some() as usize
                    + g.pick.is_some() as usize
                    + g.rest.is_some() as usize
            }
        }
    }

    /// 필드 emit 규칙: gen 태그 + (date) format 항상·offset/tz는 Some만 /
    /// (random_int) min·max 항상·step은 ≠1만 / (random_string) length 항상 /
    /// (pick_array) length·min·max 항상·positions/pick/rest는 Some만.
    fn serialize_entries<M: SerializeMap>(&self, m: &mut M) -> Result<(), M::Error> {
        match self {
            GenSpec::Date(g) => {
                m.serialize_entry("gen", "date")?;
                m.serialize_entry("format", &g.format)?;
                if let Some(o) = &g.offset {
                    m.serialize_entry("offset", o)?;
                }
                if let Some(t) = &g.tz {
                    m.serialize_entry("tz", t)?;
                }
            }
            GenSpec::RandomInt(g) => {
                m.serialize_entry("gen", "random_int")?;
                m.serialize_entry("min", &g.min)?;
                m.serialize_entry("max", &g.max)?;
                if g.step != 1 {
                    m.serialize_entry("step", &g.step)?;
                }
            }
            GenSpec::Uuid => {
                m.serialize_entry("gen", "uuid")?;
            }
            GenSpec::RandomString(g) => {
                m.serialize_entry("gen", "random_string")?;
                m.serialize_entry("length", &g.length)?;
            }
            GenSpec::PickArray(g) => {
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
            }
        }
        Ok(())
    }
}
```

`impl Serialize for GenSpec`는 남기지 않는다(소비처는 `VarDecl` 뿐 — 확인 명령 `grep -rn 'GenSpec' crates/ --include='*.rs' | grep -v genvars.rs`에서 직렬화 호출 없음을 확인. 컴파일 에러가 나면 `impl Serialize for GenSpec { fn serialize(...) { let mut m = s.serialize_map(Some(self.entry_count()))?; self.serialize_entries(&mut m)?; m.end() } }`를 추가한다).

(f) `seed_iter_vars`(570-588행)을 교체하고 `eval_gen`을 그 앞에 추가:
```rust
/// 생성기 1회 평가 — 반복 시드(`seed_iter_vars`)와 요청 단위 재평가(`reqgen.rs`)의 단일 소스.
pub(crate) fn eval_gen(spec: &GenSpec, rng: &mut StdRng, now: DateTime<Utc>) -> String {
    match spec {
        GenSpec::Date(g) => eval_date(g, now),
        GenSpec::RandomInt(g) => eval_random_int(g, rng),
        GenSpec::Uuid => eval_uuid(rng),
        GenSpec::RandomString(g) => eval_random_string(g, rng),
        GenSpec::PickArray(g) => eval_pick_array(g, rng),
    }
}

/// 반복 시드: 정적은 clone, 생성기는 지금 평가(refresh와 무관하게 전부 — 첫 요청 전의
/// `if` 조건이 값을 볼 수 있게, spec §4.2). 호출부(runner 3곳·trace 1곳)가
/// **생성기 전용** entropy rng를 넘긴다 — think rng 공유 금지 (spec §4).
pub fn seed_iter_vars(
    vars: &BTreeMap<String, VarDecl>,
    rng: &mut StdRng,
) -> BTreeMap<String, String> {
    let now = Utc::now();
    vars.iter()
        .map(|(k, d)| {
            let v = match d {
                VarDecl::Static(s) => s.clone(),
                VarDecl::Gen { spec, .. } => eval_gen(spec, rng, now),
            };
            (k.clone(), v)
        })
        .collect()
}
```

`crates/engine/src/lib.rs`의 genvars re-export에 `Refresh` 추가:
```rust
pub use genvars::{
    GenSpec, PICK_ARRAY_MAX_LEN, POSITIONS_MAX_CHARS, PickArrayGen, RandomIntGen, RandomStringGen,
    Refresh, VarDecl, parse_positions, seed_iter_vars,
};
```

- [ ] **Step 6: UI Zod 구현**

`ui/src/scenario/genVars.ts` — `OFFSET_RE` 정의 뒤에 공통 모델 추가:
```ts
// 평가 시점(spec 2026-10-17-genvar-per-request §5) — 5 멤버 공통. `.strict()` 멤버라 하나라도
// 빠뜨리면 그 생성기만 refresh를 거부해 엔진과 판정이 갈린다. null은 거부(엔진 present_refresh).
const RefreshModel = z.enum(["iteration", "request"]);
```
5개 멤버 각 `z.object({...})` 안 마지막 필드로 `refresh: RefreshModel.optional(),` 추가:
- `DateGenModel`: `tz: …optional(),` 뒤
- `RandomIntGenModel`: `step: …optional(),` 뒤
- `UuidGenModel`: `z.object({ gen: z.literal("uuid"), refresh: RefreshModel.optional() }).strict()`
- `RandomStringGenModel`: `length: …optional(),` 뒤
- `PickArrayGenModel`: `rest: JsonScalarModel.optional(),` 뒤

- [ ] **Step 7: 검증 (GREEN)**

Run:
```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/pick-array-per-request
cargo nextest run -p handicap-engine genvars pick_array proptests; echo exit=$?
cargo nextest run -p handicap-controller strip_think; echo exit=$?
cd ui && pnpm test pickArrayVectors genVars; echo exit=$?
```
Expected: 모두 exit=0. 새 테스트 4건(엔진)·1건(컨트롤러)·벡터 12건(UI) PASS.

- [ ] **Step 8: 이빨 실증 (기록만, 커밋 안 함)**

① `present_refresh`의 `match` 첫 arm으로 `Y::Null => Ok(None),`를 추가(= null을 생략으로 받는 기본 경로 흉내) → `refresh_rejects_null_empty_and_unknown`·`generator_vectors`(`refresh: null`) RED 확인 → 원복 → GREEN.
② `VarDecl` Serialize의 `if per_request { … }` 블록 삭제 → `refresh_request_emits_last_and_iteration_omitted`·`open_ignore_strip_keeps_refresh_request` RED → 원복.
③ `PickArrayGenModel`에서 `refresh` 줄 삭제 → `pickArrayVectors` RED → 원복.

- [ ] **Step 9: 커밋 (FOREGROUND, timeout 600000)**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/pick-array-per-request
cargo fmt --all
git add crates/engine/src/genvars.rs crates/engine/src/lib.rs crates/engine/tests/proptests.rs crates/engine/tests/pick_array.rs crates/controller/src/api/runs.rs ui/src/scenario/genVars.ts testdata/pick_array_vectors.json
git diff --cached --name-only
git commit -m "feat(engine,ui): 생성 변수 refresh 키 와이어 모델 — 파싱·방출·Zod·공유 벡터"
git log -1 --oneline
```

---

### Task 2: 요청 참조 판정 + 재평가 상태 (`reqgen.rs`, 순수 단위)

**Files:**
- Create: `crates/engine/src/reqgen.rs`
- Modify: `crates/engine/src/lib.rs` (`mod reqgen;` — 비공개)
- Modify: `crates/engine/src/executor.rs` (새 함수 `request_flow_refs` 추가, 기존 함수 무변경)
- Modify: `crates/engine/CLAUDE.md` (lockstep 함정 한 줄)

**Interfaces:**
- Consumes: Task 1의 `Refresh`, `VarDecl::Gen { spec, refresh }`, `eval_gen`.
- Produces:
  - `pub(crate) fn request_flow_refs(req: &Request, names: &[String]) -> Vec<usize>` (executor.rs)
  - `pub(crate) struct RequestGenPlan` + `pub(crate) fn build(scenario: &Scenario) -> Option<Arc<RequestGenPlan>>` + `pub(crate) fn targets(&self, step_id: &str) -> &[usize]`
  - `pub(crate) struct ReqGen` + `new(plan: Arc<RequestGenPlan>, seed: u64) -> Self` · `refresh(&mut self, step_id: &str, vars: &mut BTreeMap<String, String>)` · `mark_written<'a>(&mut self, keys: impl IntoIterator<Item = &'a String>)` · `fork(&mut self) -> ReqGen`

배선은 Task 3. 이 task의 신규 `pub(crate)` 항목은 아직 호출부가 없어 `-D warnings` dead_code에 걸리므로 각 항목에 `#[allow(dead_code)] // Task 3 배선 후 제거` 를 단다(Task 3 Step 7이 제거 — 제거 누락은 grep으로 확인).

- [ ] **Step 0: tdd-guard keepalive**

`lib.rs`(인라인 테스트 없음)에 `mod reqgen;`을 넣는 편집은 pending test-path 파일이 없으면 tdd-guard가 막는다(Task 1 커밋 후엔 pending 0). 먼저 `crates/engine/tests/_tdd_keepalive.rs`를 만든다(커밋하지 않음 — Step 6에서 `rm`, `git add -A` 금지):

```rust
#[test]
fn keepalive() {}
```

- [ ] **Step 1: 실패 테스트 작성**

`crates/engine/src/reqgen.rs`를 테스트만 담아 생성(구현은 Step 3):

```rust
//! 생성 변수 요청 단위 재평가 (spec 2026-10-17-genvar-per-request §4.2–4.4).

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scenario::Scenario;
    use std::collections::BTreeMap;

    fn sc(vars: &str, steps: &str) -> Scenario {
        Scenario::from_yaml(&format!("version: 1\nname: t\nvariables:\n{vars}\nsteps:\n{steps}")).unwrap()
    }
    fn http(id: &str, url: &str) -> String {
        format!("  - {{ id: \"{id}\", name: s, type: http, request: {{ method: GET, url: \"{url}\" }} }}\n")
    }
    const ID_A: &str = "01HX0000000000000000000001";
    const ID_B: &str = "01HX0000000000000000000002";

    #[test]
    fn no_request_vars_builds_none() {
        let s = sc("  f: {gen: uuid}", &http(ID_A, "http://x/{{f}}"));
        assert!(RequestGenPlan::build(&s).is_none(), "refresh 없으면 상태 없음(hot path 0)");
    }

    fn names_for(plan: &RequestGenPlan, id: &str) -> Vec<String> {
        plan.targets(id).iter().map(|&i| plan.names[i].clone()).collect()
    }

    /// 필드별 lockstep(spec §4.3): url·헤더 값·JSON leaf·JSON 캐스트 leaf·form 값·raw·공백 토큰.
    #[test]
    fn refs_per_field_lockstep() {
        let cases: &[(&str, &str)] = &[
            ("url", "request: { method: GET, url: \"http://x/{{f}}\" }"),
            ("header", "request: { method: GET, url: \"http://x/\", headers: { X-A: \"{{f}}\" } }"),
            ("json leaf", "request: { method: POST, url: \"http://x/\", body: { json: { a: \"p-{{f}}\" } } }"),
            ("json cast", "request: { method: POST, url: \"http://x/\", body: { json: { a: \"{{f:json}}\" } } }"),
            ("form", "request: { method: POST, url: \"http://x/\", body: { form: { a: \"{{f}}\" } } }"),
            ("raw", "request: { method: POST, url: \"http://x/\", body: { raw: \"v={{f}}\" } }"),
            ("spaced", "request: { method: GET, url: \"http://x/{{ f }}\" }"),
        ];
        for (label, req) in cases {
            let s = sc(
                "  f: {gen: uuid, refresh: request}",
                &format!("  - id: \"{ID_A}\"\n    name: s\n    type: http\n    {req}\n"),
            );
            let p = RequestGenPlan::build(&s).unwrap();
            assert_eq!(names_for(&p, ID_A), vec!["f".to_string()], "field {label}");
        }
    }

    #[test]
    fn env_and_system_tokens_are_not_targets() {
        // ${f}·"${f:json}"는 env 토큰 — 이름이 같아도 대상 아님(spec §4.3 더미 env).
        // ${loop_index}·${BASE_URL}은 교집합에서 빠짐.
        let s = sc(
            "  f: {gen: uuid, refresh: request}",
            &format!(
                "  - id: \"{ID_A}\"\n    name: s\n    type: http\n    request: {{ method: POST, url: \"${{BASE_URL}}/${{f}}/${{loop_index}}\", body: {{ json: {{ a: \"${{f:json}}\" }} }} }}\n"
            ),
        );
        let p = RequestGenPlan::build(&s).unwrap();
        assert!(p.targets(ID_A).is_empty(), "{:?}", names_for(&p, ID_A));
    }

    #[test]
    fn nested_steps_and_unreferenced_step() {
        let steps = format!(
            "  - id: \"01HX00000000000000000000M0\"\n    name: lp\n    type: loop\n    repeat: 2\n    do:\n      - {{ id: \"{ID_A}\", name: a, type: http, request: {{ method: GET, url: \"http://x/{{{{f}}}}\" }} }}\n{}",
            http(ID_B, "http://x/none")
        );
        let s = sc("  f: {gen: uuid, refresh: request}", &steps);
        let p = RequestGenPlan::build(&s).unwrap();
        assert_eq!(names_for(&p, ID_A), vec!["f".to_string()]);
        assert!(p.targets(ID_B).is_empty());
    }

    #[test]
    fn duplicate_step_id_unions_targets() {
        let steps = format!("{}{}", http(ID_A, "http://x/{{f}}"), http(ID_A, "http://x/{{g}}"));
        let s = sc("  f: {gen: uuid, refresh: request}\n  g: {gen: uuid, refresh: request}", &steps);
        let p = RequestGenPlan::build(&s).unwrap();
        let mut got = names_for(&p, ID_A);
        got.sort();
        assert_eq!(got, vec!["f".to_string(), "g".to_string()]);
    }

    #[test]
    fn iteration_vars_are_never_targets() {
        let s = sc(
            "  f: {gen: uuid, refresh: request}\n  o: {gen: uuid}",
            &http(ID_A, "http://x/{{f}}/{{o}}"),
        );
        let p = RequestGenPlan::build(&s).unwrap();
        assert_eq!(names_for(&p, ID_A), vec!["f".to_string()]);
    }

    #[test]
    fn refresh_regenerates_only_alive_targets() {
        let s = sc(
            "  f: {gen: uuid, refresh: request}\n  g: {gen: uuid, refresh: request}",
            &http(ID_A, "http://x/{{f}}/{{g}}"),
        );
        let p = RequestGenPlan::build(&s).unwrap();
        let mut rg = ReqGen::new(p, 7);
        let mut vars: BTreeMap<String, String> =
            [("f".to_string(), "F0".to_string()), ("g".to_string(), "G0".to_string())].into();
        rg.mark_written([&"g".to_string()]);
        rg.refresh(ID_A, &mut vars);
        assert_ne!(vars["f"], "F0", "살아 있는 f는 재평가");
        assert_eq!(vars["g"], "G0", "쓰인 g는 재평가 안 함");
        let f1 = vars["f"].clone();
        rg.refresh(ID_A, &mut vars);
        assert_ne!(vars["f"], f1, "요청마다 새 값");
        rg.refresh("unknown-step", &mut vars); // 대상 없는 스텝은 no-op
    }

    #[test]
    fn fork_copies_dead_set_and_diverges() {
        let s = sc(
            "  f: {gen: uuid, refresh: request}\n  g: {gen: uuid, refresh: request}",
            &http(ID_A, "http://x/{{f}}/{{g}}"),
        );
        let p = RequestGenPlan::build(&s).unwrap();
        let mut parent = ReqGen::new(p, 7);
        parent.mark_written([&"g".to_string()]);
        let mut a = parent.fork();
        let mut b = parent.fork();
        let mut va: BTreeMap<String, String> = [("g".to_string(), "G".to_string())].into();
        let mut vb = va.clone();
        a.refresh(ID_A, &mut va);
        b.refresh(ID_A, &mut vb);
        assert_eq!(va["g"], "G");
        assert_eq!(vb["g"], "G");
        assert_ne!(va["f"], vb["f"], "분기마다 다른 rng");
    }
}
```

`crates/engine/src/lib.rs`에 `mod reqgen;` 추가(`mod genvars;` 다음 줄).

- [ ] **Step 2: RED 확인**

Run: `cargo nextest run -p handicap-engine reqgen; echo exit=$?`
Expected: 컴파일 실패(`RequestGenPlan`/`ReqGen` 미정의).

- [ ] **Step 3: 구현**

`crates/engine/src/executor.rs` — `render_json_collecting` 함수 정의(파일 내 `fn render_json_collecting(`) 바로 뒤에 추가(기존 함수 무변경):

```rust
/// 요청이 참조하는 `names`(refresh: request 변수) 인덱스 — 실행 시작 시 1회
/// (spec 2026-10-17-genvar-per-request §4.3). **렌더러 자신의 수집 경로를 재사용**하고,
/// `execute_step`의 렌더 지점(url·헤더 값·JSON·form 값·raw)과 lockstep이다 — 새 렌더
/// 필드를 추가하면 여기도 추가할 것(빠뜨리면 그 필드에서만 반복 값이 나간다).
/// 수집 sink는 미해결 `{{x}}`와 `${X}`를 구분 없이 담으므로, env에 `names`를 더미로
/// 넣어 `${f}`가 수집되지 않게 하고 `loop_index: Some(0)`로 `${loop_index}`도 막은 뒤
/// `names`와 교집합한다(`${BASE_URL}` 같은 다른 env 이름은 교집합에서 빠진다).
pub(crate) fn request_flow_refs(req: &crate::scenario::Request, names: &[String]) -> Vec<usize> {
    let vars: BTreeMap<String, String> = BTreeMap::new();
    let env: BTreeMap<String, String> = names.iter().map(|n| (n.clone(), String::new())).collect();
    let ctx = TemplateContext {
        vars: &vars,
        env: &env,
        vu_id: 0,
        iter_id: 0,
        loop_index: Some(0),
    };
    let mut unbound: Vec<String> = Vec::new();
    render_collecting(&req.url, &ctx, &mut unbound);
    for v in req.headers.values() {
        render_collecting(v, &ctx, &mut unbound);
    }
    match &req.body {
        Some(Body::Json(v)) => {
            render_json_collecting(v, &ctx, &mut unbound);
        }
        Some(Body::Form(map)) => {
            for v in map.values() {
                render_collecting(v, &ctx, &mut unbound);
            }
        }
        Some(Body::Raw(s)) => {
            render_collecting(s, &ctx, &mut unbound);
        }
        None => {}
    }
    names
        .iter()
        .enumerate()
        .filter(|(_, n)| unbound.iter().any(|u| u == *n))
        .map(|(i, _)| i)
        .collect()
}
```
(`render_collecting`·`TemplateContext`·`Body`·`BTreeMap`이 executor.rs에 이미 import돼 있지 않으면 기존 import 줄에 추가한다 — `render_json_collecting`이 이미 `render_collecting`/`TemplateContext`를 쓰므로 둘은 있다.)

`crates/engine/src/reqgen.rs` — 테스트 모듈 **위**에 구현:

```rust
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use rand::rngs::StdRng;
use rand::{RngCore, SeedableRng};

use crate::executor::request_flow_refs;
use crate::genvars::{GenSpec, Refresh, VarDecl, eval_gen};
use crate::scenario::{HttpStep, Scenario, Step};

/// run당 1회 계산(부하 3진입점은 VU spawn 전, test-run은 trace 호출당) — `Arc`로 VU 공유.
#[derive(Debug)]
pub(crate) struct RequestGenPlan {
    names: Vec<String>,
    specs: Vec<GenSpec>,
    /// step_id → 재평가 대상(names 인덱스). 같은 step_id 여러 스텝은 합집합(§4.3).
    by_step: HashMap<String, Vec<usize>>,
}

impl RequestGenPlan {
    /// `refresh: request` 선언이 없으면 `None` — 호출부는 상태를 만들지 않는다(hot path 분기 1회).
    pub(crate) fn build(scenario: &Scenario) -> Option<Arc<Self>> {
        let mut names = Vec::new();
        let mut specs = Vec::new();
        for (k, d) in &scenario.variables {
            if let VarDecl::Gen {
                spec,
                refresh: Refresh::Request,
            } = d
            {
                names.push(k.clone());
                specs.push(spec.clone());
            }
        }
        if names.is_empty() {
            return None;
        }
        let mut https: Vec<&HttpStep> = Vec::new();
        collect_http(&scenario.steps, &mut https);
        let mut by_step: HashMap<String, Vec<usize>> = HashMap::new();
        for h in https {
            let refs = request_flow_refs(&h.request, &names);
            if refs.is_empty() {
                continue;
            }
            let e = by_step.entry(h.id.clone()).or_default();
            for i in refs {
                if !e.contains(&i) {
                    e.push(i);
                }
            }
        }
        Some(Arc::new(Self {
            names,
            specs,
            by_step,
        }))
    }

    pub(crate) fn targets(&self, step_id: &str) -> &[usize] {
        self.by_step.get(step_id).map(Vec::as_slice).unwrap_or(&[])
    }
}

fn collect_http<'a>(steps: &'a [Step], out: &mut Vec<&'a HttpStep>) {
    for s in steps {
        match s {
            Step::Http(h) => out.push(h),
            Step::Loop(l) => collect_http(&l.do_, out),
            Step::If(i) => {
                collect_http(&i.then_, out);
                for e in &i.elif {
                    collect_http(&e.then_, out);
                }
                collect_http(&i.else_, out);
            }
            Step::Parallel(p) => {
                for b in &p.branches {
                    collect_http(&b.steps, out);
                }
            }
        }
    }
}

/// 반복(또는 parallel 분기) 단위 재평가 상태 — 생성기 rng + 죽은 집합(§4.2).
pub(crate) struct ReqGen {
    plan: Arc<RequestGenPlan>,
    rng: StdRng,
    dead: Vec<bool>,
}

impl ReqGen {
    /// `seed`는 호출부의 **생성기** rng에서 뽑는다(think rng 금지).
    pub(crate) fn new(plan: Arc<RequestGenPlan>, seed: u64) -> Self {
        let n = plan.names.len();
        Self {
            plan,
            rng: StdRng::seed_from_u64(seed),
            dead: vec![false; n],
        }
    }

    /// 데이터셋 주입·추출이 **실제로 쓴** 키 — 그 반복(분기)의 남은 요청에서 재평가 중지
    /// (우선순위 생성 < 데이터셋 < 추출 유지).
    pub(crate) fn mark_written<'a>(&mut self, keys: impl IntoIterator<Item = &'a String>) {
        for k in keys {
            if let Some(i) = self.plan.names.iter().position(|n| n == k) {
                self.dead[i] = true;
            }
        }
    }

    /// 요청 직전: 이 스텝이 참조하는 살아 있는 refresh 변수만 새로 평가해 덮어쓴다.
    pub(crate) fn refresh(&mut self, step_id: &str, vars: &mut BTreeMap<String, String>) {
        let targets = self.plan.targets(step_id);
        if targets.is_empty() {
            return;
        }
        let now = chrono::Utc::now();
        for &i in targets {
            if !self.dead[i] {
                let v = eval_gen(&self.plan.specs[i], &mut self.rng, now);
                vars.insert(self.plan.names[i].clone(), v);
            }
        }
    }

    /// parallel 분기용 복제 — 죽은 집합 복사 + 부모 생성기 rng에서 시드 1개.
    pub(crate) fn fork(&mut self) -> Self {
        Self {
            plan: self.plan.clone(),
            rng: StdRng::seed_from_u64(self.rng.next_u64()),
            dead: self.dead.clone(),
        }
    }
}
```

`targets`를 지역 변수로 받은 뒤 `self.rng`/`self.dead`를 쓰면 `self.plan`(Arc) 차용과 겹친다 — 컴파일 에러가 나면 `let plan = self.plan.clone(); let targets = plan.targets(step_id);`로 바꾼다(Arc clone 1회, refresh 변수가 있는 경로에서만).

dead_code: `RequestGenPlan`·`build`·`targets`·`ReqGen`·`new`·`mark_written`·`refresh`·`fork`·`request_flow_refs` 각각 위에 `#[allow(dead_code)] // Task 3 배선 후 제거` (구조체는 struct 위, impl 메서드는 메서드 위).

`crates/engine/CLAUDE.md` "HTTP 실행 / extract / 템플릿팅" 섹션 끝에 한 줄:
```
- **`request_flow_refs`(executor.rs)는 `execute_step` 렌더 지점과 lockstep** (genvar-per-request): `refresh: request` 변수의 요청별 재평가 대상을 url·헤더 값·JSON·form 값·raw 렌더로 미리 계산한다 — `execute_step`에 새 렌더 필드를 추가하면 여기도 추가(빠뜨리면 그 필드에서만 반복 값이 조용히 나간다). 수집 sink가 `{{x}}`/`${X}`를 구분 안 하므로 env에 대상 이름을 더미로 넣는 컨텍스트가 load-bearing(`reqgen.rs` 테스트 `env_and_system_tokens_are_not_targets`).
```

- [ ] **Step 4: GREEN**

Run: `cargo nextest run -p handicap-engine reqgen; echo exit=$?` → exit=0 (8 tests).
Run: `cargo clippy -p handicap-engine --all-targets -- -D warnings; echo exit=$?` → exit=0.

- [ ] **Step 5: 이빨 실증 (기록만)**

① `request_flow_refs`의 `env`를 빈 맵으로 바꿈 → `env_and_system_tokens_are_not_targets` RED → 원복.
② `Some(Body::Form(map))` arm 본문을 비움 → `refs_per_field_lockstep`의 `form` 케이스 RED → 원복.
③ `by_step.entry(...)`를 `by_step.insert(h.id.clone(), refs)`로 바꿈 → `duplicate_step_id_unions_targets` RED → 원복.

- [ ] **Step 6: 커밋 (FOREGROUND, timeout 600000)**

```bash
rm crates/engine/tests/_tdd_keepalive.rs
cargo fmt --all
git add crates/engine/src/reqgen.rs crates/engine/src/lib.rs crates/engine/src/executor.rs crates/engine/CLAUDE.md
git diff --cached --name-only
git commit -m "feat(engine): refresh 변수 요청 참조 판정·재평가 상태 (reqgen)"
git log -1 --oneline
```

---

### Task 3: 엔진 배선 — 부하 3진입점 + execute_steps + test-run

**Files:**
- Modify: `crates/engine/src/runner.rs` (`run_scenario`·`run_vu`·`run_scenario_vu_curve`·`run_vu_curve`·`run_scenario_open_loop`·`run_arrival`·`execute_steps`)
- Modify: `crates/engine/src/trace.rs` (`trace_scenario_with_seed`·`trace_scenario_rows`·`trace_once`·`trace_steps`)
- Modify: `crates/engine/src/reqgen.rs`·`crates/engine/src/executor.rs` (`#[allow(dead_code)]` 제거)
- Create: `crates/engine/tests/genvars_per_request.rs`

**Interfaces:**
- Consumes: Task 2의 `RequestGenPlan::build`, `ReqGen::{new, refresh, mark_written, fork}`.
- Produces: `execute_steps(…, default_think, req: &mut Option<ReqGen>)` · `trace_steps(…, default_think, req: &mut Option<ReqGen>)` — 마지막 인자 추가.

- [ ] **Step 1: 실패 통합 테스트 작성**

`crates/engine/tests/genvars_per_request.rs` 생성:

```rust
// refresh: request 배선 (spec 2026-10-17-genvar-per-request §4.2·§9) — 부하 3진입점을 Mode로 직접
// spawn(run_scenario만 테스트하면 곡선·open 누락이 green — 엔진 CLAUDE.md 함정) + trace.
use handicap_engine::{
    BindingPolicy, DataSet, MetricFlush, RampDown, RunPlan, Scenario, Stage, TraceOptions,
    run_scenario, run_scenario_open_loop, run_scenario_vu_curve, trace_scenario,
    trace_scenario_rows,
};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

#[derive(Clone, Copy)]
enum Mode {
    Closed,
    Curve,
    Open,
}

fn base_plan(dur_ms: u64) -> RunPlan {
    RunPlan {
        vus: 1,
        ramp_up: Duration::ZERO,
        duration: Duration::from_millis(dur_ms),
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
    }
}

/// 요청 순서대로 (path, query map). Open은 max_in_flight=1이라 arrival이 순차 → 반복 경계가 순서를 지킨다.
async fn run_collect(
    mode: Mode,
    yaml_tpl: &str,
    dur_ms: u64,
    tweak: impl FnOnce(&mut RunPlan),
    server: &MockServer,
) -> Vec<(String, HashMap<String, String>)> {
    let yaml = yaml_tpl.replace("{URI}", &server.uri());
    let scenario = Arc::new(Scenario::from_yaml(&yaml).unwrap());
    let mut plan = base_plan(dur_ms);
    match mode {
        Mode::Closed => {}
        Mode::Curve => {
            plan.vu_stages = Some(vec![Stage {
                target: 1,
                duration_seconds: 1,
            }])
        }
        Mode::Open => {
            plan.target_rps = Some(20);
            plan.max_in_flight = Some(1);
            plan.vus = 0;
        }
    }
    tweak(&mut plan);
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(64);
    let cancel = CancellationToken::new();
    let h = match mode {
        Mode::Closed => tokio::spawn(run_scenario(scenario, plan, tx, cancel)),
        Mode::Curve => tokio::spawn(run_scenario_vu_curve(scenario, plan, tx, cancel)),
        Mode::Open => tokio::spawn(run_scenario_open_loop(scenario, plan, tx, cancel)),
    };
    while rx.recv().await.is_some() {}
    h.await.unwrap().unwrap();
    server
        .received_requests()
        .await
        .unwrap()
        .iter()
        .map(|r| {
            let q = r
                .url
                .query_pairs()
                .map(|(k, v)| (k.into_owned(), v.into_owned()))
                .collect();
            (r.url.path().to_string(), q)
        })
        .collect()
}

async fn ok_server() -> MockServer {
    let s = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&s)
        .await;
    s
}

/// 연속한 같은 `o`(반복당 1회 uuid) 묶음 = 한 반복. 각 묶음 안에서 `f`는 전부 서로 달라야 하고,
/// 묶음 크기 ≥2가 최소 하나 있어야 한다(아니면 단언이 공허).
fn assert_f_fresh_within_iteration(reqs: &[(String, HashMap<String, String>)]) {
    let mut groups: Vec<Vec<&HashMap<String, String>>> = Vec::new();
    for (_, q) in reqs {
        match groups.last_mut() {
            Some(g) if g[0]["o"] == q["o"] => g.push(q),
            _ => groups.push(vec![q]),
        }
    }
    assert!(groups.iter().any(|g| g.len() >= 2), "반복 내 요청 2개 이상 필요: {reqs:?}");
    for g in &groups {
        let fs: HashSet<&String> = g.iter().map(|q| &q["f"]).collect();
        assert_eq!(fs.len(), g.len(), "반복 안에서 f가 요청마다 달라야: {g:?}");
    }
    let os: HashSet<&String> = groups.iter().map(|g| &g[0]["o"]).collect();
    assert_eq!(os.len(), groups.len(), "o(iteration)는 반복마다 새 값이어야 묶음이 반복과 일치");
}

const TWO_STEP: &str = "version: 1
name: g
variables:
  f: {gen: uuid, refresh: request}
  o: {gen: uuid}
steps:
  - { id: \"01HX0000000000000000000001\", name: a, type: http, request: { method: GET, url: \"{URI}/a?f={{f}}&o={{o}}\" } }
  - { id: \"01HX0000000000000000000002\", name: b, type: http, request: { method: GET, url: \"{URI}/b?f={{f}}&o={{o}}\" } }
";

#[tokio::test]
async fn closed_regenerates_per_request() {
    let s = ok_server().await;
    let reqs = run_collect(Mode::Closed, TWO_STEP, 400, |_| {}, &s).await;
    assert_f_fresh_within_iteration(&reqs);
}
#[tokio::test]
async fn curve_regenerates_per_request() {
    let s = ok_server().await;
    let reqs = run_collect(Mode::Curve, TWO_STEP, 1000, |_| {}, &s).await;
    assert_f_fresh_within_iteration(&reqs);
}
#[tokio::test]
async fn open_regenerates_per_request() {
    let s = ok_server().await;
    let reqs = run_collect(Mode::Open, TWO_STEP, 700, |_| {}, &s).await;
    assert_f_fresh_within_iteration(&reqs);
}

#[tokio::test]
async fn loop_regenerates_each_round() {
    let s = ok_server().await;
    let yaml = "version: 1
name: g
variables:
  f: {gen: uuid, refresh: request}
  o: {gen: uuid}
steps:
  - id: \"01HX00000000000000000000M0\"
    name: lp
    type: loop
    repeat: 3
    do:
      - { id: \"01HX0000000000000000000001\", name: a, type: http, request: { method: GET, url: \"{URI}/l?f={{f}}&o={{o}}\" } }
";
    let reqs = run_collect(Mode::Closed, yaml, 300, |_| {}, &s).await;
    assert_f_fresh_within_iteration(&reqs);
}

#[tokio::test]
async fn parallel_branches_regenerate() {
    let s = ok_server().await;
    let yaml = "version: 1
name: g
variables:
  f: {gen: uuid, refresh: request}
  o: {gen: uuid}
steps:
  - id: \"01HX00000000000000000000P0\"
    name: par
    type: parallel
    branches:
      - name: x
        steps:
          - { id: \"01HX0000000000000000000011\", name: p1, type: http, request: { method: GET, url: \"{URI}/p1?f={{f}}&o={{o}}\" } }
      - name: y
        steps:
          - { id: \"01HX0000000000000000000012\", name: p2, type: http, request: { method: GET, url: \"{URI}/p2?f={{f}}&o={{o}}\" } }
  - { id: \"01HX0000000000000000000013\", name: z, type: http, request: { method: GET, url: \"{URI}/z?f={{f}}&o={{o}}\" } }
";
    let reqs = run_collect(Mode::Closed, yaml, 400, |_| {}, &s).await;
    // 분기는 동시 실행이라 순서 대신 o(반복)로 묶는다.
    let mut by_o: HashMap<String, Vec<String>> = HashMap::new();
    for (_, q) in &reqs {
        by_o.entry(q["o"].clone()).or_default().push(q["f"].clone());
    }
    let full: Vec<_> = by_o.values().filter(|fs| fs.len() == 3).collect();
    assert!(!full.is_empty(), "완전한 반복 1개 이상: {reqs:?}");
    for fs in full {
        let set: HashSet<_> = fs.iter().collect();
        assert_eq!(set.len(), 3, "p1·p2·z가 서로 다른 f: {fs:?}");
    }
}

#[tokio::test]
async fn dataset_bound_name_is_not_regenerated() {
    let s = ok_server().await;
    let row: BTreeMap<String, String> = [("f".to_string(), "DS".to_string())].into();
    let ds = DataSet {
        policy: BindingPolicy::PerVu,
        seed: 0,
        rows: vec![row],
    };
    let reqs = run_collect(
        Mode::Closed,
        TWO_STEP,
        300,
        |p| p.data_bindings = vec![Arc::new(ds)],
        &s,
    )
    .await;
    assert!(!reqs.is_empty());
    assert!(reqs.iter().all(|(_, q)| q["f"] == "DS"), "데이터셋 우선: {reqs:?}");
}

const EXTRACT: &str = "version: 1
name: g
variables:
  f: {gen: uuid, refresh: request}
  o: {gen: uuid}
steps:
  - id: \"01HX0000000000000000000001\"
    name: a
    type: http
    request: { method: GET, url: \"{URI}/a?f={{f}}&o={{o}}\" }
    extract:
      - var: f
        from: body
        path: \"{PATH}\"
  - { id: \"01HX0000000000000000000002\", name: b, type: http, request: { method: GET, url: \"{URI}/b?f={{f}}&o={{o}}\" } }
";

async fn extract_server() -> MockServer {
    let s = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/a"))
        .respond_with(ResponseTemplate::new(200).set_body_string("{\"tok\":\"X\"}"))
        .mount(&s)
        .await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&s)
        .await;
    s
}

/// a/b 연속 쌍(같은 o)만 뽑는다.
fn pairs(reqs: &[(String, HashMap<String, String>)]) -> Vec<(HashMap<String, String>, HashMap<String, String>)> {
    reqs.windows(2)
        .filter(|w| w[0].0 == "/a" && w[1].0 == "/b" && w[0].1["o"] == w[1].1["o"])
        .map(|w| (w[0].1.clone(), w[1].1.clone()))
        .collect()
}

#[tokio::test]
async fn extract_written_key_stops_regeneration() {
    // Review Focus 4: a는 f를 참조하면서 같은 이름으로 추출 — a에는 새 uuid, b에는 추출 값.
    let s = extract_server().await;
    let yaml = EXTRACT.replace("{PATH}", "$.tok");
    let reqs = run_collect(Mode::Closed, &yaml, 300, |_| {}, &s).await;
    let ps = pairs(&reqs);
    assert!(!ps.is_empty(), "{reqs:?}");
    for (a, b) in ps {
        assert_ne!(a["f"], "X", "a는 요청 직전 재평가 값");
        assert_eq!(b["f"], "X", "추출이 쓴 뒤로는 추출 값");
    }
}

#[tokio::test]
async fn failed_extract_keeps_regenerating() {
    // 추출은 전부-아니면-전무 — 실패하면 아무 키도 안 쓰므로 f는 계속 재평가(spec §4.2).
    let s = extract_server().await;
    let yaml = EXTRACT.replace("{PATH}", "$.missing");
    let reqs = run_collect(Mode::Closed, &yaml, 300, |_| {}, &s).await;
    let ps = pairs(&reqs);
    assert!(!ps.is_empty(), "{reqs:?}");
    for (a, b) in ps {
        assert_ne!(a["f"], b["f"], "추출 실패면 b도 새 값");
    }
}

#[tokio::test]
async fn condition_only_reference_does_not_break_run() {
    // Review Focus 2: if 조건에서만 참조 — 재평가 대상이 없고 run은 정상 진행.
    let s = ok_server().await;
    let yaml = "version: 1
name: g
variables:
  f: {gen: uuid, refresh: request}
  o: {gen: uuid}
steps:
  - id: \"01HX00000000000000000000F0\"
    name: c
    type: if
    cond: {left: \"{{f}}\", op: exists}
    then:
      - { id: \"01HX0000000000000000000001\", name: a, type: http, request: { method: GET, url: \"{URI}/t?o={{o}}\" } }
";
    let reqs = run_collect(Mode::Closed, yaml, 200, |_| {}, &s).await;
    assert!(!reqs.is_empty(), "then 분기 실행(조건이 반복 시작 값을 봄)");
}

#[tokio::test]
async fn trace_rows_rebuild_state_per_row() {
    // 행마다 상태 재생성 — 행 0은 f를 바인딩(재평가 중지), 행 1은 f 없음(재평가 재개).
    // trace의 seed_vars mark_written이 행을 넘어 새면 행 1도 재평가되지 않는다.
    let server = ok_server().await;
    let yaml = TWO_STEP.replace("{URI}", &server.uri());
    let sc = Scenario::from_yaml(&yaml).unwrap();
    let opts = TraceOptions {
        env: Default::default(),
        max_requests: 10,
        max_wall: Duration::from_secs(5),
        apply_think_time: false,
    };
    let row0: BTreeMap<String, String> = [("f".to_string(), "ROW".to_string())].into();
    let row1: BTreeMap<String, String> = [("x".to_string(), "1".to_string())].into();
    let rt = trace_scenario_rows(&sc, &opts, &[(0, row0), (1, row1)]).await;
    let urls = |i: usize| -> Vec<String> {
        rt.rows[i].trace.steps.iter().map(|st| st.request.as_ref().unwrap().url.clone()).collect()
    };
    // URL 전체가 아니라 f 쿼리 값을 비교한다 — 행 1의 두 요청은 경로(/a·/b)가 달라 URL 비교는 항상 통과(공허).
    let f_of = |u: &str| -> String {
        reqwest::Url::parse(u)
            .unwrap()
            .query_pairs()
            .find(|(k, _)| k == "f")
            .map(|(_, v)| v.into_owned())
            .unwrap()
    };
    assert!(urls(0).iter().all(|u| f_of(u) == "ROW"), "{:?}", urls(0));
    let r1: Vec<String> = urls(1).iter().map(|u| f_of(u)).collect();
    assert_eq!(r1.len(), 2);
    assert!(r1.iter().all(|f| f != "ROW"), "{r1:?}");
    assert_ne!(r1[0], r1[1], "행 1은 요청마다 새 f — 행 0의 죽은 집합이 새면 같아진다");
}

#[tokio::test]
async fn parallel_branch_extract_kills_only_in_that_branch() {
    // 분기 x: x1이 f를 추출 → x2는 추출 값. 분기 y: 같은 반복이어도 재평가 계속(분기 스코프).
    let s = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/x1"))
        .respond_with(ResponseTemplate::new(200).set_body_string("{\"tok\":\"X\"}"))
        .mount(&s)
        .await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&s)
        .await;
    let yaml = "version: 1
name: g
variables:
  f: {gen: uuid, refresh: request}
  o: {gen: uuid}
steps:
  - id: \"01HX00000000000000000000P0\"
    name: par
    type: parallel
    branches:
      - name: x
        steps:
          - id: \"01HX0000000000000000000021\"
            name: x1
            type: http
            request: { method: GET, url: \"{URI}/x1?f={{f}}&o={{o}}\" }
            extract:
              - var: f
                from: body
                path: \"$.tok\"
          - { id: \"01HX0000000000000000000022\", name: x2, type: http, request: { method: GET, url: \"{URI}/x2?f={{f}}&o={{o}}\" } }
      - name: y
        steps:
          - { id: \"01HX0000000000000000000023\", name: y1, type: http, request: { method: GET, url: \"{URI}/y1?f={{f}}&o={{o}}\" } }
          - { id: \"01HX0000000000000000000024\", name: y2, type: http, request: { method: GET, url: \"{URI}/y2?f={{f}}&o={{o}}\" } }
";
    let reqs = run_collect(Mode::Closed, yaml, 400, |_| {}, &s).await;
    let mut by_o: HashMap<String, HashMap<String, String>> = HashMap::new();
    for (p, q) in &reqs {
        by_o.entry(q["o"].clone()).or_default().insert(p.clone(), q["f"].clone());
    }
    let full: Vec<_> = by_o.values().filter(|m| m.len() == 4).collect();
    assert!(!full.is_empty(), "{reqs:?}");
    for m in full {
        assert_eq!(m["/x2"], "X", "x 분기는 추출 이후 추출 값");
        assert_ne!(m["/y1"], "X");
        assert_ne!(m["/y1"], m["/y2"], "y 분기는 계속 재평가");
    }
}

#[tokio::test]
async fn trace_pick_array_differs_per_step() {
    // US1 엔진 측 증거 — test-run 1회에서 스텝 3개의 배열이 서로 다르고 선택 개수 10.
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;
    let mut steps = String::new();
    for i in 1..=3 {
        steps.push_str(&format!(
            "  - id: \"01HX000000000000000000000{i}\"\n    name: s{i}\n    type: http\n    request:\n      method: POST\n      url: \"{}/p\"\n      body:\n        json:\n          flags: \"{{{{flags:json}}}}\"\n",
            server.uri()
        ));
    }
    let yaml = format!(
        "version: 1\nname: t\nvariables:\n  flags: {{gen: pick_array, length: 20, min: 10, max: 10, refresh: request}}\nsteps:\n{steps}"
    );
    let sc = Scenario::from_yaml(&yaml).unwrap();
    let opts = TraceOptions {
        env: Default::default(),
        max_requests: 10,
        max_wall: Duration::from_secs(5),
        apply_think_time: false,
    };
    let t = trace_scenario(&sc, &opts).await;
    let arrays: Vec<Vec<bool>> = t
        .steps
        .iter()
        .map(|st| {
            let body = st.request.as_ref().unwrap().body.as_ref().unwrap();
            let v: serde_json::Value = serde_json::from_str(body).unwrap();
            serde_json::from_value(v["flags"].clone()).unwrap()
        })
        .collect();
    assert_eq!(arrays.len(), 3);
    for a in &arrays {
        assert_eq!(a.len(), 20);
        assert_eq!(a.iter().filter(|b| **b).count(), 10);
    }
    let set: HashSet<_> = arrays.iter().collect();
    assert_eq!(set.len(), 3, "스텝마다 다른 배열");
}

#[tokio::test]
async fn trace_rows_seed_shadows_refresh_var() {
    // 데이터셋 행(seed_vars) 키는 trace에서도 재평가 안 됨.
    let server = ok_server().await;
    let yaml = TWO_STEP.replace("{URI}", &server.uri());
    let sc = Scenario::from_yaml(&yaml).unwrap();
    let opts = TraceOptions {
        env: Default::default(),
        max_requests: 10,
        max_wall: Duration::from_secs(5),
        apply_think_time: false,
    };
    let row: BTreeMap<String, String> = [("f".to_string(), "ROW".to_string())].into();
    let rt = trace_scenario_rows(&sc, &opts, &[(0, row)]).await;
    for st in &rt.rows[0].trace.steps {
        assert!(st.request.as_ref().unwrap().url.contains("f=ROW"), "{}", st.request.as_ref().unwrap().url);
    }
}
```

- [ ] **Step 2: RED 확인**

Run: `cargo nextest run -p handicap-engine --test genvars_per_request; echo exit=$?`
Expected: FAIL — `*_regenerates_*`·`trace_pick_array_differs_per_step`·`failed_extract_keeps_regenerating` 실패(아직 반복당 1회), `dataset_*`·`extract_written_*`·`condition_only_*`·`trace_rows_*`는 이미 PASS할 수 있음(현 동작과 같은 결과 — 배선 후에도 PASS여야 하는 회귀 가드).

- [ ] **Step 3: execute_steps 배선 (`runner.rs`)**

(a) 파일 상단 use에 `use crate::reqgen::{ReqGen, RequestGenPlan};`와 `use rand::RngCore;`(없으면) 추가.

(b) `execute_steps` 시그니처 마지막 파라미터 뒤에 추가:
```rust
    default_think: Option<ThinkTime>,
    // 요청 단위 재평가 상태(spec 2026-10-17-genvar-per-request §4.4). None = refresh 변수 없음.
    req: &mut Option<ReqGen>,
) -> Result<StepFlow> {
```

(c) `Step::Http(http)` arm 첫 줄(ctx 생성 전)에:
```rust
                if let Some(rg) = req.as_mut() {
                    rg.refresh(&http.id, iter_vars);
                }
```
그리고 `let outcome = execute_step(client, http, &ctx).await?;` 다음, `iter_vars.extend(...)` **앞**에:
```rust
                if let Some(rg) = req.as_mut() {
                    rg.mark_written(outcome.extracted.keys());
                }
```

(d) Loop arm·If arm의 재귀 `execute_steps(...)` 호출 마지막 인자 `default_think,` 뒤에 `req,` 추가.

(e) Parallel arm: `let seeds: Vec<u64> = …;` 줄 뒤에 추가:
```rust
                // 분기별 재평가 상태 — 부모 **생성기** rng에서 시드(think rng 시드와 별개, §4.2).
                let branch_reqs: Vec<Option<ReqGen>> = par
                    .branches
                    .iter()
                    .map(|_| req.as_mut().map(ReqGen::fork))
                    .collect();
```
`let futs = par.branches.iter().zip(seeds).map(|(branch, seed)| {`를
```rust
                let futs = par.branches.iter().zip(seeds).zip(branch_reqs).map(
                    |((branch, seed), branch_req)| {
```
로 바꾸고, 그 클로저 안 `let mut branch_rng = StdRng::seed_from_u64(seed);` 뒤에 `let mut branch_req = branch_req;`, 분기 재귀 호출의 마지막 인자 `None,`(default_think) 뒤에 `&mut branch_req,` 추가. 클로저를 닫는 괄호를 한 단계 맞춘다(`}` 뒤 `,` + `);`).

(f) 비재귀 호출부 3곳:

`run_scenario`: `let seq_counters = make_seq_counters(&datasets);` 뒤에
```rust
    // refresh: request 판정 — run당 1회, VU 공유(spec §4.3). None이면 요청 경로는 지금과 같다.
    let reqgen = RequestGenPlan::build(&scenario);
```
spawn 루프의 clone 묶음에 `let reqgen = reqgen.clone();`, `run_vu(...)` 인자 마지막 `connect_timeout,` 뒤에 `reqgen,`. `run_vu` 시그니처 마지막에 `reqgen: Option<Arc<RequestGenPlan>>,`. `run_vu` 본문의 `let mut iter_vars … seed_iter_vars(…);` 다음 줄에
```rust
        let mut req = reqgen.as_ref().map(|p| ReqGen::new(p.clone(), gen_rng.next_u64()));
```
데이터셋 주입 루프의 `for (k, v) in &ds.rows[idx] { … }` 블록 뒤(같은 `Some(idx)` arm 안)에
```rust
                    if let Some(rg) = req.as_mut() {
                        rg.mark_written(ds.rows[idx].keys());
                    }
```
`execute_steps(` 호출 마지막 인자 `scenario.default_think_time,` 뒤에 `&mut req,`.

`run_scenario_vu_curve`/`run_vu_curve`: 동일 패턴 — `RequestGenPlan::build(&scenario)`를 `let seq_counters = make_seq_counters(&datasets);`(vu_curve 함수 안 같은 이름 변수) 뒤에, spawn 클로저 clone·`run_vu_curve` 인자·시그니처(`connect_timeout: Option<Duration>,` 뒤 `reqgen: Option<Arc<RequestGenPlan>>,`)·반복 시드 뒤 `let mut req = …`·데이터셋 주입 `mark_written`·`execute_steps` 마지막 인자 `&mut req,`.

`run_scenario_open_loop`/`run_arrival`: `let seq_counters = make_seq_counters(&datasets);` 뒤에 `let reqgen = RequestGenPlan::build(&scenario);`, arrival spawn clone 묶음에 `let reqgen = reqgen.clone();`, `run_arrival(` 인자 `measure_phases,` 뒤에 `reqgen.as_ref(),`, 시그니처 `measure_phases: bool,` 뒤에 `reqgen: Option<&Arc<RequestGenPlan>>,`, 본문 시드 뒤 `let mut req = reqgen.map(|p| ReqGen::new(p.clone(), gen_rng.next_u64()));`, 데이터셋 주입 `mark_written`, `execute_steps` 마지막 `&mut req,`.

(`run_vu`의 `#[instrument(skip(...))]` 목록에 `reqgen`을 추가하지 않으면 `Arc<RequestGenPlan>`이 `Debug`를 요구한다 — `RequestGenPlan`은 `#[derive(Debug)]`라 컴파일은 되지만 span 필드 노이즈를 피하려고 `skip(scenario, agg, env, datasets, seq_counters, reqgen)`로 추가.)

- [ ] **Step 4: trace 배선 (`trace.rs`)**

(a) use 추가: `use crate::reqgen::{ReqGen, RequestGenPlan};`, `use rand::RngCore;`(이미 `SeedableRng` 등을 쓰므로 그 줄에 합칠 것), `use std::sync::Arc;`(없으면).

(b) `trace_steps` 시그니처 마지막 `default_think: Option<ThinkTime>,` 뒤에 `req: &mut Option<ReqGen>,`. `Step::Http(http)` arm 첫 줄에 `if let Some(rg) = req.as_mut() { rg.refresh(&http.id, iter_vars); }`, `let t = execute_step_traced(...).await;` 다음·`iter_vars.extend` 앞에 `if let Some(rg) = req.as_mut() { rg.mark_written(t.extracted.keys()); }`. Loop·If arm 재귀 호출에 `req,` 추가. Parallel arm: `let mut branch_vars = entry.clone();` 뒤에 `let mut branch_req = req.as_mut().map(ReqGen::fork);`, 재귀 호출 마지막 `None,` 뒤에 `&mut branch_req,`.

(c) `trace_once` 시그니처에 `reqgen: Option<&Arc<RequestGenPlan>>,` 추가(마지막) — 인자가 8개가 되어 clippy `too_many_arguments`(-D warnings)에 걸리므로 `async fn trace_once(` 바로 위에 `#[allow(clippy::too_many_arguments)]`를 단다(이웃 `trace_steps`·`execute_steps`와 같은 이디엄). 본문 `seed_iter_vars` 줄 뒤에 `let mut req = reqgen.map(|p| ReqGen::new(p.clone(), gen_rng.next_u64()));`, seed overlay 루프 `for (k, v) in seed_vars { … }` 뒤에 `if let Some(rg) = req.as_mut() { rg.mark_written(seed_vars.keys()); }`, `trace_steps(` 호출 마지막 `scenario.default_think_time,` 뒤에 `&mut req,`.

(d) `trace_scenario_with_seed`·`trace_scenario_rows`: 함수 앞부분(`let started = Instant::now();` 뒤)에 `let reqgen = RequestGenPlan::build(scenario);`, 각자의 `trace_once(` 호출 마지막 인자로 `reqgen.as_ref(),` 추가.

- [ ] **Step 5: dead_code allow 제거**

`crates/engine/src/reqgen.rs`·`crates/engine/src/executor.rs`의 `#[allow(dead_code)] // Task 3 배선 후 제거` 전부 삭제.
Run: `grep -rn 'Task 3 배선 후 제거' crates/engine/src/; echo exit=$?` → 출력 없음·exit=1(`-r` 필수 — 없으면 디렉터리 에러 exit=2를 '없음'으로 오독한다).

- [ ] **Step 6: GREEN**

```bash
cargo nextest run -p handicap-engine; echo exit=$?
cargo clippy --workspace --all-targets -- -D warnings; echo exit=$?
```
Expected: exit=0 둘 다. `genvars_per_request` 13건 PASS, 기존 `genvars_wiring`·`think_time`·`parallel_node` 등 무변경 PASS.

- [ ] **Step 7: 이빨 실증 (기록만)**

① `execute_steps` Http arm의 `rg.refresh(...)` 블록 삭제 → `closed/curve/open_regenerates_per_request`·`loop_*`·`parallel_*` RED → 원복.
② `run_vu_curve`의 `let mut req = …`를 `let mut req: Option<ReqGen> = None;`로 → `curve_regenerates_per_request`만 RED(다른 Mode는 GREEN) → 원복. 같은 방식으로 `run_arrival` → `open_*`만 RED.
③ `rg.mark_written(outcome.extracted.keys())` 삭제 → `extract_written_key_stops_regeneration` RED → 원복.
④ 데이터셋 주입의 `mark_written` 삭제(run_vu) → `dataset_bound_name_is_not_regenerated` RED → 원복.
⑤ trace Http arm의 `rg.refresh` 삭제 → `trace_pick_array_differs_per_step` RED → 원복.
⑥ Parallel arm의 `branch_reqs`를 분기마다 `None`으로(`.map(|_| None)`) → `parallel_branches_regenerate` RED → 원복.
⑦ trace `trace_once`의 `mark_written(seed_vars.keys())` 삭제 → `trace_rows_seed_shadows_refresh_var`·`trace_rows_rebuild_state_per_row`(행 0) RED → 원복.
⑧ 행 간 상태 누출: `trace_scenario_rows`에서 행 루프 **밖**에 `ReqGen`을 하나 만들어 모든 행의 `trace_once`가 공유하게 바꿈(임시로 `trace_once`에 `&mut Option<ReqGen>`을 넘기는 형태) → 행 0의 죽은 `f`가 행 1로 새어 `trace_rows_rebuild_state_per_row`의 `assert_ne!(r1[0], r1[1])` RED → 원복.

- [ ] **Step 8: 커밋 (FOREGROUND, timeout 600000)**

```bash
cargo fmt --all
git add crates/engine/src/runner.rs crates/engine/src/trace.rs crates/engine/src/reqgen.rs crates/engine/src/executor.rs crates/engine/tests/genvars_per_request.rs
git diff --cached --name-only
git commit -m "feat(engine): refresh: request 요청 직전 재평가 배선 — 부하 3진입점·parallel·test-run"
git log -1 --oneline
```

---

### Task 4: UI 작성기·문구·펼침 편집기 체크박스

**Files:**
- Modify: `ui/src/scenario/yamlDoc.ts:168-192` (`setVariableGen` — refresh 맨 끝 재배치)
- Modify: `ui/src/i18n/ko.ts` (editor 키 5개 + glossary 2개)
- Modify: `ui/src/components/scenario/GenVarEditor.tsx` (체크박스·HelpTip·타입 전환 carry·↻ title)
- Test: `ui/src/scenario/__tests__/yamlDoc.test.ts`, `ui/src/components/scenario/__tests__/GenVarEditor.test.tsx`

**Interfaces:**
- Consumes: Task 1의 `GenSpec.refresh?: "iteration" | "request"`.
- Produces (ko): `ko.editor.genRefreshLabel` · `ko.editor.genRefreshAria(name)` · `ko.editor.genRefreshHelpLabel` · `ko.editor.genRefreshBadge` · `ko.editor.genSampleRefreshTitleRequest` · `ko.editor.pickPreviewTitleRequest` · `ko.glossary.genRefreshIntro` · `ko.glossary.genRefreshPriority` (Task 5가 `genRefreshBadge`·`pickPreviewTitleRequest` 사용)

- [ ] **Step 1: 실패 테스트 (먼저 — tdd-guard)**

`ui/src/scenario/__tests__/yamlDoc.test.ts`의 `describe("applyEdit — setVariableGen (스칼라↔맵)", …)` 블록 안 끝에 추가:

```ts
  it("refresh: request는 항상 마지막 키 — spec에 없던 키(offset)를 뒤에 추가해도(키 순서 이빨)", () => {
    const out = parseScenarioDoc(VALID_YAML);
    if ("error" in out) throw new Error("expected ok");
    // GenVarEditor의 `{...dateSpec, offset}` 커밋 모양: refresh 뒤에 offset이 붙은 객체
    const spec = { gen: "date", format: "unix_ms", refresh: "request", offset: "+1d" } as GenSpec;
    applyEdit(out.doc, { type: "setVariableGen", key: "checkin", spec });
    const round = serializeDoc(out.doc);
    const block = round.slice(round.indexOf("checkin:"));
    expect(block.indexOf("offset:")).toBeGreaterThan(-1);
    expect(block.indexOf("refresh: request")).toBeGreaterThan(block.indexOf("offset:"));
    const reparsed = parseScenarioDoc(round);
    if ("error" in reparsed) throw new Error(reparsed.error);
    expect(reparsed.model.variables.checkin).toEqual({
      gen: "date",
      format: "unix_ms",
      offset: "+1d",
      refresh: "request",
    });
  });

  it("refresh가 undefined면 키를 쓰지 않는다(해제 = 키 삭제)", () => {
    const out = parseScenarioDoc(VALID_YAML);
    if ("error" in out) throw new Error("expected ok");
    applyEdit(out.doc, {
      type: "setVariableGen",
      key: "checkin",
      spec: { gen: "uuid", refresh: "request" },
    });
    expect(serializeDoc(out.doc)).toContain("refresh: request");
    applyEdit(out.doc, {
      type: "setVariableGen",
      key: "checkin",
      spec: { gen: "uuid", refresh: undefined },
    });
    expect(serializeDoc(out.doc)).not.toContain("refresh");
  });
```

`ui/src/components/scenario/__tests__/GenVarEditor.test.tsx` 끝에 추가:

```tsx
describe("GenVarEditor — 요청마다 새로 뽑기 (refresh)", () => {
  const cb = () => screen.getByRole("checkbox", { name: ko.editor.genRefreshAria("checkin") });

  it("생성기에 체크박스, 켜면 refresh: request로 즉시 커밋", () => {
    const { onCommitGen } = setup({ gen: "uuid" });
    expect(cb()).not.toBeChecked();
    fireEvent.click(cb());
    expect(onCommitGen).toHaveBeenCalledTimes(1);
    expect(onCommitGen.mock.calls[0][0]).toStrictEqual({ gen: "uuid", refresh: "request" });
  });

  it("켜진 상태에서 끄면 refresh를 undefined로 커밋(키 삭제)", () => {
    const { onCommitGen } = setup({ gen: "uuid", refresh: "request" });
    expect(cb()).toBeChecked();
    fireEvent.click(cb());
    expect(onCommitGen.mock.calls[0][0]).toStrictEqual({ gen: "uuid", refresh: undefined });
  });

  it("손으로 쓴 refresh: iteration은 꺼진 상태로 보인다 (Review Focus 1)", () => {
    const { onCommitGen } = setup({ gen: "uuid", refresh: "iteration" });
    expect(cb()).not.toBeChecked();
    fireEvent.click(cb());
    expect(onCommitGen.mock.calls[0][0]).toStrictEqual({ gen: "uuid", refresh: "request" });
  });

  it("고정값엔 체크박스 없음", () => {
    setup("hello");
    expect(screen.queryByRole("checkbox", { name: ko.editor.genRefreshAria("checkin") })).toBeNull();
  });

  it("disabled면 체크박스도 disabled", () => {
    setup({ gen: "uuid" }, true);
    expect(cb()).toBeDisabled();
  });

  it("생성기 → 다른 생성기 전환은 refresh를 보존 (Review Focus 5)", () => {
    const { onCommitGen } = setup({ gen: "uuid", refresh: "request" });
    fireEvent.change(screen.getByRole("combobox", { name: ko.editor.genFieldType("checkin") }), {
      target: { value: "random_int" },
    });
    expect(onCommitGen.mock.calls[0][0]).toStrictEqual({
      gen: "random_int",
      min: 1,
      max: 100,
      refresh: "request",
    });
  });

  it("refresh 없는 생성기 전환은 refresh 키를 만들지 않는다(byte-identical)", () => {
    const { onCommitGen } = setup({ gen: "uuid" });
    fireEvent.change(screen.getByRole("combobox", { name: ko.editor.genFieldType("checkin") }), {
      target: { value: "random_string" },
    });
    expect(onCommitGen.mock.calls[0][0]).toStrictEqual({ gen: "random_string", length: 8 });
  });

  it("선택 배열로 전환 시 팝업 initial에 refresh가 실린다", () => {
    const onOpenPickArray = vi.fn();
    render(
      <GenVarEditor
        name="checkin"
        value={{ gen: "uuid", refresh: "request" }}
        disabled={false}
        sampleTick={0}
        onSampleRefresh={vi.fn()}
        onCommitGen={vi.fn()}
        onCommitStatic={vi.fn()}
        onOpenPickArray={onOpenPickArray}
      />,
    );
    fireEvent.change(screen.getByRole("combobox", { name: ko.editor.genFieldType("checkin") }), {
      target: { value: "pick_array" },
    });
    expect(onOpenPickArray).toHaveBeenCalledWith(
      { gen: "pick_array", length: 10, min: 1, max: 3, refresh: "request" },
      "switch",
    );
  });

  it("↻ title은 refresh에 따라 요청마다/반복마다", () => {
    const { unmount } = render(
      <GenVarEditor
        name="a"
        value={{ gen: "uuid", refresh: "request" }}
        disabled={false}
        sampleTick={0}
        onSampleRefresh={vi.fn()}
        onCommitGen={vi.fn()}
        onCommitStatic={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: ko.editor.genSampleRefreshAria("a") })).toHaveAttribute(
      "title",
      ko.editor.genSampleRefreshTitleRequest,
    );
    unmount();
    setup({ gen: "uuid" });
    expect(
      screen.getByRole("button", { name: ko.editor.genSampleRefreshAria("checkin") }),
    ).toHaveAttribute("title", ko.editor.genSampleRefreshTitle);
  });

  it("체크박스 접근명은 가시 라벨을 포함한다 (WCAG 2.5.3 — 리터럴로 고정, 카탈로그 자기참조 회피)", () => {
    setup({ gen: "uuid" });
    expect(screen.getByRole("checkbox", { name: "checkin 요청마다 새로 뽑기" })).toBeInTheDocument();
    expect(screen.getByText("요청마다 새로 뽑기")).toBeInTheDocument();
  });
});
```

(`toStrictEqual`는 `undefined` 값 키와 키 부재를 구별한다 — "키를 만들지 않는다" 단언에 이빨이 생기게 의도적으로 사용.)

- [ ] **Step 2: RED 확인**

Run: `cd ui && pnpm test GenVarEditor yamlDoc; echo exit=$?`
Expected: FAIL — `ko.editor.genRefreshAria` 미정의 등.

- [ ] **Step 3: 구현**

`ui/src/i18n/ko.ts` — `glossary` 객체에 추가(기존 마지막 항목 뒤):
```ts
    genRefreshIntro:
      "켜면 이 변수를 쓰는 요청이 나갈 때마다 새 값을 뽑습니다. 끄면 반복(시나리오 1회 실행) 동안 같은 값을 씁니다.",
    genRefreshPriority: "같은 이름을 데이터셋이나 추출 값이 채우면 그 값이 우선합니다.",
```
`editor`의 `genSampleRefreshTitle:` 줄 바로 뒤에 추가:
```ts
    genSampleRefreshTitleRequest: "다시 뽑기 — 실행 시 요청마다 새 값이 생성됩니다",
    // ── 요청마다 새로 뽑기 (genvar-per-request) ──
    genRefreshLabel: "요청마다 새로 뽑기",
    genRefreshAria: (name: string) => `${name} 요청마다 새로 뽑기`,
    genRefreshHelpLabel: "요청마다 새로 뽑기 도움말",
    genRefreshBadge: "요청마다",
```
`pickPreviewTitle:` 줄 바로 뒤에:
```ts
    pickPreviewTitleRequest: "미리보기 (요청마다 새로 뽑힘)",
```

`ui/src/scenario/yamlDoc.ts` `setVariableGen` case의 `const clean = …` 를 교체:
```ts
      // refresh는 항상 맨 끝 키(엔진 방출 순서와 일치, spec 2026-10-17-genvar-per-request §5) —
      // `{...spec, offset}`처럼 spec에 없던 키를 더하는 편집은 그 키를 refresh 뒤에 붙인다.
      const { refresh, ...rest } = edit.spec;
      const ordered = refresh === undefined ? rest : { ...rest, refresh };
      const clean = Object.fromEntries(Object.entries(ordered).filter(([, v]) => v !== undefined));
```

`ui/src/components/scenario/GenVarEditor.tsx`:

(a) import에 `import { HelpTip } from "../HelpTip";` 추가.

(b) `changeKind`를 교체:
```tsx
  const changeKind = (k: VarKind) => {
    if (k === kind) return;
    if (k === "static") return onCommitStatic("");
    // 생성기 → 생성기 전환은 refresh를 보존(spec §6.2) — 없으면 키를 만들지 않는다(byte-identical).
    const carry: Pick<GenSpec, "refresh"> =
      spec?.refresh !== undefined ? { refresh: spec.refresh } : {};
    // pick_array는 즉시 커밋하지 않고 팝업으로(적용 시 커밋·취소 시 원래 타입 유지 — spec §6.1).
    // 아래 삼항 체인은 미지 kind를 random_string으로 떨어뜨리므로 이 분기가 반드시 먼저여야 한다.
    if (k === "pick_array") {
      onOpenPickArray?.({ ...PICK_ARRAY_DEFAULT, ...carry }, "switch");
      return;
    }
    onCommitGen(
      k === "date"
        ? { gen: "date", format: "%Y-%m-%d", tz: "Asia/Seoul", ...carry }
        : k === "random_int"
          ? { gen: "random_int", min: 1, max: 100, ...carry }
          : k === "uuid"
            ? { gen: "uuid", ...carry }
            : { gen: "random_string", length: 8, ...carry },
    );
  };
```

(c) JSX: `{spec?.gen === "pick_array" && ( … 편집… 버튼 … )}` 블록 **뒤**, `{previewSpec && (` **앞**에 추가:
```tsx
      {spec && (
        <div className="flex items-center gap-1 text-xs text-slate-600">
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              aria-label={ko.editor.genRefreshAria(name)}
              checked={spec.refresh === "request"}
              disabled={disabled}
              onChange={(e) =>
                onCommitGen({ ...spec, refresh: e.target.checked ? "request" : undefined })
              }
            />
            <span>{ko.editor.genRefreshLabel}</span>
          </label>
          {/* HelpTip은 label 밖 형제 — 체크박스 accname 오염 방지(U3). 패널 안이라 Modal ESC 함정 무관. */}
          <HelpTip label={ko.editor.genRefreshHelpLabel}>
            <span className="block">{ko.glossary.genRefreshIntro}</span>
            <span className="mt-1 block">{ko.glossary.genRefreshPriority}</span>
          </HelpTip>
        </div>
      )}
```

(d) ↻ 버튼 `title={ko.editor.genSampleRefreshTitle}`을
```tsx
            title={
              spec?.refresh === "request"
                ? ko.editor.genSampleRefreshTitleRequest
                : ko.editor.genSampleRefreshTitle
            }
```

- [ ] **Step 4: GREEN + 전체 UI 게이트**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/pick-array-per-request/ui
pnpm test GenVarEditor yamlDoc; echo exit=$?
pnpm lint; echo exit=$?
pnpm test; echo exit=$?
pnpm build; echo exit=$?
```
Expected: 전부 exit=0(파이프 없이 — 종료코드 마스킹 금지).

- [ ] **Step 5: 이빨 실증 (기록만)**

① yamlDoc의 재배치를 `const clean = Object.fromEntries(Object.entries(edit.spec).filter(...))`(원래 코드)로 되돌림 → "refresh: request는 항상 마지막 키" RED → 원복.
② `changeKind`의 `...carry` 4곳 중 `random_int` 하나 삭제 → "생성기 → 다른 생성기 전환" RED → 원복.
③ 체크박스 onChange를 `refresh: e.target.checked ? "request" : "iteration"`으로 → "켜진 상태에서 끄면" RED(`toStrictEqual`) → 원복.

- [ ] **Step 6: 커밋**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/pick-array-per-request
git add ui/src/scenario/yamlDoc.ts ui/src/i18n/ko.ts ui/src/components/scenario/GenVarEditor.tsx ui/src/scenario/__tests__/yamlDoc.test.ts ui/src/components/scenario/__tests__/GenVarEditor.test.tsx
git diff --cached --name-only
git commit -m "feat(ui): 생성 변수 요청마다 새로 뽑기 체크박스·refresh 끝 키 작성"
git log -1 --oneline
```

---

### Task 5: UI 접힘 행 배지 + 선택 배열 팝업 refresh 보존

**Files:**
- Modify: `ui/src/components/scenario/VariablesPanel.tsx:50-54` (`genRowTitle`) · `:339-350`(접힘 생성기 행 배지)
- Modify: `ui/src/components/scenario/PickArrayDialog.tsx:181-189`(적용 spec carry) · 미리보기 제목(`pickPreviewTitle` 사용처)
- Test: `ui/src/components/scenario/__tests__/VariablesPanel.test.tsx`, `ui/src/components/scenario/__tests__/PickArrayDialog.test.tsx`

**Interfaces:**
- Consumes: Task 4의 `ko.editor.genRefreshBadge`·`ko.editor.pickPreviewTitleRequest`·`ko.editor.genRefreshAria`, Task 1의 `refresh` 필드.

- [ ] **Step 1: 실패 테스트 (먼저)**

`ui/src/components/scenario/__tests__/PickArrayDialog.test.tsx`의 `describe("PickArrayDialog", …)` 안 끝에:
```tsx
  it("적용은 initial.refresh를 보존한다 — 길이만 바꿔도 사라지지 않음 (spec §6.3)", async () => {
    const user = userEvent.setup();
    const { onApply, dialog, apply } = setup({
      gen: "pick_array",
      length: 5,
      min: 1,
      max: 2,
      refresh: "request",
    });
    const len = within(dialog).getByRole("spinbutton", { name: ko.editor.pickFieldLength });
    await user.clear(len);
    await user.type(len, "6");
    await user.click(apply);
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][0]).toStrictEqual({
      gen: "pick_array",
      length: 6,
      min: 1,
      max: 2,
      refresh: "request",
    });
  });

  it("refresh 없는 initial은 적용 결과에 refresh 키가 없다", async () => {
    const user = userEvent.setup();
    const { onApply, apply } = setup({ gen: "pick_array", length: 5, min: 1, max: 2 });
    await user.click(apply);
    expect(onApply.mock.calls[0][0]).toStrictEqual({ gen: "pick_array", length: 5, min: 1, max: 2 });
  });

  it("미리보기 제목은 refresh에 따라 요청마다/반복마다", () => {
    const { unmount } = render(
      <PickArrayDialog
        name="flags"
        initial={{ gen: "pick_array", length: 5, min: 1, max: 2, refresh: "request" }}
        onApply={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText(ko.editor.pickPreviewTitleRequest)).toBeInTheDocument();
    unmount();
    setup({ gen: "pick_array", length: 5, min: 1, max: 2 });
    expect(screen.getByText(ko.editor.pickPreviewTitle)).toBeInTheDocument();
  });
```
(길이 5→6: 직전 positions가 전체 범위라 새 `1-6`(=전체) → `positions` 키 생략이 기대값. 길이 커밋은 적용 버튼 mousedown의 blur로 일어난다 — 기존 테스트 `무효 길이를 고친 직후 적용 첫 클릭이 동작`과 같은 경로.)

`ui/src/components/scenario/__tests__/VariablesPanel.test.tsx`의 `describe("VariablesPanel — pick_array", …)` 블록 **뒤**에 새 describe:
```tsx
describe("VariablesPanel — 요청마다 새로 뽑기", () => {
  beforeEach(() => {
    reset();
    useScenarioEditor.getState().resetEmpty();
  });

  it("접힘 행: refresh: request면 `요청마다` 배지·행 title 접미, 없으면 둘 다 없음", () => {
    const s = useScenarioEditor.getState();
    s.setVariableGen("f", { gen: "uuid", refresh: "request" });
    s.setVariableGen("o", { gen: "uuid" });
    render(<VariablesPanel />);
    const badges = screen.getAllByText(ko.editor.genRefreshBadge);
    expect(badges).toHaveLength(1);
    expect(badges[0].closest("[title]")).toHaveAttribute(
      "title",
      `${ko.editor.genTypeUuid} · ${ko.editor.genRefreshBadge}`,
    );
  });

  it("펼침 → 체크 → YAML에 refresh: request 마지막 키·배지 등장, 해제 → 키 삭제", async () => {
    const user = userEvent.setup();
    useScenarioEditor.getState().setVariableGen("q", { gen: "random_int", min: 1, max: 9 });
    render(<VariablesPanel />);
    await user.click(screen.getByRole("button", { name: ko.editor.varExpandAria("q") }));
    await user.click(screen.getByRole("checkbox", { name: ko.editor.genRefreshAria("q") }));
    const yaml = useScenarioEditor.getState().yamlText;
    const block = yaml.slice(yaml.indexOf("q:"));
    expect(block.indexOf("refresh: request")).toBeGreaterThan(block.indexOf("max:"));
    expect(useScenarioEditor.getState().model!.variables.q).toEqual({
      gen: "random_int",
      min: 1,
      max: 9,
      refresh: "request",
    });
    // 접어서 배지 확인(펼친 동안엔 접힘 행이 렌더되지 않는다)
    await user.click(screen.getByRole("button", { name: ko.editor.varExpandAria("q") }));
    expect(screen.getByText(ko.editor.genRefreshBadge)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: ko.editor.varExpandAria("q") }));
    await user.click(screen.getByRole("checkbox", { name: ko.editor.genRefreshAria("q") }));
    expect(useScenarioEditor.getState().yamlText).not.toContain("refresh");
  });

  it("refresh: request 선택 배열을 팝업으로 편집해도 refresh가 남는다 (Review Focus 5)", async () => {
    const user = userEvent.setup();
    useScenarioEditor
      .getState()
      .setVariableGen("flags", { gen: "pick_array", length: 30, min: 2, max: 3, refresh: "request" });
    render(<VariablesPanel />);
    await user.click(screen.getByRole("button", { name: ko.editor.pickEditAria("flags") }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(ko.editor.pickPreviewTitleRequest)).toBeInTheDocument();
    const pos = within(dialog).getByRole("textbox", { name: ko.editor.pickSectionPositions });
    await user.clear(pos);
    await user.type(pos, "1-5");
    await user.click(within(dialog).getByRole("button", { name: ko.editor.pickApply }));
    expect(useScenarioEditor.getState().model!.variables.flags).toEqual({
      gen: "pick_array",
      length: 30,
      min: 2,
      max: 3,
      positions: "1-5",
      refresh: "request",
    });
  });
});
```

- [ ] **Step 2: RED 확인**

Run: `cd ui && pnpm test VariablesPanel PickArrayDialog; echo exit=$?`
Expected: FAIL — 배지 없음·팝업 적용 결과에 refresh 없음·미리보기 제목 미분기.

- [ ] **Step 3: 구현**

`ui/src/components/scenario/VariablesPanel.tsx`:

(a) `genRowTitle` 교체:
```tsx
function genRowTitle(spec: GenSpec): string {
  const params = genParamsSummary(spec);
  const base = params === "" ? genTypeLabel(spec) : `${genTypeLabel(spec)} · ${params}`;
  return spec.refresh === "request" ? `${base} · ${ko.editor.genRefreshBadge}` : base;
}
```

(b) 접힘 생성기 행의 타입 배지 `<span className="shrink-0 rounded bg-indigo-50 px-1.5 text-xs text-indigo-600">{genTypeLabel(row.value)}</span>` 바로 뒤에:
```tsx
                      {row.value.refresh === "request" && (
                        <span className="shrink-0 rounded bg-sky-50 px-1.5 text-xs text-sky-700">
                          {ko.editor.genRefreshBadge}
                        </span>
                      )}
```

`ui/src/components/scenario/PickArrayDialog.tsx`:

(a) 적용 spec 리터럴(`gen: "pick_array",`로 시작하는 객체, `...(restRes.value === false ? {} : { rest: restRes.value }),` 줄)의 마지막 spread 뒤에:
```tsx
          // 팝업은 refresh를 편집하지 않는다 — initial 값을 그대로 싣는다(없으면 키 없음, spec §6.3).
          ...(initial.refresh !== undefined ? { refresh: initial.refresh } : {}),
```

(b) 미리보기 제목 `{ko.editor.pickPreviewTitle}`을
```tsx
{initial.refresh === "request" ? ko.editor.pickPreviewTitleRequest : ko.editor.pickPreviewTitle}
```

- [ ] **Step 4: GREEN + 전체 UI 게이트**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/pick-array-per-request/ui
pnpm test VariablesPanel PickArrayDialog; echo exit=$?
pnpm lint; echo exit=$?
pnpm test; echo exit=$?
pnpm build; echo exit=$?
```
Expected: 전부 exit=0.

- [ ] **Step 5: 이빨 실증 (기록만)**

① PickArrayDialog의 `...(initial.refresh …)` 줄 삭제 → "적용은 initial.refresh를 보존" + 패널 "팝업으로 편집해도 refresh가 남는다" RED → 원복.
② 배지 조건을 `row.value.gen === "uuid"`로 바꿈 → 배지 1개 단언 RED(o도 uuid) → 원복.

- [ ] **Step 6: 커밋**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/pick-array-per-request
git add ui/src/components/scenario/VariablesPanel.tsx ui/src/components/scenario/PickArrayDialog.tsx ui/src/components/scenario/__tests__/VariablesPanel.test.tsx ui/src/components/scenario/__tests__/PickArrayDialog.test.tsx
git diff --cached --name-only
git commit -m "feat(ui): 접힘 행 요청마다 배지·선택 배열 팝업 refresh 보존"
git log -1 --oneline
```

---

## 구현 후 (plan 밖 — 슬라이스 파이프라인 4~6단계)

- **최종 리뷰**: `handicap-reviewer`(whole-branch, BASE = 이 plan 커밋). `finish-slice §0` grep — diff가 `executor.rs`·`trace.rs`·`genvars.rs`·`runs.rs`를 건드리므로 `security-reviewer` 트리거 예상(grep이 지배).
- **라이브 검증 (`/live-verify`, 필수 — 엔진 경로)**, 에디터 두 진입 화면 모두([[live-verify-all-mount-paths]]):
  - US1: `/scenarios/new`·`/scenarios/{id}` 각각 — 선택 배열(`length 20, min=max=10`) 체크박스 켬 → 3스텝 test-run trace 바디 배열 3개 상이·각 선택 10개.
  - US2: 로깅 echo responder(번들 `responder.py`는 요청을 안 찍음 — 루트 CLAUDE.md) + loop `repeat: 5` run → 회차마다 배열·random_int(넓은 범위)·uuid·random_string 상이.
  - US3: 같은 run 와이어 — refresh 없는 uuid는 반복 내 동일·반복 간 상이 / 켠 배열은 요청마다 상이. refresh 없는 변수 파라미터 GUI 편집 → 저장 → `GET /api/scenarios/{id}`의 `yaml`에 `refresh` 없음.
  - US4: `date`(`format: unix_ms`, `refresh: request`) + 스텝 think time 200ms → 반복 안에서 ~200ms씩 증가 / 끈 쪽은 반복 안 동일.
  - US5: YAML 모달에서 `refresh: request` 추가 → 체크박스·배지 표시, 삭제 → 둘 다 사라짐 · 정적 변수 자리에 `{refresh: request}` → 저장 400.
  - 210px 기본 폭 패널에서 선택 배열 행(타입 배지 + `요청마다` + 요약 + `편집`)이 한 줄을 넘지 않는지 `getBoundingClientRect`로 실측(spec §6.1).
