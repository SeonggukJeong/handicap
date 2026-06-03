# S-B think time Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** closed-loop 부하에 반복 사이(run-level Profile) + 스텝 직후(per-step HttpStep) think time 지연을 넣고, 사용자 선택 시드(`think_seed`)로 재현성을 옵션화하며, test-run 미리보기에 페이싱 opt-in 토글을 단다.

**Architecture:** S-A(타임아웃)가 확립한 7-layer 배선(Profile→proto→RunPlan→engine / HttpStep YAML→engine / UI Zod)을 그대로 재사용. think time은 인터프리터(`runner::execute_steps`/`trace::trace_steps`) 레이어의 cancellable·deadline-clamped sleep — executor(`execute_step`)는 무변경(byte-identical). 미지정 시 sleep 0 = byte-identical, 마이그레이션 0건(profile_json + YAML `serde default`).

**Tech Stack:** Rust (engine/controller/worker/proto, tokio, rand 0.8, serde, prost/tonic) + TypeScript/React (Zod, vitest, React Query).

**Spec:** `docs/superpowers/specs/2026-06-03-load-model-pacing-s-b-think-time-design.md` (spec-plan-reviewer APPROVED-WITH-CHANGES, B1/B2/B3/S1-4/N1 반영됨).

---

## 실행 제약 (모든 task 공통 — subagent 프롬프트에 박을 것)

1. **task = 단일 green 커밋**. pre-commit 훅이 비-`.md` 커밋마다 `cargo fmt/clippy(-D warnings)/test --workspace` 전체를 돈다. 그래서 ① 미사용 헬퍼만(dead_code) ② RED 테스트만 — 둘 다 커밋 불가. 로컬에서 RED→GREEN을 확인하되 **테스트+구현+배선을 하나의 green 커밋으로 fold**. (엔진 라이브러리의 `pub`/`pub(crate)` 신규 심볼은 `lib.rs` re-export 시 public API라 dead_code 아님 — 단 같은 커밋에서 쓰여야 안전.)
2. **TDD 가드** (`.claude/hooks/tdd-guard.sh`): src 편집 전 작업트리에 pending test-path 파일(`tests/*.rs`·`*.test.tsx`…)이 있어야 한다. **새 src 파일**(예 `pacing.rs`)은 그 전에 `tests/*.rs`를 먼저 만들어 unblock. 기존 src에 이미 `#[cfg(test)]`가 디스크에 있으면 자동 통과. 각 task의 Step 1은 항상 **테스트 먼저**.
3. **커밋은 단일 FOREGROUND blocking 호출**(`run_in_background:false`, timeout 600000ms), **폴링 금지**(implementer 턴 truncate 방지). 파이프(`| tail`) 금지(exit code 마스킹) — 커밋 직후 `git log -1 --oneline`로 landed 확인.
4. **cold-build flake**: 엔진/워커 변경 커밋 전 `cargo build -p handicap-worker && cargo build --workspace`로 warm한 뒤 커밋. e2e flake나면 동일 커밋 warm 재시도(진짜 회귀 아님).
5. **UI task는 cargo 훅이 UI를 안 본다** — 커밋 전 `cd ui && pnpm lint && pnpm test && pnpm build`(`pnpm lint`=`--max-warnings=0`) 수동 실행. `tsc -b`(=`pnpm build`)가 최종 게이트.
6. **prost/RunPlan exhaustive**: proto·RunPlan·TraceOptions 필드 추가 시 `grep -rn "<Type> {" crates/`로 리터럴 전부 갱신(spread 안 통함). 컴파일 에러로 즉시 드러나니 grep 후 일괄.

---

## File Structure

| 파일 | 책임 | task |
|---|---|---|
| `crates/engine/src/pacing.rs` (신규) | `ThinkTime`·`sample`(generic rng)·`pace`·`PaceOutcome` | T1 |
| `crates/engine/src/lib.rs` | `pacing` 모듈 + `ThinkTime`/`pace`/`PaceOutcome` re-export | T1 |
| `crates/engine/src/dataset.rs` | `mix` private→`pub(crate)` (시드 공유) | T3 |
| `crates/engine/src/scenario.rs` | `HttpStep.think_time` | T2 |
| `crates/engine/src/runner.rs` | `RunPlan` 2필드 + run_vu RNG/run-level pace + execute_steps rng/per-step pace | T3·T4 |
| `crates/engine/src/trace.rs` | `TraceOptions.apply_think_time` + trace_steps per-step sleep | T5 |
| `crates/proto/proto/coordinator.proto` | `ThinkTime` 메시지 + `Profile` 2필드 | T7 |
| `crates/controller/src/store/runs.rs` | `Profile` 2필드 | T7 |
| `crates/controller/src/api/runs.rs` | validate 범위 + proto 매핑 | T7 |
| `crates/controller/src/api/test_runs.rs` | `TestRunRequest.apply_think_time` → TraceOptions | T5 |
| `crates/worker/src/main.rs` | proto Profile → RunPlan think_time/think_seed | T7 |
| `ui/src/scenario/model.ts` | `ThinkTimeModel` + `HttpStepModel.think_time` | T6 |
| `ui/src/scenario/yamlDoc.ts` | `normalizeStep` think_time 읽기 패스스루 | T6 |
| `ui/src/api/{schemas,client,hooks}.ts` | profile think_time/think_seed + test-run apply_think_time | T8·T10 |
| `ui/src/components/RunDialog.tsx` | run-level Pacing 접이식 섹션 | T8 |
| `ui/src/components/scenario/Inspector.tsx` | per-step think time 입력 | T9 |
| `ui/src/components/scenario/TestRunSection.tsx` | apply_think_time 토글 | T10 |

순서: T1(pacing) → T2(HttpStep 필드) → T3(run-level engine) → T4(per-step engine) → T5(trace+test_runs backend) → T6(UI model) → T7(proto/controller/worker run-level wire) → T8(RunDialog) → T9(Inspector) → T10(TestRunSection).

> **참고**: T7(proto wire)이 T6 뒤인 이유 — T1~T5는 엔진/trace를 자급 테스트로 완성하고, T6~T10 UI 중 T8(RunDialog)이 run-level wire(T7)에 의존한다. T7을 T8 직전에 두면 "엔진 완성 → UI model → run-level 전체 와이어 → RunDialog 소비" 흐름이 자연스럽다. T7 전까지 run-level think_time은 worker에서 `None`(T3에서 리터럴 None) — 엔진 테스트가 동작을 증명, UI/REST 도달은 T7부터.

---

## Task 1: engine `pacing.rs` — ThinkTime + sample + pace

**Files:**
- Create: `crates/engine/src/pacing.rs`
- Modify: `crates/engine/src/lib.rs`
- Test: `crates/engine/tests/pacing.rs` (신규, TDD 가드 unblock + 동작 검증)

- [ ] **Step 1: Write the failing test** — `crates/engine/tests/pacing.rs`

```rust
use std::time::Duration;
use handicap_engine::{PaceOutcome, ThinkTime, pace};
use rand::SeedableRng;
use rand::rngs::StdRng;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

#[test]
fn sample_fixed_when_min_eq_max() {
    let tt = ThinkTime { min_ms: 250, max_ms: 250 };
    let mut rng = StdRng::seed_from_u64(1);
    assert_eq!(tt.sample(&mut rng), Duration::from_millis(250));
}

#[test]
fn sample_in_range_inclusive() {
    let tt = ThinkTime { min_ms: 100, max_ms: 200 };
    let mut rng = StdRng::seed_from_u64(7);
    for _ in 0..200 {
        let d = tt.sample(&mut rng).as_millis() as u32;
        assert!((100..=200).contains(&d), "sample {d} out of [100,200]");
    }
}

#[test]
fn sample_reproducible_for_same_seed() {
    let tt = ThinkTime { min_ms: 0, max_ms: 1000 };
    let seq = |seed| {
        let mut rng = StdRng::seed_from_u64(seed);
        (0..5).map(|_| tt.sample(&mut rng).as_millis()).collect::<Vec<_>>()
    };
    assert_eq!(seq(42), seq(42));
    assert_ne!(seq(42), seq(43));
}

#[test]
fn sample_clamps_inverted_range() {
    // lenient: max < min → behaves as fixed min (run must not die).
    let tt = ThinkTime { min_ms: 300, max_ms: 100 };
    let mut rng = StdRng::seed_from_u64(1);
    assert_eq!(tt.sample(&mut rng), Duration::from_millis(300));
}

#[tokio::test(start_paused = true)]
async fn pace_sleeps_full_duration_when_within_window() {
    let cancel = CancellationToken::new();
    let deadline = Instant::now() + Duration::from_secs(60);
    let start = Instant::now();
    let out = pace(Duration::from_millis(500), deadline.into_std(), &cancel).await;
    assert!(matches!(out, PaceOutcome::Slept));
    assert_eq!(start.elapsed(), Duration::from_millis(500));
}

#[tokio::test(start_paused = true)]
async fn pace_returns_cancelled_immediately_on_cancel() {
    let cancel = CancellationToken::new();
    cancel.cancel();
    let deadline = Instant::now() + Duration::from_secs(60);
    let out = pace(Duration::from_secs(10), deadline.into_std(), &cancel).await;
    assert!(matches!(out, PaceOutcome::Cancelled));
}

#[tokio::test(start_paused = true)]
async fn pace_clamps_to_deadline() {
    let cancel = CancellationToken::new();
    let deadline = Instant::now() + Duration::from_millis(100);
    let out = pace(Duration::from_secs(10), deadline.into_std(), &cancel).await;
    assert!(matches!(out, PaceOutcome::DeadlineReached));
}
```

> 주의: `pace`는 `std::time::Instant` deadline을 받는다(`runner.rs`가 `std` Instant 사용). tokio `start_paused` 테스트에서 tokio `Instant`를 `.into_std()`로 변환해 넘긴다. `pace` 내부의 `tokio::time::sleep`은 paused 시계에서 즉시 advance된다.

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p handicap-engine --test pacing`
Expected: FAIL — `unresolved import handicap_engine::{PaceOutcome, ThinkTime, pace}`.

- [ ] **Step 3: Write `crates/engine/src/pacing.rs`**

```rust
//! Think time (요청/반복 간 페이싱) for closed-loop runs. The delay is applied by
//! the interpreter (`runner::execute_steps` / `trace::trace_steps`), NOT by the
//! executor — `execute_step` stays byte-identical. Absent → no sleep.

use std::time::{Duration, Instant};

use rand::Rng;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

/// Per-iteration (Profile) or per-step (HttpStep) delay. `min_ms == max_ms` → a
/// fixed delay; `min_ms < max_ms` → uniform random in `[min_ms, max_ms]` (both
/// ends inclusive).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThinkTime {
    pub min_ms: u32,
    pub max_ms: u32,
}

impl ThinkTime {
    /// Draw one delay. Generic over the RNG so the load path passes a seeded
    /// `StdRng` and the trace path passes `thread_rng()`. Lenient: if `max < min`
    /// (should be blocked by validation) it clamps to a fixed `min` — never panics.
    pub fn sample<R: Rng + ?Sized>(&self, rng: &mut R) -> Duration {
        let max = self.max_ms.max(self.min_ms);
        let ms = if max == self.min_ms {
            self.min_ms
        } else {
            rng.gen_range(self.min_ms..=max)
        };
        Duration::from_millis(u64::from(ms))
    }
}

/// Result of a paced sleep.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PaceOutcome {
    /// Slept the requested duration (or 0) within the window.
    Slept,
    /// `cancel` fired during the sleep — caller should abort.
    Cancelled,
    /// The run deadline was hit (sleep clamped) — caller should end the iteration.
    DeadlineReached,
}

/// Sleep `dur`, racing `cancel` and clamping to `deadline` so think time never
/// hangs past the run window or an abort. Mirrors the ramp loop's
/// `tokio::select! { sleep, cancel }` (runner.rs).
pub async fn pace(dur: Duration, deadline: Instant, cancel: &CancellationToken) -> PaceOutcome {
    let now = Instant::now();
    if now >= deadline {
        return PaceOutcome::DeadlineReached;
    }
    let remaining = deadline - now;
    let capped = dur.min(remaining);
    if capped.is_zero() {
        return PaceOutcome::Slept;
    }
    tokio::select! {
        _ = tokio::time::sleep(capped) => {
            if dur > remaining { PaceOutcome::DeadlineReached } else { PaceOutcome::Slept }
        }
        _ = cancel.cancelled() => PaceOutcome::Cancelled,
    }
}
```

- [ ] **Step 4: Re-export in `crates/engine/src/lib.rs`**

`lib.rs`의 모듈 선언부에 `mod pacing;`(또는 기존 컨벤션대로 `pub mod`), public 재export 줄에 추가:
```rust
pub use pacing::{PaceOutcome, ThinkTime, pace};
```
(기존 `pub use` 사이트를 grep: `grep -n "pub use" crates/engine/src/lib.rs` 후 `dataset`/`scenario` re-export 옆에 추가.)

- [ ] **Step 5: Run test to verify it passes**

Run: `cargo test -p handicap-engine --test pacing`
Expected: PASS (7 tests). 이어서 `cargo clippy -p handicap-engine --all-targets -- -D warnings` PASS.

- [ ] **Step 6: Commit** (FOREGROUND, no poll)

```bash
cargo build -p handicap-worker && cargo build --workspace
git add crates/engine/src/pacing.rs crates/engine/src/lib.rs crates/engine/tests/pacing.rs
git commit -m "feat(engine): pacing.rs ThinkTime + sample(generic rng) + pace(cancel/deadline)"
git log -1 --oneline
```

---

## Task 2: engine `HttpStep.think_time` (per-step, YAML round-trip)

**Files:**
- Modify: `crates/engine/src/scenario.rs:67-80` (HttpStep struct), 그리고 모든 `HttpStep {` 리터럴 사이트
- Test: `crates/engine/src/scenario.rs` 인라인 `#[cfg(test)]` (이미 디스크에 존재 → 가드 자동 통과)

- [ ] **Step 1: Write the failing round-trip test** — `scenario.rs` 인라인 tests에 추가 (기존 `http_step_timeout_seconds_round_trips_and_omits_when_absent`(:1072) 바로 아래, 같은 패턴)

```rust
#[test]
fn http_step_think_time_round_trips_and_omits_when_absent() {
    let yaml = r#"
version: 1
name: t
steps:
  - type: http
    id: s1
    name: pace
    request:
      method: GET
      url: http://x/
    think_time:
      min_ms: 100
      max_ms: 500
"#;
    let s = Scenario::from_yaml(yaml).unwrap();
    let Step::Http(h) = &s.steps[0] else { panic!("expected http") };
    assert_eq!(h.think_time, Some(ThinkTime { min_ms: 100, max_ms: 500 }));
    let out = s.to_yaml().unwrap();
    assert!(out.contains("min_ms: 100"), "round-trips:\n{out}");

    // absent → no key (byte-identical to pre-feature YAML)
    let yaml2 = r#"
version: 1
name: t
steps:
  - type: http
    id: s2
    name: nopace
    request:
      method: GET
      url: http://x/
"#;
    let s2 = Scenario::from_yaml(yaml2).unwrap();
    let Step::Http(h2) = &s2.steps[0] else { panic!() };
    assert_eq!(h2.think_time, None);
    assert!(!s2.to_yaml().unwrap().contains("think_time"));
}
```

> `ThinkTime`는 `crate::pacing::ThinkTime` (또는 `crate::ThinkTime`). scenario.rs `use` 상단에 `use crate::pacing::ThinkTime;` 추가. 인라인 tests의 `use super::*;`로 노출되면 추가 import 불필요할 수 있음 — 컴파일 에러 시 명시 import.

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p handicap-engine --lib scenario::tests::http_step_think_time`
Expected: FAIL — `no field think_time on type HttpStep`.

- [ ] **Step 3: Add the field** — `scenario.rs` HttpStep struct(`timeout_seconds` 아래)

```rust
    /// Per-step think time: pause AFTER this step's request runs (every time the
    /// step executes — per loop repeat, per chosen if-branch). Absent → no pause.
    /// Randomness uses the run-level `Profile.think_seed` (RNG threaded by the
    /// interpreter). Authoring-validated (min<=max<=600000) UI-side; engine lenient.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub think_time: Option<ThinkTime>,
```
`scenario.rs` 상단 import에 `use crate::pacing::ThinkTime;` 추가.

- [ ] **Step 4: Fix all `HttpStep {` literal sites**

Run: `grep -rn "HttpStep {" crates/` — 각 리터럴에 `think_time: None,` 추가(없으면 컴파일 에러). 실제 사이트: **`crates/engine/src/executor.rs` 테스트 10개 + `crates/engine/tests/proptests.rs:73`(`timeout_seconds: None`(:85) 옆에)**. scenario.rs 인라인 테스트는 `from_yaml`(YAML 문자열)로 빌드 → 리터럴 없음; runner.rs/trace.rs 통합 테스트엔 HttpStep 리터럴 없음. (S-A `timeout_seconds`·B4 `disabled` 추가 때와 동일 사이트군.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test -p handicap-engine --lib scenario` then `cargo test -p handicap-engine` then `cargo clippy -p handicap-engine --all-targets -- -D warnings`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cargo build -p handicap-worker && cargo build --workspace
git add crates/engine/src/scenario.rs $(git diff --name-only | tr '\n' ' ')
git commit -m "feat(engine): HttpStep.think_time per-step pacing field (YAML round-trip, skip-when-absent)"
git log -1 --oneline
```
> `git add`는 명시 경로로(절대 `-A` 금지). 위 `$(git diff --name-only)`는 HttpStep 리터럴이 바뀐 테스트 파일들을 포함 — 출력 확인 후 add.

---

## Task 3: engine run-level think time (RunPlan + run_vu)

**Files:**
- Modify: `crates/engine/src/runner.rs` (RunPlan struct :20-34, run_scenario spawn :60·117, run_vu :229-280), `crates/engine/src/dataset.rs:74` (`mix` → `pub(crate)`), 모든 `RunPlan {` **리터럴 24사이트**(엔진 테스트 11파일 + worker `src/main.rs:181` + worker `tests/abort_and_env.rs:47·69` — `grep`은 25 매치지만 1개는 struct def `runner.rs:20`)
- Test: `crates/engine/tests/think_time.rs` (신규)

- [ ] **Step 1: Write the failing test** — `crates/engine/tests/think_time.rs`

```rust
// run-level think time: with a fixed inter-iteration delay, fewer iterations run
// in a fixed window than with no delay. Uses a stub HTTP target.
use std::sync::Arc;
use std::time::Duration;
use handicap_engine::{MetricFlush, RunPlan, Scenario, ThinkTime, run_scenario};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use wiremock::matchers::method;
use wiremock::{Mock, MockServer, ResponseTemplate};

async fn count_requests(plan_think: Option<ThinkTime>, dur_ms: u64) -> u64 {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;
    let yaml = format!(
        "version: 1\nname: t\nsteps:\n  - type: http\n    id: s\n    name: s\n    request:\n      method: GET\n      url: {}/\n",
        server.uri()
    );
    let scenario = Arc::new(Scenario::from_yaml(&yaml).unwrap());
    let plan = RunPlan {
        vus: 1,
        ramp_up: Duration::from_secs(0),
        duration: Duration::from_millis(dur_ms),
        env: Default::default(),
        loop_breakdown_cap: 0,
        vu_offset: 0,
        data_binding: None,
        http_timeout: Duration::from_secs(30),
        think_time: plan_think,
        think_seed: None,
    };
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(64);
    let cancel = CancellationToken::new();
    let h = tokio::spawn(run_scenario(scenario, plan, tx, cancel));
    let mut total = 0u64;
    while let Some(f) = rx.recv().await {
        for w in f.windows {
            if w.step_id == "s" {
                total += w.count;
            }
        }
    }
    h.await.unwrap().unwrap();
    total
}

#[tokio::test]
async fn run_level_think_time_reduces_iterations() {
    // No think time: many iterations against a localhost stub in ~600ms.
    let none = count_requests(None, 600).await;
    // 200ms inter-iteration pause: far fewer (~3-4) in the same window.
    let paced = count_requests(Some(ThinkTime { min_ms: 200, max_ms: 200 }), 600).await;
    assert!(none > paced, "expected fewer paced iterations: none={none} paced={paced}");
    assert!(paced >= 1, "at least one iteration must run");
}
```

> 이 테스트는 실시계(`#[tokio::test]`, paused 아님)라 약간의 환경 의존이 있으나 `none > paced`는 200ms pause 효과가 압도적이라 안정적. (정밀 카운트가 아니라 부등식만 단언 — ramp-up 함정 §테스트 정책과 정합.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p handicap-engine --test think_time`
Expected: FAIL — `RunPlan` has no field `think_time`/`think_seed`.

- [ ] **Step 3: Add RunPlan fields** — `runner.rs` RunPlan struct (`http_timeout` 아래)

```rust
    /// Inter-iteration think time (run-level pacing). `None` → no pause.
    pub think_time: Option<ThinkTime>,
    /// Think time RNG seed. `Some` → reproducible per (seed, vu_id); `None` → entropy.
    pub think_seed: Option<u32>,
```
`runner.rs` 상단 import: `use crate::pacing::{PaceOutcome, ThinkTime, pace};` + `use rand::SeedableRng; use rand::rngs::StdRng;`.

- [ ] **Step 4: Expose `mix` for seed reuse** — `dataset.rs:74`

```rust
pub(crate) fn mix(seed: u32, vu_id: u32, iter_id: u32) -> u64 {
```
(앞에 `pub(crate)`만 추가. `splitmix64`는 `mix` 내부 전용이라 그대로 private.)

- [ ] **Step 5: Thread fields into run_scenario spawn + run_vu**

`run_scenario`에서 `let http_timeout = plan.http_timeout;`(:60) 옆에:
```rust
let think_time = plan.think_time;
let think_seed = plan.think_seed;
```
run_vu spawn 호출(:104-118 부근, `http_timeout,`을 넘기는 자리)에 `think_time,`/`think_seed,` 추가.

`run_vu` 시그니처에 파라미터 추가(`http_timeout: Duration,` 아래):
```rust
    think_time: Option<ThinkTime>,
    think_seed: Option<u32>,
```
`run_vu` 본문에서 client 생성 직후 RNG 생성:
```rust
    let mut think_rng = match think_seed {
        Some(s) => StdRng::seed_from_u64(crate::dataset::mix(s, vu_id, 0)),
        None => StdRng::from_entropy(),
    };
```
반복 루프의 `match flow { ... }` 직후 (iter_id 증가 전)에 run-level pace:
```rust
        match flow {
            StepFlow::Continue => {}
            StepFlow::DeadlineReached => return Ok(()),
            StepFlow::Aborted => return Err(EngineError::Aborted),
        }
        // run-level think time between iterations
        if let Some(tt) = think_time {
            if pace(tt.sample(&mut think_rng), deadline, &cancel).await == PaceOutcome::Cancelled {
                return Err(EngineError::Aborted);
            }
        }
        iter_id = iter_id.wrapping_add(1);
```
> per-step pace(execute_steps)는 T4. T3에선 execute_steps에 rng를 아직 안 넘긴다 — run-level만. (단, `think_rng`는 T4에서 execute_steps로 넘길 것이므로 T3에서 `let mut`로 둔다. T3 단독에선 execute_steps 호출이 rng를 안 받아 `think_rng`가 run-level pace에서만 쓰임 = 사용됨, dead 아님.)

- [ ] **Step 6: Fix all `RunPlan {` literals**

Run: `grep -rn "RunPlan {" crates/` (25 매치 = 24 리터럴 + struct def). 각 **리터럴**에 `think_time: None, think_seed: None,` 추가. 사이트: 엔진 테스트 11파일 전부 + **worker `crates/worker/src/main.rs:181`**(지금은 `None`, proto wire는 T7) + **worker `crates/worker/tests/abort_and_env.rs:47·69`**(2개 — 이 테스트 파일이 git add 글로브에 빠지기 쉬움, Step 8 주의).
> 대안(택1): `RunPlan`에 `#[derive(Default)]`가 가능하면(모든 필드 Default 가능 — `Option`/`Duration`/`BTreeMap`/`u32` 전부 OK) 추가 후 테스트 리터럴을 `..Default::default()`로 줄일 수 있으나, 기존 25 리터럴이 spread를 안 쓰므로 **2필드 명시가 변경 최소**. Default 추가는 별도 정리로 미룸.

- [ ] **Step 7: Run tests**

Run: `cargo test -p handicap-engine --test think_time` then `cargo test -p handicap-engine` then `cargo clippy -p handicap-engine --all-targets -- -D warnings` then `cargo build --workspace`
Expected: PASS. (`from_entropy`가 `getrandom`을 요구 — rand std 기본 feature라 가용. 안 되면 `cargo tree -p handicap-engine -i rand`로 feature 확인.)

- [ ] **Step 8: Commit**

```bash
cargo build -p handicap-worker && cargo build --workspace
# worker/tests/abort_and_env.rs 가 글로브에 포함되도록 (engine|worker) 둘 다 — 빠지면 commit 누락 → 다음 task dirty
git add crates/engine/src/runner.rs crates/engine/src/dataset.rs crates/engine/tests/think_time.rs crates/worker/src/main.rs crates/worker/tests/abort_and_env.rs $(git diff --name-only | grep -E 'crates/(engine|worker)/tests/' | tr '\n' ' ')
git status --porcelain   # 확인: 모든 RunPlan 리터럴 파일이 staged인지 (Changes not staged 비어야 함)
git commit -m "feat(engine): RunPlan think_time/think_seed + run_vu inter-iteration pacing (per-VU seeded RNG)"
git log -1 --oneline
```

---

## Task 4: engine per-step think time (execute_steps)

**Files:**
- Modify: `crates/engine/src/runner.rs` (execute_steps :296-, Http arm :316-334, loop 재귀 :343, if 재귀 :386, run_vu의 execute_steps 호출 :259)
- Test: `crates/engine/tests/think_time.rs` (T3 파일에 추가)

- [ ] **Step 1: Add failing per-step test** — `think_time.rs`에 추가

```rust
// per-step think time fires after the step's request, every execution. With a
// fixed per-step delay, fewer total requests fit the window than without.
#[tokio::test]
async fn per_step_think_time_reduces_requests() {
    async fn count(per_step_ms: Option<u32>, dur_ms: u64) -> u64 {
        let server = MockServer::start().await;
        Mock::given(method("GET")).respond_with(ResponseTemplate::new(200)).mount(&server).await;
        let tt = per_step_ms
            .map(|m| format!("\n    think_time:\n      min_ms: {m}\n      max_ms: {m}"))
            .unwrap_or_default();
        let yaml = format!(
            "version: 1\nname: t\nsteps:\n  - type: http\n    id: s\n    name: s\n    request:\n      method: GET\n      url: {}/{}\n",
            server.uri(), tt
        );
        let scenario = Arc::new(Scenario::from_yaml(&yaml).unwrap());
        let plan = RunPlan {
            vus: 1, ramp_up: Duration::from_secs(0), duration: Duration::from_millis(dur_ms),
            env: Default::default(), loop_breakdown_cap: 0, vu_offset: 0, data_binding: None,
            http_timeout: Duration::from_secs(30), think_time: None, think_seed: None,
        };
        let (tx, mut rx) = mpsc::channel::<MetricFlush>(64);
        let h = tokio::spawn(run_scenario(scenario, plan, tx, CancellationToken::new()));
        let mut total = 0u64;
        while let Some(f) = rx.recv().await { for w in f.windows { if w.step_id == "s" { total += w.count; } } }
        h.await.unwrap().unwrap();
        total
    }
    let none = count(None, 600).await;
    let paced = count(Some(200), 600).await;
    assert!(none > paced, "per-step pause should cut throughput: none={none} paced={paced}");
}
```

> YAML 들여쓰기 주의: `think_time`은 `request:`와 같은 레벨(스텝 항목의 자식). 위 format!의 `tt`는 `url:` 줄 뒤에 붙되 `request` 블록을 벗어나 `- type: http` 항목의 자식 레벨(4 spaces)로 들어가야 한다 — 헬퍼 문자열을 그대로 쓰면 정확. (실패 시 들여쓰기 재확인.)

- [ ] **Step 2: Run to verify fail**

Run: `cargo test -p handicap-engine --test think_time per_step`
Expected: FAIL — per-step think time 미구현이라 `none ≈ paced`(부등식 깨짐) 또는 컴파일 후 assert 실패.

- [ ] **Step 3: Add `rng` param to execute_steps + per-step pace**

`execute_steps` 시그니처 끝에 추가:
```rust
    rng: &mut StdRng,
```
Http arm(:316-334)의 record를 블록으로 감싸 guard를 await 전에 drop하고, 그 뒤 per-step pace:
```rust
            Step::Http(http) => {
                let ctx = TemplateContext {
                    vars: iter_vars,
                    env: env.as_ref(),
                    vu_id,
                    iter_id,
                    loop_index,
                };
                let outcome = execute_step(client, http, &ctx).await?;
                iter_vars.extend(outcome.extracted.clone());
                {
                    let mut a = agg.lock().await;
                    a.record(
                        &outcome.step_id,
                        outcome.latency.as_micros().min(u64::MAX as u128) as u64,
                        outcome.status,
                        outcome.error.is_some(),
                        loop_index,
                    );
                } // drop the aggregator guard before the (possibly long) think-time sleep
                if let Some(tt) = &http.think_time {
                    match pace(tt.sample(rng), deadline, cancel).await {
                        PaceOutcome::Slept => {}
                        PaceOutcome::Cancelled => return Ok(StepFlow::Aborted),
                        PaceOutcome::DeadlineReached => return Ok(StepFlow::DeadlineReached),
                    }
                }
            }
```

- [ ] **Step 4: Pass `rng` to all 3 recursion sites**

- run_vu의 `execute_steps(...)` 호출(:259)에 마지막 인자로 `&mut think_rng` 추가.
- loop arm 재귀 `Box::pin(execute_steps(...))`(:343)에 `rng` 추가.
- if arm 재귀 `Box::pin(execute_steps(...))`(:386)에 `rng` 추가.
> borrow: `iter_vars: &mut`와 `rng: &mut`는 서로 다른 객체 → 충돌 없음. loop arm은 `i in 0..repeat` 루프 안에서 매번 `rng`를 재차용(`&mut *rng` 자동 reborrow).

- [ ] **Step 5: Run tests**

Run: `cargo test -p handicap-engine` then `cargo clippy -p handicap-engine --all-targets -- -D warnings`
Expected: PASS (think_time.rs 2 tests + 기존 전부). 특히 기존 loop/if 통합 테스트가 회귀 없이 통과(per-step think_time 없는 시나리오 = byte-identical).

- [ ] **Step 6: Commit**

```bash
cargo build -p handicap-worker && cargo build --workspace
git add crates/engine/src/runner.rs crates/engine/tests/think_time.rs
git commit -m "feat(engine): per-step think time in execute_steps (after metric, all recursion sites, deadline/cancel-safe)"
git log -1 --oneline
```

---

## Task 5: backend test-run toggle (trace + test_runs)

**Files:**
- Modify: `crates/engine/src/trace.rs` (TraceOptions :14-21, trace_steps Http arm :213-), `crates/controller/src/api/test_runs.rs` (TestRunRequest :18-29, TraceOptions 빌드 :43-47)
- Test: `crates/engine/tests/trace_scenario.rs` (TraceOptions 리터럴 :9 갱신 + 새 테스트) + `crates/controller/tests/` (test-run handler 테스트가 있으면)

- [ ] **Step 1: Add failing trace test** — `crates/engine/tests/trace_scenario.rs`에 추가 (기존 TraceOptions 리터럴 패턴 재사용)

```rust
#[tokio::test]
async fn trace_does_not_sleep_when_apply_think_time_false() {
    let server = wiremock::MockServer::start().await;
    wiremock::Mock::given(wiremock::matchers::method("GET"))
        .respond_with(wiremock::ResponseTemplate::new(200))
        .mount(&server).await;
    let yaml = format!(
        "version: 1\nname: t\nsteps:\n  - type: http\n    id: s\n    name: s\n    request:\n      method: GET\n      url: {}/\n    think_time:\n      min_ms: 5000\n      max_ms: 5000\n",
        server.uri()
    );
    let scenario = handicap_engine::Scenario::from_yaml(&yaml).unwrap();
    let opts = handicap_engine::TraceOptions {
        env: Default::default(),
        max_requests: 50,
        max_wall: std::time::Duration::from_secs(120),
        apply_think_time: false,
    };
    let start = std::time::Instant::now();
    let trace = handicap_engine::trace_scenario(&scenario, &opts).await;
    assert!(trace.ok);
    assert!(start.elapsed() < std::time::Duration::from_secs(1), "must not sleep the 5s think time");
}

#[tokio::test]
async fn trace_sleeps_when_apply_think_time_true() {
    let server = wiremock::MockServer::start().await;
    wiremock::Mock::given(wiremock::matchers::method("GET"))
        .respond_with(wiremock::ResponseTemplate::new(200))
        .mount(&server).await;
    let yaml = format!(
        "version: 1\nname: t\nsteps:\n  - type: http\n    id: s\n    name: s\n    request:\n      method: GET\n      url: {}/\n    think_time:\n      min_ms: 300\n      max_ms: 300\n",
        server.uri()
    );
    let scenario = handicap_engine::Scenario::from_yaml(&yaml).unwrap();
    let opts = handicap_engine::TraceOptions {
        env: Default::default(), max_requests: 50,
        max_wall: std::time::Duration::from_secs(120), apply_think_time: true,
    };
    let start = std::time::Instant::now();
    handicap_engine::trace_scenario(&scenario, &opts).await;
    assert!(start.elapsed() >= std::time::Duration::from_millis(300), "should honor 300ms think time");
}
```

- [ ] **Step 2: Run to verify fail**

Run: `cargo test -p handicap-engine --test trace_scenario apply_think`
Expected: FAIL — `TraceOptions` has no field `apply_think_time`.

- [ ] **Step 3: Add `apply_think_time` to TraceOptions** — `trace.rs:14-21`

```rust
    /// Wall-clock ceiling; on reaching it the trace stops with `truncated = true`.
    pub max_wall: Duration,
    /// When true, the trace HONORS per-step `think_time` (actually sleeps) — for
    /// throttled previews (e.g. firewall). Default false = instant preview. Only
    /// per-step think time applies (single pass has no inter-iteration gap).
    pub apply_think_time: bool,
```

- [ ] **Step 4: Sleep in trace_steps Http arm** — after the `state.steps.push(StepTrace {...})` block in the `Step::Http` arm

```rust
                if opts.apply_think_time {
                    if let Some(tt) = &http.think_time {
                        let now = Instant::now();
                        if now < deadline {
                            let dur = tt.sample(&mut rand::thread_rng()).min(deadline - now);
                            tokio::time::sleep(dur).await;
                        }
                        if Instant::now() >= deadline {
                            state.truncated = true;
                        }
                    }
                }
```
> `rand::thread_rng()`는 await 전에 drop됨(`dur` 계산 후) → `Send` 안전. trace엔 cancel 토큰이 없어 deadline-clamp만(기존 truncation 경로 재사용). `Instant`/`Duration`은 trace.rs에 이미 import됨(:8, :92).

- [ ] **Step 5: Update the other TraceOptions literal** — `crates/controller/src/api/test_runs.rs:43-47`

```rust
    let opts = TraceOptions {
        env: body.env,
        max_requests: body.max_requests,
        max_wall: Duration::from_secs(WALL_CLOCK_CEILING_SECS),
        apply_think_time: body.apply_think_time,
    };
```
그리고 `TestRunRequest`에 필드 추가(:18-29, `runner` 위/아래):
```rust
    #[serde(default)]
    pub apply_think_time: bool,
```

- [ ] **Step 6: Run tests**

Run: `cargo test -p handicap-engine --test trace_scenario` then `cargo test -p handicap-controller` then `cargo clippy --workspace --all-targets -- -D warnings`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cargo build -p handicap-worker && cargo build --workspace
git add crates/engine/src/trace.rs crates/engine/tests/trace_scenario.rs crates/controller/src/api/test_runs.rs
git commit -m "feat(engine,controller): test-run apply_think_time toggle (trace honors per-step think time, opt-in)"
git log -1 --oneline
```

---

## Task 6: UI scenario model — ThinkTimeModel + HttpStepModel.think_time + yamlDoc passthrough

**Files:**
- Modify: `ui/src/scenario/model.ts` (HttpStepModel), `ui/src/scenario/yamlDoc.ts:458` (normalizeStep http passthrough)
- Test: `ui/src/scenario/__tests__/` 또는 기존 model/yamlDoc 테스트 파일 (round-trip)

- [ ] **Step 1: Write failing round-trip test** — 기존 yamlDoc round-trip 테스트 파일(예 `ui/src/scenario/__tests__/yamlDoc.test.ts`)에 추가, 또는 신규

```ts
import { describe, it, expect } from "vitest";
import { parseScenarioDoc, setStepField, /* 기존 헬퍼 */ } from "../yamlDoc";

it("per-step think_time survives set → serialize → parse → normalize (not write-only)", () => {
  // 기존 테스트의 시나리오 빌드 헬퍼를 재사용해 http 스텝 1개짜리 doc 생성.
  // 1) think_time을 set
  // 2) 직렬화된 YAML에 min_ms 포함 확인
  // 3) 재파싱 후 normalizeStep을 거친 model.steps[0].think_time === {min_ms,max_ms} 확인 (B2: 읽기 패스스루)
  // (정확한 헬퍼명은 기존 timeout_seconds round-trip 테스트를 grep해 그대로 모방:
  //  `grep -rn "timeout_seconds" ui/src/scenario/__tests__/`)
});
```
> 핵심: **set→serialize→parse→normalize 왕복**을 단언해야 B2(읽기 패스스루 누락=write-only)를 잡는다. 단방향(set→serialize만)은 버그를 통과시킨다. 기존 `timeout_seconds` round-trip 테스트가 있으면 그 구조를 복제.

- [ ] **Step 2: Run to verify fail**

Run: `cd ui && pnpm test -- yamlDoc`
Expected: FAIL — think_time이 normalize 후 떨어짐(또는 Zod 모델에 think_time 없음).

- [ ] **Step 3: Add ThinkTimeModel + HttpStepModel field** — `ui/src/scenario/model.ts`

`HttpStepModel` 정의 근처(`timeout_seconds` 필드 옆)에:
```ts
export const ThinkTimeModel = z
  .object({
    min_ms: z.number().int().min(0),
    max_ms: z.number().int().min(0),
  })
  .refine((t) => t.min_ms <= t.max_ms && t.max_ms <= 600_000, {
    message: "min_ms <= max_ms <= 600000",
  });
export type ThinkTime = z.infer<typeof ThinkTimeModel>;
```
`HttpStepModel`의 shape에 `think_time: ThinkTimeModel.optional()` 추가 (strict 게이트라 와이어 1:1). `Step`/`HttpStep` 타입 export가 자동 반영되는지 `tsc -b`로 확인.
> 주의(ui/CLAUDE.md Zod default 누출): `.optional()`만 — `.default()` 금지(중첩 default input 누출).

- [ ] **Step 4: Add yamlDoc normalizeStep passthrough** — `ui/src/scenario/yamlDoc.ts:458` (http return의 `...(src.timeout_seconds != null ...)` 줄 옆)

```ts
    ...(src.timeout_seconds != null ? { timeout_seconds: src.timeout_seconds } : {}),
    ...(src.think_time != null ? { think_time: src.think_time } : {}),
```
> 쓰기 경로(`setStepField(id, ["think_time"], {min_ms,max_ms})`)는 yamlDoc.ts:303-306 object→`createNode` 분기가 이미 처리 → 추가 불필요. 읽기만 누락 위험.

- [ ] **Step 5: Run tests + gates**

Run: `cd ui && pnpm test -- yamlDoc && pnpm lint && pnpm build`
Expected: PASS + `tsc -b` clean.

- [ ] **Step 6: Commit** (UI — cargo 훅도 돌지만 UI 게이트는 위에서 수동 확인)

```bash
cd /Users/sgj/develop/handicap
git add ui/src/scenario/model.ts ui/src/scenario/yamlDoc.ts ui/src/scenario/__tests__/
git commit -m "feat(ui): ThinkTimeModel + HttpStepModel.think_time + yamlDoc read passthrough (round-trip)"
git log -1 --oneline
```

---

## Task 7: proto + controller + worker run-level wire

**Files:**
- Modify: `crates/proto/proto/coordinator.proto` (ThinkTime 메시지 + Profile 6/7), `crates/controller/src/store/runs.rs:76-89` (Profile 2필드), `crates/controller/src/api/runs.rs` (validate :76·proto 매핑 :202), `crates/worker/src/main.rs:181-196` (proto→RunPlan), 모든 `pb::Profile {` (SF-2: api/runs.rs:202·coordinator.rs:951·proto test:13) + store `Profile {` (SF-1: store/runs.rs·presets.rs:194·report.rs:384·coordinator.rs:970·api/runs.rs:524·635)
- Test: 기존 controller round-trip/validate 테스트 + worker 매핑

- [ ] **Step 1: Write failing validate + round-trip tests** — `crates/controller/src/api/runs.rs` 인라인 tests (validate) + `store/runs.rs` 인라인 tests (profile_json round-trip)

```rust
// api/runs.rs tests — think_time range
#[tokio::test]
async fn validate_rejects_think_time_min_gt_max() {
    // build a Profile with think_time { min_ms: 500, max_ms: 100 } → expect BadRequest.
    // (기존 validate_run_config 테스트 헬퍼/AppState 픽스처 재사용; 정확한 구성은
    //  `grep -n "validate_run_config\|fn .*validate" crates/controller/src/api/runs.rs` 후 모방.)
}
#[tokio::test]
async fn validate_rejects_think_time_max_over_600000() { /* max_ms: 600_001 → BadRequest */ }
#[tokio::test]
async fn validate_accepts_think_time_in_range_and_none() { /* {100,500} OK, None OK */ }
```
```rust
// store/runs.rs tests — profile_json with think_time/think_seed round-trips; old row → None
#[test]
fn profile_json_think_time_round_trip_and_old_row_defaults_none() {
    let json = r#"{"vus":1,"duration_seconds":2,"think_time":{"min_ms":100,"max_ms":500},"think_seed":7}"#;
    let p: Profile = serde_json::from_str(json).unwrap();
    assert_eq!(p.think_time, Some(handicap_engine::ThinkTime { min_ms: 100, max_ms: 500 }));
    assert_eq!(p.think_seed, Some(7));
    // old row without the keys → None
    let old = r#"{"vus":1,"duration_seconds":2}"#;
    let p2: Profile = serde_json::from_str(old).unwrap();
    assert_eq!(p2.think_time, None);
    assert_eq!(p2.think_seed, None);
}
```

- [ ] **Step 2: Run to verify fail**

Run: `cargo test -p handicap-controller think_time`
Expected: FAIL — `Profile` has no field `think_time`.

- [ ] **Step 3: proto** — `crates/proto/proto/coordinator.proto`

`Profile` 메시지 위(또는 아래)에 새 메시지 + Profile 필드 6/7:
```proto
message ThinkTime {
  uint32 min_ms = 1;
  uint32 max_ms = 2;
}
```
```proto
message Profile {
  uint32 vus = 1;
  uint32 ramp_up_seconds = 2;
  uint32 duration_seconds = 3;
  uint32 loop_breakdown_cap = 4;   // 0 = disabled
  uint32 http_timeout_seconds = 5; // 0 = use default (30s)
  ThinkTime think_time = 6;        // absent → no inter-iteration pacing
  optional uint32 think_seed = 7;  // present → deterministic, absent → entropy
}
```

- [ ] **Step 4: store Profile fields** — `store/runs.rs:88` 아래

```rust
    #[serde(default)]
    pub think_time: Option<handicap_engine::ThinkTime>,
    #[serde(default)]
    pub think_seed: Option<u32>,
```
(store/runs.rs는 `handicap_engine` 의존 — 풀 경로 사용. import 추가 불필요하면 그대로.)

- [ ] **Step 5: validate + proto mapping** — `api/runs.rs`

validate_run_config의 http_timeout scalar 검증(:76-80) 바로 아래(criteria `if let`(:81-83) **앞** — criteria 블록 *안*에 넣지 말 것):
```rust
    if let Some(tt) = &profile.think_time {
        if tt.min_ms > tt.max_ms || tt.max_ms > 600_000 {
            return Err(ApiError::BadRequest(
                "think_time: min_ms <= max_ms <= 600000 (10분) 이어야 합니다".into(),
            ));
        }
    }
```
proto 매핑(:202-208) `Profile {…}` 리터럴에:
```rust
            http_timeout_seconds: body.profile.http_timeout_seconds,
            think_time: body.profile.think_time.map(|t| handicap_proto::v1::ThinkTime {
                min_ms: t.min_ms,
                max_ms: t.max_ms,
            }),
            think_seed: body.profile.think_seed,
```

- [ ] **Step 6: worker proto→RunPlan** — `crates/worker/src/main.rs:181-196` RunPlan 빌드(T3에서 None으로 둔 자리)

```rust
        http_timeout: Duration::from_secs(u64::from(if profile.http_timeout_seconds == 0 {
            30
        } else {
            profile.http_timeout_seconds
        })),
        think_time: profile.think_time.map(|t| handicap_engine::ThinkTime {
            min_ms: t.min_ms,
            max_ms: t.max_ms,
        }),
        think_seed: profile.think_seed,
```
(`profile`은 `pb::Profile`. `handicap_engine::ThinkTime`는 worker가 이미 engine 의존 — main.rs:9 import에 `ThinkTime` 추가하거나 풀 경로.)

- [ ] **Step 7: Fix all literal sites (SF-1 store + SF-2 prost)**

Run: `grep -rn "Profile {" crates/`. 
- **store `runs::Profile {`** 사이트(SF-1): `src/store/runs.rs`(default fixture), `src/store/presets.rs:194`, `src/report.rs:384`, `src/grpc/coordinator.rs:970`, `src/api/runs.rs:524·635` → `think_time: None, think_seed: None,`.
  - **controller 테스트 파일도(리뷰 B2 — 누락 시 컴파일 깨짐)**: `tests/export_routes_test.rs:63·191·261`, `tests/report_test.rs:70`, `tests/crash_recovery_test.rs:28` (전부 `data_binding`/`criteria`를 든 store `runs::Profile`) → `think_time: None, think_seed: None,`.
- **prost `pb::Profile {`** 사이트(SF-2): `src/api/runs.rs:202`(Step 5에서 처리됨), `src/grpc/coordinator.rs:951`, `crates/proto/tests/run_assignment_env_test.rs:13` → `think_time: None, think_seed: None,`.
> 두 종류가 같은 grep에 섞임 — `runs::Profile`(store)인지 `pb::Profile`/`handicap_proto::v1::Profile`(prost)인지 타입으로 구분. grep 결과를 **빠짐없이** 처리(특히 `crates/controller/tests/*`는 src 옆 grep에서 같이 나옴).

- [ ] **Step 8: Run tests**

Run: `cargo test -p handicap-controller` then `cargo test -p handicap-proto` then `cargo test -p handicap-worker` then `cargo clippy --workspace --all-targets -- -D warnings` then `cargo build --workspace`
Expected: PASS. (protoc 필요 — 빌드 타임 tonic-build.)

- [ ] **Step 9: Commit**

```bash
cargo build -p handicap-worker && cargo build --workspace
git add crates/proto/proto/coordinator.proto crates/controller/src/store/runs.rs crates/controller/src/api/runs.rs crates/worker/src/main.rs crates/controller/src/store/presets.rs crates/controller/src/report.rs crates/controller/src/grpc/coordinator.rs crates/proto/tests/run_assignment_env_test.rs crates/controller/tests/export_routes_test.rs crates/controller/tests/report_test.rs crates/controller/tests/crash_recovery_test.rs
git status --porcelain   # 확인: Changes not staged 비어야 함 (Profile 리터럴 파일 누락 없음)
git commit -m "feat(proto,controller,worker): run-level think_time/think_seed wire (validate 1..600000, profile_json, no migration)"
git log -1 --oneline
```

---

## Task 8: UI RunDialog — run-level Pacing 접이식 섹션

**Files:**
- Modify: `ui/src/components/RunDialog.tsx`, `ui/src/api/schemas.ts` (+ profile 타입이 정의된 곳: `ui/src/api/client.ts`/`types`의 RunProfile/PresetInput)
- Test: `ui/src/components/__tests__/RunDialog.test.tsx` (기존)

- [ ] **Step 1: Write failing test** — RunDialog 테스트에 추가

```tsx
it("submits think_time and think_seed from the Pacing section", async () => {
  // 1) RunDialog 렌더
  // 2) "Pacing" 토글 펼침(SLO 토글과 동형 — getByRole('button', {name: /Pacing/}))
  // 3) think min=100, max=500, seed=7 입력
  // 4) Run 제출 → useCreateRun mutate body.profile.think_time === {min_ms:100,max_ms:500}, think_seed===7
  // (기존 SLO 입력 제출 테스트를 grep해 mutate mock 어설션 패턴 모방:
  //  grep -n "max_p50\|mutate\|criteria" ui/src/components/__tests__/RunDialog.test.tsx)
});
it("omits think_time/think_seed when Pacing inputs are empty (byte-identical)", async () => {
  // 입력 없이 제출 → body.profile.think_time === undefined, think_seed === undefined
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd ui && pnpm test -- RunDialog`
Expected: FAIL.

- [ ] **Step 3: Add profile schema/type fields** — `ui/src/api/schemas.ts:46` (profile 스키마) + RunProfile/PresetInput 타입

`ProfileSchema`(`schemas.ts:46`)에만 추가(criteria/http_timeout_seconds 옆):
```ts
  think_time: z.object({ min_ms: z.number().int(), max_ms: z.number().int() }).optional(),
  think_seed: z.number().int().optional(),
```
**별도 TS 타입 편집 불필요** — `Profile = z.infer<typeof ProfileSchema>`(schemas.ts:55)이고 `PresetInput.profile`도 이 `Profile`을 쓰므로 스키마 한 곳 수정이 자동 전파(`RunProfile`이라는 타입은 없다). `.optional()`만 — `.default()` 금지(중첩 default 누출, ui/CLAUDE.md).

- [ ] **Step 4: Add Pacing collapsible section to RunDialog** — SLO `<fieldset>` 패턴(:378-393) 복제

state(:69 httpTimeout 옆):
```tsx
const initTT = initial?.profile.think_time;
const [thinkMin, setThinkMin] = useState(numToStr(initTT?.min_ms));
const [thinkMax, setThinkMax] = useState(numToStr(initTT?.max_ms));
const [thinkSeed, setThinkSeed] = useState(numToStr(initial?.profile.think_seed));
const [pacingOpen, setPacingOpen] = useState(
  () => initTT != null || initial?.profile.think_seed != null,
);
const thinkInvalid =
  (thinkMin.trim() !== "" || thinkMax.trim() !== "") &&
  (thinkMin.trim() === "" ||
    thinkMax.trim() === "" ||
    Number(thinkMin) < 0 ||
    Number(thinkMax) < Number(thinkMin) ||
    Number(thinkMax) > 600_000);
const pacingActiveCount = [thinkMin, thinkMax, thinkSeed].filter((s) => s.trim() !== "").length;
```
`canSubmit`에 `&& !thinkInvalid` 추가.

build helper(buildCriteria 옆):
```tsx
function buildThinkTime(): { min_ms: number; max_ms: number } | undefined {
  if (thinkMin.trim() === "" || thinkMax.trim() === "") return undefined;
  return { min_ms: Number(thinkMin), max_ms: Number(thinkMax) };
}
```
`currentInput()`(preset)과 `mutation.mutate` 둘 다의 `profile {…}`에:
```tsx
        http_timeout_seconds: httpTimeout,
        think_time: buildThinkTime(),
        think_seed: thinkSeed.trim() !== "" ? Number(thinkSeed) : undefined,
```
JSX — SLO fieldset 위/아래에 새 fieldset(SLO 토글 마크업 복제, `sloOpen`→`pacingOpen`, "SLO 기준 (선택)"→"Pacing (think time, 선택)", `sloActiveCount`→`pacingActiveCount`). 섹션 내부: think min(ms)/max(ms)/seed(optional) number 입력 3개 + thinkInvalid 인라인 에러("min ≤ max ≤ 600000, 둘 다 입력"). 입력 힌트 "min=max면 고정 지연".

- [ ] **Step 5: Run tests + gates**

Run: `cd ui && pnpm test -- RunDialog && pnpm lint && pnpm build`
Expected: PASS + clean.

- [ ] **Step 6: Commit**

```bash
git add ui/src/components/RunDialog.tsx ui/src/api/schemas.ts ui/src/api/client.ts ui/src/components/__tests__/RunDialog.test.tsx
git commit -m "feat(ui): RunDialog Pacing section — run-level think_time + think_seed (collapsible, byte-identical when empty)"
git log -1 --oneline
```

---

## Task 9: UI Inspector — per-step think time 입력

**Files:**
- Modify: `ui/src/components/scenario/Inspector.tsx`
- Test: `ui/src/components/scenario/__tests__/Inspector.test.tsx` (기존)

- [ ] **Step 1: Write failing test**

```tsx
it("commits per-step think_time on blur and clears when emptied", async () => {
  // 1) http 스텝 선택된 Inspector 렌더
  // 2) think min=100, max=300 입력 후 blur → setStepField(id, ["think_time"], {min_ms:100,max_ms:300})
  // 3) 비우면 setStepField(id, ["think_time"], undefined)
  // (timeout F5 테스트를 grep해 모방: grep -n "timeout\|commitTimeout\|setStepField" ui/src/components/scenario/__tests__/Inspector.test.tsx)
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd ui && pnpm test -- Inspector`
Expected: FAIL.

- [ ] **Step 3: Add per-step think time inputs (F5 draft/commit)** — `Inspector.tsx` (timeout draft :145-165 옆)

```tsx
const [thinkMinDraft, setThinkMinDraft] = useState(
  step.think_time ? String(step.think_time.min_ms) : "",
);
const [thinkMaxDraft, setThinkMaxDraft] = useState(
  step.think_time ? String(step.think_time.max_ms) : "",
);
useEffect(() => {
  setThinkMinDraft(step.think_time ? String(step.think_time.min_ms) : "");
  setThinkMaxDraft(step.think_time ? String(step.think_time.max_ms) : "");
}, [step.id, step.think_time]);
const commitThinkTime = () => {
  const minR = thinkMinDraft.trim();
  const maxR = thinkMaxDraft.trim();
  if (minR === "" && maxR === "") {
    setStepField(step.id, ["think_time"], undefined); // clears YAML key
    return;
  }
  const mn = Number(minR);
  const mx = Number(maxR);
  if (
    Number.isInteger(mn) && Number.isInteger(mx) &&
    mn >= 0 && mx >= mn && mx <= 600_000
  ) {
    setStepField(step.id, ["think_time"], { min_ms: mn, max_ms: mx });
  } else {
    // revert to last committed
    setThinkMinDraft(step.think_time ? String(step.think_time.min_ms) : "");
    setThinkMaxDraft(step.think_time ? String(step.think_time.max_ms) : "");
  }
};
```
JSX: Timeout(s) 입력 아래에 "Think time (ms)" min/max 두 입력(둘 다 `onBlur={commitThinkTime}`) + "min=max면 고정" 힌트.

- [ ] **Step 4: Run tests + gates**

Run: `cd ui && pnpm test -- Inspector && pnpm lint && pnpm build`
Expected: PASS + clean.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/scenario/Inspector.tsx ui/src/components/scenario/__tests__/Inspector.test.tsx
git commit -m "feat(ui): Inspector per-step think time min/max inputs (F5 draft/commit, clears when empty)"
git log -1 --oneline
```

---

## Task 10: UI TestRunSection — apply_think_time 토글

**Files:**
- Modify: `ui/src/components/scenario/TestRunSection.tsx`, `ui/src/api/client.ts:144-148` (createTestRun body 타입), `ui/src/api/hooks.ts:252-258` (useTestRun body 타입)
- Test: `ui/src/components/scenario/__tests__/TestRunSection.test.tsx` (기존 또는 신규)

- [ ] **Step 1: Write failing test**

```tsx
it("passes apply_think_time when the toggle is checked", async () => {
  // 1) TestRunSection 렌더 (yamlText prop)
  // 2) "think time 적용" 체크박스 체크
  // 3) "Test run" 클릭 → useTestRun mutate body.apply_think_time === true
  // 4) 체크 안 하면 apply_think_time === false (또는 omit)
  // (mutate mock: grep -n "useTestRun\|mutate\|max_requests" ui/src/components/scenario/__tests__/TestRunSection.test.tsx)
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd ui && pnpm test -- TestRunSection`
Expected: FAIL.

- [ ] **Step 3: Add body type** — `client.ts:144-148` + `hooks.ts:252-258`

client.ts:
```ts
  createTestRun: (body: {
    scenario_yaml: string;
    env?: Record<string, string>;
    max_requests?: number;
    apply_think_time?: boolean;
  }) => request("/test-runs", { method: "POST", body: JSON.stringify(body) }, ScenarioTraceSchema),
```
hooks.ts `useTestRun`의 mutate 인자 타입에도 `apply_think_time?: boolean;` 추가(passthrough).

- [ ] **Step 4: Add checkbox + pass in mutate** — `TestRunSection.tsx`

state(maxRequests 옆):
```tsx
const [applyThinkTime, setApplyThinkTime] = useState(false);
```
"Max requests" label 아래 체크박스:
```tsx
<label className="flex items-center gap-2 text-sm">
  <input
    type="checkbox"
    checked={applyThinkTime}
    onChange={(e) => setApplyThinkTime(e.target.checked)}
  />
  <span className="text-slate-600">think time 적용 (천천히 전송)</span>
</label>
```
mutate body에 추가:
```tsx
              testRun.mutate({
                scenario_yaml: yamlText,
                env: resolveEnv(baseVars, envEntries),
                max_requests: maxRequests,
                apply_think_time: applyThinkTime,
              })
```

- [ ] **Step 5: Run tests + gates**

Run: `cd ui && pnpm test -- TestRunSection && pnpm lint && pnpm test && pnpm build`
Expected: PASS + clean (전체 `pnpm test` 마지막 한 번).

- [ ] **Step 6: Commit**

```bash
git add ui/src/components/scenario/TestRunSection.tsx ui/src/api/client.ts ui/src/api/hooks.ts ui/src/components/scenario/__tests__/TestRunSection.test.tsx
git commit -m "feat(ui): TestRunSection apply_think_time toggle (opt-in throttled preview)"
git log -1 --oneline
```

---

## 최종 검증 (전 task 후)

- [ ] `cargo fmt --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace` (warm: 먼저 `cargo build -p handicap-worker && cargo build --workspace`).
- [ ] `cd ui && pnpm lint && pnpm test && pnpm build`.
- [ ] **handicap-reviewer** 에이전트로 whole-feature 리뷰: 와이어 1:1(UI Zod ↔ store Profile ↔ proto ↔ engine RunPlan/HttpStep), byte-identical(absent→sleep 0), 마이그레이션 0건, executor 무변경, 메트릭 무변경, B2 round-trip 패스스루 확인.
- [ ] 라이브 수동 점검(선택): RunDialog Pacing 입력 → run → 리포트에서 RPS 하락 관찰; 시나리오 에디터 per-step think_time 저장→재로드 유지 확인; test-run 토글 ON에서 천천히 전송 확인.
- [ ] roadmap §D에 S-B 완료 반영 + §13 연기 항목 누적. CLAUDE.md 루트 상태줄 갱신. (ADR 불필요 — additive.)

## 연기 항목 (spec §13)
think time 분포(Poisson) → S-C / constant-pacing-timer → S-C 이후 / test-run blanket delay → 별개 / trace think time 시각화 → UI 폴리시 / think_seed↔데이터바인딩 seed 통합 → 결정성 통합.
