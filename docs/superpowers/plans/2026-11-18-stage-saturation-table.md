# 계단 시험 a (계단 입력 + 계단 결과 표 + 포화 계단 표시) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** open-loop run에 「계단」 입력을 더하고, 리포트에서 계단별 숫자·판정·포화 계단을 bench와 같은 규칙으로 보여 준다.

**Architecture:** profile에 controller-only `stair` 설정을 두고 API 경계에서 `stages`로 펼친다(워커 무변경). 엔진은 open-loop 초 단위 계수(시작·완료·버림)와 시작 시각을 새 proto 필드 12·13으로 보내고, 컨트롤러는 migration 0024 두 테이블에 쌓는다. 리포트는 순수 판정 함수 `stair::judge`로 계단 결과를 계산해 `ReportJson.stair`(없으면 키 없음)로 내고, UI가 실행 창 탭·리포트 섹션·인쇄·내보내기를 그린다.

**Tech Stack:** Rust(tokio, hdrhistogram, prost/tonic, sqlx SQLite, axum, rust_xlsxwriter 기존), TypeScript/React(Zod, Recharts, vitest+RTL).

REVIEW-GATE: APPROVED

**Spec:** `docs/superpowers/specs/2026-11-18-stage-saturation-table-design.md` (규칙 정본 — 이 plan과 다르면 spec이 이긴다; 차이를 발견하면 STOP하고 orchestrator에 보고). 화면 기준: `docs/superpowers/specs/2026-11-18-stage-saturation-mockup-rundialog.png`, `…-mockup-report.png`, `…-mockup-decisions.png`(꼬리표 **b** 요소는 범위 밖).

## Global Constraints

- 사용자 문구는 전부 `ui/src/i18n/ko.ts` 경유(ADR-0035). 조사는 `(으)로`/`이(가)` 쌍 표기. 고유명사(p50/p95/p99, RPS, req/s) 원어.
- 서버 `skip_serializing_if` 필드 ↔ Zod `.optional()`, 항상 직렬화되는 `Option` ↔ `.nullish()`. `ReportSchema`는 `.strict()` → `stair`를 반드시 추가.
- 판정 비교는 **정수 µs**(`p99_us: u64`). 표시만 ms(1 ms 미만 소수 둘째 자리, 이상은 정수).
- 판정 상수: `ACHIEVED_MIN=0.95`, `ERROR_MAX=0.01`, `P99_MULT=3`, `P99_FAST_US=1000`, `P99_FAST_CAP_US=5000`, knee `1.5×`∧`≥1000µs`, ⚠ `head_p99_ratio ≥ 2.0`∧앞부분 p99 `≥1000µs`, 측정 10초 이상·⚠ 계산은 측정 20초 이상, 미측정 = `measured_seconds < (hold−discard)/2`.
- `StairConfig` 범위: targets 2..=50개·엄격 증가·각 1..=1_000_000, hold 20..=3600, ramp 1..=600, discard 0..=hold−10, p99_cap_ms 1..=600_000.
- 기존(stair 없는) run의 report JSON·`report.csv`·XLSX·인쇄 출력 불변.
- 부재 중 판단 기준: `docs/dev/working-rules.md` §9 — 정직한 동작·성능 → QA 입문자 사용성. 구현 중 새로 정한 것은 커밋 메시지 본문에 "부재 중 판단: …" 한 줄.
- 결함을 변호하는 주석 금지(working-rules §7). 회귀 테스트는 되돌려 확인(teeth check): 고친 코드를 옛 상태로 되돌려 RED → 원복 → GREEN.
- Rust: `cargo fmt`, `clippy -D warnings`(2-arm `match … _ => {}` 대신 `if let`). UI: `pnpm lint && pnpm test && pnpm build`.
- 커밋: implementer는 FOREGROUND 단일 호출(600000ms), `| tail` 금지·`--no-verify` 금지, 커밋 메시지는 파일(`-F`)로, 끝에 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Brief 첨부 (orchestrator)

implementer는 자기 task 절만 받는다. 아래 task는 spec 원문 절을 brief에 **그대로 첨부**한다(`docs/superpowers/specs/2026-11-18-stage-saturation-table-design.md`): Task 1 → §4.2 · Task 3 → §4.3 · Task 4 → §4.1 · Task 5 → §5.3 · Task 6 → §5.1–§5.7 · Task 7 → §5.6·§6.4 · Task 8 → §5.6 · Task 9·10 → §6.1 · Task 11·12 → §5.3 머리말·§5.7·§6.2 · Task 13 → §6.3·§6.4. 모든 brief에 spec의 `## 사용자 스토리 (US)` 블록 첨부.

## Review Focus

1. **요청이 여러 개인 시나리오** — 반복 1번에 요청 2개면 처리량(요청/초) = 2 × 달성(반복/초)이어야 한다(달성이 요청 수로 부풀면 95% 판정이 영원히 통과). → Task 6 테스트 `stair_two_requests_per_iteration`.
2. **사용자가 목표 목록을 손으로 고침** — 공백·끝 쉼표·중복·감소·소수·0·빈 칸. 입문자가 고칠 수 있는 문구로 제출을 막아야 한다. → Task 9 테스트 `parseTargets_*`.
3. **계단 프리셋을 스케줄 폼·실행 창에서 다시 염** — 저장본엔 `stair`와 `stages`가 같이 있다; 곡선 탭으로 열리면 사용자가 모르고 곡선 run을 낸다. → Task 10 테스트 `preset_with_stair_opens_stair_tab`(RunDialog·ScheduleForm 둘 다).
4. **run을 중간에 중지·데이터셋 소진** — 잘린 계단이 「포화」로 둔갑하면 안 된다(미측정/확인 못 한 실패). → Task 6 `stair_scheduler_ended_early_is_not_measured`, Task 5 `unconfirmed_when_next_not_measured`.
5. **50계단 × 큰 숫자** — 표·인쇄가 잘리거나 겹치면 안 된다. → Task 13 `stair_print_table_paginates_50_rows`, 라이브 극단값(Task 14).

---

## a1 — 계수·판정·표

### Task 1: 엔진 open-loop 초 단위 계수 + 시작 시각

**Files:**
- Create: `crates/engine/src/open_loop_counters.rs`
- Modify: `crates/engine/src/lib.rs`(mod 등록), `crates/engine/src/runner.rs`(`MetricFlush` `:115`, `run_scenario_open_loop` `:1753–2030`, `run_arrival` `:2038`, 나머지 `MetricFlush{}` 리터럴 5곳)
- Test: `crates/engine/src/open_loop_counters.rs`(`#[cfg(test)]`), `crates/engine/tests/open_loop_seconds.rs`(신규)

**Interfaces:**
- Produces:
  ```rust
  // runner.rs (pub, re-export 위치는 MetricFlush와 같게)
  pub struct OpenLoopSecond { pub ts_second: i64, pub launched: u64, pub completed: u64, pub dropped: u64 }
  // MetricFlush 새 필드
  pub open_loop_seconds: Vec<OpenLoopSecond>,
  pub open_loop_started_at_ms: Option<i64>,
  // open_loop_counters.rs (pub(crate))
  pub(crate) enum CountKind { Launched, Completed, Dropped }
  pub(crate) struct OpenLoopCounters { /* BTreeMap<i64, OpenLoopSecond>, last_emitted: i64, end_s: Option<i64> */ }
  impl OpenLoopCounters {
      pub(crate) fn new(start_second: i64) -> Self;
      pub(crate) fn record_at(&mut self, ts: i64, kind: CountKind);   // 테스트 seam
      pub(crate) fn record(&mut self, kind: CountKind);               // 잠금 안에서 현재 초 읽음(aggregator current_second()와 같은 시계)
      pub(crate) fn end_scheduler(&mut self, now_s: i64);             // 0행 채우기 상한 고정
      pub(crate) fn drain_completed(&mut self, now_s: i64) -> Vec<OpenLoopSecond>; // ts < now_s만, 빈 초 0행 채움
      pub(crate) fn drain_all(&mut self) -> Vec<OpenLoopSecond>;      // 최종: 남은 전부(+end_s까지 0행)
  }
  ```
  0행 채우기 범위 = `[max(start_second, last_emitted+1), min(now_s−1, end_s.unwrap_or(i64::MAX))]`, 결과는 `ts` 오름차순.

- [ ] **Step 1: 카운터 단위 테스트 작성** (`open_loop_counters.rs`)
  - `drain_completed_excludes_current_second`: `new(10)`, `record_at(10,Launched)`, `record_at(11,Dropped)` → `drain_completed(11)` = `[{10,1,0,0}]`, 다시 `drain_completed(12)` = `[{11,0,0,1}]`.
  - `zero_fill_between_records`: `new(10)`, `record_at(13,Completed)` → `drain_completed(15)` = ts `[10,11,12,13,14]`, 10·11·12·14는 전부 0.
  - `no_zero_fill_after_scheduler_end`: `new(10)`, `end_scheduler(12)`, `record_at(14,Completed)` → `drain_all()`의 ts = `[10,11,12,14]`(13 없음).
  - `record_uses_clock_and_is_counted_once`: `new(현재 초)`, `record(Launched)` 2회 → `drain_all()`의 launched 합 == 2.
- [ ] **Step 2: 실행 → 컴파일 실패 확인**: `cargo test -p handicap-engine open_loop_counters` → FAIL(모듈 없음).
- [ ] **Step 3: `OpenLoopCounters` 구현** — `std::sync::Mutex`로 감쌀 것을 전제(내부 동기화 없음).
- [ ] **Step 4: 통합 테스트 작성** (`crates/engine/tests/open_loop_seconds.rs`, `tests/open_loop.rs`의 wiremock·plan 헬퍼 패턴 재사용)
  - `per_second_dropped_sums_to_run_total`: `max_in_flight=1`, 응답 지연 200ms, `target_rps=20`, 3초 → 모든 flush의 `open_loop_seconds[].dropped` 합 == 최종 flush `dropped` 값, 그리고 > 0.
  - `launched_plus_dropped_equals_attempts_and_completed_le_launched`: 같은 설정에서 Σlaunched + Σdropped ≥ 1, Σcompleted ≤ Σlaunched, Σcompleted == wiremock이 받은 요청 수(요청 1개 시나리오).
  - `started_at_on_every_open_loop_flush`: 모든 flush가 `open_loop_started_at_ms == Some(v)`(같은 v), v는 테스트 시작 전후 `SystemTime` 범위 안.
  - `rows_every_second_while_scheduler_runs`: 응답 지연 3s·`max_in_flight=1`·`target_rps=1`·4초 → ts가 시작 초부터 끊김 없이 연속(0행 포함).
  - `closed_loop_flush_has_no_open_loop_fields`: `run_scenario` 1초 → 모든 flush `open_loop_seconds.is_empty()` ∧ `open_loop_started_at_ms.is_none()`.
- [ ] **Step 5: 실행 → FAIL 확인**: `cargo test -p handicap-engine --test open_loop_seconds`.
- [ ] **Step 6: runner 배선**
  - `MetricFlush`에 두 필드. closed-loop·vu-curve 4개 리터럴은 `vec![]`/`None`(`crates/engine/CLAUDE.md` "6 flush 사이트" 규칙 — `grep -n "MetricFlush {" crates/engine/src/runner.rs`로 6곳 전부 확인).
  - `run_scenario_open_loop`: `started_at = Instant::now()` 바로 옆에서 `started_at_ms = SystemTime::now()` epoch ms. `counters = Arc::new(std::sync::Mutex::new(OpenLoopCounters::new(started_at_ms.div_euclid(1000))))`.
  - 스케줄 루프: 슬롯 획득 성공 → `Launched`, `Err(_)` arm의 `dropped += 1` 옆 → `Dropped`(잠금은 짧게, `.await` 넘겨 잡지 않음). 루프 종료 직후 `end_scheduler(chrono_second())`.
  - `run_arrival`에 `counters: &Arc<std::sync::Mutex<OpenLoopCounters>>` 인자 추가. `let r = execute_steps(…).await;` → `Completed` 기록 → `r?;`(데이터셋 소진 조기 반환은 기록 안 함).
  - 주기 flusher: 같은 잠금으로 `drain_completed(now_s)`, `has_data`에 `|| !open_loop_seconds.is_empty()` 추가(`:1829`), 매 flush `open_loop_started_at_ms: Some(started_at_ms)`.
  - 최종 flush: `drain_all()`, `Some(started_at_ms)`. 최종 flush는 원래대로 무가드. 기존 `dropped: total_dropped` 그대로.
- [ ] **Step 7: 실행 → PASS**: `cargo test -p handicap-engine --test open_loop_seconds` 와 `cargo test -p handicap-engine open_loop_counters`, 그리고 `cargo test -p handicap-engine --test open_loop`(기존 회귀).
- [ ] **Step 8: 되돌려 확인** — `has_data` 새 항을 지우면 `rows_every_second_while_scheduler_runs`가 RED인지, `Completed`를 `r?` 뒤로 옮기면 실패하는 테스트가 있는지(없으면 `completed_recorded_on_engine_error` 추가: 미정의 `{{x}}` URL → `CastFailed`류 엔진 오류 반복도 completed로 센다) 확인 후 원복.
- [ ] **Step 9: Commit** — `feat(engine): open-loop 초 단위 시작·완료·버림 계수 + 시작 시각 (계단 시험 a)`.

### Task 2: proto 12·13 + 워커 매핑

**Files:**
- Modify: `crates/proto/proto/coordinator.proto`(`MetricBatch` `:83`), `crates/worker/src/lib.rs`(매핑 `:269`·`:354–365`, 빈 배치 가드 `:335–349`)
- Test: `crates/worker/src/lib.rs` `#[cfg(test)]`(`:990` 모듈). 지금 빈 배치 가드와 `MetricBatch` 조립은 `execute_assignment`의 `tokio::spawn` 클로저 안(`:257–371`)에 인라인이라 테스트할 수 없다 → **먼저 순수 함수로 뺀다**: `fn flush_to_batch(flush: MetricFlush, run_id: &str, worker_id: &str) -> Option<pb::MetricBatch>`(건너뛸 배치면 `None`), 클로저는 이 함수를 부른다(동작 불변 — 기존 가드 항 전부 보존).

**Interfaces:**
- Consumes: Task 1 `MetricFlush.open_loop_seconds`, `open_loop_started_at_ms`.
- Produces: `pb::MetricBatch { open_loop_seconds: Vec<pb::OpenLoopSecond>, open_loop_started_at_ms: i64 /*0=없음*/ }`, `pb::OpenLoopSecond { ts_second: i64, launched: u64, completed: u64, dropped: u64 }`.

- [ ] **Step 1: 테스트**(대상 = `flush_to_batch`; 기존 가드 의미 보존 테스트 `empty_flush_is_skipped`·`final_flush_with_only_dropped_is_sent`도 함께) — `batch_carries_open_loop_seconds_and_start`: `MetricFlush{windows: vec![], open_loop_seconds: vec![{5,1,0,0}], open_loop_started_at_ms: Some(5_123), dropped: 0, ..}` → 만든 배치가 `Some`이고 필드가 그대로. `flush_with_only_open_loop_seconds_is_not_skipped`: 위와 같은 flush가 빈 배치로 건너뛰어지지 않음.
- [ ] **Step 2: FAIL 확인**: `cargo test -p handicap-worker`.
- [ ] **Step 3: proto 추가** — `MetricBatch`에 두 필드, `OpenLoopSecond`는 **최상위 message**(`pb::OpenLoopSecond`, `MetricBatch` 안에 중첩하지 않음):
  ```proto
  repeated OpenLoopSecond open_loop_seconds = 12;   // MetricBatch 안
  int64 open_loop_started_at_ms = 13;                // MetricBatch 안, 0 = 없음
  message OpenLoopSecond { int64 ts_second = 1; uint64 launched = 2; uint64 completed = 3; uint64 dropped = 4; }  // 최상위
  ```
  워커 매핑 + 가드에 `&& flush.open_loop_seconds.is_empty()`. `MetricBatch{}` 리터럴 전부(`grep -rn "MetricBatch {" crates/`) 컴파일 맞춤(controller coordinator 테스트 포함 — 새 필드 `vec![]`/`0`).
- [ ] **Step 4: PASS**: `cargo test -p handicap-worker` + `cargo test --workspace --no-run`(테스트 리터럴까지 컴파일).
- [ ] **Step 5: 되돌려 확인** — 가드 항 제거 → `flush_with_only_open_loop_seconds_is_not_skipped` RED → 원복.
- [ ] **Step 6: Commit** — `feat(proto,worker): MetricBatch open_loop_seconds(12)·open_loop_started_at_ms(13)`.

### Task 3: migration 0024 + 저장·수집·삭제 cascade

**Files:**
- Create: `crates/controller/src/store/migrations/0024_run_open_loop_seconds.sql`, `crates/controller/src/store/open_loop.rs`
- Modify: `crates/controller/src/store/mod.rs`(`MIGRATION_SQL_0024` const + `connect()` 실행 + `pub mod open_loop`), `crates/controller/src/grpc/coordinator.rs`(`ingest_metrics` `:1928`), `crates/controller/src/store/scenarios.rs`(cascade 목록 `:199–208`, "8테이블" 주석)
- Test: `crates/controller/src/store/open_loop.rs`(`#[cfg(test)]`), `crates/controller/src/grpc/coordinator.rs` 테스트(`ingest_accumulates_dropped_into_runs` `:2803` 옆), `crates/controller/tests/scenario_delete_api_test.rs`

**Interfaces:**
- Consumes: Task 2 pb 필드.
- Produces:
  ```rust
  pub struct OpenLoopSecondRow { pub worker_id: String, pub ts_second: i64, pub launched: i64, pub completed: i64, pub dropped: i64 }
  pub struct WorkerStartRow { pub worker_id: String, pub started_at_ms: i64 }
  pub async fn insert_open_loop_seconds(db: &Db, run_id: &str, worker_id: &str, rows: &[(i64, i64, i64, i64)]) -> sqlx::Result<()>; // (ts,launched,completed,dropped), ON CONFLICT DO NOTHING
  pub async fn insert_worker_start(db: &Db, run_id: &str, worker_id: &str, started_at_ms: i64) -> sqlx::Result<()>; // INSERT OR IGNORE
  pub async fn open_loop_seconds(db: &Db, run_id: &str) -> sqlx::Result<Vec<OpenLoopSecondRow>>; // ORDER BY worker_id, ts_second
  pub async fn worker_starts(db: &Db, run_id: &str) -> sqlx::Result<Vec<WorkerStartRow>>;
  ```
- [ ] **Step 1: 테스트**
  - store: `open_loop_insert_is_idempotent`(같은 행 2회 → 1행, 첫 값 유지), `worker_start_first_wins`.
  - coordinator: `ingest_stores_open_loop_seconds_and_start` — `open_loop_seconds` 2행 + `open_loop_started_at_ms=7_000` 배치 ingest → 두 테이블에 반영, `started_at_ms=0` 배치는 starts 행 안 만듦. 기존 `runs.dropped` 누적 불변.
  - delete: `scenario_delete_api_test.rs`의 테이블 열거에 두 테이블 추가 + 해당 행이 지워지는지 단언.
- [ ] **Step 2: FAIL 확인**: `cargo test -p handicap-controller open_loop` 등.
- [ ] **Step 3: 구현** — `/new-migration run_open_loop_seconds` 스킬로 번호·패턴 확인. SQL은 spec §4.3 그대로. ingest는 `insert_batch` 옆에서 호출, 실패는 기존처럼 `warn!`.
- [ ] **Step 4: PASS**: `cargo test -p handicap-controller` (해당 테스트) + `cargo test -p handicap-controller --test scenario_delete_api_test`.
- [ ] **Step 5: Commit** — `feat(controller): migration 0024 run_open_loop_seconds·run_worker_starts 수집 + 삭제 cascade`.

### Task 4: `StairConfig` + 펼침 + 정규화(5개 진입점)

**Files:**
- Create: `crates/controller/src/stair.rs`(이 task는 config·expand·normalize만; 판정은 Task 5에서 같은 파일에 추가)
- Modify: `crates/controller/src/lib.rs`(`pub mod stair`), `crates/controller/src/store/runs.rs`(`Profile` `:116`에 `stair` 필드), `crates/controller/src/api/runs.rs:1017`, `crates/controller/src/api/presets.rs:84·144`, `crates/controller/src/api/schedules.rs:182`(`&mut`), `crates/controller/src/schedule/runner.rs:148`
- Modify(컴파일): `Profile {…}` 리터럴 전부에 `stair: None` — `Profile`엔 `Default`가 없다. 목록 = `grep -rln "apply_scenario_think_time:" crates/`(약 12파일·28곳: report.rs, grpc/profile.rs, grpc/coordinator.rs, schedule/runner.rs, store/presets.rs, store/schedules.rs, store/runs.rs, api/runs.rs, tests/{report,export_routes,crash_recovery,dispatcher_subprocess}_test.rs 등). 확인 = `cargo test --workspace --no-run`.
- Test: `crates/controller/src/stair.rs` 단위, `crates/controller/tests/api_test.rs`(run 생성), `presets_api_test.rs`, `schedules_api_test.rs`

**Interfaces:**
- Produces:
  ```rust
  #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
  pub struct StairConfig { pub targets: Vec<u32>, pub hold_seconds: u32, pub ramp_seconds: u32, pub discard_seconds: u32,
                           #[serde(default, skip_serializing_if = "Option::is_none")] pub p99_cap_ms: Option<u32> }
  pub fn expand_stair(c: &StairConfig) -> Vec<handicap_engine::Stage>;          // [ramp t_i, hold t_i] × n
  pub fn validate_stair(c: &StairConfig) -> Result<(), String>;                 // spec 범위, 한국어 사용자 문구
  pub fn normalize_stair(p: &mut Profile) -> Result<(), String>;                // stair 없으면 no-op
  ```
  `normalize_stair` 오류는 각 핸들러에서 `validate_run_config`가 쓰는 것과 같은 400 변형으로 감싼다.
- [ ] **Step 1: 단위 테스트**: `expand_two_targets`(`[100,200]`, ramp 5, hold 60 → `[{100,5},{100,60},{200,5},{200,60}]`), `validate_rejects_*`(1개, 51개, 감소, 중복, 0, 1_000_001, hold 19, ramp 0, discard > hold−10, cap 0), `normalize_fills_stages`, `normalize_accepts_identical_stages_roundtrip`, `normalize_rejects_different_stages`, `normalize_rejects_target_rps`·`vu_stages`·`duration_seconds>0`, `normalize_noop_without_stair`, `profile_without_stair_serializes_without_key`(기존 profile JSON 바이트 불변).
- [ ] **Step 2: API 테스트**: run 생성 stair-only(`max_in_flight` 포함) → 201·저장 profile에 `stair`와 펼친 `stages`; stair + `max_in_flight` 없음 → 400(기존 open-loop 규칙); 프리셋 생성·수정·스케줄 생성·수정 각각 stair 저장 성공 + 잘못된 stair 400; 스케줄 발사 경로는 저장 profile이 통과(`scheduler_trigger_test.rs` 또는 schedule runner 단위에서 stair 저장본 1회 발사).
- [ ] **Step 3: FAIL 확인**, **Step 4: 구현**(5곳 모두 `validate_run_config` **앞**에서 `normalize_stair(&mut body.profile)`; `schedules.rs:182` 공용 게이트는 시그니처를 `&mut`로), **Step 5: PASS**: `cargo test -p handicap-controller stair` + 위 통합 테스트 파일들.
- [ ] **Step 6: 확인** `grep -rn "validate_run_config(" crates/controller/src` — 테스트 모듈 밖 호출부 5곳(`api/runs.rs:1017`, `api/presets.rs:84·144`, `api/schedules.rs:182`, `schedule/runner.rs:148`; 줄번호는 편집 뒤 이동) 모두 앞에 정규화가 있는지 orchestrator가 diff로 확인.
- [ ] **Step 7: Commit** — `feat(controller): profile.stair 설정·stages 펼침·5개 진입점 정규화`.

### Task 5: 순수 판정 `stair::judge` (bench `saturation.py` 이식)

**Files:**
- Modify: `crates/controller/src/stair.rs`
- Test: 같은 파일 `#[cfg(test)] mod judge_tests`

**Interfaces:**
- Produces:
  ```rust
  pub struct StepNumbers { pub target: u32, pub achieved: Option<f64>, pub dropped: Option<u64>, pub error_rate: f64, pub p99_us: u64, pub measured: bool }
  #[serde(rename_all = "snake_case")] pub enum StepState { Ok, Spike, Saturated, Unconfirmed, After, NotMeasured }
  #[serde(rename_all = "snake_case")] pub enum ReasonKind { Achieved, Dropped, Errors, P99Cap, P99Relative }
  pub struct Reason { pub kind: ReasonKind, pub value: f64 }   // achieved: 비율(0..1), dropped: 개수, errors: 비율, p99_cap: p99 ms, p99_relative: 배수
  #[serde(rename_all = "snake_case")] pub enum HeadlineKind { Saturated, Unconfirmed, AllOk, OkThenUnmeasured, NoData }
  pub struct Judgement { pub states: Vec<StepState>, pub reasons: Vec<Vec<Reason>>, pub slot_limited: Vec<bool>,
                         pub last_ok: Option<usize>, pub spikes: Vec<usize>, pub saturation: Option<usize>,
                         pub knee: Option<usize>, pub headline: HeadlineKind, pub later_ok_after_first_fail: bool }
  pub fn step_ok(cur: &StepNumbers, prev_ok: Option<&StepNumbers>, p99_cap_ms: Option<u32>) -> (bool, Vec<Reason>);
  pub fn judge(steps: &[StepNumbers], cfg: &StairConfig) -> Judgement;   // spec §5 시그니처, cap은 cfg.p99_cap_ms
  ```
  `measured`는 호출자(Task 6)가 `2 * measured_seconds >= hold − discard`(정수, spec의 `/2` 미만 판정과 같은 뜻)로 채운다. `after` 계단의 사유는 고정 ref(= 마지막 정상)로 계산해 표시하되 `slot_limited`는 `false`(경고 줄은 판정에 쓰인 계단만). 규칙은 spec §5.3 그대로(조건 순서·cap이 배수 규칙 대체·첫 계단 cap 적용·spike는 `last` 필요·not_measured에서 걷기 종료·`after`/`unconfirmed`는 표시 전용). `slot_limited[i]` = 실패 사유가 `{Achieved, Dropped}`의 부분집합이고 비어 있지 않음. `later_ok_after_first_fail` = `last_ok == None ∧ saturation == Some(0)`이고 뒤 측정 계단 중 `step_ok(·, None)`이 참인 게 있음(머리말 힌트용).
- [ ] **Step 1: 표 테스트 작성** — 헬퍼 `s(target, achieved, p99_us, err, dropped)`(measured=true), `nm(target)`(measured=false). 단언 = `(last_ok, spikes, saturation)` + 명시한 곳만 `states`/`headline`:

  | 이름 | 입력(p99_us 등) | 기대 |
  |---|---|---|
  | `all_ok` | 10000,12000,15000 | (Some(2), [], None), AllOk |
  | `one_spike` | 10000,12000,40000,15000,18000 | (Some(4), [2], None), states[2]=Spike |
  | `consecutive_fail` | 10000,12000,40000,50000,60000 | (Some(1), [], Some(2)), states=[Ok,Ok,Saturated,Saturated,After] |
  | `spike_then_consecutive_fail` | 10000,12000,40000,15000,50000,60000 | (Some(3), [2], Some(4)), states=[Ok,Ok,Spike,Ok,Saturated,Saturated] |
  | `first_fail_then_ok_is_not_spike` | step0 dropped=5, step1 ok | (None, [], Some(0)), states[1]=After, `later_ok_after_first_fail` |
  | `last_step_fails` | 10000,12000,40000 | (Some(1), [], Some(2)) |
  | `sub_ms_ref_cap_5ms` | 500, 4999 / 500, 5000 | 앞: (Some(1),[],None) / 뒤: (Some(0),[],Some(1)) |
  | `abs_cap_applies_to_first_step` | cap 20, p99 25000 | (None, [], Some(0)) |
  | `abs_cap_replaces_multiple_rule` | cap 100, 10000, 90000 | (Some(1), [], None) |
  | `not_measured_stops_walk` | ok, ok, nm, nm | (Some(1), [], None), OkThenUnmeasured, states[2..]=NotMeasured |
  | `unconfirmed_when_next_not_measured` | 10000(ok), 40000(fail), nm | (Some(0), [], Some(1)), states[1]=Unconfirmed, Unconfirmed |
  | `no_data` | nm, nm | (None, [], None), NoData |
  | `achieved_boundary` | target 100: achieved 94.9 실패 / 95.0 정상 | |
  | `error_rate_boundary` | 0.0099 정상 / 0.01 실패 | |
  | `slot_limited_only_drop` | 실패 사유 dropped만 → true; dropped+p99_relative → false | |
  | `knee_at_1_5x` | 10000,12000,18000 전부 정상 | knee=Some(2) |
  | `knee_ignores_sub_ms` | 400,700 | knee=None |

  각 기대값 옆 주석에 bench `_walk` 결과(마지막 정상 index·blips·포화 index)를 적는다. 가능하면 bench 함수를 손으로 따라가 같은지 확인한 메모를 테스트 위 주석 한 줄로.
- [ ] **Step 2: FAIL**, **Step 3: 구현**, **Step 4: PASS**: `cargo test -p handicap-controller judge_tests`.
- [ ] **Step 5: 되돌려 확인**(spec §5.3은 표 테스트마다를 요구하나 **대표 2개로 의도적 축소** — 나머지는 bench 대조 주석이 근거) — ① spike 조건의 `last.is_some()` 제거 → `first_fail_then_ok_is_not_spike` RED ② cap 분기에서 배수 규칙도 보게 → `abs_cap_replaces_multiple_rule` RED. 원복.
- [ ] **Step 6: Commit** — `feat(controller): 계단 판정 순수 함수 stair::judge — bench saturation.py 이식`.

### Task 6: 리포트 계단 집계 + 신뢰도 연동

**Files:**
- Modify: `crates/controller/src/report.rs`(`ReportJson` `:18`, `build_report` `:506`), `crates/controller/src/stair.rs`(집계 함수), `crates/controller/src/api/runs.rs`(`build_report_for_run` `:1076` — stair가 있을 때만 두 테이블 조회), `crates/controller/src/validity.rs`(`derive_validity` `:67`)
- Create: `testdata/stair_report_golden.json`
- Test: `crates/controller/src/report.rs` `mod tests`, `crates/controller/tests/report_test.rs`(기존 불변 확인)

**Interfaces:**
- Consumes: Task 3 `OpenLoopSecondRow`·`WorkerStartRow`, Task 4 `StairConfig`, Task 5 `judge`.
- Produces:
  ```rust
  #[derive(Default)] pub struct StairInputs { pub open_loop: Vec<OpenLoopSecondRow>, pub starts: Vec<WorkerStartRow> }
  pub fn build_stair_report(profile: &Profile, run_dropped: u64, rows: &[WindowWithHdr], inp: &StairInputs) -> Option<StairReport>; // profile.stair 없으면 None
  // report.rs: fresh_hist → pub(crate)
  // build_report 새 마지막 인자: stair_inputs: &StairInputs  (기존 호출부·테스트는 &StairInputs::default())
  // ReportJson: #[serde(default, skip_serializing_if = "Option::is_none")] pub stair: Option<StairReport>
  // derive_validity 새 마지막 인자: stair_dropped_explained: bool  (true면 load_not_delivered 사유를 넣지 않음)
  ```
  `StairReport` 직렬화 형태 = spec §5.6 그대로(필드명·`state`·`headline.kind` 문자열, `p*_us` 정수, `seconds[].offset_s`, `bands[].kind ∈ ramp|discard|measure`, `target_line`, `headline.first_fail_hint` = `Judgement.later_ok_after_first_fail`, `max_in_flight` = profile 값, `dropped_total` = `Some(run_dropped)`(run 합계 `runs.dropped` 그대로 — spec §5.6; 초 단위 합과 같다는 것은 Task 1 불변식 테스트가 보장)).
  **골든 파일**(부트스트랩: 처음엔 테스트가 `to_string_pretty` 결과를 출력하게 해 파일을 쓰고, 그다음 같음 단언으로 바꾼다 — `include_str!`라 파일이 없으면 테스트 크레이트가 컴파일되지 않으므로 파일을 먼저 만든다): `testdata/stair_report_golden.json`(repo 루트 `testdata/`, `compare_golden.json` 선례 — `export.rs:676`·`ui/src/compare/__tests__/compareReports.test.ts:9`) — 대표 계단 run 하나(포화·튐·knee·⚠·null 필드 포함)의 `StairReport` 직렬화. Rust 테스트 `stair_report_matches_golden`이 같음을 단언(바뀌면 의도적으로 갱신). Task 8이 이 파일을 읽는다.
  **테스트 위치**: `WindowWithHdr`·`RunRow` fixture 헬퍼(`make_hdr_bytes` `:1183`, `run_row` `:1193`)가 `report.rs`의 `mod tests` 안에 private으로 있으므로 계단 집계·validity 테스트도 **`report.rs` `mod tests`에** 둔다.
- [ ] **Step 1: 테스트 작성** — `WindowWithHdr` fixture는 HDR을 실제로 만들어 인코딩(`report.rs` `mod tests`의 `make_hdr_bytes` `:1183`·`run_row` `:1193` 재사용):
  - `stair_aligned_t0_counts_measure_seconds`: ramp 1·hold 20·discard 5, t0 = 정확히 초 경계 → step0 `measured_seconds == 15`, `achieved == Σcompleted/15`.
  - `stair_offset_t0_excludes_partial_edges`: t0 = 경계+300ms → 14.
  - `stair_stalled_system_is_saturated_not_unmeasured`: step1 측정 구간에 `run_metrics` 행 0, `run_open_loop_seconds`는 launched·dropped > 0 → step1 achieved 0, state Saturated.
  - `stair_scheduler_ended_early_is_not_measured`: launched+dropped>0 마지막 초가 step1 측정 구간 1/3 지점, 뒤로 completed만 있는 꼬리 → step1 NotMeasured.
  - `stair_two_workers_align_per_worker_t0`: 워커 A t0=1000.0s, B t0=1003.0s, 각자 자기 오프셋 구간에 행 → 계단 숫자 = 두 워커 합(achieved는 율의 합).
  - `stair_idle_worker_excluded`: 워커 C는 0행만 → `measured_seconds`가 0이 되지 않음.
  - `stair_t0_fallback_sets_note`: starts 행 없음 → `notes.t0_estimated`.
  - `stair_no_open_loop_rows_unknown`: open_loop 행 없음 → achieved·dropped `null`, `notes.open_loop_unknown`, `dropped_explained == false`.
  - `stair_p99_is_merged_hdr_not_average`: 계단 측정 2초 — 1초 차에 1ms×99, 2초 차에 100ms×1·1ms×0 → p99_us == 두 히스토그램 머지의 p99(직접 계산해 단언), 초별 p99 평균과 다름.
  - `stair_two_requests_per_iteration`: step_id 2개가 같은 초에 같은 count → `throughput_rps == 2 × achieved`.
  - `stair_head_ratio_warns`: 측정 30초 중 첫 10초 p99 10ms, 나머지 4ms → `discard_warning`.
  - `stair_dropped_in_latency_failed_step_is_explained`: drop이 p99_relative로도 실패한 Saturated 계단에만 → `dropped_explained`, validity에 `load_not_delivered` 없음.
  - `stair_slot_limited_keeps_banner`: drop만으로 실패(지연 정상) → `slot_limited_targets == [t]`, `dropped_explained == false`, validity에 `load_not_delivered` 있음(인사이트가 있을 때).
  - `non_stair_report_has_no_stair_key`: 기존 fixture run → `serde_json::to_value(report)`에 `"stair"` 키 없음.
  - `stair_bands_and_target_line_shape`: 2계단(ramp 2·hold 20·discard 5) → bands 6개(offset 0–2 ramp·2–7 discard·7–22 measure·22–24·24–29·29–44), target_line 꼭짓점이 펼친 stages와 일치.
  - `stair_seconds_align_two_workers`: t0가 3초 다른 두 워커의 같은 offset 초가 `seconds`의 한 칸으로 합쳐지고 p99는 머지 값.
  - `stair_measure_times_and_launched_rate`: `measure_start_ms`/`measure_end_ms`가 포함한 첫 초 시작·마지막 초 끝(가장 이른 t0 워커 기준), `launched_rate` = Σlaunched/측정 초.
  - `stair_dropped_in_ramp_segment_not_explained`: dropped가 정상 계단의 상승 구간에만 → `dropped_explained == false`.
  - `stair_dropped_before_first_step_not_explained`: dropped가 t0 이전 초 → false.
  - `stair_report_matches_golden`.
- [ ] **Step 2: FAIL**, **Step 3: 구현** — spec §5.1–§5.7. `build_report_for_run`은 `row.profile.stair.is_some()`일 때만 `open_loop_seconds`·`worker_starts` 조회. validity 호출 전에 stair를 계산해 `dropped_explained`를 넘긴다.
- [ ] **Step 4: PASS**: `cargo test -p handicap-controller report::tests` + `cargo test -p handicap-controller --test report_test` + `cargo test -p handicap-controller validity`.
- [ ] **Step 5: 되돌려 확인** — `last_w`를 "임의 행의 최대 ts"로 바꾸면 `stair_scheduler_ended_early_is_not_measured` RED; 측정 초를 "행 있는 초"로 세면 `stair_stalled_system_is_saturated_not_unmeasured` RED. 원복.
- [ ] **Step 6: Commit** — `feat(controller): 리포트 계단 집계(ReportJson.stair) + 슬롯 부족 구분·신뢰도 연동`.

### Task 7: XLSX `Stairs` 시트 + `report-stairs.csv`

**Files:**
- Modify: `crates/controller/src/export.rs`(`report_to_xlsx` `:458`, 새 `report_to_stairs_csv`), `crates/controller/src/api/runs.rs`(새 핸들러 `report_stairs_csv`, `report_insights_csv` `:1169` 패턴), `crates/controller/src/app.rs`(`:74` 옆 라우트 `/runs/{id}/report-stairs.csv`)
- Test: `crates/controller/src/export.rs` 테스트, `crates/controller/tests/export_routes_test.rs`

**Interfaces:**
- Consumes: Task 6 `ReportJson.stair`.
- Produces: `pub fn report_to_stairs_csv(report: &ReportJson) -> Option<Vec<u8>>`(stair 없으면 `None` → 핸들러 404). CSV 머리 = `index,target_per_s,achieved_per_s,throughput_rps,p50_ms,p95_ms,p99_ms,error_rate,dropped,measure_start,measure_end,state,reasons`(시각은 RFC3339 UTC, null은 빈 칸, ms는 µs/1000 소수 셋째 자리). CSV 1행 = 머리말 문장(따옴표 한 칸), 2행 빈 줄, 3행부터 머리글+표 — US5 "같은 판정 머리말"(부재 중 판단: 스프레드시트에서 열면 첫 칸에 머리말이 보인다. 기계 처리 시 2줄 건너뛰기 필요 — 비용 낮음). 머리말 문장은 Rust 쪽 고정 한국어(Task 11 `headlineText`와 같은 뜻, 같은 6종).
- [ ] **Step 1: 테스트**: `xlsx_has_stairs_sheet_only_for_stair_run`(시트 이름 목록 비교 — 비계단 run은 기존 목록 그대로), `stairs_csv_header_and_rows`, 라우트 `report_stairs_csv_404_for_non_stair` / `200_for_stair`(terminal run).
- [ ] **Step 2: FAIL**, **Step 3: 구현**(Stairs 시트 첫 줄들 = 머리말 문장(ko 문구와 같은 뜻의 고정 한국어) + 빈 줄 + 표), **Step 4: PASS**: `cargo test -p handicap-controller export` + `--test export_routes_test`.
- [ ] **Step 5: Commit** — `feat(controller): 계단 표 내보내기 — XLSX Stairs 시트·report-stairs.csv`.

### Task 8: UI 스키마 (`StairConfigSchema`·`StairReportSchema`)

**Files:**
- Modify: `ui/src/api/schemas.ts`(`ProfileSchema` `:74–114`, `ReportSchema` `:515`), `ui/src/api/client.ts`(stairs CSV URL 헬퍼 — 기존 insights CSV URL 함수 옆)
- Test: `ui/src/api/__tests__/stairSchemas.test.ts`(신규)

**Interfaces:**
- Produces: `StairConfigSchema`, `type StairConfig`, `StairReportSchema`, `type StairReport`, `type StairStep`, `type StairState = "ok"|"spike"|"saturated"|"unconfirmed"|"after"|"not_measured"`, `ProfileSchema.stair: StairConfigSchema.optional()`, `ReportSchema.stair: StairReportSchema.optional()`, `reportStairsCsvUrl(runId: string): string`.
- [ ] **Step 1: 테스트**: `testdata/stair_report_golden.json`(Task 6 산출, `compareReports.test.ts:9`처럼 `readFileSync(nodePath.resolve(__dirname, "../../../../testdata/stair_report_golden.json"))`)이 `StairReportSchema.parse` 통과 + 기존 report fixture에 `stair`로 끼운 것이 `ReportSchema.parse` 통과; `stair` 없는 기존 fixture도 통과; profile `stair` round-trip(`ProfileSchema.parse`가 지우지 않음).
- [ ] **Step 2: FAIL**, **Step 3: 구현**, **Step 4: PASS**: `cd ui && pnpm vitest run src/api/__tests__/stairSchemas.test.ts`.
- [ ] **Step 5: Commit** — `feat(ui): 계단 설정·계단 리포트 스키마`.

### Task 9: UI 계단 순수 로직 (`loadModel` 확장)

**Files:**
- Create: `ui/src/components/run/stair.ts`
- Modify: `ui/src/components/run/loadModel.ts`(`LoadModelState`·`buildLoadProfile` `:48–97`·`loadModelErrors`·`deriveLoadMode` `:174–183`·`LoadProfileFields` `:23–36`), `ui/src/components/run/runSummary.ts`, `ui/src/components/run/openLoopChecks.ts`(`OpenLoopInput`에 `stairTargets?: number[]` — stair면 peak = 최대 목표, 유휴 워커·무의미 슬롯 둘 다), `ui/src/components/run/loadShapes.ts`(라벨만), `ui/src/i18n/ko.ts`, **`deriveLoadMode`가 `"stair"`를 내므로 그 소비처**: `ui/src/print/conditions.ts`(`:33–71` — 「열린 루프 계단 · N계단 {min}–{max} req/s」), `ui/src/runs/profileSummary.ts`(`:13–20` — 「계단 {n}개 · 최대 {X}/s」), `ui/src/runs/runFilterSort.ts`(`ModeKey`·`MODE_KEYS` `:6·27`에 `open_stair`), `MODE_LABEL` 정의 파일(`grep -rn MODE_LABEL ui/src` — 라벨 「계단」)
- Test: `ui/src/components/run/__tests__/stair.test.ts`(신규), 기존 `loadModel`·`runSummary`·`openLoopChecks` 테스트 파일에 케이스 추가

**Interfaces:**
- Produces:
  ```ts
  export type StairDraft = { targets: string; hold: string; ramp: string; discard: string; p99Cap: string };
  export const STAIR_DEFAULTS: StairDraft = { targets: "", hold: "60", ramp: "5", discard: "15", p99Cap: "" };
  export function parseTargets(s: string): { ok: true; values: number[] } | { ok: false; error: StairTargetsError };
  export type StairTargetsError = "empty" | "notInteger" | "outOfRange" | "notIncreasing" | "tooFew" | "tooMany";
  export function generateTargets(goal: number, maxMultiple: 1.5 | 2 | 2.5 | 3): number[]; // 25%,50%,75%,100%,+25%p…max, 반올림·0 제거·중복 제거
  export function expandStair(c: StairConfig): Stage[];         // 서버 expand_stair와 같은 수식
  export function stairErrors(d: StairDraft): Partial<Record<"targets"|"hold"|"ramp"|"discard"|"p99Cap", string>>; // ko 문구
  export function stairSummary(c: StairConfig): { steps: number; totalSeconds: number; measureSeconds: number };
  // loadModel.ts
  rateMode: "fixed" | "curve" | "stair";  LoadModelState.stair: StairDraft
  ```
  `parseTargets`는 공백·끝 쉼표 허용(`"100, 200,"` → [100,200]), 그 밖은 오류.
- [ ] **Step 1: 테스트**: `parseTargets_trailing_comma_and_spaces`, `parseTargets_rejects_decreasing`·`duplicate`·`decimal`·`zero`·`too_many(51)`·`too_few(1)`·`empty`; `generateTargets(400, 2)` == `[100,200,300,400,500,600,700,800]`, `generateTargets(400, 1.5)` == `[100,200,300,400,500,600]`, `generateTargets(3, 1.5)` == `[1,2,3,4,5]`(배수 0.25·0.5·0.75·1·1.25·1.5 × 3 = 0.75·1.5·2.25·3·3.75·4.5 → `Math.round` 1·2·2·3·4·5 → 중복 제거), `generateTargets(1, 1.5)` == `[1,2]`(0.25→0 제거, 0.5·0.75·1·1.25→1, 1.5→2 — JS `Math.round(0.5) === 1`) — 결과가 2개 미만이면 `parseTargets`의 `tooFew` 오류가 제출을 막는다; `expandStair` 서버와 같은 예시; `buildLoadProfile` stair 분기 == `{ stair, max_in_flight, worker_count, vus: 0, duration_seconds: 0 }`이고 `stages` 키 없음; `deriveLoadMode({stair, stages})` == open+stair(stair 우선); `runSummary` stair 문장; `openLoopChecks` stair면 peak = 최대 목표(유휴 워커·무의미 슬롯 둘 다 — run 전체에서 몫이 0인 워커만 유휴); `loadShapes` `step` 라벨 == "점증 스트레스"; `conditions` 계단 문장, `profileSummary` 계단 문장, `modeKey(stair profile) == "open_stair"`이고 그 키로 필터하면 계단 run이 남음.
- [ ] **Step 2: FAIL**, **Step 3: 구현** — 문구는 `ko.loadModel.stair*` 네임스페이스. 오류 문구 예: `notIncreasing` → "목표는 앞의 값보다 커지게 적어 주세요 (예: 100, 200, 300)".
- [ ] **Step 4: PASS**: `cd ui && pnpm vitest run src/components/run src/print src/runs`.
- [ ] **Step 5: Commit** — `feat(ui): 계단 입력 순수 로직 — 목록 파싱·도우미·펼침·검증`.

### Task 10: UI 실행 창 「계단」 탭 (RunDialog·ScheduleForm·프리셋·재실행)

**Files:**
- Modify: `ui/src/components/run/LoadModelFields.tsx`(세그먼트 `:442–495`·라디오 분기·사이징 도우미 `:750·791`·stair 입력 블록 신규 렌더), `ui/src/components/run/RunDialog.tsx`(`:90·187·250–342·430–440·476·494·757`), `ui/src/components/run/ScheduleForm.tsx`(`:75·248·251`), `ui/src/i18n/ko.ts`
- Create: `ui/src/components/run/StairFields.tsx`(목록 도우미 + 4입력 + 요약 줄 + 판정 기준 disclosure)
- Test: `ui/src/components/run/__tests__/StairFields.test.tsx`(신규), `RunDialog`·`ScheduleForm` 기존 테스트 파일에 케이스. Review Focus 3의 ScheduleForm 쪽은 "저장 스케줄 편집"으로 읽는다.

**Interfaces:**
- Consumes: Task 9 전부, Task 8 `StairConfig`.
- Produces: `<StairFields value: StairDraft onChange errors />`.
- sweep 의무: 시작 전에 `grep -rni "ratemode" ui/src` + `grep -rn '"fixed" | "curve"' ui/src` 결과 전체를 커밋 메시지 본문에 "지점: 처리" 목록으로 남긴다(테스트 파일 제외). 세그먼트·라디오 두 토글 모두 「계단」. 「계단」은 `loadModel === "open"`이고 상세 모드일 때만.
- 문구(ko.ts, 목업 ①):
  - 탭 「계단」; 도우미 제목 「목표 목록 만들기」, 「목표 (req/s)」 HelpTip "버텨야 할 요청 수 — 운영 피크 데이터가 있으면 그 값을 넣으세요. 요청 1개짜리 시나리오면 req/s = 반복/초입니다.", 「최대 배수」, 버튼 「목록 만들기」, 안내 "목표의 25%·50%·75%·100% 뒤로 25%씩 최대 배수까지 만듭니다. 만든 목록은 고칠 수 있습니다."
  - 「목표 목록 (req/s)」 placeholder "100, 200, 300", 「계단 유지 (초)」, 「상승 (초)」, 「앞부분 버림 (초)」 HelpTip "목표를 올린 직후 시스템이 적응하는 시간. 이 구간은 판정에서 빼고 차트에 회색으로 보여 줍니다. 자동 확장(HPA)이 있으면 늘리세요."
  - 요약 `(n, total, measure) => \`${n}계단 · 총 ${분}분 ${초}초 · 계단마다 측정 ${measure}초\``
  - 판정 기준(접힘, Section collapsible 이디엄): "달성 ≥ 목표의 95% · dropped 0 · 오류율 < 1% · p99 < 아래 계단의 3배(아래 계단이 1 ms 미만이면 5 ms)", 「절대 p99 상한 (ms, 선택)」 HelpTip "넣으면 '아래 계단의 3배' 규칙 대신 이 값으로 판정합니다." 값이 있으면 접힌 채 "1개 설정됨".
- 단순 모드 + 계단 선택: `RunDialog.tsx:757` 곡선 읽기 전용 카드와 같은 자리에 계단 요약 카드.
- [ ] **Step 1: 테스트**: `StairFields`: 도우미 입력 400·2× → 목록 칸 값 "100, 200, 300, 400, 500, 600, 700, 800"; 요약 줄 "8계단 · 총 8분 40초 · 계단마다 측정 45초"; 잘못된 목록 → 오류 문구 + RunDialog 제출 버튼 비활성. RunDialog: open-loop 상세 → 「계단」 세그먼트 존재·closed면 없음·단순 모드면 없음; 제출 payload에 `stair`·`max_in_flight`·`worker_count`·`vus:0`, `stages` 없음. `preset_with_stair_opens_stair_tab`: stair+stages 저장 프리셋 불러오기(RunDialog) → 「계단」 선택·목록 칸 채워짐·상세 모드. `schedule_edit_with_stair_opens_stair_tab`: ScheduleForm의 `initial`(저장 스케줄, stair+stages) → 「계단」 선택(ScheduleForm엔 프리셋 불러오기가 없다 — `ScheduleForm.tsx:43,55`). 재실행 prefill 동일. `simple_mode_with_stair_shows_readonly_card`: 계단 선택 뒤 단순 모드로 바꾸면 계단 요약 카드(「8계단 · 100–800 req/s · 총 8분 40초」 + 「상세에서 수정」)가 보이고 제출 payload는 그대로 stair. 미리보기 차트가 펼친 stages로 그려짐(점 개수).
- [ ] **Step 2: FAIL**, **Step 3: 구현**, **Step 4: PASS**: `cd ui && pnpm vitest run src/components/run && pnpm lint && pnpm build`.
- [ ] **Step 5: Commit** — `feat(ui): 실행 창 「계단」 탭 — 목록 도우미·입력·요약·프리셋/스케줄/재실행`.

### Task 11: 리포트 「계단 결과」 — 머리말 + 표

**Files:**
- Create: `ui/src/components/report/stair/StairResultSection.tsx`, `StairHeadline.tsx`, `StairTable.tsx`, `stairFormat.ts`
- Modify: `ui/src/components/report/ReportView.tsx`(`LoopRetryNotice` 다음·`VerdictPanel` 앞), `ui/src/i18n/ko.ts`(`ko.report.stair*`)
- Test: `ui/src/components/report/stair/__tests__/StairResultSection.test.tsx`

**Interfaces:**
- Consumes: Task 8 `StairReport`.
- Produces: `<StairResultSection stair={report.stair} />`(PageSection 하나, 안에 머리말·[곡선 자리]·표·[띠 자리]), `formatMs(us: number): string`(1 ms 미만 소수 둘째, 이상 정수), `stateLabel(s: StairState)`, `headlineText(stair: StairReport): string[]`(머리말 첫 줄 + 둘째 줄들, Task 13 인쇄가 재사용 — `stairFormat.ts`). M·N은 `stair.max_in_flight`·`stair.dropped_total`, 힌트는 `stair.headline.first_fail_hint`.
- 문구(spec §5.3 머리말·§5.7·결정 목업 ②):
  - 머리말: saturated "포화 계단 {t} req/s · 마지막 정상 {m} req/s" / last 없음 "포화 계단 {t} req/s · 정상 계단 없음 — 첫 계단부터 실패" (+ `later_ok_after_first_fail` 힌트 "첫 계단만 일시적으로 튀었을 수 있습니다 — 앞부분 버림을 늘려 다시 실행해 보세요") / unconfirmed "포화 의심 {t} req/s — 확인할 다음 계단 전에 run이 끝남 · 마지막 정상 {m} req/s" / all_ok "{t} req/s까지 정상 (포화 못 찾음 — 더 높은 목표로 다시)" / ok_then_unmeasured "{t} req/s까지 정상 · 이후 계단은 측정 안 됨" / no_data "판정할 수 없음 — 측정이 끝난 계단이 없습니다".
  - 둘째 줄: "지연 상승 시작 ≈ {k} req/s (p99가 아래 계단의 {x}배 — 판정 기준 안이지만 참고)", "튄 계단 {n}개({목록}) 넘김", dropped_explained "부하기가 못 보낸 요청 {N}개는 모두 지연·오류로 무너진 계단에서 발생 — 시스템 포화로 판정에 반영됨", slot_limited(경고색) "계단 {목록}은 지연·오류는 정상인데 요청을 다 못 보냄 — 동시 실행 한도(max_in_flight = {M})가 부족할 수 있어 시스템 한계로 단정할 수 없음. 한도를 늘려 다시 실행하세요".
  - notes: t0 "ⓘ 부하기 일부가 예전 버전이라 계단 시작 시각을 첫 데이터로 추정했습니다(±1초). 측정 구간 경계가 조금 어긋날 수 있습니다." / open_loop_unknown "ⓘ 예전 버전 부하기라 계단별 달성·dropped를 모릅니다 — 판정은 지연·오류로만 했습니다."
  - 표 머리글: # · 목표(반복/초) · 달성(반복/초) · 처리량(요청/초) · p50 · p95 · p99 · 오류율 · dropped · 측정 구간 · 판정. 상태 pill: 정상(초록)·튄 계단(주황)·포화(빨강)·확인 못 한 실패(주황 테두리)·포화 이후(회색)·측정 안 됨(회색). 사유 요약: achieved "달성 {p}%", dropped "dropped {n}", errors "오류 {p}%", p99_relative "p99 {x}×", p99_cap "p99 상한 초과", slot_limited 추가 "슬롯 부족 의심". null → "—".
  - 표 아래: ⚠ "계단 {i}: 측정 구간 첫 10초 p99가 나머지의 {r}배 — 앞부분 버림({d}초)이 짧았을 수 있습니다."(해당 계단마다), 단위 줄 "단위: 반복/초·요청/초·ms. 측정 구간은 경계의 부분 초를 뺀 실제 구간입니다. 운영 환경 실사용자 트래픽은 handicap이 모릅니다."
- [ ] **Step 1: 테스트**: Task 8 fixture로 렌더 → 머리말 문장 6종(각 headline kind fixture), 상태 pill 6종, null "—", ⚠ 줄 개수, 섹션 위치(`ValidityBanner` 뒤·`VerdictPanel` 앞 — DOM 순서 비교), stair 없는 report면 섹션 없음.
- [ ] **Step 2: FAIL**, **Step 3: 구현**, **Step 4: PASS**: `cd ui && pnpm vitest run src/components/report`.
- [ ] **Step 5: Commit** — `feat(ui): 리포트 계단 결과 — 판정 머리말·계단 표`.

## a2 — 차트·⚠

### Task 12: 계단 곡선 + 1초 계단 띠 차트

**Files:**
- Create: `ui/src/components/report/stair/StairCurveChart.tsx`, `StairBandChart.tsx`
- Modify: `StairResultSection.tsx`(자리 채움)
- Test: `ui/src/components/report/stair/__tests__/StairCharts.test.tsx`(jsdom은 명시 `width`/`height` prop — `components/report/CLAUDE.md`)

**Interfaces:**
- Consumes: `StairReport.steps`·`seconds`·`bands`·`target_line`.
- Produces: `<StairCurveChart steps width? height? />`, `<StairBandChart seconds bands targetLine steps width? height? />`.
- 그림(목업 ②·결정 목업 ③ B): 곡선 = 가로 범주(목표), 세로 로그(ms), p99 실선·p50 점선, 점 색 = 상태, knee 고리, 포화 지점부터 옅은 빨강 배경, 점 라벨(p99 + 「튐」/「포화」/「↑시작」), 아래 달성률 줄(95% 기준 색). 띠 = `bands` 배경(ramp·discard 회색, measure = 계단 상태색 옅게), 목표 계단선(회색 점선), 실제 시작(launched/초 실선), p99(오른쪽 로그축). 범례 포함. 색은 기존 토큰·tailwind 팔레트(초록 emerald·주황 amber·빨강 red·회색 slate).
- [ ] **Step 1: 테스트**: 점 개수 = 측정된 계단 수, 상태별 fill 클래스/색, knee 고리 1개, 띠 rect 수 = bands 수, 목표선 path 존재, 범례 문구.
- [ ] **Step 2: FAIL**, **Step 3: 구현**, **Step 4: PASS**: `cd ui && pnpm vitest run src/components/report/stair`.
- [ ] **Step 5: Commit** — `feat(ui): 계단 곡선·1초 계단 띠 차트`.

## a3 — 공유

### Task 13: 인쇄 + 다운로드 메뉴

**Files:**
- Modify: `ui/src/print/buildPrintDoc.ts`(`standardBlocks` `:192–215`·`summaryBlocks` `:226–257`·`PrintDoc` 타입), `ui/src/print/PrintDocument.tsx`(`AtomicContent` `:66–102`), `ui/src/components/report/ReportView.tsx`(다운로드 항목 목록 `:133–165` — `api.reportInsightsCsvUrl` 옆; `DownloadMenu.tsx`는 범용 컴포넌트라 손대지 않음), `ui/src/i18n/ko.ts`
- Create: `ui/src/print/stairTable.ts`(행 모델), `ui/src/print/components/StairPrintTable.tsx`
- Test: `ui/src/print/__tests__/stairPrint.test.ts(x)`, `ui/src/components/report/__tests__/`의 ReportView 테스트 파일(기존)에 케이스

**Interfaces:**
- Consumes: Task 8, Task 11 `headlineText(stair): string[]`(`stairFormat.ts`) 재사용.
- standard: `kpis` 다음에 `stair:headline` 문장 블록 + 기존 `kind: "table"` 블록 패턴(`:196·209` 참고)으로 계단 표(열은 화면 표와 같음, 측정 구간·사유 포함). summary: `stair:headline` 한 줄 + "계단 표는 표준 보고서에 있습니다".
- ReportView 다운로드 항목: stair가 있을 때만 「계단 표 CSV」(`reportStairsCsvUrl`).
- [ ] **Step 1: 테스트**: `stair_print_table_paginates_50_rows`(50행 → 표 블록이 여러 페이지로 나뉘고 행 누락 없음 — 기존 step 표 paginate 테스트 방식), summary에 표 없음·머리말 있음, 비계단 run의 `standardBlocks` id 목록 == **변경 전에 뽑아 테스트에 리터럴로 적은 목록**(같은 커밋 스냅샷 금지), ReportView 다운로드 항목 유무.
- [ ] **Step 2: FAIL**, **Step 3: 구현**, **Step 4: PASS**: `cd ui && pnpm vitest run src/print src/components/report && pnpm lint && pnpm build`.
- [ ] **Step 5: Commit** — `feat(ui): 계단 인쇄(표준 표·요약 머리말) + 계단 표 CSV 다운로드`.

## 검증·화면 모음

### Task 14: 라이브 검증 + 화면 종류별 띄워 두기 (orchestrator 수행)

코드 변경 없음(테스트 보강이 생기면 별도 커밋). `/live-verify` 스킬로 워크트리 자체 바이너리 스택(`cargo build --workspace` + `cd ui && pnpm build`, `./target/debug/controller --db /tmp/stair-live.db --ui-dir ui/dist --rest 127.0.0.1:<빈 포트> --grpc 127.0.0.1:<빈 포트>` — `lsof -iTCP:<포트> -sTCP:LISTEN` 출력이 비었는지 **읽고** 기동). 응답기는 동시 처리 한도가 있어 목표가 오르면 지연이 커지는 것(`live-verify` 응답기의 지연 설정 또는 작은 Python 서버 — 스크립트는 Write로 파일에).

- [ ] US1: 상세 모드 RunDialog 「계단」 → 도우미(목표 400·2×) → 유지 30·상승 3·버림 10으로 실행. 요약 줄 숫자 확인, 띠 차트 실제 시작선이 목표선과 겹침.
- [ ] US2: 리포트 머리말·곡선·표 상태를 응답 숫자로 손계산한 §5.3 결과와 대조.
- [ ] US3-a: 슬롯 넉넉 + 지연 상승 → drop 계단에만 dropped>0, 설명 줄, 신뢰도 배너 없음.
- [ ] US3-b: 지연 고정 + `max_in_flight` 작게 → 「슬롯 부족 의심」·경고색 줄·배너 유지.
- [ ] US4: 버림 0초 run → ⚠ 줄, 띠 회색 변화.
- [ ] US5: CSV·XLSX 다운로드 내용, 인쇄 standard·summary.
- [ ] 진입 화면: 시나리오 상세 RunDialog, 스케줄 폼, 프리셋 불러오기, 재실행 prefill.
- [ ] 극단값: 50계단(긴 목록·표·인쇄 페이지 나눔), 목표 1,000,000(입력·표 폭), p99 수십 초 — rect 교차로 겹침·잘림 없음 실측. 멀티워커 `worker_count=2` 1회.
- [ ] 화면 띄워 두기(사용자 요청 2026-11-18): 검증 스택을 **끄지 않고** 남긴다. 보이는 브라우저 탭으로 종류별 화면을 열어 둔다 — ① RunDialog 계단 탭(시나리오 상세) ② 스케줄 폼 계단 탭 ③ 리포트: 포화 run ④ 리포트: 끝까지 정상 run ⑤ 리포트: 슬롯 부족 run ⑥ 리포트: 버림 0 ⚠ run ⑦ 인쇄 standard ⑧ 인쇄 summary. 같은 화면의 전체 스크린샷을 `docs/superpowers/specs/2026-11-18-stage-saturation-live/`에 저장하고, 화면 종류별 한 줄 설명을 붙인 모음 페이지 `index.html`을 같은 폴더에 만든다(서버가 꺼져도 볼 수 있게). CSV·XLSX는 파일을 같은 폴더에.
- [ ] 결과 기록: 통과/실패 US 표 + 부재 중 판단 목록을 orchestrator 최종 메시지와 build-log 초안(마무리 때 반영)에.

---

## 실행 순서·재개

Task 1→14 순서. 밤사이 orchestrator 컨텍스트가 빠듯하면 **Task 11(a1)까지 깨끗이 끝내고 멈추는 것도 허용** — 그 경우 최종 리뷰·라이브는 다음 세션. 재개는 `git log --oneline master..HEAD`의 task 커밋 수로 판정. a1(1–11)이 끝나면 a2·a3 전이라도 라이브 US1–US3 사전 점검을 해도 된다(선택). 최종 리뷰(`handicap-reviewer`) + 보안 게이트(`finish-slice` §0 grep — 엔진 요청 실행 경로·와이어가 바뀌므로 `security-reviewer` 예상) 뒤 Task 14. **master 합류(`/finish-slice`)는 하지 않는다** — 사용자가 일어나서 요청한다(2026-11-18).
