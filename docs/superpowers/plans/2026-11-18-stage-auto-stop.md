# 계단 시험 b (자동 정지) Implementation Plan

REVIEW-GATE: APPROVED

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 계단 run이 포화(연속 두 계단 실패 / 첫 실패)나 즉시 정지 기준(초 단위 오류율·p99 N초 연속)에 걸리면 컨트롤러가 run을 멈추고, 상태 「완료」 + 정지 기록을 영속해 리포트·CSV·XLSX·인쇄·run 상세/목록에 정직하게 보인다. 성능 저하 없음을 수치로 증명한다.

**Architecture:** a의 `build_stair_report` 워커별 반복을 `StairAccumulator`로 뽑아 리포트(DB 행)와 감시(받은 MetricBatch)가 같은 누적·`judge`를 쓴다. 계단+`auto_stop` 켜진 run만 coordinator가 감시 작업(별도 tokio task, 무제한 채널)을 띄우고, `ingest_metrics`가 DB 쓰기 뒤 배치를 소유권째 넘긴다. 감시는 워커 수위(받은 open-loop 초 최댓값)로 데이터 완결을 판단해 계단을 하나씩 판정·초마다 즉시 정지를 보고, 정지는 `CoordinatorState::auto_stop()`만 실행한다. 자동 정지 run은 전 워커 end-phase까지 finalize를 미루고 migration 0025 `runs.auto_stop_json`에 status와 한 UPDATE로 기록한다. 리포트는 기록의 `judged_through` 뒤 계단을 판정 밖으로 강제하고 `emergency_stopped`·`partial`·`skipped` 상태를 더한다. **엔진·워커·worker-core·proto 무변경.**

**Tech Stack:** Rust(tokio mpsc unbounded, hdrhistogram, sqlx SQLite, axum, rust_xlsxwriter 기존), TypeScript/React(Zod, vitest+RTL), bash(bench).

**Spec:** `docs/superpowers/specs/2026-11-18-stage-auto-stop-design.md` §4–§7·§9–§11(b만; §8 = c, 범위 밖 — b가 c를 막지 않게 감시 객체 생성 조건을 한 함수 `monitor_wanted`로 둔다). 규칙 정본은 spec — 이 plan과 다르면 spec이 이긴다(단 아래 「spec 대체 결정」은 orchestrator 결정으로 spec을 대체); 다른 차이를 발견하면 STOP하고 orchestrator에 보고. 선행 a: plan `2026-11-18-stage-saturation-table.md`·spec `2026-11-18-stage-saturation-table-design.md`.

## Global Constraints

- **엔진·워커·worker-core·proto diff 0** (spec §9.1). 확인: `git diff --stat $(git merge-base master HEAD)..HEAD -- crates/engine crates/worker crates/worker-core crates/proto` 출력 0줄(orchestrator가 매 task 뒤·최종에 직접 실행).
- **계단 아닌 run 바이트 동일**: `RunResponse`·리포트 JSON·CSV·XLSX·인쇄. 새 직렬화 필드는 전부 `skip_serializing_if = "Option::is_none"`(키 생략) — 단 `AutoStopConfig` 안 `saturation`·`emergency`와 기록 안 `stop`·`mode`·`phase`·`emergency`는 **항상 키가 있고 끄면 `null`**(spec §4.1·§4.6).
- `auto_stop` **absent = 둘 다 끔**(a 저장본 바이트 동일). 새 계단 run의 기본 켜짐은 **UI가 채운다**(`two_fails` + 5 % · 2000 ms · 3초 · 20개). 「다시 실행」·프리셋 불러오기·스케줄 편집은 **저장된 그대로**.
- `EmergencyStop` 범위(검증 = `validate_stair`, 400, 한국어): `error_rate_pct` 0 < x ≤ 100(유한, 소수 허용, 기본 5) · `p99_ms` 1..=600_000(기본 2000) · `consecutive_seconds` 1..=60(기본 3) · `min_requests` 1..=100_000(기본 20).
- 즉시 정지 판정: 판정 보류 = `Σcount < min_requests`(0 포함, 계수를 끊지도 늘리지도 않음). 나쁜 초 = `errors·100 > pct·count`(f64) ∨ `p99_us > p99_ms·1000` — **엄격한 초과, 같으면 정상**.
- 실패 계단 `fail(i)` = 완결 ∧ (`states[i] ∈ {Saturated, Unconfirmed, Spike}` ∨ (`After` ∧ 사유 있음)). 마지막 계단까지 완결이면 포화 정지 없음. 같은 처리 순간 두 정지가 다 성립하면 **즉시 정지가 이긴다**.
- 데이터 완결(spec §4.4): 워커 수위 = 받은 open-loop 초 최댓값. 초 t 완결 = 모든 활성 워커 수위 ≥ t. 계단 i 완결(워커 w) = 수위 ≥ `hi_i(w)−1` ∧ (`max_scheduled(w) ≥ hi_i(w)−1` ∨ w의 계단 i 몫 = 0). 끝난 워커 = 수위 ≥ `floor((t0_ms + 전체 계단 ms)/1000) − 1` 또는 end-phase 보고 → 이후 모든 초·계단 완결. 그 경계 **전** end-phase = 포화 판정 동결(`judged_through` 고정, 즉시 정지는 계속). 등록 미달(시작 시각 보낸 워커 < `expected`) = 판정 안 함. 초 버퍼·시작 시각 전 보류 행 버퍼 상한 **30초**(넘으면 가장 오래된 초부터 버림 → 초 버퍼는 보류로 셈, 보류 행은 `warn!`).
- 감시 객체는 계단 run이고 `auto_stop` 칸이 하나라도 켜졌을 때만(c가 넓힌다 — 조건은 `stair::monitor_wanted(&StairConfig) -> bool` 한 곳).
- 정지 실행은 `CoordinatorState::auto_stop()`만 — 한 잠금 블록에서 `abort_requested = true`·`auto_stop = Some(..)`·송신자 복사, 잠금 밖에서 `fan_out_abort`(사유 `"auto stop: …"`). 감시 모듈은 `fan_out_abort`를 부르지 않는다(grep 게이트).
- 저장: migration **0025** `runs.auto_stop_json TEXT NULL`(Rust `ensure_*` 가드, 멱등). `auto_stop_json`은 status `completed`일 때만 의미 — API·리포트는 그 외 status에서 싣지 않는다. 기록 쓰기 = `UPDATE runs SET status='completed', ended_at=?, auto_stop_json=? WHERE id=? AND status IN ('pending','running')`, **바뀐 행이 1개일 때만** verdict 배지.
- 성능(spec §7): 감시 배치당 처리 p99 < 5 ms(워커 4 × 50계단, 스텝 16 window + open-loop 초 2개, 실제 크기 HDR) · A/B 각 5회, 계단별 달성 RPS·부하기 CPU 차이 ≤ ①의 잡음 폭(5회 최대−최소) · 컨트롤러 CPU 증가 ≤ 잡음 폭 **그리고** ≤ 2%p · 감시 큐 최대 ≤ 워커 수 × 2 · 50계단 × 워커 4 × 유지 60초 RSS finalize 전까지 평평. 기준 미달 = 머지 안 함.
- **dead code 금지**(pre-commit `clippy --all-targets -D warnings`): Task 1·4·5·6이 만드는 항목은 Task 8 배선 전까지 테스트 밖에서 안 쓰인다 → `stair`·`stair_monitor`·`auto_stop`(모두 `pub mod`)의 새 항목은 **`pub`**으로 둔다(pub mod의 pub 항목은 dead code 경고 대상 아님). `pub`이 부자연스러운 private 보조만 `#[allow(dead_code)] // Task 8에서 제거`. Task 8이 제거하고 grep으로 0건 확인.
- 문구는 `ui/src/i18n/ko.ts` 경유(ADR-0035), 보고서에 찍히는 문구(정지 줄·행 상태)는 보고서 문체(working-rules §8). 화면·정지 줄의 계단 번호는 1부터(`index+1`) — spec 예시 `failed_steps [6,7]` = 「7·8계단」. (CSV `index` 열은 a 선례대로 0부터 — §B 기록.)
- Zod: 서버가 키를 생략하는 필드 = `.optional()`, 항상 직렬화되는 `Option` = `.nullable()`(spec §5.5). `StairConfigSchema`·`StairStepSchema`·`StairReportSchema`는 `.strict()` → 새 키 추가 필수.
- 테스트: DB를 쓰는 테스트에 `tokio::time::pause()` 금지(sqlx `PoolTimedOut`, `crates/controller/CLAUDE.md` §테스트). 감시 규칙은 **합성 배치 시각**으로 구동(가상 시간 불필요). 회귀 가드는 「되돌려 확인」(고친 코드를 옛 상태로 → RED → 원복 → GREEN)을 실행한다.
- Rust: `cargo fmt`, `clippy -D warnings`(2-arm `match … _ => {}` 대신 `if let`). UI: 테스트 파일 편집을 그 task의 **첫 편집**으로(tdd-guard), 커밋 전 `cd ui && pnpm lint && pnpm test && pnpm build`.
- 커밋: implementer는 FOREGROUND 단일 호출(600000ms). `git add <명시 경로>` → 메시지 파일 → `git commit -F <파일>; echo exit=$?` → `git log -1`. `| tail`/`| head` 금지, `--no-verify` 금지. 메시지 끝 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. 부재 중 새로 정한 것은 본문에 "부재 중 판단: …" 한 줄(working-rules §9).
- 결함을 변호하는 주석 금지(working-rules §7).

## spec 대체 결정 (orchestrator 2026-11-18)

- **정지 줄 표기**(spec §5.3 예시를 대체): 판정 계단·마지막 정상 계단 = `N계단(T req/s)`. 실행 안 함 계단은 항상 끝까지 이어지므로 1개 = `N계단`, **2개 이상 = `a–b계단`**(en dash) — spec의 「4개 이상이면 범위」를 대체(spec 자신의 예시 「9–10계단」·「6–10계단」과 일치). 일부 실행 = `N계단 상승 S초 진입 후 멈춤`. 오류율·p99는 a 표와 **같은 표기기**(오류율 = 0.1% 내림, 0이 아닌데 0.0%면 `<0.1%`; p99 = 화면 `formatMs`와 같은 규칙).
- **【내 판단】 내보내기 시각**: CSV·XLSX의 정지 시각은 UTC RFC3339(a 선례 `stair_iso` — 같은 CSV의 측정 구간 열과 맞춤), 화면·인쇄는 지역 `HH:MM:SS`.

## Brief 첨부 (orchestrator)

모든 brief에 spec `## 사용자 스토리 (US)` 블록 + 위 Global Constraints + 「spec 대체 결정」. 추가로 spec 원문 절: Task 1 → §4.3 · Task 2 → §4.1 · Task 3 → §4.2·§4.6 기록 JSON · Task 4·5·6 → §4.2(b)·§4.4·§4.5 · Task 7 → §4.6 · Task 8 → §4.5 · Task 9 → §4.6 · Task 10 → §5.1·§5.2 · Task 11 → §5.3·§5.4 · Task 12 → §5.5 · Task 13·14 → §5.2·§5.3·§5.4 · Task 15 → §5.4 · Task 16·17 → §6 · Task 18·19 → §7.

## Review Focus

1. **시작 시각이 어긋난 워커들의 즉시 정지** — 늦은 워커의 앞 계단이 반 넘게 측정됐어도 리포트 판정에 들어가면 「실행 중 판정 = 리포트 판정」이 깨진다. → Task 10 `forced_boundary_skewed_t0_emergency`.
2. **자동 정지 직후 사용자가 중단을 누름(R1)** — 한 워커가 Aborted(미룸)·다른 워커가 자연 Completed면 backstop까지 매달리면 안 된다. → Task 9 `auto_stop_then_external_abort_then_natural_completed_finalizes_aborted`.
3. **부하기 하나가 데이터셋 소진으로 먼저 끝남** — 소진 뒤 완료 꼬리가 진행 중 계단을 오염시켜 거짓 포화 정지가 나면 안 된다. → Task 5 `early_end_phase_freezes_saturation`·`schedule_evidence_blocks_tail_completion`.
4. **a 시절 계단 run을 「다시 실행」·프리셋으로 다시 엶** — 말없이 자동 정지가 켜지면 안 되고, 새 계단 run은 기본 켜짐이어야 한다. → Task 16 `draft_from_config_without_auto_stop_is_off`·`defaults_auto_stop_on`.
5. **첫 계단 상승 첫 초처럼 표본이 몇 개뿐인 초** — 거짓 즉시 정지·연속 계수 끊김 둘 다 없어야 한다. → Task 3 `held_seconds_skip_without_breaking_streak`·`min_requests_boundary`.

---

## b1 — 누적기·규칙·감시

### Task 1: 공유 누적기 `StairAccumulator` (리팩터, 사용자 변화 0) — code-quality 리뷰 `opus`

**Files:**
- Modify: `crates/controller/src/stair.rs`(`WorkerView` `:463`, `step_of` `:472`, `measure_window` `:500`, `StepAcc` `:514`, `build_stair_report` `:560`의 워커별 반복)
- Test: `crates/controller/src/report.rs` `mod tests::stair_report`(`:3520`, fixture 재사용) — 새 테스트만 추가, **기존 테스트 무수정**

**Interfaces:**
- Produces (`stair.rs`, **`pub`** — dead code 규칙):
  ```rust
  #[derive(Clone, Copy, Debug, PartialEq, Eq)]
  pub enum Bound { Upto(i64), Open }      // Upto = 리포트(a의 `last`), Open = 감시(측정 구간 끝까지)
  pub struct StepDetail { /* throughput, launched_rate, p50_us, p95_us, head_p99_us, rest_p99_us, measured_seconds */ }
  pub struct StairAccumulator { /* cfg, detail: bool, workers: BTreeMap<String, WorkerAcc>, released: Vec<Option<StepNumbers>> */ }
  impl StairAccumulator {
      pub fn new(cfg: &StairConfig, detail: bool) -> Self;   // detail=true: 리포트용
      pub fn set_worker(&mut self, w: &str, t0_ms: i64, bound: Bound);
      pub fn push_open_loop(&mut self, w: &str, ts: i64, launched: i64, completed: i64, dropped: i64);
      pub fn push_metric(&mut self, w: &str, ts: i64, count: i64, errors: i64, h: Option<&Histogram<u64>>);
      pub fn window(&self, w: &str, i: usize) -> Option<(i64, i64)>;     // 계단 i 측정 초 [lo, hi)
      pub fn numbers(&self, complete: &[bool], open_loop_unknown: bool) -> Vec<StepNumbers>;
      pub fn details(&self) -> Vec<StepDetail>;
      /// 감시: 판정 끝난 계단 i의 `StepNumbers`(complete=true)를 캐시하고 그 계단 HDR·계수를 해제(§4.4 메모리).
      /// 이후 `numbers()`는 i에 캐시값을 돌려준다 — `judge`가 앞 계단 p99를 `prev_ok`로 읽으므로 필수.
      pub fn release_step(&mut self, i: usize, open_loop_unknown: bool);
  }
  ```
  계수 입력은 **DB 표현(i64)** — 음수는 0, 포화 덧셈(기존 `add`/`nonneg`). 감시는 pb `u64`를 ingest와 같은 `as i64`로 바꿔 넣는다(비트 동일성 조건 (2)). 계단 배정은 `WorkerAcc` 안 한 곳(`step_of`)뿐. **f64 나눗셈·합은 `numbers()`/`details()` 안에서 `workers`(BTreeMap = worker_id 정렬) 순서로만**(조건 (1)). `numbers()`의 `measured` = `complete[i] && 2·min_secs ≥ hold−discard && !(unknown && count==0)`. `build_stair_report`는 a와 같은 사전 패스(활성·t0·`last`) 뒤 `set_worker(w, t0, Bound::Upto(last))`로 밀어 넣고 `numbers(&vec![true; n], unknown)`·`details()`로 지금과 같은 출력을 만든다(`secs` 1초 띠·`dropped_explained`는 리포트 전용 그대로). `Bound::Open`·`release_step`은 이 task에선 테스트에서만 쓰인다(pub이라 경고 없음).
- [ ] **Step 1: 테스트 작성**(`report.rs` `tests::stair_report`에 추가 — 첫 편집이 테스트):
  - `accumulator_matches_report_bitwise_shuffled`: 워커 3개(t0 서로 다름, 하나는 경계+300 ms), 계단 3개, 각 워커 달성율이 f64 합 순서에 민감한 값(워커별 계단 측정 초당 completed가 `0.1`·`0.2`·`0.3`배 — `(0.1+0.2)+0.3 != 0.1+(0.2+0.3)`)인 행 집합. (1) `build_stair_report` 출력의 완결 계단 숫자(achieved·dropped·error_rate·p99_us·measured)와 (2) 같은 행을 `Bound::Open` 누적기에 **배치 순서·워커 순서를 섞어** 넣은 `numbers(&complete, false)`가 `to_bits()`까지 같음. 섞기 = 테스트 안 xorshift(시드 상수), 시드 8개 반복. 같은 테스트에 계단 0의 achieved를 손계산 리터럴로 한 번 고정(계단 배정 이빨).
  - `accumulator_open_bound_counts_full_window`: `Bound::Open`이면 `window(w,i)` hi = 측정 구간 끝 초(마지막 행과 무관).
- [ ] **Step 2: RED 확인**: `cargo test -p handicap-controller stair_report` → 컴파일 실패(타입 없음).
- [ ] **Step 3: 구현** — 위 시그니처. `build_stair_report` 본문을 누적기 사용으로 바꾼다. a 테스트·골든은 손대지 않는다.
- [ ] **Step 4: GREEN**: `cargo test -p handicap-controller stair_report` + `--test report_test` + `cargo test -p handicap-controller export` + `cargo clippy -p handicap-controller --all-targets -- -D warnings; echo exit=$?`. `git diff -- crates/controller/src/report.rs`에서 기존 테스트 줄 변경 0(새 테스트 추가만)을 orchestrator가 확인.
- [ ] **Step 5: 되돌려 확인 ①** 계단 배정 한 줄(`step_of`의 `lo..hi` → `lo..=hi`) → `accumulator_matches_report_bitwise_shuffled`(리터럴 고정)와 a의 `stair_aligned_t0_counts_measure_seconds` RED → 원복. **②** `numbers()`의 워커 순회를 도착(첫 push) 순서로 → 섞기 테스트 RED(시드 8개 중 하나 이상) → 원복 → GREEN.
- [ ] **Step 6: Commit** — `refactor(controller): 계단 집계를 공유 누적기 StairAccumulator로 — 리포트 출력 불변 (계단 시험 b)`.

### Task 2: `stair.auto_stop` 설정 + 검증 + 5개 진입점 — code-quality `opus`(와이어)

**Files:**
- Modify: `crates/controller/src/stair.rs`(`StairConfig` `:16`, `validate_stair` `:45`), `StairConfig {` 리터럴 전부에 `auto_stop: None`(`grep -rn "StairConfig {" crates/ | grep -v "pub struct"` — 27곳: stair.rs 22·report.rs 2·export.rs 1·schedule/runner.rs 1·tests/export_routes_test.rs 1)
- Test: `crates/controller/src/stair.rs` `mod tests`, `crates/controller/tests/api_test.rs`·`presets_api_test.rs`·`schedules_api_test.rs`, `crates/controller/src/schedule/runner.rs` 테스트(`:567` 계단 발사 테스트 옆)

**Interfaces:**
- Produces:
  ```rust
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub auto_stop: Option<AutoStopConfig>,          // StairConfig 새 필드
  #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
  pub struct AutoStopConfig {
      #[serde(default)] pub saturation: Option<SaturationStopMode>,   // 직렬화 시 항상 키(끄면 null)
      #[serde(default)] pub emergency: Option<EmergencyStop>,
  }
  #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
  #[serde(rename_all = "snake_case")] pub enum SaturationStopMode { TwoFails, FirstFail }
  #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
  pub struct EmergencyStop { pub error_rate_pct: f64, pub p99_ms: u32, pub consecutive_seconds: u32, pub min_requests: u32 }
  pub fn monitor_wanted(c: &StairConfig) -> bool;   // b: auto_stop의 칸이 하나라도 Some. c가 "항상 true"로 넓힌다.
  ```
  `validate_stair`에 범위 검사 가산(Global Constraints 값, 한국어 문구, 예: 「즉시 정지 오류율은 0 초과 100 이하여야 합니다」). `expand_stair`·워커 `stages` 무변경.
- [ ] **Step 1: 테스트**: `validate_rejects_bad_auto_stop`(error_rate_pct 0·−1·100.01·NaN, p99_ms 0·600_001, consecutive 0·61, min_requests 0·100_001 각각 Err), `validate_accepts_auto_stop_boundaries`(0.01·100·1·600_000·1·60·1·100_000), `auto_stop_absent_bytes_unchanged`(a 형태 StairConfig JSON 문자열 → 역직렬화 → 재직렬화가 입력과 바이트 같음, `auto_stop` 키 없음), `auto_stop_inner_keys_always_present`(`{saturation: None, emergency: Some}` 직렬화 → `as_object().contains_key("saturation")` ∧ null — `crates/controller/CLAUDE.md` §테스트 `contains_key` 함정), `auto_stop_input_keys_may_be_omitted`(`{"auto_stop":{}}` → 둘 다 None), `monitor_wanted_table`(absent·{None,None} → false; 한 칸 Some → true). API: run 생성·프리셋 생성·수정·스케줄 생성·수정 각각 auto_stop 포함 stair 저장 → 응답/재조회 profile의 `stair.auto_stop`이 보낸 값과 같음 + 범위 밖 값 400; 스케줄 발사(`schedule/runner.rs`)는 auto_stop 있는 저장본 1회 발사 → 만든 run의 profile에 그대로.
- [ ] **Step 2: RED**, **Step 3: 구현**(리터럴 sweep 포함), **Step 4: GREEN**: `cargo test -p handicap-controller stair` + `--test api_test --test presets_api_test --test schedules_api_test` + `cargo test --workspace --no-run`.
- [ ] **Step 5: Commit** — `feat(controller): stair.auto_stop 설정·검증 (포화 정지 방식·즉시 정지 기준)`.

### Task 3: 순수 정지 규칙 + 정지 기록 타입 — code-quality `opus`(기록 = 와이어)

**Files:**
- Create: `crates/controller/src/auto_stop.rs`(+ `crates/controller/src/lib.rs` `pub mod auto_stop`)
- Test: 같은 파일 `#[cfg(test)] mod tests`

**Interfaces:**
- Produces (전부 `pub`):
  ```rust
  pub fn step_failed(j: &Judgement, i: usize) -> bool;  // states ∈ {Saturated,Unconfirmed,Spike} ∨ (After ∧ !reasons.is_empty())
  pub struct SaturationStop { pub failed_steps: Vec<usize>, pub decided_step: usize, pub slot_limited: bool }
  pub fn saturation_stop(j: &Judgement, done: &[bool], mode: SaturationStopMode) -> Option<SaturationStop>;
  pub struct EmergencyHit { pub last_bad_ts: i64, pub max_error_rate: f64, pub max_p99_us: u64,
                            pub seconds: u32, pub error_hit: bool, pub p99_hit: bool }
  pub struct EmergencyTracker { /* streak 상태 */ }
  impl EmergencyTracker {
      pub fn new(c: &EmergencyStop) -> Self;
      pub fn observe(&mut self, ts: i64, count: u64, errors: u64, p99_us: u64) -> Option<EmergencyHit>; // 보류 초는 None·상태 불변
  }
  // 기록(직렬화 = 와이어, spec §4.6 JSON 그대로 — Option은 null로 항상 직렬화). Serialize + Deserialize.
  #[serde(rename_all = "snake_case")] pub enum StopKind { Saturation, Emergency }
  pub struct EmergencyStats { pub max_error_rate: f64, pub max_p99_us: u64, pub seconds: u32, pub error_hit: bool, pub p99_hit: bool }
  pub struct StopInfo { pub kind: StopKind, pub mode: Option<SaturationStopMode>, pub failed_steps: Vec<u32>,
                        pub decided_step: u32, pub judged_through: i64, pub phase: Option<BandKind>,
                        pub decided_at_ms: i64, pub stopped_at_ms: i64, pub emergency: Option<EmergencyStats>,
                        pub slot_limited: bool }
  pub struct AutoStopRecord { pub stop: Option<StopInfo>, pub suspended_seconds: u32 }
  ```
  `saturation_stop`: `done` 전부 참이면 None. `two_fails` = 완결 이웃 i,i+1이 둘 다 실패인 가장 이른 i → `[i,i+1]`, decided `i+1`; `first_fail` = 가장 이른 실패 i → `[i]`, decided `i`. `slot_limited` = 실패 계단 중 하나라도 `j.slot_limited`. `error_hit`/`p99_hit` = 연속 N초 중 한 초라도 그 조건(OR), 최대값은 그 N초에서.
- [ ] **Step 1: 표 테스트**(헬퍼: `steps(&[..])`로 `StepNumbers` + `done`을 만들어 `judge`(`measured = done[i] && …`) 뒤 `saturation_stop`): `two_fails_consecutive`(ok,ok,fail,fail,nm → `[2,3]`, decided 3) · `two_fails_spike_then_continue`(ok,fail,ok,nm → None; 이어서 ok,fail,ok,fail,fail → `[3,4]`) · `two_fails_first_step_fail_then_ok_continues`(fail,ok(After 사유 없음),nm → None) · `two_fails_after_pair_stops`(fail,ok,After사유,After사유 → `[2,3]`) · `two_fails_last_step_done_no_stop`(마지막까지 완결, 끝 둘 실패 → None) · `first_fail_stops_at_first`(ok,fail,nm → `[1]`) · `first_fail_first_step`(fail,nm → `[0]`) · `slot_limited_reason_counts_as_fail`(dropped 사유만 → fail, `slot_limited=true`) · 즉시 정지: `streak_n_seconds_stops`(N=3, 나쁜 초 3개 → Hit, last_bad_ts = 셋째) · `held_seconds_skip_without_breaking_streak`(나쁨, 보류(count 5), 나쁨, 나쁨 → 넷째에서 Hit) · `good_second_resets_streak` · `min_requests_boundary`(count 19 보류 / 20 판정, min 20) · `both_conditions_same_second`(error_hit ∧ p99_hit) · `equal_to_threshold_is_ok`(errors 1/count 20 at 5 %, p99 = 2_000_000 µs at 2000 ms → 정상) · `record_json_shape`(StopInfo/AutoStopRecord 직렬화 키 집합이 spec §4.6과 같고 `phase`·`mode`·`emergency`·`stop` null일 때 키 존재, 역직렬화 round-trip).
- [ ] **Step 2: RED**, **Step 3: 구현**, **Step 4: GREEN**: `cargo test -p handicap-controller auto_stop` + `cargo clippy -p handicap-controller --all-targets -- -D warnings; echo exit=$?`.
- [ ] **Step 5: 되돌려 확인** — ① `observe`에서 보류 초가 streak를 0으로 끊게 → `held_seconds_skip_without_breaking_streak` RED ② `>`를 `>=`로 → `equal_to_threshold_is_ok` RED ③ "마지막 계단까지 완결이면 None" 줄 삭제 → `two_fails_last_step_done_no_stop` RED. 각각 원복.
- [ ] **Step 6: Commit** — `feat(controller): 자동 정지 순수 규칙(포화 정지·즉시 정지)·정지 기록 타입`.

### Task 4: 감시 수신 — 중복·타당성·시작 전 보류 행 (4a) — code-quality `opus`

**Files:**
- Create: `crates/controller/src/stair_monitor.rs`(+ `lib.rs` `pub mod stair_monitor`)
- Modify: `crates/controller/src/grpc/coordinator.rs` — ingest의 시각 필터 두 개를 공유 함수로 추출(동작 불변): open-loop 초 필터(`:1968` `plausible_s`, 상수 `OPEN_LOOP_CLOCK_SKEW_S` `:1929`) → `pub fn plausible_second(ts: i64, now_s: i64) -> bool`, 시작 시각 필터(`:2008`, 상수 `:1931–1932`) → `pub fn plausible_start(ms: i64, now_ms: i64) -> bool`.

**Interfaces:**
- Consumes: Task 1 누적기(`Bound::Open`), Task 2 설정.
- Produces (`pub`):
  ```rust
  pub enum MonitorMsg {
      Batch(pb::MetricBatch),
      Worker { worker_id: String, step_targets: Vec<u32> },  // 워커별 계단 몫(축소된 hold stage target)
      WorkerEnded { worker_id: String },
  }
  #[derive(Debug, Default)] pub struct Outcome { pub stop: Option<StopInfo /* stopped_at_ms = 0, coordinator가 채움 */>, pub newly_suspended: u32 }
  pub struct StairMonitor { /* acc, watermarks, max_scheduled, prev_max_ts, pending(시작 전 행), shares, ended, … */ }
  impl StairMonitor {
      pub fn new(cfg: &StairConfig, expected: u32) -> Self;   // cfg는 monitor_wanted
      pub fn on_msg(&mut self, msg: MonitorMsg, now_ms: i64) -> Outcome;   // 이 task: 수신만, 판정 없음(Outcome 기본값)
  }
  ```
  수신 규칙 — **ingest와 정확히 같은 필터만**(spec §4.3 (2)): open-loop 초는 `plausible_second`로 거른다, 시작 시각은 `plausible_start`로 거른다(0 = 없음), **metric window는 ingest가 받은 그대로 저장하므로 감시도 시각으로 거르지 않는다**. 중복 = 워커별 「이전 배치까지 받은 최대 초」보다 **이전** 초 행은 버림(한 배치 안 여러 초는 모두 받음, metric·open-loop 각각). t0 = 첫 유효 `open_loop_started_at_ms`(첫 값 유지 — `insert_worker_start` INSERT OR IGNORE와 같음). t0 전 행은 워커별 보류 버퍼(30초 분량 초과 시 가장 오래된 초부터 버리고 `warn!`), t0가 오면 `set_worker(w, t0, Bound::Open)` 뒤 재생. 수위 = 받은 open-loop 초 최댓값, `max_scheduled` = launched>0 ∨ dropped>0인 초 최댓값. `MonitorMsg::Worker`가 두 번 오면(Resend 재등록이 `assignment_for`를 다시 부름) **첫 값 유지**.
- [ ] **Step 1: 테스트**(`stair_monitor.rs` `#[cfg(test)]`; 헬퍼 `batch(w, start_ms, ol: &[(ts,l,c,d)], win: &[(ts,count,err,p99_us)])` — HDR은 `fresh_hist`+V2Serializer로 인코딩; 상태 확인은 `#[cfg(test)]` 접근자): `duplicate_older_second_ignored`(이전 배치 최대 초보다 이른 초 행 재전송 → 누적 불변) · `same_batch_many_seconds_all_taken` · `implausible_open_loop_second_and_start_dropped`(시계에서 하루 넘게 먼 open-loop 초·30일 넘게 오래된 시작 시각 → 버림) · `metric_windows_not_time_filtered`(먼 시각 window도 ingest처럼 받음) · `pending_rows_before_start_replayed` · `pending_rows_cap_30s`(31초 분량 → 가장 오래된 초 버림) · `start_time_first_value_kept` · `worker_msg_twice_first_kept` · `ingest_filters_unchanged`(coordinator 기존 `ingest_stores_open_loop_seconds_and_start` 등 그대로 green — 추출이 동작 불변).
- [ ] **Step 2: RED**, **Step 3: 구현**, **Step 4: GREEN**: `cargo test -p handicap-controller stair_monitor` + `cargo test -p handicap-controller ingest` + `cargo clippy -p handicap-controller --all-targets -- -D warnings; echo exit=$?`.
- [ ] **Step 5: 되돌려 확인** — 중복 규칙 제거 → `duplicate_older_second_ignored` RED → 원복.
- [ ] **Step 6: Commit** — `feat(controller): 계단 자동 정지 감시 수신 — ingest와 같은 중복·시각 규칙`.

### Task 5: 감시 데이터 완결 + 계단 단위 포화 판정 (4b) — code-quality `opus`

**Files:**
- Modify: `crates/controller/src/stair_monitor.rs`
- Create: `crates/controller/tests/stair_watermark_test.rs`

**Interfaces:**
- Consumes: Task 3 `saturation_stop`·`StopInfo`, Task 4.
- Produces: `pub fn judged_through(&self) -> i64`(판정에 넣은 마지막 계단, 없으면 −1). 계단 완결은 Global Constraints 규칙(끝난 워커 `−1` 경계·end-phase·스케줄 증거·몫 0 포함), 완결 집합은 앞에서부터 이어진 것만(`done[i] = complete(i) ∧ done[i−1]`). 새로 완결된 계단마다 **한 계단씩** `acc.numbers(&done_upto_i, false)` → `judge` → `saturation_stop`, 첫 정지에서 멈춤(saturation 기록의 `judged_through = decided_step`). 판정한 계단은 `release_step(i, false)`. 시간 경계 **전** `WorkerEnded` → 포화 판정 동결(이후 포화 정지 없음, `judged_through` 고정). 등록 미달이면 판정 안 함.
- [ ] **Step 1: 테스트**(워커 2개 `expected=2`, cfg ramp 1·hold 20·discard 5 정도):
  - `late_worker_blocks_judging_then_judges`: w0만 계단 0·1 끝까지 → 정지 없음·`judged_through == −1`; w1 도착 → 판정.
  - `registration_shortfall_no_judging`: 시작 시각 보낸 워커 1 < expected 2 → 판정 안 함.
  - `two_fails_stops_at_pair`: 계단 2·3 지연 실패 → 계단 3 완결 배치에서 `stop.kind == Saturation`, `failed_steps == [2,3]`, `judged_through == 3`.
  - `first_fail_stops_and_judged_through_is_decided`: first_fail → 계단 2 완결에서 정지, `judged_through == 2`.
  - `one_message_completes_two_steps_first_fail`: first_fail, **k ≥ 1(앞에 정상 계단이 있어야 Spike 판정이 가능 — `stair.rs` judge `last.is_some()`)**, 한 메시지(늦던 w1의 배치)가 계단 k(실패)와 k+1(정상)을 함께 완결 → `judged_through == k`, 그리고 이 `judged_through`로 강제한 입력(`i > k` → measured=false)의 `judge` 머리말 == `Unconfirmed`(한 번에 판정해 `judged_through = k+1`이면 계단 k가 Spike가 되어 「포화 확인 못 함」을 잃는다).
  - `finished_worker_boundary_minus_one`: w0 수위 = `floor((t0+total)/1000)−1`이면 이후 완결로 침(판정 진행), `−2`면 아님.
  - `end_phase_worker_counts_complete`: 시간 경계에서 `WorkerEnded` → 판정 진행.
  - `early_end_phase_freezes_saturation`(spec §9.5 fixture): w1이 데이터셋 소진으로 진행 중 계단을 절반 넘게 측정한 뒤 경계 전 `WorkerEnded`, 그 전 몇 초 completed-only 꼬리 → 이후 w0 쪽 숫자가 연속 실패처럼 보여도 포화 정지 없음, `judged_through` 고정.
  - `schedule_evidence_blocks_tail_completion`: 꼬리가 계단 측정 구간 끝을 넘고 end-phase 전에 꼬리 배치가 옴(수위 충족, `max_scheduled` 미달) → 그 계단 미완결.
  - `zero_share_worker_completes_without_evidence`: 계단 몫 0 워커는 증거 없이 완결.
  - `release_keeps_numbers_for_prev_ok`: 계단 0 판정·해제 뒤 계단 1 판정이 계단 0 p99를 기준으로 씀(해제 전후 `numbers()[0]` 같음).
  - `monitor_matches_report_for_completed_steps`: 같은 행 집합을 배치로 감시에 넣어 판정에 쓴 숫자(`#[cfg(test)]` 접근자) == `build_stair_report`의 같은 계단 숫자.
  - 통합 `stair_watermark_test.rs` `watermark_implies_windows_arrived`: wiremock 응답기 + `handicap_engine::run_scenario_open_loop`(stages = 짧은 계단 2개, 약 6초)로 받은 `MetricFlush` 열에서, 각 flush k까지의 open-loop 초 최댓값 W_k에 대해 k 뒤 flush의 window `ts`가 모두 `> W_k`(spec §4.4 성질 — 엔진 diff 0).
- [ ] **Step 2: RED**: `cargo test -p handicap-controller stair_monitor` + `--test stair_watermark_test`.
- [ ] **Step 3: 구현**, **Step 4: GREEN**: 위 + `cargo clippy -p handicap-controller --all-targets -- -D warnings; echo exit=$?`.
- [ ] **Step 5: 되돌려 확인** — ① 동결 분기 제거 → `early_end_phase_freezes_saturation` RED(거짓 포화 정지) ② 스케줄 증거 조건 제거 → `schedule_evidence_blocks_tail_completion` RED ③ `−1` 경계를 `−0`으로 → `finished_worker_boundary_minus_one` RED ④ 새로 완결된 계단을 한 번에 `judge`하고 `judged_through` = 마지막 완결 계단으로 → `one_message_completes_two_steps_first_fail` RED ⑤ `release_step` 캐시 제거(해제 계단을 빈 숫자로) → `release_keeps_numbers_for_prev_ok` RED. 각각 원복.
- [ ] **Step 6: Commit** — `feat(controller): 감시 데이터 완결(수위·스케줄 증거·동결) + 계단 단위 포화 판정`.

### Task 6: 감시 즉시 정지 — 초 버퍼·보류·두 정지 우선순위 — code-quality `opus`

**Files:**
- Modify: `crates/controller/src/stair_monitor.rs`
- Test: 같은 파일

**Interfaces:**
- Consumes: Task 3 `EmergencyTracker`, Task 5.
- Produces: `StairMonitor` 안 초 버퍼(`BTreeMap<i64, SecAcc{count, errors, hist}>`, 아직 완결 안 된 절대 초). 초 t 완결(Global Constraints — 끝난 워커·end-phase 워커는 완결로 침) 순서대로 `observe`, 감시 범위 = `t·1000 + 1000 > min t0` ∧ `t·1000 < max t0 + 전체 계단 ms`. 버퍼가 **30개 초** 넘으면 가장 오래된 초부터 버리고 `newly_suspended += 1`(판정 없음). 등록 미달 동안도 같은 규칙. 기록: `decided_step`·`phase` = 마지막 나쁜 초 시작(`t·1000`)을 가장 이른 t0 워커 기준 계단·구간(`elapsed < ramp` → Ramp, `< ramp+discard` → Discard, 그 외 Measure; t0 이전이면 계단 0 Ramp), `judged_through` = 그 순간의 `judged_through()`(동결이면 동결값), `emergency` 통계. 한 `on_msg`에서 두 정지가 다 성립하면 즉시 정지 기록을 낸다.
- [ ] **Step 1: 테스트**: `emergency_stops_after_n_bad_seconds` · `emergency_waits_for_slow_worker`(w1 수위가 t 미만이면 그 초 판정 안 함) · `held_second_during_first_ramp_no_false_stop`(첫 상승 초 count 3·오류 3 → 보류) · `buffer_over_30s_suspends_and_resumes`(w1이 40초 늦음 → `newly_suspended` 합 = 10, 버퍼 길이 ≤ 30, w1 따라잡은 뒤 판정 재개) · `finished_worker_does_not_hold_seconds`(시작 시각 어긋난 워커 2개; w0가 시간 기준 끝(`−1` 경계)에 도달 / 변형: w0가 end-phase 보고 → 남은 w1의 꼬리 초가 계속 판정되고(나쁜 초 N개 주면 정지) 전 구간 `newly_suspended == 0`) · `emergency_phase_and_step_from_earliest_t0`(t0 3초 어긋난 두 워커, 나쁜 초가 이른 워커 기준 계단 2 상승 → `decided_step 2`, `phase Ramp`) · `emergency_records_judged_through_at_decision` · `emergency_wins_same_message`(한 배치가 계단 쌍 실패와 N번째 나쁜 초를 동시에 완결 → kind Emergency) · `emergency_continues_after_freeze` · `step_hdr_released_after_judgement`(판정 끝난 계단 HDR `None` — `#[cfg(test)]` 접근자 — **그리고 `numbers()[i]`가 해제 전과 같음**).
- [ ] **Step 2: RED**, **Step 3: 구현**, **Step 4: GREEN**: `cargo test -p handicap-controller stair_monitor` + clippy `--all-targets`.
- [ ] **Step 5: 되돌려 확인** — 버퍼 상한 제거 → `buffer_over_30s_suspends_and_resumes` RED; 끝난 워커를 초 완결 판단에서 빼지 않게 → `finished_worker_does_not_hold_seconds` RED; 우선순위 뒤집기 → `emergency_wins_same_message` RED. 각각 원복.
- [ ] **Step 6: Commit** — `feat(controller): 감시 즉시 정지 — 초 완결·30초 보류 상한·즉시 정지 우선`.

## b2 — 연결·종료·영속

### Task 7: migration 0025 + 저장·`RunResponse.auto_stop` — code-quality `opus`(migration)

**Files:**
- Modify: `crates/controller/src/store/mod.rs`(`ensure_runs_label` `:200` 뒤 새 `ensure_runs_auto_stop_json`, `connect()`의 마지막 `ensure`/execute 뒤 호출), `crates/controller/src/store/runs.rs`(`RunRow` `:258`, `get` `:321`·`list_by_scenario` `:355` SELECT 열, 새 함수), `crates/controller/src/api/runs.rs`(`RunResponse` `:35`, `to_response` `:1386`)
- Test: `store/mod.rs` `mod tests`(`ensure_runs_verdict_json_is_idempotent` 패턴), `store/runs.rs` 테스트, `crates/controller/tests/api_test.rs`

**Interfaces:**
- Consumes: Task 3 `AutoStopRecord`.
- Produces:
  ```rust
  async fn ensure_runs_auto_stop_json(db: &Db) -> anyhow::Result<()>;  // migration 0025 (Rust-guarded): ALTER TABLE runs ADD COLUMN auto_stop_json TEXT
  pub auto_stop: Option<crate::auto_stop::AutoStopRecord>,              // RunRow, 손상 JSON → None
  pub async fn complete_with_auto_stop(db: &Db, id: &str, ended_ms: i64, rec: &AutoStopRecord) -> sqlx::Result<bool>; // 가드 단일 UPDATE, 바뀐 행 1개면 true
  #[serde(skip_serializing_if = "Option::is_none")] pub auto_stop: Option<AutoStopRecord>, // RunResponse, status completed일 때만 채움
  ```
  `/new-migration auto_stop_json` 스킬로 번호(0025)·패턴 확인(3b Rust 가드 경로).
- [ ] **Step 1: 테스트**: `ensure_runs_auto_stop_json_is_idempotent`(두 번 호출 + 열 1개) · `complete_with_auto_stop_guarded`(running → true·status completed·기록 저장 / aborted 행 → false·status·기록 불변) · `get_and_list_carry_auto_stop`(손상 JSON → None) · API `run_response_auto_stop_only_when_completed`(completed+기록 → 키 있음; aborted+기록 → **키 없음**; 기록 없음 → 키 없음 — `as_object().contains_key`) · `non_stair_run_response_bytes_unchanged`(계단 아닌 run 응답 JSON 키 집합 == 변경 전 목록을 리터럴로 적은 것).
- [ ] **Step 2: RED**, **Step 3: 구현**, **Step 4: GREEN**: `cargo test -p handicap-controller store` + `--test api_test`. `grep -n "ensure_runs_auto_stop_json" crates/controller/src/store/mod.rs`가 정의·호출·테스트 3곳 이상.
- [ ] **Step 5: Commit** — `feat(controller): migration 0025 runs.auto_stop_json + 완료 run 응답에 자동 정지 기록`.

### Task 8: coordinator 연결 — 감시 작업·배치 전달·`auto_stop()` — code-quality `opus`(동시성)

**Files:**
- Modify: `crates/controller/src/grpc/coordinator.rs`(`PendingAssignment` `:83`, `RunWorkers` `:199`, `enqueue` `:971`, `assignment_for` `:1070`, `record_phase` `:1141`(end-phase 알림만), `abort` `:1453`, MetricBatch 가지 `:1797`, `ingest_metrics` `:1934`), `crates/controller/src/api/runs.rs`(`PendingAssignment` 리터럴 `:806`), `crates/controller/src/stair_monitor.rs`(작업 함수, Task 1·4·5·6의 `#[allow(dead_code)]` 제거)
- Test: `coordinator.rs` `mod tests`(헬퍼 `seed_run`·`fake_tx`·`base_assignment` `:2411`·`is_abort` 재사용)

**Interfaces:**
- Consumes: Task 4–6 `StairMonitor`, Task 2 `monitor_wanted`.
- Produces:
  ```rust
  pub struct PendingAssignment { …, pub stair: Option<crate::stair::StairConfig> }   // 리터럴 2곳(api/runs.rs, 테스트 base_assignment)
  // RunWorkers 새 필드
  monitor: Option<MonitorHandle>, auto_stop: Option<StopInfo>, external_abort: bool, suspended_seconds: u32,
  #[derive(Clone)] pub struct MonitorHandle { tx: UnboundedSender<MonitorMsg>, queued: Arc<AtomicUsize>, queued_max: Arc<AtomicUsize> }
  /// 한 잠금 블록: external_abort면 false(아무것도 기록 안 함 — finalize는 어차피 aborted);
  /// 아니면 abort_requested=true, stopped_at_ms=now, auto_stop=Some, tx 복사 → 잠금 밖 fan_out_abort("auto stop: …").
  pub async fn auto_stop(&self, run_id: &str, stop: StopInfo) -> bool;
  pub async fn add_suspended(&self, run_id: &str, n: u32);
  async fn ingest_metrics(state, batch: &pb::MetricBatch) -> Option<MonitorHandle>;   // 기존 첫 잠금 블록에서 꺼냄(추가 잠금 0); 기존 테스트 호출부는 반환값 무시
  pub(crate) async fn ingest_and_forward(state: &CoordinatorState, batch: pb::MetricBatch); // DB 쓰기 → 소유권째 send(복사 0)
  // stair_monitor.rs
  pub async fn run_monitor(coord: CoordinatorState, run_id: String, monitor: StairMonitor, rx: UnboundedReceiver<MonitorMsg>, done: CancellationToken, handle: MonitorHandle);
  ```
  `enqueue`: `base.stair`가 `monitor_wanted`면 채널 + `tokio::spawn(run_monitor(..))`(`done` 취소 또는 정지 결정에서 끝, 끝날 때 `info!(run_id, queue_max, batches, "auto-stop monitor finished")`). `assignment_for`: 축소된 pb profile `stages`의 hold stage(`skip(1).step_by(2)`) target을 `MonitorMsg::Worker`로(잠금 안 send — 무제한이라 대기 없음). `record_phase`: end-phase면 `WorkerEnded`(같은 채널이라 그 워커 마지막 배치 뒤 순서 보장). `abort()`: `external_abort = true`(기존 `abort_requested`와 같은 블록). 핸들러 MetricBatch 가지는 `ingest_and_forward(&state, batch)`. **finalize는 바꾸지 않는다**(Task 9).
- [ ] **Step 1: 테스트**: `non_stair_run_has_no_monitor`·`stair_run_without_auto_stop_has_no_monitor`(`#[cfg(test)]` 접근자) · `forward_after_db_write_in_order`(배치 3개 + end-phase → 감시가 받은 순서 = Batch×3, WorkerEnded; 각 Batch 받을 때 그 행이 이미 DB에) · `auto_stop_sets_flags_before_send`(`abort_flag_set_before_sends` `:5513` 거울: 막힌 채널로 송신 중 `record_phase(Aborted)`가 막히지 않고 R8 사유가 안 남음) · `auto_stop_reason_prefix`(워커가 받은 Abort reason이 `"auto stop:"`로 시작) · `auto_stop_after_external_abort_is_noop`(`abort()` 뒤 `auto_stop()` → false, `rw.auto_stop` None, 추가 Abort 송신 없음) · `abort_sets_external_abort` · `auto_stop_on_removed_run_is_noop` · `monitor_task_ends_with_done` · 종단 `two_worker_stair_run_auto_stops`(계단 run 2워커 등록, 계단 2·3 실패 배치를 `ingest_and_forward`로 → 두 워커 모두 Abort 수신).
- [ ] **Step 2: RED**, **Step 3: 구현**, **Step 4: GREEN**: `cargo test -p handicap-controller coordinator` + `cargo test --workspace --no-run` + `cargo clippy -p handicap-controller --all-targets -- -D warnings; echo exit=$?`.
- [ ] **Step 5: grep 게이트**(orchestrator 직접): `grep -n "fan_out_abort" crates/controller/src/stair_monitor.rs` 출력 0 · `grep -n "allow(dead_code)" crates/controller/src/stair.rs crates/controller/src/stair_monitor.rs crates/controller/src/auto_stop.rs` 출력 0 · `grep -n "auto_stop = Some" crates/controller/src/grpc/coordinator.rs`가 `auto_stop()` 안 한 곳.
- [ ] **Step 6: 되돌려 확인** — `auto_stop()`에서 플래그 설정을 송신 뒤로 옮김 → `auto_stop_sets_flags_before_send` RED → 원복.
- [ ] **Step 7: Commit** — `feat(controller): 계단 자동 정지 감시 작업 연결 — 배치 소유권 전달·auto_stop() 단일 경로`.

### Task 9: 미룬 finalize + 기록 영속 + verdict 가드 — code-quality `opus`(동시성)

**Files:**
- Modify: `crates/controller/src/grpc/coordinator.rs`(`record_phase` classify 블록 `:1159`부터·`match decision` `:1250`부터 `worker_disconnected` `:1319` 앞까지)
- Test: `coordinator.rs` `mod tests`(`seed_run_with_criteria` `:2304` 재사용)

**Interfaces:**
- Consumes: Task 7 `complete_with_auto_stop`, Task 8 필드.
- Produces: `Finalize::Completed { record: Option<AutoStopRecord> }`. classify 규칙:
  - `rw.auto_stop.is_some()`이고 phase ∈ {Completed, Aborted}: 그 워커 상태만 기록(`tx.take()`), **전원 end-phase ∧ `workers.len() == expected`**일 때만 finalize(`done.cancel()`도 그때) — 이 트리거는 `external_abort`와 무관. 결과: `external_abort` → `Aborted{self_abort: None}`; 전원 Completed → `Completed{record: (suspended>0).then(stop: None)}`; 그 외(Aborted 섞임) → `Completed{record: Some{stop: rw.auto_stop, suspended}}`.
  - `Failed`·워커 끊김·backstop = 지금 그대로(fail-fast).
  - `auto_stop` 없음 + 지금 Completed 게이트 → `Completed{record: (suspended>0).then(stop: None)}`.
  - 처리: record `Some` → `complete_with_auto_stop` → **true일 때만** verdict(`build_report_for_run` → `set_verdict`); `None` → 지금 경로 그대로(선재 틈은 §B 기록).
- [ ] **Step 1: 테스트**(spec §9.6 전부): `auto_stop_waits_all_end_phase`(w0 Aborted → run 남음·`done` 미취소(`#[cfg(test)]` 접근자); w1 Aborted → completed + 기록 stop 있음) · `auto_stop_all_completed_late_records_null_stop`(정지 뒤 두 워커 Completed → completed, 보류 0이면 기록 NULL) · `auto_stop_mixed_completed_aborted_records_stop` · `auto_stop_with_failed_is_failed` · `external_abort_before_auto_stop_aborted`·`external_abort_after_auto_stop_aborted` · `auto_stop_then_external_abort_then_natural_completed_finalizes_aborted`(R1 — 마지막 Completed에서 즉시 finalize, aborted) · `sibling_last_flush_in_persisted_verdict`(criteria 오류율 기준; w1의 마지막 배치가 오류를 실어 verdict를 실패로 뒤집음 → 영속 verdict `passed == false`. 리포트는 요청 때마다 DB에서 다시 만들어 미룸 없이도 그 배치를 포함하므로, finalize 시점에 영속되는 verdict만이 회귀를 잡는다) · `verdict_skipped_when_update_lost`(finalize 전에 `mark_aborted` → status aborted 유지·verdict NULL) · `suspended_only_natural_completion_records`(감시 보류 3초, 자연 완료 → completed + `{stop:null, suspended_seconds:3}`).
- [ ] **Step 2: RED**, **Step 3: 구현**, **Step 4: GREEN**: `cargo test -p handicap-controller coordinator` + `cargo nextest run -p handicap-controller --features in-process`(풀 e2e — 실행 테스트 수 확인, `crates/controller/CLAUDE.md` §테스트).
- [ ] **Step 5: 되돌려 확인** — ① 미룸 조건을 "첫 end-phase"로 → `sibling_last_flush_in_persisted_verdict` RED ② 전원 end-phase 트리거를 `!external_abort`일 때만으로 → R1 테스트 RED(타임아웃) ③ verdict를 `complete_with_auto_stop` 결과와 무관하게 → `verdict_skipped_when_update_lost` RED. 각각 원복.
- [ ] **Step 6: Commit** — `feat(controller): 자동 정지 run finalize 미룸·status와 한 UPDATE로 기록·verdict 가드`.

## b3 — 리포트·내보내기

### Task 10: 리포트 §5.1 강제 경계 + 새 행 상태 — code-quality `opus`(와이어)

**Files:**
- Modify: `crates/controller/src/stair.rs`(`StairInputs` `:359`, `StepState` `:132`, `StairStep` `:382`, `StairReport` `:365`, `build_stair_report`, `shown` `:722`, `explains` `:756`), `crates/controller/src/api/runs.rs`(`build_report_for_run` `:1077`의 `stair_inputs` 블록 — `auto_stop` 채움), `StairStep {`·`StairReport {` 리터럴(`grep -rn "StairStep {\|StairReport {" crates/` — export.rs 5·stair.rs 4·report.rs 1)
- Create: `testdata/stair_autostop_report_golden.json`(부트스트랩은 a plan Task 6과 같은 방식)
- Test: `report.rs` `tests::stair_report`

**Interfaces:**
- Produces:
  ```rust
  StairInputs { …, pub auto_stop: Option<AutoStopRecord> }   // build_report_for_run: row.status == Completed일 때만 row.auto_stop (Default 유지 → a 테스트 호출부 무변경)
  StepState::{EmergencyStopped, Partial, Skipped}             // serde snake_case
  impl StepState { pub fn shows_numbers(self) -> bool }       // NotMeasured·EmergencyStopped·Partial·Skipped → false
  StairStep { …, #[serde(default, skip_serializing_if = "Option::is_none")] pub partial: Option<PartialRun> }
  pub struct PartialRun { pub seconds: u32, pub phase: BandKind }
  StairReport { …, #[serde(default, skip_serializing_if = "Option::is_none")] pub auto_stop: Option<AutoStopRecord> }
  ```
  기록의 `stop`이 있으면 `judge` 입력에서 `i > judged_through`인 계단을 `measured = false`로 강제 — 따라서 `headline.last_ok_target`(즉시 정지 줄의 「마지막 정상」 출처, Task 11)도 강제 뒤 값이다. 표시 상태(`i > judged_through`): 즉시 정지이고 `i == decided_step` → `EmergencyStopped`; `i > decided_step`이고 계단 시작(가장 이른 t0 + i·계단 ms) < `stopped_at_ms` → `Partial`(`seconds = ceil((stopped − start)/1000)`, `phase` = 경과 ms 기준 Ramp/Discard/Measure); 시작 ≥ 정지 → `Skipped`; 그 밖 → `NotMeasured`. `shown`·`explains`는 새 상태를 「포화 뒤」처럼(숫자 비움, 설명됨). 기록 `stop: None`(보류만)이면 강제·상태 변화 없이 `auto_stop`만 싣는다.
- [ ] **Step 1: 테스트**: `forced_boundary_ramp1_discard0`(상승 1·버림 0, `judged_through = k`인데 계단 k+1 측정 초가 절반 넘게 쌓임 → 판정 밖, 상태 Partial/Skipped, 머리말 = 강제 없는 판정과 다름을 함께 단언) · `forced_boundary_skewed_t0_emergency`(워커 시작 시각 4초 어긋남, 즉시 정지 `judged_through = k−1`, 늦은 워커의 계단 k가 반 넘게 측정 → 계단 k EmergencyStopped·숫자 비움·`judge` 입력 밖) · `first_fail_headline_unconfirmed` · `last_ok_target_after_forcing`(강제로 빠진 정상 계단은 `last_ok_target`에 안 들어감) · `partial_seconds_and_phase`(상승 5초 중 2초 진입 → `{2, Ramp}`) · `skipped_steps_after_stop` · `emergency_between_judged_and_decided_not_measured` · `new_states_explain_dropped` · `record_ignored_unless_completed`(status aborted + 기록 → `stair.auto_stop` 없음·강제 없음) · `suspended_only_record_no_forcing` · `non_autostop_stair_report_unchanged`(a 골든 `stair_report_matches_golden` 그대로 green) · `stair_autostop_report_matches_golden`(두 실패 정지 + 일부 실행 + 실행 안 함 계단 포함 run).
- [ ] **Step 2: RED**, **Step 3: 구현**, **Step 4: GREEN**: `cargo test -p handicap-controller stair_report` + `--test report_test`.
- [ ] **Step 5: 되돌려 확인** — 강제 경계 줄 제거 → `forced_boundary_skewed_t0_emergency`·`forced_boundary_ramp1_discard0` RED → 원복.
- [ ] **Step 6: Commit** — `feat(controller): 자동 정지 리포트 — judged_through 강제 경계·즉시 정지/일부 실행/실행 안 함 행`.

### Task 11: 내보내기 — 정지 줄·행 상태(CSV·XLSX)

**Files:**
- Modify: `crates/controller/src/export.rs`(`stair_headline_lines` `:679`, `stair_state_name` `:811`, `stair_reason_texts` `:756`, `report_to_stairs_csv` `:837`의 `measured` `:849`·XLSX `:903` → `shows_numbers()`; 표기 보조 `floor_pct1` `:622`·`js_to_fixed` `:595` 재사용)
- Create: `testdata/stair_stop_line_golden.json`
- Test: `export.rs` 테스트, `crates/controller/tests/export_routes_test.rs`

**Interfaces:**
- Consumes: Task 10.
- Produces:
  ```rust
  pub(crate) fn stair_stop_line(st: &StairReport, time_text: &str) -> Option<String>;   // 기록 stop 있을 때
  pub(crate) fn stair_suspended_line(st: &StairReport) -> Option<String>;               // stop 없고 suspended>0
  fn stair_error_rate_text(r: f64) -> String;   // floor_pct1, 0이 아닌데 "0.0%"면 "<0.1%" — 화면 errorRateText와 같음
  fn stair_ms_text(us: u64) -> String;          // 화면 formatMs와 같음: 1 ms 미만 소수 둘째, 이상 정수(js_to_fixed 반올림)
  ```
  `stair_headline_lines` 맨 앞에 (정지 줄 | 보류 줄)을 넣는다. 내보내기 시각 = `stair_iso(stopped_at_ms)`(【내 판단】 UTC RFC3339). 표기 규칙 = 「spec 대체 결정」. 결합 = 머리 + 「 — 」 + 나머지를 「 · 」로(슬롯 부족 의심이면 사유 뒤 「(슬롯 부족 의심 — 부하기 한계일 수 있음)」). 즉시 정지의 「마지막 정상」 = `headline.last_ok_target`(Task 10 강제 뒤, 없으면 「정상 계단 없음」). 보류 줄 = 「자동 정지 감시가 {n}초 보류됐습니다(부하기 등록·데이터 지연) — 그동안 즉시 정지는 동작하지 않았습니다」. 상태 이름 `emergency_stopped`·`partial`·`skipped`, 사유 칸: 「즉시 정지」 / 「일부 실행 — 상승 {s}초 진입 후 정지」(구간 이름은 phase) / 「실행 안 함」.
  **기대 문자열 3종**(spec §5.3 예시 숫자, 시각 자리 `TIME`):
  - two_fails: `8계단(800 req/s) 판정 뒤 자동 정지 — 7·8계단 연속 실패 · 9계단 상승 2초 진입 후 멈춤 · 10계단 실행 안 함 · TIME`
  - first_fail: `7계단(700 req/s) 판정 뒤 자동 정지 — 7계단 실패, 첫 실패에서 정지(포화 확인 못 함) · 8계단 상승 1초 진입 후 멈춤 · 9–10계단 실행 안 함 · TIME`
  - emergency: `5계단(500 req/s) 상승 중 즉시 정지 — 오류율 12.0% 3초 연속 · 마지막 정상 4계단(400 req/s) · 6–10계단 실행 안 함 · TIME`
  (p99만 걸리면 「p99 {ms} ms {n}초 연속」, 둘 다면 「오류율 {p} · p99 {ms} ms {n}초 연속」.)
- [ ] **Step 1: 테스트**: `stop_line_two_fails`·`stop_line_first_fail`·`stop_line_emergency`(위 3종 문자열 전체 일치) · `stop_line_p99_only`·`stop_line_both_conditions` · `stop_line_slot_limited_suffix` · `skipped_single_and_range`(1개 `10계단`, 2개 `9–10계단`) · `no_partial_omits_clause` · `tiny_error_rate_text`(0.0004 → `<0.1%`) · `suspended_line_only` · `stairs_csv_starts_with_stop_line_and_blank_numbers`(새 상태 행 숫자 칸 빈 칸, 상태·사유 칸 문구, 시각은 UTC ISO) · `xlsx_stairs_sheet_has_stop_line` · `non_autostop_csv_unchanged`(a의 기존 CSV 테스트 green) · `stop_line_golden`(`testdata/stair_stop_line_golden.json` = 위 3종 문자열 그대로이고, Task 10 골든 + 변형 2개에서 만든 값과 같음) · 라우트 `report_stairs_csv_autostop_run`.
- [ ] **Step 2: RED**, **Step 3: 구현**, **Step 4: GREEN**: `cargo test -p handicap-controller export` + `--test export_routes_test`.
- [ ] **Step 5: Commit** — `feat(controller): 계단 내보내기에 자동 정지 줄·행 상태 (CSV·XLSX)`.

## b4 — UI

### Task 12: UI 스키마 + 새 상태 sweep — code-quality `opus`(와이어)

**Files:**
- Modify: `ui/src/api/schemas.ts`(`StairConfigSchema` `:74`, `StairStateSchema` `:86`, `StairStepSchema` `:104`, `StairReportSchema` `:159`, `RunSchema` `:300`), `StairState` 소비처(`grep -rn "not_measured" ui/src | grep -v __tests__` — schemas 제외 9곳: `print/stairTable.ts:40`, `print/components/StairPrintTable.tsx:16`, `report/stair/StairCurveChart.tsx:108·203`, `StairTable.tsx:12·49`, `stairColors.ts:9`, `StairBandChart.tsx:45`, `i18n/ko.ts:1172`), `ui/src/components/report/stair/stairFormat.ts`(헬퍼)
- Test: `ui/src/api/__tests__/stairSchemas.test.ts`, `ui/src/components/report/stair/__tests__/StairResultSection.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  export const AutoStopConfigSchema = z.object({
    saturation: z.enum(["two_fails", "first_fail"]).nullable(),
    emergency: z.object({ error_rate_pct: z.number(), p99_ms: z.number().int(), consecutive_seconds: z.number().int(), min_requests: z.number().int() }).strict().nullable(),
  }).strict();
  StairConfigSchema: auto_stop: AutoStopConfigSchema.optional()
  StairStateSchema: + "emergency_stopped" | "partial" | "skipped"
  StairStepSchema: partial: z.object({ seconds: z.number(), phase: z.enum(["ramp","discard","measure"]) }).strict().optional()
  export const AutoStopRecordSchema   // stop(.nullable(): kind·mode(.nullable)·failed_steps·decided_step·judged_through·phase(.nullable)·decided_at_ms·stopped_at_ms·emergency(.nullable)·slot_limited)·suspended_seconds, .strict()
  StairReportSchema: auto_stop: AutoStopRecordSchema.optional();  RunSchema: auto_stop: AutoStopRecordSchema.optional()
  export function showsNumbers(s: StairState): boolean;   // stairFormat.ts — 서버 shows_numbers와 같은 집합
  ```
  `!== "not_measured"` 4곳(`stairTable.ts:40`·`StairTable.tsx:49`·`StairCurveChart.tsx:108·203`) → `showsNumbers`. `Record<StairState,…>`(색·pill·인쇄 클래스·ko 상태 이름)에 새 키: ko 「즉시 정지」·「일부 실행」·「실행 안 함」, 색은 즉시 정지 = 빨강 계열 테두리, 나머지 회색(기존 토큰).
- [ ] **Step 1: 테스트**: `testdata/stair_autostop_report_golden.json` → `StairReportSchema.parse` 통과 · 기존 `stair_report_golden.json` 통과 · RunSchema: completed+`auto_stop`(내부 `null` 필드 포함) 통과 / 키 없음 통과 · profile `stair.auto_stop`(`{saturation:null, emergency:{…}}`) round-trip이 지우지 않음 · `StairConfigSchema`가 모르는 키 거부(strict 유지) · 새 상태 행이 표에서 숫자 「—」(StairResultSection, 자동 정지 골든).
- [ ] **Step 2: RED**: `cd ui && pnpm test stairSchemas`.
- [ ] **Step 3: 구현**, **Step 4: GREEN**: `cd ui && pnpm test src/api src/components/report src/print && pnpm lint && pnpm build`.
- [ ] **Step 5: Commit** — `feat(ui): 자동 정지 스키마(설정·기록·새 계단 상태)`.

### Task 13: 리포트 화면 — 정지 줄·보류 줄·행 문구 + 문구 일치

**Files:**
- Create: `ui/src/components/report/stair/StairStopLine.tsx`
- Modify: `stairFormat.ts`, `StairResultSection.tsx`(`StairHeadline` 위), `StairTable.tsx`(일부 실행 사유), `ui/src/i18n/ko.ts`(`ko.report.stair.stop*`)
- Test: `ui/src/components/report/stair/__tests__/StairResultSection.test.tsx`, `stairExportParity.test.ts`

**Interfaces:**
- Consumes: Task 11 골든, Task 12.
- Produces:
  ```ts
  export function stopLineText(stair: StairReport, timeText: string): string | null;   // Rust stair_stop_line과 같은 글자(errorRateText·formatMs 재사용)
  export function suspendedLineText(stair: StairReport): string | null;
  export function clockText(ms: number): string;   // 지역 시각 HH:MM:SS(0 채움)
  <StairStopLine stair={stair} />   // 노랑 줄(stop) / 회색 줄(보류만) — 정적 텍스트
  ```
- [ ] **Step 1: 테스트**: 패리티 `stop line matches Rust golden`(`stopLineText(variant, "TIME")` == `stair_stop_line_golden.json` 3종) · 섹션: 자동 정지 골든 → 정지 줄이 `StairHeadline` 앞(DOM 순서), 시각 = `clockText(stopped_at_ms)`(별도로 `/\d{2}:\d{2}:\d{2}$/` 단언 — 자기참조 함정, `ui/CLAUDE.md`) · 보류만 → 회색 줄·노랑 줄 없음 · 기록 없음 → 둘 다 없음 · 일부 실행 행 사유 「일부 실행 — 상승 2초 진입 후 정지」(리터럴 1건 병기).
- [ ] **Step 2: RED**, **Step 3: 구현**, **Step 4: GREEN**: `cd ui && pnpm test src/components/report && pnpm lint && pnpm build`.
- [ ] **Step 5: 되돌려 확인** — `stopLineText`의 계단 번호를 `index`(0부터)로 → 패리티 RED → 원복.
- [ ] **Step 6: Commit** — `feat(ui): 리포트 자동 정지 줄·보류 안내·일부 실행 행`.

### Task 14: 인쇄 — 정지 줄·행 상태

**Files:**
- Modify: `ui/src/print/buildPrintDoc.ts`(`standardBlocks` stair `:206`, `summaryBlocks` `:260`), `ui/src/print/PrintDocument.tsx`(AtomicContent), `ui/src/print/stairTable.ts`, `ui/src/print/components/StairPrintTable.tsx`
- Test: `ui/src/print/__tests__/stairPrint.test.tsx`, `ui/src/print/__tests__/verdict.test.ts`

**Interfaces:**
- Consumes: Task 13 `stopLineText`·`suspendedLineText`·`clockText`.
- Produces: atom `stair:stop`(standard: `stair:headline` 앞, summary: `stair:headline:short` 앞) — 기록 없으면 블록 없음. 인쇄 행 상태 문구 = 화면과 같음.
- [ ] **Step 1: 테스트**: 자동 정지 골든 → standard·summary 블록 id 목록에 `stair:stop`이 머리말 앞 · 비계단·자동 정지 없는 계단 run의 블록 id 목록 == **변경 전에 뽑아 리터럴로 적은 목록** · 행 상태 문구 3종 · verdict: status completed + `auto_stop` run → 판정함(`notJudged` 아님, `verdict.ts:101` 근거).
- [ ] **Step 2: RED**, **Step 3: 구현**, **Step 4: GREEN**: `cd ui && pnpm test src/print && pnpm lint && pnpm build`.
- [ ] **Step 5: Commit** — `feat(ui): 인쇄 보고서 자동 정지 줄·행 상태`.

### Task 15: run 상세·목록 「자동 정지」 표지

**Files:**
- Modify: `ui/src/pages/RunDetailPage.tsx`(`StatusBadge` `:171` 옆 형제), `ui/src/pages/ScenarioRunsPage.tsx`(`:428` 옆), `ui/src/i18n/ko.ts`
- Test: `ui/src/pages/__tests__/RunDetailPage.test.tsx`, `ScenarioRunsPage.test.tsx`

**Interfaces:**
- Produces: `run.status === "completed" && run.auto_stop?.stop != null`일 때만 작은 표지 「자동 정지」(`title` = 정지 줄 머리, heading 밖 형제 — `ui/CLAUDE.md` heading 배지 함정). 보류만(stop null)이면 표지 없음.
- [ ] **Step 1: 테스트**: 상세·목록 각각 표지 있음/없음(stop null·aborted·기록 없음) — 목록은 `within(row)`로.
- [ ] **Step 2: RED**, **Step 3: 구현**, **Step 4: GREEN**: `cd ui && pnpm test RunDetailPage ScenarioRunsPage && pnpm lint && pnpm build`.
- [ ] **Step 5: Commit** — `feat(ui): run 상세·목록 자동 정지 표지`.

### Task 16: 실행 창 자동 정지 — 순수 draft 로직

**Files:**
- Modify: `ui/src/components/run/stair.ts`(`StairDraft` `:4`, `STAIR_DEFAULTS` `:12`, `stairErrors` `:102`, `stairDraftFromConfig` `:120`, `draftToStairConfig` `:131`), `ui/src/i18n/ko.ts`(`ko.loadModel.stairAutoStop*`)
- Test: `ui/src/components/run/__tests__/stair.test.ts`, `loadModel.test.ts`, `runSummary.test.ts`, `LoadModelFields.test.tsx`
- **의도된 기존 테스트 갱신**(`StairDraft` 필드 추가로 `tsc -b`가 깨지거나 새 기본값으로 payload가 바뀜 — 재확인 `grep -n "p99Cap: \"\"" ui/src/components/run/__tests__/*.ts*`): `loadModel.test.ts:340`(draft 리터럴 → `...STAIR_DEFAULTS` 펼침 또는 새 필드)·`:345`(`buildLoadProfile` stair `toEqual` — 기본값이면 `auto_stop` 포함으로), `runSummary.test.ts:86·99`(draft 리터럴), `LoadModelFields.test.tsx:~789`(draft 리터럴, 재grep). `loadModel.test.ts:372`는 profile 입력(`deriveLoadMode`)이라 변경 불필요 — 확인만.

**Interfaces:**
- Produces:
  ```ts
  StairDraft += { satOn: boolean; satMode: "two_fails" | "first_fail"; emOn: boolean;
                  emErrorPct: string; emP99Ms: string; emSeconds: string; emMinRequests: string };
  STAIR_DEFAULTS: satOn true, two_fails, emOn true, "5", "2000", "3", "20"
  stairErrors 키 += "emErrorPct" | "emP99Ms" | "emSeconds" | "emMinRequests"  // emOn일 때만 검사
  stairDraftFromConfig: auto_stop 없음 → satOn·emOn false(숫자 칸은 기본값), 있으면 그대로
  draftToStairConfig: 둘 다 끔 → auto_stop 키 생략, 아니면 { saturation: satOn ? satMode : null, emergency: emOn ? {…} : null }
  export function autoStopSummary(c: StairConfig): string;   // 단순 모드 카드 한 줄
  ```
  `autoStopSummary`: 「자동 정지: 연속 두 계단 실패 · 즉시 정지 5%/2000 ms/3초」(첫 실패 = 「첫 실패에서 바로 정지」, 한 칸 끄면 그 구절 생략, 둘 다 끔 = 「자동 정지: 꺼짐」).
- [ ] **Step 1: 테스트**(+ 위 의도된 갱신): `defaults_auto_stop_on`(`draftToStairConfig({...STAIR_DEFAULTS, targets:"100, 200"})`.auto_stop == `{saturation:"two_fails", emergency:{5,2000,3,20}}`) · `draft_from_config_without_auto_stop_is_off`(a 형태 config → satOn·emOn false → 다시 config로 → `auto_stop` 키 없음 = 바이트 같음) · `round_trip_with_auto_stop` · `both_off_omits_key` · `emergency_errors_only_when_on`(0·100.01·소수 p99·61초·0개 → 오류 문구; emOn false면 오류 없음) · `decimal_error_rate_ok`(5.5) · `buildLoadProfile` stair 분기 payload에 `auto_stop` · `autoStopSummary` 4종.
- [ ] **Step 2: RED**, **Step 3: 구현**, **Step 4: GREEN**: `cd ui && pnpm test src/components/run && pnpm lint && pnpm build`.
- [ ] **Step 5: 되돌려 확인** — `stairDraftFromConfig`가 absent를 기본 켜짐으로 → `draft_from_config_without_auto_stop_is_off` RED → 원복.
- [ ] **Step 6: Commit** — `feat(ui): 계단 자동 정지 입력 상태·검증·요약 (새 run 기본 켜짐, 저장본은 그대로)`.

### Task 17: 실행 창·스케줄 폼 「자동 정지」 상자 + 단순 모드 카드

**Files:**
- Create: `ui/src/components/run/AutoStopFields.tsx`
- Modify: `ui/src/components/run/StairFields.tsx`(판정 기준 접기 아래), `ui/src/components/run/RunDialog.tsx`(단순 모드 계단 카드 `:800`), `ui/src/i18n/ko.ts`
- Test: `ui/src/components/run/__tests__/StairFields.test.tsx`, `RunDialog.test.tsx`, `ScheduleForm.test.tsx`
- **의도된 기존 테스트 갱신**: `RunDialog.test.tsx:3873`(새 계단 run 제출 `body.profile.stair` `toEqual` — 기본 켜짐 `auto_stop` 포함으로). `RunDialog.test.tsx:3804`·`ScheduleForm.test.tsx:403`은 저장본 fixture(a 형태)라 변경 불필요 — 그 prefill 경로의 재제출 payload가 `auto_stop` 없음을 오히려 새로 단언.

**Interfaces:**
- Consumes: Task 16.
- Produces: `<AutoStopFields value={StairDraft} onChange errors />` — fieldset(legend 「자동 정지」), **접기 없음(항상 보임)**; 체크박스 「포화가 확정되면 남은 계단을 실행하지 않음」 + 라디오 2개(「연속 두 계단 실패 시 (튄 계단은 넘김)」/「첫 실패에서 바로 정지」), first_fail일 때만 경고 「한 번 튄 계단으로도 멈출 수 있고, 리포트는 「포화 확인 못 함」으로 남습니다.」; 체크박스 「즉시 정지」 + 숫자 칸 4개(라벨: 오류율 %, p99 ms, 초 연속, 초당 완료 개수 이상) + ⓘ 안내; 둘 다 끄면 마지막 경고 줄 숨김. 숫자 칸 오류는 a 절대 p99 상한과 같은 방식(빨간 오류·`aria-invalid`·제출 막음 — `stairInvalid` 경유). StairFields가 RunDialog·ScheduleForm 공용이라 두 곳에 자동으로 뜬다. 단순 모드 계단 카드에 `autoStopSummary` 한 줄.
- [ ] **Step 1: 테스트**(+ 위 의도된 갱신): StairFields — 기본값으로 두 체크 켜짐·two_fails 선택·경고 없음 / first_fail 선택 → 경고 보임 / 둘 다 끔 → 마지막 경고 숨김 / 오류율 0 → 오류 문구 + RunDialog 제출 버튼 비활성. RunDialog: 새 계단 run 제출 payload `profile.stair.auto_stop` == 기본값 / a 저장본(auto_stop 없음) 다시 실행 prefill → 두 체크 꺼짐·payload에 키 없음 / 프리셋 불러오기 동일 / 단순 모드 카드 한 줄. ScheduleForm: `initial`(auto_stop 있는 저장 스케줄) → 상자 값 유지·저장 payload 동일.
- [ ] **Step 2: RED**, **Step 3: 구현**, **Step 4: GREEN**: `cd ui && pnpm test src/components/run && pnpm lint && pnpm test && pnpm build`(전체 1회 — targeted ≠ full).
- [ ] **Step 5: Commit** — `feat(ui): 실행 창·스케줄 폼 자동 정지 상자 + 단순 모드 요약`.

## b5 — 성능 증명

### Task 18: 감시 처리 마이크로 측정 (`#[ignore]`)

**Files:**
- Modify: `crates/controller/src/stair_monitor.rs`(`#[cfg(test)] mod perf`)

**Interfaces:**
- Produces: `#[ignore] fn monitor_batch_cost_worst_case()` — 워커 4 × 50계단(hold 60) 설정, 배치마다 스텝 16개 window + open-loop 초 2개, HDR은 실제 크기(1 µs–10 s 범위에 수천 샘플 기록 후 인코딩). 전체 run 분량 배치를 `on_msg`에 넣고 배치당 `Instant` 경과로 p50/p99 출력(`--nocapture`), `assert!(p99 < 5 ms)`. `#[ignore]`라 pre-commit 게이트에서 돌지 않는다(엔진 CLAUDE "고정 시간 상한 금지"는 게이트 테스트 규칙 — 이 측정은 spec §7.1이 정한 수동 기준).
- [ ] **Step 1: 테스트 작성**, **Step 2: 실행**: `cargo test -p handicap-controller --release monitor_batch_cost_worst_case -- --ignored --nocapture; echo exit=$?` — 측정 전 다른 cargo 빌드 없음 확인(`ps -Ao pcpu,comm` 상위에 `syspolicyd`·`XprotectService`·`rustc` 없음). 기준 미달이면 STOP → orchestrator(원인 수정은 Task 4–6 코드).
- [ ] **Step 3: 결과(p50·p99·머신)를 커밋 메시지 본문에** — Commit `test(controller): 자동 정지 감시 배치 처리 마이크로 측정 (spec §7.1)`.

### Task 19: 종단 A/B 스크립트 — 계단 프로필·CPU·큐·RSS·외부 바이너리

**Files:**
- Modify: `scripts/bench-throughput.sh`

**Interfaces:**
- Produces: `PROFILE_KIND=stair`(기본 기존 동작 그대로) + `STAIR_TARGETS`(쉼표) · `STAIR_HOLD`·`STAIR_RAMP`·`STAIR_DISCARD` · `MAX_IN_FLIGHT` · `WORKERS`(`worker_count`) · `AUTO_STOP=off|on|absent`(on = `two_fails` + 즉시 정지 50 %·600000 ms·60초·20개 — 정지가 걸리지 않는 높은 기준; absent = `auto_stop` 키 없음, master 측정용) · `BIN_DIR`(설정하면 `cargo build` 생략하고 `$BIN_DIR/controller`·`$BIN_DIR/worker` 사용 — master 바이너리용) · `RSS_EVERY`(초, 기본 0 = 끝에 한 번). 1초마다 `ps -o %cpu=`로 컨트롤러·워커(`pgrep -f "$BIN_DIR/worker"` 또는 `target/release/worker`) CPU를 기록해 평균 출력, 리포트 `stair.steps[].achieved`·`stair.headline` 출력, 컨트롤러 로그에서 `auto-stop monitor finished`의 `queue_max` 출력, `RSS_EVERY>0`이면 그 간격으로 RSS(finalize 전까지). 폴링 상한은 계단 전체 길이 + 60초.
  측정 절차(orchestrator, 커밋 본문·build-log에 적을 것):
  - **① master 빌드**: 스크래치 경로에 `git worktree add --detach <scratchpad>/handicap-master-bench master`(별도 명령으로 — master는 메인 체크아웃이 쥐고 있어 `--detach` 필수; 측정 뒤 `git worktree remove <scratchpad>/handicap-master-bench`로 정리) → 그 디렉토리에서 `CARGO_TARGET_DIR=<scratchpad 절대경로>/master-target cargo build --release -p handicap-controller -p handicap-worker` → `BIN_DIR=<scratchpad 절대경로>/master-target/release AUTO_STOP=absent`. ②③은 이 워크트리에서 `--release`(스크립트 기본). 세 쪽 모두 release.
  - **응답기 용량**: 같은 응답기로 계단 run 1회(넉넉한 목표 목록, `AUTO_STOP=absent`) → 용량 = a 판정이 정상으로 본 가장 높은 계단(`stair.headline.last_ok_target`, all_ok면 `through_target`). ③의 목표 최댓값 = 그 값의 약 80%.
- [ ] **Step 1: 비계단 기본 실행 출력이 변경 전과 같은 항목**인지 확인(`DURATION=5 VUS=10 scripts/bench-throughput.sh; echo exit=$?` — docker 필요; 없으면 `bash -n scripts/bench-throughput.sh; echo exit=$?`만 하고 orchestrator 측정 단계로 넘김을 커밋 본문에).
- [ ] **Step 2: Commit** — `chore(scripts): bench-throughput 계단 프로필·CPU/큐/RSS 기록·외부 바이너리 (spec §7.2·§7.3)`.

---

## 검증·마무리 (orchestrator 수행, 코드 변경 없음)

- **최종 리뷰**: `handicap-reviewer`(BASE = 첫 task 디스패치 직전 커밋) — 초점: 와이어 1:1(Rust 기록·`StairStep.partial`·`StairReport.auto_stop` ↔ Zod), 감시↔리포트 상호작용(Task 5/6 ↔ 10의 `judged_through` 의미), coordinator 타 경로 소비자(`worker_disconnected`·`pool_mark_finished`·`run_watchdog`가 미룬 finalize와 어울리는지). 보안 게이트: `finish-slice` §0 grep 직접 실행(요청 실행·템플릿·env/데이터셋 경로를 건드리지 않을 예상이지만 grep이 지배).
- **엔진 diff 0**: Global Constraints의 `git diff --stat` 명령 출력 0줄.
- **라이브 검증** `/live-verify`(워크트리 자체 바이너리, 빈 포트 `lsof` 출력을 읽고 기동, 용량 제한·지연 조절 응답기는 Write로 만든 스크립트):

  | US | 절차 | 통과 신호 |
  |---|---|---|
  | US1 | 용량 제한 응답기로 6계단 중 4계단에서 무너지게 → two_fails | 5계단 측정 끝 뒤 수 초 안 1초 RPS 0 · 상태 완료 · 정지 줄(6계단 「일부 실행 — 상승 N초」 실측과 일치) · 상세·목록 표지 · CSV/XLSX/인쇄 같은 줄 (시각 표기만 CSV/XLSX = UTC ISO) |
  | US2 | 지연 조절 응답기를 run 중 상승 구간에 3초 지연 | 기준 넘은 뒤 수 초 안 정지 · 「상승 중 즉시 정지」 · 그 계단 「—」 · 첫 계단 상승 거짓 정지 없음 |
  | US4 | first_fail로 US1 반복 | 경고 표시 · 4계단 판정 뒤 정지 · 「포화 확인 못 함」 |
  | US5 | Task 18 결과 + Task 19 절차로 ① master ② b 끔 ③ b 켬 각 5회(목표 최댓값 = 응답기 용량 약 80%) + 50계단 × 워커 4 × 유지 60초 RSS | Global Constraints 성능 기준 표(build-log에) |

  추가: 진입 화면 전부(실행 창·스케줄 폼·프리셋 저장→불러오기·다시 실행·단순 모드 카드) 설정 유지 · 워커 2개 run 정지 + 형제 flush 포함 · 사용자 중단 경합 · 계단 아닌 run 1개 응답·리포트 정상 · 라이브 run 1회로 목록·상세·리포트 Zod 파싱(서버 `null`) · 극단값: 50계단 run의 정지 줄(실행 안 함 범위)·표 rect 겹침 없음 · 콘솔 오류 0.
- **`/finish-slice`**: build-log 한 단락(성능 표 포함), 루트 CLAUDE 상태 줄 교체(Python 스플라이스), roadmap-status §A16 frontier → c(`stage-live-panel`), MEMORY 활성 작업 줄, ff-merge.
- **roadmap §B 기록**(번호는 `grep -n '^### B' docs/roadmap.md`로 마지막+1, 비용·해소법 함께 — working-rules):
  1. 즉시 정지를 모든 run으로 확장(사용자 결정으로 연기 — 계단 아닌 run엔 감시 없음; 해소 = `monitor_wanted`를 open-loop 일반으로, 계단 판정 없이 초 판정만).
  2. 선재 틈: 기존 Completed finalize가 `set_status`(반환 없음) 뒤 `set_verdict` 무조건 → 경합한 `mark_aborted` 뒤 aborted run에 verdict 배지 가능(spec §4.6). 해소 = 같은 가드 UPDATE + 바뀐 행 1개일 때만.
  3. 자동 정지 뒤 형제 워커가 연결된 채 멈추면(G1) 계획 시간 + 120초 backstop까지 running(spec §11, 단축 안 함).
  4. 몫 0 워커가 있는 run에서 실행 중 판정과 리포트 측정 초 ±1(spec §4.3·§11).
  5. 감시 비동기라 finalize 시점 보류 초가 실제보다 약간 적을 수 있음(spec §11).
  6. 【내 판단】 내보내기(CSV·XLSX) 정지 시각 = UTC RFC3339, 화면·인쇄 = 지역 HH:MM:SS(a `stair_iso` 선례·측정 구간 열과 맞춤). 비용: 같은 줄이 표면마다 시각 표기가 다름. 해소 = 서버 `--scheduler-timezone` 기준 표기로 통일.
  7. CSV `index` 열은 0부터(a 선례)인데 정지 줄은 1부터 계단 번호 — 같은 파일 안 번호 기준이 다름. 해소 = CSV에 1부터 `step` 열 추가(열 순서 계약 변경이라 별도 결정).
  8. spec §5.3 「실행 안 함 4개 이상이면 범위」를 「2개 이상 → `a–b`」로 대체(orchestrator 결정 — spec 예시와 일치, 실행 안 함은 항상 끝까지 이어짐). spec 문구 정정 필요.
  9. run 목록 필터의 「자동 정지」 축(spec 비목표).
  9b. 「일부 실행」 초는 계단 시작부터 셈 — 정지가 버림 구간에 걸리면 「N계단 버림 7초 진입」이 버림 구간 안 7초처럼 읽힐 수 있음. 해소 = 구간 시작부터 세기 또는 「계단 시작 7초 뒤(버림 중)」 문구.
  10. 다음 릴리즈 노트 줄: 계단 자동 정지(기본 켜짐은 새 계단 run만, 저장본은 꺼짐).

## 실행 순서·재개

Task 1→19 순서(b1 → b2 → b3 → b4 → b5). UI(Task 12–17)는 Task 10·11 골든을 읽으므로 그 뒤. 재개는 `git log --oneline master..HEAD`의 task 커밋 수와 위 체크박스 대조. c(§8)는 b 머지 뒤 별도 plan.

## 부록: 근거 명령 (사실 주장 재실행용)

```
grep -n "^pub fn\|^fn\|^pub struct\|^struct\|fn step_of\|fn measure_window\|let shown\|let explains" crates/controller/src/stair.rs
grep -n "pub mod stair\|pub mod report\|pub mod export" crates/controller/src/lib.rs   # pub mod → pub 항목은 dead code 경고 없음
grep -n "pub stair\|build_stair_report\|mod stair_report\|^mod tests\|fn make_hdr_bytes\|fn fresh_hist" crates/controller/src/report.rs
grep -n "fn stair_aligned_t0_counts_measure_seconds\|fn stair_report_matches_golden\|fn stair_export_text_matches_golden" crates/controller/src/report.rs
grep -n "pub struct PendingAssignment\|^struct RunWorkers\|pub async fn enqueue\|async fn assignment_for\|pub async fn record_phase\|pub async fn abort(\|^async fn fan_out_abort\|^async fn ingest_metrics\|WorkerPayload::MetricBatch(batch)\|OPEN_LOOP_CLOCK_SKEW_S\|OPEN_LOOP_START_MAX\|plausible_s\|start_plausible\|abort_flag_set_before_sends\|fn seed_run_with_criteria\|fn base_assignment" crates/controller/src/grpc/coordinator.rs
grep -n "        match decision {\|^    pub async fn worker_disconnected" crates/controller/src/grpc/coordinator.rs
grep -n "insert_batch(&state.db" crates/controller/src/grpc/coordinator.rs           # metric window는 시각 필터 없이 저장
grep -c "\.enqueue(" crates/controller/src/grpc/coordinator.rs                     # 41 — enqueue 시그니처 대신 PendingAssignment 필드
grep -rn "PendingAssignment {" crates/                                              # 리터럴 2곳 + 정의
grep -rn "coord.abort(" crates/controller/src                                       # api/runs.rs·in_process.rs(데스크톱 종료·모드 전환)
grep -n "pub async fn set_status\|pub async fn set_verdict\|pub async fn mark_aborted\b\|pub async fn get\|pub async fn list_by_scenario\|pub struct RunRow" crates/controller/src/store/runs.rs
grep -oE 'migration [0-9]{4}' crates/controller/src/store/mod.rs | sort | tail -1   # 0024 → 다음 0025
ls crates/controller/src/store/migrations                                            # 마지막 0024_run_open_loop_seconds.sql
grep -n "fn ensure_runs_label\|ensure_runs_label(&pool)" crates/controller/src/store/mod.rs
grep -n "pub struct RunResponse\|^fn to_response\|pub async fn build_report_for_run\|pub async fn abort_run\|PendingAssignment {" crates/controller/src/api/runs.rs   # build_report_for_run :1077
grep -rn "normalize_stair(" crates/controller/src                                   # 5개 진입점
grep -rn "StairConfig {" crates/ | grep -v "pub struct" | awk -F: '{print $1}' | sort | uniq -c   # 27곳
grep -rn "StairStep {\|StairReport {" crates/ | awk -F: '{print $1}' | sort | uniq -c
grep -n "fn stair_headline_lines\|fn stair_state_name\|fn stair_reason_texts\|fn report_to_stairs_csv\|fn stair_iso\|fn floor_pct1\|fn js_to_fixed\|state != StepState::NotMeasured" crates/controller/src/export.rs
grep -n "pub use runner::" -A2 crates/engine/src/lib.rs                             # run_scenario_open_loop 공개
grep -n "pub(crate) struct OpenLoopCounters" crates/engine/src/open_loop_counters.rs
grep -n "drain_completed(now_s)" crates/engine/src/runner.rs                         # 같은 잠금에서 window·open-loop 초
grep -n "wiremock\|handicap-engine" crates/controller/Cargo.toml
grep -n "StairConfigSchema = z\|StairStateSchema = z\|StairStepSchema = z\|StairReportSchema = z\|export const RunSchema\|stair: StairConfigSchema" ui/src/api/schemas.ts
grep -rn "not_measured" ui/src | grep -v __tests__                                  # schemas 제외 9곳
grep -rn '!== "not_measured"' ui/src | grep -v __tests__                            # 4곳
grep -n "export function formatMs\|export function errorRateText\|export function floorPct1" ui/src/components/report/stair/stairFormat.ts
grep -n "tinyErrorRate" ui/src/i18n/ko.ts
grep -n "export type StairDraft\|export const STAIR_DEFAULTS\|export function stairErrors\|export function stairDraftFromConfig\|export function draftToStairConfig" ui/src/components/run/stair.ts
grep -n "p99Cap: \"\"" ui/src/components/run/__tests__/*.ts*                       # draft 리터럴(의도된 갱신)
grep -n "targets: \[" ui/src/components/run/__tests__/RunDialog.test.tsx ui/src/components/run/__tests__/ScheduleForm.test.tsx   # 3804·3873·403
grep -rln "StairFields" ui/src                                                       # LoadModelFields 경유 = RunDialog·ScheduleForm 공용
grep -n "stairCardTitle\|stairCard(" ui/src/components/run/RunDialog.tsx            # :800
grep -n "StatusBadge status" ui/src/pages/RunDetailPage.tsx ui/src/pages/ScenarioRunsPage.tsx
grep -n "stair" ui/src/print/buildPrintDoc.ts
grep -n '"aborted"' ui/src/print/verdict.ts
ls testdata | grep stair
grep -n "SCENARIO_KIND\|ps -o rss\|cargo build" scripts/bench-throughput.sh
```
