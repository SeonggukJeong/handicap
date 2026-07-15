# graceful ramp-down 상한 (§B9 QoL) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** closed-loop VU 곡선의 graceful ramp-down에 opt-in 상한(초)을 추가한다 — 은퇴 VU가 현재 iteration을 마칠 때까지 기다리는 최대 시간을 넘기면 supervisor가 토큰을 취소해 다음 스텝 경계에서 park시킨다.

**Architecture:** 엔진 supervisor(`run_scenario_vu_curve`)에 per-index retire 타이머(`retire_expired` 헬퍼)를 추가해, graceful 모드에서 cap 초과 은퇴 VU의 activation 토큰을 취소(immediate 모드가 이미 쓰는 취소→스텝경계 abort→park 경로 재사용). opt-in `Option`(None=무상한=byte-identical). proto/store `Profile` additive 필드 + 컨트롤러 검증 + UI 노브.

**Tech Stack:** Rust(engine/controller/worker/proto·tokio·tonic-build) + TypeScript/React(Zod·vitest) UI.

**Spec:** `docs/superpowers/specs/2026-07-16-graceful-ramp-down-cap-design.md` (spec-plan-reviewer APPROVE).

<!-- REVIEW-GATE: APPROVED -->
<!-- spec-plan-reviewer(Opus): spec APPROVE (round 2) + plan APPROVE (round 2). 구현은 fresh 세션에서 subagent-driven. -->

## Global Constraints

- **opt-in·byte-identical:** 미설정(`None`/부재/빈칸)이면 기존 곡선 run과 완전히 동일. proto 부재·profile_json skip-when-none·UI 조건부 spread 전부. (spec §3.1)
- **graceful 전용:** cap은 `ramp_down == Graceful`(=`None`)에서만 의미. immediate/open-loop/fixed-closed엔 미노출·컨트롤러 거부.
- **migration 0** (profile_json serde default).
- **최소 1초:** cap은 `>= 1`(0 거부 — immediate와 중복).
- **컴파일러-강제 리터럴 fan-out:** `RunPlan`/store `Profile` 모두 `Default` 미파생 → 필드 추가 시 **모든 struct 리터럴**이 컴파일 에러. `cargo build`가 각 리터럴을 정확히 가리키므로 **빌드→에러 위치마다 `: None` 추가** (compiler-as-oracle; proto `Profile`은 별도 타입이라 store-Profile 리터럴만 걸림).
- **테스트 우선(tdd-guard):** 각 task는 테스트 파일(또는 인라인 `#[cfg(test)]`) 편집을 production src 편집보다 **먼저** — pending RED diff 없이 `crates/*/src`·`ui/src` 편집은 hook이 차단.
- **커밋:** 각 task 끝에 독립 green 커밋(`run_in_background: false` 단일 blocking 호출·폴링 금지). cargo-영향 커밋은 전체 workspace 빌드라 수 분 소요.
- **Rust idiom:** `u64::from(x)`(≠ `x as u64`), clippy `-D warnings` 클린, `if let`(≠ 2-arm match).

---

## File Structure

- `crates/engine/src/runner.rs` — RunPlan 필드 + plan 추출 + `retire_expired` 헬퍼 + supervisor 분기 (Task 1)
- `crates/engine/tests/vu_curve.rs` — 곡선 통합 테스트(실 wall-clock) (Task 1)
- `crates/engine/src/runner.rs` `#[cfg(test)] mod` — `retire_expired` 단위 테스트(합성 Instant) (Task 1)
- 모든 `RunPlan { .. }` 리터럴(engine tests·`crates/worker/src/lib.rs`·worker tests) — `graceful_ramp_down: None` (Task 1)
- `crates/controller/src/store/runs.rs` — store `Profile` 필드 (Task 2)
- `crates/controller/src/api/runs.rs` — 검증 3규칙 (Task 2) + dispatch 매핑 (Task 3)
- 모든 store `Profile { .. }` 리터럴 — `graceful_ramp_down_seconds: None` (Task 2)
- `crates/proto/proto/coordinator.proto` — proto 필드 14 (Task 3)
- proto `Profile` 리터럴(proto tests·`crates/proto/src/lib.rs`·controller dispatch·controller tests) — `graceful_ramp_down_seconds: …` (Task 3)
- `crates/worker/src/lib.rs` — proto→RunPlan 매핑 (Task 3)
- `ui/src/api/schemas.ts` — Zod `ProfileSchema` 필드 (Task 4)
- `ui/src/components/loadModel.ts` — `LoadModelState`·`buildLoadProfile`·`LoadModelErrors` (Task 4)
- `ui/src/components/LoadModelFields.tsx` — 입력 필드 + props (Task 4)
- `ui/src/components/RunDialog.tsx`·`ScheduleForm.tsx` — state·seed·thread·count (Task 4)
- `ui/src/i18n/ko.ts` — 라벨·glossary (Task 4)
- 모든 `LoadModelState` 리터럴 — `gracefulCap: ""` (Task 4, compiler-driven·`.ts` 테스트 포함: `__tests__/runSummary.test.ts`·`__tests__/profileForm.test.ts`)

---

## Task 1: 엔진 — RunPlan 필드 + `retire_expired` + supervisor 분기

**Files:**
- Modify: `crates/engine/src/runner.rs` (RunPlan struct ~90, plan 추출 ~727-731, `retire_expired` fn near `clear_slot` ~948, supervisor 분기 ~861, `#[cfg(test)] mod` 단위 테스트)
- Modify: `crates/engine/tests/vu_curve.rs` (`curve_plan` 헬퍼 + 새 통합 테스트)
- Modify: `crates/worker/src/lib.rs` (RunPlan 리터럴 ~289 — `graceful_ramp_down: None` 임시, 실 매핑은 Task 3)
- Modify: 기타 모든 `RunPlan { .. }` 리터럴 (compiler-driven)

**Interfaces:**
- Produces: `RunPlan.graceful_ramp_down: Option<Duration>`; `fn retire_expired(slab: &std::sync::Mutex<Vec<Option<CancellationToken>>>, retire_since: &mut [Option<Instant>], desired: u32, spawned: u32, cap: Duration, now: Instant)` (private, `#[cfg(test)]`에서 접근).

- [ ] **Step 1: `retire_expired` 단위 테스트 작성 (RED)** — `crates/engine/src/runner.rs`의 기존 `#[cfg(test)] mod tests`(없으면 파일 끝에 생성)에 추가. 아직 `retire_expired`가 없어 컴파일 실패(의도된 RED).

```rust
#[cfg(test)]
mod graceful_cap_tests {
    use super::*;
    use std::time::{Duration, Instant};
    use tokio_util::sync::CancellationToken;

    fn active_slab(n: usize) -> (std::sync::Mutex<Vec<Option<CancellationToken>>>, Vec<CancellationToken>) {
        let toks: Vec<CancellationToken> = (0..n).map(|_| CancellationToken::new()).collect();
        let slab = std::sync::Mutex::new(toks.iter().cloned().map(Some).collect());
        (slab, toks)
    }

    #[test]
    fn sets_timer_then_cancels_after_cap() {
        // desired=1, spawned=3: index 0 = desired-active, index 1·2 = over-desired active(=lingering).
        let (slab, toks) = active_slab(3);
        let mut since = vec![None; 3];
        let cap = Duration::from_secs(2);
        let base = Instant::now();
        // 1st: 타이머만 세팅, 취소 0.
        retire_expired(&slab, &mut since, 1, 3, cap, base);
        assert!(since[0].is_none(), "index<desired resets");
        assert!(since[1].is_some() && since[2].is_some());
        assert!(!toks[1].is_cancelled() && !toks[2].is_cancelled());
        // 2nd: cap 이내 → 취소 없음.
        retire_expired(&slab, &mut since, 1, 3, cap, base + Duration::from_secs(1));
        assert!(!toks[1].is_cancelled());
        // 3rd: cap 도달 → index 1·2 취소.
        retire_expired(&slab, &mut since, 1, 3, cap, base + Duration::from_secs(2));
        assert!(toks[1].is_cancelled() && toks[2].is_cancelled());
    }

    #[test]
    fn re_desire_resets_timer_no_cancel() {
        // index 1이 은퇴 타이머를 갖다가 desired가 다시 오르면(2) 리셋 → cap 지나도 취소 안 함.
        let (slab, toks) = active_slab(2);
        let mut since = vec![None; 2];
        let cap = Duration::from_secs(1);
        let base = Instant::now();
        retire_expired(&slab, &mut since, 1, 2, cap, base); // index1 retiring
        assert!(since[1].is_some());
        retire_expired(&slab, &mut since, 2, 2, cap, base + Duration::from_secs(2)); // desired 2 → index1 desired-active
        assert!(since[1].is_none(), "re-desired index resets");
        assert!(!toks[1].is_cancelled());
    }

    #[test]
    fn parked_slot_not_cancelled() {
        // index 1이 over-desired지만 slab None(자발 park) → 타이머·취소 없음.
        let (slab, toks) = active_slab(2);
        slab.lock().unwrap()[1] = None;
        let mut since = vec![None; 2];
        let cap = Duration::from_secs(1);
        let base = Instant::now();
        retire_expired(&slab, &mut since, 1, 2, cap, base);
        retire_expired(&slab, &mut since, 1, 2, cap, base + Duration::from_secs(5));
        assert!(since[1].is_none());
        assert!(!toks[1].is_cancelled());
    }
}
```

- [ ] **Step 2: RED 확인** — `cargo test -p handicap-engine graceful_cap_tests --no-run` → `cannot find function retire_expired` 컴파일 에러(RED).

- [ ] **Step 3: RunPlan 필드 추가** — `runner.rs` RunPlan struct의 `pub ramp_down: RampDown,`(~90) 바로 뒤:

```rust
    /// VU-curve graceful ramp-down 상한. `Some(d)` → 은퇴(desired 하락) 후 현재
    /// iteration이 `d`를 넘겨 lingering하면 supervisor가 activation 토큰을 취소해
    /// 다음 스텝 경계에서 park시킨다(immediate 경로 재사용). `None` → 무상한(현재
    /// 거동, byte-identical). graceful 모드에서만 참조(immediate가 항상 우선).
    pub graceful_ramp_down: Option<Duration>,
```

- [ ] **Step 4: `retire_expired` 헬퍼 추가** — `runner.rs`의 `fn clear_slot(...)`(~948) 근처(같은 파일 private fn 영역)에:

```rust
/// graceful ramp-down 상한(spec §5.3): 은퇴(index >= desired) 후 `cap`을 넘겨
/// 여전히 active(slab Some)인 VU의 토큰을 취소한다. 취소된 VU는 스텝 경계에서
/// `StepFlow::Aborted` → park(immediate와 동일 경로, `failed` 미증가). `retire_since`는
/// supervisor-소유 per-index 타이머(공유 없음). `index >= desired && slab Some`은
/// 항상 원래 lingering 활성화(재활성은 desired > index를 요구)라 취소 안전.
fn retire_expired(
    slab: &std::sync::Mutex<Vec<Option<CancellationToken>>>,
    retire_since: &mut [Option<Instant>],
    desired: u32,
    spawned: u32,
    cap: Duration,
    now: Instant,
) {
    let g = slab.lock().expect("slab mutex");
    for index in (desired as usize)..(spawned as usize) {
        if let Some(tok) = &g[index] {
            match retire_since[index] {
                None => retire_since[index] = Some(now),
                Some(t0) if now.duration_since(t0) >= cap => tok.cancel(),
                _ => {}
            }
        } else {
            retire_since[index] = None; // 자발 park·미활성 → 타이머 리셋
        }
    }
    // index < desired(desired-active)는 은퇴 대상 아님 → 리셋(재-desire 케이스)
    for slot in retire_since.iter_mut().take(desired as usize) {
        *slot = None;
    }
}
```

- [ ] **Step 5: plan 필드 추출 + supervisor 분기 배선** — `runner.rs` `run_scenario_vu_curve`:
  - plan 추출부(`let immediate = plan.ramp_down == RampDown::Immediate;` ~731 옆)에:
    ```rust
    let graceful_ramp_down = plan.graceful_ramp_down;
    ```
  - supervisor 루프 시작 전(`let mut spawned: u32 = 0;` ~743 옆)에:
    ```rust
    let mut retire_since: Vec<Option<Instant>> = vec![None; max_vus as usize];
    ```
  - 기존 immediate 블록(~861)을 확장:
    ```rust
    if immediate {
        // Idempotent re-cancel every tick (기존 코드 유지)
        let g = slab.lock().expect("slab mutex");
        for tok in g.iter().skip(desired as usize).flatten() {
            tok.cancel();
        }
    } else if let Some(cap) = graceful_ramp_down {
        retire_expired(&slab, &mut retire_since, desired, spawned, cap, now);
    }
    ```
    (`now`·`desired`·`spawned`·`slab`는 이미 이 위치 스코프에 있음.)

- [ ] **Step 6: 컴파일러-강제 리터럴 fan-out** — `cargo build --workspace` 실행 → `missing field graceful_ramp_down` 에러가 가리키는 **모든 `RunPlan { .. }` 리터럴**에 `graceful_ramp_down: None,` 추가. 최소 `crates/engine/tests/vu_curve.rs`의 `curve_plan`(~30-47), `crates/worker/src/lib.rs`의 RunPlan 조립부(~289 부근 — Task 3에서 실 매핑으로 교체), 그 외 `grep -rn "RunPlan {" crates/`가 잡는 전부. 반복: `cargo build --workspace`가 클린해질 때까지.

- [ ] **Step 7: GREEN 확인 (단위)** — `cargo test -p handicap-engine graceful_cap_tests` → 3 테스트 PASS.

- [ ] **Step 8: 곡선 통합 테스트 작성** — `crates/engine/tests/vu_curve.rs`에 추가. multi-step 시나리오(iteration이 cap보다 길게) + ramp-down에서 cap有 run이 cap無 run보다 요청 수가 적음(은퇴 VU가 중간에 잘림)을 단언. 실 wall-clock(`tokio::time::pause` 금지 — supervisor는 `std::Instant`라 paused time이 cap을 못 움직임·run hang).

```rust
fn scenario_n_steps(url: &str, n: usize) -> Arc<Scenario> {
    let mut steps = String::new();
    for i in 0..n {
        // ULID는 Crockford base32(I/L/O/U 제외) — ...001{0..} 로 유효.
        steps.push_str(&format!(
            "  - id: 01HX000000000000000000001{i}\n    name: s{i}\n    type: http\n    request:\n      method: GET\n      url: {url}\n    assert:\n      - status: 200\n"
        ));
    }
    let yaml = format!("version: 1\nname: vc\nsteps:\n{steps}");
    Arc::new(serde_yaml::from_str(&yaml).unwrap())
}

async fn run_curve_count(server_uri: &str, cap: Option<Duration>) -> u64 {
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(64);
    // 곡선 [stage(2,1), stage(0,4)] = 5s run. VU1은 t≈0.75s 활성→t≈2s 은퇴.
    // 20스텝×250ms = 5s iteration → 은퇴 후 남은 run(3s)보다 iteration이 길다:
    //   uncapped VU1 = deadline(5s)에 잘림 ≈ (5−0.75)/0.25 ≈ 17스텝
    //   capped   VU1 = cap(은퇴 t≈2 + 1s)에 t≈3s 취소 ≈ (3−0.75)/0.25 ≈ 9스텝
    //   → 결정적 gap ≈ 8. iteration이 remaining-run보다 길어야 gap이 벌어진다(핵심).
    let plan = RunPlan {
        graceful_ramp_down: cap,
        ..curve_plan(vec![stage(2, 1), stage(0, 4)], RampDown::Graceful)
    };
    let h = tokio::spawn(run_scenario_vu_curve(
        scenario_n_steps(&format!("{server_uri}/"), 20),
        plan,
        tx,
        CancellationToken::new(),
    ));
    let (count, errors) = drain(&mut rx).await;
    h.await.unwrap().unwrap();
    assert_eq!(errors, 0, "graceful cap run must not error");
    count
}

#[tokio::test]
async fn graceful_cap_cuts_lingering_iterations() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_millis(250)))
        .mount(&server)
        .await;
    // 실시간 sanity check — 결정적 증명은 retire_expired 단위 테스트. iteration(5s)이
    // 은퇴 후 remaining-run(3s)보다 길어 uncapped=deadline-cut / capped=cap-cut로
    // gap ≈ 8이 robust. **커밋 전 실측으로 gap을 확인**(escalate: 마진 없으면 스텝 수↑).
    let uncapped = run_curve_count(&server.uri(), None).await;
    let capped = run_curve_count(&server.uri(), Some(Duration::from_secs(1))).await;
    assert!(
        capped < uncapped,
        "capped run should execute fewer requests (retiring VUs cut at cap): capped={capped} uncapped={uncapped}"
    );
}
```

- [ ] **Step 9: 통합 GREEN 확인** — `cargo test -p handicap-engine --test vu_curve` → 기존 + 새 테스트 PASS.

- [ ] **Step 10: 게이트 + 커밋** — `cargo fmt && cargo clippy --workspace -- -D warnings && cargo nextest run --workspace`. 그 다음(단일 blocking):

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(engine): graceful ramp-down 상한 — retire_expired supervisor 캡 (§B9)

RunPlan.graceful_ramp_down: Option<Duration> + retire_expired 헬퍼로
graceful 모드 은퇴 VU가 cap 초과 lingering 시 토큰 취소→스텝경계 park
(immediate 경로 재사용). None=무상한=byte-identical. 단위(합성 Instant)+
곡선 통합(실 wall-clock) 테스트. 모든 RunPlan 리터럴 None fan-out.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: controller store `Profile` 필드 + 검증 3규칙

**Files:**
- Modify: `crates/controller/src/store/runs.rs` (store `Profile` struct ~115)
- Modify: `crates/controller/src/api/runs.rs` (`validate_run_config`, ramp_down 가드 ~210 옆)
- Modify: 모든 store `Profile { .. }` 리터럴 (compiler-driven — `report.rs:952`, test fixtures 등)
- Test: `crates/controller/src/api/runs.rs`의 검증 테스트 모듈(또는 기존 위치)

**Interfaces:**
- Consumes: (없음 — proto/worker는 Task 3)
- Produces: store `Profile.graceful_ramp_down_seconds: Option<u32>`; `validate_run_config`가 3조합을 400 거부.

- [ ] **Step 1: 검증 테스트 작성 (RED)** — `api/runs.rs`의 기존 `validate_run_config` 테스트 모듈에. **실 시그니처: `pub(crate) async fn validate_run_config(state: &AppState, profile: &Profile) -> Result<Vec<datasets::DatasetMeta>, ApiError>`**(`runs.rs:205`) — `&state`·`.await`·`state_with(db, N).await` 셋업 필수(기존 테스트 `:1676` 패턴). 실 fixture 헬퍼 = `curve_profile(stages: Vec<Stage>)`(`runs.rs:2075`, **stages 인자 필수**)·`closed_min()`(`:2481`). 골격:

```rust
#[tokio::test]
async fn graceful_cap_rejected_when_not_vu_curve() {
    let (db, _tmp) = test_db().await; // 기존 셋업 관례 재사용
    let state = state_with(db, 0).await;
    let mut p = closed_min(); // fixed closed
    p.graceful_ramp_down_seconds = Some(5);
    let err = validate_run_config(&state, &p).await.unwrap_err();
    assert!(matches!(err, ApiError::BadRequest(ref m) if m.contains("vu_stages")), "reject cap outside vu-curve: {err:?}");
}

#[tokio::test]
async fn graceful_cap_rejected_with_immediate() {
    let (db, _tmp) = test_db().await;
    let state = state_with(db, 0).await;
    let mut p = curve_profile(vec![Stage { target: 3, duration_seconds: 2 }, Stage { target: 0, duration_seconds: 2 }]);
    p.ramp_down = Some(handicap_engine::RampDown::Immediate);
    p.graceful_ramp_down_seconds = Some(5);
    let err = validate_run_config(&state, &p).await.unwrap_err();
    assert!(matches!(err, ApiError::BadRequest(ref m) if m.contains("graceful")), "reject cap with immediate: {err:?}");
}

#[tokio::test]
async fn graceful_cap_rejected_when_zero() {
    let (db, _tmp) = test_db().await;
    let state = state_with(db, 0).await;
    let mut p = curve_profile(vec![Stage { target: 3, duration_seconds: 2 }, Stage { target: 0, duration_seconds: 2 }]);
    p.graceful_ramp_down_seconds = Some(0);
    let err = validate_run_config(&state, &p).await.unwrap_err();
    assert!(matches!(err, ApiError::BadRequest(ref m) if m.contains("1 이상")), "reject cap=0: {err:?}");
}

#[tokio::test]
async fn graceful_cap_accepted_on_graceful_vu_curve() {
    let (db, _tmp) = test_db().await;
    let state = state_with(db, 0).await;
    let mut p = curve_profile(vec![Stage { target: 3, duration_seconds: 2 }, Stage { target: 0, duration_seconds: 2 }]); // ramp_down None(=graceful)
    p.graceful_ramp_down_seconds = Some(10);
    assert!(validate_run_config(&state, &p).await.is_ok());
}
```
(`test_db`/`state_with`/`curve_profile`/`closed_min`의 정확한 이름·시그니처는 `api/runs.rs`의 기존 `validate_run_config` 테스트를 grep해 맞춘다 — 위 `:1676`/`:2075`/`:2481` 참조.)

- [ ] **Step 2: RED 확인** — `cargo test -p handicap-controller graceful_cap --no-run` → `no field graceful_ramp_down_seconds`(RED).

- [ ] **Step 3: store `Profile` 필드 추가** — `store/runs.rs` `Profile` struct에(`ramp_down` 필드 근처):

```rust
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub graceful_ramp_down_seconds: Option<u32>,
```

- [ ] **Step 4: 리터럴 fan-out** — `cargo build -p handicap-controller` → `missing field graceful_ramp_down_seconds`가 가리키는 **모든 store `Profile { .. }` 리터럴**에 `graceful_ramp_down_seconds: None,` 추가(`report.rs:952`, api/runs.rs·store/{runs,presets,schedules}.rs·schedule/runner.rs·grpc/coordinator.rs test fixtures 등 — 컴파일러가 정확히 지목. proto `Profile` 리터럴은 아직 이 필드 없어 안 걸림). 클린해질 때까지 반복.

- [ ] **Step 5: 검증 3규칙 추가** — `api/runs.rs` `validate_run_config`의 ramp_down vu-curve 가드(~210) 옆에:

```rust
    // ── graceful ramp-down 상한은 graceful VU 곡선 전용 (spec §7.2) ──
    if profile.graceful_ramp_down_seconds.is_some() {
        if !profile.is_vu_curve() {
            return Err(ApiError::BadRequest(
                "graceful_ramp_down_seconds는 vu_stages(VU 곡선) 전용입니다".into(),
            ));
        }
        if profile.ramp_down == Some(handicap_engine::RampDown::Immediate) {
            return Err(ApiError::BadRequest(
                "graceful_ramp_down_seconds는 graceful ramp-down에서만 유효합니다".into(),
            ));
        }
        if profile.graceful_ramp_down_seconds == Some(0) {
            return Err(ApiError::BadRequest(
                "graceful_ramp_down_seconds는 1 이상이어야 합니다".into(),
            ));
        }
    }
```
(에러 타입은 기존 분기와 동일 `ApiError::BadRequest`(`runs.rs:211`). `RampDown`은 import 안 돼 있으니 **fully-qualified `handicap_engine::RampDown::Immediate`**(기존 `:745` 관례).)

- [ ] **Step 6: GREEN 확인** — `cargo test -p handicap-controller graceful_cap` → 4 테스트 PASS.

- [ ] **Step 7: serde 라운드트립 확인(byte-identical)** — 기존 profile_json serde 테스트 위치에, `graceful_ramp_down_seconds: None`인 profile을 직렬화하면 그 키가 **없음**(skip-when-none)을 단언(없으면 추가):

```rust
#[test]
fn none_graceful_cap_omitted_from_json() {
    let p = valid_vu_curve_profile();
    let j = serde_json::to_value(&p).unwrap();
    assert!(j.get("graceful_ramp_down_seconds").is_none(), "None must be omitted (byte-identical)");
}
```

- [ ] **Step 8: 게이트 + 커밋** — `cargo fmt && cargo clippy --workspace -- -D warnings && cargo nextest run -p handicap-controller`. 커밋(단일 blocking):

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(controller): graceful ramp-down 상한 store 필드 + 검증 (§B9)

store Profile.graceful_ramp_down_seconds: Option<u32>(skip-when-none) +
validate_run_config 3거부(vu-curve 전용·graceful 전용·>=1). None 생략
byte-identical. 모든 store Profile 리터럴 None fan-out.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: proto 필드 14 + worker 매핑 + controller dispatch

**Files:**
- Modify: `crates/proto/proto/coordinator.proto` (`Profile` message ~137-151)
- Modify: proto `Profile` 리터럴 (compiler-driven — `crates/proto/src/lib.rs`, `crates/proto/tests/*.rs`, `crates/controller/src/api/runs.rs` dispatch ~743, controller tests)
- Modify: `crates/worker/src/lib.rs` (RunPlan 조립 ~289 — Task 1의 `None` → 실 매핑)
- Modify: `crates/controller/src/api/runs.rs` (dispatch 매핑 ~743)
- Test: `crates/worker/src/lib.rs` `#[cfg(test)] mod`(proto→RunPlan 매핑)

**Interfaces:**
- Consumes: proto `Profile.graceful_ramp_down_seconds`(field 14); store `Profile.graceful_ramp_down_seconds`(Task 2).
- Produces: worker가 proto seconds → `RunPlan.graceful_ramp_down: Some(Duration)`.

- [ ] **Step 1: worker 매핑 테스트 작성 (RED)** — `crates/worker/src/lib.rs` `#[cfg(test)] mod`에. 기존 RunPlan-빌드 헬퍼(proto Profile → RunPlan)를 재사용:

```rust
#[test]
fn maps_graceful_cap_seconds_to_duration() {
    let mut p = proto_vu_curve_profile(); // 기존 proto Profile fixture 헬퍼
    p.graceful_ramp_down_seconds = Some(7);
    let plan = build_run_plan(&p, /* 기타 인자 기존대로 */);
    assert_eq!(plan.graceful_ramp_down, Some(Duration::from_secs(7)));

    p.graceful_ramp_down_seconds = None;
    let plan = build_run_plan(&p, /* … */);
    assert_eq!(plan.graceful_ramp_down, None);
}
```
(실제 RunPlan 조립 함수명·인자는 `lib.rs:232-294`를 보고 맞춘다. 조립이 인라인이면 그 경로를 타는 최소 헬퍼로 감싸거나 기존 테스트 패턴 재사용.)

- [ ] **Step 2: RED 확인** — `cargo test -p handicap-worker maps_graceful_cap --no-run` → proto Profile에 `graceful_ramp_down_seconds` 없음(RED).

- [ ] **Step 3: proto 필드 추가** — `coordinator.proto` `Profile` message의 `bool ramp_down_immediate = 13;` 뒤:

```proto
  optional uint32 graceful_ramp_down_seconds = 14;  // VU-curve graceful ramp-down 상한(초); 부재 = 무상한
```

- [ ] **Step 4: proto 리터럴 fan-out** — `cargo build --workspace` → 프로토젠이 새 `Option<u32>` 필드를 추가하며 **모든 proto `Profile { .. }` 리터럴**이 `missing field`. 컴파일러 지목대로:
  - `crates/proto/src/lib.rs`·`crates/proto/tests/run_assignment_env_test.rs` test 리터럴: `graceful_ramp_down_seconds: None,`
  - controller dispatch 리터럴(`api/runs.rs:743` 부근): **실 매핑**(store 필드 있음, Task 2):
    ```rust
    graceful_ramp_down_seconds: profile.graceful_ramp_down_seconds,
    ```
  - controller test 리터럴: `None`.
  클린해질 때까지.

- [ ] **Step 5: worker 매핑 배선** — `crates/worker/src/lib.rs` RunPlan 조립부(Task 1에서 `graceful_ramp_down: None`으로 둔 곳)를:

```rust
        graceful_ramp_down: profile
            .graceful_ramp_down_seconds
            .map(|s| Duration::from_secs(u64::from(s))),
```
(`http_timeout` 매핑 `lib.rs:244` 관용구와 동일 — `u64::from`, `as u64` 금지.)

- [ ] **Step 6: GREEN 확인** — `cargo test -p handicap-worker maps_graceful_cap` → PASS.

- [ ] **Step 7: 게이트 + 커밋** — `cargo fmt && cargo clippy --workspace -- -D warnings && cargo nextest run --workspace`. 커밋(단일 blocking):

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(proto,worker,controller): graceful 상한 와이어 배선 (§B9)

proto Profile.graceful_ramp_down_seconds=14(부재=무상한) + worker
proto→RunPlan Duration 매핑(u64::from) + controller dispatch 전달.
proto 리터럴 fan-out. 부재→None→byte-identical wire.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: UI — Zod + loadModel 빌더 + 입력 + RunDialog/ScheduleForm 배선 + ko

**Files:**
- Modify: `ui/src/api/schemas.ts` (`ProfileSchema` ~70-97)
- Modify: `ui/src/components/loadModel.ts` (`LoadModelState`·`LoadProfileFields`·`buildLoadProfile` closed+curve arm ~55-68·`LoadModelErrors`·`loadModelErrors`)
- Modify: `ui/src/components/LoadModelFields.tsx` (입력 + props, radiogroup ~529 뒤)
- Modify: `ui/src/components/RunDialog.tsx` (state·seed·loadState·`detailedAppliedCount` ~369)
- Modify: `ui/src/components/ScheduleForm.tsx` (state·seed·loadState)
- Modify: `ui/src/i18n/ko.ts` (`loadModel.gracefulCapLabel`·`glossary.gracefulCap`)
- Test: `ui/src/components/__tests__/*.tsx` (loadModel 불변식·buildProfile·prefill·count)

**Interfaces:**
- Consumes: `Profile.graceful_ramp_down_seconds`(Zod optional number).
- Produces: `LoadModelState.gracefulCap: string`; `LoadModelErrors.gracefulCapInvalid: boolean`; `LoadModelFields` props `gracefulCap: string`·`setGracefulCap: (v: string) => void`.

> **모든 하위 스텝: 테스트 파일 편집을 src보다 먼저**(tdd-guard). 각 스텝 끝에 `cd ui && pnpm test <file>`로 RED/GREEN 확인.

- [ ] **Step 1: loadModel 빌더/불변식 테스트 (RED)** — `ui/src/components/__tests__/loadModel.test.ts`(기존 파일)에 추가:

```ts
it("closed+curve+graceful+cap emits graceful_ramp_down_seconds", () => {
  const s = { ...baseClosedCurveState(), rampDown: "graceful" as const, gracefulCap: "12" };
  expect(buildLoadProfile(s).graceful_ramp_down_seconds).toBe(12);
});
it("empty cap omits the field", () => {
  const s = { ...baseClosedCurveState(), rampDown: "graceful" as const, gracefulCap: "" };
  expect(buildLoadProfile(s)).not.toHaveProperty("graceful_ramp_down_seconds");
});
it("immediate omits cap even if set", () => {
  const s = { ...baseClosedCurveState(), rampDown: "immediate" as const, gracefulCap: "12" };
  expect(buildLoadProfile(s)).not.toHaveProperty("graceful_ramp_down_seconds");
});
it("non-curve modes never emit cap", () => {
  for (const s of [baseClosedFixedState(), baseOpenFixedState(), baseOpenCurveState()]) {
    expect(buildLoadProfile({ ...s, gracefulCap: "12" })).not.toHaveProperty("graceful_ramp_down_seconds");
  }
});
it("gracefulCapInvalid on <1 or non-numeric", () => {
  expect(loadModelErrors({ ...baseClosedCurveState(), rampDown: "graceful", gracefulCap: "0" }).gracefulCapInvalid).toBe(true);
  expect(loadModelErrors({ ...baseClosedCurveState(), rampDown: "graceful", gracefulCap: "abc" }).gracefulCapInvalid).toBe(true);
  expect(loadModelErrors({ ...baseClosedCurveState(), rampDown: "graceful", gracefulCap: "5" }).gracefulCapInvalid).toBe(false);
});
```
(`base*State()` 헬퍼가 없으면 기존 테스트의 state 팩토리를 재사용·`gracefulCap: ""` 기본 추가.)

- [ ] **Step 2: RED 확인** — `cd ui && pnpm test loadModel` → 컴파일/단언 실패(RED).

- [ ] **Step 3: loadModel.ts 배선** —
  - `LoadModelState`(loadModel.ts) 타입에 `gracefulCap: string;` 추가. **`gracefulCap`은 non-optional이라 모든 `LoadModelState` 리터럴이 `tsc -b`에서 깨진다** — `grep -rn "LoadModelState" ui/src`로 전수해 각 리터럴에 `gracefulCap: ""` 추가. **RunDialog/ScheduleForm(Step 8·9) 외에 `.tsx`가 아닌 테스트도 걸림**: `ui/src/components/__tests__/runSummary.test.ts`(`Omit<LoadModelState,"loadModel">` factory)·`ui/src/components/__tests__/profileForm.test.ts`(state 리터럴 2곳). `pnpm build`(Step 10)가 이들을 잡으니 여기서 함께 갱신.
  - `LoadProfileFields`의 `Partial<Pick<Profile, ...>>`에 `"graceful_ramp_down_seconds"` 추가.
  - `buildLoadProfile`의 **closed+curve arm**(~55-68)에서 `ramp_down` spread(~66) 옆:
    ```ts
    ...(s.rampDown === "graceful" && s.gracefulCap.trim() !== ""
      ? { graceful_ramp_down_seconds: Number(s.gracefulCap) }
      : {}),
    ```
  - `LoadModelErrors` 타입에 `gracefulCapInvalid: boolean;` 추가.
  - `loadModelErrors(s)` 반환에:
    ```ts
    gracefulCapInvalid:
      s.loadModel === "closed" && s.rateMode === "curve" && s.rampDown === "graceful" &&
      s.gracefulCap.trim() !== "" &&
      (!Number.isInteger(Number(s.gracefulCap)) || Number(s.gracefulCap) < 1),
    ```

- [ ] **Step 4: GREEN 확인** — `cd ui && pnpm test loadModel` → PASS.

- [ ] **Step 5: Zod 필드** — `ui/src/api/schemas.ts` `ProfileSchema`의 `ramp_down` 옆:
  ```ts
  graceful_ramp_down_seconds: z.number().int().positive().optional(),
  ```
  (서버 skip-when-none이라 `.optional()`·`.nullish()` 아님.)

- [ ] **Step 6: ko 카탈로그** — `ui/src/i18n/ko.ts`에 (`rampDownLabel`/`glossary.rampDown` 패턴 따라):
  ```ts
  // loadModel 그룹:
  gracefulCapLabel: "느슨한 감축 상한(초)",
  gracefulCapPlaceholder: "비우면 무제한",
  // glossary 그룹:
  gracefulCap: "감축(ramp-down) 중 은퇴한 VU가 현재 반복을 마칠 때까지 기다리는 최대 시간(초)입니다. 비우면 무제한이며, 초과하면 다음 스텝 경계에서 중단합니다.",
  ```

- [ ] **Step 7: LoadModelFields 입력 (테스트 먼저)** — `__tests__/LoadModelFields.test.tsx`(또는 RunDialog 테스트)에 "graceful일 때만 상한 입력 렌더 + immediate면 미렌더" 테스트 추가(RED) → 그 뒤 `LoadModelFields.tsx`:
  - props 타입에 `gracefulCap: string;`·`setGracefulCap: (v: string) => void;` 추가(rampDown props 옆).
  - ramp_down `role="radiogroup"` 닫힌 직후(~529), `rampDown === "graceful"` 게이트:
    ```tsx
    {rampDown === "graceful" && (
      <Field label={ko.loadModel.gracefulCapLabel} htmlFor={gracefulCapId}>
        <div className="flex items-center gap-2">
          <Input
            id={gracefulCapId}
            numeric
            min={1}
            value={gracefulCap}
            onChange={(e) => setGracefulCap(e.target.value)}
            placeholder={ko.loadModel.gracefulCapPlaceholder}
          />
          <HelpTip label={ko.loadModel.gracefulCapLabel}>{ko.glossary.gracefulCap}</HelpTip>
        </div>
      </Field>
    )}
    ```
    (HelpTip은 `<label>`/`<Field>` accname을 오염 안 하도록 형제로 — 기존 ramp_down HelpTip 배치 미러. `Field`/`Input`/`HelpTip`·`gracefulCapId=useId()`는 파일의 기존 사용 관례를 따른다.)

- [ ] **Step 8: RunDialog 배선 (테스트 먼저)** — `__tests__/RunDialog.test.tsx`에 prefill·count 테스트 추가(RED):
  ```tsx
  it("prefills graceful cap from initial run profile", async () => {
    renderDialog({ initial: runWith({ vu_stages: [...], graceful_ramp_down_seconds: 15 }) });
    // <Input numeric>는 type="text"라 값은 문자열 — toHaveValue("15")(숫자 15 아님).
    expect(screen.getByLabelText(/느슨한 감축 상한/)).toHaveValue("15");
  });
  ```
  그 뒤 `RunDialog.tsx`:
  - `const [gracefulCap, setGracefulCap] = useState(() => initial?.profile.graceful_ramp_down_seconds != null ? String(initial.profile.graceful_ramp_down_seconds) : "");`
  - `loadPreset`에서 재시드: `setGracefulCap(prof.graceful_ramp_down_seconds != null ? String(prof.graceful_ramp_down_seconds) : "")`.
  - `loadState`(LoadModelState 리터럴)에 `gracefulCap,` 추가.
  - `LoadModelFields`에 `gracefulCap={gracefulCap} setGracefulCap={setGracefulCap}` 전달.
  - `detailedAppliedCount`(~369)에 항 추가:
    ```ts
    (loadModel === "closed" && rateMode === "curve" && rampDown === "graceful" && gracefulCap.trim() !== "" ? 1 : 0) +
    ```

- [ ] **Step 9: ScheduleForm 배선** — `ScheduleForm.tsx`(RunDialog와 동형, count 항 제외):
  - `const [gracefulCap, setGracefulCap] = useState(() => init?.profile.graceful_ramp_down_seconds != null ? String(init.profile.graceful_ramp_down_seconds) : "");`(실제 init 소스명은 파일 기존 `rampDown` 시드 미러).
  - `loadState`에 `gracefulCap,` + `LoadModelFields`에 props 전달.
  - `canSubmit`/제출 게이트가 `loadModelErrors`를 소비하므로 `gracefulCapInvalid`는 자동 반영(추가 배선 불요 — 확인만).

- [ ] **Step 10: 전체 UI 게이트** — `cd ui && pnpm lint && pnpm test && pnpm build`(전체 스위트 — targeted-green≠full-green; `--max-warnings=0`·`tsc -b`). `tsc -b`가 미갱신 `LoadModelState` 리터럴(`.ts` 테스트 포함, Step 3 grep)을 잡으면 `gracefulCap: ""` 추가. RunDialog를 렌더하는 타 테스트(ScenarioRunsPage 등)에 accname/스키마 회귀 없는지 확인.

- [ ] **Step 11: 커밋** (단일 blocking):

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(ui): graceful ramp-down 상한 입력 + 배선 (§B9)

ProfileSchema optional + loadModel 조건부 spread(graceful+curve+값) +
LoadModelFields 입력(graceful 게이트) + RunDialog/ScheduleForm state·
프리필·count + ko 라벨/glossary. 미설정=payload 키 부재=byte-identical.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## 최종 리뷰 · 라이브 검증 (구현 후, finish-slice 전)

- **handicap-reviewer**(크로스커팅·와이어 1:1·repo 함정) APPROVE. **path-gate:** 엔진 동시성 diff라 per-task code-quality 리뷰는 Opus. **security-reviewer:** `finish-slice §0` grep이 지배(엔진 `runner.rs` 매치 가능 — 예측 말고 grep 직접 실행해 매치면 APPROVE 필수).
- **라이브 검증(필수 — 엔진/run-create 경로):** `/live-verify` — 워크트리-자체 `cargo build -p handicap-worker --bin worker && -p handicap-controller --bin controller` + 느린 responder(iteration을 cap보다 길게, multi-step 또는 delay). ramp-down 곡선 run 2회(cap 有/無) → `active_vu_series` desired/actual 비교로 cap 有가 actual을 desired로 더 빨리 수렴시킴 실증 + 검증 3거부(vu-curve-only·graceful-only·≥1) 400 확인 + UI에서 곡선+graceful+cap run 1회 생성→리포트(Zod 콘솔 에러 0).

## Self-Review 체크 (작성자 확인 완료)

- **Spec 커버리지:** §5 엔진→Task 1, §6 proto→Task 3, §7 controller→Task 2(store+검증)+Task 3(dispatch), §8 worker→Task 3, §9 UI→Task 4, §12 테스트→각 task, §13 라이브→최종. 전부 매핑됨.
- **타입 일관성:** `graceful_ramp_down`(engine `Option<Duration>`)·`graceful_ramp_down_seconds`(proto/store `Option<u32>`·Zod optional number)·`gracefulCap`(UI string state)·`retire_expired` 시그니처가 task 간 일치.
- **Placeholder 스캔:** 모든 코드 스텝에 실 코드. fixture 헬퍼명은 "기존 파일 grep해 맞춤"으로 명시(코드베이스 관례 의존 부분).
- **순서:** 각 task compile-green(Task 1 worker 리터럴 `None` 임시→Task 3 실 매핑; Task 2 store-only→Task 3 proto+dispatch). tdd-guard 위해 UI는 테스트-먼저.
