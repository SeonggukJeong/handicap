# S-C 오픈루프 (open-loop / arrival-rate) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** closed-loop와 격리된 open-loop 실행 모델을 opt-in으로 추가 — `target_rps` 도착률 스케줄러 + `max_in_flight` 슬롯 풀 + drop 카운터.

**Architecture:** `target_rps` 지정 시 워커가 기존 `run_scenario`(무변경) 대신 신규 `run_scenario_open_loop`를 호출. 후자는 `max_in_flight`개 재사용 `Arc<VuClient>` 풀(슬롯 인덱스 = `vu_id`) + 사전 적재 mpsc free-slot 큐 + `1/target_rps` 균등 틱 스케줄러. 슬롯이 비면 arrival을 발사(`tokio::spawn` → 기존 `execute_steps` 1회), 만석이면 `dropped++`. cookie jar는 슬롯-지속(ADR-0018 일관). `target_rps` 미지정 → `run_scenario` byte-identical.

**Tech Stack:** Rust(엔진/컨트롤러/워커) — tokio, `tokio::sync::mpsc`(슬롯 큐, **새 의존성 0**), prost/tonic(proto), sqlx(SQLite). TypeScript/React(RunDialog, Zod).

**설계 문서:** `docs/superpowers/specs/2026-06-04-load-model-pacing-s-c-open-loop-design.md` (+ 작성할 **ADR-0031**). 영역 umbrella: `docs/superpowers/specs/2026-06-03-load-model-pacing-config-design.md`.

**리뷰 반영:** spec-plan-reviewer가 잡은 6개 — 슬롯 할당 primitive(mpsc 큐, bare Semaphore 아님), `worker_count=1` 명시 override, open-loop `iter_id`(글로벌 arrival 카운터), dropped blast radius 전체 task화, 실제 상한값, "S-C2" 명칭/advisory-only verdict.

---

## 절단점 (cut-point)

- **Tasks 1–8 = 코어** (실행모델 + config + 검증 + UI). `dropped`는 엔진 in-memory/MetricFlush까지만, 영속화 없음. 출하 가능(achieved≈target, closed-loop byte-identical).
- **Tasks 9–13 = dropped 영속화** (proto forward → migration → ingest → report → UI). 코어가 예상보다 커지면 follow-up으로 절단 가능.
- **Task 14 = ADR-0031 + 문서.**

## 파일 맵

| 파일 | 역할 | task |
|---|---|---|
| `crates/engine/src/runner.rs` | `RunPlan` +2필드, `MetricFlush.dropped`, **신규 `run_scenario_open_loop` + `run_arrival`** | 1,2,3 |
| `crates/engine/src/lib.rs` | `run_scenario_open_loop` re-export | 1 |
| `crates/engine/tests/open_loop.rs` | open-loop 엔진 통합 테스트(wiremock) | 1,2,3 |
| `crates/controller/src/store/runs.rs` | `Profile` +`target_rps`/`max_in_flight` | 4 |
| `crates/proto/proto/coordinator.proto` | `Profile` +8/9, `MetricBatch` +`dropped`=6 | 5 |
| `crates/controller/src/api/runs.rs` | `validate_run_config` open-loop 분기 + `worker_count=1` override + proto `Profile{}` 매핑 | 5,6 |
| `crates/worker/src/main.rs` | `RunPlan` 빌드(+2) + dispatch 분기 + (T10)dropped forward | 7,10 |
| `ui/src/components/RunDialog.tsx`, `ui/src/api/schemas.ts` | 부하모델 토글 + 필드 + Zod | 8 |
| `crates/controller/src/store/mod.rs` | migration 0009 `runs.dropped` 가드 | 9 |
| `crates/controller/src/grpc/coordinator.rs` | `ingest_metrics` UPDATE `runs.dropped` | 10 |
| `crates/controller/src/report.rs` / `api/runs.rs` | `RunRow.dropped` + `build_report` → `ReportJson.dropped` | 11 |
| `ui/src/components/report/*` | summary에 target_rps/achieved/dropped | 12 |
| `crates/controller/tests/e2e_test.rs` | open-loop e2e smoke | 8,13 |
| `docs/adr/0031-*.md`, 루트 `CLAUDE.md`, `docs/roadmap.md` | 결정 기록 | 14 |

---

## Task 1: 엔진 — `run_scenario_open_loop` 코어 (스케줄러 + 슬롯 풀 + drop)

**Files:**
- Modify: `crates/engine/src/runner.rs` (RunPlan +2필드, MetricFlush +dropped, 신규 함수 2개)
- Modify: `crates/engine/src/lib.rs` (re-export)
- Test: `crates/engine/tests/open_loop.rs` (신규)

> **불변식**: 기존 `run_scenario`/`run_vu`/`execute_steps`는 **본문 한 줄도 안 건드린다**(필드 추가로 `MetricFlush{}` 리터럴 2곳만 `dropped: 0` 명시). `run_arrival`은 `run_vu` iteration-body의 *의도된 복제*(run-level think time 제외, unique 소진 시 `exhausted` 신호) — run_vu를 리팩터하지 않기 위함.

- [ ] **Step 1: 실패 테스트 작성** — `crates/engine/tests/open_loop.rs`

```rust
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use handicap_engine::{MetricFlush, RunPlan, Scenario, run_scenario_open_loop};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use wiremock::matchers::method;
use wiremock::{Mock, MockServer, ResponseTemplate};

fn plan(target_rps: u32, max_in_flight: u32, secs: u64) -> RunPlan {
    RunPlan {
        vus: 0, // open-loop ignores vus
        ramp_up: Duration::ZERO,
        duration: Duration::from_secs(secs),
        env: BTreeMap::new(),
        loop_breakdown_cap: 256,
        vu_offset: 0,
        data_binding: None,
        http_timeout: Duration::from_secs(30),
        think_time: None,
        think_seed: None,
        target_rps: Some(target_rps),
        max_in_flight: Some(max_in_flight),
    }
}

fn scenario(url: &str) -> Arc<Scenario> {
    let yaml = format!(
        "version: 1\nname: ol\nsteps:\n  - id: 01HX0000000000000000000010\n    type: http\n    request:\n      method: GET\n      url: {url}\n    assert:\n      status: 200\n"
    );
    Arc::new(serde_yaml::from_str(&yaml).unwrap())
}

#[tokio::test]
async fn open_loop_fires_near_target_rps_with_ample_pool() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(32);
    let cancel = CancellationToken::new();
    // 50 rps * 2s = ~100 requests; ample pool so no drops.
    let h = tokio::spawn(run_scenario_open_loop(
        scenario(&format!("{}/", server.uri())),
        plan(50, 64, 2),
        tx,
        cancel,
    ));
    let mut count = 0u64;
    let mut dropped = 0u64;
    while let Some(f) = rx.recv().await {
        count += f.windows.iter().map(|w| w.count).sum::<u64>();
        dropped += f.dropped;
    }
    h.await.unwrap().unwrap();
    // ~100 expected; allow timing slack. Key: in the right order of magnitude, not VU-bound.
    assert!(count >= 60 && count <= 140, "count={count} not near 100");
    assert_eq!(dropped, 0, "ample pool should not drop");
}
```

> `StepWindow.count` 필드명은 `crates/engine/src/aggregator.rs`에서 확인(현재 `pub count: u64`). 다르면 그 이름으로.

- [ ] **Step 2: 실패 확인**

Run: `cargo test -p handicap-engine --test open_loop open_loop_fires_near_target_rps_with_ample_pool`
Expected: 컴파일 실패 — `run_scenario_open_loop` 없음, `RunPlan`에 `target_rps`/`max_in_flight` 없음, `MetricFlush`에 `dropped` 없음.

- [ ] **Step 3: `RunPlan` + `MetricFlush` 필드 추가** — `runner.rs`

`RunPlan` struct 끝(`think_seed` 뒤)에:
```rust
    /// Open-loop target arrival rate (req/s). `Some` → open-loop path
    /// (`run_scenario_open_loop`); `None` → closed-loop `run_scenario` (byte-identical).
    pub target_rps: Option<u32>,
    /// Open-loop concurrent in-flight cap = reusable slot-pool size. Required when
    /// `target_rps` is set (controller-validated). Each slot = one `VuClient` + cookie jar.
    pub max_in_flight: Option<u32>,
```

`MetricFlush` struct에 필드 추가:
```rust
    /// Open-loop arrivals dropped because the slot pool was full, since the last
    /// flush (delta). Always `0` on the closed-loop path.
    pub dropped: u64,
```

기존 `run_scenario`의 두 `MetricFlush { … }` 리터럴(periodic flush + final flush)에 `dropped: 0,` 추가.

> **⚠ 리터럴 sweep(반드시 — pre-commit이 `cargo test --workspace`로 모든 테스트 타깃 컴파일)**: `RunPlan`은 `Default` 미파생이라 2필드 추가가 **모든 `RunPlan {}` 리터럴을 깬다 — 총 ~26곳**(워커 `main.rs:181` 1곳 + **엔진 테스트 ~25곳**: `assertions.rs`·`if_node.rs`·`all_vus_failed.rs`·`think_time.rs`·`runner_e2e.rs`·`data_binding.rs`·`vu_offset.rs`·`http_timeout.rs`·`ramp_up.rs`·`loop_node.rs`·`json_cast.rs`·`multi_step.rs` 등). 처리:
> ```bash
> grep -rln "RunPlan {" crates/        # 모든 리터럴 파일 확인
> ```
> 워커(`main.rs:181`)는 `target_rps: None, max_in_flight: None`(T7에서 매핑 교체), **엔진 테스트 전부** `target_rps: None, max_in_flight: None` 추가. `MetricFlush {}` 리터럴(`grep -rln "MetricFlush {" crates/`)도 `dropped: 0` 추가. 누락 1곳이라도 있으면 T1 커밋의 워크스페이스 빌드가 깨진다.

- [ ] **Step 4: `run_scenario_open_loop` + `run_arrival` 구현** — `runner.rs`

```rust
use std::sync::atomic::AtomicBool;

/// Drive open-loop arrival-rate load: schedule iteration *starts* at `target_rps`
/// against a fixed pool of `max_in_flight` reusable VU clients (slot index = vu_id,
/// cookie jar persists per slot). Arrivals that find no free slot are dropped and
/// counted. Isolated from `run_scenario` — closed-loop code is untouched.
pub async fn run_scenario_open_loop(
    scenario: Arc<Scenario>,
    plan: RunPlan,
    out: mpsc::Sender<MetricFlush>,
    cancel: CancellationToken,
) -> Result<()> {
    let max_in_flight = plan.max_in_flight.unwrap_or(1).max(1) as usize;
    let target_rps = plan.target_rps.unwrap_or(1).max(1);
    let agg = Arc::new(Mutex::new(Aggregator::new(plan.loop_breakdown_cap)));
    let started_at = Instant::now();
    let deadline = started_at + plan.duration;
    let env = Arc::new(plan.env);
    let dataset = plan.data_binding.clone();
    let http_timeout = plan.http_timeout;
    let think_seed = plan.think_seed;
    let vu_offset = plan.vu_offset;
    let dropped = Arc::new(AtomicU64::new(0));
    let arrival_counter = Arc::new(AtomicU64::new(0)); // open-loop iter_id source
    let exhausted = Arc::new(AtomicBool::new(false));
    let seq_counter = match dataset.as_ref().map(|d| d.policy) {
        Some(BindingPolicy::IterSequential | BindingPolicy::Unique) => {
            Some(Arc::new(AtomicU64::new(0)))
        }
        _ => None,
    };

    // Slot pool: max_in_flight reusable clients, index = vu_id (offset applied at use).
    let mut pool: Vec<Arc<VuClient>> = Vec::with_capacity(max_in_flight);
    for _ in 0..max_in_flight {
        pool.push(Arc::new(VuClient::with_timeout(scenario.cookie_jar, http_timeout)?));
    }
    let pool = Arc::new(pool);
    // Free-slot queue: pre-loaded with every index. `try_recv` = acquire (Empty → drop),
    // send back on completion. The channel itself is the permit + the slot identity.
    let (slot_tx, mut slot_rx) = mpsc::channel::<usize>(max_in_flight);
    for i in 0..max_in_flight {
        slot_tx.try_send(i).expect("capacity == max_in_flight");
    }

    let mut set = JoinSet::new();

    // Flusher: drain windows until the run ends. It does NOT carry `dropped` — the
    // run-total drop count rides on the single final flush below (avoids the
    // delta/double-count bookkeeping; per-second drop series is deferred, spec §9).
    let flush_agg = agg.clone();
    let flush_out = out.clone();
    let flusher = tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_millis(500));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            ticker.tick().await;
            let now_s = chrono_second();
            let (drained, loop_stats, branch_stats) = {
                let mut g = flush_agg.lock().await;
                (g.drain_completed(now_s), g.drain_loop_deltas(), g.drain_branch_deltas())
            };
            if !drained.is_empty() || !loop_stats.is_empty() || !branch_stats.is_empty() {
                if flush_out
                    .send(MetricFlush { windows: drained, loop_stats, branch_stats, dropped: 0 })
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

    // Scheduler: uniform ticks at 1/target_rps.
    let interval = Duration::from_nanos((1_000_000_000u64 / u64::from(target_rps)).max(1));
    let mut next = started_at;
    loop {
        if cancel.is_cancelled() || exhausted.load(Ordering::Relaxed) || Instant::now() >= deadline {
            break;
        }
        let now = Instant::now();
        if now < next {
            tokio::select! {
                _ = tokio::time::sleep(next - now) => {}
                _ = cancel.cancelled() => break,
            }
            continue;
        }
        match slot_rx.try_recv() {
            Ok(slot) => {
                let vu_id = vu_offset.saturating_add(slot as u32);
                let iter_id = arrival_counter.fetch_add(1, Ordering::Relaxed) as u32;
                let client = pool[slot].clone();
                let scenario = scenario.clone();
                let agg = agg.clone();
                let env = env.clone();
                let cancel_vu = cancel.clone();
                let dataset = dataset.clone();
                let seq_counter = seq_counter.clone();
                let exhausted = exhausted.clone();
                let slot_tx = slot_tx.clone();
                set.spawn(async move {
                    // Return the slot on ALL exit paths (incl. panic) via Drop — a leaked
                    // slot would permanently shrink the pool (→ runaway drops). C2 fix.
                    struct SlotGuard {
                        slot: usize,
                        tx: mpsc::Sender<usize>,
                    }
                    impl Drop for SlotGuard {
                        fn drop(&mut self) {
                            let _ = self.tx.try_send(self.slot); // capacity guaranteed
                        }
                    }
                    let _slot_guard = SlotGuard { slot, tx: slot_tx };
                    let mut rng = match think_seed {
                        Some(s) => StdRng::seed_from_u64(crate::dataset::mix(s, vu_id, iter_id)),
                        None => StdRng::from_entropy(),
                    };
                    let _ = run_arrival(
                        &client, &scenario, vu_id, iter_id, &agg, deadline, &env,
                        &cancel_vu, dataset, seq_counter, &mut rng, &exhausted,
                    )
                    .await;
                });
            }
            Err(_) => {
                dropped.fetch_add(1, Ordering::Relaxed);
            }
        }
        next += interval;
    }

    while let Some(res) = set.join_next().await {
        if let Err(e) = res {
            warn!(error = %e, "arrival join error");
        }
    }

    // Stop the flusher, then send ONE final flush carrying the remaining windows plus
    // the run-total `dropped` (the flusher sent dropped: 0 throughout, so no double count).
    flusher.abort();
    let _ = flusher.await;
    let total_dropped = dropped.load(Ordering::Relaxed);
    let (final_windows, final_loops, final_branches) = {
        let mut g = agg.lock().await;
        (g.drain_all(), g.drain_loop_deltas(), g.drain_branch_deltas())
    };
    let _ = out
        .send(MetricFlush {
            windows: final_windows,
            loop_stats: final_loops,
            branch_stats: final_branches,
            dropped: total_dropped,
        })
        .await;
    drop(out);

    if cancel.is_cancelled() {
        return Err(EngineError::Aborted);
    }
    info!(dropped = total_dropped, "open-loop run finished");
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn run_arrival(
    client: &VuClient,
    scenario: &Scenario,
    vu_id: u32,
    iter_id: u32,
    agg: &Arc<Mutex<Aggregator>>,
    deadline: Instant,
    env: &Arc<BTreeMap<String, String>>,
    cancel: &CancellationToken,
    dataset: Option<Arc<DataSet>>,
    seq_counter: Option<Arc<AtomicU64>>,
    rng: &mut StdRng,
    exhausted: &AtomicBool,
) -> Result<()> {
    let mut iter_vars: BTreeMap<String, String> = scenario.variables.clone();
    if let Some(ds) = &dataset {
        match ds.select_index(vu_id, iter_id, seq_counter.as_deref()) {
            Some(idx) => {
                for (k, v) in &ds.rows[idx] {
                    iter_vars.insert(k.clone(), v.clone());
                }
            }
            // unique slice exhausted → signal the scheduler to stop new arrivals.
            None => {
                exhausted.store(true, Ordering::Relaxed);
                return Ok(());
            }
        }
    }
    // No run-level think time in open-loop (arrival rate governs inter-iteration pacing).
    let _ = execute_steps(
        client, &scenario.steps, &mut iter_vars, agg, deadline, env, vu_id, iter_id, None,
        cancel, rng,
    )
    .await?;
    Ok(())
}
```

> **dropped 회계(단순·정확)**: flusher는 `dropped: 0`만 보내고(windows/loop/branch), run-total `dropped`는 **final flush 한 번**(`dropped: total_dropped`)으로만 전달 — 이중 계산 0. per-second drop 시계열은 §9 연기라 run-total 한 방이면 충분.

- [ ] **Step 5: lib.rs re-export** — `crates/engine/src/lib.rs`

`pub use ... run_scenario` 옆에 `run_scenario_open_loop` 추가(기존 `run_scenario` re-export 라인 찾아 동반).

- [ ] **Step 6: 테스트 통과 확인**

Run: `cargo test -p handicap-engine --test open_loop`
Expected: PASS.

- [ ] **Step 7: 워크스페이스 빌드(literal 누락 점검) + 커밋**

```bash
cargo build --workspace 2>&1 | tail -20   # RunPlan/MetricFlush 리터럴 누락 잡기
cargo test -p handicap-engine
# src + 신규 테스트 + 워커 + sweep로 수정한 엔진 테스트 전부 스테이지(명시 경로):
git add crates/engine/src/runner.rs crates/engine/src/lib.rs crates/engine/tests/ crates/worker/src/main.rs
git commit -m "feat(engine): run_scenario_open_loop — arrival scheduler + slot pool + drop counter"
```
> `git add crates/engine/tests/`로 sweep 수정한 ~25개 테스트 파일을 한 번에(신규 `open_loop.rs` 포함). 워커 `main.rs:181` RunPlan 리터럴은 이 커밋에서 `target_rps: None, max_in_flight: None`만 추가(매핑은 T7). 커밋은 `run_in_background:false` 단일 호출, 폴링 금지.

---

## Task 2: 엔진 — open-loop drop + cancel 동작 테스트

**Files:** Test: `crates/engine/tests/open_loop.rs` (추가)

- [ ] **Step 1: 실패 테스트 작성**

```rust
#[tokio::test]
async fn open_loop_drops_when_pool_too_small() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_millis(200)))
        .mount(&server)
        .await;
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(64);
    let cancel = CancellationToken::new();
    // 100 rps but only 1 slot held 200ms each → most arrivals find no free slot.
    let h = tokio::spawn(run_scenario_open_loop(
        scenario(&format!("{}/", server.uri())),
        plan(100, 1, 2),
        tx,
        cancel,
    ));
    let mut count = 0u64;
    let mut dropped = 0u64;
    while let Some(f) = rx.recv().await {
        count += f.windows.iter().map(|w| w.count).sum::<u64>();
        dropped += f.dropped;
    }
    h.await.unwrap().unwrap();
    assert!(dropped > 0, "small pool must drop (dropped={dropped})");
    assert!(count < 100, "achieved must be below target (count={count})");
}

#[tokio::test]
async fn open_loop_cancel_aborts_promptly() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(32);
    let cancel = CancellationToken::new();
    let s = scenario(&format!("{}/", server.uri()));
    let c2 = cancel.clone();
    let h = tokio::spawn(run_scenario_open_loop(s, plan(50, 8, 30), tx, cancel));
    tokio::time::sleep(Duration::from_millis(300)).await;
    c2.cancel();
    // drain
    while rx.recv().await.is_some() {}
    let res = h.await.unwrap();
    assert!(matches!(res, Err(handicap_engine::EngineError::Aborted)));
}
```

- [ ] **Step 2: 실패 확인** → Run: `cargo test -p handicap-engine --test open_loop open_loop_drops_when_pool_too_small open_loop_cancel_aborts_promptly` — Expected: 통과 못 함(드물게 cancel 타이밍)일 수 있으나, 보통 drop 테스트는 즉시 PASS(이미 구현됨). cancel 테스트가 실패하면 Step 3.
- [ ] **Step 3: (필요 시) cancel 경로 보정** — Task 1의 스케줄러 루프가 이미 `cancel.is_cancelled()` + `tokio::select!` cancel을 본다. cancel 후 `set.join_next()`가 in-flight를 기다리되 `execute_steps`가 cancel을 보고 `StepFlow::Aborted`로 빠지므로 prompt. 추가 보정 불필요면 skip.
- [ ] **Step 4: 통과 확인** → Run: `cargo test -p handicap-engine --test open_loop` — Expected: PASS(4 tests).
- [ ] **Step 5: 커밋**
```bash
git add crates/engine/tests/open_loop.rs
git commit -m "test(engine): open-loop drop-on-full + prompt cancel"
```

---

## Task 3: 엔진 — open-loop 정체성/바인딩 테스트 (slot=vu_id, per_vu, jar 지속)

**Files:** Test: `crates/engine/tests/open_loop.rs` (추가)

> 이 테스트들은 Task 1 함수가 이미 충족(slot=vu_id, `select_index(slot, arrival_idx, …)`, 슬롯 클라이언트 jar 지속)함을 검증. 실패하면 Task 1 회귀.

- [ ] **Step 1: 실패 테스트 작성** — echo 서버로 `${vu_id}` 와 쿠키 지속 검증

```rust
// vu_id (= slot index, 0..max_in_flight) is rendered into the request and observed
// at the target. With max_in_flight=2, only slot ids {0,1} ever appear.
#[tokio::test]
async fn open_loop_vu_id_is_slot_index_bounded_by_pool() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;
    let yaml = format!(
        "version: 1\nname: ol\nsteps:\n  - id: 01HX0000000000000000000011\n    type: http\n    request:\n      method: GET\n      url: {}/u/${{vu_id}}\n    assert:\n      status: 200\n",
        server.uri()
    );
    let scn: Arc<Scenario> = Arc::new(serde_yaml::from_str(&yaml).unwrap());
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(32);
    let cancel = CancellationToken::new();
    let h = tokio::spawn(run_scenario_open_loop(scn, plan(40, 2, 2), tx, cancel));
    while rx.recv().await.is_some() {}
    h.await.unwrap().unwrap();
    let reqs = server.received_requests().await.unwrap();
    assert!(!reqs.is_empty());
    for r in &reqs {
        let p = r.url.path();
        assert!(p == "/u/0" || p == "/u/1", "vu_id must be slot 0 or 1, got {p}");
    }
}
```

> `${vu_id}` 렌더는 `template.rs`가 이미 지원(closed-loop와 동일). 여기선 슬롯 인덱스가 vu_id로 들어가는지만 확인. 쿠키 슬롯-지속은 reqwest 자동 jar라 별도 stateful echo가 필요 — v1 테스트는 `vu_id` 경계로 충분, jar 지속은 §10 e2e/수동으로 보강(과도한 stateful mock 회피).

- [ ] **Step 2: 실패/통과 확인** → Run: `cargo test -p handicap-engine --test open_loop open_loop_vu_id_is_slot_index_bounded_by_pool` — Expected: PASS(이미 구현). 실패 시 Task 1의 `vu_id = vu_offset + slot` 점검.
- [ ] **Step 3: 커밋**
```bash
git add crates/engine/tests/open_loop.rs
git commit -m "test(engine): open-loop vu_id = slot index, bounded by pool"
```

---

## Task 4: 컨트롤러 `store::runs::Profile` — `target_rps`/`max_in_flight` 필드

**Files:**
- Modify: `crates/controller/src/store/runs.rs` (Profile struct)
- Test: 같은 파일 인라인 `#[cfg(test)]` 또는 `crates/controller/tests/`

- [ ] **Step 1: 실패 테스트 작성** — `runs.rs` 인라인 `mod tests`(없으면 추가)

```rust
#[test]
fn profile_open_loop_fields_roundtrip_and_default_absent() {
    // absent → None (back-compat with old profile_json rows)
    let p: Profile = serde_json::from_str(
        r#"{"vus":1,"duration_seconds":1}"#,
    ).unwrap();
    assert_eq!(p.target_rps, None);
    assert_eq!(p.max_in_flight, None);
    // present → round-trips
    let p2: Profile = serde_json::from_str(
        r#"{"vus":0,"duration_seconds":10,"target_rps":500,"max_in_flight":64}"#,
    ).unwrap();
    assert_eq!(p2.target_rps, Some(500));
    assert_eq!(p2.max_in_flight, Some(64));
}
```

- [ ] **Step 2: 실패 확인** → Run: `cargo test -p handicap-controller profile_open_loop_fields_roundtrip` — Expected: FAIL(필드 없음).
- [ ] **Step 3: 필드 추가** — `Profile` struct(`think_seed` 뒤):
```rust
    #[serde(default)]
    pub target_rps: Option<u32>,
    #[serde(default)]
    pub max_in_flight: Option<u32>,
```

> **⚠ 리터럴 sweep(F2)**: `store::runs::Profile`도 `Default` 미파생이라 2필드 추가가 **~8개 `Profile {}` 리터럴을 깬다 — `runs.rs`(인라인 테스트 ×2) 외 cross-file 6곳**: `report.rs:~384`, `grpc/coordinator.rs:~972`, `api/runs.rs`(×3 ~539/652/693), `presets.rs:~194`. 처리:
> ```bash
> grep -rln "Profile {" crates/controller/   # serde_yaml/proto Profile과 헷갈리지 말 것 — store::runs::Profile만
> ```
> 각 리터럴에 `target_rps: None, max_in_flight: None` 추가(전부 기존 동작 보존). proto `Profile`(coordinator.proto)·serde 다른 Profile과 구분.

- [ ] **Step 4: 통과 + 워크스페이스 빌드** → Run: `cargo test -p handicap-controller profile_open_loop_fields_roundtrip && cargo build --workspace 2>&1 | tail -20` — Expected: PASS, 빌드 클린(리터럴 누락 0).
- [ ] **Step 5: 커밋**
```bash
git add crates/controller/src/store/runs.rs crates/controller/src/report.rs crates/controller/src/grpc/coordinator.rs crates/controller/src/api/runs.rs crates/controller/src/store/presets.rs
git commit -m "feat(controller): Profile target_rps/max_in_flight (serde-default, migration 0)"
```

---

## Task 5: proto + 검증 — `Profile`/`MetricBatch` 필드 + `validate_run_config` open-loop 분기

**Files:**
- Modify: `crates/proto/proto/coordinator.proto`
- Modify: `crates/controller/src/api/runs.rs` (`validate_run_config` + proto `Profile{}` 매핑 리터럴 + `worker_count` override)
- Test: `crates/controller/tests/` 또는 `api/runs.rs` 인라인

- [ ] **Step 1: 실패 테스트 작성** — open-loop 검증 규칙 (controller 통합 테스트 위치는 기존 validate 테스트 따름)

```rust
// open-loop requires max_in_flight; conflicting pacing knobs are rejected.
// NOTE: real helpers in api/runs.rs tests are `state_with(db, capacity)` (~:525) — there is
// NO `base_profile()`/`Default for Profile`. Add a local full-field open-loop builder:
fn ol_profile() -> Profile {
    Profile {
        vus: 0, ramp_up_seconds: 0, duration_seconds: 10, loop_breakdown_cap: 256,
        http_timeout_seconds: 30, data_binding: None, criteria: None,
        think_time: None, think_seed: None,
        target_rps: Some(100), max_in_flight: Some(16),
    }
}

#[tokio::test]
async fn validate_open_loop_requires_max_in_flight_and_rejects_conflicts() {
    let state = state_with(test_db().await, 2000).await; // match existing helper signature
    assert!(validate_run_config(&state, &ol_profile()).await.is_ok());

    let no_cap = Profile { max_in_flight: None, ..ol_profile() };
    assert!(validate_run_config(&state, &no_cap).await.is_err());

    let ramp = Profile { ramp_up_seconds: 5, ..ol_profile() };
    assert!(validate_run_config(&state, &ramp).await.is_err());

    let tt = Profile { think_time: Some(handicap_engine::ThinkTime { min_ms: 100, max_ms: 100 }), ..ol_profile() };
    assert!(validate_run_config(&state, &tt).await.is_err());

    let huge = Profile { max_in_flight: Some(10_001), ..ol_profile() };
    assert!(validate_run_config(&state, &huge).await.is_err());
}
```
> 실제 헬퍼명(`state_with`/`test_db` 등)은 `api/runs.rs`의 기존 `#[cfg(test)]` 모듈에서 확인해 맞춘다(`test_state`/`base_profile`은 존재하지 않음 — F4). `Profile`은 `Default` 미파생이라 `ol_profile()` 전 필드 명시.

- [ ] **Step 2: 실패 확인** → Run: `cargo test -p handicap-controller validate_open_loop_requires` — Expected: FAIL(open-loop 분기 없음).

- [ ] **Step 3: proto 필드 추가** — `coordinator.proto`

`message Profile` 끝(`think_seed = 7` 뒤):
```proto
  optional uint32 target_rps = 8;      // present → open-loop arrival rate
  optional uint32 max_in_flight = 9;   // present → open-loop slot-pool size
```
`message MetricBatch` 끝(`branch_stats = 5` 뒤):
```proto
  uint64 dropped = 6;                  // open-loop arrivals dropped (run-total carried on final flush)
```

- [ ] **Step 4: `validate_run_config` open-loop 분기 추가** — `api/runs.rs`, `http_timeout` 검증 *앞*(또는 `vus==0` 검증을 모드-aware로):

```rust
    // ── open-loop (S-C): target_rps present switches the execution model ──
    if let Some(rps) = profile.target_rps {
        if rps == 0 || rps > 1_000_000 {
            return Err(ApiError::BadRequest(
                "target_rps must be between 1 and 1000000".into(),
            ));
        }
        match profile.max_in_flight {
            None => {
                return Err(ApiError::BadRequest(
                    "open-loop(target_rps)은 max_in_flight가 필요합니다".into(),
                ));
            }
            Some(m) if m == 0 || m > 10_000 => {
                return Err(ApiError::BadRequest(
                    "max_in_flight must be between 1 and 10000".into(),
                ));
            }
            _ => {}
        }
        if profile.ramp_up_seconds > 0 {
            return Err(ApiError::BadRequest(
                "open-loop에선 ramp_up_seconds를 쓸 수 없습니다 (RPS 곡선은 S-D stages)".into(),
            ));
        }
        if profile.think_time.is_some() {
            return Err(ApiError::BadRequest(
                "open-loop에선 run-level think_time을 쓸 수 없습니다 (closed-loop 전용)".into(),
            ));
        }
        if profile.duration_seconds == 0 {
            return Err(ApiError::BadRequest("duration_seconds must be > 0".into()));
        }
        // NOTE: vus is ignored in open-loop (slot pool = max_in_flight); do not require vus>0.
    } else if profile.vus == 0 || profile.duration_seconds == 0 {
        // closed-loop (unchanged)
        return Err(ApiError::BadRequest(
            "vus and duration_seconds must be > 0".into(),
        ));
    }
```
> 기존 맨 앞 `if profile.vus == 0 || profile.duration_seconds == 0` 블록을 위 분기의 `else if`로 대체(중복 검사 제거). `loop_breakdown_cap`/`http_timeout`/`criteria`/`data_binding` 검증은 그대로 뒤에 둔다(직교, 두 모드 공통).

- [ ] **Step 5: `worker_count=1` override + proto `Profile{}` 매핑** — `api/runs.rs`

run-create에서 `n = worker_count_for(body.profile.vus)` 사이트(~`:227`)를:
```rust
    let n = if body.profile.target_rps.is_some() {
        1 // open-loop is single-worker in v1 (fan-out deferred — spec §9)
    } else {
        state.coord.worker_count_for(body.profile.vus)
    };
```
proto `Profile { … }` 빌드 리터럴에 매핑 추가:
```rust
        target_rps: profile.target_rps,        // Option<u32> → proto optional
        max_in_flight: profile.max_in_flight,
```
> **⚠ proto Profile 리터럴 sweep(F3)**: `grep -rn "Profile {" crates/controller/`로 **proto** Profile 리터럴 전부 — 프로덕션 빌드 지점(`api/runs.rs:~209`) **+ 테스트 `base_assignment` 헬퍼(`grpc/coordinator.rs:~951`, `#[cfg(test)]`)**. 후자 누락 시 `cargo test --workspace` 컴파일 실패(prost exhaustive, controller CLAUDE.md). proto optional은 prost가 `Option<u32>` 생성이라 매핑 직결.

- [ ] **Step 6: 통과 + 워크스페이스 빌드** — proto 재생성 + literal 누락 점검
```bash
cargo build --workspace 2>&1 | tail -20   # MetricBatch{}(worker main.rs:259), proto Profile 리터럴
cargo test -p handicap-controller validate_open_loop_requires
```
Expected: PASS. `MetricBatch { … }` 리터럴은 `dropped: 0` 추가(워커 forward는 T10).

- [ ] **Step 7: 커밋**
```bash
git add crates/proto/proto/coordinator.proto crates/controller/src/api/runs.rs crates/controller/src/grpc/coordinator.rs crates/worker/src/main.rs
git commit -m "feat(proto,controller): open-loop Profile fields + MetricBatch.dropped + validate_run_config open-loop branch + single-worker override"
```

---

## Task 6: 워커 — `RunPlan` 매핑 + dispatch 분기

**Files:** Modify: `crates/worker/src/main.rs`

- [ ] **Step 1: pending test 확보** — 워커는 bin이라 인라인 테스트가 적음. 동작 검증은 T8 e2e가 담당. tdd-guard 통과를 위해 `crates/worker/tests/_tdd_keepalive.rs`에 `#[test] fn keepalive() {}` 임시 생성(커밋 안 함, task 끝 `rm`).

- [ ] **Step 2: RunPlan 빌드 매핑** — `main.rs:181` RunPlan 리터럴의 `target_rps: None, max_in_flight: None`(T1에서 추가)을 proto Profile 매핑으로 교체:
```rust
        target_rps: profile.target_rps,        // proto optional uint32 → Option<u32>
        max_in_flight: profile.max_in_flight,
```

- [ ] **Step 3: dispatch 분기** — `main.rs:292` `run_scenario(...)` 호출을:
```rust
    let run_res = match plan.target_rps {
        Some(_) => {
            handicap_engine::run_scenario_open_loop(scenario, plan, win_tx, cancel).await
        }
        None => run_scenario(scenario, plan, win_tx, cancel).await,
    };
```
import에 `run_scenario_open_loop` 추가(상단 `use handicap_engine::{… run_scenario}`).

- [ ] **Step 4: 빌드 + 워커 바이너리 재빌드(subprocess용)**
```bash
cargo build -p handicap-worker --bin worker
cargo build --workspace 2>&1 | tail -20
rm -f crates/worker/tests/_tdd_keepalive.rs
```
- [ ] **Step 5: 커밋**
```bash
git add crates/worker/src/main.rs
git commit -m "feat(worker): map open-loop Profile fields + dispatch run_scenario_open_loop"
```

---

## Task 7: UI — RunDialog 부하모델 토글 + 필드 + Zod

**Files:**
- Modify: `ui/src/api/schemas.ts` (Profile/RunConfig Zod)
- Modify: `ui/src/components/RunDialog.tsx`
- Test: `ui/src/components/__tests__/RunDialog.test.tsx` (또는 기존 위치)

- [ ] **Step 1: 실패 테스트 작성(RTL)** — open-loop 모드 선택 시 target_rps/max_in_flight 노출 + 빈 max_in_flight 게이트

```tsx
it("open-loop mode shows target_rps + max_in_flight and gates empty max_in_flight", async () => {
  const user = userEvent.setup();
  render(<RunDialog scenarioId="s1" onClose={() => {}} />);
  // 부하모델을 open-loop로 전환 (구현 토글의 접근성 이름에 맞춰 조정)
  await user.click(screen.getByRole("radio", { name: /open-loop/i }));
  expect(screen.getByLabelText(/target rps/i)).toBeInTheDocument();
  const cap = screen.getByLabelText(/max in.?flight/i);
  await user.clear(cap);
  // submit 비활성 또는 검증 에러
  expect(screen.getByRole("button", { name: /run|시작/i })).toBeDisabled();
});
```

- [ ] **Step 2: 실패 확인** → Run: `cd ui && pnpm test RunDialog` — Expected: FAIL.
- [ ] **Step 3: Zod 필드** — `schemas.ts` Profile/RunConfig 스키마에:
```ts
  target_rps: z.number().int().positive().max(1_000_000).optional(),
  max_in_flight: z.number().int().positive().max(10_000).optional(),
```
> `.optional()` (NOT `.default()` — nested default는 `number|undefined` parent-infer 누출, ui/CLAUDE.md).

- [ ] **Step 4: RunDialog 토글 + 필드** — closed/open 라디오(또는 select). open 선택 시: target_rps(필수)·max_in_flight(필수)·duration 노출, vus/ramp_up/run-level think time **숨김**(보내지 않음 → 충돌 400 UI 예방). 검증: 두 상한 + 빈 max_in_flight 게이트.

> **⚠ payload 빌더 2곳(A1)**: `RunDialog.tsx`는 profile payload를 **두 군데**서 만든다 — run submit(`:~212`) **와** preset-save(`:~616`). **둘 다** 동일하게 open-loop 처리(open이면 `target_rps`/`max_in_flight` 포함·`ramp_up_seconds: 0`·think_time omit; closed면 open 필드 미전송 = 현행 byte-identical). 한쪽만 고치면 open-loop 프리셋이 malformed(서버 validate가 막지만 UI가 만들게 둠). 공통 헬퍼로 빼서 두 사이트 공유 권장.

- [ ] **Step 5: 통과 + 게이트** → Run: `cd ui && pnpm test RunDialog && pnpm lint && pnpm build` — Expected: PASS, tsc-b clean, eslint 0 warn.
- [ ] **Step 6: 커밋**
```bash
git add ui/src/api/schemas.ts ui/src/components/RunDialog.tsx ui/src/components/__tests__/RunDialog.test.tsx
git commit -m "feat(ui): RunDialog open-loop mode (target_rps + max_in_flight, field swap, validation)"
```

---

## Task 8: 컨트롤러 — open-loop e2e smoke (코어, dropped 영속화 전)

**Files:** Test: `crates/controller/tests/e2e_test.rs` (추가)

- [ ] **Step 1: 실패 테스트 작성** — run-create(open-loop) → 워커 subprocess → run 완료 + 요청 발생

```rust
// open-loop run completes and generates traffic. (dropped persistence not asserted here.)
#[tokio::test]
async fn open_loop_e2e_smoke() {
    // 기존 e2e 헬퍼(wiremock 타겟 + controller + subprocess worker) 패턴 재사용.
    // POST /api/runs with profile { target_rps: 50, max_in_flight: 16, duration_seconds: 2 }
    // (vus 생략/0). run이 succeeded로 끝나고 report summary.count > 0 단언.
}
```
> 기존 `report_e2e_smoke`/`loop_e2e_inner_step_counts`의 셋업을 복제해 profile만 open-loop로. **워커 바이너리 warm 필요**(`cargo build -p handicap-worker` 선행 — 루트 CLAUDE.md cold-build flake).

- [ ] **Step 2: 실패 확인** → Run: `cargo build -p handicap-worker && cargo test -p handicap-controller --test e2e_test open_loop_e2e_smoke` — Expected: FAIL→구현 후 PASS.
- [ ] **Step 3: 구현/배선 보정** — 위 경로가 이미 동작하면(코어 완성) 테스트만. run이 `running`에 멈추면 controller 로그의 worker exit 확인(루트 CLAUDE.md status-transition 갭).
- [ ] **Step 4: 통과 확인** → Run: `cargo test -p handicap-controller --test e2e_test open_loop_e2e_smoke` — Expected: PASS.
- [ ] **Step 5: 커밋**
```bash
git add crates/controller/tests/e2e_test.rs
git commit -m "test(controller): open-loop e2e smoke (run completes, traffic generated)"
```

> **여기까지 = 코어 출하 가능.** 아래 Tasks 9–13은 dropped 영속화(필요 시 follow-up으로 절단).

---

## Task 9: 컨트롤러 — migration 0009 `runs.dropped` 컬럼 (Rust-guarded idempotent)

**Files:** Modify: `crates/controller/src/store/mod.rs`

- [ ] **Step 1: 실패 테스트 작성** — 멱등 + 기존 행 보존(`run_metrics_worker_id` 가드 테스트 패턴 복제)

```rust
#[tokio::test]
async fn runs_dropped_column_guard_is_idempotent() {
    let pool = /* OLD-schema runs table, no dropped column */;
    ensure_runs_dropped(&pool).await.unwrap();
    ensure_runs_dropped(&pool).await.unwrap(); // second call no-op
    let has: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM pragma_table_info('runs') WHERE name = 'dropped'",
    ).fetch_one(&pool).await.unwrap();
    assert_eq!(has, 1);
}
```

- [ ] **Step 2: 실패 확인** → Run: `cargo test -p handicap-controller runs_dropped_column_guard` — Expected: FAIL.
- [ ] **Step 3: 가드 함수 + connect() 호출** — `runs.message` 가드(`connect()` 내 pragma_table_info) 패턴 복제:
```rust
async fn ensure_runs_dropped(db: &Db) -> anyhow::Result<()> {
    let has: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM pragma_table_info('runs') WHERE name = 'dropped'",
    ).fetch_one(db).await?;
    if has == 0 {
        sqlx::query("ALTER TABLE runs ADD COLUMN dropped INTEGER NOT NULL DEFAULT 0")
            .execute(db).await?;
    }
    Ok(())
}
```
migration 0008 호출 라인 옆에 `ensure_runs_dropped(&pool).await?; // migration 0009 (Rust-guarded)`.

- [ ] **Step 4: 통과 확인** → Run: `cargo test -p handicap-controller runs_dropped_column_guard` — Expected: PASS.
- [ ] **Step 5: 커밋**
```bash
git add crates/controller/src/store/mod.rs
git commit -m "feat(controller): migration 0009 — runs.dropped column (Rust-guarded idempotent)"
```

---

## Task 10: 워커 forward + 컨트롤러 ingest — dropped 누적

**Files:**
- Modify: `crates/worker/src/main.rs` (forwarder: flush.dropped → MetricBatch.dropped)
- Modify: `crates/controller/src/grpc/coordinator.rs` (`ingest_metrics`: UPDATE runs.dropped)
- Test: `coordinator.rs` 인라인 또는 `crates/controller/tests/`

- [ ] **Step 1: 실패 테스트 작성** — ingest가 dropped를 runs에 누적

```rust
#[tokio::test]
async fn ingest_accumulates_dropped_into_runs() {
    let state = /* coordinator state + a run row */;
    // 두 배치(dropped=3, dropped=5) ingest → runs.dropped == 8
    // NOTE: ingest_metrics는 () 반환(에러는 내부 warn! — coordinator.rs:783). .unwrap() 금지.
    ingest_metrics(&state, batch_with_dropped("run1", "w0", 3)).await;
    ingest_metrics(&state, batch_with_dropped("run1", "w0", 5)).await;
    let d: i64 = sqlx::query_scalar("SELECT dropped FROM runs WHERE id='run1'")
        .fetch_one(&state.db).await.unwrap();
    assert_eq!(d, 8);
}
```

- [ ] **Step 2: 실패 확인** → Run: `cargo test -p handicap-controller ingest_accumulates_dropped` — Expected: FAIL.
- [ ] **Step 3: 워커 forwarder** — `main.rs` forwarder가 `MetricFlush`→`MetricBatch` 변환 지점에서 `dropped: flush.dropped` 세팅(`MetricBatch{}` 리터럴 `:259`의 `dropped: 0`을 `dropped: flush.dropped`로).

> **⚠ CRITICAL(C1) — empty-skip 가드 완화**: forwarder의 빈-배치 스킵 가드(`main.rs:~255`)가 현재:
> ```rust
> if windows.is_empty() && loop_stats.is_empty() && branch_stats.is_empty() { continue; }
> ```
> open-loop는 run-total `dropped`를 **windows가 빈 final flush**로 보낸다(periodic flusher가 이미 윈도를 다 비운 뒤). 이 가드를 안 고치면 그 final flush가 `continue`로 버려져 **`dropped`가 영영 controller에 안 닿는다**(T13 실패/flaky). 반드시:
> ```rust
> if windows.is_empty() && loop_stats.is_empty() && branch_stats.is_empty() && flush.dropped == 0 { continue; }
> ```
> 로 완화. (`flush.windows`/`loop_stats`/`branch_stats` destructure 자리에 `dropped`도 함께 바인딩.)
- [ ] **Step 4: ingest UPDATE** — `coordinator.rs` `ingest_metrics`에서 batch 처리 끝에:
```rust
    if batch.dropped > 0 {
        sqlx::query("UPDATE runs SET dropped = dropped + ? WHERE id = ?")
            .bind(batch.dropped as i64)
            .bind(&batch.run_id)
            .execute(&state.db)
            .await?;
    }
```
- [ ] **Step 5: 통과 + 워커 재빌드** → Run: `cargo build -p handicap-worker && cargo test -p handicap-controller ingest_accumulates_dropped` — Expected: PASS.
- [ ] **Step 6: 커밋**
```bash
git add crates/worker/src/main.rs crates/controller/src/grpc/coordinator.rs
git commit -m "feat(controller,worker): forward + accumulate open-loop dropped into runs.dropped"
```

---

## Task 11: 컨트롤러 — `RunRow.dropped` + `build_report` → `ReportJson.dropped`

**Files:**
- Modify: `crates/controller/src/store/runs.rs` (`RunRow.dropped` + `get` SELECT)
- Modify: `crates/controller/src/report.rs` (`ReportJson.dropped`)
- Modify: `crates/controller/src/api/runs.rs` (`build_report` thread)
- Test: build_report 단위/통합

- [ ] **Step 1: 실패 테스트 작성** — runs.dropped 있는 run의 리포트에 dropped 노출
```rust
#[tokio::test]
async fn build_report_surfaces_dropped() {
    // runs.dropped = 7 인 완료 run → ReportJson.dropped == 7
}
```
- [ ] **Step 2: 실패 확인** → Run: `cargo test -p handicap-controller build_report_surfaces_dropped` — Expected: FAIL.
- [ ] **Step 3: 배선** —
  - `RunRow`에 `pub dropped: i64`, `runs::get`(+ 다른 SELECT 사이트)에 `dropped` 컬럼 추가(SELECT 리스트 + `from_row`/매핑).
  - `ReportJson`(`report.rs`)에 `pub dropped: u64`(`#[serde(default)]` — 골든 fixture/옛 리포트 호환).
  - `build_report`가 `row.dropped as u64`를 `ReportJson.dropped`로 thread. `target_rps`는 `ReportRun.profile`(이미 `serde_json::Value`)에 포함돼 무료.
- [ ] **Step 4: 통과 확인** → Run: `cargo test -p handicap-controller build_report_surfaces_dropped` — Expected: PASS.
- [ ] **Step 5: 커밋**
```bash
git add crates/controller/src/store/runs.rs crates/controller/src/report.rs crates/controller/src/api/runs.rs
git commit -m "feat(controller): thread runs.dropped into ReportJson.dropped"
```

---

## Task 12: UI — 리포트 summary에 target_rps / achieved / dropped

**Files:**
- Modify: `ui/src/api/schemas.ts` (ReportJson Zod에 `dropped`)
- Modify: `ui/src/components/report/*` (Summary)
- Test: report RTL

- [ ] **Step 1: 실패 테스트 작성** — dropped>0 리포트가 dropped + drop율 렌더
```tsx
it("renders dropped count for open-loop reports", () => {
  render(<ReportSummary report={{ ...openLoopReport, dropped: 12, summary: { ...s, count: 88 } }} />);
  expect(screen.getByText(/dropped/i)).toBeInTheDocument();
  expect(screen.getByText(/12/)).toBeInTheDocument();
});
```
- [ ] **Step 2: 실패 확인** → Run: `cd ui && pnpm test report` — Expected: FAIL.
- [ ] **Step 3: 배선** — ReportJson Zod에 `dropped: z.number().default(0)`. Summary에 open-loop일 때(`report.dropped`나 profile.target_rps 존재) `target_rps`(설정) / achieved RPS(기존 `summary.rps`) / `dropped`(+ `dropped/(dropped+count)` 율) 표시. closed-loop면 미표시.
- [ ] **Step 4: 통과 + 게이트** → Run: `cd ui && pnpm test report && pnpm lint && pnpm build` — Expected: PASS.
- [ ] **Step 5: 커밋**
```bash
git add ui/src/api/schemas.ts ui/src/components/report
git commit -m "feat(ui): report summary shows open-loop target_rps / achieved / dropped"
```

---

## Task 13: e2e — dropped 전 파이프라인

**Files:** Test: `crates/controller/tests/e2e_test.rs` (추가)

- [ ] **Step 1: 실패 테스트 작성** — 느린 타겟 + 작은 max_in_flight → 리포트 dropped>0
```rust
#[tokio::test]
async fn open_loop_dropped_reaches_report() {
    // wiremock with delay + profile { target_rps: 200, max_in_flight: 1, duration_seconds: 2 }
    // → report.dropped > 0.
}
```
- [ ] **Step 2: 실패 확인** → Run: `cargo build -p handicap-worker && cargo test -p handicap-controller --test e2e_test open_loop_dropped_reaches_report` — Expected: FAIL→PASS.
- [ ] **Step 3: 통과 확인** → Run: 동일 — Expected: PASS.
- [ ] **Step 4: 커밋**
```bash
git add crates/controller/tests/e2e_test.rs
git commit -m "test(controller): open-loop dropped reaches report end-to-end"
```

---

## Task 14: ADR-0031 + 문서

**Files:**
- Create: `docs/adr/0031-open-loop-arrival-rate-execution-model.md`
- Modify: 루트 `CLAUDE.md`(상태 + 알아둘 결정 0031), `docs/roadmap.md`(§D S-C 완료), `docs/adr/README.md`(인덱스)

- [ ] **Step 1: ADR 작성** — MADR 포맷. 결정 = spec §11(opt-in / 균등 틱 / drop+카운터 / 슬롯=vu_id+jar 지속 / 단일워커 v1 / dropped 마이그레이션 0009 advisory-only / 노브 충돌 400 / churn·곡선 연기).
- [ ] **Step 2: 루트 CLAUDE.md** — 상태 줄에 S-C 완료 + "알아둘 결정"에 `0031` 한 줄. 엔진 함정(`crates/engine/CLAUDE.md`)에 open-loop 슬롯 풀/별도 함수/run_arrival 복제 한 줄.
- [ ] **Step 3: docs/roadmap.md §D** — S-C 완료 반영, 잔여 S-D(stages) + churn 노브.
- [ ] **Step 4: 문서 conflict marker 점검 + 커밋** (`.md`-only fast-path)
```bash
grep -rn '^<<<<<<<\|^>>>>>>>' docs/ crates/engine/CLAUDE.md CLAUDE.md || echo clean
git add docs/adr/0031-*.md docs/adr/README.md docs/roadmap.md CLAUDE.md crates/engine/CLAUDE.md
git commit -m "docs(adr,roadmap,claude): ADR-0031 open-loop + S-C 완료 반영"
```

---

## Self-Review (작성자 체크)

**Spec 커버리지**: §4 정체성→T1/T3, §5 스케줄러→T1/T2, §6 dropped 파이프라인→T1·T5·T9·T10·T11·T12, §7 config/검증→T4·T5, §8 UI→T7·T12, §9 연기→문서, §10 테스트→T1·T2·T3·T8·T13, §11 ADR→T14. **갭 없음.**

**절단 가능성**: T1–T8 코어(dropped는 엔진 in-memory→MetricFlush까지만, 영속화 무). T9–T13 절단 시 코어 출하 가능(closed-loop byte-identical + achieved≈target). ✓

**타입 일관성**: `target_rps: Option<u32>`/`max_in_flight: Option<u32>`(RunPlan·Profile·proto optional 일관), `MetricFlush.dropped: u64`/proto `dropped uint64`/`runs.dropped INTEGER`/`ReportJson.dropped: u64`/Zod `number`. `run_scenario_open_loop` 시그니처 = `run_scenario`와 동일(scenario, plan, out, cancel). ✓

**게이트 경계**: 각 task green-committable(dead-code/RED 단독 커밋 회피 — pub 함수·필드라 미사용도 dead_code 아님). 커밋은 foreground 단일 호출. UI task는 `pnpm lint && test && build` 별도. ✓

**커밋 순서 함정(pre-commit 전체 게이트)**: proto 변경(T5)은 build 깨지는 literal 전부 동반 수정(`grep Profile {`/`MetricBatch {`). 엔진/워커 변경 커밋은 cold-build flake 대비 `cargo build -p handicap-worker` warm 후. ✓
