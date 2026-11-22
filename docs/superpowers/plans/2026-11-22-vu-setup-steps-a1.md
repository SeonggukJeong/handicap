# 준비 스텝 슬라이스 A1 (엔진·와이어·저장·리포트) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 시나리오의 `setup: { steps }` 구간을 VU당 한 번 실행하고, 추출 변수·쿠키를 모든 반복이 이어받고, 준비 요청을 본 집계와 따로 세어 리포트에 `setup` 블록으로 보인다.

**Architecture:** 엔진에 구간 실행 모듈(`section.rs`)을 새로 두고 세 부하 진입점과 trace가 첫 반복 머리에서 부른다. 준비 통계는 본 `Aggregator`와 별도의 누적기에 모아 `MetricFlush` → proto `MetricBatch`의 새 반복 필드 둘 → 추가 전용 표 둘 → 리포트 `setup` 블록으로 흐른다. UI는 모델·리포트 구획·최소 에디터 변경만 한다(에디터 본 작업은 슬라이스 A2).

**Tech Stack:** Rust(엔진·워커·컨트롤러, tonic/prost, sqlx SQLite), TypeScript/React(Zod, yaml Document API, vitest).

REVIEW-GATE: APPROVED

**Spec:** `docs/superpowers/specs/2026-11-22-vu-setup-steps-design.md` — 이 plan의 `D1`…`D14`·`§n`은 그 문서의 번호다. 구현자는 자기 task가 가리키는 D 절을 읽는다.

**범위:** spec §3–§6과 §7-1. §7-2(A2)·§9(B)·§10은 이 plan 밖이다. A1을 머지한 뒤 A2가 끝날 때까지 릴리즈하지 않는다.

## Global Constraints

- 준비 스텝이 없는 시나리오는 YAML 출력·proto 배치 바이트·리포트 JSON·DB 행이 변경 전과 같다(spec §8). 「준비가 있는가」는 어디서나 `scenario.setup_steps().is_empty()`로 판단한다(`setup` 키 유무가 아니다).
- 본 스텝의 요청 경로(`execute_steps`의 http 가지)에 준비 여부 분기를 넣지 않는다(D7).
- 준비 통계·오류 문구·로그의 새 줄에 변수 값·URL·응답 조각을 싣지 않는다. 실을 수 있는 것은 고정 분류 글자, 스텝 id, 변수 **이름**이다(D6·§13).
- 구간 이름의 와이어 글자는 `setup` 하나다. 엔진·컨트롤러 안에서는 열거형 `Section`으로 다룬다(D8).
- 실패 종류 글자(D6): ADR-0050 전송 실패 kind(`ErrorKind::as_str()`) + `read_body` · `status_assert` · `extract` · `unknown_var` · `malformed_template` · `cast_failed`.
- 화면 문구는 `ui/src/i18n/ko.ts` 경유(ADR-0035). 문구는 spec D12의 글자를 그대로 쓴다.
- 놀라운 동작을 변호하는 주석을 쓰지 않는다. 주석은 불변식·순서 제약만(`docs/dev/working-rules.md` §7).
- 회귀 테스트는 되돌려 확인한다: 고친 코드를 일부러 옛 상태로 돌려 RED를 보고 원복한다. 각 task 보고에 그 결과를 적는다.
- 커밋은 task마다 하나, 그 task 끝에서 게이트가 통과하는 상태로. `git commit`은 파이프 없이, 끝난 뒤 `git log -1`로 확인. `--no-verify` 금지.
- `Scenario`에 필드를 더하면 엔진 `Scenario { … }` 리터럴이 컴파일되지 않는다. 지금 리터럴은 `crates/engine/tests/proptests.rs` 한 곳이다(Task 1에서 `grep -rn 'default_think_time: None' crates --include='*.rs'`로 다시 확인 — `Scenario {`로 찾으면 `EditDone::Scenario {` 같은 다른 것이 섞인다).
- 구조체에 필드를 더하는 task의 「통과 확인」은 `cargo build --workspace --tests`로 한다. `cargo build --workspace`는 `tests/*.rs`와 `#[cfg(test)]`의 리터럴을 컴파일하지 않아, 통과해 보이고 커밋 게이트(nextest)에서 깨진다.

## Review Focus

1. **준비 실패 뒤 본 스텝이 나가는 경로** — 세 진입점 어느 하나라도 실패한 VU(슬롯)가 본 요청을 보내면 안 된다. Task 4·5·6의 「실패 VU 본 요청 0건」 테스트.
2. **빈 토큰** — 로그인 실패를 `200 {"token": null}`로 답하는 서버. Task 3의 `null_or_empty_extract_fails_setup`.
3. **준비 통계만 든 flush가 버려짐** — think time이 긴 준비 중 시작 감시가 run을 죽인다. Task 4의 `section_only_flush_is_sent`, Task 8의 워커 가드 테스트.
4. **공유 카운터 두 번 전진** — 첫 반복을 다시 짤 때 행을 다시 고르면 `iter_sequential`·`unique` 순번이 어긋난다. Task 4의 `first_iteration_reuses_selected_rows`.
5. **open-loop 계수 왜곡** — 준비 실패 도착이 시작·완료·버림에 들어가면 계단 판정·「슬롯을 늘리라」 인사이트가 틀린다. Task 6의 `setup_failed_arrival_is_in_no_counter`.

---

## 파일 구조

| 파일 | 책임 |
|---|---|
| `crates/engine/src/scenario.rs` | `SetupSection`, `Scenario.setup`, `setup_steps()`, `all_steps()` |
| `crates/engine/src/executor.rs` | `ExtractMode::StrictNoDefaults`, `ErrorClass` |
| `crates/engine/src/section.rs` (새) | `Section`, 구간 통계 누적기, `run_section`, VU 준비 상태 |
| `crates/engine/src/error.rs` | `EngineError::SetupFailed`, `safe_cause` |
| `crates/engine/src/runner.rs` | 세 진입점 배선, `MetricFlush` 새 벡터 둘 |
| `crates/engine/src/trace.rs` | trace의 준비 실행과 새 필드 |
| `crates/proto/proto/coordinator.proto` | `SectionStepStat`, `SectionOutcome` |
| `crates/worker/src/lib.rs` | flush → proto 변환, 건너뛰기 가드 |
| `crates/controller/src/store/section.rs` (새) + 마이그레이션 0027 | 구간 통계 저장·조회 |
| `crates/controller/src/grpc/coordinator.rs` | 수신 |
| `crates/controller/src/report.rs`, `steady.rs`, `validity.rs`, `api/runs.rs` | `setup` 블록, 유지 구간 보정, 유효성 항목 |
| `crates/controller/src/api/*.rs`, `monitor/*.rs`, `crates/tui/src/names.rs` | 「모든 스텝」 훑기 |
| `ui/src/scenario/*`, `ui/src/api/schemas.ts`, `ui/src/components/report/*`, `ui/src/print/*`, `ui/src/i18n/ko.ts` | 모델·리포트 구획·최소 에디터 |

---

### Task 1: 시나리오 모델 — `setup: { steps }`

**Files:**
- Modify: `crates/engine/src/scenario.rs`, `crates/engine/src/lib.rs`(재수출), `crates/engine/tests/proptests.rs`(리터럴)
- Test: `crates/engine/tests/setup_model.rs` (새)

**Interfaces:**
- Produces:
  ```rust
  #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]   // Scenario가 Eq를 파생한다
  #[serde(deny_unknown_fields)]
  pub struct SetupSection {
      #[serde(deserialize_with = "de_http_only_steps")]
      pub steps: Vec<Step>,          // 기본값 없음 — `setup: {}`는 거절
  }
  // Scenario 새 필드 (notes 다음, steps 앞):
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub setup: Option<SetupSection>,

  impl Scenario {
      /// 준비 스텝. `setup`이 없거나 `steps`가 비면 빈 조각.
      pub fn setup_steps(&self) -> &[Step];
      /// setup → steps 순서.
      pub fn all_steps(&self) -> impl Iterator<Item = &Step>;
  }
  ```
- `de_http_only_steps`: `Vec<Step>`으로 읽은 뒤 `Step::Http`가 아닌 것이 있으면 `de::Error::custom("setup.steps: only http steps are allowed (step <id>)")`.

- [ ] **Step 1: 실패하는 테스트를 쓴다** — `crates/engine/tests/setup_model.rs`:
  - `no_setup_yaml_is_byte_identical`: 기존 fixture(`crates/engine/tests/fixtures/`의 시나리오 하나)를 `from_yaml` → `to_yaml`한 글자가, 같은 fixture를 변경 전 코드로 낸 글자와 같다. 변경 전 글자는 이 step에서 **지금 코드로 한 번 출력해** 테스트 안 상수로 박는다(출력에 `setup`이라는 글자가 없어야 한다는 단언도 함께).
  - `setup_round_trips`: `setup: { steps: [http 1개] }`가 든 YAML → `from_yaml` → `to_yaml` → `from_yaml` 결과가 처음 파싱과 `==`.
  - `setup_null_is_none`: `setup:`(값 없음) → `setup.is_none()`, `setup_steps().is_empty()`.
  - `setup_empty_object_rejected`: `setup: {}` → `Err`.
  - `setup_unknown_key_rejected`: `setup: { steps: [], every: 5m }` → `Err`.
  - `setup_non_http_rejected`: `setup.steps`에 `type: loop` → `Err`, 메시지에 `only http steps`.
  - `all_steps_order`: setup 1개 + steps 2개 → `all_steps()`의 id 순서가 setup, step1, step2.
  - `empty_steps_setup_counts_as_none`: `setup: { steps: [] }` → `setup_steps().is_empty()`이고 `to_yaml`은 그 키를 그대로 낸다(왕복 보존).
- [ ] **Step 2: 실패 확인** — `cargo test -p handicap-engine --test setup_model` → 컴파일 오류(`setup` 필드 없음).
- [ ] **Step 3: 구현** — 위 Interfaces대로. `Scenario { … }` 리터럴에 `setup: None`을 더한다.
- [ ] **Step 4: 통과 확인** — `cargo test -p handicap-engine --test setup_model` PASS, `cargo build --workspace --tests` 0.
- [ ] **Step 5: 되돌려 확인** — `skip_serializing_if`를 잠시 지우고 `no_setup_yaml_is_byte_identical`이 RED인지 본 뒤 원복.
- [ ] **Step 6: 커밋** — `feat(engine): 시나리오에 setup 구간 모델 (http만, 객체 꼴)`

---

### Task 2: 추출 방식 「기본값 없는 엄격」과 오류 분류

**Files:**
- Modify: `crates/engine/src/executor.rs`
- Test: `crates/engine/tests/executor_extract.rs` (추가)

**Interfaces:**
- Produces:
  ```rust
  pub enum ExtractMode { Strict, Lenient, StrictNoDefaults }   // 새 변형
  #[derive(Debug, Clone, Copy, PartialEq, Eq)]
  pub enum ErrorClass { Send, ReadBody, StatusAssert, Extract }
  // ExecOutcome 새 필드:
  pub error_class: Option<ErrorClass>,   // error가 Some이면 반드시 Some
  ```
- `StrictNoDefaults`: `execute_step_with`와 `execute_step_traced_with` 둘 다에서 `has_default` 갈래를 타지 않고 항상 `evaluate_extracts`(기본값을 무시하는 엄격 평가)를 쓴다. `Strict`·`Lenient`의 동작은 그대로다.
- `error_class`는 `execute_step_with`가 `ExecOutcome.error`를 채우는 모든 자리에서 함께 채운다(`grep -n 'error = Some\|error: Some' crates/engine/src/executor.rs`로 자리 확인). trace 쪽 결과 구조체에는 두지 않는다(trace의 준비 실패 판정은 오류 유무·미해결 변수·빈 추출로 한다 — Task 7).

- [ ] **Step 1: 실패하는 테스트** — `executor_extract.rs`에:
  - `strict_no_defaults_ignores_default`: 추출 항목에 `default: "x"`가 있고 응답에 그 경로가 없을 때, `StrictNoDefaults` → `error.is_some()`, `error_class == Some(ErrorClass::Extract)`, `extracted`에 그 이름 없음. 같은 입력을 `Strict`로 → 오류 없이 `extracted["var"] == "x"`(지금 동작 유지).
  - `error_class_matches_error`: 전송 실패(닫힌 포트) → `Send`, 상태 검증 불일치 → `StatusAssert`, 추출 실패 → `Extract`. 성공 → `None`.
- [ ] **Step 2: 실패 확인** — 컴파일 오류.
- [ ] **Step 3: 구현.**
- [ ] **Step 4: 통과 확인** — `cargo test -p handicap-engine` 전체 PASS(기존 테스트의 `ExecOutcome` 리터럴 포함).
- [ ] **Step 5: 커밋** — `feat(engine): 기본값 없는 엄격 추출 방식과 오류 분류 필드`

---

### Task 3: 구간 실행 모듈 `section.rs`

**Files:**
- Create: `crates/engine/src/section.rs`
- Modify: `crates/engine/src/lib.rs`, `crates/engine/src/error.rs`
- Test: `crates/engine/src/section.rs`의 `#[cfg(test)]`(누적기 단위 + wiremock으로 `run_section`). `run_section`과 `ReqGen`이 `pub(crate)`라 `tests/` 밑의 바깥 크레이트에서는 부를 수 없다 — `executor.rs`의 인라인 wiremock 테스트와 같은 꼴로 둔다.

**Interfaces:**
- Consumes: Task 1 `setup_steps()`, Task 2 `ExtractMode::StrictNoDefaults`·`ErrorClass`.
- Produces:
  ```rust
  #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
  pub enum Section { Setup }
  impl Section {
      pub fn as_str(self) -> &'static str;            // "setup"
      pub fn from_wire(s: &str) -> Option<Section>;
  }

  /// 한 flush 구간의 스텝 통계 델타.
  #[derive(Debug, Clone)]
  pub struct SectionStepStat {
      pub section: Section,
      pub step_id: String,
      pub count: u64,
      pub error_count: u64,
      pub status_counts: HashMap<u16, u64>,           // 0 = 전송 실패 (StepWindow와 같은 규칙)
      pub histogram: Histogram<u64>,                  // 본 창과 같은 bound: new_with_bounds(1, 60_000_000, 3), 단위 µs
      pub failure_kinds: BTreeMap<&'static str, u64>,
  }
  impl SectionStepStat {
      /// 본 창(`StepWindow::serialize_histogram`)과 같은 직렬화.
      pub fn serialize_histogram(&self) -> Result<Vec<u8>>;
  }
  #[derive(Debug, Clone, PartialEq, Eq)]
  pub struct SectionOutcome {
      pub section: Section,
      pub ok: u64,
      pub failed: u64,
      pub interrupted: u64,
      pub last_done_ms: Option<i64>,                  // 이 구간에서 마지막으로 성공한 실행의 완료 epoch ms
  }

  /// 본 Aggregator와 별도의 누적기. 준비가 있는 run만 만든다.
  #[derive(Default)]
  pub struct SectionStats { /* 비공개 */ }
  impl SectionStats {
      pub fn record_request(&mut self, section: Section, step_id: &str, status: u16, latency: Duration, is_error: bool);
      pub fn record_failure_kind(&mut self, section: Section, step_id: &str, kind: &'static str);
      pub fn record_ok(&mut self, section: Section, done_at_ms: i64);
      pub fn record_failed(&mut self, section: Section);
      pub fn record_interrupted(&mut self, section: Section);
      /// 쌓인 델타를 꺼내고 비운다. 세 수가 0이고 last_done이 없으면 outcome을 내지 않는다.
      pub fn drain(&mut self) -> (Vec<SectionStepStat>, Vec<SectionOutcome>);
  }
  pub type SharedSectionStats = Arc<std::sync::Mutex<SectionStats>>;

  /// 구간 한 번 실행의 결과.
  pub enum SectionRun {
      /// 끝까지 성공. 값 = 이 구간의 스텝들이 실제로 추출한 이름과 값.
      Done(BTreeMap<String, String>),
      Failed(EngineError),            // 항상 EngineError::SetupFailed
      Deadline,
      Aborted,
  }

  /// http 스텝 목록을 순서대로 한 번 실행한다. 첫 실패에서 멈춘다.
  /// `vars`는 실행 중 추출을 받아 뒤 스텝이 읽을 수 있게 갱신된다(호출자가 사본을 넘긴다).
  /// 요청 통계와 결과 수 ok/failed, deadline에 따른 interrupted는 이 함수가 `stats`에 기록한다.
  /// 취소(`Aborted`)는 기록하지 않는다 — run이 끝나는 취소인지 호출자만 안다(VU 곡선의 은퇴 취소는
  /// 세지 않는다). 호출자가 run이 끝나는 취소일 때 `record_interrupted`를 부른다.
  /// `Err`는 준비 실패로 분류하지 않는 엔진 오류(아래 규칙의 세 변형 밖)다.
  #[allow(clippy::too_many_arguments)]
  pub(crate) async fn run_section(
      section: Section,
      steps: &[Step],
      client: &VuClient,
      vars: &mut BTreeMap<String, String>,
      env: &BTreeMap<String, String>,
      vu_id: u32,
      iter_id: u32,
      deadline: Instant,
      cancel: &CancellationToken,
      rng: &mut StdRng,
      default_think: Option<ThinkTime>,
      req: &mut Option<ReqGen>,
      stats: &SharedSectionStats,
  ) -> Result<SectionRun>;
  ```
  ```rust
  // error.rs
  // 글자는 spec D6 그대로 — run 메시지로 저장돼 화면에 나온다.
  #[error("준비 스텝 {step_id} 실패: {kind}{}", .var.as_ref().map(|v| format!(" ({v})")).unwrap_or_default())]
  SetupFailed { step_id: String, kind: &'static str, var: Option<String> },
  ```
  `safe_cause`는 `SetupFailed`를 `Some(e.to_string())`으로 통과시킨다(값이 없다).
- `run_section` 규칙(D6·D7):
  - 스텝마다 머리에서 deadline → `Deadline`(`record_interrupted`), 취소 → `Aborted`(기록 없음).
  - `req`가 있으면 스텝마다 `refresh(&http.id, vars)`.
  - `execute_step_with(client, http, &ctx, ExtractMode::StrictNoDefaults)`. `Ok(outcome)`이면 `record_request`.
    - `outcome.error`가 있으면 실패. 종류 = `error_kind`가 있으면 `error_kind.as_str()`, 아니면 `error_class`에 따라 `read_body`/`status_assert`/`extract`.
    - 오류가 없어도 `outcome.extracted`의 값 중 빈 문자열이 있으면 실패, 종류 `extract`.
  - `Err(e)`: `UnknownVar` → 실패, 종류 `unknown_var`(var = 그 이름). `MalformedTemplate` → `malformed_template`. `CastFailed` → `cast_failed`(var = 그 이름). 그 밖의 변형은 준비 실패로 접지 않고 `Err(e)`로 전파한다(호출자가 지금의 엔진 오류 경로로 처리). `match`는 `_` 가지 없이 변형을 나열한다.
  - 실패 시 `record_failure_kind` + `record_failed`, 반환 `Failed(SetupFailed{…})`. 뒤 스텝은 실행하지 않는다.
  - 성공한 스텝의 `extracted`는 `vars`에 넣고, `req`에 `mark_written`, 반환용 맵에도 넣는다. 스텝별 think time은 본 스텝과 같은 규칙(`http.think_time` 없으면 `default_think`)으로 `pace`한다. `pace`가 취소를 알리면 `Aborted`, deadline을 알리면 `Deadline`(`record_interrupted`) — 마지막 스텝의 think time 중이어도 같다.
  - 호출자가 받는 `Aborted`: Task 4(closed)와 Task 6(open)은 run이 끝나는 취소뿐이므로 `record_interrupted`를 부른다. Task 5(곡선)는 run 전체 취소일 때만 부른다.
  - 전부 끝나면 `record_ok(section, 지금 epoch ms)`.
  - 비움 표는 쓰지 않는다.

- [ ] **Step 1: 실패하는 테스트**
  - 누적기 단위: `drain_is_delta`(두 번 기록·drain 뒤 다시 drain하면 비어 있음), `no_outcome_when_all_zero`, `last_done_is_max`.
  - `run_section` (인라인, wiremock):
    - `runs_steps_in_order_and_returns_extracts`: 로그인(토큰 발급) → 둘째 스텝이 첫째 추출을 헤더로 읽는다. `Done(map)`에 토큰, 통계에 스텝 둘 각 1건·`ok == 1`.
    - `stops_at_first_failure`: 첫 스텝 401 + `assert status 200` → `Failed`, 종류 `status_assert`, 둘째 스텝 요청 0건(서버가 센 수), `failed == 1`.
    - `null_or_empty_extract_fails_setup`: `200 {"token": null}` → `Failed`, 종류 `extract`. `{"token": ""}`도 같다.
    - `default_is_not_used`: 추출에 `default: "guest"`, 응답에 토큰 없음 → `Failed`, 종류 `extract`.
    - `unknown_var_names_the_var`: 주소에 `{{nope}}` → `Failed(SetupFailed{kind: "unknown_var", var: Some("nope")})`.
    - `transport_failure_uses_error_kind`: 닫힌 포트 → 종류가 `ErrorKind::ConnectRefused.as_str()`.
    - `deadline_before_step_is_interrupted`: 이미 지난 deadline → `Deadline`, `interrupted == 1`, 요청 0건.
    - `cancel_is_not_counted`: 이미 취소된 토큰 → `Aborted`, `interrupted == 0`.
    - `safe_cause_has_no_value`: `safe_cause(&SetupFailed{…})`의 글자가 스텝 id·종류·변수 이름만 담는다.
- [ ] **Step 2: 실패 확인** — 컴파일 오류.
- [ ] **Step 3: 구현.** `error.rs`의 `safe_cause`는 `_` 가지가 없어 새 변형을 넣지 않으면 컴파일되지 않는다 — 허용 쪽에 넣는다.
- [ ] **Step 4: 통과 확인** — `cargo test -p handicap-engine section::` PASS, `cargo build --workspace --tests` 0.
- [ ] **Step 5: 되돌려 확인** — 빈 값 검사를 잠시 빼고 `null_or_empty_extract_fails_setup` RED 확인 뒤 원복.
- [ ] **Step 6: 커밋** — `feat(engine): 구간 실행 모듈 — 준비 스텝 한 번 실행과 전용 통계`

---

### Task 4: closed-loop(`run_scenario`/`run_vu`) 배선 + `MetricFlush`

**Files:**
- Modify: `crates/engine/src/runner.rs`, `crates/engine/src/section.rs`, `crates/engine/src/reqgen.rs`, `crates/worker/src/lib.rs`(리터럴만)
- Test: `crates/engine/tests/setup_steps.rs` (새)

**Interfaces:**
- Consumes: Task 3 전부.
- Produces:
  ```rust
  // runner.rs — MetricFlush 새 필드 (모든 리터럴에 추가)
  pub section_step_stats: Vec<SectionStepStat>,
  pub section_outcomes: Vec<SectionOutcome>,

  // section.rs — VU(슬롯)의 준비 상태. 세 진입점이 같이 쓴다.
  #[derive(Default)]
  pub(crate) struct VuSetup {
      pub done: bool,
      pub vars: BTreeMap<String, String>,   // 준비가 추출한 이름과 값
  }
  impl VuSetup {
      /// 반복 머리 2단계(D5): 준비 추출을 덮고 req에 「받은 값」 표시. done이 아니거나 비면 아무것도 안 한다.
      pub(crate) fn overlay(&self, iter_vars: &mut BTreeMap<String, String>, req: &mut Option<ReqGen>);
  }
  ```
- `MetricFlush` 리터럴은 `grep -n 'MetricFlush {' crates/engine/src/runner.rs crates/worker/src/lib.rs`로 확인한다(지금 runner 6곳 + worker 테스트 헬퍼 1곳). 이 task는 closed-loop 2곳에서 실제로 drain하고 나머지 4곳은 `vec![]`를 넣는다(Task 5·6이 채운다).
- 송신 가드: closed-loop 주기·최종 flush의 「보낼 것이 있는가」 조건에 `|| !section_step_stats.is_empty() || !section_outcomes.is_empty()`를 더한다.
- `RequestGenPlan::build`의 스텝 수집을 `scenario.all_steps()`로 넓힌다(D2·D4).
- `run_vu` 변경(D3·D4·D5):
  1. 준비 통계 누적기는 `run_scenario`가 `scenario.setup_steps()`가 비어 있지 않을 때만 만들어(`Option<SharedSectionStats>`) VU와 flusher에 넘긴다. flusher는 주기·최종 flush마다 `drain()`.
  2. 반복 머리에서 `seed_iter_vars` 직후 `vu_setup.overlay(&mut iter_vars, &mut req)` → 그 뒤 지금의 데이터셋 주입.
  3. `!vu_setup.done`이고 준비가 있으면, 데이터셋 주입이 끝난 직후(`unique` 소진으로 끝나는 갈래 뒤):
     - 주입 전 시드 맵 S와 이번에 넣은 데이터셋 항목 R(이름·값 목록)을 보관해 둔다.
     - `iter_vars`의 **사본**으로 `run_section(Section::Setup, …)`.
     - `Done(extracted)`: `vu_setup = { done: true, vars: extracted }`. `iter_vars`를 S → `overlay` → R 순서로 다시 짠다. `seed_iter_vars`와 `select_index`는 다시 부르지 않는다.
     - `Failed(e)`: `return Err(e)`(지금의 VU 실패 경로 — `failed`++, 첫 사유 `safe_cause`).
     - `Deadline`: `return Ok(())`. `Aborted`: `record_interrupted` 뒤 `return Err(EngineError::Aborted)`. `Err(e)`: `return Err(e)`.
  4. 준비가 없으면 위 2·3은 빈 검사 한 번뿐이고 지금 경로와 같다.

- [ ] **Step 1: 실패하는 테스트** — `setup_steps.rs`. `tests/think_time.rs`의 `Mode::{Closed,Curve,Open}` 헬퍼 꼴을 따라 `enum Mode`와 진입점별 실행 헬퍼를 둔다(이 task는 `Closed`만 구현하고 `Curve`·`Open` 가지는 Task 5·6이 채운다 — 이 task에서는 그 두 가지를 쓰는 테스트를 만들지 않는다). 응답기는 wiremock: `POST /login`은 호출마다 다른 토큰을 주고 호출 수를 센다. `GET /orders`는 `Authorization` 헤더가 발급된 토큰일 때만 200.
  - `closed_setup_runs_once_per_vu`: VU 3·1초 run → 로그인 요청 수 == 3, `/orders` 응답 전부 200, 본 창(`flush.windows`)에 로그인 스텝 id가 없다.
  - `closed_main_steps_get_setup_token_every_iteration`: VU 1 → `/orders` 요청이 2건 이상이고 전부 같은 토큰.
  - `closed_cookie_carries_over`: 로그인이 `Set-Cookie`를 주고 `/orders`가 쿠키를 검사 → 전부 200.
  - `closed_failed_vu_sends_no_main_requests`: VU 2 중 하나만 틀린 계정(`per_vu` 데이터셋 2행) → 틀린 계정의 `/orders` 0건, 로그인은 계정마다 1건, run은 `Ok`.
  - `closed_all_failed_is_all_vus_failed`: 전부 틀림 → `Err(AllVusFailed)`이고 `cause`에 `준비 스텝`·`status_assert`.
  - `first_iteration_reuses_selected_rows`: `iter_sequential` 데이터셋 4행·VU 1·`/orders?row={{n}}` → 서버가 받은 `row` 값이 1,2,3,…로 빠짐없이 이어진다(준비 때문에 한 행을 건너뛰지 않는다). 로그인 본문에 실린 값은 1.
  - `dataset_wins_over_setup_extract_on_same_name`: 준비가 `n`을 추출하고 데이터셋도 열 `n`을 가질 때, 첫 반복과 둘째 반복의 본 스텝이 모두 데이터셋 값을 쓴다.
  - `section_stats_flushed`: 모은 flush의 `section_step_stats` 합이 로그인 3건, `section_outcomes` 합이 `ok == 3`, `last_done_ms`가 `Some`.
  - `section_only_flush_is_sent`: 준비 스텝 think time 1.5초 + 본 스텝 없음에 가까운 run → 본 창이 비어 있는 flush가 준비 통계를 싣고 채널에 도착한다.
  - `no_setup_flush_has_no_section_stats`: 준비 없는 시나리오 → 모든 flush의 두 벡터가 비어 있다.
- [ ] **Step 2: 실패 확인** — 컴파일 오류.
- [ ] **Step 3: 구현.**
- [ ] **Step 4: 통과 확인** — `cargo test -p handicap-engine --test setup_steps` PASS, `cargo test -p handicap-engine` 전체 PASS, `cargo build --workspace --tests` 0(워커의 `empty_flush()` 리터럴 포함).
- [ ] **Step 5: 되돌려 확인** — (a) 첫 반복을 다시 짤 때 `select_index`를 다시 부르게 바꿔 `first_iteration_reuses_selected_rows` RED, (b) 송신 가드 항을 빼고 `section_only_flush_is_sent` RED. 각각 원복.
- [ ] **Step 6: 커밋** — `feat(engine): closed-loop에서 준비 스텝을 VU당 한 번 실행하고 따로 센다`

---

### Task 5: VU 곡선(`run_scenario_vu_curve`/`run_vu_curve`) 배선

**Files:**
- Modify: `crates/engine/src/runner.rs`
- Test: `crates/engine/tests/setup_steps.rs` (추가)

**Interfaces:**
- Consumes: Task 4의 `VuSetup`, `MetricFlush` 필드.
- `run_vu_curve` 변경: Task 4의 2·3을 같은 규칙으로 넣는다. 차이(D3):
  - `vu_setup`은 park 루프 **밖**에 둔다(재개 때 다시 하지 않는다).
  - 준비는 슬롯을 등록한 뒤 실행한다. `run_section`에 넘기는 취소 토큰은 그 활성화의 토큰이다.
  - `Aborted`가 run 전체 취소가 아니라 은퇴 취소이면(지금 코드가 둘을 가르는 방식 그대로) 준비는 `done == false`로 남고 park으로 간다. `record_interrupted`를 부르지 않는다. run 전체 취소이면 부른다.
  - `Failed(e)`: 지금의 영구 종료 경로(`clear_slot` 뒤 `Err`).
- 곡선의 주기·최종 flush 두 곳에서 `drain()`하고 송신 가드 두 곳에 항을 더한다.

- [ ] **Step 1: 실패하는 테스트** — `Mode::Curve` 헬퍼를 구현하고:
  - `curve_setup_runs_once_per_activated_vu`: `vu_stages`로 0→3→1→3 → 로그인 요청 수 == 3(재활성화에서 다시 로그인하지 않는다).
  - `curve_failed_vu_sends_no_main_requests`.
  - `curve_all_failed_is_all_vus_failed`.
  - `curve_main_window_has_no_setup_step_id`.
  - 시간 값은 넉넉히 잡는다(실제 시계로 돈다): 계단 길이 1초 이상, 준비 think time 1.5초, 단언은 「정확히 몇 초」가 아니라 요청 수.
  - `curve_retire_during_setup_redoes_setup`: 준비 스텝 think time을 길게 두고 그 사이 즉시 ramp-down → 다시 활성화되면 로그인이 한 번 더 나가고, `section_outcomes`의 `interrupted` 합은 0.
  - `curve_section_stats_flushed`.
- [ ] **Step 2: 실패 확인.**
- [ ] **Step 3: 구현.**
- [ ] **Step 4: 통과 확인** — `cargo test -p handicap-engine --test setup_steps --test vu_curve` + `cargo test -p handicap-engine section::` PASS.
- [ ] **Step 5: 커밋** — `feat(engine): VU 곡선에서 준비 스텝 — 재활성화 때 다시 하지 않음`

---

### Task 6: open-loop(`run_scenario_open_loop`/`run_arrival`) 배선

**Files:**
- Modify: `crates/engine/src/runner.rs`
- Test: `crates/engine/tests/setup_steps.rs` (추가)

**Interfaces:**
- Consumes: Task 4의 `VuSetup`.
- 슬롯 상태(D3·D6): 슬롯 풀과 같은 길이의 `Vec<Arc<SlotState>>`.
  ```rust
  struct SlotState {
      ready: AtomicBool,                         // 준비 완료
      setup: std::sync::Mutex<VuSetup>,          // 대기 없음 — 슬롯은 한 번에 한 도착만 쓴다
  }
  ```
- 스케줄러 변경:
  - 슬롯을 받았을 때 준비가 없거나 `ready`이면 지금처럼 그 자리에서 `Launched`를 기록한다. 준비가 있고 `ready`가 아니면 기록하지 않고 태스크를 띄운다.
  - `SlotGuard`에 `retire: Arc<AtomicBool>`(또는 같은 뜻의 필드)을 두어, 세워져 있으면 `Drop`이 슬롯을 큐로 돌려주지 않는다.
  - 빠진 슬롯 수 `Arc<AtomicUsize>`와 첫 사유 `Arc<OnceLock<String>>`. 루프 머리의 `exhausted` 검사 옆에서 `빠진 수 == max_in_flight`이면 루프를 끝내고, 남은 태스크를 거둔 뒤 최종 flush를 보내고 `Err(EngineError::AllVusFailed { failed: max_in_flight, total: max_in_flight, cause })`를 돌려준다.
- 태스크(`run_arrival`) 변경: 데이터셋 주입 직후, 슬롯이 준비 안 됐으면 Task 4의 3과 같은 규칙으로 `run_section`.
  - `Done`: 슬롯 상태에 저장·`ready = true` → **그때** `Launched` 기록 → 본 스텝 → `Completed`.
  - `Failed(e)`: `retire` 세움, 빠진 수 +1, 첫 사유 저장(`safe_cause`), `warn!` 한 줄(슬롯 번호·스텝 id·종류만). `Launched`·`Completed`·`dropped` 어디에도 기록하지 않는다.
  - `Deadline`: 계수 기록 없음(`run_section`이 `interrupted`를 이미 셌다). `Aborted`: `record_interrupted`, 계수 기록 없음. 둘 다 슬롯은 돌려준다.
  - `unique` 소진으로 끝나는 갈래: 슬롯이 준비 안 됐으면 끝내기 전에 `Launched`를 기록한다(D4 — 지금 그 도착이 「시작」으로 세어지는 것과 같게).
  - 준비된 슬롯의 도착은 반복 머리에서 `overlay`만 한다.
- open-loop의 주기·최종 flush에서 `drain()`. 주기 flush의 송신 가드에 항을 더한다(최종 flush는 지금도 무조건 보낸다).

- [ ] **Step 1: 실패하는 테스트** — `Mode::Open` 헬퍼를 구현하고:
  - `open_setup_runs_once_per_used_slot`: `max_in_flight` 4·충분한 도착 → 로그인 요청 수 == 4.
  - `open_main_steps_get_slot_token`.
  - `setup_failed_arrival_is_in_no_counter`: 슬롯 4 중 1개가 틀린 계정, 도착률은 슬롯이 남게 낮춘다 → run이 끝난 뒤 `open_loop_seconds` 합에서 `launched == completed`, `section_outcomes`의 `failed` 합 == 1, 틀린 계정의 로그인 요청은 정확히 1건(재시도 없음), `launched`는 서버가 센 `/orders` 요청 수와 같다(본 스텝 1개 시나리오). 준비 실패 도착이 `launched`에 들어가면 `launched`가 `/orders` 수보다 1 크다. run 길이는 도착 간격의 정수배 + 반 간격으로 잡아 마지막 도착이 deadline에 걸리지 않게 한다.
  - `open_cookie_carries_over`, `open_main_window_has_no_setup_step_id`.
  - `open_retired_slot_is_not_reused`: 위 run에서 틀린 계정의 `/orders` 0건.
  - `open_all_slots_failed_fails_run`: 전부 틀림 → `Err(AllVusFailed)`, 로그인 요청 수 == `max_in_flight`, run이 deadline 전에 끝난다.
  - `open_no_setup_counters_unchanged`: 준비 없는 시나리오로 `tests/open_loop_seconds.rs`의 기존 단언이 그대로 통과(새 테스트 불필요 — 그 파일을 이 step의 실행 목록에 넣는다).
- [ ] **Step 2: 실패 확인.**
- [ ] **Step 3: 구현.**
- [ ] **Step 4: 통과 확인** — `cargo test -p handicap-engine --test setup_steps --test open_loop --test open_loop_seconds` PASS.
- [ ] **Step 5: 되돌려 확인** — 준비 안 된 슬롯에서도 스케줄러가 `Launched`를 기록하게 바꿔 `setup_failed_arrival_is_in_no_counter` RED 확인 뒤 원복.
- [ ] **Step 6: 커밋** — `feat(engine): open-loop에서 준비 스텝 — 슬롯당 한 번, 실패한 슬롯은 run에서 뺀다`

---

### Task 7: trace(test-run·모니터)

**Files:**
- Modify: `crates/engine/src/trace.rs`, 필요하면 `crates/engine/src/executor.rs`
- Modify(리터럴만 — 새 필드에 기본값을 채우는 기계적 수정): `StepTrace {`·`ScenarioTrace {`·`RowsTrace {` 리터럴이 있는 파일. `grep -rln 'StepTrace {\|ScenarioTrace {\|RowsTrace {' crates --include='*.rs'`로 확인한다 — `crates/controller/src/monitor/{check,record,step_judge}.rs`, `crates/tui/src/{app,inspect}.rs`, `crates/tui/tests/*`, 엔진 테스트.
- Test: `crates/engine/tests/trace_scenario.rs`, `crates/engine/tests/trace_rows.rs` (추가)

**Interfaces:**
- Produces (모두 `#[serde(default, skip_serializing_if = …)]` — 없을 때 키가 없고, 키가 없는 JSON도 읽힌다. TUI가 `CheckRecord`로 엔진 `ScenarioTrace`를 역직렬화하므로 `default`가 빠지면 준비 없는 trace가 「missing field」로 깨진다. `timed_out`·`blocked`·`defaulted`의 선례):
  ```rust
  // StepTrace
  pub section: Option<Section>,        // 준비 행만 Some(Section::Setup); Section은 serde로 "setup"
  // ScenarioTrace
  pub setup_failed: bool,              // false면 키 없음
  pub setup_ms: Option<u64>,
  // RowsTrace
  pub setup_steps: Vec<StepTrace>,     // 비면 키 없음
  pub setup_failed: bool,
  pub setup_ms: Option<u64>,
  ```
  `Section`에 `Serialize`/`Deserialize`(`rename_all = "lowercase"`)를 단다.
  ```rust
  /// trace 쪽 구간 실행. 준비 행을 `state.steps`에 `section: Some(section)`으로 쌓는다.
  /// `state.requests`(요청 상한)와 `deadline`은 본 패스와 공유하고 스텝마다 머리에서 검사한다.
  /// 본 스텝용 `trace_steps`를 다시 쓰지 않는다(값 채우기·비움 표·너그러운 추출이 없다).
  #[allow(clippy::too_many_arguments)]
  async fn trace_section(
      section: Section,
      steps: &[Step],
      client: &VuClient,
      vars: &mut BTreeMap<String, String>,
      opts: &TraceOptions,
      deadline: Instant,
      state: &mut TraceState,
      req: &mut Option<ReqGen>,
      default_think: Option<ThinkTime>,
  ) -> TraceSectionRun;
  enum TraceSectionRun { Done(BTreeMap<String, String>), Failed, Truncated }
  ```
  `trace_once`는 인자 둘을 더 받는다: `setup_vars: &BTreeMap<String, String>`(준비 추출 — 시드 앞에 덮는다)와 `reuse_seed: Option<BTreeMap<String, String>>`(첫 패스가 준비 때 시드한 시나리오 변수 값을 다시 쓸 때 `Some`, `None`이면 지금처럼 새로 시드). `trace_once`는 진입할 때 `state.steps`를 비우고 `total_ms`를 자기 시작 시각부터 잰다 — 준비 행은 `trace_once`를 부르기 전에 `state.steps`에서 꺼내 두었다가 결과의 `steps` 앞에 붙이고, `total_ms`는 준비 시작 시각부터 다시 잰다.
- 규칙(D11):
  - `trace_scenario`·`trace_scenario_with_seed`: 준비가 있으면 본 패스 전에 준비 스텝을 실행한다. 준비 행은 `steps`의 앞에 `section: Some(Setup)`으로 들어간다. `total_ms`는 준비 포함, `setup_ms`는 준비만.
  - `trace_scenario_rows`: 준비는 첫 행 전에 한 번, 시드는 첫 행. 준비 행은 `RowsTrace.setup_steps`에.
  - 변수: 준비는 「시나리오 변수(한 번 시드) + 시드」의 사본에서 돈다. 첫 패스는 그때 시드한 시나리오 변수 값을 다시 쓰고 「시나리오 변수 → 준비 추출 → 시드」로 시작한다. 둘째 패스부터는 지금처럼 새로 시드한 뒤 준비 추출 → 그 행의 시드.
  - 준비 스텝 실행은 `execute_step_traced_with(…, ExtractMode::StrictNoDefaults)`.
  - 준비 실패 판정: 그 행에 오류가 있음, 또는 `unbound_vars`가 비어 있지 않음, 또는 추출한 값 중 빈 문자열이 있음. 오류 없이 실패로 판정한 행에는 고정 문구를 오류로 채운다: 미해결 변수 → `"setup: unbound variable"`, 빈 추출 → `"setup: empty extract"`. 실패하면 뒤 준비 스텝과 본 스텝을 실행하지 않고 `setup_failed = true`, `ok = false`.
  - 요청 상한·시간 상한은 준비 요청도 센다. 준비 도중 상한에 닿으면 `truncated = true`, `setup_failed`는 false, 본 스텝은 실행하지 않는다.
  - 준비가 없으면 세 함수의 출력 JSON이 변경 전과 같다.

- [ ] **Step 1: 실패하는 테스트**
  - `trace_setup_then_steps`: 준비 1 + 본 1 → `steps[0].section == Some(Setup)`, `steps[1].section == None`, 본 요청 헤더에 준비 토큰, `setup_ms.is_some()`.
  - `trace_setup_failure_stops`: 준비 401 → `setup_failed`, `ok == false`, 본 행 없음, `error`(trace 수준)는 `None`, 준비 행의 오류는 `Some`.
  - `trace_setup_unbound_var_fails_with_fixed_error`: 준비 주소에 `{{nope}}` → `setup_failed`, 그 행 오류 == `"setup: unbound variable"`.
  - `trace_setup_empty_extract_fails`: `{"token": null}` → 그 행 오류 == `"setup: empty extract"`.
  - `trace_setup_truncated_is_not_failed`: `max_requests: 1`·준비 스텝 2개 → `truncated`, `!setup_failed`.
  - `trace_rows_setup_once_with_first_row`: 3행 → 로그인 1건(첫 행의 계정), `setup_steps.len() == 1`, 행별 trace의 `steps`에 준비 행이 없다, 모든 행의 본 요청이 같은 토큰.
  - `trace_no_setup_json_unchanged`: 준비 없는 시나리오의 `serde_json::to_value(trace)`에 `section`·`setup_failed`·`setup_ms`·`setup_steps` 키가 없다.
  - `trace_without_new_keys_deserializes`: 새 키가 없는 `ScenarioTrace`·`RowsTrace` JSON을 `serde_json::from_str`로 읽으면 성공하고 새 필드가 기본값이다.
- [ ] **Step 2: 실패 확인.**
- [ ] **Step 3: 구현.**
- [ ] **Step 4: 통과 확인** — `cargo test -p handicap-engine --test trace_scenario --test trace_rows` PASS, `cargo build --workspace --tests` 0, `cargo test -p handicap-tui` PASS.
- [ ] **Step 5: 커밋** — `feat(engine): trace가 준비 스텝을 먼저 한 번 실행한다`

---

### Task 8: proto와 워커 전달

**Files:**
- Modify: `crates/proto/proto/coordinator.proto`, `crates/worker/src/lib.rs`
- Test: `crates/worker/src/lib.rs`의 기존 flush 변환 테스트 모듈 (추가)

**Interfaces:**
- proto: spec D8의 글자 그대로 — `MetricBatch`에 `repeated SectionStepStat section_step_stats = 14;`, `repeated SectionOutcome section_outcomes = 15;`와 두 메시지.
- 워커 변환: `SectionStepStat::serialize_histogram()` → `bytes`. `status_counts` 키는 본 창과 같은 글자화. `failure_kinds`는 `map<string,uint64>`. `last_done_ms`는 `None` → 0.
- 건너뛰기 가드(`windows.is_empty() && …`로 `None`을 돌려주는 조건)에 `&& section_step_stats.is_empty() && section_outcomes.is_empty()`를 더한다.
- prost 구조체 리터럴(`MetricBatch { … }`)이 컨트롤러·테스트에 있으면 컴파일러가 알려 준다 — 빈 벡터를 넣는다.

- [ ] **Step 1: 실패하는 테스트**
  - `section_only_flush_is_forwarded`: 다른 벡터가 모두 비고 `section_outcomes`만 있는 flush → 변환 결과가 `Some`이고 `section_outcomes[0].section == "setup"`.
  - `section_step_stat_maps_fields`: 수·상태 코드·실패 종류·히스토그램 바이트(다시 읽어 count 일치).
  - `empty_flush_still_skipped`: 지금의 빈 flush 테스트가 그대로 `None`.
  - `no_section_batch_bytes_unchanged`: **proto를 고치기 전에** 고정 내용의 `MetricBatch`(창 1개·`dropped` 1) 하나를 `encode_to_vec()`한 바이트를 출력해 테스트 안 상수로 박는다. proto를 고친 뒤 같은 내용(새 필드는 빈 벡터)의 바이트가 그 상수와 같다.
- [ ] **Step 2: 실패 확인.**
- [ ] **Step 3: 구현.**
- [ ] **Step 4: 통과 확인** — `cargo test -p handicap-worker` PASS, `cargo build --workspace --tests` 0(컨트롤러 `coordinator.rs`·`stair_monitor.rs` 테스트의 `MetricBatch` 리터럴 포함).
- [ ] **Step 5: 되돌려 확인** — 가드 항을 빼고 `section_only_flush_is_forwarded` RED 확인 뒤 원복.
- [ ] **Step 6: 커밋** — `feat(proto,worker): 구간 통계를 MetricBatch로 나른다`

---

### Task 9: 저장과 수신 — 마이그레이션 0027

**Files:**
- Create: `crates/controller/src/store/migrations/0027_run_section_metrics.sql`, `crates/controller/src/store/section.rs`
- Modify: `crates/controller/src/store/mod.rs`, `crates/controller/src/store/scenarios.rs`, `crates/controller/src/grpc/coordinator.rs`
- Test: `crates/controller/src/store/section.rs`의 `#[cfg(test)]`, 시나리오 삭제 테스트(기존 모듈에 추가)

**Interfaces:**
- 마이그레이션은 `/new-migration run_section_metrics` 스킬로 뼈대를 만든다(번호 확인: 지금 마지막은 Rust 가드 방식의 0026 — `grep -n 'migration 00' crates/controller/src/store/mod.rs`). SQL은 spec D9의 두 `CREATE TABLE IF NOT EXISTS`와 두 인덱스다.
- Produces:
  ```rust
  // store/section.rs
  pub struct SectionStepRow {
      pub run_id: String, pub worker_id: String, pub section: String, pub step_id: String,
      pub count: i64, pub error_count: i64,
      pub status_counts: String,     // JSON 객체 {"200": 3}
      pub failure_kinds: String,     // JSON 객체
      pub hdr_histogram: Vec<u8>,
  }
  pub struct SectionOutcomeRow {
      pub run_id: String, pub worker_id: String, pub section: String,
      pub ok: i64, pub failed: i64, pub interrupted: i64, pub last_done_ms: i64,   // 0 = 없음
  }
  pub async fn insert_section_step_batch(db: &Db, rows: &[SectionStepRow]) -> sqlx::Result<()>;
  pub async fn insert_section_outcome_batch(db: &Db, rows: &[SectionOutcomeRow]) -> sqlx::Result<()>;
  /// 저장된 행 그대로(합치지 않음). 합치기는 report 쪽.
  pub async fn section_steps(db: &Db, run_id: &str) -> sqlx::Result<Vec<SectionStepRow>>;
  pub async fn section_outcomes(db: &Db, run_id: &str) -> sqlx::Result<Vec<SectionOutcomeRow>>;
  ```
- 수신(`ingest_metrics`): 두 반복 필드가 비어 있지 않을 때만 행을 만들어 넣는다(비면 DB 호출 0회). `section` 글자가 `Section::from_wire`로 읽히지 않는 항목은 버리고 `warn!` 한 줄. `last_done_ms`는 워커 시작 시각에 쓰는 `plausible_start`와 같은 검사를 거쳐, 통과하지 못하면 0으로 저장하고 `warn!`. `failure_kinds`의 키는 허용 목록(Global Constraints의 실패 종류 글자)에 있는 것만 저장하고 나머지는 버린다 — 워커가 보낸 글자를 그대로 저장하지 않는다(선례 `ingest_persists_loop_exits_and_sanitizes_worker_input`). 삽입 실패는 지금의 다른 표처럼 `warn!`만.
- 시나리오 삭제의 run 연쇄 삭제 목록(`store/scenarios.rs`의 표 이름 목록)에 `run_section_step_metrics`, `run_section_outcomes`를 더한다.

- [ ] **Step 1: 실패하는 테스트**
  - `insert_and_read_back`: 두 표에 넣은 행이 그대로 읽힌다. 같은 키로 두 번 넣으면 두 행이 읽힌다(추가 전용).
  - `migration_is_idempotent`: DB를 두 번 여는 기존 마이그레이션 멱등 테스트가 통과.
  - `scenario_delete_removes_section_rows`: 시나리오를 지우면 그 run의 두 표 행이 0.
  - `ingest_drops_unknown_section`·`ingest_zeroes_implausible_last_done`·`ingest_drops_unknown_failure_kind`: 수신 함수 단위 테스트(기존 ingest 테스트 꼴을 따른다).
- [ ] **Step 2: 실패 확인.**
- [ ] **Step 3: 구현.**
- [ ] **Step 4: 통과 확인** — `cargo test -p handicap-controller section` + 시나리오 삭제 테스트 PASS.
- [ ] **Step 5: 커밋** — `feat(controller): 구간 통계 저장 표 둘(0027)과 수신`

---

### Task 10: 리포트 `setup` 블록 · 유효성 · 유지 구간 보정

**Files:**
- Modify: `crates/controller/src/report.rs`, `crates/controller/src/api/runs.rs`, `crates/controller/src/validity.rs`, `crates/controller/src/steady.rs`
- Test: 각 파일의 기존 테스트 모듈 (추가)

**Interfaces:**
- Produces:
  ```rust
  // report.rs
  #[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]   // ReportJson이 Deserialize를 파생한다
  pub struct SetupReport {
      pub ok: u64, pub failed: u64, pub interrupted: u64,
      pub steps: Vec<SetupStepReport>,
  }
  #[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
  pub struct SetupStepReport {
      pub step_id: String,
      pub count: u64, pub errors: u64,
      pub p50_ms: u64, pub p95_ms: u64, pub max_ms: u64,     // ReportStep과 같은 형·같은 µs→ms 변환
      pub status_counts: BTreeMap<String, u64>,
      pub failure_kinds: BTreeMap<String, u64>,
  }
  /// 시나리오에 준비 스텝이 없거나 YAML을 읽지 못하면 None.
  /// 순서 = 시나리오의 준비 스텝 순서. 통계가 없는 스텝은 0행.
  pub fn build_setup_report(
      scenario_yaml: &str,
      steps: &[crate::store::section::SectionStepRow],
      outcomes: &[crate::store::section::SectionOutcomeRow],
  ) -> Option<SetupReport>;

  // ReportJson 새 필드
  #[serde(skip_serializing_if = "Option::is_none")]
  pub setup: Option<SetupReport>,
  ```
- `build_report`에 인자 `setup: Option<&SetupReport>`를 더한다(마지막 `scope` 앞). `ReportJson.setup`에 복제해 넣고, `derive_validity`에 `setup.map(|s| s.failed).unwrap_or(0)`를 넘긴다. `build_report`를 부르는 곳은 컴파일러가 알려 준다(테스트·내보내기 포함) — 준비와 무관한 호출부는 `None`. 이 task의 세 시그니처 변경은 테스트 호출부가 많다(`report.rs`·`validity.rs`·`steady.rs`의 테스트와 헬퍼) — 기계적 수정이다.
- `build_reports_for_run`(`api/runs.rs`): `Scenario::from_yaml(&row.scenario_yaml)`가 성공하고 `setup_steps()`가 비어 있지 않을 때만 두 표를 읽는다(준비 없는 run은 조회 0회). 두 기준(whole·steady) 리포트에 같은 블록을 넣는다.
- 유효성: `derive_validity`에 인자 `setup_failed: u64`. `> 0`이면 `reason_base("setup_failed", "warning")`에 `count = Some(setup_failed)`를 넣어 더한다. 수준(`level`) 계산은 기존 warning 항목과 같은 규칙을 따른다. `derive_narrative`에는 가지를 더하지 않는다.
- 유지 구간(D7): `steady_window_from_spans`에 인자 `setup_done: &HashMap<&str, i64>`(워커 id → 마지막 준비 완료 epoch ms)를 더한다. 워커별 `lo_w`를 `max(lo_w, ceil_sec(그 워커의 값))`으로 한다. 값이 없는 워커는 지금 계산 그대로. 호출부(`build_reports_for_run`)는 run이 **VU 고정**(open-loop도 VU 곡선도 아님)일 때만 outcome 행에서 워커별 최대 `last_done_ms`(0 제외)를 모아 넘기고, 그 밖에는 빈 맵을 넘긴다.

- [ ] **Step 1: 실패하는 테스트**
  - `setup_report_none_without_setup`: 준비 없는 시나리오 YAML → `None`. 그 run의 리포트 JSON(`serde_json::to_value`)에 `setup` 키가 없다.
  - `setup_report_merges_rows`: 같은 스텝의 행 둘(워커 둘) → 수 합산, 상태 코드·실패 종류 맵 합산, HDR merge한 p50이 두 히스토그램을 합친 값. outcome 행 셋 → `ok`·`failed`·`interrupted` 합.
  - `setup_report_order_follows_scenario`: 행이 역순으로 들어와도 `steps` 순서가 YAML 순서.
  - `setup_report_zero_row_for_step_without_stats`.
  - `setup_report_none_on_bad_yaml`.
  - `validity_setup_failed_reason`: `setup_failed = 2` → `reasons`에 `kind == "setup_failed"`, `count == Some(2)`. 0이면 없다.
  - `steady_lo_waits_for_setup_done`: 워커 시작 t0, ramp 0·discard 1, 준비 완료가 t0+2.4초 → `lo == ceil_sec(t0+2400ms)`. 맵이 비면 지금 값.
  - `steady_setup_done_ignored_when_earlier`: 준비 완료가 t0+0.2초 → 지금 값 그대로.
  - `both_bases_carry_setup`(`api/runs.rs` 테스트 모듈): 유지 구간 표시가 있는 run + 준비 통계 행 → `build_reports_for_run`이 돌려준 두 리포트 모두 `setup`이 `Some`이고 같다.
  - `no_setup_run_has_no_setup_block`: 준비 없는 run의 리포트에 `setup`이 `None`.
- [ ] **Step 2: 실패 확인.**
- [ ] **Step 3: 구현.**
- [ ] **Step 4: 통과 확인** — `cargo test -p handicap-controller` PASS, `cargo build --workspace --tests` 0.
- [ ] **Step 5: 되돌려 확인** — `build_reports_for_run`이 `build_setup_report` 결과를 `build` 클로저에 넘기는 자리를 `None`으로 바꿔 `both_bases_carry_setup` RED 확인 뒤 원복.
- [ ] **Step 6: 커밋** — `feat(controller): 리포트 setup 블록, 준비 실패 유효성 항목, 유지 구간 시작 보정`

---

### Task 11: 「모든 스텝」 훑기 — 컨트롤러·모니터·TUI

**Files:**
- Modify: `crates/controller/src/api/scenarios.rs`, `crates/controller/src/api/runs.rs`, `crates/controller/src/api/test_runs.rs`, `crates/controller/src/monitor/{check,step_judge,unit,board_file}.rs`, `crates/tui/src/names.rs`
- Test: 각 파일의 기존 테스트 모듈 (추가)

**Interfaces:**
- 이 task는 먼저 분류표를 만든다. 명령(spec §12):
  ```bash
  grep -rn '\.steps\b' crates/engine/src crates/controller/src crates/worker/src crates/tui/src --include='*.rs'
  ```
  매치마다 「모든 스텝」·「반복 본문만」·「시나리오와 무관」으로 나눠 보고서에 표로 남긴다. 줄 수는 구현 중에 실측으로 확정한다. 아래 목록은 spec D2가 「모든 스텝」으로 정한 것이고, 표에서 이 밖의 「모든 스텝」 매치가 나오면 멈추고 보고한다.
- 「모든 스텝」으로 바꿀 곳:
  - `api/scenarios.rs`: 생성·수정에서 `validate_scenario_think_times`가 준비 스텝도 본다(`validate_parallel_branch_names`는 준비가 http만이라 불필요).
  - `api/test_runs.rs`: 같은 think time 검증.
  - `monitor/board_file.rs`: 가져오기 검증 묶음.
  - `api/runs.rs`: `maybe_strip_think`·`strip_scenario_think`가 준비 스텝의 think time도 뗀다.
  - `monitor/check.rs`의 `collect_http_steps` 호출부, `monitor/unit.rs`의 `walk_http_mut` 호출부, `monitor/step_judge.rs`의 조상 표·`auth_var_names`.
  - `crates/tui/src/names.rs`: `flatten_http_steps`·`flatten_with_hint`를 부르는 곳.
- 「반복 본문만」으로 **그대로 두는** 곳: `api/runs.rs`의 `collect_http_step_ids`·`validate_step_criteria_targets`(SLO 스텝 기준 대상), `insights.rs`·`validity.rs`의 스텝 훑기, 반복 시간 추정(`curve_first_arrival_secs` 등).
- http 아닌 준비 스텝의 거절은 Task 1의 역직렬화가 이미 한다 — 이 task는 그 결과가 API에 어떻게 나오는지만 테스트한다.
- 모니터 판정: `setup_failed`인 trace는 지금의 「오류가 있는 첫 http 행」 규칙으로 실패 판정과 사유가 나와야 한다(Task 7이 준비 행에 오류를 채운다) — 코드 변경이 필요 없으면 테스트만 더한다.

- [ ] **Step 1: 실패하는 테스트**
  - `create_scenario_rejects_non_http_setup`: `POST /api/scenarios`에 `setup.steps`가 loop → 400. 수정(`PUT`)도 400.
  - `board_import_rejects_non_http_setup`: 그런 시나리오가 든 보드 파일 가져오기가 기존 파싱 실패 응답으로 거절된다.
  - `test_run_rejects_non_http_setup`: `POST /api/test-runs` → 422.
  - `create_scenario_validates_setup_think_time`: 준비 스텝 think time이 상한을 넘으면 400(본 스텝과 같은 메시지 꼴).
  - `strip_think_strips_setup_steps`: think를 떼는 프로파일로 `maybe_strip_think` → 결과 YAML의 준비 스텝에 think time이 없고 `setup` 구조는 남는다.
  - `strip_think_without_setup_is_unchanged`: 준비 없는 YAML의 결과 글자가 변경 전과 같다(이 step에서 지금 코드로 출력해 상수로 박는다).
  - `auth_var_names_sees_setup_steps`: 준비 스텝이 `Authorization` 헤더 값을 추출·사용하는 시나리오 → 그 변수 이름이 가림 집합에 있다.
  - `monitor_check_fails_on_setup_failed`: 준비가 401인 시나리오의 점검 결과가 실패이고 사유가 준비 스텝의 사유.
  - `tui_names_include_setup_steps`: 이름 목록에 준비 스텝이 앞에 있다.
- [ ] **Step 2: 실패 확인.**
- [ ] **Step 3: 구현** — 분류표를 먼저 만들고 그 표대로 고친다.
- [ ] **Step 4: 통과 확인** — `cargo test -p handicap-controller` + `cargo test -p handicap-tui` PASS.
- [ ] **Step 5: 되돌려 확인** — `auth_var_names`를 `scenario.steps`만 보게 돌려 `auth_var_names_sees_setup_steps` RED 확인 뒤 원복.
- [ ] **Step 6: 커밋** — `feat(controller,tui): 검증·think 제거·모니터 판정·인증 가림이 준비 스텝도 본다`

---

### Task 12: UI — 모델·리포트 구획·최소 에디터

**Files:**
- Modify: `ui/src/scenario/model.ts`, `ui/src/scenario/yamlDoc.ts`, `ui/src/scenario/problems.ts`, `ui/src/scenario/scanVars.ts`, `ui/src/scenario/trust.ts`, `ui/src/components/scenario/ValidationBanner.tsx`, `ui/src/api/schemas.ts`, `ui/src/components/report/ReportView.tsx`, `ui/src/components/report/ValidityBanner.tsx`, `ui/src/components/scenario/FlowOutline.tsx`, `ui/src/print/buildPrintDoc.ts`, `ui/src/print/components/ReportHeader.tsx`, `ui/src/print/print.css`, `ui/src/i18n/ko.ts`
- Create: `ui/src/components/report/SetupSection.tsx`
- Test: 각 파일 옆 `__tests__`(기존 위치 규칙), `ui/src/components/report/__tests__/SetupSection.test.tsx` (새)

**Interfaces:**
- 이 task는 `ui/src`를 고친다 — 첫 step은 테스트다(tdd-guard).
- 모델(`model.ts`):
  ```ts
  // ScenarioModel에 추가
  setup: z.object({ steps: z.array(HttpStepModel) }).strict().optional(),
  export function setupSteps(s: Scenario): HttpStep[];   // 없으면 []
  export function allSteps(s: Scenario): Step[];         // setup → steps
  ```
- `yamlDoc.ts`의 `normalizeForModel` 허용 목록에 `setup`을 통과시킨다: 값이 `null`·없음이면 키를 넣지 않고, 객체면 `steps`가 배열일 때만 `normalizeStep`을 적용하고 배열이 아니면(없음 포함) 그대로 넘긴다 — `setup: {}`는 여기서 던지지 않고 Zod가 거절한다. 그 밖의 키도 그대로 넘겨 Zod strict가 거절하게 한다.
- `problems.ts`: `collectProblems(steps, yamlError, setupSteps: HttpStep[] = [])`로 인자를 더하고(호출부는 `ValidationBanner.tsx` 한 곳), 스텝 id가 `setup`과 `steps`를 통틀어 겹치면 문제로 낸다. 문구 `ko.editor.problemDuplicateStepId(id)` = 「스텝 id가 겹칩니다: <id>」(기존 `ko.editor.problemEmptyUrl` 옆). 기존 문제 항목 형식을 따르되 스텝 선택으로 이어지는 연결은 달지 않는다(A1에서는 준비 스텝을 고를 수 없다).
- `scanVars.ts`: 「이 변수를 만든 스텝이 있는가」 판정이 준비 스텝의 추출을 본 스텝에서 정의됨으로 본다. 준비 스텝이 본 스텝의 추출을 읽으면 정의 안 됨이다. 고칠 함수는 `grep -n 'scenario.steps\|\.steps' ui/src/scenario/scanVars.ts`로 확인한다(`undefinedVarRefs`·`collectProducedVars`·`flatExtractNames` 등).
- 같은 파일의 변수 **수집** 함수(`scanFlowVars`·`scanEnvVars`·`buildVarRefIndex`)도 준비 스텝을 훑는다. `scanFlowVars`는 run 생성 창의 데이터셋 열 연결 행을 만든다 — 빠지면 준비 스텝만 쓰는 `{{user}}`에 연결 행이 없어 화면으로 만든 run이 `unknown_var`로 전부 실패한다.
- `trust.ts`의 `isTrustApplicable`·`evaluateTrust`가 준비 스텝도 본다(D2·D6 — 「상태 검증 없음」이 준비 스텝에도 나온다).
- 리포트 스키마(`api/schemas.ts`, `ReportSchema`는 strict):
  ```ts
  export const ReportSetupSchema = z.object({
    ok: z.number(), failed: z.number(), interrupted: z.number(),
    steps: z.array(z.object({
      step_id: z.string(), count: z.number(), errors: z.number(),
      p50_ms: z.number(), p95_ms: z.number(), max_ms: z.number(),
      status_counts: z.record(z.number()), failure_kinds: z.record(z.number()),
    }).strict()),
  }).strict();
  // ReportSchema에: setup: ReportSetupSchema.optional()
  ```
  유효성 사유 `setup_failed`를 `ValidityBanner`의 분기에 더한다. 문구 `ko.validity.reason.setup_failed` = 「준비 스텝 실패로 부하가 설정보다 적었습니다」(spec D10).
- `SetupSection.tsx`: props `{ setup: ReportSetup; stepMeta: Map<string, {name: string}>; loadModel: "vu" | "open"; steadyNote: boolean }`. `loadModel`은 `ReportView`가 run 프로파일에서 정한다(open-loop면 `"open"`, VU 고정·VU 곡선은 `"vu"` — 리포트 화면이 이미 쓰는 부하 방식 판정을 쓴다). `steadyNote`는 open-loop이고 리포트에 `basis` 블록이 있을 때 true. 동작(D12·D7):
  - `steadyNote`면 펼친 내용 끝에 「유지 구간 안에서도 준비가 실행됐을 수 있습니다.」
  - 접이식. 기본 접힘, `failed > 0`이면 처음부터 펼침.
  - 머리 줄: 「준비 스텝 N개 · VU M개 준비 완료」(open-loop면 「슬롯 M개 준비 완료」).
  - 펼치면 스텝 표(이름·요청 수·오류·p50·p95·최대·상태 코드)와 실패 종류.
  - 경고·안내 문구는 spec D12의 글자 그대로(`ko.report.setup.*`). 실패 종류 이름은 `ko`의 기존 오류 종류 카탈로그(`errorKinds`)를 재사용하고 `read_body`·`status_assert`·`extract`·`unknown_var`·`malformed_template`·`cast_failed`만 새로 더한다.
- `ReportView.tsx`: `stepMeta`가 준비 스텝도 포함한다. `report.setup`이 있으면 스텝별 표 구획 아래에 `SetupSection`을, 요약 카드 아래에 한 줄 안내(spec D12)를 그린다.
- 인쇄: `buildPrintDoc`의 머리 정보에 `setupNote?: string`(준비가 있을 때 spec D12의 한 줄)을 더하고, `ReportHeader.tsx`가 `.p-meta-basis`와 같은 전체 폭 한 줄로 그린다(4칸 격자에 칸을 더하지 않는다).
- `FlowOutline.tsx`: 준비 스텝이 있으면 목록 위에 읽기 전용 한 줄 「준비 스텝 N개 — YAML 보기에서 확인할 수 있습니다」. 그 밖의 아웃라인 동작은 바꾸지 않는다.

- [ ] **Step 1: 실패하는 테스트**
  - 모델·YAML: `setup` 있는 YAML을 `parseScenarioDoc` → `model.setup.steps.length === 1`. `setup:`(null) → `model.setup === undefined`. `setup: {}` → 오류. `setup.steps`에 loop → 오류. 준비 없는 문서를 편집·직렬화해도 `setup`이라는 글자가 생기지 않는다.
  - `collectProblems`: id 겹침을 낸다.
  - `scanVars`: 준비가 `token`을 추출하고 본 스텝이 `{{token}}`을 읽으면 정의 안 됨 목록이 빈다. 반대 방향은 정의 안 됨. `scanFlowVars`가 준비 스텝만 쓰는 `{{user}}`를 돌려준다. `scanEnvVars`가 준비 스텝의 `${BASE_URL}`을 돌려준다.
  - `trust`: 준비 스텝에 상태 검증이 없으면 본 스텝에 없을 때와 같은 항목이 나온다.
  - `ReportSchema`: `setup` 블록이 있는 응답과 없는 응답 둘 다 통과. `setup: null`은 통과하지 않는다(서버는 키를 생략한다 — 이 단언이 깨지면 서버 쪽을 확인).
  - `SetupSection`: 기본 접힘 / `failed > 0`이면 펼침과 경고 문구 / open-loop 문구 / `interrupted > 0` 문구 / `steadyNote` 문구 / 스텝 이름이 `stepMeta`에서 온다 / 이름이 없으면 step id.
  - `ReportView`: `setup`이 없는 리포트에는 구획도 안내 줄도 없다.
  - 인쇄: 준비가 있는 리포트의 머리에 안내 줄, 없는 리포트에는 없다.
  - `FlowOutline`: 준비 스텝 2개 → 안내 한 줄, 0개 → 없음.
- [ ] **Step 2: 실패 확인** — `cd ui && pnpm test <파일 이름>`로 파일별 RED 확인(`pnpm test -- --run <파일>`은 `--` 때문에 전체가 돈다).
- [ ] **Step 3: 구현.**
- [ ] **Step 4: 통과 확인** — `cd ui && pnpm lint && pnpm test && pnpm build` 0.
- [ ] **Step 5: 분류표** — spec §12의 UI 명령을 돌려 매치를 셋으로 분류하고, A1에서 고치지 않은 「모든 스텝」 매치(A2 몫: Inspector·test-run 화면·흐름 칩·사이징·모니터 칸 설정·인쇄 본문 등)를 보고서에 표로 남긴다. 이 표가 A2 plan의 입력이다.
  ```bash
  grep -rnE '\.steps\b|"steps"' ui/src --include='*.ts' --include='*.tsx'
  ```
- [ ] **Step 6: 커밋** — `feat(ui): 준비 스텝 모델과 리포트 구획, 에디터 최소 대응`

---

### Task 13: ADR-0062와 문서

**Files:**
- Create: `docs/adr/0062-vu-setup-section.md`
- Modify: `CLAUDE.md`(알아둘 결정들 한 줄), `crates/engine/CLAUDE.md`, `crates/controller/CLAUDE.md`, `ui/src/scenario/CLAUDE.md`

- [ ] **Step 1: ADR을 쓴다** — MADR 형식(`docs/adr/0061-*.md`의 꼴). 담을 결정: 준비 구간 = 시나리오의 `setup: { steps }` 객체(http만), VU의 첫 반복 머리에서 그 반복의 값으로 한 번, 추출·쿠키 이어받기, 준비 통계는 본 집계와 별도 누적기·구간 이름을 가진 와이어·표, 실패 시 재시도 없음과 빈 값 = 실패, 기각한 대안(스텝별 「한 번만」 스위치 · 리포트에서만 제외 · 컨트롤러가 id로 거르기 · `per_vu` 열만 보기 · 목록 꼴 `setup`).
- [ ] **Step 2: 인덱스와 함정 노트** — 루트 `CLAUDE.md`의 결정 인덱스에 `- **0062** …` 한 줄. 도메인 `CLAUDE.md`에 각각 한 줄씩: 엔진(준비 통계는 `MetricFlush` 드레인 여섯 곳·가드 전부·워커 가드 / 세 진입점의 첫 반복 다시 짜기는 시드·행을 다시 고르지 않는다 / open-loop 준비 안 된 슬롯은 태스크가 `Launched`를 기록), 컨트롤러(「준비가 있는가」는 `setup_steps()`로 / 구간 표는 추가 전용·읽을 때 합침), UI(`setup`은 최상위 키 세 곳 규칙).
- [ ] **Step 3: 확인** — `just doc-budget` 결과가 FAIL이 아니다.
- [ ] **Step 4: 커밋** — `docs: ADR-0062 준비 구간, 도메인 함정 노트`

---

## 구현 뒤 (plan 밖 — 파이프라인 4–6단계)

- 최종 리뷰: `handicap-reviewer`(와이어 1:1 — proto ↔ 워커 변환 ↔ 수신 ↔ 표 ↔ 리포트 JSON ↔ Zod) + `security-reviewer`(spec §13: 인증 가림, `SetupFailed` 문구·`failure_kinds`·새 로그 줄에 값 없음).
- 라이브 검증: spec §12의 표에서 「A1」 줄 전부. 토큰 방식·쿠키 방식 응답기는 `/live-verify` 스캐폴드의 응답기를 확장하거나 작은 전용 응답기를 쓴다(로그인 호출 수·계정별 조회 수를 셀 수 있어야 한다).
- 마무리: `/finish-slice` — roadmap §B 새 블록(번호는 `grep -n '^### B' docs/roadmap.md`의 마지막 + 1)에 spec §11의 항목과 구현 중 판단을 비용·해소법과 함께, 「A1과 A2 사이 릴리즈 금지」를 블록 머리에.
