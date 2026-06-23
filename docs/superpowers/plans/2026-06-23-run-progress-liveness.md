# Run 진행 라이브니스 (G1a: A+B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 등록을 마쳤지만 진행이 없는(hung) 워커의 run을 컨트롤러가 자동으로 `Failed`(사유 message 포함)로 닫는다 — startup 무부하(A) + 예상종료 초과(B) 두 watchdog.

**Architecture:** 기존 per-run `registration_watchdog`(coordinator.rs)를 3-phase `run_watchdog`로 재작성(등록→startup-A→backstop-B). 진행 신호 = 마지막 MetricBatch 도착(`ingest_metrics`가 첫 배치에 `first_load` 토큰 cancel). 정상 완료/실패/abort는 `done` 토큰 cancel로 watchdog 즉시 종료. A/B fail은 기존 `fail_incomplete_registration` teardown(`mark_failed_if_active`+abort+cleanup)을 `fail_run_hung`으로 공유. B의 예상시간은 worker의 `run_duration_secs`를 proto crate로 추출해 단일 소스화.

**Tech Stack:** Rust (tokio `CancellationToken`/`tokio::time`, sqlx SQLite, prost/tonic), 컨트롤러 단독.

설계 근거·불변식 전문 → `docs/superpowers/specs/2026-06-23-run-progress-liveness-design.md`.

## Global Constraints

- **healthy run byte-identical**: A+B는 항상 무장하되 정상 run은 `first_load`(첫 메트릭)·`done`(완료)가 grace 전 cancel → watchdog 조용히 종료. **오직 영영 running이던 run만** `Failed`로 바뀐다. 기존 e2e/단위 무변경 통과.
- **migration / proto-field / UI / settings-registry / AppState / engine: 0.** proto는 `run_duration_secs` 추출만(필드 추가 0). worker 동작 byte-identical.
- **terminal 비클로버**: 모든 fail은 `mark_failed_if_active`(가드 `WHERE status IN ('pending','running')`) — reaper/worker_disconnected/정상 finalize와 race-safe.
- **R14 락 규율**: `runs` 락 안에서 스냅샷만(`.await` 0) → guard drop → 락 밖에서 DB write·abort·cleanup. `fail_incomplete_registration`(coordinator.rs:993) 패턴 그대로.
- **테스트 = 실타이머 (`pause()` 금지)**: watchdog는 발동 시 DB write(`mark_failed_if_active`)를 하는 spawned-sleep 태스크라 `tokio::time::pause()/advance()`는 sqlx `PoolTimedOut`을 유발한다. `watchdog_fires_after_deadline`(coordinator.rs:2147) 실타이머 패턴을 따른다 — grace를 sub-second `Duration`으로 주입 + 실제 `tokio::time::sleep`.
- **green-commit 규율**: 각 Task는 빌드+clippy(`-D warnings`)+nextest 전부 통과하는 단일 커밋. 미사용 `pub(crate)` 헬퍼·RED-only 테스트는 게이트 실패(루트 CLAUDE.md). 커밋은 `run_in_background:false` 단일 호출 + `git log -1`로 landed 확인(파이프 금지).
- **커밋 메시지**: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` 줄로 끝.

---

## File Structure

- `crates/proto/src/lib.rs` — `run_duration_secs(&Profile) -> u64` 신규 `pub fn`(엔진 deadline 공식 단일 소스) + 단위테스트.
- `crates/worker/src/lib.rs` — private `run_duration_secs`(:609) 삭제 → proto 공유본 import(동작 byte-identical).
- `crates/controller/src/grpc/coordinator.rs` — `CoordinatorState`에 `watchdog_grace` OnceLock 필드 + accessor, `RunWorkers`에 `first_load`/`done` 토큰, `registration_watchdog`→`run_watchdog` 3-phase, `fail_run_hung` 추출, `ingest_metrics` first_load cancel, finalize 사이트 `done` cancel, `enqueue` 2 Duration 파라미터, 단위테스트.
- `crates/controller/src/api/runs.rs` — `spawn_run`이 grace 계산(assignment.profile + OnceLock) → 3 enqueue 사이트 전달, `leading_idle_secs`/`startup_grace_eff` 순수 헬퍼 + 단위테스트.
- `crates/controller/src/main.rs` — CLI 2 flag(`--run-startup-grace-seconds` 90 · `--run-backstop-grace-seconds` 120) + `set_watchdog_grace` 1회 호출 + 로그.

---

## Task 1: proto crate에 `run_duration_secs` 단일 소스 추출

**Files:**
- Modify: `crates/proto/src/lib.rs`
- Modify: `crates/worker/src/lib.rs:607-620` (private fn 삭제 + import)

**Interfaces:**
- Produces: `handicap_proto::run_duration_secs(p: &handicap_proto::v1::Profile) -> u64` — VU-curve stage 합 > rate-curve stage 합 > flat `duration_seconds`(엔진 deadline 불변식). Task 4의 `spawn_run`이 B의 backstop 계산에 사용.

- [ ] **Step 1: proto crate에 실패 테스트 작성**

`crates/proto/src/lib.rs` 끝에 추가:

```rust
#[cfg(test)]
mod tests {
    use super::v1::{Profile, Stage};

    fn stage(dur: u32) -> Stage {
        Stage { target: 0, duration_seconds: dur }
    }

    #[test]
    fn flat_duration_when_no_stages() {
        let p = Profile { duration_seconds: 30, ..Default::default() };
        assert_eq!(super::run_duration_secs(&p), 30);
    }

    #[test]
    fn rate_curve_sums_stages() {
        let p = Profile {
            duration_seconds: 999,
            stages: vec![stage(5), stage(3)],
            ..Default::default()
        };
        assert_eq!(super::run_duration_secs(&p), 8);
    }

    #[test]
    fn vu_curve_takes_precedence_over_rate_and_flat() {
        let p = Profile {
            duration_seconds: 999,
            stages: vec![stage(100)],
            vu_stages: vec![stage(4), stage(6)],
            ..Default::default()
        };
        assert_eq!(super::run_duration_secs(&p), 10);
    }
}
```

- [ ] **Step 2: 실패 확인**

Run: `cargo test -p handicap-proto run_duration_secs 2>&1 | tail -20`
Expected: FAIL — `cannot find function 'run_duration_secs'`.

- [ ] **Step 3: 공유 함수 추가**

`crates/proto/src/lib.rs`의 `pub use coordinator::v1;`(:9) 아래에 추가:

```rust
use coordinator::v1::Profile;

/// Total run duration the engine will run for: VU-curve stage sum > rate-curve
/// stage sum > flat `duration_seconds`. **Invariant: engine deadline = this value.**
/// Single source shared by the worker (builds `RunPlan.duration`) and the
/// controller's run-progress watchdog (B backstop). Mirrors the formula formerly
/// private in `crates/worker/src/lib.rs`.
pub fn run_duration_secs(p: &Profile) -> u64 {
    if !p.vu_stages.is_empty() {
        p.vu_stages.iter().map(|s| u64::from(s.duration_seconds)).sum()
    } else if p.stages.is_empty() {
        u64::from(p.duration_seconds)
    } else {
        p.stages.iter().map(|s| u64::from(s.duration_seconds)).sum()
    }
}
```

- [ ] **Step 4: 통과 확인**

Run: `cargo test -p handicap-proto run_duration_secs 2>&1 | tail -20`
Expected: PASS (3 tests).

- [ ] **Step 5: worker를 공유본으로 재배선**

`crates/worker/src/lib.rs`에서 private `fn run_duration_secs`(607-620 근방, **doc 주석 + fn body만** 삭제). 파일 상단 import에 추가:

```rust
use handicap_proto::run_duration_secs;
```

(이미 `use handicap_proto::v1 as pb;`로 alias하므로 `handicap_proto`는 직접 dep다. 호출부 lib.rs:221 `Duration::from_secs(run_duration_secs(&profile))`는 무변경 — 이제 import된 공유본으로 resolve.)

> **기존 worker 테스트는 삭제하지 말 것**(리뷰어 반영). worker 테스트 모듈은 `use super::*`라, import 추가 후 `run_duration_secs` 호출이 공유본으로 resolve돼 그대로 통과한다. 그 호출들은 `run_duration_uses_vu_stage_sum`·`stages_wiring` 같은 **더 큰 테스트 안**에서 `proto_is_vu_curve`/`proto_is_open_loop`도 함께 단언하므로, 삭제하면 그 커버리지를 잃는다. Step 1의 proto-crate 테스트는 **신규 추가**(이전이 아님).

- [ ] **Step 6: worker 동작 byte-identical 확인**

Run: `cargo build -p handicap-worker && cargo test -p handicap-worker 2>&1 | tail -20`
Expected: PASS (worker가 같은 duration 공식을 공유본으로 호출 — 행동 불변).

- [ ] **Step 7: 커밋**

```bash
git add crates/proto/src/lib.rs crates/worker/src/lib.rs
git commit -m "refactor(proto): run_duration_secs 공유 추출 (worker+controller 단일 소스, G1a Task 1)"
git log -1 --oneline
```

---

## Task 2: `watchdog_grace` OnceLock + CLI flags

**Files:**
- Modify: `crates/controller/src/grpc/coordinator.rs` (CoordinatorState 필드 + accessor)
- Modify: `crates/controller/src/main.rs` (CLI flags + set + 로그)

**Interfaces:**
- Produces: `CoordinatorState::set_watchdog_grace(&self, startup_floor: Duration, backstop_grace: Duration)` (1회 설정, `set_pool_mode` 패턴) · `CoordinatorState::watchdog_grace_config(&self) -> (Duration, Duration)` (미설정 시 기본 `(90s, 120s)`). Task 4 `spawn_run`이 per-run grace 도출에 사용.

- [ ] **Step 1: 실패 테스트 작성**

`coordinator.rs`의 `#[cfg(test)] mod tests` 안에 추가(`use std::time::Duration;`가 없으면 추가):

```rust
#[tokio::test]
async fn watchdog_grace_defaults_then_overrides() {
    let db = crate::store::connect("sqlite::memory:").await.unwrap();
    let coord = CoordinatorState::new(db);
    assert_eq!(
        coord.watchdog_grace_config(),
        (Duration::from_secs(90), Duration::from_secs(120)),
        "unset → default 90/120"
    );
    coord.set_watchdog_grace(Duration::from_secs(5), Duration::from_secs(7));
    assert_eq!(coord.watchdog_grace_config(), (Duration::from_secs(5), Duration::from_secs(7)));
}
```

- [ ] **Step 2: 실패 확인**

Run: `cargo test -p handicap-controller watchdog_grace_defaults 2>&1 | tail -20`
Expected: FAIL — method 미정의.

- [ ] **Step 3: CoordinatorState 필드 + accessor 추가**

`CoordinatorState` 구조체에 필드 추가(`pool_mode: OnceLock<bool>` 옆):

```rust
    /// CLI-seeded run-liveness grace: (startup_floor, backstop_grace). Set once in
    /// main.rs; unset (tests/legacy) → default (90s, 120s). OnceLock per the
    /// `set_pool_mode`/`set_worker_token` precedent — zero AppState/settings churn.
    watchdog_grace: std::sync::OnceLock<(std::time::Duration, std::time::Duration)>,
```

`CoordinatorState::new(db)`의 구조체 리터럴(coordinator.rs:220 근방)에 `watchdog_grace: std::sync::OnceLock::new(),` 추가. 메서드 추가(`set_pool_mode`/`is_pool_mode` 근처):

```rust
    pub fn set_watchdog_grace(&self, startup_floor: std::time::Duration, backstop_grace: std::time::Duration) {
        let _ = self.watchdog_grace.set((startup_floor, backstop_grace));
    }

    pub fn watchdog_grace_config(&self) -> (std::time::Duration, std::time::Duration) {
        *self
            .watchdog_grace
            .get()
            .unwrap_or(&(std::time::Duration::from_secs(90), std::time::Duration::from_secs(120)))
    }
```

- [ ] **Step 4: 통과 확인**

Run: `cargo test -p handicap-controller watchdog_grace_defaults 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 5: main.rs CLI flags + 배선 + 로그**

`ControllerArgs`(clap)에 필드 추가:

```rust
    /// 등록 후 첫 메트릭을 기다리는 최소 시간(초). 실제 grace는 http_timeout과
    /// 선두 rate=0 stage를 더해 늘어난다(per-run). hung 워커를 이 안에 못 잡으면 backstop이 닫는다.
    #[arg(long, default_value_t = 90)]
    run_startup_grace_seconds: u64,
    /// run 예상 종료 시각을 넘어 terminal을 기다리는 grace(초). 이 시간을 넘기면 hung으로 보고 Failed.
    #[arg(long, default_value_t = 120)]
    run_backstop_grace_seconds: u64,
```

`coord_state`(CoordinatorState, main.rs:172 `let coord_state = CoordinatorState::new(...)`)가 만들어진 직후, AppState 구성·`CoordinatorService` move(main.rs:321) 전에:

```rust
    coord_state.set_watchdog_grace(
        std::time::Duration::from_secs(args.run_startup_grace_seconds),
        std::time::Duration::from_secs(args.run_backstop_grace_seconds),
    );
    let (su, bk) = coord_state.watchdog_grace_config();
    tracing::info!(
        startup_grace_s = su.as_secs(),
        backstop_grace_s = bk.as_secs(),
        "run-liveness watchdog configured"
    );
```

(실제 변수명은 `coord_state` — `set_worker_token`/`set_pool_mode`와 동일 변수. 로그가 `watchdog_grace_config()`를 읽지만, `pub` 메서드는 dead-code 면제라 사실 로그 없이도 green — 로그는 운영 가시성용.)

- [ ] **Step 6: 빌드 + 게이트**

Run: `cargo build --workspace && cargo clippy -p handicap-controller --all-targets -- -D warnings 2>&1 | tail -20`
Expected: 0 에러/경고.

- [ ] **Step 7: 커밋**

```bash
git add crates/controller/src/grpc/coordinator.rs crates/controller/src/main.rs
git commit -m "feat(controller): run-liveness grace CLI flags + OnceLock (G1a Task 2)"
git log -1 --oneline
```

---

## Task 3: `fail_run_hung` 공통 teardown 추출

**Files:**
- Modify: `crates/controller/src/grpc/coordinator.rs:993-1026` (`fail_incomplete_registration` 정리 + `fail_run_hung` 신규)

**Interfaces:**
- Produces: `CoordinatorState::fail_run_hung(&self, run_id: &str, reason: &str, abort_msg: &str)` — terminal-guard + sibling tx 스냅샷(락 안) → `mark_failed_if_active(reason)` + `fan_out_abort(abort_msg)` + `cleanup_dispatcher`(락 밖). Task 4의 A/B가 사용.

- [ ] **Step 1: 실패 테스트 작성**

`coordinator.rs` 테스트 모듈에 추가:

```rust
#[tokio::test]
async fn fail_run_hung_fails_active_and_noops_terminal() {
    let db = crate::store::connect("sqlite::memory:").await.unwrap();
    let run_id = seed_run(&db).await;
    let coord = CoordinatorState::new(db.clone());
    coord.enqueue(run_id.clone(), base_assignment(), 1, 4, None).await;
    let (tx0, mut r0) = fake_tx();
    coord.register(&run_id, "w0", tx0).await;

    coord.fail_run_hung(&run_id, "stuck: no metrics", "hung").await;
    let row = runs::get(&db, &run_id).await.unwrap().unwrap();
    assert_eq!(row.status, RunStatus::Failed);
    assert_eq!(row.message.as_deref(), Some("stuck: no metrics"));
    assert!(r0.try_recv().is_ok(), "registered worker gets AbortRun");

    // 두 번째 호출 = terminal → no-op(메시지 클로버 안 함)
    coord.fail_run_hung(&run_id, "different reason", "hung").await;
    let row2 = runs::get(&db, &run_id).await.unwrap().unwrap();
    assert_eq!(row2.message.as_deref(), Some("stuck: no metrics"), "terminal 비클로버");
}
```

> 주의: 이 Step은 Task 4가 추가할 `enqueue` 2-Duration 파라미터를 아직 모른다. 이 테스트의 `enqueue(...)` 호출은 **Task 3 시점의 현재 시그니처**(`run_id, base, expected, total_vus, None`)를 쓴다. Task 4에서 enqueue 시그니처가 바뀌면 이 호출부도 long-grace 인자를 더해 갱신된다(Task 4 Step 10이 컴파일러 안내로 잡음).

- [ ] **Step 2: 실패 확인**

Run: `cargo test -p handicap-controller fail_run_hung_fails 2>&1 | tail -20`
Expected: FAIL — `fail_run_hung` 미정의.

- [ ] **Step 3: `fail_run_hung` 추출 + `fail_incomplete_registration` 정리**

`fail_incomplete_registration`(coordinator.rs:993)를 아래로 교체:

```rust
    /// Fail a run that cannot make progress and tear it down: terminal-guard +
    /// snapshot siblings under the runs lock, then (lock-free) mark the run failed
    /// with `reason`, abort registered workers with `abort_msg`, and release the
    /// dispatcher. Shared by `fail_incomplete_registration` (registration timeout)
    /// and the run-progress watchdog A/B (no-load / backstop). R14 lock discipline.
    pub async fn fail_run_hung(&self, run_id: &str, reason: &str, abort_msg: &str) {
        let siblings = {
            let mut g = self.runs.lock().await;
            let Some(rw) = g.get_mut(run_id) else { return; };
            if rw.terminal {
                return;
            }
            rw.terminal = true;
            rw.workers.values().map(|e| e.tx.clone()).collect::<Vec<_>>()
        };
        let _ = runs::mark_failed_if_active(&self.db, run_id, &truncate_message(reason)).await;
        fan_out_abort(run_id, &siblings, abort_msg).await;
        self.cleanup_dispatcher(run_id).await;
    }

    pub async fn fail_incomplete_registration(&self, run_id: &str) {
        // Registration-specific guard + message; teardown is shared via fail_run_hung.
        let counts = {
            let g = self.runs.lock().await;
            match g.get(run_id) {
                Some(rw) if !rw.terminal && (rw.workers.len() as u32) < rw.expected => {
                    Some((rw.workers.len(), rw.expected))
                }
                _ => None,
            }
        };
        if let Some((registered, expected)) = counts {
            let reason =
                format!("only {registered}/{expected} workers registered before the registration deadline");
            self.fail_run_hung(run_id, &reason, "not all workers registered before deadline")
                .await;
        }
    }
```

> 함정: `truncate_message`가 `fail_run_hung` 안에서 호출되므로, 기존 `fail_incomplete_registration`의 `truncate_message(&format!(...))`는 제거됐다(`fail_run_hung`이 이미 truncate). 이중 truncate 방지 — `fail_run_hung`이 단일 truncate 지점.

- [ ] **Step 4: 통과 + 회귀 확인**

Run: `cargo test -p handicap-controller fail_run_hung_fails registration_deadline_fails incomplete_registration_records 2>&1 | tail -25`
Expected: PASS (신규 + 기존 두 fail_incomplete 테스트 무변경 통과).

- [ ] **Step 5: 커밋**

```bash
git add crates/controller/src/grpc/coordinator.rs
git commit -m "refactor(controller): fail_run_hung 공통 teardown 추출 (G1a Task 3)"
git log -1 --oneline
```

---

## Task 4: 3-phase `run_watchdog` + 진행 토큰 + grace 배선 (코어)

**Files:**
- Modify: `crates/controller/src/grpc/coordinator.rs` (RunWorkers 토큰, run_watchdog, ingest_metrics, finalize 사이트, enqueue, 테스트)
- Modify: `crates/controller/src/api/runs.rs` (`spawn_run` grace 계산 + 헬퍼 + 테스트)

**Interfaces:**
- Consumes: `handicap_proto::run_duration_secs` (Task 1) · `CoordinatorState::watchdog_grace_config` (Task 2) · `CoordinatorState::fail_run_hung` (Task 3).
- Produces: `CoordinatorState::enqueue(run_id, base, expected, total_vus, precomputed, startup_grace: Duration, backstop_total: Duration)` (2 파라미터 추가). 내부 `run_watchdog` 3-phase. `runs.rs`: `leading_idle_secs(&pb::Profile) -> u64`, `startup_grace_eff(&pb::Profile, startup_floor: Duration) -> Duration`.

> **이 Task는 단일 green 커밋이다** — 토큰·watchdog·ingest·finalize·enqueue arity·spawn_run이 서로 맞물려(dead_code/컴파일 게이트) 쪼갤 수 없다. 아래 모든 Step을 마친 뒤 Step 13에서 한 번 커밋한다. 중간 Step은 컴파일 안 될 수 있다(정상).

- [ ] **Step 1: A/B 단위테스트 작성 (실타이머)**

`coordinator.rs` 테스트 모듈에 추가. `enqueue`의 새 시그니처(끝에 startup·backstop `Duration`)와 `run_watchdog`를 가정 — 아직 미구현이라 컴파일 안 됨(예상). 작은 grace 상수를 모듈 상단(테스트 모듈)에 둔다:

```rust
const TINY: Duration = Duration::from_millis(120);
const LONG: Duration = Duration::from_secs(3600);

fn metric_batch(run_id: &str) -> pb::MetricBatch {
    pb::MetricBatch { run_id: run_id.to_string(), worker_id: "w0".to_string(), ..Default::default() }
}

#[tokio::test]
async fn startup_hang_fails_run_no_load() {
    // 전원 등록 → 메트릭 0 → startup grace 경과 → Failed(no-load).
    let db = crate::store::connect("sqlite::memory:").await.unwrap();
    let run_id = seed_run(&db).await;
    let coord = CoordinatorState::new(db.clone());
    coord.enqueue(run_id.clone(), base_assignment(), 1, 4, None, TINY, LONG).await;
    let (tx0, _r0) = fake_tx();
    coord.register(&run_id, "w0", tx0).await; // 1/1 등록 → Phase 2 진입
    tokio::time::sleep(TINY + Duration::from_millis(80)).await;
    let row = runs::get(&db, &run_id).await.unwrap().unwrap();
    assert_eq!(row.status, RunStatus::Failed);
    assert!(row.message.unwrap().contains("no metrics"), "no-load 사유");
}

#[tokio::test]
async fn first_metric_prevents_startup_fail() {
    let db = crate::store::connect("sqlite::memory:").await.unwrap();
    let run_id = seed_run(&db).await;
    let coord = CoordinatorState::new(db.clone());
    coord.enqueue(run_id.clone(), base_assignment(), 1, 4, None, TINY, LONG).await;
    let (tx0, _r0) = fake_tx();
    coord.register(&run_id, "w0", tx0).await;
    ingest_metrics(&coord, &metric_batch(&run_id)).await; // 진행 신호 → first_load cancel
    tokio::time::sleep(TINY + Duration::from_millis(80)).await;
    assert_ne!(
        runs::get(&db, &run_id).await.unwrap().unwrap().status,
        RunStatus::Failed,
        "메트릭이 왔으면 startup-A는 발동 안 함"
    );
}

#[tokio::test]
async fn backstop_fails_run_exceeding_duration() {
    // 메트릭 후 미완료 → backstop 경과 → Failed(exceeded duration).
    let db = crate::store::connect("sqlite::memory:").await.unwrap();
    let run_id = seed_run(&db).await;
    let coord = CoordinatorState::new(db.clone());
    coord.enqueue(run_id.clone(), base_assignment(), 1, 4, None, LONG, TINY).await;
    let (tx0, _r0) = fake_tx();
    coord.register(&run_id, "w0", tx0).await;
    ingest_metrics(&coord, &metric_batch(&run_id)).await; // first_load cancel → Phase 3
    tokio::time::sleep(TINY + Duration::from_millis(80)).await;
    let row = runs::get(&db, &run_id).await.unwrap().unwrap();
    assert_eq!(row.status, RunStatus::Failed);
    assert!(row.message.unwrap().contains("exceeded"), "backstop 사유");
}

#[tokio::test]
async fn completion_cancels_watchdog_no_spurious_fail() {
    let db = crate::store::connect("sqlite::memory:").await.unwrap();
    let run_id = seed_run(&db).await;
    let coord = CoordinatorState::new(db.clone());
    coord.enqueue(run_id.clone(), base_assignment(), 1, 4, None, TINY, TINY).await;
    let (tx0, _r0) = fake_tx();
    coord.register(&run_id, "w0", tx0).await;
    coord.record_phase(&run_id, "w0", pb::run_status::Phase::Completed as i32, "").await;
    tokio::time::sleep(TINY + Duration::from_millis(80)).await;
    assert_eq!(
        runs::get(&db, &run_id).await.unwrap().unwrap().status,
        RunStatus::Completed,
        "정상 완료는 done cancel → watchdog 미발동"
    );
}
```

- [ ] **Step 2: 컴파일 실패 확인**

Run: `cargo test -p handicap-controller startup_hang_fails_run_no_load --no-run 2>&1 | tail -20`
Expected: FAIL — `enqueue` 인자 수 불일치 / `run_watchdog` 미정의.

- [ ] **Step 3: RunWorkers에 진행 토큰 추가**

`RunWorkers` 구조체(coordinator.rs:139)에 필드 추가:

```rust
    /// Cancelled by `ingest_metrics` on this run's FIRST metric batch (progress
    /// signal). The run_watchdog startup phase (A) selects on it.
    first_load: CancellationToken,
    /// Cancelled at every finalize site (Completed/Failed/Aborted/disconnect/
    /// dispatch-fail) → run_watchdog exits immediately on a healthy/terminal run.
    done: CancellationToken,
```

- [ ] **Step 4: `enqueue`에 grace 2 파라미터 + 토큰 생성 + run_watchdog spawn**

`enqueue`(coordinator.rs:681)를 교체:

```rust
    pub async fn enqueue(
        &self,
        run_id: String,
        base: PendingAssignment,
        expected: u32,
        total_vus: u32,
        precomputed: Option<Vec<(u32, u32)>>,
        startup_grace: std::time::Duration,
        backstop_total: std::time::Duration,
    ) -> CancellationToken {
        let token = CancellationToken::new();
        let first_load = CancellationToken::new();
        let done = CancellationToken::new();
        {
            let mut g = self.runs.lock().await;
            g.insert(
                run_id.clone(),
                RunWorkers {
                    base,
                    expected,
                    total_vus,
                    next_shard: 0,
                    workers: HashMap::new(),
                    reg_deadline: token.clone(),
                    terminal: false,
                    precomputed_counts: precomputed,
                    first_load: first_load.clone(),
                    done: done.clone(),
                },
            );
        }
        let coord = self.clone();
        tokio::spawn(async move {
            run_watchdog(
                coord, run_id, token.clone(), first_load, done, startup_grace, backstop_total,
            )
            .await;
        });
        token
    }
```

> 주의: 반환값은 여전히 `reg_deadline` 토큰(`token`). spawn 후에도 호출자에게 돌려준다 — 클로저에 move하기 전 `token.clone()`을 쓴다(위 코드대로).

- [ ] **Step 5: `registration_watchdog` → `run_watchdog` 3-phase 재작성**

`registration_watchdog`(coordinator.rs:1161)를 교체:

```rust
/// Per-run progress watchdog (3 phases). Phase 1 (registration) preserves the old
/// `registration_watchdog` behavior; Phases 2/3 add startup (A) and backstop (B)
/// liveness. All fail paths go through `fail_run_hung` (terminal-guarded).
async fn run_watchdog(
    coord: CoordinatorState,
    run_id: String,
    reg_deadline: CancellationToken,
    first_load: CancellationToken,
    done: CancellationToken,
    startup_grace: std::time::Duration,
    backstop_total: std::time::Duration,
) {
    // Phase 1: registration (unchanged behavior + new done arm).
    tokio::select! {
        _ = tokio::time::sleep(REGISTRATION_DEADLINE) => {
            coord.fail_incomplete_registration(&run_id).await;
            return;
        }
        _ = reg_deadline.cancelled() => {} // all registered → proceed
        _ = done.cancelled() => return,    // already terminal (e.g. dispatch failed)
    }
    let started = tokio::time::Instant::now();
    // Phase 2: startup (A) — first metric must arrive within startup_grace.
    tokio::select! {
        _ = tokio::time::sleep(startup_grace) => {
            let reason = format!(
                "worker registered but produced no load within {}s — the run appears stuck (no metrics received)",
                startup_grace.as_secs()
            );
            coord.fail_run_hung(&run_id, &reason, "no load produced (startup liveness)").await;
            return;
        }
        _ = first_load.cancelled() => {} // first metric → proceed
        _ = done.cancelled() => return,
    }
    // Phase 3: backstop (B) — terminal must arrive within backstop_total of start.
    let remaining = backstop_total.saturating_sub(started.elapsed());
    tokio::select! {
        _ = tokio::time::sleep(remaining) => {
            let reason = format!(
                "run exceeded its expected-duration budget ({}s, incl. grace) without reaching a terminal state — the run appears stuck",
                backstop_total.as_secs()
            );
            coord.fail_run_hung(&run_id, &reason, "exceeded expected duration (backstop)").await;
        }
        _ = done.cancelled() => {}
    }
}
```

> `REGISTRATION_DEADLINE`(coordinator.rs:38-40, `#[cfg(test)]` 200ms) 무변경. 테스트는 startup/backstop을 직접 주입하므로 Phase 1은 200ms로 빠르게 통과(전원 등록 시 reg_deadline cancel).

- [ ] **Step 6: `ingest_metrics`가 first_load cancel**

`ingest_metrics`(coordinator.rs:1450) 본문 **맨 앞**에 추가(기존 row 매핑 전):

```rust
    // First batch from this run's workers = the engine flusher produced output =
    // not hung at startup. Cancel first_load (idempotent — no-op after the first).
    // ~1-2 batches/sec/worker, so the per-batch runs lock is not contention.
    {
        let g = state.runs.lock().await;
        if let Some(rw) = g.get(&batch.run_id) {
            rw.first_load.cancel();
        }
    }
```

- [ ] **Step 7: finalize 사이트에서 `done` cancel**

`done`은 `RunWorkers`가 terminal로 갈 때마다 cancel한다. 아래 사이트에서 `rw.terminal = true`(또는 entry remove) 직후, 락을 잡고 있는 동안 `rw.done.cancel()` 호출(이미 entry를 들고 있으면 그 핸들로):

1. **`record_phase`**(coordinator.rs:838) — Completed/Aborted/Failed로 finalize하는 arm(터미널 set 사이트 ~870/879/885). 해당 `rw`에서 `rw.done.cancel()`.
2. **`worker_disconnected`**(~966, 비-terminal 단절 fail-fast로 `rw.terminal=true` 하는 지점). `rw.done.cancel()`.
3. **`fail_run_hung`**(Task 3) — `rw.terminal = true` 직후 같은 락 블록에서 `rw.done.cancel()` 추가(A/B 자기 자신이 done을 닫아 watchdog의 다른 phase가 중복 안 깨게; self-fire 후 return이라 무해하지만 일관).
4. **`cancel_dispatch_failed`**(coordinator.rs:1034) — 현재 `rw.reg_deadline.cancel()`(1038)을 **`rw.done.cancel()`로 교체**(§3.1: dispatch 실패는 "정지" 신호지 "진행" 신호가 아니다 — reg_deadline를 cancel하면 watchdog이 Phase 2로 *진행*해 grace만큼 lingering).

> 각 사이트는 이미 `runs` 락 + `rw`(get_mut/remove) 핸들을 들고 있다 — `rw.done.cancel()` 한 줄이면 된다(`done`은 `CancellationToken`, cancel은 `&self`). `cancel_dispatch_failed`는 `g.remove(run_id)`로 꺼낸 `rw`에서 `rw.done.cancel()`(remove 후에도 토큰 핸들 유효).

- [ ] **Step 8: `runs.rs`에 grace 헬퍼 + 테스트**

`crates/controller/src/api/runs.rs`는 **`pb` alias가 없다**(full path `handicap_proto::v1::` 사용). 먼저 파일 상단 모듈 import에 추가:

```rust
use handicap_proto::v1 as pb;
```

그 다음 순수 헬퍼 추가:

```rust
const STARTUP_MARGIN: u64 = 15;

/// Leading consecutive zero-load stages (delayed start): open-loop `stages` or
/// closed-loop `vu_stages` whose `target == 0`. Normal runs → 0.
pub(crate) fn leading_idle_secs(p: &pb::Profile) -> u64 {
    let lead = if !p.vu_stages.is_empty() {
        &p.vu_stages
    } else {
        &p.stages
    };
    lead.iter()
        .take_while(|s| s.target == 0)
        .map(|s| u64::from(s.duration_seconds))
        .sum()
}

/// Effective startup grace: at least the CLI floor, but never below the run's
/// HTTP timeout + margin (a black-hole SUT emits its first error-metric only
/// after the timeout), plus any leading idle stages. Mirrors worker's 0→30 fallback.
pub(crate) fn startup_grace_eff(p: &pb::Profile, startup_floor: std::time::Duration) -> std::time::Duration {
    let http_to = if p.http_timeout_seconds == 0 { 30 } else { p.http_timeout_seconds } as u64;
    let floor = startup_floor.max(std::time::Duration::from_secs(http_to + STARTUP_MARGIN));
    floor + std::time::Duration::from_secs(leading_idle_secs(p))
}
```

테스트(`runs.rs`의 `#[cfg(test)] mod tests`):

```rust
#[test]
fn leading_idle_only_counts_leading_zeros() {
    let z = |t: u32, d: u32| pb::Stage { target: t, duration_seconds: d };
    let p = pb::Profile { stages: vec![z(0, 5), z(0, 3), z(100, 10), z(0, 2)], ..Default::default() };
    assert_eq!(super::leading_idle_secs(&p), 8); // 선두 0,0 만, 중간 0은 제외
}

#[test]
fn startup_grace_floor_respects_http_timeout_and_idle() {
    // floor 90s vs http_timeout 600 + margin 15 = 615 → 615 채택, + leading idle 0
    let p = pb::Profile { http_timeout_seconds: 600, ..Default::default() };
    assert_eq!(
        super::startup_grace_eff(&p, std::time::Duration::from_secs(90)),
        std::time::Duration::from_secs(615)
    );
    // http_timeout 작으면(30) floor 90 채택 + leading idle 20
    let p2 = pb::Profile { http_timeout_seconds: 30, stages: vec![pb::Stage { target: 0, duration_seconds: 20 }, pb::Stage { target: 50, duration_seconds: 10 }], ..Default::default() };
    assert_eq!(
        super::startup_grace_eff(&p2, std::time::Duration::from_secs(90)),
        std::time::Duration::from_secs(90 + 20)
    );
}
```

- [ ] **Step 9: `spawn_run`이 grace 계산 → 3 enqueue 사이트 전달**

`spawn_run`(runs.rs)에서 proto `assignment`(또는 dispatch용 proto Profile)이 만들어진 직후, **`assignment`/`base`가 `enqueue`로 move 되기 전에** grace를 계산:

```rust
    let (startup_floor, backstop_grace) = state.coord.watchdog_grace_config();
    let startup_grace = startup_grace_eff(&assignment.profile, startup_floor);
    let backstop_total =
        std::time::Duration::from_secs(handicap_proto::run_duration_secs(&assignment.profile)) + backstop_grace;
```

그리고 **3개 production enqueue 호출 사이트 전부**(pool capacity-aware · pool legacy · non-pool)에 `, startup_grace, backstop_total`을 추가. `assignment.profile` 필드 경로는 실제 코드에 맞춘다(proto Profile을 들고 있는 변수). 만약 enqueue가 `base`(PendingAssignment)만 받고 proto Profile은 다른 변수라면, 그 proto Profile에서 계산한다(spawn_run은 dispatch용 proto Profile을 이미 만든다).

> 컴파일러가 3개 production 사이트 + 모든 test 사이트를 "인자 수 부족"으로 전부 짚어준다(Step 10).

- [ ] **Step 10: 나머지 모든 `enqueue` 호출 사이트 갱신 (long grace)**

`cargo build -p handicap-controller --tests 2>&1`로 남은 `enqueue` 호출 사이트를 전부 찾아 `, LONG, LONG`을 추가한다. **모든 test enqueue 사이트(~26개)는 `coordinator.rs`의 `mod tests` 안**(`LONG`/`TINY` 상수가 그 모듈에 정의됨)이라 전부 `LONG`을 쓴다 — `tests/*.rs`나 다른 크레이트에서 `enqueue`를 직접 호출하는 곳은 **없다**(production 3개는 Step 9의 runs.rs `spawn_run`). A/B를 *의도적으로* 테스트하는 Step 1의 4개만 `TINY`(해당 phase) + long(다른 phase)을 쓰고, **나머지는 전부 `LONG, LONG`**(기존 동작 보존 — A/B 미발동). Task 3 Step 1의 `fail_run_hung` 테스트 enqueue 호출에도 `LONG, LONG` 추가.

> 컴파일러가 arity 불일치로 모든 사이트를 짚어준다(전부 in-crate, 2 파일: coordinator.rs 테스트 + runs.rs production). healthy run은 long grace라 절대 A/B에 안 걸린다.

- [ ] **Step 11: 전체 테스트 통과 확인**

Run: `cargo build -p handicap-worker && cargo test -p handicap-controller 2>&1 | tail -30`
Expected: PASS — 신규 4 A/B 테스트 + 헬퍼 테스트 + 기존 전부.

> `cargo build -p handicap-worker`를 먼저 돌려 e2e 워커 바이너리를 워밍(루트 CLAUDE.md cold-build flake).

- [ ] **Step 12: 전체 게이트**

Run: `cargo clippy --workspace --all-targets -- -D warnings 2>&1 | tail -20 && cargo nextest run --workspace 2>&1 | tail -20`
Expected: 0 경고, 전 테스트 pass.

- [ ] **Step 13: 커밋**

```bash
git add crates/controller/src/grpc/coordinator.rs crates/controller/src/api/runs.rs
git commit -m "feat(controller): 3-phase run_watchdog (startup-A + backstop-B liveness, G1a Task 4)"
git log -1 --oneline
```

---

## 구현 후 (별도 단계 — plan 범위 밖)

- **최종 리뷰**: `handicap-reviewer`(크로스커팅·wire 1:1·repo 함정) APPROVE. `finish-slice` §0 보안 게이트는 path-gate(요청실행/템플릿/바인딩/업로드/trace) — 본 diff는 무관이라 N/A 예상(grep로 확인).
- **라이브 검증(필수)**: spec §6 — **subprocess 모드 + `kill -STOP`**, 짧은 flag(`--run-startup-grace-seconds 5 --run-backstop-grace-seconds 3`). 첫 메트릭 전 STOP → ~5s A Failed("no metrics"); 메트릭 후 STOP → backstop B Failed("exceeded"); STOP 없는 정상 run → completed, 오발동 0. (L6 하트비트는 pool-only라 subprocess 무간섭; h2-keepalive ~20s 전에 발동하도록 짧은 flag.)
- **마무리**: `finish-slice` — build-log·roadmap(§B3 G1 완료, G1b/B2 연기 명시)·root 상태줄·메모리.

---

## Self-Review (작성자 체크)

- **Spec 커버리지**: R1=Task4 run_watchdog Phase2(A)+fail_run_hung; R2=Phase3(B); R3=Phase1 무변경; R4=Task4 Step6 ingest first_load; R5=Task4 Step7 finalize done; R6=Task3 fail_run_hung; R7=Task1 proto 추출; R8=Task4 Step8/9 헬퍼+spawn_run; R9=Task2 CLI/OnceLock + 실타이머 단위(Task4 Step1); R10=Task4 Step10 enqueue arity 전site; R11=Task4 Step10 long-grace로 healthy byte-identical. **전 요구사항 task 매핑됨.**
- **Placeholder 스캔**: 모든 step에 실제 코드/명령/기대출력. "적절히 처리" 류 없음.
- **타입 일관성**: `run_duration_secs`(proto)·`watchdog_grace_config`→`(Duration,Duration)`·`fail_run_hung(run_id,reason,abort_msg)`·`enqueue(...,startup_grace:Duration,backstop_total:Duration)`·`leading_idle_secs`/`startup_grace_eff` — Task 간 시그니처 일치.

<!-- REVIEW-GATE: APPROVED -->
