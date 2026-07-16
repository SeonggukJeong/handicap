# 에디터 데이터셋 test-run (§A12) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

<!-- REVIEW-GATE: APPROVED -->
<!-- spec-plan-reviewer: spec clean APPROVE (2026-07-16, 3라운드) · plan clean APPROVE (2026-07-16, 2라운드 — R1 must-fix 3건[TestRunSection.test.tsx whole-module mock 확장·R18 0-leaf 테스트·clippy unused import]+nit 3건 반영 후). 사용자 spec 승인(2026-07-16, 핵심 5결정). -->

**Goal:** test-run 요청에 optional `dataset` 구성을 추가해 ① 특정 1행 골라 단발 확인(single_row), ② 1 VU 순차 N행 행별 ✓/✗ 검증(sequential)을 실제 run과 같은 주입 세만틱으로 제공한다.

**Architecture:** 엔진 `trace.rs`에 1패스 코어(`trace_once`)를 추출하고 시드 주입 단발(`trace_scenario_with_seed`)·행 루프(`trace_scenario_rows` — jar 1회 빌드·전역 예산 공유)를 얹는다. 컨트롤러 `test_runs.rs`가 검증(R9 10케이스)·자동 매핑 실체화(R3)·R18 clamp·행 로드(바인딩별 range fetch 1–2회)·`apply_mappings` 재사용을 소유하고, single_row는 기존 `ScenarioTrace` 그대로, sequential은 엔진 `RowsTrace` 직렬화(`SequentialTrace` 와이어)를 반환한다. UI는 Zod/client/hook additive 확장 + TestRunSection 접이식 데이터셋 섹션 + `DatasetRowsPreview` 선택 prop + 순차 결과 행 목록(`SequentialRunPanel`, 기존 스텝 렌더 재사용)이다. **proto·worker·migration·store 스키마 0-diff** (spec §5).

**Tech Stack:** Rust(axum 0.8 / serde / wiremock) + React/TS(Zod, React Query v5, RTL+vitest).

**Spec:** `docs/superpowers/specs/2026-07-16-editor-dataset-testrun-design.md` — R-id는 전부 그 spec §2. ADR: `docs/adr/0047-editor-test-run-dataset-binding.md`.

## Global Constraints

- **R1 byte-identical**: `dataset` 필드 없는 test-run은 거동·응답 무변경 — `trace_scenario` 시그니처 무변경, 기존 test_runs/trace 테스트 **무수정** green. run 경로(`binding.rs` 기존 함수 시그니처·`runs.rs` 검증) 무변경 — `apply_mappings`는 재사용만, `collect_var_names` 시그니처 무변경.
- **모든 test-run 검증 실패는 422 `ApiError::Unprocessable` + 한국어 메시지** (400 아님 — 이 엔드포인트 컨벤션, `crates/controller/CLAUDE.md`).
- **와이어 표기**: `row_index`/`start_row`는 **0-based**(엔진·서버·Zod 전부). **UI 표시(입력·행 목록·미리보기)는 1-based** — 변환은 UI 컴포넌트 경계에서만(`DatasetRowsPreview`의 기존 1-based 관행과 일치). 응답 `row_index = start_row + i`(첫 바인딩 앵커, wrap 없음 — R17).
- **UI 신규 한국어 문구(aria-label 포함)는 전부 `ko.ts` 경유** (ADR-0035). 단 기존 하드코딩 문자열을 *옮기기만* 하는 곳(TraceStepList 추출)은 byte-identical 유지 — 스코프 확장 금지.
- **UI 응답 Zod는 plain 타입**: `RowsTrace` 직렬화는 전 필드 항상 emit(Option/skip 없음) → `.nullable()`/`.optional()`/`.default()` 전부 불요 (R16).
- UI 게이트: `cd ui && pnpm lint && pnpm test && pnpm build` (lint `--max-warnings=0`, build `tsc -b`가 최종). 단일 파일 반복은 `pnpm test <name>` (`--` 붙이면 전체 스위트).
- cargo 게이트: pre-commit이 전체 워크스페이스(fmt/build/clippy -D warnings/nextest/doctest) — cargo-영향 커밋은 수 분 정상. plan 인라인 Rust는 clippy-clean(2-arm `match … _ => {}` 금지).
- 커밋은 **단일 blocking 호출**(`run_in_background: false`, timeout 600000ms), `git commit … | tail` 파이프 금지, `--no-verify` 금지.
- 리포트 파일(`task-N-report.md` 등)은 `.superpowers/sdd/` 아래에만 — worktree 루트에 쓰지 말고 `git add` 금지.
- tdd-guard: src 편집 전에 **테스트 파일 편집을 먼저** 해 pending RED diff를 만들 것(각 task Step 1이 테스트).

---

### Task 1: 엔진 — `trace_once` 추출 + `trace_scenario_with_seed` (R1, R4-시드)

**Files:**
- Modify: `crates/engine/tests/trace_scenario.rs` (테스트 append)
- Modify: `crates/engine/src/trace.rs` (`TraceState.iter_id` + `trace_once` + `trace_scenario_with_seed`)
- Modify: `crates/engine/src/lib.rs` (`pub use trace::` 한 줄에 `trace_scenario_with_seed` 추가)

**Interfaces:**
- Consumes: 기존 `trace_scenario`/`trace_steps`/`TraceState`/`VuClient::new`(`trace.rs:105-160`).
- Produces: `pub async fn trace_scenario_with_seed(scenario: &Scenario, opts: &TraceOptions, seed_vars: &BTreeMap<String, String>) -> ScenarioTrace` — Task 3의 single_row 경로가 호출. 내부 `async fn trace_once(client: &VuClient, scenario: &Scenario, opts: &TraceOptions, seed_vars: &BTreeMap<String, String>, iter_id: u32, deadline: Instant, state: &mut TraceState) -> ScenarioTrace` — Task 2의 행 루프가 재사용. `TraceState`는 `{ steps, requests, truncated, iter_id: u32 }`(spec §4.1 "분해 형태 plan 확정": 예산 `requests`는 호출 간 이월, `steps`/`truncated`/`iter_id`는 `trace_once` 진입 시 리셋 — 별도 budget 구조체 대신 기존 struct에 필드 1개 추가로 재귀 시그니처 무변경).

**설계 노트(스펙 대비 확정 2건):** ① spec §4.1의 가칭 `trace_once(..., budget)`에서 budget은 `state.requests`로 흡수(위). ② `trace_scenario_with_seed`는 spec §4.1에 없는 **추가 public API** — single_row가 `trace_scenario_rows`(1행)를 경유하면 극단 케이스(클라이언트 빌드 실패)에서 `ScenarioTrace.error` setup-실패 계약(R7 "기존 형태 그대로")을 잃는다(RowsTrace엔 error 채널이 없음, R8 와이어 고정). 기존 `trace_scenario`는 이것의 seed-없는 위임이 되어 시그니처·거동 무변경(R1).

- [ ] **Step 1: 실패하는 테스트 작성** — `crates/engine/tests/trace_scenario.rs` 끝에 append. 파일 상단 import를 `use handicap_engine::{Scenario, StepKind, TraceOptions, trace_scenario, trace_scenario_with_seed};`로 확장하고 아래 테스트는 **비수식(unqualified) 호출**로 작성(임포트만 하고 수식 호출하면 unused import — clippy 게이트):

```rust
#[tokio::test]
async fn seeded_trace_overrides_scenario_variables() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/u/dataset-user"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;

    let yaml = format!(
        r#"
version: 1
name: seeded
variables:
  username: scenario-user
  keep: base
steps:
  - type: http
    id: 01HX0000000000000000000010
    name: a
    request: {{ method: GET, url: "{base}/u/{{{{username}}}}" }}
"#,
        base = server.uri()
    );
    let scenario = Scenario::from_yaml(&yaml).unwrap();
    let mut seed = BTreeMap::new();
    seed.insert("username".to_string(), "dataset-user".to_string());
    let trace = trace_scenario_with_seed(&scenario, &opts(BTreeMap::new(), 50), &seed).await;
    assert!(trace.ok, "{trace:?}");
    // 시드가 동명 시나리오 변수를 이긴다 (run_vu의 variables.clone() 후 insert 미러 — R4)
    let url = &trace.steps[0].request.as_ref().unwrap().url;
    assert!(url.ends_with("/u/dataset-user"), "{url}");
    // 시드 안 된 변수는 유지, final_vars엔 시드 반영
    assert_eq!(trace.final_vars.get("keep").map(String::as_str), Some("base"));
    assert_eq!(
        trace.final_vars.get("username").map(String::as_str),
        Some("dataset-user")
    );
}

#[tokio::test]
async fn seeded_trace_with_empty_seed_matches_plain_trace_shape() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/a"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;
    let yaml = format!(
        r#"
version: 1
name: plain
steps:
  - type: http
    id: 01HX0000000000000000000010
    name: a
    request: {{ method: GET, url: "{base}/a" }}
"#,
        base = server.uri()
    );
    let scenario = Scenario::from_yaml(&yaml).unwrap();
    let plain = trace_scenario(&scenario, &opts(BTreeMap::new(), 50)).await;
    let seeded =
        trace_scenario_with_seed(&scenario, &opts(BTreeMap::new(), 50), &BTreeMap::new()).await;
    // total_ms(월클록)만 다를 수 있다 — 구조 필드는 동일 (R1 위임 보존)
    assert_eq!(plain.ok, seeded.ok);
    assert_eq!(plain.steps.len(), seeded.steps.len());
    assert_eq!(plain.final_vars, seeded.final_vars);
    assert_eq!(plain.truncated, seeded.truncated);
}
```

- [ ] **Step 2: RED 확인** — `cargo test -p handicap-engine --test trace_scenario` → `trace_scenario_with_seed` 미존재 컴파일 에러.

- [ ] **Step 3: 구현** — `crates/engine/src/trace.rs`:

`TraceState`에 필드 추가:

```rust
struct TraceState {
    steps: Vec<StepTrace>,
    requests: u32,
    truncated: bool,
    /// 이 패스의 `${iter_id}` 값 — 단발/시드 = 0, sequential = 반복 순번 (R4).
    iter_id: u32,
}
```

`trace_steps`의 두 `TemplateContext` 리터럴(Http arm `trace.rs:224-230`, If arm `:286-292`)에서 `iter_id: 0` → `iter_id: state.iter_id`.

`trace_scenario` 본문을 위임 + 신규 2 함수로 교체:

```rust
/// Run `scenario` once (1 VU, single pass) and capture a per-request trace.
/// Never returns `Err` — setup failures land in `ScenarioTrace.error`, per-step
/// failures in each `StepTrace.error`.
pub async fn trace_scenario(scenario: &Scenario, opts: &TraceOptions) -> ScenarioTrace {
    trace_scenario_with_seed(scenario, opts, &BTreeMap::new()).await
}

/// `trace_scenario` + 데이터셋 시드 1행 주입 (test-run single_row, ADR-0047).
/// 시드는 scenario.variables 위에 덮인다(충돌 시 데이터셋 우선 — run_vu의
/// "variables.clone() 후 바인딩 insert" 순서 미러, runner.rs `run_vu` — R4).
/// 응답 형태는 기존 `ScenarioTrace` 그대로(R7) — setup 실패는 `error` 필드.
pub async fn trace_scenario_with_seed(
    scenario: &Scenario,
    opts: &TraceOptions,
    seed_vars: &BTreeMap<String, String>,
) -> ScenarioTrace {
    let started = Instant::now();
    let deadline = started + opts.max_wall;
    let client = match VuClient::new(scenario.cookie_jar) {
        Ok(c) => c,
        Err(e) => {
            return ScenarioTrace {
                ok: false,
                total_ms: 0,
                steps: vec![],
                final_vars: BTreeMap::new(),
                truncated: false,
                error: Some(format!("http client build: {e}")),
            };
        }
    };
    let mut state = TraceState {
        steps: Vec::new(),
        requests: 0,
        truncated: false,
        iter_id: 0,
    };
    trace_once(&client, scenario, opts, seed_vars, 0, deadline, &mut state).await
}

/// 클라이언트 하나로 시나리오를 1패스 실행하는 내부 코어. `state.requests`
/// (공유 요청 예산)는 호출 간 이월되고 `steps`/`truncated`/`iter_id`는 진입 시
/// 리셋된다 — `trace_scenario_rows`(Task 2)가 행 루프에서 재사용 (R6).
async fn trace_once(
    client: &VuClient,
    scenario: &Scenario,
    opts: &TraceOptions,
    seed_vars: &BTreeMap<String, String>,
    iter_id: u32,
    deadline: Instant,
    state: &mut TraceState,
) -> ScenarioTrace {
    let started = Instant::now();
    state.steps = Vec::new();
    state.truncated = false;
    state.iter_id = iter_id;
    let mut iter_vars: BTreeMap<String, String> = scenario.variables.clone();
    for (k, v) in seed_vars {
        iter_vars.insert(k.clone(), v.clone());
    }
    Box::pin(trace_steps(
        client,
        &scenario.steps,
        &mut iter_vars,
        &opts.env,
        None,
        opts,
        deadline,
        state,
        scenario.default_think_time,
    ))
    .await;
    let ok = state.steps.iter().all(|s| s.error.is_none());
    ScenarioTrace {
        ok,
        total_ms: started.elapsed().as_millis().min(u64::MAX as u128) as u64,
        steps: std::mem::take(&mut state.steps),
        final_vars: iter_vars,
        truncated: state.truncated,
        error: None,
    }
}
```

(`total_ms` 측정 시점이 클라이언트 빌드 *뒤*로 수 µs 이동 — 월클록 값이라 거동 등가, 기존 테스트는 정확값을 단언하지 않음.)

`crates/engine/src/lib.rs:34-37`의 `pub use trace::{…}`에 `trace_scenario_with_seed` 추가.

- [ ] **Step 4: GREEN 확인** — `cargo test -p handicap-engine --test trace_scenario` 전부 PASS(기존 테스트 무수정 포함). 이어 `cargo test -p handicap-engine` 전체 PASS(R1 — 다른 trace 소비 테스트 무회귀).

- [ ] **Step 5: Commit** — `git add crates/engine/src/trace.rs crates/engine/src/lib.rs crates/engine/tests/trace_scenario.rs` 후 `git commit -m "feat(engine): trace_once 코어 추출 + trace_scenario_with_seed (test-run 데이터셋 시드, R1/R4)"`.

---

### Task 2: 엔진 — `trace_scenario_rows` 행 루프 (R4, R5, R6, R8 엔진 절반, R10)

**Files:**
- Create: `crates/engine/tests/trace_rows.rs`
- Modify: `crates/engine/src/trace.rs` (`RowTrace`/`RowsTrace`/`trace_scenario_rows` + 인라인 serde round-trip 테스트)
- Modify: `crates/engine/src/lib.rs` (`pub use trace::`에 `RowTrace, RowsTrace, trace_scenario_rows` 추가)

**Interfaces:**
- Consumes: Task 1의 `trace_once`/`TraceState`.
- Produces (Task 3이 호출·직렬화):

```rust
pub struct RowTrace { pub row_index: u64, pub trace: ScenarioTrace }
pub struct RowsTrace { pub ok: bool, pub truncated: bool, pub total_ms: u64, pub rows: Vec<RowTrace> }
pub async fn trace_scenario_rows(
    scenario: &Scenario,
    opts: &TraceOptions,
    seeded_rows: &[(u64 /* row_index */, BTreeMap<String, String>)],
) -> RowsTrace
```

엔진의 `truncated` = "시드된 행을 전부 못 돌았거나(미실행 행 존재) 마지막 실행 행 mid-cut". **R6의 사용자-요청-구간 대비 clamp 반영은 컨트롤러(Task 3) 몫** — 엔진은 seeded_rows 기준만 안다.

- [ ] **Step 1: 실패하는 테스트 작성** — `crates/engine/tests/trace_rows.rs` 신규:

```rust
use std::collections::BTreeMap;
use std::time::Duration;

use handicap_engine::{Scenario, TraceOptions, trace_scenario_rows};
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn opts(max_requests: u32) -> TraceOptions {
    TraceOptions {
        env: BTreeMap::new(),
        max_requests,
        max_wall: Duration::from_secs(120),
        apply_think_time: false,
    }
}

fn seed(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

/// 한 http 스텝짜리 시나리오 (cookie_jar auto).
fn one_step_scenario(url: &str) -> Scenario {
    Scenario::from_yaml(&format!(
        r#"
version: 1
name: rows
cookie_jar: auto
steps:
  - type: http
    id: 01HX0000000000000000000010
    name: a
    request: {{ method: GET, url: "{url}" }}
"#
    ))
    .unwrap()
}

/// 두 http 스텝짜리 시나리오 (예산 케이스용).
fn two_step_scenario(base: &str) -> Scenario {
    Scenario::from_yaml(&format!(
        r#"
version: 1
name: rows2
steps:
  - type: http
    id: 01HX0000000000000000000010
    name: a
    request: {{ method: GET, url: "{base}/a" }}
  - type: http
    id: 01HX0000000000000000000011
    name: b
    request: {{ method: GET, url: "{base}/b" }}
"#
    ))
    .unwrap()
}

async fn mount_ok(server: &MockServer, p: &str) {
    Mock::given(method("GET"))
        .and(path(p))
        .respond_with(ResponseTemplate::new(200))
        .mount(server)
        .await;
}

#[tokio::test]
async fn rows_share_cookie_jar_across_rows() {
    // R5: 클라이언트(jar) 1회 빌드 — 행 0의 Set-Cookie가 행 1 요청에 실린다.
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/bump"))
        .and(header("cookie", "sid=abc"))
        .respond_with(ResponseTemplate::new(200).set_body_string("seen"))
        .with_priority(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/bump"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("Set-Cookie", "sid=abc; Path=/")
                .set_body_string("fresh"),
        )
        .with_priority(2)
        .mount(&server)
        .await;

    let scenario = one_step_scenario(&format!("{}/bump", server.uri()));
    let rows = vec![(0u64, seed(&[])), (1u64, seed(&[]))];
    let rt = trace_scenario_rows(&scenario, &opts(50), &rows).await;
    assert!(rt.ok, "{rt:?}");
    let body0 = &rt.rows[0].trace.steps[0].response.as_ref().unwrap().body;
    let body1 = &rt.rows[1].trace.steps[0].response.as_ref().unwrap().body;
    assert_eq!(body0, "fresh");
    assert_eq!(body1, "seen");
}

#[tokio::test]
async fn iter_id_advances_per_row_and_row_index_passes_through() {
    // R4: iter_id = 반복 순번(0..N-1), row_index = 호출자가 준 앵커 그대로.
    let server = MockServer::start().await;
    mount_ok(&server, "/i/0").await;
    mount_ok(&server, "/i/1").await;
    mount_ok(&server, "/i/2").await;
    let scenario = one_step_scenario(&format!("{}/i/${{iter_id}}", server.uri()));
    let rows = vec![(5u64, seed(&[])), (6u64, seed(&[])), (7u64, seed(&[]))];
    let rt = trace_scenario_rows(&scenario, &opts(50), &rows).await;
    assert!(rt.ok, "{rt:?}");
    for (i, r) in rt.rows.iter().enumerate() {
        assert_eq!(r.row_index, 5 + i as u64);
        let url = &r.trace.steps[0].request.as_ref().unwrap().url;
        assert!(url.ends_with(&format!("/i/{i}")), "{url}");
    }
}

#[tokio::test]
async fn vars_reset_between_rows_extracts_do_not_accumulate() {
    // R4: 행마다 iter_vars 리셋 — 행 0의 extract가 행 1로 새지 않는다.
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/a"))
        .respond_with(
            ResponseTemplate::new(200).set_body_string(r#"{"tok":"t0"}"#),
        )
        .up_to_n_times(1)
        .with_priority(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/a"))
        .respond_with(ResponseTemplate::new(200).set_body_string("{}"))
        .with_priority(2)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/use/t0"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/use/"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;

    let scenario = Scenario::from_yaml(&format!(
        r#"
version: 1
name: reset
steps:
  - type: http
    id: 01HX0000000000000000000010
    name: get
    request: {{ method: GET, url: "{base}/a" }}
    extract:
      - var: tok
        from: body
        path: "$.tok"
  - type: http
    id: 01HX0000000000000000000011
    name: use
    request: {{ method: GET, url: "{base}/use/{{{{tok}}}}" }}
"#,
        base = server.uri()
    ))
    .unwrap();
    let rows = vec![(0u64, seed(&[])), (1u64, seed(&[]))];
    let rt = trace_scenario_rows(&scenario, &opts(50), &rows).await;
    // 행 0: tok=t0 추출·사용 / 행 1: 추출 실패 → tok 미바인딩(누적됐다면 t0가 남았을 것)
    let row1_use = rt.rows[1].trace.steps[1].request.as_ref().unwrap();
    assert!(row1_use.url.ends_with("/use/"), "{}", row1_use.url);
    assert!(rt.rows[1].trace.steps[1].unbound_vars.contains(&"tok".to_string()));
    let row0_use = rt.rows[0].trace.steps[1].request.as_ref().unwrap();
    assert!(row0_use.url.ends_with("/use/t0"), "{}", row0_use.url);
}

#[tokio::test]
async fn budget_exhausts_at_row_boundary() {
    // R6: 2스텝 × max_requests 4 → 행 0·1 완주, 행 2는 미실행(rows에 없음).
    let server = MockServer::start().await;
    mount_ok(&server, "/a").await;
    mount_ok(&server, "/b").await;
    let scenario = two_step_scenario(&server.uri());
    let rows = vec![(0u64, seed(&[])), (1u64, seed(&[])), (2u64, seed(&[]))];
    let rt = trace_scenario_rows(&scenario, &opts(4), &rows).await;
    assert_eq!(rt.rows.len(), 2);
    assert!(rt.truncated);
    assert!(!rt.ok, "truncated ⟹ ok=false (R8)");
    assert!(!rt.rows[0].trace.truncated);
    assert!(!rt.rows[1].trace.truncated);
}

#[tokio::test]
async fn budget_exhausts_mid_row() {
    // R6: max_requests 3 → 행 1이 스텝 1개만 돌고 mid-cut(그 행 truncated).
    let server = MockServer::start().await;
    mount_ok(&server, "/a").await;
    mount_ok(&server, "/b").await;
    let scenario = two_step_scenario(&server.uri());
    let rows = vec![(0u64, seed(&[])), (1u64, seed(&[]))];
    let rt = trace_scenario_rows(&scenario, &opts(3), &rows).await;
    assert_eq!(rt.rows.len(), 2);
    assert!(rt.truncated);
    assert!(rt.rows[1].trace.truncated);
    assert_eq!(rt.rows[1].trace.steps.len(), 1);
}

#[tokio::test]
async fn exact_budget_exhaustion_on_last_row_is_not_truncated() {
    // R6: 요청 구간 전부 완료 + 예산 정확 소진 → truncated=false.
    let server = MockServer::start().await;
    mount_ok(&server, "/a").await;
    mount_ok(&server, "/b").await;
    let scenario = two_step_scenario(&server.uri());
    let rows = vec![(0u64, seed(&[])), (1u64, seed(&[]))];
    let rt = trace_scenario_rows(&scenario, &opts(4), &rows).await;
    assert_eq!(rt.rows.len(), 2);
    assert!(!rt.truncated);
    assert!(rt.ok);
}

#[tokio::test]
async fn failed_row_does_not_stop_the_loop() {
    // R10: 실패 행 뒤 행도 실행 — fail-fast 없음.
    let server = MockServer::start().await;
    mount_ok(&server, "/s/okv").await;
    Mock::given(method("GET"))
        .and(path("/s/bad"))
        .respond_with(ResponseTemplate::new(500))
        .mount(&server)
        .await;
    let scenario = Scenario::from_yaml(&format!(
        r#"
version: 1
name: cont
steps:
  - type: http
    id: 01HX0000000000000000000010
    name: s
    request: {{ method: GET, url: "{base}/s/{{{{code}}}}" }}
    assert:
      - status: 200
"#,
        base = server.uri()
    ))
    .unwrap();
    let rows = vec![
        (0u64, seed(&[("code", "okv")])),
        (1u64, seed(&[("code", "bad")])),
        (2u64, seed(&[("code", "okv")])),
    ];
    let rt = trace_scenario_rows(&scenario, &opts(50), &rows).await;
    assert_eq!(rt.rows.len(), 3);
    assert!(rt.rows[0].trace.ok);
    assert!(rt.rows[1].trace.error.is_none()); // per-step 에러지 setup 에러 아님
    assert!(!rt.rows[1].trace.ok);
    assert!(rt.rows[2].trace.ok);
    assert!(!rt.ok);
    assert!(!rt.truncated);
}
```

- [ ] **Step 2: RED 확인** — `cargo test -p handicap-engine --test trace_rows` → `trace_scenario_rows` 미존재 컴파일 에러.

- [ ] **Step 3: 구현** — `crates/engine/src/trace.rs`에 타입 + 함수 추가:

```rust
/// sequential test-run의 행 하나 결과 (R8 — 컨트롤러가 그대로 직렬화).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RowTrace {
    /// 첫 바인딩 행 번호(= start_row + i, wrap 없음 — R17 앵커). 호출자가 부여.
    pub row_index: u64,
    pub trace: ScenarioTrace,
}

/// sequential test-run 응답의 엔진측 절반 (spec R8, ADR-0047).
/// `truncated`/`ok`는 seeded_rows 기준 — R18 clamp 반영(요청 구간 축소 시
/// all-green이어도 truncated)은 컨트롤러가 OR로 조정한다(정의는 spec R6 소유).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RowsTrace {
    /// `!truncated && rows[].trace.ok 전부`.
    pub ok: bool,
    /// 시드 행을 전부 못 돌았거나(미실행 행 존재) 마지막 실행 행이 mid-cut.
    pub truncated: bool,
    pub total_ms: u64,
    pub rows: Vec<RowTrace>,
}

/// 시나리오를 시드 행마다 1회씩 순차 실행 (1 VU iter_sequential 미러 — ADR-0047).
/// 클라이언트(cookie jar)는 1회 빌드해 행 간 공유(R5), `max_requests`·wall-clock
/// deadline은 전 행 공유 단일 예산(R6). 실패 행에서도 계속(R10). 예산이 행 시작
/// 전에 소진되면 그 행부터 `rows`에 없다(R6). Never returns `Err` — 극히 드문
/// 클라이언트 빌드 실패는 `ok=false`·빈 `rows`로 축약(R8 와이어에 error 채널 없음).
pub async fn trace_scenario_rows(
    scenario: &Scenario,
    opts: &TraceOptions,
    seeded_rows: &[(u64, BTreeMap<String, String>)],
) -> RowsTrace {
    let started = Instant::now();
    let deadline = started + opts.max_wall;
    let client = match VuClient::new(scenario.cookie_jar) {
        Ok(c) => c,
        Err(_) => {
            return RowsTrace {
                ok: false,
                truncated: false,
                total_ms: 0,
                rows: vec![],
            };
        }
    };
    let mut state = TraceState {
        steps: Vec::new(),
        requests: 0,
        truncated: false,
        iter_id: 0,
    };
    let mut rows: Vec<RowTrace> = Vec::with_capacity(seeded_rows.len());
    let mut truncated = false;
    for (i, (row_index, seed)) in seeded_rows.iter().enumerate() {
        // 행 시작 전 예산 소진 → 이 행부터 미실행 (rows에 없음 — R6).
        if state.requests >= opts.max_requests || Instant::now() >= deadline {
            truncated = true;
            break;
        }
        let trace =
            trace_once(&client, scenario, opts, seed, i as u32, deadline, &mut state).await;
        let mid_cut = trace.truncated;
        rows.push(RowTrace {
            row_index: *row_index,
            trace,
        });
        if mid_cut {
            // 마지막 실행 행 mid-cut (R6) — 이후 행도 미실행.
            truncated = true;
            break;
        }
    }
    let ok = !truncated && rows.iter().all(|r| r.trace.ok);
    RowsTrace {
        ok,
        truncated,
        total_ms: started.elapsed().as_millis().min(u64::MAX as u128) as u64,
        rows,
    }
}
```

(`i as u32`: seeded_rows 길이는 컨트롤러 R18 clamp로 `max_requests: u32` 이하.)

`trace.rs`의 기존 `mod tests`에 serde round-trip 추가(Deserialize 양방향 계약 — Slice 5 함정):

```rust
#[test]
fn rows_trace_serde_round_trips() {
    let rt = RowsTrace {
        ok: false,
        truncated: true,
        total_ms: 7,
        rows: vec![RowTrace {
            row_index: 3,
            trace: ScenarioTrace {
                ok: true,
                total_ms: 5,
                steps: vec![],
                final_vars: BTreeMap::new(),
                truncated: false,
                error: None,
            },
        }],
    };
    let json = serde_json::to_value(&rt).unwrap();
    // 와이어 키 고정 (R8 — UI Zod 1:1 계약)
    assert!(json.get("rows").unwrap()[0].get("row_index").is_some());
    let back: RowsTrace = serde_json::from_value(json).unwrap();
    assert_eq!(rt, back);
}
```

`lib.rs`의 `pub use trace::{…}`에 `RowTrace, RowsTrace, trace_scenario_rows` 추가.

- [ ] **Step 4: GREEN 확인** — `cargo test -p handicap-engine --test trace_rows` + `cargo test -p handicap-engine` 전체 PASS.

- [ ] **Step 5: Commit** — `git add crates/engine/src/trace.rs crates/engine/src/lib.rs crates/engine/tests/trace_rows.rs` 후 `git commit -m "feat(engine): trace_scenario_rows — jar 공유·전역 예산 행 루프 (R4/R5/R6/R10)"`.

---

### Task 3: 컨트롤러 — dataset 구성 wire·검증·핸들러 분기 (R2, R3, R7, R8, R9, R17, R18)

**Files:**
- Modify: `crates/controller/tests/test_runs_api_test.rs` (테스트 append)
- Modify: `crates/controller/src/api/test_runs.rs` (전면 확장 — store/proto/migration 0-diff)

**Interfaces:**
- Consumes: Task 1 `trace_scenario_with_seed` / Task 2 `trace_scenario_rows`·`RowsTrace`; `crate::binding::{Mapping, apply_mappings}`(기존 pub, 시그니처 무변경); `crate::store::datasets::{get_meta, get_rows_range}`(기존); `state.settings.max_data_bindings()`.
- Produces: `POST /api/test-runs` 요청 optional `dataset` 필드(아래 serde) — Task 4 UI 타입과 1:1. 응답: single_row/무-dataset = 기존 `ScenarioTrace` JSON(R7), sequential = `{ok, truncated, total_ms, rows:[{row_index, trace}]}`(R8, `RowsTrace` 직렬화). 핸들러 리턴 타입은 `Result<axum::response::Response, ApiError>`(spec §4.2의 "axum Response 분기" 선택 — untagged enum보다 단순, 라우트 무변경).

- [ ] **Step 1: 실패하는 테스트 작성** — `crates/controller/tests/test_runs_api_test.rs`에 append. 파일 상단 import에 `use std::collections::BTreeMap;` 불필요(아래 헬퍼는 Vec 기반). 헬퍼 + 테스트:

```rust
/// 데이터셋 직접 시드 (store 경유 — datasets_api_test의 multipart 대신 간결).
async fn seed_dataset(
    db: &handicap_controller::store::Db,
    name: &str,
    columns: &[&str],
    rows: &[&[&str]],
) -> String {
    let cols: Vec<String> = columns.iter().map(|s| s.to_string()).collect();
    let row_vecs: Vec<Vec<String>> = rows
        .iter()
        .map(|r| r.iter().map(|s| s.to_string()).collect())
        .collect();
    store::datasets::insert(db, name, &cols, &row_vecs, 0).await.unwrap()
}

/// 한 스텝 시나리오 YAML. url엔 `{{col}}` 토큰 — 연결 거부(포트 9)여도
/// trace가 렌더된 request.url을 캡처하므로 주입 검증에 서버가 필요 없다.
fn ds_scenario(url: &str) -> String {
    format!(
        r#"
version: 1
name: ds-test
steps:
  - type: http
    id: 01HX0000000000000000000010
    name: step-a
    request: {{ method: GET, url: "{url}" }}
"#
    )
}

#[tokio::test]
async fn single_row_injects_selected_row_and_keeps_trace_shape() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());
    let ds = seed_dataset(&db, "users", &["u"], &[&["alice"], &["bob"], &["carol"]]).await;
    let (status, v) = post(
        &app,
        "/api/test-runs",
        json!({
            "scenario_yaml": ds_scenario("http://127.0.0.1:9/u/{{u}}"),
            "env": {},
            "dataset": {"mode": "single_row", "bindings": [{"dataset_id": ds, "row_index": 1}]}
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    // R7: 기존 ScenarioTrace 형태 그대로 — rows 키 없음, steps/final_vars 있음
    assert!(v.get("rows").is_none());
    assert!(v.get("steps").is_some());
    assert_eq!(v["final_vars"]["u"], json!("bob"));
    let url = v["steps"][0]["request"]["url"].as_str().unwrap();
    assert!(url.ends_with("/u/bob"), "{url}");
}

#[tokio::test]
async fn single_row_explicit_mappings_column_and_literal() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());
    let ds = seed_dataset(&db, "users", &["u"], &[&["alice"], &["bob"]]).await;
    let (status, v) = post(
        &app,
        "/api/test-runs",
        json!({
            "scenario_yaml": ds_scenario("http://127.0.0.1:9/m/{{user}}/{{role}}"),
            "env": {},
            "dataset": {"mode": "single_row", "bindings": [{
                "dataset_id": ds, "row_index": 1,
                "mappings": [
                    {"kind": "column", "var": "user", "column": "u"},
                    {"kind": "literal", "var": "role", "value": "admin"}
                ]
            }]}
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let url = v["steps"][0]["request"]["url"].as_str().unwrap();
    assert!(url.ends_with("/m/bob/admin"), "{url}");
}

#[tokio::test]
async fn sequential_anchors_row_index_and_wraps_non_first_binding() {
    // R17: 첫 바인딩 wrap 없음·row_index=start_row+i, 비-첫 바인딩 % len wrap.
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());
    let a = seed_dataset(&db, "A", &["a"], &[&["x0"], &["x1"], &["x2"], &["x3"]]).await;
    let b = seed_dataset(&db, "B", &["b"], &[&["y0"], &["y1"]]).await;
    let (status, v) = post(
        &app,
        "/api/test-runs",
        json!({
            "scenario_yaml": ds_scenario("http://127.0.0.1:9/w/{{a}}/{{b}}"),
            "env": {},
            "dataset": {"mode": "sequential", "bindings": [
                {"dataset_id": a}, {"dataset_id": b}
            ]}
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let rows = v["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 4);
    for (i, r) in rows.iter().enumerate() {
        assert_eq!(r["row_index"], json!(i as u64));
        let url = r["trace"]["steps"][0]["request"]["url"].as_str().unwrap();
        assert!(url.ends_with(&format!("/w/x{i}/y{}", i % 2)), "{url}");
    }
}

#[tokio::test]
async fn sequential_start_row_offsets_first_binding_without_wrap() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());
    let ds = seed_dataset(&db, "A", &["u"], &[&["r0"], &["r1"], &["r2"]]).await;
    let (status, v) = post(
        &app,
        "/api/test-runs",
        json!({
            "scenario_yaml": ds_scenario("http://127.0.0.1:9/u/{{u}}"),
            "env": {},
            "dataset": {"mode": "sequential", "start_row": 1,
                        "bindings": [{"dataset_id": ds}]}
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let rows = v["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["row_index"], json!(1));
    assert_eq!(rows[1]["row_index"], json!(2));
    assert!(rows[1]["trace"]["steps"][0]["request"]["url"]
        .as_str()
        .unwrap()
        .ends_with("/u/r2"));
}

#[tokio::test]
async fn sequential_clamped_all_green_is_truncated_and_not_ok() {
    // R18 clamp(max_requests) + R6: all-green이어도 요청 구간 미완주 → truncated·ok=false.
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());
    let server = wiremock::MockServer::start().await;
    wiremock::Mock::given(wiremock::matchers::method("GET"))
        .respond_with(wiremock::ResponseTemplate::new(200))
        .mount(&server)
        .await;
    let ds = seed_dataset(&db, "big", &["u"], &[&["a"], &["b"], &["c"], &["d"], &["e"]]).await;
    let (status, v) = post(
        &app,
        "/api/test-runs",
        json!({
            "scenario_yaml": ds_scenario(&format!("{}/x/{{{{u}}}}", server.uri())),
            "env": {},
            "max_requests": 2,
            "dataset": {"mode": "sequential", "bindings": [{"dataset_id": ds}]}
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(v["rows"].as_array().unwrap().len(), 2);
    assert_eq!(v["rows"][0]["trace"]["ok"], json!(true));
    assert_eq!(v["truncated"], json!(true));
    assert_eq!(v["ok"], json!(false));
}

#[tokio::test]
async fn sequential_row_limit_within_budget_is_clean() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());
    let server = wiremock::MockServer::start().await;
    wiremock::Mock::given(wiremock::matchers::method("GET"))
        .respond_with(wiremock::ResponseTemplate::new(200))
        .mount(&server)
        .await;
    let ds = seed_dataset(&db, "big", &["u"], &[&["a"], &["b"], &["c"], &["d"], &["e"]]).await;
    let (status, v) = post(
        &app,
        "/api/test-runs",
        json!({
            "scenario_yaml": ds_scenario(&format!("{}/x/{{{{u}}}}", server.uri())),
            "env": {},
            "dataset": {"mode": "sequential", "row_limit": 2,
                        "bindings": [{"dataset_id": ds}]}
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(v["rows"].as_array().unwrap().len(), 2);
    assert_eq!(v["truncated"], json!(false));
    assert_eq!(v["ok"], json!(true));
}

/// R9 검증 10케이스 — 전부 422 + 한국어 메시지 조각.
async fn expect_422(app: &axum::Router, dataset: Value, yaml_url: &str, frag: &str) {
    let (status, v) = post(
        app,
        "/api/test-runs",
        json!({ "scenario_yaml": ds_scenario(yaml_url), "env": {}, "dataset": dataset }),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{v:?}");
    assert!(
        v["error"].as_str().unwrap_or("").contains(frag),
        "expected '{frag}' in {v:?}"
    );
}

#[tokio::test]
async fn dataset_validation_rejects_with_422_korean() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());
    let ds = seed_dataset(&db, "users", &["u"], &[&["alice"], &["bob"]]).await;
    let url = "http://127.0.0.1:9/u/{{u}}";

    // ① dataset_id 미존재
    expect_422(&app, json!({"mode":"single_row","bindings":[{"dataset_id":"01JNOPE","row_index":0}]}), url, "존재하지 않습니다").await;
    // ② 명시 매핑 컬럼 미존재
    expect_422(&app, json!({"mode":"single_row","bindings":[{"dataset_id":ds,"row_index":0,"mappings":[{"kind":"column","var":"u","column":"nope"}]}]}), url, "데이터셋에 없습니다").await;
    // ③-a row_index 범위 밖
    expect_422(&app, json!({"mode":"single_row","bindings":[{"dataset_id":ds,"row_index":2}]}), url, "row_index").await;
    // ③-b start_row 범위 밖 (첫 바인딩 앵커)
    expect_422(&app, json!({"mode":"sequential","start_row":2,"bindings":[{"dataset_id":ds}]}), url, "start_row").await;
    // ④ row_limit < 1
    expect_422(&app, json!({"mode":"sequential","row_limit":0,"bindings":[{"dataset_id":ds}]}), url, "row_limit").await;
    // ⑤ 바인딩 간 변수명 중복 (auto-auto — 같은 데이터셋 2회 = 전 컬럼 충돌)
    expect_422(&app, json!({"mode":"sequential","bindings":[{"dataset_id":ds},{"dataset_id":ds}]}), url, "중복").await;
    // ⑥ bindings 빈 배열
    expect_422(&app, json!({"mode":"single_row","bindings":[]}), url, "바인딩").await;
    // ⑦ mappings 빈 배열 명시 (R3 — 자동은 생략만)
    expect_422(&app, json!({"mode":"single_row","bindings":[{"dataset_id":ds,"row_index":0,"mappings":[]}]}), url, "빈 배열").await;
    // ⑨-a single_row에 start_row
    expect_422(&app, json!({"mode":"single_row","start_row":0,"bindings":[{"dataset_id":ds,"row_index":0}]}), url, "single_row").await;
    // ⑨-b sequential에 row_index
    expect_422(&app, json!({"mode":"sequential","bindings":[{"dataset_id":ds,"row_index":0}]}), url, "sequential").await;
    // ⑩ single_row인데 row_index 누락
    expect_422(&app, json!({"mode":"single_row","bindings":[{"dataset_id":ds}]}), url, "row_index").await;
}

#[tokio::test]
async fn dataset_bindings_over_limit_rejected() {
    // ⑧ bindings.len() > max_data_bindings (시드 8)
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());
    let ds = seed_dataset(&db, "users", &["u"], &[&["alice"]]).await;
    let bindings: Vec<Value> =
        (0..9).map(|_| json!({"dataset_id": ds, "row_index": 0})).collect();
    expect_422(&app, json!({"mode":"single_row","bindings":bindings}), "http://127.0.0.1:9/u/{{u}}", "최대").await;
}

#[tokio::test]
async fn empty_dataset_rejected() {
    // R9 목록 외 방어(⑪): 0행 데이터셋 — 비-첫 바인딩 wrap `% 0` 차단 (run 게이트 미러).
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());
    let empty = seed_dataset(&db, "empty", &["u"], &[]).await;
    expect_422(&app, json!({"mode":"sequential","bindings":[{"dataset_id":empty}]}), "http://127.0.0.1:9/u/{{u}}", "빈 데이터셋").await;
}

#[tokio::test]
async fn sequential_zero_leaf_scenario_is_bounded_by_clamp() {
    // R18 acceptance: 0-http-leaf 시나리오는 요청 예산을 전혀 안 쓰므로
    // clamp(N ≤ max_requests)만이 행 수·응답 크기를 유계로 만든다.
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());
    let ds = seed_dataset(&db, "big", &["u"], &[&["a"], &["b"], &["c"], &["d"], &["e"]]).await;
    let (status, v) = post(
        &app,
        "/api/test-runs",
        json!({
            "scenario_yaml": "version: 1\nname: empty\nsteps: []\n",
            "env": {},
            "max_requests": 2,
            "dataset": {"mode": "sequential", "bindings": [{"dataset_id": ds}]}
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(v["rows"].as_array().unwrap().len(), 2); // N = min(잔여 5, 5, max_requests 2)
    assert_eq!(v["truncated"], json!(true)); // 요청 구간 5 중 2행만 (clamp)
    assert_eq!(v["ok"], json!(false));
}

#[tokio::test]
async fn dataset_omitted_stays_byte_identical() {
    // R1: dataset 없는 요청 — 기존 형태(steps 有·rows 無). 기존 테스트 무수정 green이 주 증거.
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);
    let (status, v) = post(
        &app,
        "/api/test-runs",
        json!({ "scenario_yaml": ds_scenario("http://127.0.0.1:9/plain"), "env": {} }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(v.get("steps").is_some());
    assert!(v.get("rows").is_none());
}
```

(파일 상단 `use handicap_controller::{app, store};`는 기존 그대로 — `store::datasets::insert` 접근 가능. wiremock은 dev-dep 기존 존재.)

- [ ] **Step 2: RED 확인** — `cargo test -p handicap-controller --test test_runs_api_test` → `dataset` 필드가 무시(serde unknown 필드 허용)되므로 주입 단언 실패 또는 422 기대 실패로 RED.

- [ ] **Step 3: 구현** — `crates/controller/src/api/test_runs.rs` 확장:

```rust
use std::collections::BTreeMap;
use std::time::Duration;

use axum::Json;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use handicap_engine::{
    Scenario, TraceOptions, trace_scenario, trace_scenario_rows, trace_scenario_with_seed,
};
// (주의: `ScenarioTrace`는 임포트하지 않는다 — 핸들러 리턴이 `Response`로 바뀌어
// 타입 표기가 사라지므로 unused import = clippy -D warnings 게이트 실패.)
use serde::Deserialize;

use crate::api::scenarios::validate_scenario_think_times;
use crate::binding::{Mapping, apply_mappings};
use crate::error::ApiError;
use crate::store::datasets;
```

serde 타입(spec §4.2 verbatim + mode enum):

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TestRunDatasetMode {
    SingleRow,
    Sequential,
}

#[derive(Debug, Deserialize)]
pub struct TestRunBinding {
    pub dataset_id: String,
    /// None = 전 컬럼→동명 변수 자동 매핑(서버가 명시 Column으로 실체화 — R3).
    /// Some(빈 배열) = 422 — run 와이어의 "빈 매핑 = 주입 없음"(runs.rs)과
    /// 같은 모양이 다른 뜻이 되는 이중 계약 금지 (spec §5).
    #[serde(default)]
    pub mappings: Option<Vec<Mapping>>,
    /// single_row 전용·필수(R9-⑩). sequential에서 지정 시 422 (R9-⑨).
    #[serde(default)]
    pub row_index: Option<u64>,
}

#[derive(Debug, Deserialize)]
pub struct TestRunDatasetConfig {
    pub mode: TestRunDatasetMode,
    pub bindings: Vec<TestRunBinding>,
    /// sequential 전용 (None=0). single_row에서 지정 시 422 (R9-⑨).
    #[serde(default)]
    pub start_row: Option<u64>,
    /// sequential 전용, None=전체 (R18 clamp).
    #[serde(default)]
    pub row_limit: Option<u64>,
}
```

`TestRunRequest`에 `#[serde(default)] pub dataset: Option<TestRunDatasetConfig>,` 추가.

검증·해석(핸들러 아래 private fn — 순서: 실체화(R3) → 검증(R9) → clamp(R18) → 행 로드(R17/R18) → 시드(R4)):

```rust
/// 검증 통과한 바인딩 — 자동 매핑은 이미 명시 Column으로 실체화됨(R3).
struct EffectiveBinding {
    dataset_id: String,
    mappings: Vec<Mapping>,
    row_index: Option<u64>,
    row_count: u64,
}

/// R3 실체화 + R9 ①②⑤⑥⑦⑧(+⑪ 빈 데이터셋 방어). 메타는 바인딩당 1회
/// fetch(TOCTOU 가드 — 8c 함정) 후 필요한 필드만 남긴다.
async fn resolve_bindings(
    state: &crate::app::AppState,
    cfg: &TestRunDatasetConfig,
) -> Result<Vec<EffectiveBinding>, ApiError> {
    if cfg.bindings.is_empty() {
        return Err(ApiError::Unprocessable(
            "데이터셋 바인딩을 1개 이상 지정하세요 (bindings가 비어 있음)".into(),
        ));
    }
    let max_bindings = state.settings.max_data_bindings();
    if cfg.bindings.len() > max_bindings {
        return Err(ApiError::Unprocessable(format!(
            "데이터셋 바인딩은 최대 {max_bindings}개입니다 ({}개)",
            cfg.bindings.len()
        )));
    }
    let mut effective = Vec::with_capacity(cfg.bindings.len());
    let mut seen = std::collections::HashSet::new();
    for b in &cfg.bindings {
        let meta = datasets::get_meta(&state.db, &b.dataset_id)
            .await?
            .ok_or_else(|| {
                ApiError::Unprocessable(format!(
                    "데이터셋 '{}'이 존재하지 않습니다",
                    b.dataset_id
                ))
            })?;
        // R9 목록 외 방어: 0행 데이터셋은 비-첫 바인딩 wrap `% len`이 0-나눗셈이
        // 된다 — run 게이트와 같은 메시지로 선제 거부.
        if meta.row_count == 0 {
            return Err(ApiError::Unprocessable(
                "빈 데이터셋은 바인딩할 수 없습니다".into(),
            ));
        }
        let mappings: Vec<Mapping> = match &b.mappings {
            // R3: 생략 = 전 컬럼→동명 변수 자동 매핑을 명시 Column으로 실체화.
            None => meta
                .columns
                .iter()
                .map(|c| Mapping::Column {
                    var: c.clone(),
                    column: c.clone(),
                })
                .collect(),
            Some(v) if v.is_empty() => {
                return Err(ApiError::Unprocessable(
                    "mappings 빈 배열은 허용되지 않습니다 — 자동 매핑은 mappings 필드를 생략하세요".into(),
                ));
            }
            Some(v) => v.clone(),
        };
        // 실체화 후 effective 매핑 기준 단일 경로 검증 (R9-②·⑤ — auto-auto 충돌 포함).
        for m in &mappings {
            if let Mapping::Column { column, .. } = m {
                if !meta.columns.iter().any(|c| c == column) {
                    return Err(ApiError::Unprocessable(format!(
                        "매핑 컬럼 '{column}'이 데이터셋에 없습니다 (있는 컬럼: {:?})",
                        meta.columns
                    )));
                }
            }
            let var = match m {
                Mapping::Column { var, .. } | Mapping::Literal { var, .. } => var,
            };
            if !seen.insert(var.clone()) {
                return Err(ApiError::Unprocessable(format!(
                    "변수 '{var}'이 여러 데이터셋에 중복 매핑됨"
                )));
            }
        }
        effective.push(EffectiveBinding {
            dataset_id: b.dataset_id.clone(),
            mappings,
            row_index: b.row_index,
            row_count: meta.row_count as u64,
        });
    }
    Ok(effective)
}

/// single_row: R9 ③⑨⑩ 검증 + 바인딩별 1행 로드·매핑 병합 시드 (R4).
async fn seed_single_row(
    state: &crate::app::AppState,
    cfg: &TestRunDatasetConfig,
    effective: &[EffectiveBinding],
) -> Result<BTreeMap<String, String>, ApiError> {
    if cfg.start_row.is_some() || cfg.row_limit.is_some() {
        return Err(ApiError::Unprocessable(
            "single_row 모드에선 start_row/row_limit를 지정할 수 없습니다".into(),
        ));
    }
    let mut seed = BTreeMap::new();
    for b in effective {
        let idx = b.row_index.ok_or_else(|| {
            ApiError::Unprocessable("single_row 모드는 바인딩마다 row_index가 필요합니다".into())
        })?;
        if idx >= b.row_count {
            return Err(ApiError::Unprocessable(format!(
                "row_index {idx}가 데이터셋 행 수 {}를 벗어납니다",
                b.row_count
            )));
        }
        let rows = datasets::get_rows_range(&state.db, &b.dataset_id, idx as i64, 1).await?;
        let row = rows.into_iter().next().ok_or_else(|| {
            ApiError::Unprocessable(format!(
                "데이터셋 '{}'의 행 {idx}를 읽지 못했습니다",
                b.dataset_id
            ))
        })?;
        seed.extend(apply_mappings(&b.mappings, &row));
    }
    Ok(seed)
}

struct SequentialPlan {
    seeded_rows: Vec<(u64, BTreeMap<String, String>)>,
    /// 사용자 요청 구간 = row_limit ?? 첫 바인딩 잔여 (R6 truncated 판정 기준).
    requested_span: u64,
}

/// sequential: R9 ③④⑨ 검증 + R18 clamp + 행 로드(바인딩별 연속 range fetch
/// 1–2회, ≤ min(len, N)행 — 전체 선로드 금지) + 반복별 시드 (R4/R17).
async fn seed_sequential(
    state: &crate::app::AppState,
    cfg: &TestRunDatasetConfig,
    effective: &[EffectiveBinding],
    max_requests: u32,
) -> Result<SequentialPlan, ApiError> {
    if effective.iter().any(|b| b.row_index.is_some()) {
        return Err(ApiError::Unprocessable(
            "sequential 모드에선 row_index를 지정할 수 없습니다".into(),
        ));
    }
    if cfg.row_limit == Some(0) {
        return Err(ApiError::Unprocessable("row_limit는 1 이상이어야 합니다".into()));
    }
    let first = &effective[0];
    let start = cfg.start_row.unwrap_or(0);
    if start >= first.row_count {
        return Err(ApiError::Unprocessable(format!(
            "start_row {start}가 첫 바인딩 데이터셋 행 수 {}를 벗어납니다",
            first.row_count
        )));
    }
    let remaining = first.row_count - start;
    let requested_span = cfg.row_limit.unwrap_or(remaining);
    // R18: N = min(row_limit ?? 잔여, 잔여, max_requests).
    let n = requested_span.min(remaining).min(max_requests as u64);
    // 행 로드: 첫 바인딩은 start부터 no-wrap 1회(start+n ≤ row_count 보장),
    // 비-첫은 start % len부터 — 테이블 끝에 못 미치면 head를 0부터 이어붙인다(wrap 2회째).
    let mut loaded: Vec<Vec<BTreeMap<String, String>>> = Vec::with_capacity(effective.len());
    for (k, b) in effective.iter().enumerate() {
        let len = b.row_count;
        let count = n.min(len);
        let first_idx = if k == 0 { start } else { start % len };
        let mut rows =
            datasets::get_rows_range(&state.db, &b.dataset_id, first_idx as i64, count as i64)
                .await?;
        if (rows.len() as u64) < count {
            let head = count - rows.len() as u64;
            let mut head_rows =
                datasets::get_rows_range(&state.db, &b.dataset_id, 0, head as i64).await?;
            rows.append(&mut head_rows);
        }
        if (rows.len() as u64) < count {
            // meta 검증 후 삭제된 rare TOCTOU — 500 대신 검증 계열 422.
            return Err(ApiError::Unprocessable(format!(
                "데이터셋 '{}'의 행을 읽지 못했습니다",
                b.dataset_id
            )));
        }
        loaded.push(rows);
    }
    // 반복 i의 비-첫 바인딩 행 = (start+i) % len = 로드 벡터의 i % len 위치
    // (로드가 start%len부터 wrap 순서라 by-construction 정렬 — R17).
    let mut seeded_rows = Vec::with_capacity(n as usize);
    for i in 0..n {
        let mut seed = BTreeMap::new();
        for (k, b) in effective.iter().enumerate() {
            let rows = &loaded[k];
            let row = &rows[(i as usize) % rows.len()];
            seed.extend(apply_mappings(&b.mappings, row));
        }
        seeded_rows.push((start + i, seed));
    }
    Ok(SequentialPlan {
        seeded_rows,
        requested_span,
    })
}
```

핸들러 — 리턴 타입 변경 + 분기(기존 검증 3종은 그대로 유지):

```rust
pub async fn create(
    State(state): State<crate::app::AppState>,
    Json(body): Json<TestRunRequest>,
) -> Result<Response, ApiError> {
    let max_requests = state.settings.max_test_run_requests();
    if body.max_requests < 1 || body.max_requests > max_requests {
        return Err(ApiError::Unprocessable(format!(
            "max_requests must be 1..={max_requests}, got {}",
            body.max_requests
        )));
    }
    let scenario = Scenario::from_yaml(&body.scenario_yaml)
        .map_err(|e| ApiError::Unprocessable(format!("scenario parse: {e}")))?;
    validate_scenario_think_times(&scenario.steps, &scenario.default_think_time)
        .map_err(ApiError::Unprocessable)?;

    let opts = TraceOptions {
        env: body.env,
        max_requests: body.max_requests,
        max_wall: Duration::from_secs(WALL_CLOCK_CEILING_SECS),
        apply_think_time: body.apply_think_time,
    };
    match &body.dataset {
        // R1: dataset 없는 요청은 기존 경로 그대로.
        None => Ok(Json(trace_scenario(&scenario, &opts).await).into_response()),
        Some(cfg) => {
            let effective = resolve_bindings(&state, cfg).await?;
            match cfg.mode {
                TestRunDatasetMode::SingleRow => {
                    let seed = seed_single_row(&state, cfg, &effective).await?;
                    // R7: 기존 ScenarioTrace 형태 그대로 — 렌더러 무변경.
                    let trace = trace_scenario_with_seed(&scenario, &opts, &seed).await;
                    Ok(Json(trace).into_response())
                }
                TestRunDatasetMode::Sequential => {
                    let plan =
                        seed_sequential(&state, cfg, &effective, body.max_requests).await?;
                    let mut rt = trace_scenario_rows(&scenario, &opts, &plan.seeded_rows).await;
                    // R6/R18: clamp로 요청 구간이 축소됐으면 all-green이어도 truncated.
                    let clamped = (plan.seeded_rows.len() as u64) < plan.requested_span;
                    rt.truncated = rt.truncated || clamped;
                    rt.ok = rt.ok && !clamped;
                    Ok(Json(rt).into_response())
                }
            }
        }
    }
}
```

(`app.rs` 라우트 무변경 — `Result<Response, ApiError>`도 axum handler로 유효.)

- [ ] **Step 4: GREEN 확인** — `cargo test -p handicap-controller --test test_runs_api_test` 전부 PASS(기존 3 테스트 무수정 포함) + `cargo build --workspace`.

- [ ] **Step 5: Commit** — `git add crates/controller/src/api/test_runs.rs crates/controller/tests/test_runs_api_test.rs` 후 `git commit -m "feat(controller): test-run dataset 바인딩 — 자동매핑 실체화·R9 검증·R18 clamp·sequential 응답 (ADR-0047)"`.

---

### Task 4: UI — API 레이어 (R16)

**Files:**
- Create: `ui/src/api/__tests__/testRunDataset.test.ts`
- Modify: `ui/src/api/schemas.ts` (`ScenarioTraceSchema` 아래에 append)
- Modify: `ui/src/api/client.ts` (`TestRunBody` 타입 + `createTestRunSequential`)
- Modify: `ui/src/api/hooks.ts` (`useTestRun` body 타입 교체 + `useTestRunSequential`)

**Interfaces:**
- Consumes: 기존 `MappingSchema`/`Mapping`(`schemas.ts:24-28`), `ScenarioTraceSchema`, `request()`.
- Produces (Task 5–7이 소비):
  - `schemas.ts`: `TestRunDatasetMode`/`TestRunBinding`/`TestRunDatasetConfig`(plain TS 타입 — 직렬화 방향이라 Zod 불필수, spec §4.3), `RowTraceSchema`/`RowTrace`, `SequentialTraceSchema`/`SequentialTrace`.
  - `client.ts`: `export interface TestRunBody { scenario_yaml: string; env: Record<string, string>; max_requests?: number; apply_think_time?: boolean; dataset?: TestRunDatasetConfig }`, `api.createTestRun(body: TestRunBody): Promise<ScenarioTrace>`(기존 파싱 유지), `api.createTestRunSequential(body: TestRunBody): Promise<SequentialTrace>`.
  - `hooks.ts`: `useTestRun()`(body 타입만 `TestRunBody`로 — 거동 무변경), `useTestRunSequential()`(무invalidation bare mutation — C-2 이디엄).

- [ ] **Step 1: 실패하는 테스트 작성** — `ui/src/api/__tests__/testRunDataset.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  ScenarioTraceSchema,
  SequentialTraceSchema,
  type TestRunDatasetConfig,
} from "../schemas";

// Rust RowsTrace 직렬화 1:1 fixture (Task 2/3 와이어 — 전 필드 항상 emit)
const stepTrace = {
  step_id: "01HX0000000000000000000010",
  kind: "http",
  loop_index: null,
  branch: null,
  request: { method: "GET", url: "http://x/u/bob", headers: {}, body: null },
  response: {
    status: 200,
    latency_ms: 3,
    download_ms: null,
    headers: {},
    set_cookies: [],
    body: "ok",
    body_truncated: false,
  },
  extracted: {},
  unbound_vars: [],
  error: null,
};
const trace = {
  ok: true,
  total_ms: 5,
  steps: [stepTrace],
  final_vars: { u: "bob" },
  truncated: false,
  error: null,
};

describe("SequentialTraceSchema", () => {
  it("parses the Rust RowsTrace wire shape 1:1", () => {
    const seq = {
      ok: false,
      truncated: true,
      total_ms: 42,
      rows: [
        { row_index: 3, trace },
        { row_index: 4, trace: { ...trace, ok: false } },
      ],
    };
    const parsed = SequentialTraceSchema.parse(seq);
    expect(parsed.rows[0].row_index).toBe(3);
    expect(parsed.rows[1].trace.ok).toBe(false);
  });

  it("rejects a single-trace payload (rows 없음)", () => {
    expect(SequentialTraceSchema.safeParse(trace).success).toBe(false);
  });

  it("single_row 응답은 기존 ScenarioTraceSchema 그대로 통과 (R7)", () => {
    expect(ScenarioTraceSchema.safeParse(trace).success).toBe(true);
  });

  it("요청 타입이 와이어 필드명과 일치 (컴파일 계약)", () => {
    const cfg: TestRunDatasetConfig = {
      mode: "sequential",
      bindings: [
        { dataset_id: "01J", mappings: [{ kind: "column", var: "u", column: "u" }] },
      ],
      start_row: 1,
      row_limit: 5,
    };
    expect(cfg.bindings[0].dataset_id).toBe("01J");
  });
});
```

- [ ] **Step 2: RED 확인** — `cd ui && pnpm test testRunDataset` → import 실패.

- [ ] **Step 3: 구현** — `schemas.ts`의 `ScenarioTraceSchema` 아래 append:

```ts
// ── 에디터 test-run 데이터셋 (ADR-0047) ─────────────────────────────
// 요청 방향(직렬화 전용)이라 Zod 불필수 — plain TS 타입 (spec §4.3).
// row_index/start_row는 0-based 와이어 값 — UI 표시는 1-based, 변환은 컴포넌트에서.
export type TestRunDatasetMode = "single_row" | "sequential";
export interface TestRunBinding {
  dataset_id: string;
  /** 생략 = 서버 자동 매핑(컬럼명=변수명, R3). 빈 배열 전송 금지(422). */
  mappings?: Mapping[];
  /** single_row 전용(필수). */
  row_index?: number;
}
export interface TestRunDatasetConfig {
  mode: TestRunDatasetMode;
  bindings: TestRunBinding[];
  start_row?: number;
  row_limit?: number;
}

// sequential 응답 — 엔진 RowsTrace 직렬화 1:1 (전 필드 항상 emit → plain 타입, R16).
export const RowTraceSchema = z.object({
  row_index: z.number().int(),
  trace: ScenarioTraceSchema,
});
export type RowTrace = z.infer<typeof RowTraceSchema>;

export const SequentialTraceSchema = z.object({
  ok: z.boolean(),
  truncated: z.boolean(),
  total_ms: z.number().int(),
  rows: z.array(RowTraceSchema),
});
export type SequentialTrace = z.infer<typeof SequentialTraceSchema>;
```

`client.ts`: import에 `SequentialTraceSchema, type TestRunDatasetConfig` 추가 + 인라인 body 타입을 명명 타입으로 교체:

```ts
export interface TestRunBody {
  scenario_yaml: string;
  env: Record<string, string>;
  max_requests?: number;
  apply_think_time?: boolean;
  dataset?: TestRunDatasetConfig;
}
```

`api` 객체: `createTestRun: (body: TestRunBody) => request("/test-runs", { method: "POST", body: JSON.stringify(body) }, ScenarioTraceSchema)` (기존 시그니처의 인라인 타입만 교체), 그 아래 추가:

```ts
createTestRunSequential: (body: TestRunBody) =>
  request("/test-runs", { method: "POST", body: JSON.stringify(body) }, SequentialTraceSchema),
```

`hooks.ts`: `useTestRun`의 인라인 body 타입을 `TestRunBody`로 교체(import 추가) + 추가:

```ts
/** sequential 모드 test-run — ephemeral이라 무invalidation (C-2 이디엄). */
export function useTestRunSequential() {
  return useMutation({
    mutationFn: (body: TestRunBody) => api.createTestRunSequential(body),
  });
}
```

- [ ] **Step 4: GREEN 확인** — `cd ui && pnpm test testRunDataset` PASS → `pnpm lint && pnpm test && pnpm build` 전체 PASS.

- [ ] **Step 5: Commit** — `git add ui/src/api/schemas.ts ui/src/api/client.ts ui/src/api/hooks.ts ui/src/api/__tests__/testRunDataset.test.ts` 후 `git commit -m "feat(ui): test-run 데이터셋 요청 타입 + SequentialTraceSchema + useTestRunSequential (R16)"`.

---

### Task 5: UI — `DatasetRowsPreview` 선택 prop (R12)

**Files:**
- Modify: `ui/src/components/datasets/__tests__/DatasetRowsPreview.test.tsx` (테스트 append)
- Modify: `ui/src/components/datasets/DatasetRowsPreview.tsx`
- Modify: `ui/src/i18n/ko.ts` (`ko.dataset`에 키 1개)

**Interfaces:**
- Produces: additive optional props — `onSelectRow?: (rowIndex: number) => void`(0-based 데이터셋 idx), `selectedRow?: number`. 미전달 시 기존 렌더·거동 byte-identical(기존 테스트 무수정 green — R12). Task 7의 single_row 행 선택이 소비.
- ko 키: `ko.dataset.selectRowAria: (n: number) => \`행 ${n} 선택\`` (n은 1-based 표시 번호).

- [ ] **Step 1: 실패하는 테스트 작성** — `DatasetRowsPreview.test.tsx`의 기존 `renderPreview` 헬퍼(`:33-40`)에 additive optional 파라미터를 더하고(기존 호출부 무수정) 케이스 3개 append:

```tsx
// renderPreview 시그니처 확장 (기존 케이스 무수정 — extra 기본값 {})
function renderPreview(
  rowCount = 1000,
  columns: string[] = ["name", "val"],
  extra: { onSelectRow?: (rowIndex: number) => void; selectedRow?: number } = {},
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <DatasetRowsPreview
        datasetId="01J"
        name="users"
        columns={columns}
        rowCount={rowCount}
        {...extra}
      />
    </QueryClientProvider>,
  );
}
```

```tsx
it("onSelectRow 미전달이면 행 번호 셀에 버튼이 없다 (기존 거동 — R12)", async () => {
  mockRowsByUrl(1000);
  renderPreview();
  await screen.findByText(ko.dataset.rowsRange(1, 50, 1000));
  expect(screen.queryByRole("button", { name: /행 \d+ 선택/ })).not.toBeInTheDocument();
});

it("onSelectRow 전달 시 행 번호 버튼 클릭이 0-based idx로 콜백", async () => {
  const user = userEvent.setup();
  const onSelectRow = vi.fn();
  mockRowsByUrl(1000);
  renderPreview(1000, ["name", "val"], { onSelectRow });
  await screen.findByText(ko.dataset.rowsRange(1, 50, 1000));
  await user.click(screen.getByRole("button", { name: ko.dataset.selectRowAria(2) }));
  expect(onSelectRow).toHaveBeenCalledWith(1); // 표시 1-based → 와이어 0-based
});

it("selectedRow 행은 하이라이트 + aria-pressed", async () => {
  mockRowsByUrl(1000);
  renderPreview(1000, ["name", "val"], { onSelectRow: () => {}, selectedRow: 1 });
  await screen.findByText(ko.dataset.rowsRange(1, 50, 1000));
  const btn = screen.getByRole("button", { name: ko.dataset.selectRowAria(2) });
  expect(btn).toHaveAttribute("aria-pressed", "true");
  expect(btn.closest("tr")).toHaveClass("bg-accent-50");
  // 비선택 행은 하이라이트 없음
  const other = screen.getByRole("button", { name: ko.dataset.selectRowAria(1) });
  expect(other.closest("tr")).not.toHaveClass("bg-accent-50");
});
```

- [ ] **Step 2: RED 확인** — `pnpm test DatasetRowsPreview` → 신규 3 케이스 실패, 기존 케이스 green 유지 확인.

- [ ] **Step 3: 구현** — `DatasetRowsPreview.tsx`:

Props 확장:

```tsx
interface Props {
  datasetId: string;
  name: string;
  columns: string[];
  rowCount: number;
  /** 전달 시 행 클릭 = 선택(0-based 데이터셋 idx) — test-run 행 선택 재사용 (R12). */
  onSelectRow?: (rowIndex: number) => void;
  selectedRow?: number;
}
```

tbody 행 교체(행 번호 셀만 조건부 버튼, `<tr>`엔 시각 하이라이트 + 포인터 편의 onClick — aria는 버튼이 소유):

```tsx
{rows.map((row, i) => {
  const rowIdx = respOffset + i;
  const selected = selectedRow === rowIdx;
  return (
    <tr
      key={rowIdx}
      className={`border-b border-slate-100${
        onSelectRow ? " cursor-pointer hover:bg-slate-100" : ""
      }${selected ? " bg-accent-50" : ""}`}
      onClick={onSelectRow ? () => onSelectRow(rowIdx) : undefined}
    >
      <td className="px-2 py-1 tabular-nums text-slate-400">
        {onSelectRow ? (
          <button
            type="button"
            aria-label={ko.dataset.selectRowAria(rowIdx + 1)}
            aria-pressed={selected}
            className="tabular-nums hover:underline"
            onClick={(e) => {
              e.stopPropagation();
              onSelectRow(rowIdx);
            }}
          >
            {rowIdx + 1}
          </button>
        ) : (
          rowIdx + 1
        )}
      </td>
      {columns.map((c) => (
        <td key={c} className="max-w-xs truncate px-2 py-1" title={row[c] ?? ""}>
          {row[c] ?? ""}
        </td>
      ))}
    </tr>
  );
})}
```

`ko.ts`의 `dataset` 객체에 `selectRowAria: (n: number) => \`행 ${n} 선택\`,` 추가.

- [ ] **Step 4: GREEN 확인** — `pnpm test DatasetRowsPreview` 전부 PASS(기존 무수정 포함).

- [ ] **Step 5: Commit** — `git add ui/src/components/datasets/DatasetRowsPreview.tsx ui/src/components/datasets/__tests__/DatasetRowsPreview.test.tsx ui/src/i18n/ko.ts` 후 `git commit -m "feat(ui): DatasetRowsPreview 행 선택 additive prop (R12)"`.

---

### Task 6: UI — `TraceStepList` 추출 + `SequentialRunPanel` (R13)

**Files:**
- Create: `ui/src/components/scenario/__tests__/SequentialRunPanel.test.tsx`
- Create: `ui/src/components/scenario/SequentialRunPanel.tsx`
- Modify: `ui/src/components/scenario/TestRunPanel.tsx` (`TraceStepList` export 추출 — byte-identical 재구성)
- Modify: `ui/src/i18n/ko.ts` (`ko.editor` 키 6개)

**Interfaces:**
- Consumes: Task 4 `SequentialTrace`; 기존 `TestRunPanel`의 private `HttpRow`/`IfRow`.
- Produces (Task 7이 소비):

```tsx
// TestRunPanel.tsx에서 export
export function TraceStepList(props: {
  trace: ScenarioTrace;
  steps?: ReadonlyArray<Step>;
  onAddExtract?: (stepId: string, extract: Extract) => void;
}): JSX.Element;

// SequentialRunPanel.tsx
export function defaultExpandedRow(seq: SequentialTrace): number | null; // 첫 실패 행(없으면 첫 행)의 row_index
export function SequentialRunPanel(props: {
  seq: SequentialTrace;
  steps?: ReadonlyArray<Step>;
  requestedRows: number;            // 사용자 요청 구간 (truncated 경고 N)
  expandedRow: number | null;       // 펼친 행 row_index (부모 제어 — R14 칩 미러용 리프팅)
  onExpandRow: (rowIndex: number | null) => void;
  onAddExtract?: (stepId: string, extract: Extract) => void;
}): JSX.Element;
```

- ko 키(`ko.editor`): `seqResultTitle: "순차 검증 결과"` · `seqResultAria: "순차 검증 결과"` · `seqRowCount: (n: number) => \`${n}행\`` · `seqRowLabel: (n: number) => \`행 ${n}\``(n=1-based 표시) · `seqTruncated: (requested: number, done: number) => \`상한 도달로 ${requested}행 중 ${done}행만 실행됨\`` · `seqRowTruncated: "이 행은 상한 도달로 중간에 잘렸습니다"`.

- [ ] **Step 1: 실패하는 테스트 작성** — `SequentialRunPanel.test.tsx`:

```tsx
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SequentialTrace, StepTrace } from "../../../api/schemas";
import { SequentialRunPanel, defaultExpandedRow } from "../SequentialRunPanel";
import { ko } from "../../../i18n/ko";

function httpStep(url: string, error: string | null = null): StepTrace {
  return {
    step_id: "01HX0000000000000000000010",
    kind: "http",
    loop_index: null,
    branch: null,
    request: { method: "GET", url, headers: {}, body: null },
    response: error
      ? null
      : {
          status: 200,
          latency_ms: 3,
          download_ms: null,
          headers: {},
          set_cookies: [],
          body: "ok",
          body_truncated: false,
        },
    extracted: {},
    unbound_vars: [],
    error,
  };
}
function rowTrace(url: string, ok: boolean) {
  return {
    ok,
    total_ms: 7,
    steps: [httpStep(url, ok ? null : "boom")],
    final_vars: {},
    truncated: false,
    error: null,
  };
}
const seq: SequentialTrace = {
  ok: false,
  truncated: true,
  total_ms: 21,
  rows: [
    { row_index: 0, trace: rowTrace("http://x/a0", true) },
    { row_index: 1, trace: rowTrace("http://x/a1", false) },
    { row_index: 2, trace: rowTrace("http://x/a2", true) },
  ],
};

describe("defaultExpandedRow", () => {
  it("첫 실패 행을 고른다", () => {
    expect(defaultExpandedRow(seq)).toBe(1);
  });
  it("전부 성공이면 첫 행", () => {
    const green = { ...seq, rows: seq.rows.map((r) => ({ ...r, trace: { ...r.trace, ok: true } })) };
    expect(defaultExpandedRow(green)).toBe(0);
  });
  it("빈 rows면 null", () => {
    expect(defaultExpandedRow({ ...seq, rows: [] })).toBeNull();
  });
});

describe("SequentialRunPanel", () => {
  const noop = () => {};
  it("행 목록: 번호(1-based)·✓/✗·ms + truncated 경고 (R13)", () => {
    render(
      <SequentialRunPanel seq={seq} requestedRows={5} expandedRow={null} onExpandRow={noop} />,
    );
    const panel = screen.getByRole("region", { name: ko.editor.seqResultAria });
    expect(within(panel).getByRole("button", { name: /행 1/ })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: /행 2/ })).toBeInTheDocument();
    // truncated: 요청 5행 중 완료 3행
    expect(within(panel).getByText(ko.editor.seqTruncated(5, 3))).toBeInTheDocument();
  });
  it("expandedRow 행만 스텝 렌더 + 클릭 토글 콜백", async () => {
    const user = userEvent.setup();
    const onExpandRow = vi.fn();
    render(
      <SequentialRunPanel seq={seq} requestedRows={3} expandedRow={1} onExpandRow={onExpandRow} />,
    );
    // 펼친 행(행 2)의 스텝 URL 노출, 다른 행 URL 미노출
    expect(screen.getByText(/a1/)).toBeInTheDocument();
    expect(screen.queryByText(/a0/)).not.toBeInTheDocument();
    // 펼친 행 재클릭 → null(접기)
    await user.click(screen.getByRole("button", { name: /행 2/ }));
    expect(onExpandRow).toHaveBeenCalledWith(null);
    // 다른 행 클릭 → 그 행 row_index
    await user.click(screen.getByRole("button", { name: /행 3/ }));
    expect(onExpandRow).toHaveBeenCalledWith(2);
  });
});
```

- [ ] **Step 2: RED 확인** — `pnpm test SequentialRunPanel` → 모듈 미존재 실패.

- [ ] **Step 3: `TraceStepList` 추출** — `TestRunPanel.tsx`의 `TestRunPanel` 본문 중 스텝 리스트 부분(빈-스텝 문구 + `<ul>` 매핑)을 그대로 export 함수로 이동(문자열·클래스 byte-identical — 기존 하드코딩 한국어도 그대로 이동, 신규 문구 아님):

```tsx
/** trace.steps 행 리스트 — TestRunPanel 본문이자 순차 결과 행 펼침 공유 (R13). */
export function TraceStepList({
  trace,
  steps,
  onAddExtract,
}: {
  trace: ScenarioTrace;
  steps?: ReadonlyArray<Step>;
  onAddExtract?: (stepId: string, extract: Extract) => void;
}) {
  if (trace.steps.length === 0) {
    return <p className="text-sm text-slate-500">실행할 스텝이 없습니다.</p>;
  }
  return (
    <ul>
      {trace.steps.map((step, i) =>
        step.kind === "if" ? (
          <IfRow key={`${step.step_id}-${i}`} step={step} steps={steps} />
        ) : (
          <HttpRow key={`${step.step_id}-${i}`} step={step} onAddExtract={onAddExtract} />
        ),
      )}
    </ul>
  );
}
```

`TestRunPanel`의 해당 블록을 `<TraceStepList trace={trace} steps={steps} onAddExtract={onAddExtract} />`로 교체. `pnpm test TestRunPanel`로 기존 테스트 무수정 green 확인.

- [ ] **Step 4: `SequentialRunPanel` 구현** — `ui/src/components/scenario/SequentialRunPanel.tsx`:

```tsx
import type { SequentialTrace } from "../../api/schemas";
import type { Extract, Step } from "../../scenario/model";
import { Callout } from "../ui/Callout";
import { TraceStepList } from "./TestRunPanel";
import { ko } from "../../i18n/ko";

/** 순차 검증 기본 펼침 행: 첫 실패 행(없으면 첫 행)의 row_index (R13). */
export function defaultExpandedRow(seq: SequentialTrace): number | null {
  if (seq.rows.length === 0) return null;
  const failed = seq.rows.find((r) => !r.trace.ok);
  return (failed ?? seq.rows[0]).row_index;
}

export function SequentialRunPanel({
  seq,
  steps,
  requestedRows,
  expandedRow,
  onExpandRow,
  onAddExtract,
}: {
  seq: SequentialTrace;
  steps?: ReadonlyArray<Step>;
  requestedRows: number;
  expandedRow: number | null;
  onExpandRow: (rowIndex: number | null) => void;
  onAddExtract?: (stepId: string, extract: Extract) => void;
}) {
  const completed = seq.rows.filter((r) => !r.trace.truncated).length;
  return (
    <section
      aria-label={ko.editor.seqResultAria}
      className="rounded border border-slate-200 p-4"
    >
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-lg font-semibold">{ko.editor.seqResultTitle}</h3>
        <span
          className={`rounded px-2 py-0.5 text-xs font-semibold ${
            seq.ok ? "bg-emerald-200 text-emerald-900" : "bg-red-200 text-red-900"
          }`}
        >
          {seq.ok ? ko.editor.testRunOk : ko.editor.testRunFail}
        </span>
        <span className="text-xs text-slate-500">
          {seq.total_ms}ms · {ko.editor.seqRowCount(seq.rows.length)}
        </span>
      </div>
      {seq.truncated && (
        <Callout variant="warn" className="mb-2">
          {ko.editor.seqTruncated(requestedRows, completed)}
        </Callout>
      )}
      <ul>
        {seq.rows.map((r) => {
          const open = expandedRow === r.row_index;
          return (
            <li key={r.row_index} className="border-b border-slate-100 py-1">
              <button
                type="button"
                aria-expanded={open}
                onClick={() => onExpandRow(open ? null : r.row_index)}
                className="flex w-full items-center gap-2 text-left text-sm"
              >
                <span aria-hidden="true">{open ? "▾" : "▸"}</span>
                <span className="font-medium">{ko.editor.seqRowLabel(r.row_index + 1)}</span>
                <span
                  title={r.trace.ok ? ko.editor.testRunOk : ko.editor.testRunFail}
                  className={r.trace.ok ? "text-emerald-600" : "text-red-600"}
                >
                  {r.trace.ok ? "✓" : "✗"}
                </span>
                <span className="text-xs text-slate-500">{r.trace.total_ms}ms</span>
              </button>
              {open && (
                <div className="mt-1 pl-5">
                  {r.trace.truncated && (
                    <Callout variant="warn" className="mb-1">
                      {ko.editor.seqRowTruncated}
                    </Callout>
                  )}
                  <TraceStepList trace={r.trace} steps={steps} onAddExtract={onAddExtract} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
```

`ko.ts`의 `editor` 객체(기존 `testRun*` 키들 옆)에 위 Interfaces의 6개 키 추가.

- [ ] **Step 5: GREEN 확인** — `pnpm test SequentialRunPanel` + `pnpm test TestRunPanel` PASS.

- [ ] **Step 6: Commit** — `git add ui/src/components/scenario/TestRunPanel.tsx ui/src/components/scenario/SequentialRunPanel.tsx ui/src/components/scenario/__tests__/SequentialRunPanel.test.tsx ui/src/i18n/ko.ts` 후 `git commit -m "feat(ui): SequentialRunPanel 행 목록 + TraceStepList 추출 (R13)"`.

---

### Task 7: UI — `TestRunDatasetSection` + TestRunSection 배선 (R11, R14, R15)

**Files:**
- Create: `ui/src/components/scenario/__tests__/TestRunSection.dataset.test.tsx`
- Create: `ui/src/components/scenario/TestRunDatasetSection.tsx`
- Modify: `ui/src/components/scenario/TestRunSection.tsx`
- Modify: `ui/src/components/scenario/__tests__/TestRunSection.test.tsx` (**whole-module hooks mock 확장** — 아래 Step 4b)
- Modify: `ui/src/i18n/ko.ts` (`ko.editor` 키 19개)

**Interfaces:**
- Consumes: Task 4 `TestRunBody`/`TestRunDatasetConfig`/`useTestRunSequential`, Task 5 `DatasetRowsPreview` 선택 prop, Task 6 `SequentialRunPanel`/`defaultExpandedRow`; 기존 `useDatasets`(펼친 뒤에만 마운트 — 아래), `flattenHttpSteps`(`scenario/model.ts`), `Section`(`ui/Section.tsx` — `collapsible`/`hint`는 버튼 밖 형제 캐넌), `Select`/`Input` 프리미티브(폭은 래퍼 `<div className="w-24">` 이디엄).
- Produces:

```tsx
// TestRunDatasetSection.tsx
export type DatasetDraftState =
  | { kind: "ready"; config: TestRunDatasetConfig; requestedRows: number }
  | { kind: "incomplete"; reason: string };
export function TestRunDatasetSection(props: {
  onChange: (state: DatasetDraftState | null) => void; // null = 데이터셋 미선택(구성 없음)
  expectedLeafCount: number;  // R15: 정적 http leaf 수 (flattenHttpSteps().length)
  maxRequests: number;        // R15 힌트 비교값
}): JSX.Element;
```

- **useDatasets 마운트 게이트(기존 테스트 보호)**: `TestRunDatasetSection` 루트는 접힘 토글만 렌더하고 **본문(`{open && <Body/>}`)에서만 `useDatasets`를 호출** — 접힘 기본이라 기존 TestRunSection/ScenarioNewPage/ScenarioEditPage 테스트의 one-shot fetch 큐가 안 깨진다(`ui/CLAUDE.md` 무조건-훅 함정). 단 접힘 상태에서 구성 요약 힌트를 보여야 하므로 데이터셋 **이름은 선택 시점에 로컬 state로 캡처**(`selectedName`).
- ko 키(`ko.editor`): `dsSectionTitle: "데이터셋 (선택)"` · `dsSectionAria: "테스트 데이터셋 구성"` · `dsPickLabel: "데이터셋"` · `dsPickNone: "— 선택 안 함 —"` · `dsModeSingle: "특정 행"` · `dsModeSeq: "순차 검증"` · `dsRowNumLabel: "행 번호"` · `dsStartRowLabel: "시작 행"` · `dsRowLimitLabel: "행 수 (비움=전체)"` · `dsIncompleteRow: "행 번호를 선택하세요 — 미리보기에서 행을 클릭하거나 직접 입력"` · `dsIncompleteSeq: "시작 행/행 수 입력이 올바르지 않습니다"` · `dsMappingAuto: "매핑: 자동 (컬럼명=변수명)"` · `dsMappingEdit: "매핑 편집"` · `dsMappingAdd: "+ 매핑 추가"` · `dsMappingRemoveAria: (i: number) => \`매핑 삭제 ${i}\`` · `dsMappingColAria: (i: number) => \`매핑 컬럼 ${i}\`` · `dsMappingVarAria: (i: number) => \`매핑 변수 ${i}\`` · `dsSummary: (name: string, mode: string) => \`${name} · ${mode}\`` · `dsBudgetHint: (expected: number, max: number) => \`예상 요청 수 ${expected}개가 최대 요청 수 ${max}개를 넘어 일부 행만 실행될 수 있습니다\``.

- [ ] **Step 1: 실패하는 테스트 작성** — `TestRunSection.dataset.test.tsx`. **이 파일은 hooks를 모킹하지 않고 실훅 + URL 라우팅 fetch 스텁**으로 간다(기존 `TestRunSection.test.tsx`는 fetch가 아니라 **hooks 모듈 전체를 mock**하는 다른 아키텍처 — 그 파일 스타일을 미러하지 말 것; `jsonResponse` 헬퍼는 `DatasetRowsPreview.test.tsx:13-18` 형태를 복제):

```tsx
// URL 라우팅 fetch 스텁 — one-shot 큐 금지(무조건-훅 함정 회피). Response 생성은
// DatasetRowsPreview.test.tsx의 jsonResponse 헬퍼와 동일 형태를 이 파일에 복제.
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
const datasetsFixture = {
  datasets: [
    { id: "01JDS", name: "users", columns: ["username", "password"], row_count: 40, byte_size: 1, created_at: 1765500000000 },
  ],
};
const rowsFixture = {
  rows: Array.from({ length: 40 }, (_, i) => ({ username: `u${i}`, password: `p${i}` })).slice(0, 50),
  offset: 0,
  total: 40,
};
// 단발/시드 응답(ScenarioTrace)·순차 응답(SequentialTrace) fixture는 Task 4 테스트
// (testRunDataset.test.ts)의 trace/seq 객체를 이 파일에 복제해 사용 (와이어 1:1).
let testRunResponse: unknown; // 케이스별로 trace 또는 seq를 대입
const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.includes("/api/environments")) return jsonResponse({ environments: [] });
  if (url.includes("/api/datasets") && url.includes("/rows")) return jsonResponse(rowsFixture);
  if (url.includes("/api/datasets")) return jsonResponse(datasetsFixture);
  if (url.includes("/api/test-runs")) return jsonResponse(testRunResponse);
  throw new Error(`unexpected fetch ${url}`);
});
beforeEach(() => {
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});
// payload 단언 헬퍼: /test-runs 호출의 body를 파싱
function lastTestRunBody(): Record<string, unknown> {
  const call = fetchMock.mock.calls.findLast(([u]) => String(u).includes("/test-runs"));
  expect(call).toBeDefined();
  return JSON.parse((call![1] as RequestInit).body as string);
}
```

케이스(각각 `render(<QueryClientProvider…><TestRunSection yamlText={YAML} /></…>)`, YAML은 http 스텝 2개짜리 고정 fixture — leaf 수 2):

1. **기본 접힘 + 지연 fetch**: 토글 버튼(정확명 `데이터셋 (선택)`) 존재, `/api/datasets` fetch 미발생(`fetchMock` 호출 URL 목록 단언).
2. **single_row payload (R11)**: 펼침 → 데이터셋 선택 → 행 번호 입력 `18` → 실행 클릭 → `/test-runs` 요청 body 단언: `dataset.mode === "single_row"`, `bindings[0].row_index === 17`(1-based→0-based), `bindings[0]`에 `mappings` 키 **없음**, top-level `start_row`/`row_limit` 키 없음.
3. **sequential payload**: 모드 `순차 검증` → 시작 행 `2`·행 수 `5` → 실행 → body: `start_row === 1`, `row_limit === 5`; **빈 입력이면 두 키 absent**(별도 실행으로 단언).
4. **매핑 편집 정규화 (R11)**: `매핑 편집` 클릭(행 2개 시드: username/password) → 행 전부 삭제 → 실행 → `bindings[0]`에 `mappings` 키 없음(None 정규화). 반대로 var 하나를 `login_id`로 수정 후 실행 → `mappings`가 `[{kind:"column",var:"login_id",column:"username"},{kind:"column",var:"password",column:"password"}]`.
5. **incomplete 게이트**: single_row에서 행 미선택 → 실행 버튼 disabled + `dsIncompleteRow` 문구 표시.
6. **R15 힌트**: sequential·행 수 비움(=40행)·leaf 2 → 예상 80 > maxRequests 50 → `dsBudgetHint(80, 50)` 표시; 행 수 `10`(예상 20 ≤ 50) → 미표시.
7. **R14 칩 미러 + 기본 펼침**: `/test-runs` 응답을 seq fixture(행 2 실패)로 → 실행 → `SequentialRunPanel` 렌더 + 행 2가 펼쳐짐(`aria-expanded`) → 행 1 헤더 클릭 → 칩 스트립(`role="group"` `테스트 흐름` within)의 결과 표시가 바뀜을 단언(구체 칩 셀렉터는 `TestFlowChips.test.tsx`의 기존 결과 단언 패턴 재사용 — 실패 행 trace에선 ✗류 결과, 성공 행 trace에선 ✓류). **seq fixture의 `step_id`는 YAML fixture 스텝 id와 반드시 일치시킬 것** — 불일치면 `deriveChipResults`가 전부 미실행으로 떠 단언이 vacuous.

(스텝명 단언은 칩/아웃라인 다중매치 함정 — 칩은 반드시 스트립 within 스코프, `ui/CLAUDE.md`.)

- [ ] **Step 2: RED 확인** — `pnpm test TestRunSection.dataset` → 모듈/섹션 미존재 실패.

- [ ] **Step 3: `TestRunDatasetSection` 구현** — 상태: `open`(접힘 기본 false), `selected: { id: string; name: string; columns: string[]; rowCount: number } | null`(**선택 시점에 메타를 통째 캡처** — 접힘/본문 unmount 후에도 요약 힌트·derived 유지, `useDatasets`는 Body 안에서만), `mode: TestRunDatasetMode`(기본 `"single_row"`), `rowIndex: number | null`(0-based), `startRowDraft: string`, `rowLimitDraft: string`, `mappingRows: { column: string; var: string }[] | null`(null=자동). 아래 코드의 `datasetId`/`rowCount`는 `selected?.id ?? null`/`selected?.rowCount ?? 0` 파생.

파생·보고(부모 콜백은 latest-value ref — `onChangeRef` 이디엄, dep은 state 원자들만):

```tsx
const derived = useMemo<DatasetDraftState | null>(() => {
  if (datasetId == null) return null;
  const mappings =
    mappingRows && mappingRows.length > 0
      ? mappingRows.map((r) => ({ kind: "column" as const, var: r.var, column: r.column }))
      : undefined;
  if (mode === "single_row") {
    if (rowIndex == null) return { kind: "incomplete", reason: ko.editor.dsIncompleteRow };
    return {
      kind: "ready",
      requestedRows: 1,
      config: {
        mode,
        bindings: [{ dataset_id: datasetId, ...(mappings ? { mappings } : {}), row_index: rowIndex }],
      },
    };
  }
  const startN = startRowDraft.trim() === "" ? 0 : Math.floor(Number(startRowDraft)) - 1;
  const limitN = rowLimitDraft.trim() === "" ? null : Math.floor(Number(rowLimitDraft));
  if (!Number.isFinite(startN) || startN < 0 || (limitN != null && (!Number.isFinite(limitN) || limitN < 1))) {
    return { kind: "incomplete", reason: ko.editor.dsIncompleteSeq };
  }
  const remaining = Math.max(rowCount - startN, 0);
  return {
    kind: "ready",
    requestedRows: limitN ?? remaining,
    config: {
      mode,
      bindings: [{ dataset_id: datasetId, ...(mappings ? { mappings } : {}) }],
      ...(startRowDraft.trim() !== "" ? { start_row: startN } : {}),
      ...(limitN != null ? { row_limit: limitN } : {}),
    },
  };
}, [datasetId, mode, rowIndex, startRowDraft, rowLimitDraft, mappingRows, rowCount]);
useEffect(() => { onChangeRef.current(derived); }, [derived]);
```

(범위 밖 숫자 입력은 `dsIncompleteSeq` — 서버 422가 최종 방어. `datasetId`/`rowCount`/`selectedName`은 전부 `selected` 캡처 객체 파생 — Step 3 서두.)

구조:

```tsx
<Section
  variant="card"
  collapsible
  open={open}
  onToggle={() => setOpen((o) => !o)}
  title={ko.editor.dsSectionTitle}
  aria-label={ko.editor.dsSectionAria}
  hint={datasetId != null ? ko.editor.dsSummary(selectedName, mode === "single_row" ? ko.editor.dsModeSingle : ko.editor.dsModeSeq) : undefined}
>
  {open && <DatasetBody …controlled props… />}
</Section>
```

(참고: `Section`은 이미 `{(!collapsible || open) && children}`로 본문을 게이트하지만, `useDatasets`를 접힘 중 안 부르는 계약을 **명시적으로** 지키기 위해 훅은 Body 컴포넌트 내부에만 둔다.)

Body: `useDatasets()` 목록 → `<Select aria-label={ko.editor.dsPickLabel}>`(첫 옵션 `dsPickNone`) — 선택 변경 시 `rowIndex(null)`/`startRowDraft("")`/`rowLimitDraft("")`/`mappingRows(null)` 리셋 + `setSelected(meta 캡처)`. 모드 라디오(native input+label — accname 정확매치). single_row: 행 번호 `<Input type="number" min={1} …/>`(폭 `<div className="w-24">` 래퍼, 표시 1-based ↔ state 0-based) + `<DatasetRowsPreview datasetId name columns rowCount selectedRow={rowIndex ?? undefined} onSelectRow={setRowIndex} />`. sequential: 시작 행·행 수 Input(각 w-24 래퍼) + `dsBudgetHint`(derived ready && `requestedRows * expectedLeafCount > maxRequests`일 때 `<span className="text-xs text-amber-700">`). 매핑: `mappingRows === null`이면 `dsMappingAuto` 요약 + `dsMappingEdit` 버튼(클릭 시 columns로 same-name 행 시드), 아니면 행 목록(컬럼 `<Select aria-label={dsMappingColAria(i)}>` + 변수 `<Input aria-label={dsMappingVarAria(i)}>` + 삭제 버튼 `aria-label={dsMappingRemoveAria(i)}`) + `dsMappingAdd` 버튼(첫 컬럼 same-name 행 추가). **마지막 행 삭제 시 `setMappingRows(null)`(자동 복귀 — R11 None 정규화)**. 빈 var/column 매핑 행은 클라 게이트 없이 서버 422 배너가 유일 방어 — **의도된 수용**(범위 밖 숫자와 동급, incomplete 게이트는 single_row 행 미선택만).

- [ ] **Step 4: TestRunSection 배선** — `TestRunSection.tsx`:

```tsx
const testRunSeq = useTestRunSequential();
const [dsState, setDsState] = useState<DatasetDraftState | null>(null);
const [expandedRow, setExpandedRow] = useState<number | null>(null);
const [seqRequested, setSeqRequested] = useState(0);
const leafCount = useMemo(() => flattenHttpSteps(traceSteps).length, [traceSteps]);
const isPending = testRun.isPending || testRunSeq.isPending;
const dsIncomplete = dsState?.kind === "incomplete";

const fire = () => {
  if (isPending || dsIncomplete) return;
  setAddedNote(null);
  const base: TestRunBody = {
    scenario_yaml: yamlText,
    env: resolveEnv(baseVars, envEntries),
    max_requests: maxRequests,
    apply_think_time: applyThinkTime,
  };
  if (dsState?.kind === "ready" && dsState.config.mode === "sequential") {
    testRun.reset();
    setSeqRequested(dsState.requestedRows);
    testRunSeq.mutate(
      { ...base, dataset: dsState.config },
      { onSuccess: (s) => setExpandedRow(defaultExpandedRow(s)) },
    );
  } else {
    testRunSeq.reset();
    testRun.mutate({ ...base, ...(dsState?.kind === "ready" ? { dataset: dsState.config } : {}) });
  }
};
```

- 칩 미러(R14): `const seqData = testRunSeq.data ?? null;` →

```tsx
const chipTrace = seqData
  ? (seqData.rows.find((r) => r.row_index === expandedRow)?.trace ?? null)
  : (testRun.data ?? null);
```

`<TestFlowChips trace={chipTrace} …/>`로 교체(기존 `testRun.data ?? null` 대체 — dataset 미사용 시 등가).
- 섹션 배치: `<EnvironmentPicker …/>` 아래에 `<TestRunDatasetSection onChange={setDsState} expectedLeafCount={leafCount} maxRequests={maxRequests} />`.
- 실행 버튼: `disabled={isPending || dsIncomplete}` + `{dsIncomplete && <span className="text-xs text-amber-700">{dsState.reason}</span>}`.
- 에러 배너: `{(testRun.error ?? testRunSeq.error) && <Callout variant="error">{((testRun.error ?? testRunSeq.error) as Error).message}</Callout>}`.
- 결과: 기존 `{testRun.data && <TestRunPanel …/>}` 유지 + 추가

```tsx
{seqData && (
  <SequentialRunPanel
    seq={seqData}
    steps={traceSteps}
    requestedRows={seqRequested}
    expandedRow={expandedRow}
    onExpandRow={setExpandedRow}
    onAddExtract={(stepId, extract) => {
      useScenarioEditor.getState().addStepExtract(stepId, extract);
      setAddedNote(`추출 추가됨 — ${extract.var} (Inspector·YAML에서 확인)`);
    }}
  />
)}
```

- [ ] **Step 4b: 기존 `TestRunSection.test.tsx` 모듈 mock 확장 (필수 — 안 하면 그 파일 전 케이스 사망)** — 그 파일은 hooks 모듈을 **비-spread whole-module mock**(`vi.mock("../../../api/hooks", () => ({ useTestRun, useEnvironment, useEnvironments, … }))`, `:15-19`)하므로 배선된 TestRunSection이 무조건 호출하는 신규 훅이 `undefined`가 된다. 두 가지 추가:

```ts
// vi.mock factory 반환 객체에 추가
useTestRunSequential: () => ({
  mutate: vi.fn(),
  isPending: false,
  error: null,
  data: undefined,
  reset: vi.fn(),
}),
```

그리고 기존 `useTestRun` 스텁 반환 객체에 `reset: vi.fn()` 추가 — 신규 `fire()`가 비-dataset 경로에서 `testRunSeq.reset()`, sequential 경로에서 `testRun.reset()`을 호출하기 때문(기존 케이스들은 비-dataset 경로만 타지만 두 스텁 다 갖춰 대칭). **케이스 본문은 무수정** — mock factory만 확장.

- [ ] **Step 5: GREEN 확인** — `pnpm test TestRunSection.dataset` PASS + `pnpm test TestRunSection`(Step 4b mock 확장 반영 — 케이스 본문 무수정) green + `pnpm test ScenarioNewPage`·`pnpm test ScenarioEditPage` **무수정** green(페이지 테스트는 `TestRunSection`을 null 스텁하거나 실훅+URL 라우팅 fetch라 안전; 접힘 기본이라 `/api/datasets` fetch 0).

- [ ] **Step 6: 전체 UI 게이트** — `cd ui && pnpm lint && pnpm test && pnpm build` (targeted-green ≠ full-green).

- [ ] **Step 7: Commit** — `git add ui/src/components/scenario/TestRunDatasetSection.tsx ui/src/components/scenario/TestRunSection.tsx ui/src/components/scenario/__tests__/TestRunSection.dataset.test.tsx ui/src/components/scenario/__tests__/TestRunSection.test.tsx ui/src/i18n/ko.ts` 후 `git commit -m "feat(ui): test-run 데이터셋 접이식 섹션 + 순차 결과·칩 미러 배선 (R11/R14/R15)"`.

---

## 최종 게이트·라이브 검증 (plan 밖 파이프라인 단계 — 참고)

- **최종 리뷰**: `handicap-reviewer` (와이어 1:1 — Rust `RowsTrace`/`Mapping` serde ↔ UI Zod/타입 필드명 대조 필수) + **`security-reviewer` 필수 예상**(diff가 env/데이터셋 바인딩·trace/body 뷰어를 건드림 — finish-slice §0 grep이 매치할 것; 데이터셋 값 평문 노출은 §B1 소유·기결정, spec §7).
- **라이브 검증**: `/live-verify` + spec §6 도그푸딩 체크리스트(US1–US4) — 로깅 echo 서버(번들 `responder.py`는 요청을 안 찍음 — 로깅 변형), US4는 실제 run 대조라 `cargo build -p handicap-worker --bin worker` 선행 + run엔 자동 실체화와 동일 집합의 **명시 매핑** 지정(run 와이어에 자동 규약 없음). curl로 R2/R7/R8/R16 왕복(응답을 UI 스키마로 파싱) + 대표 422 1건.
- **기록**: build-log 한 단락 append·CLAUDE.md 상태줄 교체(Python 스플라이스)·roadmap-status frontier 전진 — `/finish-slice`가 체크리스트.
