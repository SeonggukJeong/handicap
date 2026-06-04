# S-D 다단계 ramp (open-loop 레이트 곡선) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** open-loop 실행을 고정 `target_rps`에서 `stages: [{target=RPS, duration}]` 레이트 곡선으로 일반화한다(k6식 piecewise-linear, 시작 rate=0). closed-loop 무변경.

**Architecture:** S-C의 격리 함수 `run_scenario_open_loop`에 레이트 곡선만 주입(슬롯풀/drop/메트릭/플러셔 무변경). `stages`는 `target_rps`+`duration_seconds`의 generic 대체(상호배타), `max_in_flight` 직교 필수. 7-layer 배선(엔진→proto→store→worker→검증→UI), **마이그레이션 0건**(profile_json serde-default), stages 없으면 byte-identical.

**Tech Stack:** Rust(engine/controller/worker/proto, tonic/prost, tokio, sqlx) + React/TS(Zod, React Query, Recharts) UI.

**스펙:** `docs/superpowers/specs/2026-06-04-load-model-pacing-s-d-stages-design.md` (spec-plan-reviewer APPROVE-WITH-FIXES 반영본).

---

## ⚠ 이 repo의 커밋 게이트 (모든 task 공통 — 반드시 숙지)

- **pre-commit이 비-`.md` 커밋마다 `cargo fmt --check + build + clippy -D warnings + test --workspace` 전체를 돈다**(수 분). 그래서:
  - **RED 테스트 단독 커밋 불가**(test --workspace 게이트), **미사용 헬퍼 단독 커밋 불가**(clippy dead_code). → 각 task는 **로컬에서 RED→GREEN 확인하되 커밋은 task 끝에 1회**(green 상태). 아래 각 task의 "Step: Commit"이 그 1회다.
  - 커밋은 **`run_in_background:false` 단일 호출**(파이프 금지 — `git commit | tail`은 exit code 마스킹). 직후 `git log -1 --oneline`로 landed 확인.
  - engine/worker 건드린 커밋은 **cold-build flake** 가능 → 커밋 전 `cargo build -p handicap-worker && cargo build --workspace`로 warm, flake나면 warm 상태로 재시도.
- **prost/RunPlan struct는 exhaustive** — 새 필드 추가 시 모든 literal 사이트가 컴파일 에러. 본 plan은 그 사이트를 전부 열거한다(빠뜨리면 workspace 컴파일 실패 = 커밋 불가).
- **UI는 cargo 훅이 안 본다** — UI task는 커밋 전 **`cd ui && pnpm lint && pnpm test && pnpm build` 수동**(`pnpm lint`는 `--max-warnings=0`). UI 커밋도 cargo 훅을 다 거치므로 다른 cargo 작업과 직렬.
- **TDD guard**(PreToolUse): src 파일 편집은 작업트리에 pending test 파일이 있어야 통과. 각 task의 Step 1이 테스트(테스트-경로 파일)를 먼저 만들어 unblock. 기존 `#[cfg(test)]` 가진 src(runner.rs 등) 편집은 자동통과.

---

## File Structure (touch map)

| 파일 | 책임 | task |
|---|---|---|
| `crates/engine/src/runner.rs` | `pub Stage`, `rate_at`, `RunPlan.stages`, 곡선 스케줄러 | 1 |
| `crates/engine/tests/open_loop.rs` | 곡선 스케줄러 통합 테스트(기존 하네스 재사용) | 1 |
| 모든 `RunPlan { … }` literal(아래 열거) | `stages: None` 컴파일 픽스 | 1 |
| `crates/controller/src/store/runs.rs` | store `Profile.stages` + `is_open_loop()` 메서드 | 2,5 |
| 모든 store `runs::Profile { … }` literal | `stages: None` 컴파일 픽스 | 2 |
| `crates/proto/proto/coordinator.proto` | `message Stage` + `repeated Stage stages = 10` | 3 |
| proto `Profile { … }` literal 3사이트 | `stages` 매핑/`vec![]` | 3 |
| `crates/worker/src/main.rs` | open-loop predicate 디스패치 + RunPlan.stages + duration=sum | 1,4 |
| `crates/controller/src/api/runs.rs` | `validate_run_config` + discriminator 사이트(:156/215/277) | 5 |
| `crates/controller/tests/` | stages open-loop e2e smoke | 6 |
| `ui/src/api/schemas.ts` (+ normalize) | `StageModel`, `ProfileSchema.stages` | 7 |
| `ui/src/components/RunDialog.tsx` | 고정\|곡선 토글 + stage 행 에디터 + payload + prefill | 8 |
| `ui/src/components/loadShapes.ts` (신규) | 부하-모양 템플릿 상수 | 9 |
| `ui/src/components/StageCurvePreview.tsx` (신규) | 라이브 미리보기 스파크라인 | 10 |
| `docs/adr/0032-*.md`, root/도메인 `CLAUDE.md`, `roadmap.md` | ADR + 결정/함정/상태 | 11 |

---

## Task 1: 엔진 — `Stage` + `rate_at` + 곡선 스케줄러 + RunPlan 필드

**Files:**
- Modify: `crates/engine/src/runner.rs` (RunPlan struct ~23, `run_scenario_open_loop` ~452-657, new `Stage`/`rate_at`)
- Modify (compile-fix `stages: None`): 모든 `RunPlan { … }` literal —
  `crates/worker/src/main.rs:182`, `crates/worker/tests/abort_and_env.rs`,
  `crates/engine/tests/{assertions,if_node,think_time,all_vus_failed,data_binding,runner_e2e,http_timeout,open_loop,vu_offset,loop_node,ramp_up,json_cast,multi_step}.rs`,
  `crates/engine/src/runner.rs`(인라인 테스트 literal).
- Test: `crates/engine/tests/open_loop.rs` (기존 하네스에 곡선 테스트 추가), runner.rs 인라인 `#[cfg(test)]`에 `rate_at` 단위테스트.

> 왜 한 task: `rate_at`은 스케줄러가 안 쓰면 `#[cfg(test)]`-only → clippy dead_code(커밋 불가). `RunPlan.stages` 추가는 cross-crate로 worker literal까지 깨므로 같은 커밋에서 컴파일 green 필요. 그래서 엔진 곡선 전체 + 전 literal `stages: None`이 한 green 커밋.

- [ ] **Step 1: `rate_at` 단위테스트 작성 (RED)** — runner.rs 하단 `#[cfg(test)] mod tests`에 추가:

```rust
    #[test]
    fn rate_at_piecewise_linear() {
        // ramp 0→200 over 30s
        let s = vec![Stage { target: 200, duration_seconds: 30 }];
        assert_eq!(rate_at(&s, 0.0), 0.0);
        assert_eq!(rate_at(&s, 15.0), 100.0);
        assert_eq!(rate_at(&s, 30.0), 200.0);
        // ramp + hold: 0→200(30s), hold 200(120s)
        let s = vec![
            Stage { target: 200, duration_seconds: 30 },
            Stage { target: 200, duration_seconds: 120 },
        ];
        assert_eq!(rate_at(&s, 30.0), 200.0);
        assert_eq!(rate_at(&s, 90.0), 200.0);
        assert_eq!(rate_at(&s, 150.0), 200.0);
        // ramp-down: 0→200(30s), 200→0(30s)
        let s = vec![
            Stage { target: 200, duration_seconds: 30 },
            Stage { target: 0, duration_seconds: 30 },
        ];
        assert_eq!(rate_at(&s, 30.0), 200.0);
        assert_eq!(rate_at(&s, 45.0), 100.0);
        assert_eq!(rate_at(&s, 60.0), 0.0);
        // segment-to-segment: 0→100(10s), 100→500(10s)
        let s = vec![
            Stage { target: 100, duration_seconds: 10 },
            Stage { target: 500, duration_seconds: 10 },
        ];
        assert_eq!(rate_at(&s, 10.0), 100.0);
        assert_eq!(rate_at(&s, 15.0), 300.0);
        assert_eq!(rate_at(&s, 20.0), 500.0);
        // empty → 0
        assert_eq!(rate_at(&[], 5.0), 0.0);
    }
```

- [ ] **Step 2: `Stage` 타입 + `rate_at` 구현** — runner.rs에 추가 (RunPlan 위 또는 근처):

```rust
/// One stage of an open-loop rate curve: ramp the arrival rate to `target` (req/s)
/// over `duration_seconds`, linearly from the previous stage's target (0 for the
/// first stage). Run-config concept (profile_json) — plain derive, no YAML round-trip
/// (NOT a scenario.rs manual-serde enum). Reused by the controller store Profile.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Stage {
    pub target: u32,
    pub duration_seconds: u32,
}

/// Instantaneous arrival rate (req/s) at `elapsed_secs` into a piecewise-linear
/// stage curve. Start rate = 0; stage k ramps `target_{k-1} → target_k` over its
/// duration (target_0 = 0). Past the end → last target (caller's deadline ends the run).
fn rate_at(stages: &[Stage], elapsed_secs: f64) -> f64 {
    let mut seg_start = 0.0_f64;
    let mut prev_target = 0.0_f64;
    for stage in stages {
        let seg_end = seg_start + f64::from(stage.duration_seconds);
        let target = f64::from(stage.target);
        if elapsed_secs <= seg_end {
            let span = seg_end - seg_start;
            if span <= 0.0 {
                return target;
            }
            let frac = (elapsed_secs - seg_start) / span;
            return prev_target + frac * (target - prev_target);
        }
        seg_start = seg_end;
        prev_target = target;
    }
    prev_target
}
```

- [ ] **Step 3: `RunPlan`에 `stages` 필드 추가** — runner.rs RunPlan struct에:

```rust
    /// Open-loop multi-stage rate curve (S-D). `Some(non-empty)` → the open-loop
    /// scheduler drives arrivals at `rate_at(stages, elapsed)` instead of the fixed
    /// `target_rps`. `None` → fixed rate (byte-identical to S-C). The worker sets
    /// `duration == sum(stage durations)` as an invariant (the engine derives the
    /// deadline from `plan.duration`, not from `stages`).
    pub stages: Option<Vec<Stage>>,
```

- [ ] **Step 4: 곡선 스케줄러 주입** — `run_scenario_open_loop`의 스케줄러 루프(현 `runner.rs:543-619`)를 아래로 교체. **루프 body(try_recv→spawn / drop+yield / next 전진)는 S-C와 동일, `interval` 산출만 변경**:

```rust
    // Rate epsilon: below this the curve is effectively zero (a `{0, d}` hold or the
    // ramp-down tail) — fire nothing, just poll. Low-but-positive rates (e.g. 0.5 rps
    // = 2s interval) take the normal 1/rate path (no interval cap — capping distorts rate).
    const RATE_EPS: f64 = 1e-9;
    let curve = plan.stages.clone();
    // Fixed-rate interval (S-C): precomputed integer nanos → byte-identical when curve is None.
    let fixed_interval = Duration::from_nanos((1_000_000_000u64 / u64::from(target_rps)).max(1));
    let mut next = started_at;
    loop {
        if cancel.is_cancelled() || exhausted.load(Ordering::Relaxed) || Instant::now() >= deadline
        {
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
        // Per-iteration interval: fixed (byte-identical) or curve-derived.
        let interval = match &curve {
            None => fixed_interval,
            Some(stages) => {
                let elapsed = now.saturating_duration_since(started_at).as_secs_f64();
                let rate = rate_at(stages, elapsed);
                if rate <= RATE_EPS {
                    // Zero-rate region: no arrival, no drop. Poll-step with the SAME
                    // cancel-aware select so cancel/deadline stay responsive.
                    tokio::select! {
                        _ = tokio::time::sleep(Duration::from_millis(100)) => {}
                        _ = cancel.cancelled() => break,
                    }
                    next = Instant::now();
                    continue;
                }
                Duration::from_secs_f64(1.0 / rate)
            }
        };
        match slot_rx.try_recv() {
            Ok(slot) => {
                let vu_id = vu_offset.saturating_add(slot as u32);
                let iter_id = arrival_counter as u32;
                arrival_counter += 1;
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
                    struct SlotGuard {
                        slot: usize,
                        tx: mpsc::Sender<usize>,
                    }
                    impl Drop for SlotGuard {
                        fn drop(&mut self) {
                            let _ = self.tx.try_send(self.slot);
                        }
                    }
                    let _slot_guard = SlotGuard { slot, tx: slot_tx };
                    let mut rng = match think_seed {
                        Some(s) => StdRng::seed_from_u64(crate::dataset::mix(s, vu_id, iter_id)),
                        None => StdRng::from_entropy(),
                    };
                    match run_arrival(
                        &client, &scenario, vu_id, iter_id, &agg, deadline, &env, &cancel_vu,
                        dataset, seq_counter, &mut rng, &exhausted,
                    )
                    .await
                    {
                        Ok(()) | Err(EngineError::Aborted) => {}
                        Err(e) => warn!(vu_id, error = ?e, "arrival failed"),
                    }
                });
            }
            Err(_) => {
                dropped += 1;
                tokio::task::yield_now().await;
            }
        }
        next += interval;
    }
```

> 주의: 위 블록은 기존 spawn arm을 그대로 보존한 채 `let interval = …` 산출만 감싼 형태다. 기존 코드의 spawn 클로저를 **삭제/재작성하지 말고** interval 분기만 추가하라(diff 최소화 = byte-identical 보존). `target_rps`/`fixed_interval`은 curve 모드에서 unused지만(plan.target_rps=None→1) 무해.

- [ ] **Step 5: 곡선 통합 테스트 작성 (RED)** — `crates/engine/tests/open_loop.rs` 끝에 추가. 기존 파일의 mock-server 헬퍼·`RunPlan` 빌더 패턴을 그대로 따른다(파일 상단 참고). 타이밍 민감하므로 **느슨한 tolerance**(ramp-up flakiness 함정):

```rust
#[tokio::test]
async fn open_loop_stages_curve_runs_and_drops_nothing_when_capacity_ample() {
    // 0→100 rps over 1s, hold 100 for 1s (total 2s). Ample slots, fast local mock.
    let server = start_mock().await; // ← 기존 open_loop.rs의 mock 시작 헬퍼명에 맞춰 사용
    let scenario = single_get_scenario(&server.url); // ← 기존 헬퍼
    let (tx, mut rx) = mpsc::channel(64);
    let plan = RunPlan {
        // ↓ 기존 open_loop.rs의 RunPlan 빌더 필드를 그대로 복사하고 아래만 변경
        vus: 0,
        ramp_up: Duration::ZERO,
        duration: Duration::from_secs(2), // == sum(stages)
        env: Default::default(),
        loop_breakdown_cap: 0,
        vu_offset: 0,
        data_binding: None,
        http_timeout: Duration::from_secs(30),
        think_time: None,
        think_seed: Some(7),
        target_rps: None,                 // curve mode (not fixed)
        max_in_flight: Some(50),
        stages: Some(vec![
            Stage { target: 100, duration_seconds: 1 },
            Stage { target: 100, duration_seconds: 1 },
        ]),
    };
    let cancel = CancellationToken::new();
    let mut total: u64 = 0;
    let mut dropped: u64 = 0;
    let h = tokio::spawn(run_scenario_open_loop(Arc::new(scenario), plan, tx, cancel));
    while let Some(flush) = rx.recv().await {
        for w in &flush.windows { total += w.count as u64; } // ← StepWindow count 필드명에 맞춰
        dropped += flush.dropped;
    }
    h.await.unwrap().unwrap();
    // Curve area ≈ 0.5*100*1 + 100*1 = 150 req. Loose bounds (timing-sensitive).
    assert!(total > 30, "expected curve to drive requests, got {total}");
    assert_eq!(dropped, 0, "ample slots → no drops");
}
```

> `Stage`/`rate_at`이 `pub`/모듈-가시인지 확인: `Stage`는 `pub`, 테스트는 `handicap_engine::Stage`로 import. `RunPlan`도 `pub`. (기존 open_loop.rs import 블록에 `Stage` 추가.)

- [ ] **Step 6: 모든 `RunPlan { … }` literal에 `stages: None` 추가** — 위 Files의 literal 목록 전부. 누락 시 `cargo build --workspace` 실패. 확인:

```bash
grep -rn "RunPlan {" crates/ | wc -l   # literal 개수 파악
cargo build --workspace 2>&1 | grep "missing field .stages." || echo "all literals patched"
```

worker `main.rs:182`의 RunPlan literal에는 일단 `stages: None`(real 매핑은 Task 4):
```rust
        // S-D: built from proto stages in Task 4; None here keeps closed/fixed paths intact.
        stages: None,
```

- [ ] **Step 7: warm build → 전체 테스트 GREEN 확인**

```bash
cargo build -p handicap-worker && cargo build --workspace
cargo test -p handicap-engine open_loop -- --nocapture
cargo test --workspace
```
Expected: `rate_at_piecewise_linear` PASS, `open_loop_stages_curve_*` PASS, 기존 open_loop 테스트 전부 PASS(fixed 경로 무회귀), workspace 0 fail.

- [ ] **Step 8: Commit** (`run_in_background:false`)

```bash
git add crates/engine crates/worker
git commit -m "feat(engine): open-loop 다단계 ramp 레이트 곡선 (S-D) — Stage/rate_at + 곡선 스케줄러

run_scenario_open_loop에 piecewise-linear rate_at 주입(시작 rate=0, k6식). 루프 body는
S-C와 byte-identical, interval만 곡선 도출. rate≈0(<=1e-9)이면 발사 안 함(poll-step+select).
RunPlan.stages 추가 → 전 literal stages:None. stages None이면 fixed 경로 byte-identical.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git log -1 --oneline
```

---

## Task 2: store `Profile.stages` (마이그레이션 0건)

**Files:**
- Modify: `crates/controller/src/store/runs.rs` (`Profile` struct ~76)
- Modify (compile-fix `stages: None`): 모든 store `runs::Profile { … }` literal —
  `crates/controller/src/grpc/coordinator.rs:984`, `crates/controller/src/report.rs`,
  `crates/controller/src/api/runs.rs`, `crates/controller/src/store/presets.rs`,
  `crates/controller/src/store/runs.rs`(인라인 테스트). (`grep -rn "Profile {" crates/controller/src`로 store-Profile literal만 식별 — proto `pb::Profile`/`handicap_proto::v1::Profile`은 Task 3.)
- Test: `crates/controller/src/store/runs.rs` 인라인 `#[cfg(test)]` (serde round-trip)

- [ ] **Step 1: serde round-trip 테스트 (RED)** — store/runs.rs 인라인 테스트에:

```rust
    #[test]
    fn profile_stages_serde_roundtrip_and_default_absent() {
        // present → parses
        let j = serde_json::json!({
            "vus": 0, "duration_seconds": 60, "max_in_flight": 50,
            "stages": [{"target": 200, "duration_seconds": 30}, {"target": 0, "duration_seconds": 30}]
        });
        let p: Profile = serde_json::from_value(j).unwrap();
        assert_eq!(p.stages.as_ref().unwrap().len(), 2);
        assert_eq!(p.stages.as_ref().unwrap()[0].target, 200);
        // absent → None (old rows, no migration)
        let j2 = serde_json::json!({ "vus": 1, "duration_seconds": 10 });
        let p2: Profile = serde_json::from_value(j2).unwrap();
        assert!(p2.stages.is_none());
        // None → omitted from output (skip_serializing_if)
        let out = serde_json::to_value(&p2).unwrap();
        assert!(out.get("stages").is_none());
    }
```

- [ ] **Step 2: `Profile`에 `stages` 필드 추가** — store/runs.rs Profile struct에 (`handicap_engine::Stage` 재사용 — `ThinkTime`와 동일 패턴):

```rust
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stages: Option<Vec<handicap_engine::Stage>>,
```

- [ ] **Step 3: 모든 store `Profile { … }` literal에 `stages: None` 추가** — 위 목록. 확인:

```bash
cargo build -p handicap-controller 2>&1 | grep "missing field .stages." || echo "store literals patched"
```

- [ ] **Step 4: GREEN 확인**

```bash
cargo test -p handicap-controller profile_stages_serde -- --nocapture
cargo test --workspace
```
Expected: round-trip PASS, workspace 0 fail.

- [ ] **Step 5: Commit**

```bash
git add crates/controller
git commit -m "feat(controller): store Profile.stages (profile_json, 마이그레이션 0건)

handicap_engine::Stage 재사용, #[serde(default, skip_serializing_if)] — 옛 행 None,
present면 round-trip. runs 테이블 무변경(profile_json). store Profile literal stages:None.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git log -1 --oneline
```

---

## Task 3: proto `Stage` + `Profile.stages = 10` + store→proto 매핑

**Files:**
- Modify: `crates/proto/proto/coordinator.proto` (Profile message ~104, max field 현재 9)
- Modify (proto `Profile` literal 3사이트):
  - `crates/controller/src/api/runs.rs:257` — **프로덕션 store→proto 실 매핑**
  - `crates/controller/src/grpc/coordinator.rs:961` — 테스트 헬퍼 → `stages: vec![]`
  - `crates/proto/tests/run_assignment_env_test.rs:13` — round-trip 테스트 → `stages: …`
- Test: `crates/proto/tests/run_assignment_env_test.rs` (Stage round-trip)

- [ ] **Step 1: proto round-trip 테스트 (RED)** — `run_assignment_env_test.rs`에 stages 단언 추가(기존 Profile literal에 stages 채우고 encode→decode 후 비교):

```rust
    // in the existing Profile { … } literal: set stages
    // stages: vec![ Stage { target: 200, duration_seconds: 30 }, Stage { target: 0, duration_seconds: 30 } ],
    // after round-trip:
    assert_eq!(decoded.profile.as_ref().unwrap().stages.len(), 2);
    assert_eq!(decoded.profile.as_ref().unwrap().stages[0].target, 200);
```

- [ ] **Step 2: proto에 `Stage` + `stages` 추가** — coordinator.proto `Profile` 메시지 끝(현 `max_in_flight = 9` 뒤):

```proto
message Stage {
  uint32 target = 1;           // arrival rate (req/s) reached at end of this stage
  uint32 duration_seconds = 2;
}
```
그리고 `Profile` 안에:
```proto
  repeated Stage stages = 10;  // S-D open-loop rate curve; empty = absent (fixed rate)
```

- [ ] **Step 3: 빌드(코드젠) + proto literal 3사이트 픽스**

`api/runs.rs:257` 프로덕션 변환 — store `Profile.stages`(Option<Vec<engine::Stage>>) → proto repeated:
```rust
            stages: body
                .profile
                .stages
                .as_deref()
                .unwrap_or_default()
                .iter()
                .map(|s| handicap_proto::v1::Stage {
                    target: s.target,
                    duration_seconds: s.duration_seconds,
                })
                .collect(),
```
`grpc/coordinator.rs:961` 테스트 헬퍼: `stages: vec![],`
`run_assignment_env_test.rs:13`: Step 1에서 실제 stages 채움.

확인:
```bash
cargo build --workspace 2>&1 | grep "missing field .stages." || echo "proto literals patched"
```

- [ ] **Step 4: GREEN 확인**

```bash
cargo test -p handicap-proto -- --nocapture
cargo test --workspace
```
Expected: proto round-trip PASS, workspace 0 fail.

- [ ] **Step 5: Commit**

```bash
git add crates/proto crates/controller
git commit -m "feat(proto): Profile.stages repeated Stage = 10 + store→proto 매핑

message Stage{target,duration_seconds} + repeated stages=10(비어있음=absent). 프로덕션
변환(api/runs.rs:257)은 store Profile.stages 실 매핑, 테스트 literal 2곳 vec![].

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git log -1 --oneline
```

---

## Task 4: worker — open-loop predicate 디스패치 + RunPlan.stages + duration=sum

**Files:**
- Modify: `crates/worker/src/main.rs` (RunPlan build ~182, dispatch ~305)
- Test: `crates/worker/tests/` — 기존 패턴이 있으면 추가, 없으면 Step 2의 로직을 `fn`으로 추출해 인라인 단위테스트(`stages_sum_duration`/`is_open_loop`)

- [ ] **Step 1: duration=sum + predicate 헬퍼 테스트 (RED)** — main.rs에 순수 헬퍼를 두고 인라인 `#[cfg(test)]`(또는 `crates/worker/tests/stages_wiring.rs`):

```rust
/// Open-loop when fixed rate OR a non-empty stage curve is set (S-D §3.5 predicate,
/// proto side). Empty `stages` ≡ absent.
fn proto_is_open_loop(p: &handicap_proto::v1::Profile) -> bool {
    p.target_rps.is_some() || !p.stages.is_empty()
}
/// Total run duration for the engine: sum of stage durations when a curve is set,
/// else the flat `duration_seconds`. Invariant: engine deadline = this value.
fn run_duration_secs(p: &handicap_proto::v1::Profile) -> u64 {
    if p.stages.is_empty() {
        u64::from(p.duration_seconds)
    } else {
        p.stages.iter().map(|s| u64::from(s.duration_seconds)).sum()
    }
}
```
테스트:
```rust
    #[test]
    fn stages_wiring() {
        let mut p = handicap_proto::v1::Profile::default();
        p.duration_seconds = 10;
        assert!(!proto_is_open_loop(&p));
        assert_eq!(run_duration_secs(&p), 10);
        p.stages = vec![
            handicap_proto::v1::Stage { target: 200, duration_seconds: 30 },
            handicap_proto::v1::Stage { target: 0, duration_seconds: 30 },
        ];
        assert!(proto_is_open_loop(&p));
        assert_eq!(run_duration_secs(&p), 60);
    }
```

- [ ] **Step 2: RunPlan build에 stages + duration 배선** — main.rs RunPlan literal:
  - `duration: Duration::from_secs(run_duration_secs(&profile)),`
  - `stages:` 매핑:
```rust
        stages: if profile.stages.is_empty() {
            None
        } else {
            Some(
                profile
                    .stages
                    .iter()
                    .map(|s| handicap_engine::Stage {
                        target: s.target,
                        duration_seconds: s.duration_seconds,
                    })
                    .collect(),
            )
        },
```

- [ ] **Step 3: 디스패치를 predicate로** — main.rs:305 `match plan.target_rps`를 교체:
```rust
    let run_res = if proto_is_open_loop(&profile) {
        run_scenario_open_loop(scenario, plan, win_tx, cancel).await
    } else {
        run_scenario(scenario, plan, win_tx, cancel).await
    };
```
> `profile`이 이 시점 스코프에 있는지 확인(RunPlan build 후 `profile` move 안 됐는지 — `profile.stages.is_empty()` 등은 `&profile` 참조). move됐으면 predicate 결과를 build 전에 `let is_ol = proto_is_open_loop(&profile);`로 캡처.

- [ ] **Step 4: warm build → GREEN**

```bash
cargo build -p handicap-worker && cargo build --workspace
cargo test -p handicap-worker -- --nocapture
cargo test --workspace
```

- [ ] **Step 5: Commit**

```bash
git add crates/worker
git commit -m "feat(worker): open-loop predicate 디스패치 + stages build + duration=sum

proto_is_open_loop(target_rps||비어있지 않은 stages) → run_scenario_open_loop. RunPlan.stages
proto 매핑, duration=sum(stages) (엔진 deadline 불변식). 빈 stages=absent.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git log -1 --oneline
```

---

## Task 5: 컨트롤러 검증 + discriminator 사이트 (`is_open_loop`)

**Files:**
- Modify: `crates/controller/src/store/runs.rs` — `Profile::is_open_loop()` 메서드
- Modify: `crates/controller/src/api/runs.rs` — `validate_run_config`(~62) + discriminator `:156`/`:215`/`:277`
- Test: `crates/controller/src/api/runs.rs` 인라인 `#[cfg(test)]` (validate 단위테스트)

- [ ] **Step 1: validate 단위테스트 (RED)** — api/runs.rs 인라인 테스트에. **먼저 이 파일의 기존 validate 테스트를 읽어** Profile literal 구성법·`validate_run_config` 호출 방식(AppState 빌더)을 그대로 차용한다(Profile은 Default 미derive 가능성 높음 → 기존 테스트의 명시-필드 Profile literal을 복사해 `stages`/`target_rps`만 바꿔 쓴다). `is_open_loop`은 DB 불필요한 순수 메서드라 단독 단위테스트:

```rust
    // base_closed_profile(): 기존 테스트의 closed-loop Profile literal을 복사해 헬퍼화
    // (vus>0, duration_seconds>0, target_rps:None, stages:None, max_in_flight:None, …).
    #[test]
    fn is_open_loop_predicate() {
        let mut p = base_closed_profile();
        assert!(!p.is_open_loop());
        p.target_rps = Some(100); p.max_in_flight = Some(10);
        assert!(p.is_open_loop());
        p.target_rps = None;
        p.stages = Some(vec![]);              // empty == absent
        assert!(!p.is_open_loop());
        p.stages = Some(vec![handicap_engine::Stage { target: 100, duration_seconds: 5 }]);
        assert!(p.is_open_loop());
    }
```
`validate_run_config` 위반 테스트는 async(`#[tokio::test]`)라 기존 validate 테스트의 AppState/`make_app` 헬퍼를 그대로 쓰고, curve Profile은 `base_closed_profile()`에서 `vus:0, duration_seconds:0, max_in_flight:Some(50), stages:Some(vec![Stage{200,30}])`로 변형해 구성한다.
그리고 validate 위반 케이스(각 400):
- stages + target_rps 동시
- stages + duration_seconds>0
- stages + ramp_up_seconds>0
- stages + run-level think_time
- stages + max_in_flight 없음
- stage target 모두 0
- stage duration_seconds==0
- (정상) stages + max_in_flight만 → Ok

(기존 validate 테스트의 호출 방식 — `validate_run_config(&state, &profile).await` — 을 그대로 따른다. AppState 빌더가 기존 테스트에 있으면 재사용.)

- [ ] **Step 2: `is_open_loop()` 메서드** — store/runs.rs `impl Profile`(없으면 추가):

```rust
impl Profile {
    /// S-D §3.5: open-loop when fixed rate OR a non-empty stage curve is set.
    /// Empty `stages` ≡ absent. Single source of truth for every open-loop
    /// discriminator (validate + slot_count + worker count).
    pub fn is_open_loop(&self) -> bool {
        self.target_rps.is_some() || self.stages.as_ref().is_some_and(|s| !s.is_empty())
    }
}
```

- [ ] **Step 3: `validate_run_config` 확장** — api/runs.rs. 현 `if let Some(rps) = profile.target_rps {` 진입을 `if profile.is_open_loop() {`로 바꾸고, 내부를 stages/fixed 분기. 핵심 골격:

```rust
    if profile.is_open_loop() {
        // max_in_flight required + range (both fixed & curve)
        match profile.max_in_flight {
            None => return Err(ApiError::BadRequest(
                if profile.stages.is_some() {
                    "stages(레이트 곡선)은 max_in_flight가 필요합니다 (closed-loop stages는 아직 미지원)".into()
                } else {
                    "open-loop(target_rps)은 max_in_flight가 필요합니다".into()
                },
            )),
            Some(m) if m == 0 || m > 10_000 =>
                return Err(ApiError::BadRequest("max_in_flight must be between 1 and 10000".into())),
            _ => {}
        }
        // knob conflicts shared by both open-loop sub-modes
        if profile.ramp_up_seconds > 0 {
            return Err(ApiError::BadRequest("open-loop에선 ramp_up_seconds를 쓸 수 없습니다 (RPS 곡선은 stages)".into()));
        }
        if profile.think_time.is_some() {
            return Err(ApiError::BadRequest("open-loop에선 run-level think_time을 쓸 수 없습니다 (closed-loop 전용)".into()));
        }
        match &profile.stages {
            Some(stages) if !stages.is_empty() => {
                // ── curve mode (S-D) ──
                if profile.target_rps.is_some() {
                    return Err(ApiError::BadRequest("stages와 target_rps는 함께 쓸 수 없습니다 (레이트 지정 방식 충돌)".into()));
                }
                if profile.duration_seconds > 0 {
                    return Err(ApiError::BadRequest("stages 사용 시 duration_seconds를 비워야 합니다 (총 길이 = stage 합)".into()));
                }
                for s in stages {
                    if s.target > 1_000_000 {
                        return Err(ApiError::BadRequest("stage target must be between 0 and 1000000".into()));
                    }
                    if s.duration_seconds == 0 {
                        return Err(ApiError::BadRequest("stage duration_seconds must be >= 1".into()));
                    }
                }
                if !stages.iter().any(|s| s.target > 0) {
                    return Err(ApiError::BadRequest("최소 한 stage의 target은 0보다 커야 합니다".into()));
                }
            }
            _ => {
                // ── fixed mode (S-C, unchanged) ──
                let rps = profile.target_rps.expect("is_open_loop && no stages ⟹ target_rps set");
                if rps == 0 || rps > 1_000_000 {
                    return Err(ApiError::BadRequest("target_rps must be between 1 and 1000000".into()));
                }
                if profile.duration_seconds == 0 {
                    return Err(ApiError::BadRequest("duration_seconds must be > 0".into()));
                }
            }
        }
        // vus ignored in open-loop (slot pool = max_in_flight)
    } else if profile.vus == 0 || profile.duration_seconds == 0 {
        return Err(ApiError::BadRequest("vus and duration_seconds must be > 0".into()));
    }
    // … 이하 loop_cap/http_timeout/criteria/data_binding 검증은 기존 그대로 …
```
> 기존 `if let Some(rps) = profile.target_rps {` 블록을 위 구조로 교체. http_timeout·loop_cap·think_time-range·criteria·data_binding 후속 검증은 손대지 말 것(그대로 유지).

- [ ] **Step 4: discriminator 사이트 교체** — api/runs.rs:
  - `:156` unique 워커수 `n`: `let n = if profile.is_open_loop() { 1 } else { state.coord.worker_count_for(profile.vus) };`
  - `:215` per_vu `slot_count`: `let slot_count = if body.profile.is_open_loop() { … max_in_flight … } else { … vus … };` (기존 `target_rps.is_some()`만 교체, 본문 로직 유지)
  - `:277` 워커수 `n`: `let n = if body.profile.is_open_loop() { 1 } else { state.coord.worker_count_for(body.profile.vus) };`

- [ ] **Step 5: GREEN**

```bash
cargo test -p handicap-controller validate -- --nocapture
cargo test -p handicap-controller is_open_loop -- --nocapture
cargo test --workspace
```

- [ ] **Step 6: Commit**

```bash
git add crates/controller
git commit -m "feat(controller): stages 검증 + is_open_loop discriminator 통일 (S-D §3.5)

Profile::is_open_loop(target_rps||비어있지 않은 stages)로 판별 사이트 4곳(:156/215/277+validate)
통일 → stages run이 closed-loop 오분류/fan-out 안 됨. stages 상호배타 400(target_rps/duration/
ramp/think_time/max_in_flight 없음) + bounds(target 0..1e6, dur>=1, 최소 1개 target>0).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git log -1 --oneline
```

---

## Task 6: 컨트롤러 e2e smoke — stages open-loop run

**Files:**
- Modify/Create test: `crates/controller/tests/e2e_test.rs` (기존 open-loop/`report_e2e_smoke` 패턴 미러) 또는 신규 `crates/controller/tests/stages_e2e_test.rs`
- 헬퍼: `worker_bin_path()`(기존), `cargo build -p handicap-worker` 선빌드

- [ ] **Step 1: e2e 테스트 작성 (RED)** — 기존 S-C open-loop e2e를 복사해 profile을 stages로:
  - 시나리오: 단일 GET(wiremock /ping, `set_delay(5ms)`로 p95>0)
  - run profile: `{"max_in_flight": 50, "stages": [{"target": 200, "duration_seconds": 1}, {"target": 200, "duration_seconds": 1}]}` (target_rps/duration_seconds 없음)
  - 단언: run이 `completed`로 종료, `GET /report`의 windows 비어있지 않음, `summary.count > 0`, `summary.rps`가 곡선 평균 근처(느슨), `dropped` 필드 존재.

```rust
// (기존 open-loop e2e의 spawn-worker → POST /scenarios → POST /runs → poll terminal → GET /report
//  구조를 그대로. 차이는 run body의 profile만 stages로.)
let profile = serde_json::json!({
    "max_in_flight": 50,
    "stages": [
        {"target": 200, "duration_seconds": 1},
        {"target": 200, "duration_seconds": 1}
    ]
});
// … run 생성·terminal 대기 후 …
assert_eq!(report["summary"]["count"].as_u64().unwrap() > 0, true);
assert!(report["windows"].as_array().unwrap().len() >= 1);
```

- [ ] **Step 2: 선빌드 + RED→GREEN**

```bash
cargo build -p handicap-worker
cargo test -p handicap-controller --test e2e_test stages -- --nocapture
```
Expected: PASS(완료 + 리포트 windows). flake(cold-build worker race) 나면 warm 재시도.

- [ ] **Step 3: workspace GREEN + Commit**

```bash
cargo build -p handicap-worker && cargo build --workspace && cargo test --workspace
git add crates/controller
git commit -m "test(controller): stages open-loop e2e smoke — 곡선 run 완료 + 리포트 windows

worker subprocess→controller→stages run→report. 단일워커 v1, 곡선 [200/1s,200/1s].

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git log -1 --oneline
```

---

## Task 7: UI — Zod `StageModel` + `Profile.stages`

**Files:**
- Modify: `ui/src/api/schemas.ts` (`ProfileSchema`) + `normalizeProfile` 헬퍼(검색: `grep -rn normalizeProfile ui/src`)
- Test: `ui/src/api/__tests__/schemas.test.ts`

- [ ] **Step 1: Zod round-trip 테스트 (RED)** — schemas.test.ts:

```ts
it("ProfileSchema parses stages and treats absent as undefined", () => {
  const p = ProfileSchema.parse({
    vus: 0, duration_seconds: 0, max_in_flight: 50,
    stages: [{ target: 200, duration_seconds: 30 }, { target: 0, duration_seconds: 30 }],
  });
  expect(p.stages).toHaveLength(2);
  expect(p.stages?.[0].target).toBe(200);
  const p2 = ProfileSchema.parse({ vus: 1, duration_seconds: 10 });
  expect(p2.stages).toBeUndefined();
});
```

- [ ] **Step 2: `StageModel` + `ProfileSchema.stages`** — schemas.ts. **`.default([])` 금지**(nested default 누출 — `ui/CLAUDE.md`), `.optional()`만:

```ts
export const StageModel = z.object({
  target: z.number().int().min(0).max(1_000_000),
  duration_seconds: z.number().int().min(1),
});
export type Stage = z.infer<typeof StageModel>;
// in ProfileSchema:
  stages: z.array(StageModel).optional(),
```
`normalizeProfile`(있으면)에 `stages`가 통과되도록 — standalone `Profile` 입력 타입을 손으로 쓰는 패턴이면(presets처럼) `stages?: Stage[]` 추가.

- [ ] **Step 3: GREEN (UI 게이트)**

```bash
cd ui && pnpm test schemas && pnpm lint && pnpm build
```
Expected: schemas 테스트 PASS, lint 0 warning, `tsc -b` clean.

- [ ] **Step 4: Commit** (UI도 cargo 훅 전체 통과 — 직렬)

```bash
git add ui/src/api
git commit -m "feat(ui): Zod StageModel + ProfileSchema.stages (optional, no default leak)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git log -1 --oneline
```

---

## Task 8: UI — RunDialog 고정|곡선 토글 + stage 행 에디터

**Files:**
- Modify: `ui/src/components/RunDialog.tsx` (load-model open 분기 ~459-515, payload ~257-273, prefill ~159-163)
- Test: `ui/src/components/__tests__/RunDialog.test.tsx`

- [ ] **Step 1: RTL 테스트 (RED)** — 토글/행/검증/payload/prefill:

```tsx
it("curve mode: add stages and submit stages payload", async () => {
  const user = userEvent.setup();
  const onSubmit = vi.fn();
  render(<RunDialog scenario={fakeScenario} onSubmit={onSubmit} /* … */ />);
  await user.click(screen.getByLabelText("Open-loop (arrival rate)"));
  await user.click(screen.getByLabelText(/곡선/)); // 레이트: 곡선
  // 기본 1행 시드 가정 — 목표/지속 입력
  const targets = screen.getAllByLabelText(/stage target/i);
  await user.clear(targets[0]); await user.type(targets[0], "200");
  const durs = screen.getAllByLabelText(/stage duration/i);
  await user.clear(durs[0]); await user.type(durs[0], "30"); await user.tab();
  await user.click(screen.getByRole("button", { name: /단계 추가/ }));
  // … 2행 입력 …
  await user.click(screen.getByRole("button", { name: /Run|실행/ }));
  const payload = onSubmit.mock.calls[0][0];
  expect(payload.profile.stages).toEqual([{ target: 200, duration_seconds: 30 }, /* … */]);
  expect(payload.profile.target_rps).toBeUndefined();
  expect(payload.profile.duration_seconds).toBe(0);
});

it("curve mode: requires at least one target>0", async () => { /* invalid 게이트 → submit disabled */ });

it("prefills curve mode from initial.profile.stages", () => {
  render(<RunDialog initial={{ profile: { max_in_flight: 50, stages: [{target:100,duration_seconds:10}] } }} /* … */ />);
  expect(screen.getByLabelText(/곡선/)).toBeChecked();
  expect(screen.getByDisplayValue("100")).toBeInTheDocument();
});
```

- [ ] **Step 2: state + 토글 + 에디터 구현** — RunDialog.tsx. open 분기 안에 `rateMode` state + 곡선 렌더:

```tsx
// state (prefill from initial — reseed-by-key remount, no reseed effect)
const [rateMode, setRateMode] = useState<"fixed" | "curve">(
  initial?.profile.stages && initial.profile.stages.length > 0 ? "curve" : "fixed",
);
const [stages, setStages] = useState<{ target: string; duration_seconds: string }[]>(
  initial?.profile.stages?.map((s) => ({ target: String(s.target), duration_seconds: String(s.duration_seconds) }))
    ?? [{ target: "100", duration_seconds: "30" }],
);
```
- open 분기 상단에 `레이트: 고정 | 곡선` radio(`aria-label` 부여). `loadModel==="open"`일 때만.
- `rateMode==="fixed"` → 기존 Target RPS 입력. `"curve"` → stage 행 에디터(아래) + Target RPS·Duration 칸 숨김(Max in-flight·HTTP timeout 유지).
- stage 행: 각 행 `[목표 RPS][지속 s][×]`. 숫자 입력은 **draft state(문자열) + onBlur 커밋 검증**(`ui/CLAUDE.md` F5 — 빈칸/NaN 방지). `+ 단계 추가`/`×` 삭제(최소 1행 유지). 총 길이 readout = `sum(duration)`.
- **인라인 helper(§6.3.4)**: 곡선 모드 상단/필드 옆에 항상 보이는 한 줄 설명(호버-only 툴팁 아님 = a11y) — 예: 목표 RPS `각 단계가 *끝날 때*의 목표 초당 요청 수 (이전 값에서 선형 변화)`, Max in-flight `동시 처리 상한 — 서비스가 목표 레이트를 못 따라가면 초과분은 drop되어 리포트에 표시됩니다`, 지속 `이 단계가 지속되는 시간(초)`. `<span className="text-xs text-slate-500">`(loop cap helper 이디엄, `:532` 참고).
- 검증: 각 행 정수, target 0..=1e6, duration>=1, 최소 1개 target>0 → 위반 시 inline 에러 + submit 비활성(`stagesInvalid`).

- [ ] **Step 3: payload 분기** — 현 open payload(`:260-263`)를 rateMode 분기:

```tsx
// open-loop curve
if (loadModel === "open" && rateMode === "curve") {
  return { /* …common… */ profile: {
    ...baseProfile,
    ramp_up_seconds: 0,
    max_in_flight: Number(maxInFlight),
    duration_seconds: 0,          // 곡선: 합으로 결정 (controller가 stages 사용)
    stages: stages.map((s) => ({ target: Number(s.target), duration_seconds: Number(s.duration_seconds) })),
    // target_rps / think_time 생략
  }};
}
// open-loop fixed → 기존 그대로 (target_rps)
// closed → 기존 그대로
```
> `duration_seconds: 0` + `stages` 동시 전송이 controller 검증 통과(Task 5: 곡선 모드는 duration_seconds>0이면 거부 → 0이어야 함). worker가 sum으로 덮어씀.

- [ ] **Step 4: GREEN (UI 게이트)**

```bash
cd ui && pnpm test RunDialog && pnpm lint && pnpm build
```

- [ ] **Step 5: Commit**

```bash
git add ui/src/components
git commit -m "feat(ui): RunDialog 고정|곡선 토글 + stage 행 에디터 (S-D)

open 분기 안 rateMode 토글, 곡선 모드 stage 행([target][duration][×]+추가, F5 draft/blur),
검증(target 0..1e6/dur>=1/최소1개 target>0), payload stages+duration_seconds:0, stages prefill.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git log -1 --oneline
```

---

## Task 9: UI — 부하-모양 템플릿 드롭다운

**Files:**
- Create: `ui/src/components/loadShapes.ts`
- Modify: `ui/src/components/RunDialog.tsx` (곡선 모드 상단 드롭다운)
- Test: `ui/src/components/__tests__/RunDialog.test.tsx` (템플릿 선택 → 행 시드)

- [ ] **Step 1: 테스트 (RED)** — 템플릿 선택이 stage 행을 채우는지:

```tsx
it("selecting a load-shape template seeds stages", async () => {
  const user = userEvent.setup();
  render(<RunDialog scenario={fakeScenario} /* … open+curve … */ />);
  await user.selectOptions(screen.getByLabelText(/부하 모양/), "spike");
  expect(screen.getAllByLabelText(/stage target/i).length).toBeGreaterThan(1);
});
```

- [ ] **Step 2: 템플릿 상수** — `loadShapes.ts` (UI-only 시드, 백엔드 무관):

```ts
import type { Stage } from "../api/schemas";
export type LoadShape = { id: string; label: string; stages: Stage[] };
export const LOAD_SHAPES: LoadShape[] = [
  { id: "ramp_hold", label: "점증·유지", stages: [
    { target: 200, duration_seconds: 30 }, { target: 200, duration_seconds: 120 }, { target: 0, duration_seconds: 30 } ] },
  { id: "spike", label: "스파이크", stages: [
    { target: 50, duration_seconds: 20 }, { target: 500, duration_seconds: 10 },
    { target: 500, duration_seconds: 20 }, { target: 50, duration_seconds: 20 } ] },
  { id: "step", label: "계단 스트레스", stages: [
    { target: 100, duration_seconds: 30 }, { target: 200, duration_seconds: 30 },
    { target: 300, duration_seconds: 30 }, { target: 400, duration_seconds: 30 },
    { target: 500, duration_seconds: 30 } ] },
  { id: "soak", label: "소크", stages: [
    { target: 100, duration_seconds: 60 }, { target: 100, duration_seconds: 1800 }, { target: 0, duration_seconds: 60 } ] },
];
```

- [ ] **Step 3: 드롭다운 배선** — 곡선 모드 상단 `<select aria-label="부하 모양">` + 옵션, onChange로 `setStages(shape.stages.map(→string draft))`. (선택은 시드일 뿐, 이후 사용자가 행 편집.)

- [ ] **Step 4: GREEN + Commit**

```bash
cd ui && pnpm test RunDialog && pnpm lint && pnpm build
git add ui/src/components
git commit -m "feat(ui): 부하-모양 템플릿 4종(점증·유지/스파이크/계단/소크) 드롭다운 → stage 시드

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git log -1 --oneline
```

---

## Task 10: UI — 라이브 곡선 미리보기 스파크라인

**Files:**
- Create: `ui/src/components/StageCurvePreview.tsx`
- Modify: `ui/src/components/RunDialog.tsx` (곡선 모드 하단 미리보기)
- Test: `ui/src/components/__tests__/StageCurvePreview.test.tsx`

- [ ] **Step 1: 테스트 (RED)** — 제어점/렌더(jsdom: explicit size — `ui/CLAUDE.md` Recharts 함정):

```tsx
it("renders a line from (0,0) through cumulative control points", () => {
  render(<StageCurvePreview stages={[{target:200,duration_seconds:30},{target:0,duration_seconds:30}]} width={300} height={120} />);
  // 단언: SVG path 존재 + 데이터 포인트(0,0)/(30,200)/(60,0) 매핑 (toControlPoints 순수 함수 별도 단위테스트 권장)
  expect(document.querySelector("svg")).toBeInTheDocument();
});

it("toControlPoints builds cumulative (t, rate) including start 0", () => {
  expect(toControlPoints([{target:200,duration_seconds:30},{target:0,duration_seconds:30}]))
    .toEqual([{ t: 0, rate: 0 }, { t: 30, rate: 200 }, { t: 60, rate: 0 }]);
});
```

- [ ] **Step 2: 컴포넌트** — `StageCurvePreview.tsx`:

```tsx
import { LineChart, Line, XAxis, YAxis, ResponsiveContainer } from "recharts";
import type { Stage } from "../api/schemas";

export function toControlPoints(stages: Stage[]): { t: number; rate: number }[] {
  const pts = [{ t: 0, rate: 0 }];
  let t = 0;
  for (const s of stages) { t += s.duration_seconds; pts.push({ t, rate: s.target }); }
  return pts;
}

export function StageCurvePreview({ stages, width, height }: { stages: Stage[]; width?: number; height?: number }) {
  const data = toControlPoints(stages);
  const chart = (
    <LineChart data={data} width={width} height={height}>
      <XAxis dataKey="t" type="number" unit="s" />
      <YAxis dataKey="rate" type="number" unit=" rps" />
      <Line type="linear" dataKey="rate" dot={false} isAnimationActive={false} />
    </LineChart>
  );
  // production: ResponsiveContainer; tests pass explicit width/height (jsdom no layout)
  return width && height ? chart : <ResponsiveContainer width="100%" height={120}>{chart}</ResponsiveContainer>;
}
```

- [ ] **Step 3: RunDialog 곡선 모드 하단에 `<StageCurvePreview stages={parsedStages} />`** (유효 행만 number 변환해 전달; invalid면 빈 배열/마지막 유효 상태).

- [ ] **Step 4: GREEN + Commit**

```bash
cd ui && pnpm test StageCurvePreview && pnpm test RunDialog && pnpm lint && pnpm build
git add ui/src/components
git commit -m "feat(ui): stage 곡선 라이브 미리보기 스파크라인 (Recharts, 제어점 0,0→누적)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git log -1 --oneline
```

---

## Task 11: ADR-0032 + 결정/함정/상태 문서 (.md only)

**Files:**
- Create: `docs/adr/0032-multi-stage-open-loop-rate-curve.md`
- Modify: root `CLAUDE.md`("알아둘 결정들" + 상태 한 줄), `crates/engine/CLAUDE.md`(오픈루프 곡선 함정), `crates/controller/CLAUDE.md`(is_open_loop discriminator), `ui/CLAUDE.md`(stage 에디터/미리보기), `docs/roadmap.md`(§D S-D 완료 표기)

- [ ] **Step 1: ADR-0032 작성** (MADR 포맷) — 결정 = 스펙 §9의 5개(open-loop만/generic stages/시작 rate=0+fixed|curve/순간-rate v1/마이그레이션 0건). 맥락·대안·결과 포함. closed-loop stages·모드선택기·정확적분·fan-out 연기 명시.

- [ ] **Step 2: root CLAUDE.md** — "알아둘 결정들"에 `- **0032** 다단계 ramp(open-loop 레이트 곡선): stages=target_rps 일반화...` 한 줄 + 상단 상태 줄에 S-D 완료 반영.

- [ ] **Step 3: 도메인 CLAUDE.md 함정** —
  - engine: "곡선은 `run_scenario_open_loop`에 interval 산출만 주입, 루프 body byte-identical, rate≈0 poll-step, deadline은 plan.duration(워커가 sum)".
  - controller: "`Profile::is_open_loop()`로 판별 사이트 통일 — `target_rps.is_some()` 직접 분기 금지(stages 오분류)".
  - ui: "stage 행 에디터 F5 draft/blur, 미리보기 jsdom explicit size, stages `.optional()`(default 누출)".

- [ ] **Step 4: roadmap §D** — S-D를 ✅ 완료로, 영역 D 잔여를 churn/fan-out 등 후속만 남김.

- [ ] **Step 5: Commit** (docs-only fast-path)

```bash
git add docs/adr/0032-multi-stage-open-loop-rate-curve.md CLAUDE.md crates/engine/CLAUDE.md crates/controller/CLAUDE.md ui/CLAUDE.md docs/roadmap.md
git commit -m "docs(adr,claude,roadmap): ADR-0032 다단계 ramp + S-D 완료 반영"
git log -1 --oneline
```

---

## 최종 검증 (전 task 후)

- [ ] `cargo build -p handicap-worker && cargo build --workspace && cargo test --workspace` — 0 fail
- [ ] `cd ui && pnpm lint && pnpm test && pnpm build` — lint 0 warning, tsc-b clean, 테스트 green
- [ ] 라이브 수동 검증(선택, S-B/S-C 패턴): python `ThreadingHTTPServer` 200-responder + controller subprocess 워커 + 격리 DB → curve run(`[{200,5},{0,5}]`) 돌려 리포트 초당 RPS가 삼각형으로 오르내리는지 관찰. test-run은 stages 무관(부하 전용).
- [ ] 최종 whole-feature 리뷰 = `handicap-reviewer`(wire 1:1 7-layer + is_open_loop 통일 + byte-identical).

## 연기 (스펙 §8 — 구현 안 함)
closed-loop stages(VU 곡선+retire), 부하모델 모드선택기 3-way, 정확 적분-역산 스케줄러, graceful drain, per-second drop 시계열, Poisson 분포, open-loop fan-out.
