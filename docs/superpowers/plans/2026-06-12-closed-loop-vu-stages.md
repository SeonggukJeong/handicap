# Closed-loop VU 곡선 (vu_stages) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** closed-loop run의 VU 수를 다단계 곡선(`vu_stages`)으로 ramp-up/down — park-gate 격리 엔진 함수 + `ramp_down` graceful/immediate 노브 + UI closed+curve 활성화.

**Architecture:** 신규 격리 함수 `run_scenario_vu_curve`(슈퍼바이저 inline + watch 채널 + park-gate, 기존 3모드 byte-identical 구조 보장) → proto `Profile.vu_stages=12`/`ramp_down_immediate=13` → 컨트롤러 `is_vu_curve()` 판별 4 사이트 + 검증 ①–⑨ → UI `deriveLoadMode` 단일화 + LoadModelFields 재구성. 마이그레이션 0 (profile_json serde default).

**Tech Stack:** Rust (tokio watch/JoinSet, wiremock 테스트) + prost + React/Zod/vitest.

**Spec:** `docs/superpowers/specs/2026-06-12-closed-loop-vu-stages-design.md` (§ 번호는 이 spec 기준)

---

## 오케스트레이터 공통 지침 (모든 task)

- 워크트리: `/Users/sgj/develop/handicap/.claude/worktrees/closed-loop-vu-stages` — **모든 subagent prompt 첫 줄에 `cd` 명시**.
- pre-commit이 cargo-영향 커밋마다 전체 워크스페이스 게이트(수 분)를 돈다 → **RED 테스트·미사용 헬퍼 단독 커밋 불가, task당 green 커밋 1회로 fold**(RED→GREEN 확인은 로컬). 커밋 전 `cargo build -p handicap-worker && cargo build --workspace`로 warm(cold-build flake 예방). implementer의 커밋은 **foreground 단일 호출**(`run_in_background` 금지, timeout 600000ms).
- `git add`는 명시 경로만(`-A` 금지). `git commit`에 파이프 금지(git-guard가 deny).
- tdd-guard: `crates/engine/src/runner.rs`는 인라인 `#[cfg(test)]`가 이미 있어 자동 통과. 그 외 src 편집은 Task 순서상 항상 pending test 파일(`crates/engine/tests/vu_curve.rs` 등)이 먼저 생기므로 자연 unblock.
- UI task는 커밋 후 `cd ui && pnpm lint && pnpm test && pnpm build` 수동 게이트(hook은 cargo만).

---

### Task 1: 엔진 — `RampDown` enum + `RunPlan` 필드 2개 + 워크스페이스 리터럴 갱신

**Files:**
- Modify: `crates/engine/src/runner.rs` (Stage 정의 근처 ~:27, RunPlan ~:34)
- Modify: `crates/engine/src/lib.rs` (re-export)
- Create: `crates/engine/tests/vu_curve.rs` (이 task에선 RampDown 단위 테스트만 — Task 2가 통합 테스트 추가)
- Modify: 워크스페이스 전체 `RunPlan {` 리터럴 (~34곳/18파일, 전부 테스트/워커)

- [ ] **Step 1: 테스트 파일 먼저 생성 (tdd-guard pending + RED)**

`crates/engine/tests/vu_curve.rs`:

```rust
use handicap_engine::RampDown;

#[test]
fn ramp_down_default_is_graceful() {
    assert_eq!(RampDown::default(), RampDown::Graceful);
}

#[test]
fn ramp_down_serde_lowercase_round_trip() {
    assert_eq!(
        serde_json::to_string(&RampDown::Immediate).unwrap(),
        "\"immediate\""
    );
    assert_eq!(
        serde_json::from_str::<RampDown>("\"graceful\"").unwrap(),
        RampDown::Graceful
    );
}
```

- [ ] **Step 2: RED 확인** — `cargo test -p handicap-engine --test vu_curve` → 컴파일 에러(`RampDown` 미존재) = RED.

- [ ] **Step 3: `RampDown` enum + `RunPlan` 필드 구현**

`crates/engine/src/runner.rs` — `Stage` 정의 바로 아래에:

```rust
/// VU 곡선 ramp-down 시 초과분 VU 처리 (spec §2). Graceful = 현재 iteration을
/// 마치고 park, Immediate = 활성화 child 토큰 취소 → 다음 스텝 경계에서 중단 후
/// park (진행 중 HTTP 요청 1개는 마저 끝남 — mid-request 소켓 중단은 비목표).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RampDown {
    #[default]
    Graceful,
    Immediate,
}
```

`RunPlan`의 `measure_phases` 필드 뒤에:

```rust
    /// Closed-loop VU curve (spec §3.1): `Some(non-empty)` → the worker selects
    /// `run_scenario_vu_curve` (park-gate). `None` → fixed closed / open-loop
    /// (byte-identical). The worker sets `duration == sum(stage durations)`
    /// (same invariant as `stages`).
    pub vu_stages: Option<Vec<Stage>>,
    /// VU-curve ramp-down mode. Only meaningful with `vu_stages` (controller-validated).
    pub ramp_down: RampDown,
```

`crates/engine/src/lib.rs` — 기존 runner re-export 줄에 `RampDown` 추가 (예: `pub use runner::{..., RampDown, ...};` — 파일의 기존 형식을 따름).

- [ ] **Step 4: 워크스페이스 `RunPlan {` 리터럴 전부 갱신 (기계적)**

```bash
grep -rln "RunPlan {" crates/
```

각 리터럴에 두 줄 추가 (전부 기존 동작 보존 값):

```rust
            vu_stages: None,
            ramp_down: RampDown::Graceful,
```

import가 없는 파일은 `use handicap_engine::RampDown;` (engine 내부 테스트는 `handicap_engine::RampDown`, engine src 내부는 `crate` 경로 불필요 — runner.rs 안). `cargo build --workspace --tests`가 0 에러까지.

- [ ] **Step 5: GREEN 확인** — `cargo test -p handicap-engine --test vu_curve` PASS + `cargo build --workspace --tests` 0 에러.

- [ ] **Step 6: 커밋**

```bash
git add crates/engine/src/runner.rs crates/engine/src/lib.rs crates/engine/tests/vu_curve.rs <리터럴 갱신 파일들 명시>
git commit -m "feat(engine): RampDown enum + RunPlan.vu_stages/ramp_down 필드 (소비처는 후속)"
```

---

### Task 2: 엔진 — `run_scenario_vu_curve` + `run_vu_curve` + 통합 테스트

**Files:**
- Modify: `crates/engine/src/runner.rs` (run_scenario_open_loop 아래에 신규 함수 2개)
- Modify: `crates/engine/src/lib.rs` (`run_scenario_vu_curve` re-export)
- Modify: `crates/engine/tests/vu_curve.rs` (통합 테스트 추가)

- [ ] **Step 1: 통합 테스트 작성 (RED)**

`crates/engine/tests/vu_curve.rs`에 추가. 스캐폴딩은 `open_loop.rs` 패턴(wiremock + mpsc + 헬퍼) 미러:

```rust
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use handicap_engine::{MetricFlush, RunPlan, Scenario, Stage, run_scenario_vu_curve};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use wiremock::matchers::method;
use wiremock::{Mock, MockServer, ResponseTemplate};

fn curve_plan(stages: Vec<Stage>, ramp_down: RampDown) -> RunPlan {
    let secs: u64 = stages.iter().map(|s| u64::from(s.duration_seconds)).sum();
    RunPlan {
        vus: 0, // curve ignores vus (controller-validated to 0)
        ramp_up: Duration::ZERO,
        duration: Duration::from_secs(secs), // worker invariant: sum(stage durations)
        env: BTreeMap::new(),
        loop_breakdown_cap: 256,
        vu_offset: 0,
        data_binding: None,
        http_timeout: Duration::from_secs(30),
        think_time: None,
        think_seed: None,
        target_rps: None,
        max_in_flight: None,
        stages: None,
        measure_phases: false,
        vu_stages: Some(stages),
        ramp_down,
    }
}

fn scenario(url: &str) -> Arc<Scenario> {
    let yaml = format!(
        "version: 1\nname: vc\nsteps:\n  - id: 01HX0000000000000000000010\n    name: get\n    type: http\n    request:\n      method: GET\n      url: {url}\n    assert:\n      - status: 200\n"
    );
    Arc::new(serde_yaml::from_str(&yaml).unwrap())
}

fn stage(target: u32, duration_seconds: u32) -> Stage {
    Stage { target, duration_seconds }
}

/// 채널을 다 마시고 (총 count, 총 error) 집계.
async fn drain(rx: &mut mpsc::Receiver<MetricFlush>) -> (u64, u64) {
    let (mut count, mut errors) = (0u64, 0u64);
    while let Some(f) = rx.recv().await {
        count += f.windows.iter().map(|w| w.count).sum::<u64>();
        errors += f.windows.iter().map(|w| w.error_count).sum::<u64>();
    }
    (count, errors)
}

#[tokio::test]
async fn vu_curve_ramps_and_completes_at_stage_sum() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(64);
    let started = Instant::now();
    let h = tokio::spawn(run_scenario_vu_curve(
        scenario(&format!("{}/", server.uri())),
        curve_plan(vec![stage(2, 2)], RampDown::Graceful),
        tx,
        CancellationToken::new(),
    ));
    let (count, errors) = drain(&mut rx).await;
    h.await.unwrap().unwrap();
    let elapsed = started.elapsed();
    assert!(count > 0, "curve run should fire requests, got {count}");
    assert_eq!(errors, 0);
    // deadline = sum(stage durations) = 2s. 넉넉한 상한(spec §7.1: 정확 단언은 flake).
    assert!(
        (Duration::from_millis(1800)..Duration::from_millis(4000)).contains(&elapsed),
        "run should end near 2s, took {elapsed:?}"
    );
}

#[tokio::test]
async fn vu_curve_cookie_jar_persists_across_park() {
    // 곡선 1→0→1: 가운데 0 VU 구간이 park를 강제. jar가 슬롯-지속이면
    // 맨 첫 요청만 쿠키가 없다 (재활성화 첫 요청도 쿠키 동반).
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200).insert_header("set-cookie", "sid=abc123"))
        .mount(&server)
        .await;
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(64);
    let h = tokio::spawn(run_scenario_vu_curve(
        scenario(&format!("{}/", server.uri())),
        curve_plan(vec![stage(1, 1), stage(0, 2), stage(1, 1)], RampDown::Graceful),
        tx,
        CancellationToken::new(),
    ));
    let (count, _) = drain(&mut rx).await;
    h.await.unwrap().unwrap();
    let reqs = server.received_requests().await.unwrap();
    let with_cookie = reqs
        .iter()
        .filter(|r| {
            r.headers
                .get("cookie")
                .map(|v| v.to_str().unwrap_or("").contains("sid=abc123"))
                .unwrap_or(false)
        })
        .count() as u64;
    assert!(count >= 2, "need at least two requests to prove persistence, got {count}");
    assert_eq!(
        with_cookie,
        count - 1,
        "only the very first request may lack the cookie (jar persists across park)"
    );
}

#[tokio::test]
async fn vu_curve_vu_ids_stay_within_bound() {
    // ${vu_id}를 경로에 에코 → 모든 id < max(stage.target).
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;
    let yaml = format!(
        "version: 1\nname: vc\nsteps:\n  - id: 01HX0000000000000000000010\n    name: get\n    type: http\n    request:\n      method: GET\n      url: {}/u/${{vu_id}}\n    assert:\n      - status: 200\n",
        server.uri()
    );
    let sc: Arc<Scenario> = Arc::new(serde_yaml::from_str(&yaml).unwrap());
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(64);
    let h = tokio::spawn(run_scenario_vu_curve(
        sc,
        curve_plan(vec![stage(3, 2)], RampDown::Graceful),
        tx,
        CancellationToken::new(),
    ));
    let (count, _) = drain(&mut rx).await;
    h.await.unwrap().unwrap();
    assert!(count > 0);
    let reqs = server.received_requests().await.unwrap();
    for r in &reqs {
        let id: u32 = r.url.path().rsplit('/').next().unwrap().parse().unwrap();
        assert!(id < 3, "vu_id {id} outside [0, 3)");
    }
}

#[tokio::test]
async fn vu_curve_graceful_rampdown_records_no_errors() {
    // 느린 응답 + 하강 곡선: graceful retire는 에러/abort를 메트릭에 안 남긴다.
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_millis(300)))
        .mount(&server)
        .await;
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(64);
    let h = tokio::spawn(run_scenario_vu_curve(
        scenario(&format!("{}/", server.uri())),
        curve_plan(vec![stage(4, 1), stage(0, 2)], RampDown::Graceful),
        tx,
        CancellationToken::new(),
    ));
    let (count, errors) = drain(&mut rx).await;
    h.await.unwrap().unwrap();
    assert!(count > 0);
    assert_eq!(errors, 0, "graceful ramp-down must not record errors");
}

#[tokio::test]
async fn vu_curve_immediate_retire_is_not_a_failure() {
    // immediate: 토큰 취소로 스텝 경계 중단 — run은 Ok, 에러 0 (retire ≠ failed).
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_millis(300)))
        .mount(&server)
        .await;
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(64);
    let h = tokio::spawn(run_scenario_vu_curve(
        scenario(&format!("{}/", server.uri())),
        curve_plan(vec![stage(4, 1), stage(0, 2)], RampDown::Immediate),
        tx,
        CancellationToken::new(),
    ));
    let (count, errors) = drain(&mut rx).await;
    let res = h.await.unwrap();
    assert!(res.is_ok(), "immediate retire must not fail the run: {res:?}");
    assert!(count > 0);
    assert_eq!(errors, 0);
}

#[tokio::test]
async fn vu_curve_all_spawned_vus_failed() {
    // strict 렌더 실패(UnknownVar)로 spawn된 전 VU가 죽으면 AllVusFailed (spawned 기준).
    let yaml = "version: 1\nname: vc\nsteps:\n  - id: 01HX0000000000000000000010\n    name: bad\n    type: http\n    request:\n      method: GET\n      url: http://127.0.0.1:1/{{missing}}\n    assert:\n      - status: 200\n";
    let sc: Arc<Scenario> = Arc::new(serde_yaml::from_str(yaml).unwrap());
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(64);
    let h = tokio::spawn(run_scenario_vu_curve(
        sc,
        curve_plan(vec![stage(2, 2)], RampDown::Graceful),
        tx,
        CancellationToken::new(),
    ));
    drain(&mut rx).await;
    let res = h.await.unwrap();
    assert!(
        matches!(res, Err(handicap_engine::EngineError::AllVusFailed { .. })),
        "expected AllVusFailed, got {res:?}"
    );
}

#[tokio::test]
async fn vu_curve_abort_cancels_run() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(64);
    let cancel = CancellationToken::new();
    let c2 = cancel.clone();
    let h = tokio::spawn(run_scenario_vu_curve(
        scenario(&format!("{}/", server.uri())),
        curve_plan(vec![stage(2, 10)], RampDown::Graceful),
        tx,
        cancel,
    ));
    tokio::time::sleep(Duration::from_millis(500)).await;
    c2.cancel();
    drain(&mut rx).await;
    let res = h.await.unwrap();
    assert!(matches!(res, Err(handicap_engine::EngineError::Aborted)));
}
```

(import에 `RampDown` 추가: `use handicap_engine::{..., RampDown, ...};`, `EngineError`가 re-export 안 돼 있으면 lib.rs 확인 — `all_vus_failed.rs`가 쓰는 경로를 미러.)

- [ ] **Step 2: RED 확인** — `cargo test -p handicap-engine --test vu_curve` → `run_scenario_vu_curve` 미존재 컴파일 에러.

- [ ] **Step 3: 엔진 구현**

`crates/engine/src/runner.rs`의 `run_scenario_open_loop` 아래(rate_at 재사용 가능 위치)에:

```rust
/// Closed-loop VU curve (spec §4): drive a piecewise-linear *active VU count*
/// `desired(t) = round(rate_at(vu_stages, elapsed))` with park-gated reusable VU
/// tasks. Isolated from `run_scenario`/`run_scenario_open_loop` — the fixed
/// closed-loop and open-loop paths are untouched (S-C isolation precedent).
///
/// Supervisor runs INLINE in this task (mirror of run_scenario's spawn-loop
/// position): tick every 250ms until the deadline, only then join. Starting at
/// 0 VUs with lazy spawn means the JoinSet may be empty early — joining
/// immediately would end the run at t≈0 (spec §4.2 hazard).
pub async fn run_scenario_vu_curve(
    scenario: Arc<Scenario>,
    plan: RunPlan,
    out: mpsc::Sender<MetricFlush>,
    cancel: CancellationToken,
) -> Result<()> {
    let stages = plan
        .vu_stages
        .clone()
        .expect("worker selects this path only when vu_stages is non-empty");
    let max_vus: u32 = stages.iter().map(|s| s.target).max().unwrap_or(0);
    let agg = Arc::new(Mutex::new(Aggregator::new(plan.loop_breakdown_cap)));
    let started_at = Instant::now();
    let deadline = started_at + plan.duration;
    let failed = Arc::new(AtomicU32::new(0));
    let env = Arc::new(plan.env);
    let dataset = plan.data_binding.clone();
    let http_timeout = plan.http_timeout;
    let think_time = plan.think_time;
    let think_seed = plan.think_seed;
    let measure_phases = plan.measure_phases;
    let immediate = plan.ramp_down == RampDown::Immediate;
    let seq_counter = match dataset.as_ref().map(|d| d.policy) {
        Some(BindingPolicy::IterSequential | BindingPolicy::Unique) => {
            Some(Arc::new(AtomicU64::new(0)))
        }
        _ => None,
    };

    // Desired active-VU count, broadcast to every VU task. VU `i` is active iff
    // `desired > i`.
    let (desired_tx, desired_rx) = tokio::sync::watch::channel::<u32>(0);
    // Per-VU activation tokens. The supervisor re-cancels indexes >= desired EVERY
    // tick in immediate mode (idempotent — closes the wake→register race, spec §4.2).
    let slab: Arc<std::sync::Mutex<Vec<Option<CancellationToken>>>> =
        Arc::new(std::sync::Mutex::new(vec![None; max_vus as usize]));

    let mut set = JoinSet::new();
    let mut spawned: u32 = 0;

    // Flusher: mirror of run_scenario's (MetricFlush drain site #5 — see engine
    // CLAUDE.md "드레인 6/guard 5"). dropped is always 0 on this path.
    let flush_agg = agg.clone();
    let flush_out = out.clone();
    let flusher = tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_millis(500));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            ticker.tick().await;
            let now_s = chrono_second();
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
                if flush_out
                    .send(MetricFlush {
                        windows: drained,
                        loop_stats,
                        branch_stats,
                        group_stats,
                        dropped: 0,
                        phase_stats,
                    })
                    .await
                    .is_err()
                {
                    break;
                }
            }
            if flush_out.is_closed() {
                break;
            }
        }
    });

    // ── Supervisor (inline): tick until deadline ──
    let mut ticker = tokio::time::interval(Duration::from_millis(250));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        if cancel.is_cancelled() {
            break;
        }
        let now = Instant::now();
        if now >= deadline {
            break;
        }
        let elapsed = now.duration_since(started_at).as_secs_f64();
        let desired =
            (rate_at(&stages, elapsed).round() as i64).clamp(0, i64::from(max_vus)) as u32;
        // Lazy spawn: indexes the curve never reaches are never spawned.
        while spawned < desired {
            let index = spawned;
            let vu_id = plan.vu_offset.saturating_add(index);
            let scenario = scenario.clone();
            let agg = agg.clone();
            let failed = failed.clone();
            let env = env.clone();
            let cancel_vu = cancel.clone();
            let dataset = dataset.clone();
            let seq_counter = seq_counter.clone();
            let rx = desired_rx.clone();
            let slab_vu = slab.clone();
            set.spawn(async move {
                if let Err(e) = run_vu_curve(
                    scenario,
                    index,
                    vu_id,
                    agg,
                    deadline,
                    env,
                    cancel_vu,
                    rx,
                    slab_vu,
                    dataset,
                    seq_counter,
                    http_timeout,
                    think_time,
                    think_seed,
                    measure_phases,
                )
                .await
                {
                    if !matches!(e, EngineError::Aborted) {
                        warn!(vu_id, error = ?e, "vu failed");
                    }
                    failed.fetch_add(1, Ordering::Relaxed);
                }
            });
            spawned += 1;
        }
        let _ = desired_tx.send(desired);
        if immediate {
            // Idempotent re-cancel every tick (NOT falling-edge-only): closes the
            // "VU woke on watch but hasn't registered yet" race — worst lag is one
            // tick (250ms) + a step boundary (spec §4.2).
            let g = slab.lock().expect("slab mutex");
            for tok in g.iter().skip(desired as usize).flatten() {
                tok.cancel();
            }
        }
        tokio::select! {
            _ = ticker.tick() => {}
            _ = cancel.cancelled() => break,
        }
    }

    while let Some(res) = set.join_next().await {
        if let Err(e) = res {
            warn!(error = %e, "vu join error");
            failed.fetch_add(1, Ordering::Relaxed);
        }
    }

    // Final flush (MetricFlush drain site #6, guarded — dropped always 0 here).
    let (final_windows, final_loops, final_branches, final_groups, final_phases) = {
        let mut g = agg.lock().await;
        (
            g.drain_all(),
            g.drain_loop_deltas(),
            g.drain_branch_deltas(),
            g.drain_group_deltas(),
            g.drain_phase_deltas(),
        )
    };
    if !final_windows.is_empty()
        || !final_loops.is_empty()
        || !final_branches.is_empty()
        || !final_groups.is_empty()
        || !final_phases.is_empty()
    {
        let _ = out
            .send(MetricFlush {
                windows: final_windows,
                loop_stats: final_loops,
                branch_stats: final_branches,
                group_stats: final_groups,
                dropped: 0,
                phase_stats: final_phases,
            })
            .await;
    }
    drop(out);
    flusher.abort();
    let _ = flusher.await;

    if cancel.is_cancelled() {
        return Err(EngineError::Aborted);
    }
    let failed_count = failed.load(Ordering::Relaxed);
    // AllVusFailed is judged against SPAWNED, not max_vus: 250ms sampling + round
    // may never reach the curve peak, and "every VU we actually ran died" must
    // still fail the run (spec §4.3).
    if spawned > 0 && failed_count >= spawned {
        warn!(failed = failed_count, total = spawned, "all spawned VUs failed");
        return Err(EngineError::AllVusFailed {
            failed: failed_count,
            total: spawned,
        });
    }
    if failed_count > 0 {
        info!(
            failed = failed_count,
            total = spawned,
            "vu-curve run finished with partial VU failures"
        );
    } else {
        info!("vu-curve run finished");
    }
    Ok(())
}

fn clear_slot(slab: &std::sync::Mutex<Vec<Option<CancellationToken>>>, index: u32) {
    slab.lock().expect("slab mutex")[index as usize] = None;
}

/// One park-gated curve VU (spec §4.3).
///
/// INTENDED DUPLICATION of `run_vu`'s iteration body (S-C `run_arrival` precedent)
/// — keep binding select / execute_steps call / think-time pacing in lockstep with
/// `run_vu`. Curve-only deltas:
///  - park-gate around the iteration (`desired` watch; VU `index` active iff
///    `desired > index`)
///  - per-activation child token (`act`) so a supervisor retire-cancel parks the
///    VU instead of killing it; run-abort is distinguished at the park head via
///    the run-level `cancel`.
///  - retire-abort does NOT count into `failed` — NEW semantics vs run_scenario,
///    where Aborted also increments failed (harmless there: the run returns
///    Err(Aborted) anyway).
#[allow(clippy::too_many_arguments)]
#[instrument(skip_all, fields(vu_id))]
async fn run_vu_curve(
    scenario: Arc<Scenario>,
    index: u32,
    vu_id: u32,
    agg: Arc<Mutex<Aggregator>>,
    deadline: Instant,
    env: Arc<BTreeMap<String, String>>,
    cancel: CancellationToken,
    mut desired: tokio::sync::watch::Receiver<u32>,
    slab: Arc<std::sync::Mutex<Vec<Option<CancellationToken>>>>,
    dataset: Option<Arc<DataSet>>,
    seq_counter: Option<Arc<AtomicU64>>,
    http_timeout: Duration,
    think_time: Option<ThinkTime>,
    think_seed: Option<u32>,
    measure_phases: bool,
) -> Result<()> {
    // Client + rng + iter_id persist across park (Park & 재사용, spec §2):
    // the cookie jar IS the session, and iter_id stays monotonic.
    let client = VuClient::with_timeout(scenario.cookie_jar, http_timeout)?;
    let mut think_rng = match think_seed {
        Some(s) => StdRng::seed_from_u64(crate::dataset::mix(s, vu_id, 0)),
        None => StdRng::from_entropy(),
    };
    let mut iter_id: u32 = 0;
    let deadline_tokio = tokio::time::Instant::from_std(deadline);
    loop {
        // ── park: 3-way select — watch / run-cancel / deadline (spec §4.3) ──
        if cancel.is_cancelled() {
            return Err(EngineError::Aborted);
        }
        if Instant::now() >= deadline {
            return Ok(());
        }
        if *desired.borrow() <= index {
            tokio::select! {
                r = desired.wait_for(|d| *d > index) => {
                    if r.is_err() {
                        return Ok(()); // sender dropped — run is tearing down
                    }
                }
                _ = cancel.cancelled() => return Err(EngineError::Aborted),
                _ = tokio::time::sleep_until(deadline_tokio) => return Ok(()),
            }
        }
        // ── activate: child token, register in slab (both modes — run-abort
        //    propagates from the parent token automatically) ──
        let act = cancel.child_token();
        slab.lock().expect("slab mutex")[index as usize] = Some(act.clone());
        // ── active loop: iterate until retired / deadline ──
        loop {
            if Instant::now() >= deadline {
                clear_slot(&slab, index);
                return Ok(());
            }
            if act.is_cancelled() {
                break; // retire (or run-abort — re-checked at the park head)
            }
            // Per-iteration flow vars: lockstep with run_vu.
            let mut iter_vars: BTreeMap<String, String> = scenario.variables.clone();
            if let Some(ds) = &dataset {
                match ds.select_index(vu_id, iter_id, seq_counter.as_deref()) {
                    Some(idx) => {
                        for (k, v) in &ds.rows[idx] {
                            iter_vars.insert(k.clone(), v.clone());
                        }
                    }
                    // unique slice exhausted → permanent clean stop (mirror run_vu).
                    None => {
                        clear_slot(&slab, index);
                        return Ok(());
                    }
                }
            }
            let flow = match execute_steps(
                &client,
                &scenario.steps,
                &mut iter_vars,
                &agg,
                deadline,
                &env,
                vu_id,
                iter_id,
                None,
                &act,
                &mut think_rng,
                measure_phases,
            )
            .await
            {
                Ok(f) => f,
                Err(e) => {
                    clear_slot(&slab, index);
                    return Err(e); // genuine engine error → permanent VU death
                }
            };
            match flow {
                StepFlow::Continue => {
                    // run_vu increments at the loop tail; doing it on Continue is
                    // equivalent (the non-Continue paths there return entirely).
                    iter_id = iter_id.wrapping_add(1);
                }
                StepFlow::DeadlineReached => {
                    clear_slot(&slab, index);
                    return Ok(());
                }
                StepFlow::Aborted => break, // act cancelled — retire or run-abort
            }
            // Gate re-check BEFORE think-time pacing (graceful-lag mitigation,
            // spec §2): a retire at this point skips the sleep entirely.
            if *desired.borrow() <= index {
                break;
            }
            if let Some(tt) = think_time {
                match pace(tt.sample(&mut think_rng), deadline, &act).await {
                    PaceOutcome::Cancelled => break, // retire or run-abort
                    PaceOutcome::DeadlineReached => {
                        clear_slot(&slab, index);
                        return Ok(());
                    }
                    PaceOutcome::Slept => {}
                }
            }
        }
        // ── deactivate: clear slot; run-abort exits, retire parks ──
        clear_slot(&slab, index);
        if cancel.is_cancelled() {
            return Err(EngineError::Aborted);
        }
    }
}
```

`crates/engine/src/lib.rs` — `run_scenario_vu_curve` re-export 추가.

- [ ] **Step 4: GREEN 확인** — `cargo test -p handicap-engine --test vu_curve > /tmp/vc.log 2>&1; echo exit=$?` (파이프 마스킹 금지) → 전부 PASS. 추가로 `cargo test -p handicap-engine`(전체) PASS — 기존 closed/open 테스트 무영향 확인.

- [ ] **Step 5: clippy + fmt** — `cargo clippy -p handicap-engine --all-targets -- -D warnings && cargo fmt`

- [ ] **Step 6: 커밋**

```bash
git add crates/engine/src/runner.rs crates/engine/src/lib.rs crates/engine/tests/vu_curve.rs
git commit -m "feat(engine): run_scenario_vu_curve — park-gate VU 곡선 (graceful/immediate retire, 격리 함수)"
```

---

### Task 3: proto 필드 12·13 + 워커 배선

**Files:**
- Modify: `crates/proto/proto/coordinator.proto` (`Profile` 메시지)
- Modify: `crates/worker/src/main.rs` (3-way 분기 + duration + RunPlan 매핑)
- Modify: proto `Profile {` 리터럴 전 사이트 (controller dispatch는 Task 4 — 여기선 `vu_stages: vec![], ramp_down_immediate: false` 기존-값 갱신만)

- [ ] **Step 1: proto 필드 추가**

`coordinator.proto`의 `Profile` 메시지 `measure_phases = 11;` 뒤에:

```proto
  repeated Stage vu_stages = 12;       // closed-loop VU curve; empty = absent (spec §3.1)
  bool ramp_down_immediate = 13;       // VU-curve ramp-down: false = graceful (default)
```

- [ ] **Step 2: 워크스페이스 컴파일 → proto `Profile {` 리터럴 전부 갱신**

```bash
cargo build --workspace --tests 2>&1 | grep -c "missing field"
grep -rn "v1::Profile {\|pb::Profile {" crates/ | grep -v target
```

모든 prost `Profile` 리터럴에 `vu_stages: vec![], ramp_down_immediate: false,` 추가 (controller `api/runs.rs:313` dispatch 사이트 포함 — **이 task에선 기존-동작 값으로만**, 실제 매핑은 Task 4).

- [ ] **Step 3: 워커 분기 RED 테스트**

`crates/worker/src/main.rs`의 인라인 `#[cfg(test)] mod tests`(있으면 — `run_duration_secs` 기존 테스트 위치)에:

```rust
#[test]
fn run_duration_uses_vu_stage_sum() {
    let p = pb::Profile {
        duration_seconds: 0,
        vu_stages: vec![
            pb::Stage { target: 5, duration_seconds: 3 },
            pb::Stage { target: 1, duration_seconds: 4 },
        ],
        ..base_profile() // 기존 테스트의 base 헬퍼를 미러 — 없으면 전 필드 명시
    };
    assert_eq!(run_duration_secs(&p), 7);
    assert!(proto_is_vu_curve(&p));
    assert!(!proto_is_open_loop(&p));
}
```

(prost 타입은 `Default`를 derive하므로 테스트 한정 `..Default::default()` spread 가능 — 기존 워커 테스트 컨벤션을 따른다.)

- [ ] **Step 4: 워커 구현**

`run_duration_secs` 교체:

```rust
/// Total run duration for the engine: VU-curve stage sum > rate-curve stage sum >
/// flat duration_seconds. Invariant: engine deadline = this value.
fn run_duration_secs(p: &pb::Profile) -> u64 {
    if !p.vu_stages.is_empty() {
        p.vu_stages.iter().map(|s| u64::from(s.duration_seconds)).sum()
    } else if p.stages.is_empty() {
        u64::from(p.duration_seconds)
    } else {
        p.stages.iter().map(|s| u64::from(s.duration_seconds)).sum()
    }
}

/// Closed-loop VU curve when vu_stages is non-empty (spec §3.1). Empty ≡ absent.
fn proto_is_vu_curve(p: &pb::Profile) -> bool {
    !p.vu_stages.is_empty()
}
```

RunPlan 빌드(`main.rs:188` 부근) — predicate 캡처에 `let is_vu_curve = proto_is_vu_curve(&profile);` 추가(기존 `is_open_loop` 캡처와 같은 줄들 — partial-move 전), 리터럴에:

```rust
        vu_stages: if profile.vu_stages.is_empty() {
            None
        } else {
            Some(
                profile
                    .vu_stages
                    .iter()
                    .map(|s| handicap_engine::Stage {
                        target: s.target,
                        duration_seconds: s.duration_seconds,
                    })
                    .collect(),
            )
        },
        ramp_down: if profile.ramp_down_immediate {
            handicap_engine::RampDown::Immediate
        } else {
            handicap_engine::RampDown::Graceful
        },
```

실행 분기(`main.rs:357` 부근) 3-way로:

```rust
    let run_res = if is_vu_curve {
        run_scenario_vu_curve(scenario, plan, win_tx, cancel).await
    } else if is_open_loop {
        run_scenario_open_loop(scenario, plan, win_tx, cancel).await
    } else {
        run_scenario(scenario, plan, win_tx, cancel).await
    };
```

(import에 `run_scenario_vu_curve` 추가.)

- [ ] **Step 5: GREEN + 게이트** — `cargo test -p handicap-worker` PASS, `cargo build --workspace --tests` 0 에러, clippy + fmt.

- [ ] **Step 6: 커밋** — `git add crates/proto/proto/coordinator.proto crates/worker/src/main.rs <리터럴 파일들>` 후 commit `"feat(proto+worker): Profile.vu_stages=12/ramp_down_immediate=13 + 워커 3-way 분기"`.

---

### Task 4: 컨트롤러 — store 필드 + `is_vu_curve` + 검증 ①–⑨ + 판별 4 사이트 + dispatch 매핑

**Files:**
- Modify: `crates/controller/src/store/runs.rs` (Profile 필드 + 헬퍼)
- Modify: `crates/controller/src/api/runs.rs` (validate + 4 사이트 + dispatch + 인라인 테스트)
- Modify: 컨트롤러 store `Profile {` 리터럴 ~15곳 (테스트)

- [ ] **Step 1: store Profile 필드 + 헬퍼 (인라인 테스트 RED 먼저)**

`api/runs.rs`의 기존 `is_open_loop_predicate` 테스트(:1050 부근) 옆에 RED 테스트:

```rust
    #[test]
    fn is_vu_curve_predicate() {
        let mut p = valid_profile(); // 그 mod tests의 기존 base 헬퍼 사용 (이름이 다르면 기존 테스트와 동일하게)
        assert!(!p.is_vu_curve());
        p.vu_stages = Some(vec![]); // Some(vec![]) ≡ absent (S-D 미러)
        assert!(!p.is_vu_curve());
        p.vu_stages = Some(vec![handicap_engine::Stage { target: 5, duration_seconds: 10 }]);
        assert!(p.is_vu_curve());
        assert!(!p.is_open_loop()); // vu_stages는 is_open_loop에 영향 없음
        assert_eq!(p.vu_curve_max(), 5);
    }
```

`store/runs.rs` Profile에 (`measure_phases` 뒤):

```rust
    /// Closed-loop VU 곡선 (spec §3.1). skip_serializing_if → UI Zod `.optional()`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vu_stages: Option<Vec<handicap_engine::Stage>>,
    /// VU 곡선 ramp-down 노브. absent = graceful (spec §2).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ramp_down: Option<handicap_engine::RampDown>,
```

impl Profile에:

```rust
    /// Closed-loop VU curve (vu_stages 비어있지 않음). `Some(vec![])` ≡ absent.
    /// 판별은 반드시 이 헬퍼로 — `vu_stages.is_some()` 직접 분기 금지 (spec §3.3).
    pub fn is_vu_curve(&self) -> bool {
        self.vu_stages.as_ref().is_some_and(|s| !s.is_empty())
    }

    /// 곡선의 최대 목표 VU — park-gate 슬랩 크기 = per_vu row 요구치 = enqueue
    /// total_vus (spec §3.3). 비어있으면 0 (is_vu_curve가 false인 경우만).
    pub fn vu_curve_max(&self) -> u32 {
        self.vu_stages
            .as_deref()
            .unwrap_or_default()
            .iter()
            .map(|s| s.target)
            .max()
            .unwrap_or(0)
    }
```

store `Profile {` 리터럴 전 사이트에 `vu_stages: None, ramp_down: None,` 추가:

```bash
cargo build --workspace --tests 2>&1 | grep "missing field" # 사이트 열거
```

- [ ] **Step 2: 검증 테스트 RED (①–⑨ + 유효 통과)**

같은 mod tests에 — 기존 open-loop 검증 테스트(:954–1013 부근)의 state/profile 헬퍼 컨벤션을 그대로 미러. 케이스(각각 `validate_run_config` 호출, 메시지 부분 문자열 단언):

| 케이스 | profile 설정 | 기대 |
|---|---|---|
| ① | vu_stages=[{5,10}] + target_rps=Some(10) | 400 "vu_stages와 target_rps" |
| ② | vu_stages + max_in_flight=Some(10) | 400 "max_in_flight" |
| ③ | vu_stages + stages=[{10,10}] | 400 "stages(RPS 곡선)" |
| ④ | vu_stages + ramp_up_seconds=5 | 400 "ramp_up_seconds" |
| ⑤ | vu_stages + duration_seconds=10 | 400 "duration_seconds" |
| ⑥ | vu_stages + vus=5 | 400 "vus를 비워야" |
| ⑦a | vu_stages=[{5,0}] | 400 "duration_seconds must be >= 1" |
| ⑦b | vu_stages=[{capacity+1,10}] | 400 "워커 용량" |
| ⑧ | vu_stages=[{0,10}] | 400 "0보다 커야" |
| ⑨ | vu_stages 없음 + ramp_down=Some(Graceful) | 400 "VU 곡선) 전용" |
| 통과 | vus=0,duration=0,ramp_up=0 + vu_stages=[{5,10},{1,10}] (+ramp_down=Some(Immediate)) | Ok(None) |

- [ ] **Step 3: 검증 구현**

`validate_run_config`(:79) 본문 최상단(기존 `if profile.is_open_loop()` 앞)에:

```rust
    // ── ramp_down은 VU 곡선 전용 노브 (spec §3.2 ⑨) ──
    if !profile.is_vu_curve() && profile.ramp_down.is_some() {
        return Err(ApiError::BadRequest(
            "ramp_down은 vu_stages(VU 곡선) 전용입니다".into(),
        ));
    }
    // ── closed-loop VU curve (spec §3.2 ①–⑧): open-loop 분기보다 먼저 — curve
    //    규칙이 open-loop 필드 배제를 포함하므로 에러 메시지의 권위가 여기다 ──
    if profile.is_vu_curve() {
        if profile.target_rps.is_some() {
            return Err(ApiError::BadRequest(
                "vu_stages와 target_rps는 함께 쓸 수 없습니다 (VU 곡선 vs RPS 지정 충돌)".into(),
            ));
        }
        if profile.max_in_flight.is_some() {
            return Err(ApiError::BadRequest(
                "vu_stages에선 max_in_flight를 쓸 수 없습니다 (open-loop 전용)".into(),
            ));
        }
        if profile.stages.as_ref().is_some_and(|s| !s.is_empty()) {
            return Err(ApiError::BadRequest(
                "vu_stages와 stages(RPS 곡선)는 함께 쓸 수 없습니다".into(),
            ));
        }
        if profile.ramp_up_seconds > 0 {
            return Err(ApiError::BadRequest(
                "vu_stages 사용 시 ramp_up_seconds를 비워야 합니다 (곡선이 ramp의 일반화)".into(),
            ));
        }
        if profile.duration_seconds > 0 {
            return Err(ApiError::BadRequest(
                "vu_stages 사용 시 duration_seconds를 비워야 합니다 (총 길이 = stage 합)".into(),
            ));
        }
        if profile.vus > 0 {
            return Err(ApiError::BadRequest(
                "vu_stages 사용 시 vus를 비워야 합니다 (곡선이 VU 수를 정의)".into(),
            ));
        }
        let capacity = state.coord.worker_capacity_vus;
        let stages = profile.vu_stages.as_deref().unwrap_or_default();
        for s in stages {
            if s.duration_seconds == 0 {
                return Err(ApiError::BadRequest(
                    "stage duration_seconds must be >= 1".into(),
                ));
            }
            if s.target > capacity {
                return Err(ApiError::BadRequest(format!(
                    "최대 목표 VU {}가 워커 용량 {capacity}을 초과합니다 \
                     (vu_stages는 단일 워커 — 멀티워커 곡선 샤딩 미지원, spec §9)",
                    s.target
                )));
            }
        }
        if !stages.iter().any(|s| s.target > 0) {
            return Err(ApiError::BadRequest(
                "최소 한 stage의 target은 0보다 커야 합니다".into(),
            ));
        }
    } else if profile.is_open_loop() {
```

기존 `if profile.is_open_loop() {`를 `} else if profile.is_open_loop() {`로 잇고, 기존 꼬리 `} else if profile.vus == 0 || profile.duration_seconds == 0 {`는 그대로(curve는 첫 분기에서 소화돼 도달 안 함).

- [ ] **Step 4: 판별 4 사이트 + dispatch 매핑 (spec §3.3/§5)**

① per_vu slot_count(:271):

```rust
                    let slot_count = if profile.is_vu_curve() {
                        u64::from(profile.vu_curve_max())
                    } else if profile.is_open_loop() {
                        profile.max_in_flight.unwrap_or(0) as u64
                    } else {
                        profile.vus as u64
                    };
```

② unique N(:217) 및 ③ create N(:341) — 두 곳 모두:

```rust
        let n = if profile.is_vu_curve() || profile.is_open_loop() {
            1 // 단일 워커 v1 (curve: 검증 ⑦이 capacity 이내 보장 / open-loop: spec §9)
        } else {
            state.coord.worker_count_for(profile.vus)
        };
```

④ enqueue total_vus(:348):

```rust
    // curve의 total_vus = max(stage.target) — profile.vus(=0)를 넘기면 register의
    // shard_split(0,…)이 vu_count=0을 만들어 §5 와이어 약속과 모순 (spec §3.3).
    let total_vus = if profile.is_vu_curve() {
        profile.vu_curve_max()
    } else {
        profile.vus
    };
    state
        .coord
        .enqueue(row.id.clone(), assignment, n, total_vus)
        .await;
```

dispatch proto 매핑(:313 리터럴의 Task 3 placeholder 교체):

```rust
            vu_stages: profile
                .vu_stages
                .as_deref()
                .unwrap_or_default()
                .iter()
                .map(|s| handicap_proto::v1::Stage {
                    target: s.target,
                    duration_seconds: s.duration_seconds,
                })
                .collect(),
            ramp_down_immediate: matches!(
                profile.ramp_down,
                Some(handicap_engine::RampDown::Immediate)
            ),
```

- [ ] **Step 5: GREEN + 게이트** — `cargo test -p handicap-controller > /tmp/ct.log 2>&1; echo exit=$?` PASS, `cargo build --workspace --tests`, clippy, fmt.

- [ ] **Step 6: 커밋** — `"feat(controller): vu_stages 검증 ①–⑨ + is_vu_curve 판별 4사이트 + dispatch 매핑"`

---

### Task 5: 컨트롤러 e2e smoke

**Files:**
- Modify: `crates/controller/tests/e2e_test.rs`

- [ ] **Step 1: 기존 `stages_open_loop_e2e_smoke`(:1612)를 읽고 미러로 작성**

`vu_curve_e2e_smoke`: 같은 하네스(실 워커 바이너리 + wiremock)로 profile만 교체 —

```json
{"vus":0,"duration_seconds":0,"ramp_up_seconds":0,
 "vu_stages":[{"target":2,"duration_seconds":2},{"target":1,"duration_seconds":2}],
 "ramp_down":"immediate"}
```

단언: run이 `completed` 도달 + `/report` 200 + `summary.count > 0` + `summary.errors == 0` (기존 smoke의 단언 형태 미러). cold-build flake 주의(루트 CLAUDE.md — `cargo build -p handicap-worker` warm 후 실행).

- [ ] **Step 2: 실행** — `cargo test -p handicap-controller --test e2e_test vu_curve_e2e_smoke > /tmp/e2e.log 2>&1; echo exit=$?` PASS.

- [ ] **Step 3: 커밋** — `"test(controller): vu_curve e2e smoke (graceful 곡선 run 완주 + report)"`

---

### Task 6: UI — Zod + `loadModel.ts` + `deriveLoadMode` + `profileDurationSeconds`

**Files:**
- Modify: `ui/src/api/schemas.ts` (ProfileSchema)
- Modify: `ui/src/components/loadModel.ts`
- Modify: `ui/src/api/runPrefill.ts`
- Test: `ui/src/components/__tests__/loadModel.test.ts`, `ui/src/api/__tests__/runPrefill.test.ts`(기존 위치 확인 — 없으면 profileDurationSeconds 기존 테스트 파일에 추가)

- [ ] **Step 1: 테스트 RED**

`loadModel.test.ts`에 추가:

```ts
it("closed+curve: vu_stages·think_time 존재, vus===0, duration===0, ramp_up===0, target_rps/max_in_flight/stages 부재", () => {
  const p = buildLoadProfile({
    ...base, // 그 파일의 기존 base state 헬퍼 사용
    loadModel: "closed",
    rateMode: "curve",
    stages: [{ target: "50", duration_seconds: "60" }],
    thinkMin: "100",
    thinkMax: "300",
    rampDown: "graceful",
  });
  expect(p.vus).toBe(0);
  expect(p.duration_seconds).toBe(0);
  expect(p.ramp_up_seconds).toBe(0);
  expect(p.vu_stages).toEqual([{ target: 50, duration_seconds: 60 }]);
  expect(p.think_time).toEqual({ min_ms: 100, max_ms: 300 });
  expect(p).not.toHaveProperty("target_rps");
  expect(p).not.toHaveProperty("max_in_flight");
  expect(p).not.toHaveProperty("stages");
  expect(p).not.toHaveProperty("ramp_down"); // graceful = absent (byte-minimal)
});

it("closed+curve: rampDown=immediate일 때만 ramp_down emit", () => {
  const p = buildLoadProfile({
    ...base,
    loadModel: "closed",
    rateMode: "curve",
    stages: [{ target: "50", duration_seconds: "60" }],
    rampDown: "immediate",
  });
  expect(p.ramp_down).toBe("immediate");
});

it("closed+curve에서도 stagesInvalid가 작동 (curve 공통 일반화)", () => {
  const e = loadModelErrors({
    ...base,
    loadModel: "closed",
    rateMode: "curve",
    stages: [{ target: "0", duration_seconds: "30" }],
  });
  expect(e.stagesInvalid).toBe(true);
});

describe("deriveLoadMode", () => {
  it("vu_stages → closed+curve / stages → open+curve / target_rps → open+fixed / 그 외 closed+fixed", () => {
    expect(deriveLoadMode({ vu_stages: [{ target: 5, duration_seconds: 10 }] }))
      .toEqual({ loadModel: "closed", rateMode: "curve" });
    expect(deriveLoadMode({ stages: [{ target: 5, duration_seconds: 10 }] }))
      .toEqual({ loadModel: "open", rateMode: "curve" });
    expect(deriveLoadMode({ target_rps: 100 })).toEqual({ loadModel: "open", rateMode: "fixed" });
    expect(deriveLoadMode({})).toEqual({ loadModel: "closed", rateMode: "fixed" });
    expect(deriveLoadMode({ vu_stages: [] })).toEqual({ loadModel: "closed", rateMode: "fixed" });
  });
});
```

기존 테스트 갱신 2건: `"closed: target_rps/stages/max_in_flight 부재"`는 유지(closed+fixed), `"closed에선 stagesInvalid 항상 false (curve는 open 전용)"` → **closed+fixed에선 false**로 이름·내용 수정(curve 일반화 반영).

`profileDurationSeconds` 테스트(기존 파일에):

```ts
it("vu_stages 합산 (closed-loop 곡선 run)", () => {
  expect(
    profileDurationSeconds({
      duration_seconds: 0,
      stages: undefined,
      vu_stages: [
        { target: 10, duration_seconds: 30 },
        { target: 2, duration_seconds: 60 },
      ],
    }),
  ).toBe(90);
});
```

- [ ] **Step 2: 구현**

`schemas.ts` ProfileSchema의 `stages` 줄 아래:

```ts
  // closed-loop VU 곡선 (spec §3.1). 서버 #[serde(skip_serializing_if)] → absent → .optional()
  vu_stages: z.array(StageSchema).optional(),
  ramp_down: z.enum(["graceful", "immediate"]).optional(),
```

`loadModel.ts`:
- `LoadModelState`에 `rampDown: "graceful" | "immediate";` 추가.
- `LoadProfileFields`의 `Partial<Pick<...>>`에 `"vu_stages" | "ramp_down"` 추가.
- `buildLoadProfile` 최상단에 closed+curve arm:

```ts
  if (s.loadModel === "closed" && s.rateMode === "curve") {
    return {
      vus: 0,
      duration_seconds: 0, // curve: 총 길이 = sum(vu_stages); 서버는 >0 + vu_stages를 400
      ramp_up_seconds: 0,
      vu_stages: s.stages.map((x) => ({
        target: Number(x.target),
        duration_seconds: Number(x.duration_seconds),
      })),
      think_time: buildThinkTime(s), // closed-loop이므로 허용 (spec §3.2)
      think_seed: s.thinkSeed.trim() !== "" ? Number(s.thinkSeed) : undefined,
      ...(s.rampDown === "immediate" ? { ramp_down: "immediate" as const } : {}),
      // NO target_rps, NO max_in_flight, NO stages
    };
  }
```

- `loadModelErrors`의 `stagesInvalid`에서 `s.loadModel === "open" &&` 조건 제거(곡선 공통):

```ts
  const stagesInvalid =
    s.rateMode === "curve" &&
    (s.stages.length === 0 || ...기존 그대로...);
```

- `deriveLoadMode` 추가:

```ts
export type LoadMode = { loadModel: "closed" | "open"; rateMode: "fixed" | "curve" };

/** profile → (loadModel, rateMode) 역도출 — RunDialog init / RunDialog loadPreset /
 *  ScheduleForm init 3사이트가 공유. 한 곳이라도 빠지면 vu_stages 든 프리셋이
 *  closed+fixed로 조용히 로드돼 곡선이 증발한다 (spec §6.3). */
export function deriveLoadMode(p: {
  target_rps?: number | null;
  stages?: { target: number; duration_seconds: number }[] | null;
  vu_stages?: { target: number; duration_seconds: number }[] | null;
}): LoadMode {
  if (p.vu_stages && p.vu_stages.length > 0) return { loadModel: "closed", rateMode: "curve" };
  if (p.stages && p.stages.length > 0) return { loadModel: "open", rateMode: "curve" };
  if (p.target_rps != null) return { loadModel: "open", rateMode: "fixed" };
  return { loadModel: "closed", rateMode: "fixed" };
}
```

`runPrefill.ts` — `profileDurationSeconds` 교체:

```ts
export function profileDurationSeconds(
  profile: Pick<Profile, "duration_seconds" | "stages" | "vu_stages">,
): number {
  const curve = profile.vu_stages?.length ? profile.vu_stages : profile.stages;
  if (curve && curve.length > 0) {
    return curve.reduce((acc, s) => acc + s.duration_seconds, 0);
  }
  return profile.duration_seconds;
}
```

(독스트링도 vu_stages 언급으로 갱신. 호출부 2곳(RunDetailPage/ScenarioRunsPage)은 `Pick` 확장이라 무수정 컴파일 — 확인만.)

- [ ] **Step 3: GREEN + 게이트** — `cd ui && pnpm test loadModel && pnpm test runPrefill` PASS → 전체 `pnpm lint && pnpm test && pnpm build`.

- [ ] **Step 4: 커밋** — `"feat(ui): vu_stages/ramp_down Zod + buildLoadProfile 4번째 모드 + deriveLoadMode + duration 합산"`

---

### Task 7: UI — `ko.ts` 카피 + `LoadModelFields` 재구성

**Files:**
- Modify: `ui/src/i18n/ko.ts`
- Modify: `ui/src/components/LoadModelFields.tsx`
- Test: `ui/src/components/__tests__/LoadModelFields.test.tsx`, `ui/src/i18n/__tests__/ko.test.ts`

- [ ] **Step 1: ko.ts 신규 키 (전부 카탈로그 경유 — ADR-0035)**

`glossary`에:

```ts
    vuCurve:
      "VU 곡선 — 동시 사용자 수를 시간에 따라 단계별로 늘렸다 줄이는 부하 방식입니다. 점심 피크, 이벤트 오픈처럼 사용자 수가 변하는 상황을 재현합니다.",
    rampDown:
      "줄이는 방식 — 곡선이 내려갈 때 초과분 사용자를 정리하는 방법입니다. '요청을 마친 뒤'는 안전하지만 약간 늦게 줄고, '즉시'는 곡선에 충실하지만 진행 중이던 요청 1개는 마저 끝납니다.",
```

`loadModel`에:

```ts
    curveTargetVu: "목표 VU",
    curveTargetRps: "목표 RPS",
    curveHintVu: "각 단계가 끝날 때의 목표 동시 사용자 수 (이전 값에서 선형 변화)",
    curveHintRps: "각 단계가 끝날 때의 목표 초당 요청 수 (이전 값에서 선형 변화)",
    curvePreviewAriaVu: "VU 곡선 미리보기 (x: 누적 초, y: VU)",
    curvePreviewAriaRps: "레이트 곡선 미리보기 (x: 누적 초, y: RPS)",
    rampDownLabel: "줄이는 방식",
    rampDownGraceful: "요청을 마친 뒤 줄이기 (권장) — 안전하지만 곡선보다 약간 늦게 줄어듭니다",
    rampDownImmediate: "즉시 줄이기 — 곡선에 충실하지만 진행 중이던 요청 1개는 마저 끝납니다",
```

`report`에 (Task 8의 ReportHeadline이 소비):

```ts
    headlineClosedCurve: (p: { duration: string; count: string; p95: string; errPct: string }) =>
      `${p.duration} 동안 단계별 VU 곡선으로 ${p.count}회 요청 — 95%가 ${p.p95} 안에 응답, 에러 ${p.errPct}`,
```

`ko.test.ts`의 기존 패턴(키 존재/함수형 카탈로그 검증)에 신규 키 추가.

- [ ] **Step 2: LoadModelFields RTL 테스트 RED**

기존 `LoadModelFields.test.tsx`에 추가 (기존 렌더 헬퍼 미러 — props에 `rampDown`/`setRampDown` 추가 필요):

```tsx
it("closed에서 곡선 라디오가 활성화돼 선택 가능 (곧 지원 제거)", async () => {
  const user = userEvent.setup();
  renderFields({ loadModel: "closed", rateMode: "fixed" });
  const curve = screen.getByRole("radio", { name: "곡선" });
  expect(curve).toBeEnabled();
  await user.click(curve);
  expect(setRateMode).toHaveBeenCalledWith("curve");
});

it("closed 라디오 클릭이 rateMode를 리셋하지 않는다 (eager reset 제거)", async () => {
  const user = userEvent.setup();
  renderFields({ loadModel: "open", rateMode: "curve" });
  await user.click(screen.getByRole("radio", { name: /사용자 수 기준/ }));
  expect(setRateMode).not.toHaveBeenCalled();
});

it("closed+curve: 목표 VU 라벨 + ramp_down 라디오 + vus/chips/ramp_up/duration/max_in_flight 비노출", () => {
  renderFields({ loadModel: "closed", rateMode: "curve" });
  expect(screen.getAllByText("목표 VU").length).toBeGreaterThan(0);
  expect(screen.getByRole("radio", { name: /요청을 마친 뒤 줄이기/ })).toBeChecked();
  expect(screen.getByRole("radio", { name: /즉시 줄이기/ })).not.toBeChecked();
  expect(screen.queryByLabelText(ko.loadModel.vus)).not.toBeInTheDocument();
  expect(screen.queryByRole("group", { name: ko.loadModel.sizePresetsLabel })).not.toBeInTheDocument();
  expect(screen.queryByLabelText(ko.loadModel.rampUp)).not.toBeInTheDocument();
  expect(screen.queryByLabelText(ko.loadModel.duration)).not.toBeInTheDocument();
  expect(screen.queryByLabelText(ko.loadModel.maxInFlight)).not.toBeInTheDocument();
});

it("open+curve: 기존 목표 RPS 라벨 유지 + ramp_down 비노출 (회귀 가드)", () => {
  renderFields({ loadModel: "open", rateMode: "curve" });
  expect(screen.getAllByText("목표 RPS").length).toBeGreaterThan(0);
  expect(screen.queryByRole("radio", { name: /즉시 줄이기/ })).not.toBeInTheDocument();
});
```

- [ ] **Step 3: LoadModelFields 재구성**

- Props에 `rampDown: "graceful" | "immediate"; setRampDown: (m: "graceful" | "immediate") => void;` 추가.
- closed 라디오 onChange에서 `setRateMode("fixed")` 줄 제거, 곡선 라디오의 `disabled`/`(곧 지원)`/클래스 분기 제거.
- 기존 곡선 에디터 블록(:286–407 — 모양 select·stage 행·총 길이·stagesInvalid·미리보기)을 **컴포넌트 본문 위 지역 JSX 변수 `curveEditor`로 호이스팅**하고 라벨만 모드 분기:
  - `목표 RPS` 텍스트 → `{loadModel === "closed" ? ko.loadModel.curveTargetVu : ko.loadModel.curveTargetRps}`
  - 힌트 p 2줄 중 첫 줄 → `curveHintVu`/`curveHintRps` 분기 (둘째 줄 "지속 시간" 공통 유지)
  - 미리보기 aria-label → `curvePreviewAriaVu`/`curvePreviewAriaRps` 분기
  - stagesInvalid 인라인 문구는 기존 그대로(소급 카탈로그 이전 비목표)
- 렌더 트리:

```tsx
{loadModel === "closed" ? (
  rateMode === "curve" ? (
    <>
      {curveEditor}
      <fieldset className="mb-3">
        <legend className="text-sm text-slate-600 mb-1">
          {ko.loadModel.rampDownLabel}
        </legend>
        <HelpTip label="줄이는 방식 설명">{ko.glossary.rampDown}</HelpTip>
        <div className="flex flex-col gap-1">
          <label className="flex items-center gap-1 text-sm cursor-pointer">
            <input
              type="radio"
              name="ramp-down"
              value="graceful"
              checked={rampDown === "graceful"}
              onChange={() => setRampDown("graceful")}
            />
            {ko.loadModel.rampDownGraceful}
          </label>
          <label className="flex items-center gap-1 text-sm cursor-pointer">
            <input
              type="radio"
              name="ramp-down"
              value="immediate"
              checked={rampDown === "immediate"}
              onChange={() => setRampDown("immediate")}
            />
            {ko.loadModel.rampDownImmediate}
          </label>
        </div>
      </fieldset>
    </>
  ) : (
    <>... 기존 chips + vus/duration/rampUp 그리드 그대로 ...</>
  )
) : (
  <>... 기존 open 분기 그대로 (curve면 {curveEditor}) ...</>
)}
```

(HelpTip은 legend **밖** — U3 accname 오염 함정. 기존 open 분기의 렌더 결과는 변경 0 — 회귀 테스트가 가드.)

- 곡선 라디오 라벨 옆 HelpTip 추가: closed+curve 개념 안내는 곡선 라디오에 — `프로파일` fieldset의 곡선 label 형제로 `<HelpTip label="VU 곡선 설명">{ko.glossary.vuCurve}</HelpTip>`을 **closed일 때만** 노출(open 곡선은 기존 RPS 의미라 그대로).

- [ ] **Step 4: GREEN + 게이트** — `pnpm test LoadModelFields && pnpm test ko` PASS → `pnpm lint && pnpm test && pnpm build`. (이 시점에 RunDialog/ScheduleForm이 새 필수 props로 `tsc -b` 깨지면 — Task 8을 같은 커밋으로 fold하지 말고, props를 optional default로 두지도 말고, **Task 7+8을 한 커밋으로 합치는 게 아니라 Task 7에서 두 부모에 `rampDown={"graceful"} setRampDown={() => {}}` 임시 배선 금지** — 올바른 해법: Task 7과 8은 **하나의 커밋**으로 합쳐 props 추가와 부모 배선을 원자적으로. 오케스트레이터는 Task 7 구현 후 커밋 없이 Task 8로 이어 한 번에 커밋한다.)

- [ ] **Step 5: 커밋은 Task 8과 통합** (위 사유 — `tsc -b`는 프로젝트 전체 타입체크라 부모 미배선 상태로 green 커밋 불가).

---

### Task 8: UI — RunDialog/ScheduleForm 배선 + ReportHeadline (Task 7과 한 커밋)

**Files:**
- Modify: `ui/src/components/RunDialog.tsx`
- Modify: `ui/src/components/ScheduleForm.tsx`
- Modify: `ui/src/components/report/ReportHeadline.tsx`
- Test: `ui/src/components/__tests__/RunDialog.test.tsx`, `__tests__/ScheduleForm.test.tsx`, `report/__tests__/ReportHeadline.test.tsx`(기존 위치 미러)

- [ ] **Step 1: RTL 테스트 RED**

RunDialog (기존 테스트 헬퍼 미러):

```tsx
it("closed+curve 제출: vu_stages payload + ramp_down immediate", async () => {
  // 곡선 라디오 클릭 → stage 행 입력 → 즉시 줄이기 선택 → Run.
  // mutation mock의 마지막 호출 payload.profile 단언:
  //   vus: 0, duration_seconds: 0, vu_stages: [{target, duration_seconds}],
  //   ramp_down: "immediate", target_rps/max_in_flight/stages 부재.
});

it("vu_stages 든 run 프리필이 closed+curve로 역도출되고 stage 행·rampDown이 시드된다", () => {
  // initial.profile = { vus:0, duration_seconds:0, vu_stages:[{target:7,duration_seconds:11}], ramp_down:"immediate", ... }
  // → 곡선 라디오 checked + "사용자 수 기준" checked + stage target 입력값 "7" + 즉시 줄이기 checked.
});
```

ScheduleForm: 같은 형태로 init 역도출 1건. ReportHeadline: `vu_stages` 있는 profile fixture → `단계별 VU 곡선으로` 문구 포함 + `동시 사용자 0명` 미포함.

(구체 쿼리는 각 파일의 기존 테스트 컨벤션을 따른다 — RunDialog는 `getByRole("radio", {name: "곡선"})`, stage 입력은 `getByLabelText("stage target 0")`.)

- [ ] **Step 2: RunDialog 배선**

- import에 `deriveLoadMode` 추가. init 교체(:66–86):

```tsx
  const initMode = deriveLoadMode(initial?.profile ?? {});
  const [loadModel, setLoadModel] = useState<"closed" | "open">(initMode.loadModel);
  const [rateMode, setRateMode] = useState<"fixed" | "curve">(initMode.rateMode);
  const [rampDown, setRampDown] = useState<"graceful" | "immediate">(
    initial?.profile.ramp_down ?? "graceful",
  );
  const [stages, setStages] = useState<{ target: string; duration_seconds: string }[]>(
    (initial?.profile.vu_stages?.length
      ? initial.profile.vu_stages
      : initial?.profile.stages
    )?.map((s) => ({
      target: String(s.target),
      duration_seconds: String(s.duration_seconds),
    })) ?? [{ target: "100", duration_seconds: "30" }],
  );
```

(`targetRps`/`maxInFlight` init은 기존 유지.)

- `loadState`에 `rampDown` 추가. `<LoadModelFields>`에 `rampDown={rampDown} setRampDown={setRampDown}` 전달.
- `loadPreset`(:211–232)의 open/stages 분기 2개를 통째로 교체:

```tsx
      // 모드 역도출 단일화 (spec §6.3): vu_stages/stages/target_rps → 4모드.
      const mode = deriveLoadMode(prof);
      setLoadModel(mode.loadModel);
      setRateMode(mode.rateMode);
      if (prof.target_rps != null) setTargetRps(String(prof.target_rps));
      if (prof.max_in_flight != null) setMaxInFlight(String(prof.max_in_flight));
      const curveStages = prof.vu_stages?.length ? prof.vu_stages : prof.stages;
      if (curveStages && curveStages.length > 0) {
        setStages(
          curveStages.map((s) => ({
            target: String(s.target),
            duration_seconds: String(s.duration_seconds),
          })),
        );
      }
      setRampDown(prof.ramp_down ?? "graceful");
```

- `canSubmit`(:294–317) closed 분기에 curve 케이스 추가:

```tsx
      : rateMode === "curve"
        ? !loadErrs.stagesInvalid &&
          !loopCapInvalid &&
          !httpTimeoutInvalid &&
          !thinkInvalid &&
          bindingBlock.ok &&
          !mutation.isPending
        : vus >= 1 && ...기존 closed+fixed...
```

- [ ] **Step 3: ScheduleForm 배선** — init을 `deriveLoadMode(init ?? {})` 형태로 교체(ScheduleForm의 init은 profile 평탄 — 필드명 동일), `rampDown` state + LoadModelFields props + `buildLoadProfile`용 loadState에 `rampDown` 추가, `canSubmit`(:201–215)의 closed 분기에 curve 케이스(RunDialog 미러, think 입력 없음 — `!loadErrs.stagesInvalid && ...`).

- [ ] **Step 4: ReportHeadline** — `isVuCurve = (profile.vu_stages?.length ?? 0) > 0` 추가, 분기:

```tsx
        : isCurve
          ? ko.report.headlineOpenCurve(common)
          : isVuCurve
            ? ko.report.headlineClosedCurve(common)
            : ko.report.headlineClosed({ ...common, vus: profile.vus });
```

(profile prop 타입이 `Pick<Profile,...>`이면 `"vu_stages"` 추가.)

- [ ] **Step 5: GREEN + 전체 게이트** — `pnpm test`(전체 — targeted만으론 부족, ui/CLAUDE.md) + `pnpm lint && pnpm build`.

- [ ] **Step 6: Task 7+8 통합 커밋**

```bash
git add ui/src/i18n/ko.ts ui/src/components/LoadModelFields.tsx ui/src/components/RunDialog.tsx ui/src/components/ScheduleForm.tsx ui/src/components/report/ReportHeadline.tsx ui/src/components/loadModel.ts <테스트 파일들>
git commit -m "feat(ui): closed+curve 활성화 — VU 곡선 에디터/ramp_down 라디오/역도출 단일화/헤드라인"
```

(UI-only 커밋 = cargo skip, 빠름. 커밋 후 ui-gate 리마인더 확인.)

---

### Task 9: 문서 — engine CLAUDE.md 6+5 + ADR-0037 + roadmap

**Files:**
- Modify: `crates/engine/CLAUDE.md` (MetricFlush 불변식 4+3 → 6+5 문구 2곳: open-loop 섹션의 "4 flush 사이트 + 3 send-guard" 항목과 phase 채널 항목)
- Create: `docs/adr/0037-closed-loop-vu-curve.md` (MADR: park-gate 격리 함수 + vu_stages/ramp_down 와이어 + 단일워커 v1 + Park&재사용 결정, 기각 대안: run_scenario 수정·spawn/cancel·stages 재사용)
- Modify: `docs/roadmap.md` (§D 또는 신규 항목에 완료 기록 + §B에 연기 항목: 곡선 샤딩/active-VU 시계열/grace 상한/fresh-spawn/VU 템플릿 스케일/곡선 VU 표시)
- Modify: 루트 `CLAUDE.md` ADR 인덱스에 0037 한 줄

- [ ] **Step 1: 위 4파일 작성** (spec §9·§10에서 연기/비목표 목록 그대로 옮김. engine CLAUDE.md의 두 불변식 문구를 "드레인 6곳(closed/open/vu-curve × periodic/final), send-guard 5곳(open-loop final만 무가드)"로 갱신 + vu-curve 한 줄 추가: park-gate·retire-abort failed 미집계·AllVusFailed spawned 기준.)
- [ ] **Step 2: conflict marker 검사** — `grep -rn '^<<<<<<<\|^>>>>>>>' docs/ crates/engine/CLAUDE.md CLAUDE.md` 출력 없음 확인.
- [ ] **Step 3: 커밋** — docs-only fast path. `"docs: ADR-0037 closed-loop VU 곡선 + engine CLAUDE.md 6+5 불변식 + roadmap"`

---

### Task 10: 최종 검증 (오케스트레이터 직접 — subagent 아님)

- [ ] **전체 게이트**: `cargo fmt --check && cargo build --workspace && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace` + `cd ui && pnpm lint && pnpm test && pnpm build`
- [ ] **최종 whole-feature 리뷰**: `handicap-reviewer` agent — 특히 와이어 7-layer 1:1(엔진 RunPlan ↔ proto 12·13 ↔ 워커 매핑 ↔ store serde ↔ Zod ↔ buildLoadProfile), MetricFlush 6+5, 기존 3모드 byte-identical, deferral 추적.
- [ ] **라이브 검증 (spec §8 — S-D 갭 차단)**:
  1. `cargo build -p handicap-worker --bin worker && cargo build -p handicap-controller --bin controller` (워크트리 자체 바이너리)
  2. `just ui-build` 후 `./target/debug/controller --db /tmp/vu-curve.db --ui-dir ui/dist` (+ python 200-responder: `python3 -c 'from http.server import ThreadingHTTPServer,BaseHTTPRequestHandler ...'` 8요지 — 기존 S-B 수동테스트 레시피)
  3. **곡선 모양**: think_time 200ms 고정 + `vu_stages:[{"target":10,"duration_seconds":10},{"target":2,"duration_seconds":10}]` → run 리포트 per-second 윈도에서 RPS 0→~50 상승 후 ~10 하강 확인 (RPS ≈ N(t)×5). graceful vs immediate 두 run 비교(immediate 하강이 더 가파름).
  4. **Playwright**: RunDialog closed+curve로 run 생성 → 리포트 헤드라인 "단계별 VU 곡선" + 콘솔 Zod 0 → "다시 실행" prefill이 closed+curve 역도출. 실 `/api/runs` 응답 바이트 throwaway `safeParse`(null-vs-absent).
  5. 정리: `.playwright-mcp/`·루트 png·`/tmp/vu-curve.db` 제거.
- [ ] **마무리**: `superpowers:finishing-a-development-branch` (rebase 필요 시 master 전진 확인 → ff-merge는 메인 체크아웃 경유 `git -C /Users/sgj/develop/handicap merge --ff-only` → `ExitWorktree(discard_changes:true)`) + build-log 단락 + 메모리 갱신.

---

## Self-review 기록

- **Spec coverage**: §2(ramp_down 노브 — T1/T2/T4/T7), §3.1 와이어(T1/T3/T4/T6), §3.2 ①–⑨(T4), §3.3 4사이트(T4), §4 엔진(T2), §5 proto/워커/리터럴 churn(T3/T4), §6.1–6.4 UI/초보자 카피(T6/T7/T8), §7 테스트(T2/T4/T5/T6/T7/T8), §8 라이브(T10), §9·§10 문서(T9). 갭 없음. ReportHeadline `headlineClosedCurve`는 spec §6.4 "신규 문구 ko.ts" 범위로 plan에서 구체화(스펙 미열거 표면 — plan 추가分).
- **Type consistency**: `RampDown`(engine) ↔ store `Option<handicap_engine::RampDown>` ↔ proto `bool ramp_down_immediate` ↔ Zod `z.enum(["graceful","immediate"]).optional()` ↔ `LoadModelState.rampDown` 일관. `vu_curve_max()` u32 ↔ slot_count u64 캐스트 명시.
- **Placeholder scan**: 검증 테스트 표(T4 Step 2)·RTL 케이스 일부(T8 Step 1)는 기존 파일의 헬퍼 컨벤션에 의존해 의도적으로 "기존 미러" 지시 + 단언 목록으로 명세 — verdict-badge 교훈(plan이 헬퍼 시그니처를 지어내면 implementer가 정정하게 됨)에 따른 선택.
