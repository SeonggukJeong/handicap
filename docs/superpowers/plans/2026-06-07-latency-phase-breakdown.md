# 레이턴시 단계 분해 (TTFB + 다운로드) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 각 HTTP 스텝의 응답 시간을 TTFB(=기존 latency, 무변경) + 본문 다운로드(신규) 2 phase로 분해해 per-step 리포트에 노출하되, opt-in(`Profile.measure_phases`, 기본 off → off면 byte-identical)으로 켤 때만 측정·저장한다.

**Architecture:** A2-2 `group_stats`(parallel 페이지-로드 HDR) 파이프라인을 `phase`-키 일반 채널로 재사용한다. 엔진 `executor`가 `bytes().await` 구간을 재서 `ExecOutcome.download`로 반환 → opt-in 시 `aggregator.record_phase(step_id,"download",us)` → `MetricFlush.phase_stats`(drain 4곳/guard 3곳) → proto `MetricBatch.phase_stats=8` → 워커 HDR forward → migration 0013 `run_phase_metrics`(append-only read-merge) → `build_report` 7번째 param이 step_id별 merge → `ReportStep.download` → UI StepStatsTable 컬럼. 기존 핫 per-window 파이프라인 완전 무변경.

**Tech Stack:** Rust(engine/proto/worker/controller, tokio, hdrhistogram, sqlx, prost), TypeScript/React(Zod, vitest, RTL).

**Spec:** `docs/superpowers/specs/2026-06-07-latency-phase-breakdown-design.md` (reviewer 반영본).

---

## 게이트 / 커밋 규칙 (전역)

- **pre-commit 훅이 비-`.md` 커밋마다 `cargo fmt --check + build --workspace + clippy -D warnings + test --workspace`를 돈다(수 분).** 각 task = **하나의 green 커밋**(컴파일+테스트 통과). 커밋은 `run_in_background:false` 단일 호출, 폴링 금지. 커밋 후 `git log -1`로 landed 확인(파이프 금지 — exit code 마스킹).
- **cold-build flake**: 커밋 전 `cargo build -p handicap-worker && cargo build --workspace`로 warm. flake(`worker` ENOENT/sig 9/15)면 동일 커밋 warm 재시도.
- **UI 커밋**도 cargo 훅을 다 거치지만 UI 게이트(`cd ui && pnpm lint && pnpm test && pnpm build`)는 훅이 안 돈다 — UI task는 커밋 전 셋 다 수동.
- **prost/struct 리터럴은 exhaustive**: proto 필드·`RunPlan`/`MetricFlush` 필드 추가 시 컴파일러가 모든 리터럴을 강제 → `grep -rn "<Type> {" crates/`로 전수 갱신.

---

## Task 1: 엔진 — executor 다운로드 측정 + aggregator phase 채널

**Files:**
- Modify: `crates/engine/src/executor.rs` (ExecOutcome:41-48, execute_step:99-227)
- Modify: `crates/engine/src/aggregator.rs` (GroupStat 패턴:39-58, Aggregator:107-238)

- [ ] **Step 1: aggregator에 `PhaseStat` + record/drain 테스트 작성 (RED)**

`crates/engine/src/aggregator.rs`의 `#[cfg(test)] mod tests`에 추가:

```rust
    #[test]
    fn record_phase_accumulates_and_drains_as_delta() {
        let mut a = Aggregator::new(0); // cap irrelevant to phase latency
        a.record_phase("s1", "download", 100_000); // 100 ms
        a.record_phase("s1", "download", 300_000); // 300 ms
        a.record_phase("s2", "download", 50_000);
        let mut by: std::collections::HashMap<(String, String), (u64, u64)> = Default::default();
        for p in a.drain_phase_deltas() {
            by.insert((p.step_id.clone(), p.phase.clone()), (p.count, p.histogram.max()));
        }
        assert_eq!(by.get(&("s1".into(), "download".into())).map(|x| x.0), Some(2));
        assert_eq!(by.get(&("s2".into(), "download".into())).map(|x| x.0), Some(1));
        assert!(by[&("s1".into(), "download".into())].1 >= 290_000);
        assert!(a.drain_phase_deltas().is_empty(), "drain resets phase hists");
    }

    #[test]
    fn phase_stat_serializes_histogram() {
        let mut a = Aggregator::new(0);
        a.record_phase("s1", "download", 12_345);
        let p = a.drain_phase_deltas().pop().expect("one phase stat");
        assert!(!p.serialize_histogram().expect("serializes").is_empty());
    }
```

- [ ] **Step 2: RED 확인**

Run: `cargo test -p handicap-engine aggregator 2>&1 | tail -20`
Expected: FAIL — `record_phase`/`drain_phase_deltas`/`PhaseStat` not found.

- [ ] **Step 3: aggregator에 phase 채널 구현 (GroupStat 미러 + phase 키)**

`crates/engine/src/aggregator.rs`의 `GroupStat`(48행) 블록 **뒤**에 추가:

```rust
/// A per-(step_id, phase) latency delta since the last drain. HDR (not counts) —
/// merged by the controller via `Histogram::add` (like `GroupStat`). v1 only ever
/// records phase = "download" (response-body download time); the `phase` key leaves
/// room for DNS/TCP/TLS/total later with no schema change (spec §4.2).
#[derive(Debug)]
pub struct PhaseStat {
    pub step_id: String,
    pub phase: String,
    pub histogram: Histogram<u64>,
    pub count: u64,
}

impl PhaseStat {
    pub fn serialize_histogram(&self) -> Result<Vec<u8>> {
        let mut buf = Vec::new();
        let mut ser = V2Serializer::new();
        ser.serialize(&self.histogram, &mut buf)
            .map_err(|e| EngineError::Histogram(e.to_string()))?;
        Ok(buf)
    }
}
```

`Aggregator` 구조체(108행)에 필드 추가 (group_hists 옆):

```rust
    /// per-(step_id, phase) accumulating latency-phase HDR + sample count (B7-C).
    phase_hists: HashMap<(String, String), (Histogram<u64>, u64)>,
```

`Aggregator::new`(118행)의 리터럴에 추가:

```rust
            phase_hists: HashMap::new(),
```

`drain_group_deltas`(212행) **뒤**에 메서드 2개 추가:

```rust
    /// Record one latency-phase sample (µs) for (step_id, phase). HDR-accumulating,
    /// unconditional (no cap) — the caller (runner) gates on `measure_phases`.
    pub fn record_phase(&mut self, step_id: &str, phase: &str, latency_us: u64) {
        let v = latency_us.clamp(1, 60_000_000);
        let e = self
            .phase_hists
            .entry((step_id.to_string(), phase.to_string()))
            .or_insert_with(|| {
                (
                    Histogram::<u64>::new_with_bounds(1, 60_000_000, 3).expect("valid bounds"),
                    0,
                )
            });
        let _ = e.0.record(v);
        e.1 += 1;
    }

    /// Take and reset the accumulated per-(step_id, phase) histograms as deltas
    /// (the controller merges them via Histogram::add). Histograms returned live.
    pub fn drain_phase_deltas(&mut self) -> Vec<PhaseStat> {
        std::mem::take(&mut self.phase_hists)
            .into_iter()
            .map(|((step_id, phase), (histogram, count))| PhaseStat {
                step_id,
                phase,
                histogram,
                count,
            })
            .collect()
    }
```

선택(일관성): `crates/engine/src/lib.rs:15`의 `pub use aggregator::{Aggregator, BranchStat, GroupStat, LoopStat, StepWindow};`에 `PhaseStat` 추가(GroupStat 미러). `aggregator`가 이미 `pub mod`라 Task 2 테스트의 `handicap_engine::aggregator::PhaseStat` import는 이것 없이도 동작하지만, GroupStat과 노출 방식을 맞춘다.

- [ ] **Step 4: aggregator 테스트 GREEN 확인**

Run: `cargo test -p handicap-engine aggregator 2>&1 | tail -20`
Expected: PASS (신규 2개 포함).

- [ ] **Step 5: executor download 측정 테스트 작성 (RED)**

`crates/engine/src/executor.rs`의 `#[cfg(test)] mod tests`에 추가 (`MockServer` 패턴은 기존 테스트 차용):

```rust
    #[tokio::test]
    async fn execute_step_measures_download_on_success() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/dl"))
            .respond_with(ResponseTemplate::new(200).set_body_string("x".repeat(2048)))
            .mount(&server)
            .await;
        let step = HttpStep {
            id: "01HX0000000000000000000041".into(),
            name: "dl".into(),
            request: Request {
                method: HttpMethod::Get,
                url: format!("{}/dl", server.uri()),
                headers: BTreeMap::new(),
                body: None,
                disabled: DisabledRows::default(),
            },
            assert: vec![],
            extract: vec![],
            timeout_seconds: None,
            think_time: None,
        };
        let vars = BTreeMap::new();
        let env = empty_env();
        let ctx = TemplateContext { vars: &vars, env: &env, vu_id: 0, iter_id: 0, loop_index: None };
        let client = VuClient::new(crate::scenario::CookieJarMode::Off).unwrap();
        let outcome = execute_step(&client, &step, &ctx).await.unwrap();
        assert_eq!(outcome.status, 200);
        assert!(outcome.download.is_some(), "download phase measured on success");
    }

    #[tokio::test]
    async fn execute_step_no_download_on_connection_error() {
        let step = HttpStep {
            id: "01HX0000000000000000000042".into(),
            name: "down".into(),
            request: Request {
                method: HttpMethod::Get,
                url: "http://127.0.0.1:1/nope".into(), // refused fast — never reaches body
                headers: BTreeMap::new(),
                body: None,
                disabled: DisabledRows::default(),
            },
            assert: vec![],
            extract: vec![],
            timeout_seconds: None,
            think_time: None,
        };
        let vars = BTreeMap::new();
        let env = empty_env();
        let ctx = TemplateContext { vars: &vars, env: &env, vu_id: 0, iter_id: 0, loop_index: None };
        let client = VuClient::new(crate::scenario::CookieJarMode::Off).unwrap();
        let outcome = execute_step(&client, &step, &ctx).await.unwrap();
        assert_eq!(outcome.status, 0);
        assert!(outcome.download.is_none(), "no download phase on transport failure");
    }
```

- [ ] **Step 6: RED 확인**

Run: `cargo test -p handicap-engine executor::tests::execute_step_measures_download 2>&1 | tail`
Expected: FAIL — `download` field missing on `ExecOutcome`.

- [ ] **Step 7: ExecOutcome.download + execute_step 측정 구현**

`ExecOutcome`(41행)에 필드 추가:

```rust
#[derive(Debug, Clone)]
pub struct ExecOutcome {
    pub step_id: String,
    pub status: u16,
    pub latency: Duration,
    /// Body-download time (headers-received → body-complete). `Some` only on the
    /// success path (`bytes().await` reached); `None` on transport failure. TTFB is
    /// `latency` (measured at `send().await`, before body). Phase-breakdown (B7-C).
    pub download: Option<Duration>,
    pub error: Option<String>,
    pub extracted: BTreeMap<String, String>,
}
```

`execute_step`의 success arm: `let body_bytes = match resp.bytes().await {`(173행)를 `Instant`로 감싼다:

```rust
            let dl_start = Instant::now();
            let body_bytes = match resp.bytes().await {
                Ok(b) => b,
                Err(e) => {
                    return Ok(ExecOutcome {
                        step_id: step.id.clone(),
                        status,
                        latency,
                        download: None, // body read failed → no clean download sample
                        error: Some(format!("read body: {e}")),
                        extracted: BTreeMap::new(),
                    });
                }
            };
            let download = Some(dl_start.elapsed());
```

성공 `Ok(ExecOutcome { ... })`(211행)에 `download,` 추가. send-error arm(219행) `Ok(ExecOutcome { ... status: 0, ... })`에 `download: None,` 추가. (총 3개 ExecOutcome 리터럴.)

- [ ] **Step 8: 전체 엔진 테스트 GREEN 확인**

Run: `cargo test -p handicap-engine 2>&1 | tail -20`
Expected: PASS (executor + aggregator 신규 포함; 기존 ExecOutcome 소비처는 field 접근만이라 무영향).

- [ ] **Step 9: warm + 커밋**

```bash
cargo build -p handicap-worker && cargo build --workspace
git add crates/engine/src/executor.rs crates/engine/src/aggregator.rs
git commit -m "feat(engine): executor 다운로드 측정(ExecOutcome.download) + aggregator phase 채널(record_phase/drain_phase_deltas)"
git log -1 --oneline
```

---

## Task 2: 엔진 — runner 배선 (RunPlan.measure_phases + MetricFlush.phase_stats + 게이트 기록 + drain/guard)

**Files:**
- Modify: `crates/engine/src/runner.rs` (RunPlan:33-64, MetricFlush:69-78, run_scenario flush:180-251, execute_steps:362-545, run_vu:282-331, open-loop flush:629-807, run_arrival:850-863)
- Modify: `crates/worker/src/main.rs` (RunPlan build:186-225 — placeholder `false`, Task 3에서 wire)
- Test: `crates/engine/tests/` (신규 또는 기존 통합 테스트)

> **주의(컴파일러-강제)**: `RunPlan`에 non-Option 필드를 더하면 모든 `RunPlan { … }` 리터럴(~31곳, engine 테스트 + worker)이 "missing field"로 깨진다. `MetricFlush`도 동일. 이 task는 그 전수 갱신을 포함한다.

- [ ] **Step 1: 게이트 통합 테스트 작성 (RED)** — `crates/engine/tests/phase_breakdown.rs` 신규:

```rust
use std::sync::Arc;
use std::time::Duration;

use handicap_engine::aggregator::PhaseStat;
use handicap_engine::runner::{MetricFlush, RunPlan, run_scenario};
use handicap_engine::scenario::Scenario;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn plan(measure_phases: bool) -> RunPlan {
    RunPlan {
        vus: 2,
        ramp_up: Duration::from_secs(0),
        duration: Duration::from_millis(400),
        env: Default::default(),
        loop_breakdown_cap: 0,
        vu_offset: 0,
        data_binding: None,
        http_timeout: Duration::from_secs(30),
        think_time: None,
        think_seed: None,
        target_rps: None,
        max_in_flight: None,
        stages: None,
        measure_phases,
    }
}

async fn collect_phases(measure_phases: bool) -> Vec<PhaseStat> {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/p"))
        .respond_with(ResponseTemplate::new(200).set_body_string("payload"))
        .mount(&server)
        .await;
    let yaml = format!(
        "version: 1\nname: t\nsteps:\n  - id: 01HX0000000000000000000051\n    type: http\n    name: g\n    request:\n      method: GET\n      url: {}/p\n",
        server.uri()
    );
    let scenario = Arc::new(Scenario::from_yaml(&yaml).unwrap());
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(32);
    let h = tokio::spawn(run_scenario(scenario, plan(measure_phases), tx, CancellationToken::new()));
    let mut phases = Vec::new();
    while let Some(f) = rx.recv().await {
        phases.extend(f.phase_stats);
    }
    h.await.unwrap().unwrap();
    phases
}

#[tokio::test]
async fn measure_phases_on_records_download_deltas() {
    let phases = collect_phases(true).await;
    assert!(phases.iter().any(|p| p.phase == "download" && p.count > 0),
        "expected download phase deltas when measure_phases=true");
}

#[tokio::test]
async fn measure_phases_off_records_nothing() {
    assert!(collect_phases(false).await.is_empty(),
        "no phase deltas when measure_phases=false (byte-identical)");
}
```

- [ ] **Step 2: RED 확인**

Run: `cargo test -p handicap-engine --test phase_breakdown 2>&1 | tail -20`
Expected: FAIL — `RunPlan` has no `measure_phases`, `MetricFlush` has no `phase_stats`.

- [ ] **Step 3: RunPlan + MetricFlush 필드 추가**

`RunPlan`(63행 `stages` 뒤)에:

```rust
    /// Opt-in latency-phase breakdown (B7-C). `true` → the Http arm records the
    /// download phase via `Aggregator::record_phase`. `false` → byte-identical (no
    /// phase channel touched). Default false at every absent boundary.
    pub measure_phases: bool,
```

`MetricFlush`(74행 `group_stats` 뒤)에:

```rust
    /// Per-(step_id, phase) latency-phase deltas since the last flush (B7-C).
    pub phase_stats: Vec<PhaseStat>,
```

import에 `PhaseStat` 추가 (14행): `use crate::aggregator::{Aggregator, BranchStat, GroupStat, LoopStat, PhaseStat, StepWindow};`

- [ ] **Step 4: execute_steps에 measure_phases 스레드 + Http arm 기록**

`execute_steps`(363행) 시그니처 마지막 param 추가:

```rust
    rng: &mut StdRng,
    measure_phases: bool,
) -> Result<StepFlow> {
```

Http arm(394-403행)의 aggregator 블록을 교체:

```rust
                {
                    let mut a = agg.lock().await;
                    a.record(
                        &outcome.step_id,
                        outcome.latency.as_micros().min(u64::MAX as u128) as u64,
                        outcome.status,
                        outcome.error.is_some(),
                        loop_index,
                    );
                    if measure_phases {
                        if let Some(dl) = outcome.download {
                            a.record_phase(
                                &outcome.step_id,
                                "download",
                                dl.as_micros().min(u64::MAX as u128) as u64,
                            );
                        }
                    }
                } // drop the aggregator guard before the (possibly long) think-time sleep
```

재귀 `execute_steps` 호출 **3곳** 마지막 인자에 `measure_phases` 추가:
- Loop arm `Box::pin(execute_steps(... rng,))` → `... rng, measure_phases,` (420행)
- If arm `Box::pin(execute_steps(... cancel, rng,))` → `... cancel, rng, measure_phases,` (464행)
- Parallel arm 분기 future 안 `Box::pin(execute_steps(... &mut branch_rng,))` → `... &mut branch_rng, measure_phases,` (488행)

- [ ] **Step 5: run_vu / run_arrival가 measure_phases를 받아 전달**

`run_vu`(282행) 시그니처 마지막 param 추가 `think_seed: Option<u32>,` 뒤:

```rust
    think_seed: Option<u32>,
    measure_phases: bool,
) -> Result<()> {
```

`run_vu` 안 `execute_steps(...)` 호출(318행) 마지막 인자 `&mut think_rng,` 뒤 `measure_phases,` 추가.

`run_scenario`의 `run_vu(...)` spawn 호출(144행) `think_seed,` 뒤 `plan.measure_phases`를 전달 — 단 `plan`은 move되므로 루프 전에 `let measure_phases = plan.measure_phases;`(94행 근처 `let think_seed = ...` 옆)로 캡처하고 클로저에 `let measure_phases = measure_phases;`처럼 Copy로 넘긴다. 호출 인자: `... think_seed, measure_phases,`.

`run_arrival`(820행) 시그니처 마지막 param 추가 `exhausted: &AtomicBool,` 뒤:

```rust
    exhausted: &AtomicBool,
    measure_phases: bool,
) -> Result<()> {
```

`run_arrival` 안 `execute_steps(...)` 호출(850행) 마지막 인자 `cancel, rng,` 뒤 `measure_phases,` 추가.

`run_scenario_open_loop`의 `run_arrival(...)` spawn 호출(748행): 루프 전 `let measure_phases = plan.measure_phases;`(588행 `let think_seed = ...` 옆) 캡처 후 클로저로 Copy 전달, 호출 인자 `... &exhausted, measure_phases,`.

- [ ] **Step 6: phase_stats drain 4곳 + send-guard 3곳**

**closed-loop periodic flusher**(180-214행): drain 튜플에 `g.drain_phase_deltas()` 추가, guard에 `|| !phase_stats.is_empty()` 추가, `MetricFlush{}`에 `phase_stats,` 추가:

```rust
            let (drained, loop_stats, branch_stats, group_stats, phase_stats) = {
                let mut g = flush_agg.lock().await;
                (
                    g.drain_completed(now_s),
                    g.drain_loop_deltas(),
                    g.drain_branch_deltas(),
                    g.drain_group_deltas(),
                    g.drain_phase_deltas(),
                )
            };
            if !drained.is_empty()
                || !loop_stats.is_empty()
                || !branch_stats.is_empty()
                || !group_stats.is_empty()
                || !phase_stats.is_empty()
            {
                // debug!(...) 기존 유지
                if flush_out
                    .send(MetricFlush { windows: drained, loop_stats, branch_stats, group_stats, phase_stats, dropped: 0 })
                    .await
                    .is_err()
                { break; }
            }
```

**closed-loop final**(228-251행): drain 튜플 + guard + `MetricFlush{}`에 `final_phases`/`phase_stats` 동형 추가 (`g.drain_phase_deltas()` → `final_phases`, guard에 `|| !final_phases.is_empty()`, 리터럴 `phase_stats: final_phases,`).

**open-loop periodic**(629-663행): drain 튜플에 `g.drain_phase_deltas()`(→ `phase_stats`), `has_data`에 `|| !phase_stats.is_empty()`, `MetricFlush{}`에 `phase_stats,`.

**open-loop final**(790-807행): drain 튜플에 `g.drain_phase_deltas()`(→ `final_phases`), **guard 없음**(open-final은 dropped 무조건 송신), `MetricFlush{}`에 `phase_stats: final_phases,`.

> 검증: drain 호출 4곳, `MetricFlush {` 리터럴 4곳 모두 `phase_stats` 채움, send-guard 3곳(closed periodic·closed final·open periodic).

- [ ] **Step 7: 모든 `RunPlan {}` / `MetricFlush {}` 테스트 리터럴 갱신**

Run: `grep -rn "RunPlan {" crates/ | grep -v "pub struct"` → 각 리터럴(engine 단위/통합 테스트 + `crates/worker/src/main.rs:186`)에 `measure_phases: false,` 추가. worker는 이 task에선 **placeholder `false`**(Task 3에서 `profile.measure_phases`로 wire).

Run: `grep -rn "MetricFlush {" crates/` → drain으로 안 채워지는 테스트 리터럴이 있으면 `phase_stats: vec![],` 추가.

- [ ] **Step 8: GREEN 확인**

Run: `cargo test -p handicap-engine --test phase_breakdown 2>&1 | tail` → PASS.
Run: `cargo build --workspace 2>&1 | tail` → 0 errors (worker placeholder 포함).
Run: `cargo test -p handicap-engine 2>&1 | tail -20` → 기존 전부 PASS.

- [ ] **Step 9: warm + 커밋**

```bash
cargo build -p handicap-worker && cargo build --workspace
git add crates/engine/src/runner.rs crates/engine/tests/phase_breakdown.rs crates/worker/src/main.rs
git add -A  # 갱신된 RunPlan 리터럴이 여러 테스트 파일에 분산 — 변경분만 (git status로 확인 후)
git commit -m "feat(engine): RunPlan.measure_phases 게이트 + MetricFlush.phase_stats(drain 4/guard 3) + execute_steps 스레드"
git log -1 --oneline
```

> `git add -A` 전 `git status`로 의도한 파일만 staged인지 확인(tdd keepalive·임시 stub 없는지).

---

## Task 3: proto + store Profile + 워커 forward/wire

**Files:**
- Modify: `crates/proto/proto/coordinator.proto` (GroupStat:45-49, MetricBatch:51-59, Profile:116-127)
- Modify: `crates/controller/src/store/runs.rs` (Profile:93-117)
- Modify: `crates/controller/src/api/runs.rs` (pb::Profile literal:313-336)
- Modify: `crates/worker/src/main.rs` (forward block:279-318, RunPlan build:191)

- [ ] **Step 1: proto 메시지/필드 추가**

`crates/proto/proto/coordinator.proto`의 `GroupStat`(49행) 뒤:

```proto
message PhaseStat {
  string step_id = 1;
  string phase = 2;          // v1: "download" only (room for dns/tcp/tls/total later)
  bytes hdr_histogram = 3;   // hdrhistogram V2 serialized (delta since last drain)
  uint64 count = 4;
}
```

`MetricBatch`(58행 `group_stats = 7;` 뒤)에:

```proto
  repeated PhaseStat phase_stats = 8;  // per-(step_id,phase) latency-phase breakdown (delta, controller merges)
```

`Profile`(126행 `stages = 10;` 뒤)에:

```proto
  bool measure_phases = 11;            // opt-in latency-phase breakdown (TTFB+download)
```

- [ ] **Step 2: store Profile에 measure_phases (serde default)**

`crates/controller/src/store/runs.rs`의 `Profile`(116행 `stages` 뒤)에:

```rust
    #[serde(default)]
    pub measure_phases: bool,
```

- [ ] **Step 3: api/runs.rs pb::Profile 변환에 매핑**

`crates/controller/src/api/runs.rs`의 `handicap_proto::v1::Profile { … }`(335행 `stages: …collect(),` 뒤)에:

```rust
            measure_phases: profile.measure_phases,
```

- [ ] **Step 4: 워커 — RunPlan wire + phase_stats forward**

`crates/worker/src/main.rs`:
- RunPlan build(191행 부근, Task 2의 placeholder)에서 `measure_phases: false` → `measure_phases: profile.measure_phases,`.
- forward block: group_stats serialize 블록(279-290행) **뒤**에 phase_stats 블록 추가 (proto 타입 import `PhaseStat` 필요 — 파일 상단 proto use에 추가):

```rust
            let phase_stats: Vec<PhaseStat> = flush
                .phase_stats
                .into_iter()
                .filter_map(|p| {
                    let hdr = p.serialize_histogram().ok()?;
                    Some(PhaseStat {
                        step_id: p.step_id,
                        phase: p.phase,
                        hdr_histogram: hdr,
                        count: p.count,
                    })
                })
                .collect();
```

- 빈-배치 송신가드(294-301행)에 `&& phase_stats.is_empty()` 추가.
- `MetricBatch { … }` 리터럴(303-311행)에 `phase_stats,` 추가.

> **(CRITICAL — 커밋 경계)** 이 task는 두 종류의 컴파일러-강제 리터럴을 모두 깬다:
> 1. **store `runs::Profile.measure_phases`(non-Option)** → 모든 `Profile { … }` 리터럴(serde default는 *역직렬화*만, 리터럴은 강제). 영향 파일(이 task Files에 추가): `api/runs.rs`(~20곳, in-scope), `src/report.rs:569`, `src/schedule/runner.rs:265`, `src/grpc/coordinator.rs:1000/1079/1103`, `tests/crash_recovery_test.rs:28`, `tests/dispatcher_subprocess_test.rs:53`, `tests/report_test.rs:72`, `tests/export_routes_test.rs:64/197/272`, `crates/proto/tests/run_assignment_env_test.rs:14/58`(full Profile literal — `..Default::default()` 없음). 각각 `measure_phases: false,` 추가.
> 2. **proto regen → `pb::MetricBatch {}` full 리터럴** → `src/grpc/coordinator.rs:1354/1387`에 `phase_stats: vec![],`. (worker `main.rs:489/496`은 `..Default::default()` spread라 안 깨짐 — SAFE.)
>
> 전수 audit: `grep -rn "Profile {" crates/ | grep -v "message Profile\|pub struct Profile\|fn "` 와 `grep -rn "MetricBatch {" crates/`. **이 task의 커밋은 `git add -A`(아래 `git status` 확인 후) — 영향 파일이 8+개 분산이라 명시 리스트는 누락 위험. landed 커밋이 컴파일돼야 하므로(pre-commit은 working dir, 게이트는 landed tree) 누락 0.**

- [ ] **Step 5: GREEN 확인**

Run: `cargo build --workspace 2>&1 | tail` → 0 errors.
Run: `cargo test --workspace 2>&1 | tail -20` → PASS (cold-build flake면 warm 재시도).

- [ ] **Step 6: warm + 커밋**

```bash
cargo build -p handicap-worker && cargo build --workspace   # 0 errors 확인 (모든 강제 리터럴 갱신됨)
git status   # 의도 파일만 — proto/store/api/worker + coordinator.rs + 위 테스트들
git add -A
git commit -m "feat(proto/worker): PhaseStat(MetricBatch.phase_stats=8) + Profile.measure_phases=11 + 워커 forward/wire"
git log -1 --oneline
```

---

## Task 4: 컨트롤러 — migration 0013 + store table + ingest

**Files:**
- Create: `crates/controller/src/store/migrations/0013_run_phase_metrics.sql`
- Modify: `crates/controller/src/store/mod.rs` (const:34, execute:67)
- Modify: `crates/controller/src/store/metrics.rs` (GroupMetricRow 패턴:248-294)
- Modify: `crates/controller/src/grpc/coordinator.rs` (group ingest:853-867)

- [ ] **Step 1: store 테스트 작성 (RED)** — `crates/controller/src/store/metrics.rs`의 `#[cfg(test)] mod tests`에 추가:

```rust
    #[tokio::test]
    async fn phase_batch_inserts_and_reads_back() {
        let db = pool().await;
        let rows = vec![
            PhaseMetricRow { run_id: "R1".into(), step_id: "s1".into(), phase: "download".into(), hdr_histogram: vec![1, 2, 3], count: 5 },
            PhaseMetricRow { run_id: "R1".into(), step_id: "s1".into(), phase: "download".into(), hdr_histogram: vec![4, 5], count: 2 },
        ];
        insert_phase_batch(&db, &rows).await.expect("insert");
        let got = phase_breakdown(&db, "R1").await.expect("read");
        assert_eq!(got.len(), 2, "append-only: both delta rows coexist");
        assert!(got.iter().all(|r| r.phase == "download"));
    }
```

- [ ] **Step 2: RED 확인**

Run: `cargo test -p handicap-controller phase_batch 2>&1 | tail`
Expected: FAIL — `PhaseMetricRow`/`insert_phase_batch`/`phase_breakdown`/table not found.

- [ ] **Step 3: migration SQL 작성** — `crates/controller/src/store/migrations/0013_run_phase_metrics.sql`:

```sql
-- migration 0013 (B7-C): per-(step_id, phase) latency-phase breakdown (TTFB+download).
-- Append-only: HDR histograms can't be merged in SQL, so each metric batch's delta
-- histogram is its own row; build_report merges by (step_id, phase) (Histogram::add).
-- No PK — metric batches are delivered once (no mid-run resend). Mirrors
-- run_group_metrics (0010). CREATE IF NOT EXISTS = idempotent.
CREATE TABLE IF NOT EXISTS run_phase_metrics (
  run_id        TEXT    NOT NULL,
  step_id       TEXT    NOT NULL,
  phase         TEXT    NOT NULL,
  hdr_histogram BLOB    NOT NULL,
  count         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_phase_metrics_run ON run_phase_metrics(run_id);
```

- [ ] **Step 4: store/mod.rs 배선** — const(34행 `MIGRATION_SQL_0011` 뒤):

```rust
const MIGRATION_SQL_0013: &str = include_str!("migrations/0013_run_phase_metrics.sql");
```

execute(67행 `ensure_runs_verdict_json(&pool).await?;` 뒤):

```rust
    sqlx::query(MIGRATION_SQL_0013).execute(&pool).await?; // migration 0013: run_phase_metrics
```

> 검증: `grep -c "MIGRATION_SQL_00" crates/controller/src/store/mod.rs`로 const 개수 == 그 const를 `execute`하는 라인 개수 교차확인(컨트롤러 CLAUDE.md: execute 라인 silent auto-merge 누락 함정).

- [ ] **Step 5: store/metrics.rs — PhaseMetricRow + insert/read** — `group_breakdown`(294행) 뒤에 추가 (GroupMetricRow 미러 + phase):

```rust
#[derive(Debug, Clone)]
pub struct PhaseMetricRow {
    pub run_id: String,
    pub step_id: String,
    pub phase: String,
    pub hdr_histogram: Vec<u8>,
    pub count: i64,
}

pub async fn insert_phase_batch(db: &Db, rows: &[PhaseMetricRow]) -> sqlx::Result<()> {
    if rows.is_empty() {
        return Ok(());
    }
    let mut tx = db.begin().await?;
    for r in rows {
        sqlx::query(
            "INSERT INTO run_phase_metrics(run_id,step_id,phase,hdr_histogram,count) VALUES(?,?,?,?,?)",
        )
        .bind(&r.run_id)
        .bind(&r.step_id)
        .bind(&r.phase)
        .bind(&r.hdr_histogram)
        .bind(r.count)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await
}

pub async fn phase_breakdown(db: &Db, run_id: &str) -> sqlx::Result<Vec<PhaseMetricRow>> {
    let rows = sqlx::query(
        "SELECT step_id, phase, hdr_histogram, count FROM run_phase_metrics \
         WHERE run_id = ? ORDER BY step_id, phase",
    )
    .bind(run_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| PhaseMetricRow {
            run_id: run_id.to_string(),
            step_id: r.get("step_id"),
            phase: r.get("phase"),
            hdr_histogram: r.get("hdr_histogram"),
            count: r.get("count"),
        })
        .collect())
}
```

- [ ] **Step 6: coordinator.rs ingest** — group ingest 블록(853-867행) 뒤, dropped 블록(868행) 앞에 추가:

```rust
    let phase_rows: Vec<crate::store::metrics::PhaseMetricRow> = batch
        .phase_stats
        .iter()
        .map(|ps| crate::store::metrics::PhaseMetricRow {
            run_id: batch.run_id.clone(),
            step_id: ps.step_id.clone(),
            phase: ps.phase.clone(),
            hdr_histogram: ps.hdr_histogram.clone(),
            count: ps.count as i64,
        })
        .collect();
    if !phase_rows.is_empty() {
        if let Err(e) = crate::store::metrics::insert_phase_batch(&state.db, &phase_rows).await {
            warn!(run_id = %batch.run_id, error = %e, "failed to insert phase metrics");
        }
    }
```

선택(parity): group 경로엔 ingest 단위테스트 `ingest_stores_group_stats`(coordinator.rs:1374)가 있다. 시간 여유 시 `ingest_stores_phase_stats`(MetricBatch에 `phase_stats` 한 줄 → ingest → `phase_breakdown` 비어있지 않음)를 미러 추가. (필수는 e2e Task 8이 ingest 경로를 커버.)

- [ ] **Step 7: GREEN 확인**

Run: `cargo test -p handicap-controller phase_batch 2>&1 | tail` → PASS.
Run: `cargo build --workspace 2>&1 | tail` → 0 errors.

- [ ] **Step 8: warm + 커밋**

```bash
cargo build -p handicap-worker && cargo build --workspace
git add crates/controller/src/store/migrations/0013_run_phase_metrics.sql crates/controller/src/store/mod.rs crates/controller/src/store/metrics.rs crates/controller/src/grpc/coordinator.rs
git commit -m "feat(controller): migration 0013 run_phase_metrics + PhaseMetricRow store + coordinator ingest"
git log -1 --oneline
```

---

## Task 5: 컨트롤러 — build_report에 download 부착

**Files:**
- Modify: `crates/controller/src/report.rs` (ReportStep:87-96, build_report sig:304-311, steps build:446-465, group_acc:494-521, ReportJson literal:523-545, callers — grep로 전수)
- Modify: `crates/controller/src/api/runs.rs` (build_report_for_run:403-421)
- Modify: `crates/controller/src/export.rs` (step() fixture:375-386)
- Modify: `crates/controller/src/insights.rs` (ReportStep 테스트 픽스처 **2곳**: `step`:228, `step_err`:293 — `ReportStep.download` 추가가 강제)

- [ ] **Step 1: build_report download 테스트 작성 (RED)** — `report.rs` 테스트 모듈에 추가 (group 테스트 `build_report_attaches_group_latency_without_polluting_summary` 패턴 차용; HDR blob은 헬퍼로 직렬화):

```rust
    #[test]
    fn build_report_attaches_download_phase_to_step() {
        let r = run_row_completed(); // 기존 테스트 헬퍼 (없으면 인접 테스트의 RunRow 빌더 재사용)
        let yaml = "version: 1\nname: t\nsteps: []\n";
        // 한 step_id에 download HDR 한 줄(직렬화 헬퍼는 group 테스트와 동일 hist→V2 bytes).
        let phases = vec![PhaseMetricRow {
            run_id: r.id.clone(),
            step_id: "s1".into(),
            phase: "download".into(),
            hdr_histogram: hist_blob(&[5_000, 9_000]), // 인접 group 테스트의 직렬화 헬퍼
            count: 2,
        }];
        // per-step 행이 생기도록 run_metrics 윈도도 한 줄(기존 헬퍼 rows).
        let rows = window_rows_for_step("s1");
        let rep = build_report(&r, yaml, &rows, &[], &[], &[], &phases);
        let s = rep.steps.iter().find(|s| s.step_id == "s1").unwrap();
        let d = s.download.as_ref().expect("download phase attached");
        assert_eq!(d.count, 2);
        assert!(d.p50_ms <= d.max_ms);
    }

    #[test]
    fn build_report_no_download_without_phases() {
        let r = run_row_completed();
        let rows = window_rows_for_step("s1");
        let rep = build_report(&r, "version: 1\nname: t\nsteps: []\n", &rows, &[], &[], &[], &[]);
        assert!(rep.steps.iter().all(|s| s.download.is_none()),
            "no download when phases empty (byte-identical)");
    }
```

> 헬퍼는 기존 이름으로 **없다** — 실제 report.rs 테스트는 `run_row()`(이미 Completed 반환, :564)·`win(ts,step,count,errors,sc,samples)`·`make_hdr_bytes(&[…])`(:554/595)를 쓴다. 위 의사 헬퍼(`run_row_completed`/`window_rows_for_step`/`hist_blob`)를 그 실명으로 치환하거나 인접 group 테스트(`build_report_attaches_group_latency…` :1116) 패턴을 복제. 테스트 상단에 `use crate::store::metrics::PhaseMetricRow;`(group 테스트 :1117 미러) 필요.

- [ ] **Step 2: RED 확인**

Run: `cargo test -p handicap-controller build_report_attaches_download 2>&1 | tail`
Expected: FAIL — `build_report` takes 6 args (not 7); `ReportStep` has no `download`; `PhaseStats` undefined.

- [ ] **Step 3: PhaseStats + ReportStep.download**

`report.rs`의 `GroupLatency`(119행) 뒤에:

```rust
#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct PhaseStats {
    pub count: u64,
    pub p50_ms: u64,
    pub p95_ms: u64,
    pub p99_ms: u64,
    pub max_ms: u64,
}
```

`ReportStep`(87행)에 필드 추가 (loop_breakdown 뒤):

```rust
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub download: Option<PhaseStats>,
```

- [ ] **Step 4: build_report 시그니처 + phase 누적 + 부착**

`build_report`(304행) 시그니처에 7번째 param:

```rust
    groups: &[GroupMetricRow],
    phases: &[crate::store::metrics::PhaseMetricRow],
) -> ReportJson {
```

**배치(단일·명확)**: download_acc 블록은 `let mut steps`(446행) **직전**에 둔다(steps map이 `download_by_step.remove(&step_id)`를 호출하므로 steps build보다 먼저 필요). group_acc(498행)는 steps 뒤 그대로 — 옮기지 않는다. `fresh_hist`/`decode_hdr`/`merge_into`/`percentiles_of`는 모듈 레벨 함수라 446행 위치에서 in-scope. 아래 블록:

```rust
    // Phase (download) latency: SEPARATE accumulator keyed by (step_id, phase).
    // v1 surfaces phase == "download" onto each ReportStep. NOT merged into
    // summary/overall/per_step(TTFB)/windows (isolation; spec §4.6).
    let mut download_acc: BTreeMap<String, (Histogram<u64>, u64)> = BTreeMap::new();
    for p in phases.iter().filter(|p| p.phase == "download") {
        let e = download_acc
            .entry(p.step_id.clone())
            .or_insert_with(|| (fresh_hist(), 0));
        if let Ok(Some(h)) = decode_hdr(&p.hdr_histogram) {
            merge_into(&mut e.0, &h); // fail-soft on bad blob
        }
        e.1 += p.count as u64;
    }
    let mut download_by_step: BTreeMap<String, PhaseStats> = download_acc
        .into_iter()
        .map(|(step_id, (h, count))| {
            let pc = percentiles_of(&h);
            (
                step_id,
                PhaseStats {
                    count,
                    p50_ms: pc.p50_ms,
                    p95_ms: pc.p95_ms,
                    p99_ms: pc.p99_ms,
                    max_ms: h.max() / 1_000,
                },
            )
        })
        .collect();
```

steps 빌드(446-465행)의 `ReportStep { … }` 리터럴에 추가:

```rust
                loop_breakdown: breakdown,
                download: download_by_step.remove(&step_id),
```

- [ ] **Step 5: build_report 모든 호출부 + export 픽스처 갱신**

Run: `grep -rn "build_report(" crates/controller/src | grep -v "fn build_report"` → **출력된 모든** 호출에 7번째 인자 `&[]` 추가(report.rs 테스트 ~14곳: 640/688/713/756/800/894/908/915/922/937/959/1112/1137/1167 + 그 외 — 명시 라인 신뢰 말고 grep 출력 전수).
- `build_report_for_run`(api/runs.rs:413): groups fetch 뒤에 `let phases = crate::store::metrics::phase_breakdown(db, run_id).await?;` 추가하고 `build_report(&row, &scenario_yaml, &rows, &loops, &branches, &groups, &phases)`.

`ReportStep { … }` 리터럴은 prod(report.rs:454) + 테스트 픽스처 여럿이 강제된다. `grep -rn "ReportStep {" crates/controller/src` 전수 → 각각 `download: None,` 추가:
- `export.rs`의 `step()`(384행 `loop_breakdown: vec![],` 뒤)
- `insights.rs`의 `step`(228) **및** `step_err`(293) 픽스처

- [ ] **Step 6: GREEN 확인**

Run: `cargo test -p handicap-controller 2>&1 | tail -20` → PASS (신규 2 + 기존).
Run: `cargo build --workspace 2>&1 | tail` → 0 errors.

- [ ] **Step 7: warm + 커밋**

```bash
cargo build -p handicap-worker && cargo build --workspace
git add crates/controller/src/report.rs crates/controller/src/api/runs.rs crates/controller/src/export.rs crates/controller/src/insights.rs
git commit -m "feat(controller): build_report에 download phase 부착(ReportStep.download, phases 7번째 param)"
git log -1 --oneline
```

---

## Task 6: UI — Zod 스키마 + StepStatsTable 컬럼 + opt-in 토글

**Files:**
- Modify: `ui/src/api/schemas.ts` (ProfileSchema:58-77, ReportStepSchema:212-231, GroupLatencySchema:247-256)
- Modify: `ui/src/components/profileForm.ts` (ProfileFormInput:88-95, buildProfile:97-105)
- Modify: `ui/src/components/report/StepStatsTable.tsx`
- Modify: `ui/src/components/RunDialog.tsx` + `ui/src/components/ScheduleForm.tsx` (토글 UI/state)
- Test: `ui/src/components/__tests__/profileForm.test.ts`, `ui/src/components/report/__tests__/StepStatsTable.test.tsx`

> UI 게이트: 커밋 전 `cd ui && pnpm lint && pnpm test && pnpm build` 셋 다.

- [ ] **Step 1: profileForm 테스트 작성 (RED)** — `ui/src/components/__tests__/profileForm.test.ts`에 추가:

```ts
import { buildProfile } from "../profileForm";
// 기존 테스트의 EMPTY input 빌더 재사용; measurePhases 토글만 검증.

it("buildProfile emits measure_phases from input", () => {
  const base = baseInput(); // 기존 헬퍼 (없으면 인접 테스트의 ProfileFormInput 리터럴 복제)
  expect(buildProfile({ ...base, measurePhases: true }).measure_phases).toBe(true);
  expect(buildProfile({ ...base, measurePhases: false }).measure_phases).toBe(false);
});
```

- [ ] **Step 2: RED 확인**

Run: `cd ui && pnpm test profileForm 2>&1 | tail`
Expected: FAIL — `measurePhases` not on `ProfileFormInput`; `measure_phases` not on Profile.

- [ ] **Step 3: Zod 스키마 — Profile.measure_phases + ReportStep.download + PhaseStatsSchema**

`schemas.ts` `ProfileSchema`(76행 `stages` 뒤):

```ts
  measure_phases: z.boolean().default(false),
```

> **`.default(false)` 선택 근거**(ui/CLAUDE.md S-C 규칙 검토): 서버는 `#[serde(default)]`(skip 없음)라 측정 여부와 무관하게 `false`를 **항상 직렬화**(절대 null/absent 아님)하므로 `.nullish()`는 부적합(bool은 Option 아님). plain `z.boolean()`도 동작하나, **옛 run 행**(이 기능 전 생성된 `profile_json`에 키 없음)을 응답 경로가 raw passthrough할 가능성에 대비해 `.default(false)`가 더 방어적이고, 기존 sibling 필드 3개(`ramp_up_seconds`/`loop_breakdown_cap`/`http_timeout_seconds`)와 **동형**이다. `.default()`의 `boolean|undefined` 누출은 그 3개와 마찬가지로 `normalizeProfile`(=`ProfileSchema.parse`) 경계에서 collapse된다(누출-free가 아니라 collapse됨 — 새 컴포넌트에 `Profile`을 직접 넘기는 코드는 normalizeProfile 통과분만 받음).

`GroupLatencySchema`(256행) 뒤:

```ts
export const PhaseStatsSchema = z
  .object({
    count: z.number().int().nonnegative(),
    p50_ms: z.number().int().nonnegative(),
    p95_ms: z.number().int().nonnegative(),
    p99_ms: z.number().int().nonnegative(),
    max_ms: z.number().int().nonnegative(),
  })
  .strict();
export type PhaseStats = z.infer<typeof PhaseStatsSchema>;
```

`ReportStepSchema`(221행 `loop_breakdown` `.optional()` 뒤, `.strict()` 앞)에:

```ts
    download: PhaseStatsSchema.optional(),
```

> `.nullish()` 아님 — `ReportStep.download`는 `skip_serializing_if`로 absent(omit)이라 `.optional()`이 옳다(`group_latency` 패턴; spec §4.7).

- [ ] **Step 4: profileForm — measurePhases**

`ProfileFormInput`(88행)에 `measurePhases: boolean;` 추가. `buildProfile`(97행) 리턴 객체에:

```ts
    measure_phases: i.measurePhases,
```

> **기존 `profileForm.test.ts` 리터럴 갱신**: `measurePhases`가 required가 되면 기존 `ProfileFormInput` 리터럴(profileForm.test.ts:43/61 등)이 "missing property"로 `tsc -b` red → 각 리터럴에 `measurePhases: false,` 추가(`grep -n "measurePhases\|ProfileFormInput\|buildProfile(" src/components/__tests__/profileForm.test.ts`로 확인).

- [ ] **Step 5: profileForm 테스트 GREEN**

Run: `cd ui && pnpm test profileForm 2>&1 | tail` → PASS.

- [ ] **Step 6: StepStatsTable 다운로드 컬럼 테스트 작성 (RED)** — `ui/src/components/report/__tests__/StepStatsTable.test.tsx`는 **이미 존재**한다. 새 `it`을 **기존 `describe` 안에** 추가(상단 `import { render, screen }`/`import { StepStatsTable }`를 다시 쓰지 말 것 — 중복 선언 에러). 추가할 `it`:

```tsx
// (기존 파일 상단 import/meta 재사용 — 아래 it 본문만 describe 안에 추가.
//  meta가 없으면: const meta = new Map([["s1", { id: "s1", name: "g", method: "GET", url: "/p" }]]);)
it("shows download columns only when a step has download", () => {
  const { rerender } = render(
    <StepStatsTable steps={[{ step_id: "s1", count: 1, error_count: 0, status_counts: {}, p50_ms: 5, p95_ms: 9, p99_ms: 9 }]} meta={meta} />,
  );
  expect(screen.queryByText(/다운로드 p50/)).toBeNull();
  rerender(
    <StepStatsTable
      steps={[{ step_id: "s1", count: 1, error_count: 0, status_counts: {}, p50_ms: 5, p95_ms: 9, p99_ms: 9, download: { count: 1, p50_ms: 3, p95_ms: 7, p99_ms: 7, max_ms: 8 } }]}
      meta={meta}
    />,
  );
  expect(screen.getByText(/다운로드 p50/)).toBeInTheDocument();
});
```

- [ ] **Step 7: RED 확인**

Run: `cd ui && pnpm test StepStatsTable 2>&1 | tail` → FAIL.

- [ ] **Step 8: StepStatsTable 다운로드 컬럼 구현**

`StepStatsTable.tsx`: 컴포넌트 상단에 `const anyDownload = steps.some((s) => s.download != null);`(strict-boolean-expressions/`--max-warnings=0` 대비 `!= null`). `colSpan`을 `anyDownload ? 11 : 8`로. `<thead>`에 조건부 컬럼 추가(p99 헤더 뒤):

```tsx
            {anyDownload && (
              <>
                <th className="py-2 pr-4 font-medium">다운로드 p50</th>
                <th className="py-2 pr-4 font-medium">다운로드 p95</th>
                <th className="py-2 pr-4 font-medium">다운로드 p99</th>
              </>
            )}
```

본문 행(p99 셀 71행 뒤)에:

```tsx
                  {anyDownload && (
                    <>
                      <td className="py-2 pr-4">{s.download?.p50_ms ?? "—"}</td>
                      <td className="py-2 pr-4">{s.download?.p95_ms ?? "—"}</td>
                      <td className="py-2 pr-4">{s.download?.p99_ms ?? "—"}</td>
                    </>
                  )}
```

기존 p50/p95/p99 헤더를 "응답(TTFB) p50" 등으로 라벨 명확화(anyDownload일 때만 혼동 방지 — 항상 "p50 ms (TTFB)"로 둬도 됨). 섹션 하단에 anyDownload일 때 범례 `<p>` 추가: `"응답(TTFB)=요청~헤더, 다운로드=본문 수신. 합 ≠ 전체(퍼센타일 비가산)."`.

- [ ] **Step 9: StepStatsTable 테스트 GREEN**

Run: `cd ui && pnpm test StepStatsTable 2>&1 | tail` → PASS.

- [ ] **Step 10: RunDialog + ScheduleForm 토글 배선**

두 폼은 **로컬 zero-arg `buildProfile()` 래퍼**(RunDialog:313, ScheduleForm:200)가 공유 `buildProfileShared({…})`(=profileForm.ts의 `buildProfile`)를 호출하는 구조다. 각 폼에:
- state: `const [measurePhases, setMeasurePhases] = useState(initial?.profile.measure_phases ?? false);`(RunDialog는 prefill `initial` 시드; ScheduleForm은 편집 시드).
- **로컬 `buildProfile()` 래퍼의 `buildProfileShared({…})` 호출 객체**(RunDialog:314-321, ScheduleForm:201-208)에 `measurePhases,` 추가(단일 공유 호출이 아니라 폼별 래퍼 2곳).
- 토글 UI: "진단/고급" 접이식 섹션(`ui-optional-sections-collapsible` 이디엄 — `<legend>` 안 `<button aria-expanded>` + `{open && …}`) 안에 체크박스 `<label>측정: 레이턴시 단계 분해(TTFB/다운로드) <input type="checkbox" checked={measurePhases} onChange={(e)=>setMeasurePhases(e.target.checked)} aria-label="measure latency phases" /></label>`. 값 있으면 자동 펼침.

> 기존 RunDialog/ScheduleForm 제출 테스트는 `measure_phases: false`가 payload에 추가될 뿐(byte 비교가 아니라 필드 단언이면)이라 대부분 무수정. 깨지면 expect에 `measure_phases: false` 추가.

- [ ] **Step 11: UI 전체 게이트**

Run: `cd ui && pnpm lint && pnpm test && pnpm build 2>&1 | tail -25`
Expected: lint 0 warning, 전체 test PASS, `tsc -b` clean.

> `pnpm test`(전체)로 `RunDialog`/`ScheduleForm`/`RunDetailPage`/`ReportView` 등 인접 파일 회귀(특히 `ReportSchema`/`ProfileSchema` 누출, S-D 함정)까지 확인.

- [ ] **Step 12: 커밋**

```bash
cd /Users/sgj/develop/handicap
git add ui/src/api/schemas.ts ui/src/components/profileForm.ts ui/src/components/report/StepStatsTable.tsx ui/src/components/report/__tests__/StepStatsTable.test.tsx ui/src/components/__tests__/profileForm.test.ts ui/src/components/RunDialog.tsx ui/src/components/ScheduleForm.tsx
git commit -m "feat(ui): download phase 컬럼(StepStatsTable) + measure_phases 토글(profileForm/RunDialog/ScheduleForm)"
git log -1 --oneline
```

---

## Task 7: test-run trace — TTFB/다운로드 (엔진 + UI)

**Files:**
- Modify: `crates/engine/src/executor.rs` (execute_step_traced:278-463)
- Modify: `crates/engine/src/trace.rs` (TracedResponse:44-52, 테스트 픽스처:366)
- Modify: `ui/src/api/schemas.ts` (TracedResponseSchema:384-392)
- Modify: `ui/src/components/.../TestRunPanel.tsx`

- [ ] **Step 1: trace 테스트 작성 (RED)** — `executor.rs` 테스트의 `traced_step_captures_request_response_and_unbound`에 단언 추가:

```rust
        assert!(resp.download_ms.is_some(), "trace records download phase on success");
```

- [ ] **Step 2: RED 확인**

Run: `cargo test -p handicap-engine traced_step_captures 2>&1 | tail` → FAIL (`download_ms` 없음).

- [ ] **Step 3: TracedResponse.download_ms + execute_step_traced 측정**

`trace.rs`의 `TracedResponse`(45행, `latency_ms` 뒤):

```rust
    pub download_ms: Option<u64>,
```

`executor.rs::execute_step_traced`: body 측정을 `Instant`로 감싼다 — `let body_bytes = match resp.bytes().await {`(397행)을:

```rust
    let dl_start = std::time::Instant::now();
    let body_bytes = match resp.bytes().await {
        Ok(b) => b,
        Err(e) => {
            return HttpTrace {
                request,
                response: Some(TracedResponse {
                    status,
                    latency_ms,
                    download_ms: None,
                    headers: resp_headers.iter().cloned().collect(),
                    set_cookies,
                    body: String::new(),
                    body_truncated: false,
                }),
                extracted: BTreeMap::new(),
                unbound_vars: unbound,
                error: Some(format!("read body: {e}")),
            };
        }
    };
    let download_ms = Some(dl_start.elapsed().as_millis().min(u64::MAX as u128) as u64);
```

성공 `TracedResponse { … }` 리터럴(451행)에 `download_ms,` 추가. trace.rs 테스트 픽스처(366행 `latency_ms: 3,` 뒤)에 `download_ms: None,` 추가.

> `grep -rn "TracedResponse {" crates/`로 모든 리터럴 확인.

- [ ] **Step 4: 엔진 GREEN**

Run: `cargo test -p handicap-engine trace 2>&1 | tail`; `cargo test -p handicap-engine 2>&1 | tail` → PASS.

- [ ] **Step 5: UI ScenarioTraceSchema + TestRunPanel**

`schemas.ts` `TracedResponseSchema`(384행)에 `download_ms: z.number().int().nullable(),`(엔진 trace는 `skip_serializing_if` 없이 `Option`→`null` 직렬화 → `.nullable()`, ScenarioTrace 컨벤션). `TestRunPanel.tsx`의 http 응답 행에 "TTFB {latency_ms}ms / 다운로드 {download_ms ?? "—"}ms" 표시.

- [ ] **Step 6: UI 게이트 + 커밋**

```bash
cd ui && pnpm lint && pnpm test && pnpm build 2>&1 | tail -20
cd /Users/sgj/develop/handicap
cargo build -p handicap-worker && cargo build --workspace
git add crates/engine/src/executor.rs crates/engine/src/trace.rs ui/src/api/schemas.ts ui/src/components
git commit -m "feat(trace): test-run TTFB/다운로드 분리(TracedResponse.download_ms + TestRunPanel)"
git log -1 --oneline
```

---

## Task 8: e2e + 라이브 검증

**Files:**
- Modify: `crates/controller/tests/e2e_test.rs` (group e2e `parallel_group_latency_report_e2e_smoke` 미러)

- [ ] **Step 1: e2e 테스트 작성** — `e2e_test.rs`에 `phase_breakdown_report_e2e_smoke`: wiremock 타깃(본문 ≥ 수 KB) + `measure_phases: true` profile로 워커 subprocess→컨트롤러 run→ `/report`에서 `steps[].download.count > 0` 단언. (group e2e의 worker_bin_path/스폰/폴링 헬퍼 그대로 차용.)

- [ ] **Step 2: e2e GREEN**

Run: `cargo test -p handicap-controller --test e2e_test phase_breakdown 2>&1 | tail -30`
Expected: PASS.

- [ ] **Step 3: 워크스페이스 전체 게이트**

Run: `cargo build -p handicap-worker && cargo build --workspace && cargo test --workspace 2>&1 | tail -25` → PASS (cold flake면 warm 재시도).

- [ ] **Step 4: 라이브 검증 (S-D 교훈 — 머지 전 필수)**

`dev-doctor` 스킬 또는 수동: `cargo build -p handicap-worker --bin worker && cargo build -p handicap-controller --bin controller`, 큰 본문 반환 echo/wiremock 타깃 + 격리 DB로 controller 기동.
- ① `POST /api/runs` `profile.measure_phases:true` → 종료 후 `GET /api/runs/{id}/report` 응답을 파일로 저장 → `ui/src/**/__tests__/`에 throwaway 테스트가 `ReportSchema.safeParse`로 파싱 통과 확인(실패 시 `error.issues` 출력) + `steps[].download.p50_ms > 0` 확인. 돌린 뒤 삭제(커밋 안 함).
- ② `measure_phases:false` run → `report.steps[].download` 부재 + 기존 리포트 필드 동일(byte-identical 감각).
- ③ Playwright: RunDialog 진단 섹션 토글 ON → run → 리포트에 다운로드 컬럼 + 콘솔 **Zod 에러 0**. `rm -rf .playwright-mcp` + 루트 png 정리(머지 전).

- [ ] **Step 5: 커밋**

```bash
git add crates/controller/tests/e2e_test.rs
git commit -m "test(e2e): phase_breakdown_report_e2e_smoke (measure_phases run → report.download)"
git log -1 --oneline
```

---

## 완료 후

- `docs/roadmap.md`: §A2 도출 우선순위 (3)을 "완료"로, §B7에 연기 항목(DNS/TCP/TLS/total phase·per-second 시계열·다운로드 성공/오류 분할·다운로드 SLO·download timeout 비대칭) 누적. 루트 `CLAUDE.md` 상태 줄 + 도메인 CLAUDE.md(engine/controller/ui)에 새 함정(phase 채널 drain 4/guard 3, ReportStep.download `.optional()`, measure_phases 게이트) 한 줄씩.
- ADR 불필요(additive, ADR-0017/0033 범위 내) — spec §머리말 근거.
- 머지: `finishing-a-development-branch` 스킬. 워크트리면 `git -C <메인> merge --ff-only` 후 `ExitWorktree`.

---

## Self-review 체크 (작성자 확인 완료)

- **Spec 커버리지**: §4.1(T1)·§4.2(T1)·§4.3(T2)·§4.4(T3)·§4.5(T3·T4)·§4.6(T5)·§4.7(T6)·§4.8(T6)·§4.9(T7)·§4.10(컴파일러-강제 사이트는 각 task의 grep 단계)·§5 불변식(T2 off=byte-identical·T5 isolation 테스트)·§6 테스트(T1·T2·T5·T8 + T8 라이브)·§8 연기(완료 후 roadmap). 전부 매핑됨.
- **타입 일관성**: `PhaseStat`(engine aggregator/proto, step_id/phase/histogram(bytes)/count) ↔ `PhaseMetricRow`(controller store) ↔ `PhaseStats`(report, count/p50/p95/p99/max **u64**) ↔ `PhaseStatsSchema`(UI, int) — 이름 구분 의도적(Stat=delta 행, Stats=집계 결과). `measure_phases`: proto `bool`(default false) / store `#[serde(default)] bool`(skip 없음 → 항상 `false` 직렬화) / RunPlan `bool` / Zod `.default(false)`(누출은 normalizeProfile에서 collapse — Task 6 근거 박스 참조, 누출-free 주장 아님).
- **번호**: MetricBatch.phase_stats=8, Profile.measure_phases=11, migration 0013 — 코드 대조 확인됨.
