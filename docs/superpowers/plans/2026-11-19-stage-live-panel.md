# 계단 시험 c — 실행 중 계단 패널 (stage-live-panel) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 계단 run이 실행 중일 때 run 상세 화면에 현재 계단·계단별 판정 칩·자동 정지 예고·즉시 정지 현재값·정지 사유를 보여 주고, 그 판정이 끝난 뒤 리포트 판정과 같게 한다.

**Architecture:** b의 컨트롤러 감시(`StairMonitor`)를 「계단 run이면 항상」 만들고, 메시지마다 순수 함수 `build_live`로 실행 중 요약(`LiveState`)을 계산해 `tokio::sync::watch`에 넣는다. `GET /api/runs/{id}`가 status `running`인 계단 run일 때 그 마지막 값을 `auto_stop_live`로 싣는다(UI는 이미 1초 폴링). 판정 계단의 칩 상태는 리포트와 **같은 이름**(`StepState`), 정지 뒤 계단은 리포트와 같은 `stair::stop_row_state`를 쓴다.

REVIEW-GATE: APPROVED

**Tech Stack:** Rust(axum·tokio watch·serde) / TypeScript·React·Zod·vitest·RTL.

**Spec:** `docs/superpowers/specs/2026-11-18-stage-auto-stop-design.md` — **§8이 이 슬라이스**, US3·US5(c 부분). §4.4(완결·동결)·§4.5(감시 작업)·§5.2(행 상태)·§7(성능)·§9 체크리스트 1·2를 상속한다. 이전 판단·연기: roadmap §B69(특히 (2) 「해제된 계단의 `details()` 0」).

## 사용자 스토리 (US) — spec에서 발췌 (원천 = spec 앞머리)

- **US3** [c]: 운영자가 계단 run을 서버 대시보드 옆에 띄워 놓고 지켜본다. 성공하면 실행 중 화면에 현재 계단, 계단별 판정(정상/실패/측정 중/예정), 즉시 정지 현재값과 기준, 「다음 계단이 실패하면 자동 정지」 예고가 보인다. 멈추는 순간 이유가 바로 보인다. 실행 중에 본 판정은 끝난 뒤 리포트의 판정과 같다.
- **US5** [b, c는 자기 비용 재측정]: 운영자가 자동 정지를 켠 채 높은 RPS의 계단 run을 돌린다. 성공하면 같은 조건에서 켬 / 끔 / 기존 master를 비교해 달성 RPS, 부하기 CPU, 컨트롤러 CPU, 데이터 수신 지연이 §7 기준 안에 있다. 계단이 아닌 run은 리포트와 와이어가 바이트 단위로 이전과 같다.

## spec §8 세부화 (plan이 정한 것 — 리뷰 대상, 마무리 때 roadmap §B70에 기록)

1. **칩 상태 = 리포트 행 상태 9종 그대로 + 실행 중 3종(`measuring`·`pending`·`frozen`)**: spec `[ok|fail|…]`의 `fail`을 리포트의 `saturated`(포화)·`unconfirmed`로 나눠 둔다 → 판정 계단은 **리포트와 같은 값**이라 동등성이 항등 비교다. `after`(포화 정지를 끈 run의 포화 뒤 계단)·`not_measured`·`emergency_stopped`도 리포트 값 그대로, `frozen` = spec 「판정 중단 — 부하기 데이터 소진」.
2. **잠정 판정은 하나뿐이고 화면이 잠정이라고 말한다**: `judge`의 규칙상 판정 계단 상태는 다음 계단이 판정돼도 바뀌지 않는다 — 단 **마지막 판정 계단의 `unconfirmed`**는 다음 계단 판정 뒤 `spike`(앞에 정상 계단이 있고 다음이 정상) 또는 `saturated`(그 밖 — 첫 계단 실패 뒤 정상이면 `saturated` + 다음은 `after`)가 된다(`stair.rs` `judge` `:336-367`). 그래서 정지 기록이 없고 동결되지 않은 동안 그 칩·요약 라벨은 「실패(다음 계단 확인 중)」, 정지·동결 뒤엔(다음 계단이 판정되지 않으므로) 리포트 라벨 「확인 못 한 실패」. US3 「실행 중에 본 판정 = 리포트」는 이 잠정 라벨을 빼면 문자 그대로 성립(테스트 `unconfirmed_then_spike_or_saturated`).
3. **`suspended: bool` → `suspended_seconds: u32`**: 리포트 보류 줄(`stopSuspendedLine(secs)`)과 같은 숫자.
4. **`current_step`·`phase`는 등록이 다 차고(`expected`개 워커가 시작 시각을 보냄) 첫 open-loop 초가 오기 전엔 `null`** (「첫 데이터 대기 중」 — `band_of`가 등록 미달 때 `(0, Ramp)`를 내는 것을 화면에 쓰지 않는다).
5. **`emergency_now`는 「판정한 초가 아직 없음」이어도 `null`**: 즉시 정지가 켜졌는지는 UI가 `profile.stair.auto_stop.emergency`로 안다(켜짐 + null = 「첫 판정 대기」).
6. **`auto_stop_live`는 `GET /api/runs/{id}`에만, 계단 run일 때만 coordinator 조회**: 목록·생성·라벨 응답은 키를 싣지 않고, 계단 아닌 running run의 폴링에 잠금 추가 0.
7. **first_fail 예고**: first_fail은 어느 계단이든 실패하면 멈추므로, 다음 판정 계단이 마지막이 아니고 판정이 측정 안 된 계단에서 멈추지 않았으면 예고를 늘 낸다.
8. **갱신 주기 = 감시가 메시지를 처리할 때마다**(spec 「판정할 때만」보다 잦음): `current`·`emergency_now`가 초마다 바뀌기 때문. 단 **정지를 결정한 메시지에선 보내지 않고**, coordinator가 채운 기록을 받은 뒤 한 번 보낸다(예고·칩이 정지 전 모습으로 남지 않게).
9. **정지 뒤 머리 줄에서 「… 중」을 뺀다**: 감시가 멈춘 뒤 `current`가 마지막 구간에 얼어 있어 「측정 중」이 거짓이 되므로, 정지 기록이 있으면 머리 줄 = 판정 요약만(정지 줄이 칩 위에 있다).
10. **칩은 숫자를 싣지 않는다** → §B69 (2) `details()` 0 문제는 이 슬라이스에서 발생하지 않는다(`details()` 미사용 — Task 3 grep 게이트).
11. **US3 동등성의 예외(수용, §B70에 기록)**: ① 동결(조기 종료 워커) 뒤 계단은 실행 중 「판정 중단」, 리포트는 a의 `Upto(last)` 규칙으로 판정(spec §4.4) ② 정지 결정 뒤 중단 신호가 닿기 전에 모든 워커가 자연 완료 → 기록 `stop: null`(b `auto_stop_all_completed_late_records_null_stop`) → 실행 중 정지 줄·일부 실행 칩을 봤지만 리포트는 일반 상태 ③ 자동 정지 뒤 외부 중단 → `aborted`·기록 없음(리포트 없음 경로). 셋 다 run 꼬리 경합·드문 경우.

## Global Constraints

- 엔진·워커·worker-core·proto diff 0 (`git diff --stat master -- crates/engine crates/worker crates/worker-core crates/proto` 출력 0줄).
- 계단 아닌 run: `GET /api/runs/{id}` JSON에 `auto_stop_live` 키 없음(바이트 동일), 리포트·CSV·XLSX·인쇄 무변경.
- 실행 중 요약은 기존 1초 폴링(`useRun`)으로만 — WebSocket/SSE/push 금지(ADR-0009 비목표 유지).
- 화면 문구는 `ui/src/i18n/ko.ts` 경유, 보고서 문체(명사형·짧은 줄; 보류 줄은 기존 `stopSuspendedLine` 재사용).
- 와이어 직렬화: `LiveState` 안쪽 `Option`은 항상 `null`로 직렬화(키 생략 없음) → Zod `.nullable()`; 바깥 `auto_stop_live`는 키 생략 → `.optional()`.
- JSON 키 존재 단언은 `as_object().unwrap().contains_key(..)` (+ `is_null()`) — `v["k"] == Null`은 없는 키와 null 키를 못 가른다.
- 50계단에서 칩 줄은 줄바꿈(가로 스크롤 금지).
- 줄번호는 이 문서 작성 시점 기준 — 편집 전 `grep -n`으로 재확인.
- 커밋은 pre-commit 게이트 통과(`--no-verify` 금지), cargo-영향 커밋은 background. subagent는 `git checkout/switch/stash` 금지(복원은 Edit 또는 `git restore -- <path>`).

## Review Focus

1. **정지 결정 뒤 run이 아직 `running`인 몇 초**: 칩이 리포트와 같은 `partial`/`skipped`/`emergency_stopped`이고, 정지를 결정한 순간의 예고·「측정 중」이 남지 않아야 한다 → Task 2 `live_matches_report_after_stop`·Task 1 `stopped_hides_forecast`·Task 4 `head_waiting_current_and_after_stop`.
2. **자동 정지를 다 끈 계단 run(`auto_stop` 없음·두 칸 null)**: 이제 감시가 생기지만 절대 멈추면 안 되고(정지 판정 0), 화면엔 칩만 → Task 2 `no_auto_stop_never_stops_but_judges`, Task 5 `auto_stop_off_shows_chips_only`.
3. **50계단·큰 목표(예: 100000 req/s)·400px 화면**: 칩 줄바꿈, 문서 가로 넘침 0 → Task 5 클래스 단언 + 라이브 rect.
4. **잠정 실패 칩이 다음 계단 판정 뒤 「튄 계단」으로 바뀜**: 화면이 미리 잠정이라고 말해야 한다 → Task 1 `unconfirmed_then_spike_or_saturated`, Task 4 `summary_groups`.
5. **즉시 정지 초당 완료 < min_requests 초(보류 초)·워커 2대 등록 미달**: 「0%」·「계단 1 상승 중」 같은 거짓 대신 「판정 보류」·「첫 데이터 대기 중」 → Task 2 `live_current_waits_for_registration`·`live_current_step_and_emergency_now`, Task 4 `emergencyLine_*`.

---

### Task 1: 실행 중 요약 순수 모델 (`stair_live.rs`)

**Files:**
- Create: `crates/controller/src/stair_live.rs`
- Modify: `crates/controller/src/lib.rs` (모듈 등록 — 기존 `pub mod stair_monitor;` 옆)
- Modify: `crates/controller/src/stair.rs:1142` (`fn stop_row_state` → `pub(crate) fn`, 본문 무수정)
- Modify: `crates/controller/src/auto_stop.rs` (`EmergencyTracker::streak(&self) -> u32` 추가)
- Test: `stair_live.rs` 안 `#[cfg(test)] mod tests`, `auto_stop.rs` 테스트 모듈

**Interfaces:**
- Consumes: `stair::{StairConfig, StepState, Judgement, BandKind, SaturationStopMode, stop_row_state}`, `auto_stop::{StopInfo, step_failed}`.
- Produces (Task 2·3이 쓴다):

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LiveStepState {
    // 리포트 StepState와 같은 이름·같은 직렬화
    Ok, Spike, Saturated, Unconfirmed, After, NotMeasured, EmergencyStopped, Partial, Skipped,
    // 실행 중 전용
    Measuring, Pending, Frozen,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct EmergencyNow { pub error_rate: f64, pub p99_us: u64, pub bad_streak: u32, pub held: bool }

/// `RunResponse.auto_stop_live` 와이어. Option은 항상 null로 직렬화(skip 없음).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LiveState {
    pub current_step: Option<u32>,
    pub phase: Option<BandKind>,
    pub step_states: Vec<LiveStepState>,
    pub last_ok_step: Option<u32>,
    pub next_fail_stops: bool,
    pub emergency_now: Option<EmergencyNow>,
    pub suspended_seconds: u32,
    pub frozen: bool,
    pub stop: Option<StopInfo>,
}

pub struct LiveInputs<'a> {
    pub cfg: &'a StairConfig,
    pub judged: usize,                    // 판정에 넣은 계단 수(앞에서부터)
    pub judgement: Option<&'a Judgement>, // judged 계단까지 넣은 judge 결과(judged == 0이면 None)
    pub current: Option<(u32, BandKind)>,
    pub frozen: bool,
    pub stopped: bool,                    // 감시가 정지를 냈다(기록이 아직 없을 수 있음)
    pub stop: Option<&'a StopInfo>,       // stopped_at_ms가 채워진 기록
    pub stop_t0_ms: Option<i64>,          // 시작 시각을 보낸 워커 중 가장 이른 t0
    pub emergency_now: Option<EmergencyNow>,
    pub suspended_seconds: u32,
}

pub fn live_step_state(s: StepState) -> LiveStepState; // 같은 이름으로 1:1
pub fn build_live(inp: &LiveInputs) -> LiveState;
```

`build_live` 규칙 (계단 `i`, `n = cfg.targets.len()`):
- `stop`이 있고 `i as i64 > stop.judged_through` → `live_step_state(stop_row_state(cfg, stop, stop_t0_ms, i).0)`.
- 아니면 `i < judged` → `live_step_state(judgement.states[i])`.
- 아니면 `frozen` → `Frozen`; `current`가 있고 `i <= current.0` → `Measuring`; 그 밖 → `Pending`.
- `last_ok_step` = `judgement.last_ok`.
- `next_fail_stops` = `mode.is_some() ∧ !stopped ∧ stop.is_none() ∧ !frozen ∧ judged + 1 < n ∧ !judgement.states[..judged].contains(&NotMeasured) ∧ (mode == FirstFail ∨ (judged ≥ 1 ∧ step_failed(judgement, judged − 1)))`. (`judged + 1 < n`: 다음 판정 계단이 마지막이면 그 계단 완결 = 전 계단 완결이라 `saturation_stop`이 None — `auto_stop.rs:37-39`. `NotMeasured` 조건: `judge`가 측정 안 된 계단에서 걷기를 멈추면 뒤 계단은 실패할 수 없다.) `mode` = `cfg.auto_stop.as_ref().and_then(|a| a.saturation)`.

- [ ] **Step 1: 실패하는 테스트 작성** — `stair_live.rs` 테스트 모듈. 헬퍼: `cfg(n, mode)`, `jud(spec: &str, n) -> Judgement` — 'o' 정상·'f' 오류율 실패·'n' 그 자리 `measured=false`, spec 길이 뒤도 `measured=false`로 n까지 채워 `judge` 호출(`auto_stop.rs` 테스트 `steps()`와 같은 방식).
  - `maps_report_states`: `live_step_state` 9개 전부 같은 이름(`serde_json::to_value`로 문자열 비교 — `StepState`와 `LiveStepState` 직렬화 값이 같다).
  - `no_data_all_pending`: judged 0·current None·mode two_fails → 전부 `Pending`, `last_ok_step == None`, `next_fail_stops == false`.
  - `judged_then_measuring_then_pending`: n=6, `jud("ooof", 6)` judged 4, current (4, Measure) → `[Ok,Ok,Ok,Unconfirmed,Measuring,Pending]`, `last_ok_step == Some(2)`.
  - `unconfirmed_then_spike_or_saturated`: `jud("oof",6)` judged 3 → states[2] `Unconfirmed`; `jud("oofo",6)` judged 4 → states[2] `Spike`; `jud("ooff",6)` judged 4 → states[2] `Saturated`, states[3] `Saturated`; 그리고 `jud("ooffo",6)` judged 5 → states[2..4] 그대로 `Saturated`(앞 판정 불변 확인); `jud("f",6)` judged 1 → states[0] `Unconfirmed`, `jud("fo",6)` judged 2 → states[0] `Saturated`, states[1] `After`(앞 정상 없으면 튄 계단 아님).
  - `lagging_steps_are_measuring`: judged 2, current (4, Ramp) → 인덱스 2·3·4 `Measuring`, 5 `Pending`.
  - `forecast_two_fails`: n=6 `"ooof"` judged 4 → `true`; `"oooo"` → `false`; n=5 `"ooof"` judged 4(다음 = 마지막) → `false`; mode None → `false`.
  - `forecast_first_fail`: n=6 `"oo"` judged 2 → `true`; judged 5 → `false`.
  - `forecast_off_after_not_measured`: mode **FirstFail**, n=6, `jud("on", 6)` judged 2 → `false` (two_fails면 `step_failed`가 이미 false라 가드 없이도 통과하므로 반드시 FirstFail).
  - `stopped_hides_forecast`: mode **TwoFails**, n=6, `"ooof"` judged 4·`stopped: true`·`stop: None` → `next_fail_stops == false` (같은 입력에 `stopped: false`면 `true`도 같이 단언).
  - `frozen_marks_unjudged_and_hides_forecast`: judged 2, frozen, current (4, Measure) → 2..6 `Frozen`, `next_fail_stops == false`, `frozen == true`.
  - `saturation_stop_states_match_stop_row_state`: n=6, two_fails, `"ooff"` judged 4, stop{kind Saturation, decided 3, judged_through 3, stopped_at = t0 + 4·step_ms + 2000}, stop_t0 = t0 → `[Ok,Ok,Saturated,Saturated,Partial,Skipped]`.
  - `emergency_stop_states`: n=5, `"o"` judged 1, stop{kind Emergency, decided 2, judged_through 0, stopped_at = t0 + 2·step_ms + 1500} → `[Ok, NotMeasured, EmergencyStopped, Skipped, Skipped]`.
  - `serializes_nulls`: `build_live(no data)`를 `serde_json::to_value` → 객체가 `current_step`·`phase`·`emergency_now`·`stop`·`last_ok_step` 키를 **가지고**(`contains_key`) 값이 `is_null()`; `step_states[0] == "pending"`.
  - `auto_stop.rs` `streak_counts_and_resets`: 나쁜 초 2개 → `streak() == 2`, 보류 초(count < min) → 2 그대로, 정상 초 → 0.

- [ ] **Step 2: 실패 확인** — `cargo nextest run -p handicap-controller stair_live streak_counts` — 컴파일 오류(모듈·함수 없음).
- [ ] **Step 3: 구현** — 위 Interfaces 그대로.
- [ ] **Step 4: 통과 확인** — 같은 명령 PASS + `cargo clippy -p handicap-controller --all-targets -- -D warnings` 0.
- [ ] **Step 5: 되돌려 확인** — `build_live`의 stop 분기를 지우면 `saturation_stop_states_match_stop_row_state` RED · `next_fail_stops`에서 `!stopped`를 빼면 `stopped_hides_forecast` RED · `NotMeasured` 가드를 빼면 `forecast_off_after_not_measured` RED → 각각 원복 GREEN.
- [ ] **Step 6: 커밋** — `feat(controller): 계단 실행 중 요약 순수 모델 (stair_live)` (background).

---

### Task 2: 감시가 실행 중 요약을 계산한다 (`StairMonitor` 안쪽)

**Files:**
- Modify: `crates/controller/src/stair_monitor.rs` (`StairMonitor` 필드·`judge_steps`·`judge_seconds`·`on_msg`·`live()`·`set_stop()`)
- Test: `stair_monitor.rs` `#[cfg(test)] mod tests`

**Interfaces:**
- Consumes: Task 1 `LiveState`, `LiveInputs`, `EmergencyNow`, `build_live`, `EmergencyTracker::streak`.
- Produces (Task 3이 쓴다):
  - `StairMonitor::live(&self) -> LiveState`
  - `StairMonitor::set_stop(&mut self, stop: StopInfo)` (coordinator가 `stopped_at_ms`를 채운 기록 보관)

변경:
- `judge_steps`: `judging`이면 **mode와 무관하게** `numbers(&done)`·`judge`를 계산해 `self.judgement = Some(j)`로 보관하고, mode가 있을 때만 그 `j`로 `saturation_stop`. 정지 결정·`judged`·`released` 갱신은 b와 동일(b의 정지 테스트 무수정 통과가 증거).
- `judge_seconds`: `observe`에 넣은 초마다 `self.last_second = Some((count, errors, p99))`.
- `on_msg`: `newly_suspended`를 `self.suspended_total`에도 더한다.
- `live()`: `LiveInputs`를 채워 `build_live`.
  - `current` = `registered_t0s()`가 `Some`(등록 완료)이고 워커 수위(`level`) 최댓값이 있으면 `Some(self.band_of(그 최댓값))`, 아니면 None.
  - `stop_t0_ms` = `self.workers.values().filter_map(|s| s.t0_ms).min()` (리포트 `stop_t0` = `starts` 최솟값과 같은 규칙 — 둘 다 `plausible_start`를 통과한 첫 값).
  - `emergency_now` = 즉시 정지 칸이 켜져 있고 `last_second`가 있을 때 `EmergencyNow { error_rate: errors/count (count 0이면 0.0), p99_us, bad_streak: tracker.streak(), held: count == 0 || count < min_requests }`.
  - `stopped` = `self.stopped`, `stop` = `self.stop_record.as_ref()`.
- `details()`를 감시·요약 경로에서 부르지 않는다(§B69 (2)).

- [ ] **Step 1: 실패하는 테스트 작성**
  - 기존 `monitor_matches_report_for_completed_steps`의 배치·행 생성부를 헬퍼 `fn gen_run(c: &StairConfig, fail_from: i64) -> GenRun`로 꺼낸다 — `struct GenRun { m: StairMonitor, rows: Vec<WindowWithHdr>, ol: Vec<OpenLoopSecondRow>, starts: Vec<WorkerStartRow>, first_stop: Option<StopInfo> }`; `fail_from` = dropped가 생기기 시작하는 절대 초(기존 값 `T0 + 70`), 각 `on_msg`의 첫 `Outcome.stop`을 `first_stop`에 담는다. 기존 테스트는 `gen_run(&cfg5(None), T0 + 70)`를 쓰도록 바꾸되 **단언 줄 무수정**.
  - `live_matches_report_for_completed_steps`: `gen_run(&cfg5(None), T0 + 70)` → 리포트(`build_stair_report`, `auto_stop: None`)와 `m.live().step_states[i] == live_step_state(rep.steps[i].state)` (i < 5 전부), 상태 집합에 `Ok`와 비-`Ok`가 둘 다.
  - `live_matches_report_after_stop`: `gen_run(&cfg5(Some(TwoFails)), T0 + 49)` → `let s = first_stop.expect("정지")`, `assert_eq!(s.decided_step, 3)`; `s.stopped_at_ms = s.decided_at_ms + 20`; `m.set_stop(s.clone())`; 리포트는 `StairInputs.auto_stop = Some(AutoStopRecord { stop: Some(s), suspended_seconds: 0 })` → 모든 i에서 `m.live().step_states[i] == live_step_state(rep.steps[i].state)`, 그리고 `step_states[4] == Partial`(정지 시각이 계단 4 시작 뒤 — `NOW2`가 모든 계단 시작보다 뒤), `step_states[2..4]`에 `Saturated`. (gen_run이 정지 뒤에도 배치를 밀어 넣지만 감시는 `stopped` 뒤 판정하지 않으므로 무해 — 단언은 그대로.)
  - `no_auto_stop_never_stops_but_judges`: `StairConfig { auto_stop: None, ..cfg5(None) }`으로 `gen_run(.., T0 + 49)` → `first_stop == None`, `m.live().step_states`에 `Saturated` 있음, `next_fail_stops == false`, `emergency_now == None`.
  - `live_current_step_and_emergency_now`: `cfg_em(None)`·워커 1개(기존 `interleave`/`span` 헬퍼) — 계단 1 측정 구간까지 배치 → `current_step == Some(1)`, `phase == Some(Measure)`, `emergency_now.unwrap().bad_streak == 0`; 나쁜 초 2개 뒤 `bad_streak == 2`; count < min_requests 초 뒤 `held == true`, `bad_streak == 2`.
  - `live_current_waits_for_registration`: `expected = 2`, 워커 하나만 시작 시각+계단 2까지의 배치 → `current_step == None`, `phase == None`.
  - `live_frozen_after_early_end`: 기존 `early_end_phase_freezes_saturation` 입력 뒤 `m.live().frozen == true`, 판정 안 된 계단은 `Frozen`.
- [ ] **Step 2: 실패 확인** — `cargo nextest run -p handicap-controller stair_monitor` — 컴파일 오류.
- [ ] **Step 3: 구현** (위 「변경」 그대로).
- [ ] **Step 4: 통과 확인** — `cargo nextest run -p handicap-controller` 전부 PASS. b 테스트 단언 무수정 확인: `git diff -U0 HEAD -- crates/controller/src/stair_monitor.rs | grep '^-.*assert'` 출력 0줄. clippy 0.
- [ ] **Step 5: grep 게이트** — `grep -n 'details()' crates/controller/src/stair_monitor.rs crates/controller/src/stair_live.rs` 0건.
- [ ] **Step 6: 되돌려 확인** — `judge_steps`에서 judgement 보관을 `mode` 클로저 안으로 옮기면 `no_auto_stop_never_stops_but_judges` RED · `live()`의 `current`에서 등록 완료 조건을 빼면 `live_current_waits_for_registration` RED → 원복 GREEN.
- [ ] **Step 7: 커밋** — `feat(controller): 계단 감시가 실행 중 요약을 계산한다` (background).

---

### Task 3: 감시 상시화 + watch 배선 + `GET /api/runs/{id}` + ADR-0059

**Files:**
- Modify: `crates/controller/src/stair_monitor.rs` (`run_monitor`에 watch 송신자)
- Modify: `crates/controller/src/grpc/coordinator.rs` (`enqueue` `:1000` 감시 조건, `RunWorkers.live`(`:226` 주석 포함), `auto_stop()` `:1592` 반환형, `live_of()`, 테스트)
- Modify: `crates/controller/src/stair.rs` (`monitor_wanted` `:56`·`monitor_wanted_table` 삭제), `stair_monitor.rs:199` 주석
- Modify: `crates/controller/src/api/runs.rs` (`RunResponse` `:35`, `get` `:1040`, `to_response` `:1395`)
- Create: `docs/adr/0059-stair-auto-stop-live-summary.md`
- Modify: `CLAUDE.md` 「알아둘 결정들」 끝에 한 줄
- Test: `coordinator.rs`·`api/runs.rs` 테스트 모듈(`state_with` 하네스 `:1553`)

**Interfaces:**
- Consumes: Task 2 `StairMonitor::{live, set_stop}`.
- Produces:
  - `CoordinatorState::auto_stop(&self, run_id: &str, stop: StopInfo) -> Option<StopInfo>` (**반환형 변경** — 기존 `true` = `Some(채운 기록)`, `false` = `None`)
  - `CoordinatorState::live_of(&self, run_id: &str) -> Option<LiveState>` (run 없음·감시 없음 → None)
  - `run_monitor(coord, run_id, monitor, rx, done, handle, live_tx: tokio::sync::watch::Sender<LiveState>)`
  - 와이어 `RunResponse.auto_stop_live?: LiveState` (`#[serde(skip_serializing_if = "Option::is_none")]`)

변경:
- `enqueue`: `.filter(|c| monitor_wanted(c))` 삭제 → `base.stair`가 있으면 항상 감시. `watch::channel(monitor.live())` — Receiver는 `RunWorkers.live: Option<watch::Receiver<LiveState>>`, Sender는 `run_monitor`로. `:226` 주석 「자동 정지 칸이 켜졌을 때만(`monitor_wanted`)」 → 「계단 run이면 항상」.
- `run_monitor`: `on_msg` 뒤 `out.stop`이 **없으면** `live_tx.send_replace(monitor.live())`. 있으면 보내지 않고 `if let Some(filled) = coord.auto_stop(&run_id, stop).await { monitor.set_stop(filled); live_tx.send_replace(monitor.live()); }` 뒤 break(정지 뒤엔 배치가 오지 않으므로 마지막 값 유지; `None`이면 외부 중단이 이겨 곧 aborted).
- `get`: `row.status == RunStatus::Running && row.profile.stair.is_some()`일 때만 `state.coord.live_of(&id).await`, 그 밖 None. `to_response(r, last_metric_ts)`는 `auto_stop_live: None`을 넣고 `get`이 덮어쓴다(다른 호출부 3곳 `:1037·:1065·:1341` 무변경).

- [ ] **Step 1: 실패하는 테스트 작성**
  - `coordinator.rs`:
    - `stair_run_without_auto_stop_has_no_monitor`(`:6295`)를 **`stair_run_always_has_monitor`로 교체**: `stair_cfg(None)`·두 칸 null·`two_fails()` 셋 다 `monitor_handle(..).is_some()`; `non_stair_run_has_no_monitor` 유지.
    - `live_of_stair_and_non_stair`: 계단 run 등록 직후 `live_of(..)`가 `Some`이고 `step_states`가 전부 `Pending`; 계단 아닌 run → `None`; 없는 run → `None`.
    - `auto_stop_returns_filled_record`: `auto_stop(..)`이 `Some(s)`이고 `s.stopped_at_ms > 0`; 두 번째 호출 `None`.
    - 기존 bool 단언 8곳(`grep -n 'coord.auto_stop(\|c2.auto_stop(' crates/controller/src/grpc/coordinator.rs` — `c2.auto_stop`의 결과 단언 `:6399-6404` 포함) → `.is_some()`/`.is_none()`.
    - `two_worker_stair_run_auto_stops`(`:6507`)에 단언 추가: 워커가 Abort를 받은 뒤 `live_of(..)`를 타임아웃(2초) 폴링해 `stop.is_some()`이 될 때까지 기다리고 `stop.unwrap().stopped_at_ms > 0`, `next_fail_stops == false`(`auto_stop()`이 Abort를 보낸 뒤에야 감시 작업이 `set_stop`하므로 즉시 읽으면 경합 — `monitor_task_ends_with_done` `:6488`의 대기 방식 참고).
  - `api/runs.rs`:
    - `get_running_stair_run_includes_live`: 계단 profile run을 만들고 status running·coordinator `enqueue` → `GET` JSON `auto_stop_live.step_states` 길이 = 계단 수, `auto_stop_live` 객체가 `current_step` 키를 가지고 null.
    - `get_non_stair_run_has_no_live_key`: 계단 아닌 running run(enqueue 포함) → `!v.as_object().unwrap().contains_key("auto_stop_live")`.
    - `get_completed_stair_run_has_no_live_key`: 계단 run enqueue 뒤 DB status completed → 키 없음.
    - `get_running_run_missing_from_coordinator`: DB만 running 계단 run, enqueue 없음 → 200 + 키 없음.
- [ ] **Step 2: 실패 확인** — `cargo nextest run -p handicap-controller coordinator::tests api::runs::tests::get_` — 컴파일 오류/FAIL.
- [ ] **Step 3: 구현** (위 「변경」) + ADR-0059(MADR): 제목 「계단 자동 정지: 수신 흐름 감시 + 실행 중 판정 요약」. 결정 = 컨트롤러가 받은 배치로 계단·초를 판정(b)하고, 실행 중 요약(`auto_stop_live`)을 기존 1초 run 폴링에 싣는다. ADR-0051(이미 폴링 중인 windows의 클라 표시)을 넘어 서버가 실행 중 계산한 p99·판정을 싣는 점, ADR-0009 비목표(WebSocket/SSE·push·라이브 대시보드) 유지, 기각안(spec §3 B·C), 결과(계단 run마다 감시 상시 — 비용은 §7 재측정, `details()` 미사용, 잠정 판정 하나 — 위 세부화 2). CLAUDE.md 한 줄: `- **0059** 계단 자동 정지 감시 + 실행 중 판정 요약: 수신 배치 감시·`auto_stop_live`를 기존 1초 폴링에 (push·라이브 대시보드 비목표 유지)`.
- [ ] **Step 4: 통과 확인** — `cargo nextest run -p handicap-controller` 전부 PASS + clippy 0.
- [ ] **Step 5: grep 게이트** — `grep -rn 'monitor_wanted' crates/` 0건 · `grep -n 'fan_out_abort' crates/controller/src/stair_monitor.rs` 0건(b 불변식) · `git diff --stat master -- crates/engine crates/worker crates/worker-core crates/proto` 0줄.
- [ ] **Step 6: 되돌려 확인** — `run_monitor`의 정지 뒤 `set_stop`+`send_replace`를 지우면 `two_worker_stair_run_auto_stops` 폴링 타임아웃 RED · `get`의 `row.status == Running` 조건을 지우면 `get_completed_stair_run_has_no_live_key` RED → 원복 GREEN.
- [ ] **Step 7: 커밋** — `feat(controller): 계단 run 감시 상시화·run 상세 응답에 실행 중 요약 (ADR-0059)` (background).

---

### Task 4: UI 스키마 + 실행 중 패널 문구 (순수 함수)

**Files:**
- Modify: `ui/src/api/schemas.ts` (`StopInfoSchema`를 `AutoStopRecordSchema`의 `stop` 안쪽 객체에서 꺼내 둘이 공유, `StairLiveSchema` 추가, `RunSchema` `:360`에 `auto_stop_live: StairLiveSchema.optional()`, `export type EmergencyStopConfig = NonNullable<AutoStopConfig["emergency"]>`)
- Modify: `ui/src/components/report/stair/stairFormat.ts` (`StopRecord` 타입 export `:179`; `stopLineText`의 사유 조각을 `export function stopReasonParts(stop: StopRecord, lastOk: { label: string } | { target: number } | null): string[]`로 추출 — 포화면 연속 실패/첫 실패 사유(+슬롯 꼬리), 즉시 정지면 오류율·p99·연속 초 조각 + `stopLastOk(label)`/`stopLastOkTarget(target)`/`stopNoOk`. `stopLineText`는 `headline.last_ok_target`을 지금처럼 찾아 `{ label }`(인덱스 찾음)·`{ target }`(못 찾음)·`null`(없음)로 넘긴다 — 출력 바이트 무변경)
- Create: `ui/src/components/run/stairLive.ts`
- Modify: `ui/src/i18n/ko.ts` (`ko.runDetail.stairLive` 블록)
- Test: `ui/src/components/run/__tests__/stairLive.test.ts`; 기존 `stairExportParity.test.ts`·`StairResultSection.test.tsx`·`stairPrint.test.tsx` 무수정 통과

**Interfaces:**
- Consumes: Task 3 와이어.
- Produces (Task 5가 쓴다):

```ts
export type StairLive = z.infer<typeof StairLiveSchema>;
export type LiveStepState = StairLive["step_states"][number];
export function liveStateLabel(s: LiveStepState, live: StairLive): string;
export function liveHeadText(live: StairLive, targets: readonly number[]): string | null;
export function liveSummaryText(live: StairLive): string | null;
export function liveForecastText(live: StairLive): string | null;
export function liveEmergencyText(live: StairLive, em: EmergencyStopConfig | null | undefined): string | null;
export function liveStopText(live: StairLive, targets: readonly number[]): string | null;
```

`StairLiveSchema`(`.strict()`): `current_step: int|null`, `phase: enum(ramp,discard,measure)|null`, `step_states: array(enum(ok,spike,saturated,unconfirmed,after,not_measured,emergency_stopped,partial,skipped,measuring,pending,frozen))`, `last_ok_step: int|null`, `next_fail_stops: boolean`, `emergency_now: {error_rate:number, p99_us:number, bad_streak:int, held:boolean}.strict()|null`, `suspended_seconds: number`, `frozen: boolean`, `stop: StopInfoSchema|null`.

문구 (ko.ts `runDetail.stairLive` — 정확한 글자):
- `title: "계단 진행"`, `chipsLabel: "계단별 판정"`
- 실행 중 전용 상태 라벨: `measuring: "측정 중"`, `pending: "예정"`, `frozen: "판정 중단"`, `unconfirmedPending: "실패(다음 계단 확인 중)"`. 나머지 9종은 기존 `ko.report.stair.states`.
- `head: (cur: number, n: number, target: number, phase: string) => \`계단 ${cur}/${n} (${target} req/s) ${phase} 중\`` — phase 이름은 기존 `ko.report.stair.stopPhaseName`.
- `waitingFirst: "첫 데이터 대기 중"`
- `group: (a: number, b: number, label: string) => a === b ? \`${a} ${label}\` : \`${a}–${b} ${label}\``
- `forecast: (n: number) => \`→ ${n}계단이 실패하면 자동 정지\``
- `frozenLine: "판정 중단 — 부하기 데이터 소진"`
- `emergency: (rate: string, p99: string, limRate: number, limP99: number, secs: number, streak: number) => \`즉시 정지 감시: 오류율 ${rate} · p99 ${p99} ms (기준 ${limRate}% · ${limP99} ms 초과, ${secs}초 연속) 나쁜 초 ${streak}\``
- `emergencyHeld: (min: number, limRate: number, limP99: number, secs: number) => \`즉시 정지 감시: 초당 완료 ${min}개 미만 — 판정 보류 (기준 ${limRate}% · ${limP99} ms 초과, ${secs}초 연속)\``
- `emergencyWaiting: "즉시 정지 감시: 첫 판정 대기"`

규칙:
- `liveStateLabel`: `unconfirmed`이고 `live.stop == null && !live.frozen` → `unconfirmedPending`; 실행 중 전용 3종은 위 라벨; 나머지는 `ko.report.stair.states[s]`.
- `liveHeadText`: `stop != null` → null(세부화 9); `current_step == null` → `waitingFirst`; 아니면 `head(cur+1, targets.length, targets[cur], stopPhaseName[phase])`.
- `liveSummaryText`: 판정 상태(리포트 9종 중 `ok·spike·saturated·unconfirmed·after·not_measured`)인 앞쪽 연속 칩만, 같은 상태가 이어지는 구간마다 `group(a, b, liveStateLabel(s, live))`을 ` · `로 잇는다(번호 1부터). 판정 계단 0개 → null. 예: `[ok,ok,ok,ok,unconfirmed,measuring,…]`(정지 없음) → `"1–4 정상 · 5 실패(다음 계단 확인 중)"`.
- `liveForecastText`: `next_fail_stops` → `forecast(앞쪽 판정 칩 수 + 1)`; 아니면 null.
- `liveEmergencyText`: `em`(= `profile.stair.auto_stop?.emergency`)이 없으면 null; `emergency_now == null` → `emergencyWaiting`; `held` → `emergencyHeld(em.min_requests, em.error_rate_pct, em.p99_ms, em.consecutive_seconds)`; 아니면 `emergency(errorRateText(error_rate), formatMs(p99_us), em.error_rate_pct, em.p99_ms, em.consecutive_seconds, bad_streak)`.
- `liveStopText`: `stop == null` → null; 아니면 `stopHeadText(stop, targets) + " — " + [...stopReasonParts(stop, lastOk), clockText(stop.stopped_at_ms)].join(" · ")` (`lastOk` = `last_ok_step != null ? { label: stopLabel(i+1, targets[i]) } : null`). 머리말이 이미 「자동 정지」/「즉시 정지」를 말하므로 접두어 없음. 「일부 실행·실행 안 함」은 칩이 대신한다.

- [ ] **Step 1: 실패하는 테스트 작성** (`stairLive.test.ts`):
  - `schema_accepts_server_shape`: 서버 모양(모든 null 키 포함) parse 성공; `step_states`에 `"bogus"` → 실패; 추가 키 → 실패(strict); `RunSchema`가 `auto_stop_live` 없는 run도 parse.
  - `head_waiting_current_and_after_stop`: `current_step` null → `"첫 데이터 대기 중"`; `current_step 5, phase "measure", targets [100,200,…,1000]` → `"계단 6/10 (600 req/s) 측정 중"`; 같은 값 + `stop` 있음 → `null`.
  - `summary_groups`: 위 예 → `"1–4 정상 · 5 실패(다음 계단 확인 중)"`; 같은 상태 + `stop` 있음 → `"1–4 정상 · 5 확인 못 한 실패"`; 같은 상태 + `frozen: true` → `"1–4 정상 · 5 확인 못 한 실패"`; `[ok,spike,ok]` → `"1 정상 · 2 튄 계단 · 3 정상"`; `[ok,saturated,saturated,after]` → `"1 정상 · 2–3 포화 · 4 포화 이후"`; 판정 0 → null.
  - `forecast`: `next_fail_stops` true·판정 5칩 → `"→ 6계단이 실패하면 자동 정지"`; false → null.
  - `emergencyLine_off_waiting_held_value`: em 없음 → null; `emergency_now` null → `"즉시 정지 감시: 첫 판정 대기"`; held → `"즉시 정지 감시: 초당 완료 20개 미만 — 판정 보류 (기준 5% · 2000 ms 초과, 3초 연속)"`; `{error_rate: 0.002, p99_us: 340000, bad_streak: 0, held: false}` → `"즉시 정지 감시: 오류율 0.2% · p99 340 ms (기준 5% · 2000 ms 초과, 3초 연속) 나쁜 초 0"`.
  - `stopLine_saturation_and_emergency`: two_fails failed [3,4] decided 4, targets 100..1000 → `` `5계단(500 req/s) 판정 뒤 자동 정지 — 4·5계단 연속 실패 · ${clockText(stopped_at_ms)}` ``; emergency(error_hit only, max_error_rate 0.12, seconds 3, phase measure, decided 2)·`last_ok_step` 1 → `"3계단(300 req/s) 측정 중 즉시 정지 — 오류율 12.0% 3초 연속 · 마지막 정상 2계단(200 req/s) · …"`; `last_ok_step` null → `"정상 계단 없음"` 포함.
- [ ] **Step 2: 실패 확인** — `cd ui && pnpm vitest run src/components/run/__tests__/stairLive.test.ts` — FAIL.
- [ ] **Step 3: 구현**.
- [ ] **Step 4: 통과 확인** — `cd ui && pnpm lint && pnpm test && pnpm build` 전부 녹색(골든 `stair_stop_line_golden.json` 대조 테스트 포함 무수정).
- [ ] **Step 5: 되돌려 확인** — `liveStateLabel`에서 `stop == null` 조건을 지우면(항상 `unconfirmedPending`) `summary_groups`의 정지 뒤 케이스 RED · `stopReasonParts`의 `{ target }` 가지를 `stopNoOk`로 바꾸면 기존 `stairExportParity`/`StairResultSection` 테스트 중 하나가 RED인지 확인(없으면 `stopLineText` 단위 테스트에 last_ok_target이 계단 목록에 없는 케이스를 추가해 RED를 만든다) → 원복.
- [ ] **Step 6: 커밋** — `feat(ui): 계단 실행 중 요약 스키마·문구`.

---

### Task 5: 실행 중 계단 패널 컴포넌트 + run 상세 배치

**Files:**
- Create: `ui/src/components/run/StairLivePanel.tsx`
- Modify: `ui/src/pages/RunDetailPage.tsx` (라이브 궤적 `{liveSeconds.length > 0 && (` `:345` 바로 위)
- Test: `ui/src/components/run/__tests__/StairLivePanel.test.tsx`, `ui/src/pages/__tests__/RunDetailPage.test.tsx`

**Interfaces:**
- Consumes: Task 4 전부, `STAIR_STATE_COLOR`(`components/report/stair/stairColors.ts`), `PageSection`.
- Produces: `export function StairLivePanel({ live, stair }: { live: StairLive; stair: StairConfig }): JSX.Element`.

화면(위에서 아래):
1. 정지 줄: `liveStopText`가 있으면 b의 `StairStopLine`과 같은 노랑 상자 클래스(`rounded-md border border-amber-300 bg-amber-50 p-3 text-sm font-medium break-words text-amber-900`, `data-tone="auto-stop"`) — 맨 위(멈춘 순간 이유가 먼저 보이게).
2. 머리 줄 `<p>`: [`liveHeadText`, `liveSummaryText`] 중 null 아닌 것을 ` · `로 잇고, 예고가 있으면 ` ` + `liveForecastText`. `frozen`이면 그 아래 회색 줄 `frozenLine`.
3. 칩 `<ol aria-label={chipsLabel} className="flex flex-wrap gap-1">`, 계단마다 `<li aria-label={\`${i+1}계단 ${liveStateLabel(s, live)}\`} title={같은 글자}>` — 내용 = 번호 + 기호, `border-2`, 흰 배경, 번호 `text-slate-800`(pending만 `text-slate-400`). 기호·테두리색:
   | 상태 | 기호 | 테두리·기호 색 |
   |---|---|---|
   | ok | ✓ | `STAIR_STATE_COLOR.ok` |
   | saturated · unconfirmed | ✗ | 같은 이름의 `STAIR_STATE_COLOR` |
   | spike | ! | `STAIR_STATE_COLOR.spike` |
   | after · not_measured · partial · skipped | (없음) | 같은 이름의 `STAIR_STATE_COLOR` |
   | emergency_stopped | ■ | `STAIR_STATE_COLOR.emergency_stopped` |
   | measuring | … | 클래스 `border-accent-500 text-accent-700` |
   | pending | (없음) | 클래스 `border-slate-200` |
   | frozen | – | `STAIR_STATE_COLOR.not_measured` |
4. 즉시 정지 줄: `liveEmergencyText(live, stair.auto_stop?.emergency)`가 있으면 `text-sm text-slate-700`.
5. 보류 줄: `suspended_seconds > 0`이면 `ko.report.stair.stopSuspendedLine(n)` 회색.

자동 정지를 끈 run(`stair.auto_stop` 없음 또는 두 칸 null): 서버가 `next_fail_stops=false`·`emergency_now=null`을 주고 `liveEmergencyText`가 em 없음으로 null → 머리 줄 + 칩만(별도 분기 불필요, 테스트로 고정).

`RunDetailPage`: `r.status === "running" && r.auto_stop_live && r.profile.stair`일 때 `<PageSection ariaLabel={title} title={title} className="mb-6"><StairLivePanel live={r.auto_stop_live} stair={r.profile.stair} /></PageSection>`를 라이브 궤적보다 위에(첫 배치 전에도 보이게 `liveSeconds` 조건 밖).

- [ ] **Step 1: 실패하는 테스트 작성**
  - `StairLivePanel.test.tsx`:
    - `renders_head_chips_forecast`: 10계단·`[ok×4, unconfirmed, measuring, pending×4]`·`current_step 5`·`next_fail_stops` → 텍스트 `"계단 6/10 (600 req/s) 측정 중 · 1–4 정상 · 5 실패(다음 계단 확인 중) → 6계단이 실패하면 자동 정지"` 포함, `getAllByRole("listitem")` 10개, 5번째 `aria-label == "5계단 실패(다음 계단 확인 중)"`.
    - `auto_stop_off_shows_chips_only`: `stair.auto_stop` undefined, `next_fail_stops false`, `emergency_now null` → `"즉시 정지 감시"`·`"→"` 텍스트 없음, `data-tone="auto-stop"` 없음, 칩은 있음.
    - `stop_line_first_and_no_running_phrase`: `stop` 있음(saturation) → `data-tone="auto-stop"` 요소가 `ol`보다 문서 순서상 앞(`compareDocumentPosition` & `DOCUMENT_POSITION_FOLLOWING`), `"측정 중"` 텍스트 없음.
    - `frozen_line`: frozen → `"판정 중단 — 부하기 데이터 소진"` 표시, 해당 칩 `aria-label`에 `"판정 중단"`.
    - `fifty_steps_wrap`: 50계단 → `ol`에 `flex-wrap` 클래스, `li` 50개.
    - `suspended_line`: `suspended_seconds 4` → `stopSuspendedLine(4)` 글자.
  - `RunDetailPage.test.tsx` `stair_live_panel_only_while_running`: running + `auto_stop_live` → `region` 이름 `"계단 진행"` 있음; **completed + `auto_stop_live` 있음(가드 케이스)** → 없음; completed(키 없음) → 없음; running 계단 아닌 run → 없음; running 계단 run인데 키 생략 → 없음.
- [ ] **Step 2: 실패 확인** — `cd ui && pnpm vitest run src/components/run/__tests__/StairLivePanel.test.tsx src/pages/__tests__/RunDetailPage.test.tsx` — FAIL.
- [ ] **Step 3: 구현** (위 화면 그대로).
- [ ] **Step 4: 통과 확인** — `cd ui && pnpm lint && pnpm test && pnpm build` 녹색.
- [ ] **Step 5: 되돌려 확인** — `RunDetailPage`의 `r.status === "running"` 조건을 지우면 가드 케이스 RED · 칩 `flex-wrap`을 지우면 `fifty_steps_wrap` RED → 원복.
- [ ] **Step 6: 커밋** — `feat(ui): run 상세에 실행 중 계단 패널`.

---

### Task 6: 성능 재측정 (spec §7 1–3, 「켬」 + 이제 감시가 생기는 「끔」)

**Files:**
- Modify: `crates/controller/src/stair_monitor.rs` `mod perf` (배치마다 `live()` + `send_replace` 포함해 잰다)
- Modify: `scripts/bench-throughput.sh:188` (`queue_max` 로그 재시도를 `AUTO_STOP=off`에도 — 이제 끔도 감시가 생겨 「auto-stop monitor finished」 줄이 늦게 온다)
- 결과: `.superpowers/sdd/stage-live-panel-perf.md` (마무리 때 build-log로 옮김)

**Interfaces:** Task 2 `StairMonitor::live`.

- [ ] **Step 1: 마이크로벤치 확장** — `perf::run`의 배치 루프에서 `on_msg` 뒤 `tx.send_replace(m.live())`(테스트 안 `watch::channel`)를 같은 `Instant` 구간에 넣는다. Run: `cargo test -p handicap-controller --release monitor_batch_cost -- --ignored --nocapture`. 통과: p99 < 5 ms, 판정 배치 max < 5 ms(b 값 p99 1.07–1.11 ms와 나란히 기록).
- [ ] **Step 2: 종단 A/B** — 측정 전 다른 빌드 없음 확인(`ps -Ao pcpu,comm | grep -E 'syspolicyd|XprotectService|rustc|cargo'`). master 바이너리는 메인 체크아웃(`/Users/sgj/develop/handicap`, master)에서 `CARGO_TARGET_DIR=<절대경로 /tmp/handicap-master-target> cargo build -p handicap-controller -p handicap-worker` (메인 체크아웃 파일을 바꾸지 말 것). `scripts/bench-throughput.sh`로 b와 같은 조건(부하기 2대, 응답기 지연 5 ms, 1440→7200 req/s 5계단) **① master `AUTO_STOP=on` ② c `AUTO_STOP=on` ③ c `AUTO_STOP=off`** 각 5회 교차. 통과(①의 회차 폭 대비): 계단별 달성 평균 차 ≤ 폭 · 부하기 CPU 차 ≤ 폭 · 컨트롤러 CPU 증가 ≤ 폭 ∧ ≤ 2%p · 감시 큐 최대 ≤ 워커×2 (②·③ 둘 다 ① 대비).
- [ ] **Step 3: 최악 메모리** — 50계단 × 부하기 4 × 144→7200 × 유지 60초, c `AUTO_STOP=off`(새로 감시가 생기는 갈래), `RSS_EVERY=60`. 통과: finalize 전 RSS가 계단 진행과 무관하게 평평(b 17.7–20.7 MB 대비).
- [ ] **Step 4: 커밋** — 마이크로벤치·스크립트 변경만 `perf(controller): 감시 마이크로벤치에 실행 중 요약 갱신 포함, 끔 갈래 queue_max 재시도` (background). 결과 파일은 커밋하지 않는다.

기준 미달이면 머지하지 않고 원인을 고친다(spec §7 원칙 — 「수용 한계」로 넘기지 않음).

---

## 라이브 검증 (파이프라인 5단계 — US 척추, plan task 아님)

워크트리 자체 바이너리(`./target/debug/controller`, `--ui-dir ui/dist`), 용량·지연 조절 응답기(`/live-verify`).

| US | 절차 | 통과 신호 |
|---|---|---|
| US3-a | 6계단 two_fails, 4계단에서 무너지게 | 실행 중 머리 줄 계단 번호가 진행 · 4 「실패(다음 계단 확인 중)」 + 「→ 5계단이 실패하면 자동 정지」 · 정지 순간 노랑 줄(사유·시각)·「… 중」 사라짐 · 칩 partial/skipped · 끝난 뒤 리포트 행 상태 = 마지막으로 본 칩(잠정 라벨 제외 같은 글자) |
| US3-a' | 한 계단만 튀게(다음 계단 정상) | 「실패(다음 계단 확인 중)」 → 다음 계단 판정 뒤 「튄 계단」 · 리포트도 튄 계단 |
| US3-b | 즉시 정지 켠 run에 지연 주입 | 즉시 정지 줄 값이 오르고 「나쁜 초」 1→2→3 · 첫 계단 상승의 20 미만 초는 「판정 보류」 · 정지 줄 |
| US3-c | 자동 정지를 끈 계단 run | 칩만, 예고·즉시 정지 줄 없음, 끝까지 감 |
| 워커 2대 | 계단 run, 부하기 2대 | 두 워커 시작 전 「첫 데이터 대기 중」, 이후 정상 진행 |
| 비계단 | 일반 run | 패널 없음, `GET` JSON에 키 없음 |
| 극단값 | 50계단·목표 100000 req/s, 1280·400px | 칩 줄바꿈, `document.documentElement.scrollWidth ≤ clientWidth`, 머리 줄 rect 겹침 0 |
| US5 | Task 6 | 기준 표 |

진입 화면: run 상세는 실행 창 「실행」 뒤 이동·목록에서 진입·다시 실행 뒤 진입 세 경로 모두에서 패널 확인. 콘솔 오류 0.
