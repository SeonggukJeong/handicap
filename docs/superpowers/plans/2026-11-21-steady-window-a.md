# 유지 구간 기준 리포트 — 슬라이스 A 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 「고정」 부하에 상승 시간·앞부분 버림을 넣을 수 있게 하고, 그런 run의 리포트·SLO 판정을 유지 구간 기준(전체 구간으로 전환 가능)으로 만든다.

**Architecture:** run 프로필에 `steady` 표시를 저장하고(서버가 세 가지 저장 모양으로 맞춘다), 리포트 계산(`build_report`)에 「초 범위」를 넘겨 같은 계산을 유지 구간 행만으로 한 번 더 돌린다. `GET /runs/{id}/report?basis=`가 기준을 고르고, 리포트의 `basis` 블록이 창·상태·다른 기준의 핵심 숫자를 싣는다. 엔진은 closed-loop 고정 경로가 시작 시각을 싣고 flusher를 VU 기동 전에 띄우는 두 가지만 바뀐다.

**Tech Stack:** Rust(controller·engine), SQLite(스키마 변경 없음), TypeScript/React + Zod + React Query.

**Spec:** `docs/superpowers/specs/2026-11-21-steady-window-design.md` — 이 plan은 §3-1의 **슬라이스 A**(D1–D8, D9의 A 몫, R1–R9·R11–R13)만 구현한다. 슬라이스 B(시계열 띠, D10 전부)는 다음 plan.

<!-- spec-plan-reviewer 4회차 clean APPROVE (2026-11-21) -->
REVIEW-GATE: APPROVED

## Global Constraints

- **US4 불변**: `steady`가 없는 run은 리포트 JSON·판정·내보내기·제출 페이로드가 변경 전과 같다. 리포트에 `basis` 키를 내지 않고 `?basis=`를 무시한다. 상승 0·버림 0이면 UI는 `steady`를 보내지 않는다.
- **범위(spec D2)**: `ramp_seconds` 0–3600, `hold_seconds` 1–86400, `discard_seconds` 0–3600, `hold_seconds − discard_seconds ≥ 5`, `target` 1–1,000,000. 상승 0이고 버림 0인 `steady`는 400.
- **마이그레이션·proto 변경 없음**: `steady`는 `profile_json`에만 있다. 워커는 지금의 `stages`/`target_rps`/`vus`+`ramp_up_seconds`만 받는다. proto 필드 `open_loop_started_at_ms`의 이름은 그대로 둔다.
- **문구**: 화면 문구는 전부 `ui/src/i18n/ko.ts` 경유(ADR-0035), 서버 400 사유는 한국어. 단위 글자는 `iter/s`. 낱말은 「상승」·「유지」·「앞부분 버림」·「유지 구간」·「전체 구간」으로 통일(「램프업」·「점진 시작」 기존 문구는 이번에 고치지 않는다 — Task 7에서 지정한 것만).
- **주석 규칙(working-rules §7)**: 이상한 동작을 변호하는 주석을 새로 쓰지 않는다. 사실(불변식·순서 제약)만 적는다.
- **성능(working-rules §10)**: `steady` 없는 run의 리포트 계산 경로에 새 DB 조회·새 반복을 더하지 않는다(`Option` 확인만).
- **커밋 게이트**: cargo-영향 커밋은 수 분. `--no-verify`·`| tail` 금지. UI 커밋 전 `pnpm lint && pnpm test && pnpm build`.
- **줄 번호**: 이 문서의 줄 번호는 `84bce772`에서 `grep -n`으로 잰 값이다. 앞 task가 같은 파일을 고치면 밀리므로 편집 전에 다시 `grep -n` 한다.

## Review Focus

spec이 암시하지만 아래 task의 기본 테스트가 저절로 밟지 않는 입력. 각 줄의 테스트는 괄호 안 task에 들어 있다.

1. **VU 1개·긴 반복 run이 정상 완료했는데 마지막 초에 끝난 응답이 없다** — `measured`여야 하고 측정 초가 줄어 RPS가 부풀면 안 된다 (Task 3 `completed_run_without_metric_in_last_second_is_measured`).
2. **이미 정규화된 프로필을 다시 저장·발사한다(프리셋 재저장, 스케줄 발사, 다시 실행)** — `steady` + `stages`가 함께 온 페이로드가 400이 되면 다시 실행이 전부 깨진다 (Task 1 `renormalize_is_identity_*`, Task 6 `prefill_roundtrip_keeps_steady`).
3. **옛 프리셋이 `rps_warmup_seconds`에 상승 시간을 복사해 뒀다** — 유지 구간 기준에서 상승을 두 번 빼면 `min_window_rps` 창이 비어 기준이 조용히 건너뛰어진다 (Task 4 `warmup_equal_to_ramp_removes_nothing_extra`).
4. **중단한 run에서 워커 하나만 유지 구간에 닿았다** — `no_common_window`(워커 시작 시각 탓)가 아니라 `partial`/`not_reached`여야 한다 (Task 3 `aborted_run_with_one_worker_in_window_is_not_no_common_window`).
5. **`steady` run을 「지난 실행」으로 읽는 화면(사이징 도우미·목록 요약·인쇄 조건)** — 저장본에 `target_rps`가 없고 `stages`가 있어 「곡선」·「0 iter/s」로 찍힌다 (Task 8 `steady_run_reads_as_fixed_everywhere`).

---

## 파일 구조

| 파일 | 책임 | task |
|---|---|---|
| `crates/controller/src/steady.rs` (새 파일) | `SteadyConfig`·검증·정규화, 유지 구간 창 계산, `Basis`·`BasisBlock` 타입 | 1·3·5 |
| `crates/controller/src/store/runs.rs` | `Profile.steady` 필드 | 1 |
| `crates/controller/src/api/{runs,presets,schedules}.rs`, `schedule/runner.rs` | 정규화 호출 다섯 곳, `build_report_for_run` 기준 인자, `?basis=` | 1·5 |
| `crates/engine/src/runner.rs` | closed-loop 고정: flusher 조기 기동, 시작 시각 싣기 | 2 |
| `crates/controller/src/report.rs` | `build_report`에 `SteadyScope`, `ReportJson.basis` | 4·5 |
| `crates/controller/src/insights.rs` | 전체 구간 포화 인사이트 끼워 넣기 | 4 |
| `ui/src/api/schemas.ts`, `client.ts`, `hooks.ts` | `steady`·`basis` 스키마, 기준별 조회 키 | 6·9 |
| `ui/src/components/run/loadModel.ts` | `steadyPlan`·`fixedTarget`·`steadyFormSeed`·`deriveLoadMode` | 6 |
| `ui/src/components/run/{LoadModelFields,RunDialog,ScheduleForm}.tsx` | 칸·검증·요약 줄·프리필 | 7 |
| 표시 사이트 9곳(Task 8 목록) | `steady` run을 「고정 + 상승·버림」으로 읽기 | 8 |
| `ui/src/components/report/BasisBar.tsx` (새 파일), `ReportView.tsx`, `pages/RunDetailPage.tsx` | 기준 전환·기준 줄·참고 줄·표지·주소 | 9 |

**서브에이전트 공통(orchestrator가 brief에 넣는다)**: prompt 첫 줄 `cd /Users/sgj/develop/handicap/.claude/worktrees/steady-window`. spec의 `사용자 스토리 (US)` 블록을 매 brief에 첨부. `ui/src`를 건드리는 task는 테스트 파일 편집이 첫 스텝(tdd-guard). 리뷰 라우팅: Task 1–5는 path-gate(engine·와이어·판정)라 code-quality 리뷰 `model: opus`.

---

### Task 1: `steady` 설정 저장·정규화·검증 (R1·R12)

**Files:**
- Create: `crates/controller/src/steady.rs`
- Modify: `crates/controller/src/lib.rs`(`pub mod steady;`), `crates/controller/src/store/runs.rs`(`Profile`), `crates/controller/src/api/runs.rs:1072`, `crates/controller/src/api/presets.rs:84,145`, `crates/controller/src/api/schedules.rs:185`, `crates/controller/src/schedule/runner.rs:149`
- Test: `crates/controller/src/steady.rs` 인라인 `#[cfg(test)]`, `crates/controller/tests/api_test.rs`, `crates/controller/tests/presets_api_test.rs`, `crates/controller/tests/schedules_api_test.rs`

**Interfaces:**
- Consumes: `crate::store::runs::Profile`, `handicap_engine::Stage`, 기존 `crate::stair::normalize_stair`.
- Produces:
  ```rust
  // steady.rs
  #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
  #[serde(deny_unknown_fields)]
  pub struct SteadyConfig {
      pub ramp_seconds: u32,
      pub hold_seconds: u32,
      pub discard_seconds: u32,
      #[serde(default, skip_serializing_if = "Option::is_none")]
      pub target: Option<u32>,
  }
  pub fn validate_steady(c: &SteadyConfig) -> Result<(), String>;
  /// steady가 없으면 no-op. 반드시 normalize_stair 뒤, validate_run_config 앞.
  pub fn normalize_steady(p: &mut Profile) -> Result<(), String>;
  ```
  `Profile`에 `#[serde(default, skip_serializing_if = "Option::is_none")] pub steady: Option<crate::steady::SteadyConfig>` (`stair` 바로 아래).

- [ ] **Step 1: 실패하는 단위 테스트를 쓴다** (`steady.rs` 인라인). 프로필 도우미 `fn base() -> Profile`은 `report.rs` 테스트의 `run_row().profile`과 같은 전 필드 리터럴 + `steady: None`.

  | 테스트 이름 | 입력 | 기대 |
  |---|---|---|
  | `open_ramp_fills_stages` | `max_in_flight: Some(50)`, `steady{ramp 20, hold 40, discard 5, target Some(40)}`, 나머지 0/None | `Ok`; `stages == Some([{40,20},{40,40}])`, `duration_seconds == 0`, `target_rps == None` |
  | `open_ramp_requires_ramp_and_slots` | 위에서 `ramp 0` / `max_in_flight None` 각각 | `Err` |
  | `open_ramp_rejects_extra_knobs` | 위에 `target_rps Some(40)` / `vus 3` / `ramp_up_seconds 5` / `duration_seconds 60` 각각 | 넷 다 `Err` |
  | `open_ramp_rejects_mismatched_stages` | 위에 `stages Some([{40,20},{40,41}])` | `Err`, 사유에 「stages」 |
  | `open_discard_only_fills_duration` | `target_rps Some(40)`, `max_in_flight Some(50)`, `duration_seconds 0`, `steady{0, 60, 5, None}` | `Ok`; `duration_seconds == 60`, `stages == None` |
  | `open_discard_only_rejects` | 위에 `ramp 10` / `stages Some([..])` / `duration_seconds 61` 각각 | 셋 다 `Err` |
  | `closed_fills_duration` | `vus 10`, `ramp_up_seconds 10`, `duration_seconds 0`, `steady{10, 50, 5, None}` | `Ok`; `duration_seconds == 60` |
  | `closed_requires_equal_ramp` | 위에서 `ramp_up_seconds 0` / `duration_seconds 61` | 둘 다 `Err` |
  | `closed_rejects_stages` | closed 모양에 `stages Some([{5,10}])` | `Err` (spec D2 규칙 3) |
  | `rejects_stair_and_vu_stages` | `stair Some(..)` / `vu_stages Some(..)` + `steady` | 둘 다 `Err` |
  | `range_limits` | `ramp 3601` / `hold 0` / `hold 86401` / `discard 3601` / `hold 9, discard 5`(남는 4초) / `target Some(0)` / `target Some(1_000_001)` / `ramp 0, discard 0` | 전부 `Err`; `hold 10, discard 5`는 `Ok` |
  | `open_ramp_rejects_target_below_worker_count` | open-ramp, `worker_count Some(4)`, `target Some(3)` | `Err`, 사유에 「worker_count」 |
  | `renormalize_is_identity_open_ramp` / `_open_discard` / `_closed` | 한 번 정규화한 프로필을 복제해 다시 `normalize_steady` | `Ok`이고 `serde_json::to_value`가 처음 결과와 같다 (Review Focus 2) |
  | `no_steady_is_noop` | `steady None`인 임의 프로필 | `Ok`, `serde_json::to_value`가 호출 전과 같다 |
  | `serde_omits_absent_and_rejects_unknown` | `Profile` 직렬화 / `{"ramp_seconds":1,"hold_seconds":10,"discard_seconds":0,"x":1}` 역직렬화 | JSON에 `"steady"` 키 없음(`as_object().contains_key`) / `Err` |

  `Profile`은 `PartialEq`를 derive하지 않는다(`store/runs.rs:114`) — 프로필 비교는 전부 `serde_json::to_value`로 한다(derive를 더하지 않는다).

- [ ] **Step 2: 실패 확인** — `cargo nextest run -p handicap-controller steady::` → 컴파일 에러(모듈 없음).

- [ ] **Step 3: `Profile.steady` 필드를 더하고 리터럴 사이트를 고친다.** `cargo build --workspace --tests`가 「missing field `steady`」로 알려 주는 곳 전부에 `steady: None`. `grpc/profile.rs`의 전 필드 픽스처에는 `steady`가 **와이어로 가지 않는다**는 사실을 `stair`와 같은 방식으로 다룬다(`..Default::default()`로 피하지 않는다).

- [ ] **Step 4: `validate_steady`·`normalize_steady`를 구현한다.** 모양 판별은 spec D2의 규칙 1→2→3 순서 그대로:
  1. `steady.target.is_some()` → open-loop + 상승. `expand = [Stage{target, ramp}, Stage{target, hold}]`. `stages`가 `None | Some([])`면 채우고, 있으면 `==`일 때만 통과.
  2. `target` 없음 + `p.target_rps.is_some()` → open-loop, 버림만.
  3. 그 밖 → closed-loop.
  공통 선검사: `validate_steady` → `p.stair.is_some()` 400 → `p.vu_stages`가 비어 있지 않으면 400. 400 사유(정확한 글자):
  - `"유지 구간 설정(steady)과 계단 시험(stair)은 함께 쓸 수 없습니다"`
  - `"유지 구간 설정(steady)과 vu_stages는 함께 쓸 수 없습니다"`
  - `"유지 구간 설정(steady)과 stages가 일치하지 않습니다 — stages를 비우세요"`
  - `"유지 구간 설정(steady)이 있는 고정 VU 부하에는 stages를 쓸 수 없습니다"`
  - `"steady.ramp_seconds와 ramp_up_seconds가 같아야 합니다"`
  - `"steady의 상승·유지 시간과 duration_seconds가 맞지 않습니다"`
  - `"도착률 고정에 상승 시간을 쓰려면 steady.target과 max_in_flight가 필요합니다"`
  - `"steady.target을 쓸 때는 target_rps·vus·ramp_up_seconds·duration_seconds를 비워야 합니다"`
  - `"worker_count={w}이면 steady.target >= {w} 필요 (워커당 1 iter/s 이상)"`
  - 범위: `"상승 시간은 0초 이상 3600초 이하여야 합니다"`, `"유지 시간은 1초 이상 86400초 이하여야 합니다"`, `"앞부분 버림은 0초 이상 3600초 이하여야 합니다"`, `"앞부분 버림을 뺀 유지 시간이 5초 이상 남아야 합니다"`, `"목표 도착률은 1 이상 1,000,000 이하여야 합니다"`, `"상승 시간과 앞부분 버림이 모두 0이면 steady를 쓸 수 없습니다"`

- [ ] **Step 5: 다섯 진입점에 호출을 더한다.** `normalize_stair(...)` 호출 바로 다음 줄에 같은 오류 처리로 `crate::steady::normalize_steady(...)`:
  - `api/runs.rs:1072`, `api/presets.rs:84`, `api/presets.rs:145`, `api/schedules.rs:185` → `.map_err(ApiError::BadRequest)?`
  - `schedule/runner.rs:149` → 바로 위 `normalize_stair`의 `if let Err(e)` 블록과 같은 기록·`continue` 처리.
  확인: `grep -rn "steady::normalize_steady(" crates/controller/src` → 프로덕션 호출 5줄(위 다섯 위치) + `schedule/runner.rs` 테스트의 호출. `steady.rs` 안의 정의·인라인 테스트는 이 패턴에 걸리지 않는다.

- [ ] **Step 6: 진입점 통합 테스트.** 각 파일의 기존 `make_app`/요청 도우미를 쓴다.
  - `api_test.rs` `run_create_with_steady_open_ramp_stores_stages`: `POST /api/runs` 프로필 `{max_in_flight:50, duration_seconds:0, steady:{target:40, ramp_seconds:20, hold_seconds:40, discard_seconds:5}}` → 201, `GET /api/runs/{id}`의 `profile.steady.target == 40`, `profile.stages` 길이 2.
  - `api_test.rs` `run_create_rejects_open_loop_ramp_up_without_steady`: `{target_rps:40, max_in_flight:50, duration_seconds:60, ramp_up_seconds:20}` → 400 (spec F1 유지, R12).
  - `api_test.rs` `run_create_rejects_steady_with_stair` → 400.
  - `presets_api_test.rs` `preset_save_and_update_normalize_steady`: 저장·수정 둘 다 응답 프로필에 `stages`가 채워짐.
  - `presets_api_test.rs` `preset_resave_of_normalized_profile_is_accepted`: GET한 프로필을 그대로 PUT → 200.
  - `schedules_api_test.rs` `schedule_save_normalizes_steady` → 저장된 프로필에 `stages`.
  - `schedule/runner.rs` 인라인(기존 `:623`·`:655` 테스트 옆) `fire_normalizes_steady_profile`: `steady`만 있고 `stages` 없는 스케줄을 발사 → 만들어진 run의 프로필에 `stages`.

- [ ] **Step 7: 통과 확인** — `cargo nextest run -p handicap-controller steady:: run_create_ preset_ schedule_save_ fire_normalizes` 전부 PASS, `cargo build --workspace --tests` 경고 0.

- [ ] **Step 8: 커밋** — `feat(controller): steady 설정 저장·정규화 — 고정 부하의 상승·버림 (R1·R12)`

---

### Task 2: closed-loop 고정 — flusher 조기 기동 + 시작 시각 (R3·R13, spec D4)

**Files:**
- Modify: `crates/engine/src/runner.rs`(`run_scenario` `:171-420`, `MetricFlush` 문서 주석 `:138-139`), `crates/proto/proto/coordinator.proto:96`(주석만)
- Test: `crates/engine/tests/open_loop_seconds.rs`(`:181-204` 테스트 교체), 새 `crates/engine/tests/closed_loop_ramp_flush.rs`, `crates/controller/src/grpc/coordinator.rs` 인라인

**Interfaces:**
- Consumes: 기존 `epoch_millis()`(`runner.rs:2203`), `MetricFlush.open_loop_started_at_ms: Option<i64>`.
- Produces: `run_scenario`의 **모든** flush가 `open_loop_started_at_ms: Some(t0)`(VU를 띄우기 시작한 시각의 epoch ms, 한 run에서 같은 값)를 싣는다. `open_loop_seconds`는 계속 빈 Vec. `run_scenario_vu_curve`는 바꾸지 않는다.

- [ ] **Step 1: 재현 테스트를 먼저 쓴다** (`closed_loop_ramp_flush.rs`, `open_loop_seconds.rs`의 `delayed_server`·`scenario`·`plan` 도우미를 `mod` 공유가 안 되면 같은 모양으로 둔다).

  ```rust
  /// spec F2b: 상승 중에도 메트릭이 흘러야 한다(시작 감시가 「부하 없음」으로 오판하지 않게).
  #[tokio::test]
  async fn metrics_flow_during_ramp_up() {
      let server = delayed_server(Duration::from_millis(10)).await;
      let mut p = plan(1, 1, 6);          // duration 6s
      p.vus = 4;
      p.ramp_up = Duration::from_secs(4); // 1초마다 VU 1개 → 띄우는 반복문이 3초 넘게 돈다
      p.target_rps = None;
      p.max_in_flight = None;
      let (tx, mut rx) = mpsc::channel::<MetricFlush>(256);
      let started = std::time::Instant::now();
      let h = tokio::spawn(run_scenario(scenario(&format!("{}/", server.uri())), p, tx, CancellationToken::new()));
      let first = rx.recv().await.expect("a flush");
      assert!(started.elapsed() < Duration::from_millis(2500),
          "첫 flush가 상승이 끝난 뒤({:?})에야 왔다", started.elapsed());
      assert!(!first.windows.is_empty());
      while rx.recv().await.is_some() {}
      h.await.unwrap().unwrap();
  }
  ```
  `plan(..)` 도우미의 인자 뜻은 `open_loop_seconds.rs` 머리에서 확인하고 맞춘다(인자 순서를 추측하지 않는다).

- [ ] **Step 2: 실패 확인** — `cargo nextest run -p handicap-engine metrics_flow_during_ramp_up`. **기대: FAIL**(VU를 띄우는 반복문이 약 3초에 끝나고 그 뒤에야 flusher가 뜬다 → 첫 flush 약 3초). **통과하면 STOP** — F2b가 재현되지 않은 것이다. 그 경우 spec D4 마지막 줄대로 이 테스트만 남기고 Step 4의 「flusher 이동」을 건너뛰며, 그 사실을 보고서에 적는다(orchestrator가 roadmap §B에 기록).

- [ ] **Step 3: 시작 시각 테스트를 쓴다.** `open_loop_seconds.rs`의 `closed_loop_flush_has_no_open_loop_fields`를 아래로 **교체**:

  ```rust
  #[tokio::test]
  async fn closed_loop_flush_carries_start_time_but_no_seconds() {
      // (기존 본문 그대로 run_scenario 실행)
      let before = /* epoch ms now */;
      // ...
      let mut starts = std::collections::BTreeSet::new();
      while let Some(f) = rx.recv().await {
          n += 1;
          assert!(f.open_loop_seconds.is_empty());
          starts.insert(f.open_loop_started_at_ms.expect("closed-loop 고정도 시작 시각을 싣는다"));
      }
      assert!(n > 0);
      assert_eq!(starts.len(), 1, "한 run의 시작 시각은 하나");
      let t0 = *starts.iter().next().unwrap();
      assert!(t0 >= before && t0 <= before + 1_000);
  }
  ```

- [ ] **Step 4: 구현.** `run_scenario`에서
  1. `let started_at_ms = epoch_millis();`를 `started_at` 바로 다음에 둔다.
  2. 「Flusher」 블록(`let flush_agg = …` ~ `});`, 지금 `:292-357` 부근)을 **VU를 띄우는 `loop` 앞**으로 옮긴다. 본문은 그대로다.
  3. 주기 flush와 최종 flush의 `open_loop_started_at_ms: None`을 `Some(started_at_ms)`로.
  4. `MetricFlush.open_loop_started_at_ms` 문서 주석을 「스케줄 t=0의 epoch ms. open-loop 전 경로와 closed-loop 고정(`run_scenario`)이 모든 flush에 싣는다. VU 곡선 경로는 `None`.」으로, `coordinator.proto:96` 주석을 「open-loop 스케줄 t=0 또는 closed-loop 고정의 VU 기동 시작 epoch ms, 0 = 없음」으로.

- [ ] **Step 5: 컨트롤러 ingest 테스트** (`coordinator.rs` 인라인, 기존 `open_loop_started_at_ms: started` 테스트 `:3250` 부근의 도우미를 쓴다) `closed_loop_batch_start_time_is_stored`: `target_rps` 없는 run에 `open_loop_started_at_ms: now` + 창 1개인 배치를 ingest → `open_loop::worker_starts(db, run)`이 그 값 1행. ingest 코드는 바꾸지 않는다(이미 `> 0`이면 넣는다 — 이 테스트는 그 사실을 잠근다).

- [ ] **Step 6: 통과 + 되돌려 확인.** `cargo nextest run -p handicap-engine` 전체 PASS. flusher 블록을 원래 자리로 되돌려 Step 1 테스트가 다시 FAIL하는지 보고 원복. 계단 감시(`stair_monitor.rs:635`)는 계단 run 전용 분기 안에 있음을 `grep -n "open_loop_started_at_ms" crates/controller/src/stair_monitor.rs`로 다시 확인해 보고서에 적는다.

- [ ] **Step 7: 커밋** — `fix(engine): closed-loop 고정이 상승 중에도 메트릭을 보내고 시작 시각을 싣는다 (R3·R13)`

---

### Task 3: 유지 구간 창 계산 (R4, spec D3)

**Files:**
- Modify: `crates/controller/src/steady.rs`
- Test: 같은 파일 인라인

**Interfaces:**
- Consumes: `SteadyConfig`(Task 1), `crate::store::metrics::WindowWithHdr`, `crate::store::open_loop::WorkerStartRow`, `crate::store::runs::RunStatus`.
- Produces:
  ```rust
  #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
  #[serde(rename_all = "snake_case")]
  pub enum BasisState { Measured, Partial, NotReached, NoCommonWindow }

  #[derive(Debug, Clone, Copy, PartialEq, Eq)]
  pub struct SteadyWindow {
      /// ts_second 반열린 구간 [lo, hi). 창이 비면 None.
      pub range: Option<(i64, i64)>,
      pub state: BasisState,
      pub t0_estimated: bool,
  }

  /// `ended_at_ms`: run이 completed가 아닐 때의 끝(없으면 마지막 메트릭 초의 끝을 쓴다).
  pub fn steady_window(
      cfg: &SteadyConfig,
      completed: bool,
      ended_at_ms: Option<i64>,
      rows: &[WindowWithHdr],
      starts: &[WorkerStartRow],
  ) -> SteadyWindow;
  ```

- [ ] **Step 1: 실패하는 테스트를 쓴다.** 도우미 `fn row(worker: &str, ts: i64) -> WindowWithHdr`(count 1, 빈 HDR), `fn start(worker, ms)`. 기본 설정 `cfg(ramp 10, hold 30, discard 5)`.

  | 테스트 | 입력 | 기대 |
  |---|---|---|
  | `single_worker_on_second_boundary` | t0 = 100_000, 행 100..=139, completed | `range Some((115, 140))`, `Measured`, 추정 아님 |
  | `partial_second_at_start_is_dropped` | t0 = 100_400 | `range Some((116, 140))` — `lo = ceil(115.4)`, `hi = floor(140.4)` |
  | `zero_discard` / `zero_ramp` | `discard 0` / `ramp 0, discard 5` (t0 100_000) | `(110,140)` / `(105,130)` |
  | `two_workers_use_common_range` | w1 t0 100_000, w2 t0 102_300 | `Some((118, 140))` — `max lo`(w2 117.3→118), `min hi`(w1 140) |
  | `idle_worker_is_ignored` | `starts`에 w3(행 없음, t0 500_000) 추가 | 위와 같은 결과 |
  | `start_gap_larger_than_hold_is_no_common_window` | w1 t0 100_000, w2 t0 130_000, completed | `range None`, `NoCommonWindow` |
  | `completed_run_without_metric_in_last_second_is_measured` | t0 100_000, 행이 100..=136에만(마지막 3초 없음), completed | `Some((115,140))`, `Measured` (Review Focus 1) |
  | `aborted_mid_window_is_partial` | completed=false, `ended_at_ms Some(125_000)` | `Some((115,125))`, `Partial` |
  | `aborted_before_window_is_not_reached` | completed=false, `ended_at_ms Some(112_000)` | `None`, `NotReached` |
  | `aborted_run_with_one_worker_in_window_is_not_no_common_window` | w1 t0 100_000, w2 t0 111_000, completed=false, `ended_at_ms Some(118_000)` | `None`, `NotReached` (Review Focus 4) |
  | `aborted_without_ended_at_uses_last_metric_second` | completed=false, `ended_at_ms None`, 행 100..=124 | `Some((115,125))`, `Partial` |
  | `missing_start_is_estimated_from_first_metric` | `starts` 비움, 행 103..=139, completed | `t0_estimated`, t0 = 103_000 → `Some((118,140))`(hi는 `min(143, 마지막 행 139 + 1)`), `Measured` |
  | `estimated_hi_capped_at_last_metric_plus_one` | `starts` 비움, 행 103..=130, completed | `Some((118,131))`, `Measured` |
  | `garbage_start_times_do_not_panic` | 워커 하나씩 t0 = `i64::MAX` / `i64::MIN`, 그리고 두 워커가 각각 MAX·MIN | 세 경우 모두 패닉 없이 값을 돌려준다(`range` 값은 단언하지 않는다). 두 워커 경우만 `range None` |

- [ ] **Step 2: 실패 확인** — `cargo nextest run -p handicap-controller steady::window`(테스트를 `mod window_tests`에 둔다).

- [ ] **Step 3: 구현.** 포화 산술(`saturating_*`, `div_euclid`/`rem_euclid` — `stair.rs:564-575 measure_window`와 같은 방식)로:
  ```
  일한 워커 = rows에 나오는 worker_id 집합
  t0_w   = starts에서 찾음 | 없으면 그 워커 rows의 min(ts)·1000 (t0_estimated = true)
  lo_w   = ceil((t0_w + (ramp+discard)·1000) / 1000)
  plan_w = floor((t0_w + (ramp+hold)·1000) / 1000)
  end    = completed면 없음 | ended_at_ms | (전체 rows의 max(ts)+1)·1000
  hi_w   = min(plan_w, floor(end/1000))          // end가 있을 때만 자름
           추정 워커는 추가로 min(…, 그 워커 max(ts)+1)
  lo = max_w lo_w ; hi = min_w hi_w
  range = (lo < hi) ? Some((lo,hi)) : None
  state = completed ? (range ? Measured : NoCommonWindow)
                    : (range ? Partial  : NotReached)
  일한 워커가 없으면 range None, state = completed ? NoCommonWindow : NotReached
  ```

- [ ] **Step 4: 통과 확인** — 같은 명령 PASS.

- [ ] **Step 5: 커밋** — `feat(controller): 유지 구간 창 계산 — 워커 공통 구간·부분 초 제외·일찍 끝난 run (R4)`

---

### Task 4: `build_report`에 초 범위 넘기기 (R5·R7의 계산, spec D5·D6)

**Files:**
- Modify: `crates/controller/src/report.rs`(`build_report` `:512-1211`, `min_window_rps` `:323`, `ConnectionStats` `:193`·`PhaseStats` `:208`에 `Clone` derive), `crates/controller/src/insights.rs`, `build_report` 호출부 전부(`grep -rn "build_report(" crates/` — 프로덕션은 `api/runs.rs:1184` 하나, 나머지는 `report.rs` 인라인 테스트), `evaluate_criteria(` 호출부 전부(프로덕션 `report.rs:1012` 하나 + `report.rs` 테스트)
- Create: `testdata/report_whole_golden.json`(repo 루트 — 기존 골든과 같은 자리)
- Test: `crates/controller/src/report.rs` 인라인

**Interfaces:**
- Consumes: `OpenLoopTotal`(`store/open_loop.rs:88`), 기존 `derive_insights`·`refine_saturation_stall`·`derive_validity`.
- Produces:
  ```rust
  // report.rs
  /// 유지 구간 기준 리포트의 입력. `None`이면 지금과 같은 전체 구간 계산.
  pub struct SteadyScope<'a> {
      pub lo: i64,                 // ts_second 반열린 [lo, hi)
      pub hi: i64,
      /// run 시작부터 센 warmup에서 (ramp+discard)를 뺀 나머지(0 이상). min_window_rps에 쓴다.
      pub warmup_seconds: u32,
      /// open-loop의 창 안 계수. closed-loop면 None.
      pub open_loop: Option<ScopedOpenLoop<'a>>,
      /// 같은 run의 전체 구간 리포트 — 나눌 수 없는 값의 출처.
      pub whole: &'a ReportJson,
  }
  pub struct ScopedOpenLoop<'a> {
      /// 평평한 목표(iter/s). 예정 도착 수 = target × (hi − lo).
      pub target: u32,
      /// 창 안 버림 합. None = 초 단위 계수가 없는 워커가 섞여 다시 셀 수 없다(dropped_whole_run).
      pub dropped: Option<u64>,
      /// 창 안의 초별 합계(오름차순). dropped가 None이면 빈 슬라이스.
      pub totals: &'a [OpenLoopTotal],
  }
  pub fn build_report(/* 기존 13개 인자 */, scope: Option<&SteadyScope<'_>>) -> ReportJson;

  // insights.rs
  /// `whole`의 `load_gen_saturated` 인사이트를 `into`에 넣고 기존 발행 순서(order_rank)로 다시 정렬한다.
  pub(crate) fn adopt_whole_saturation(into: &mut Vec<Insight>, whole: &[Insight]);
  ```
  `scope = None`이면 결과가 지금과 **바이트 단위로 같다**.

**`scope = Some`일 때 달라지는 것(전부 — 이 목록 밖은 그대로):**

| 값 | 계산 |
|---|---|
| 행 반복문(`for r in rows`, `:662`) | `window_acc`(그림용 창) 누적은 모든 행. `overall`·`per_step`·`per_step_count`·`status_dist`·`total_count`·`total_errors`·`worker_acc` 누적은 `lo <= r.ts_second < hi`인 행만. 반복문은 하나로 유지한다. |
| `windows`(응답) | 모든 행(지금과 같다). |
| `duration_ms` | `(hi − lo) × 1000`. `duration_seconds = hi − lo`, `rps = total_count / (hi − lo)`. |
| `evaluate_criteria`·`derive_insights`에 넘기는 창 목록 | `windows`에서 `lo <= ts_second < hi`만 거른 목록(새 `Vec`가 아니라 연속 구간 슬라이스 — `windows`는 `(ts, step)` 오름차순이라 `partition_point` 두 번). |
| `min_window_rps`의 warmup | `scope.warmup_seconds` (`criteria.rps_warmup_seconds` 대신). `evaluate_criteria`에 `warmup_override: Option<u32>` 인자를 더한다. |
| `derive_insights`의 `dropped` | `open_loop.dropped.unwrap_or(0)`. closed-loop는 지금처럼 `run.dropped`(항상 0). |
| `derive_insights`의 `target_rps` | `open_loop.target`. |
| `derive_insights`의 `scheduled_arrivals` | `Some(target × (hi − lo))` — `scheduled_arrivals(..)`를 부르지 않는다. |
| `refine_saturation_stall` | `open_loop.totals`. |
| `open_loop.dropped == None`일 때 | 위 인사이트 계산 뒤 `adopt_whole_saturation(&mut insights, &whole.insights)`. `ReportJson.dropped = whole.dropped`. |
| `ReportJson.dropped` (그 밖) | `open_loop.dropped`가 `Some(d)`면 `d`, closed-loop면 `run.dropped`. |
| `connection` | `whole.connection`을 복제(창 안 `total_count`로 다시 계산하지 않는다). |
| 인사이트의 `onset_second`(「약 N초 지점부터」 — run 시작부터 센 초, `insights.rs:45`) | `derive_insights`는 넘겨받은 창의 첫 초부터 센다. 범위가 있으면 계산 뒤 `Some(n)`인 값에 `(범위 안 창 목록의 첫 ts_second) − (rows의 가장 이른 ts_second)`를 더한다(`lo`가 아니라 데이터가 있는 첫 초 — 인사이트가 세는 기준과 같다)(그림은 run 전체를 그리므로 같은 축이어야 한다). `adopt_whole_saturation`으로 가져온 인사이트에는 더하지 않는다. |
| `speed_bands`·`latency`·`steps`의 요청 수·오류·백분위·`worker_breakdown`·`verdict`·`validity`·`narrative` | 범위 안 누적값에서 지금 코드 그대로. |
| `steps[*].loop_breakdown`·`download`·`wait`·`loop_split`·`not_sent`, `if_breakdown`, `error_kinds`, `loop_exits`, `group_latency`, `active_vu_*`, `stair` | 손대지 않는다(입력이 초 단위가 아니라 두 기준에서 같은 값이 나온다). |

- [ ] **Step 0: `report.rs`를 고치기 전에 전체 구간 골든을 만든다(US4 잠금).** `report.rs` 인라인 테스트에 픽스처 `fn golden_inputs()`를 둔다 — 스텝 2개(`"a"`·`"b"`), 워커 2개, 초 100..=119, open-loop 프로필(`target_rps Some(10)`, `max_in_flight Some(5)`), `run.dropped = 30`, `criteria.max_p95_ms`, `loops`·`branches`·`groups`·`phases`(download·connect)·`error_kinds`·`open_loop_totals`가 전부 비어 있지 않다. 테스트 하나:
  - `fn whole_report_matches_golden()` 하나 — `stair_export_text_matches_golden`(`report.rs:4801`)과 같은 방식: 경로 `concat!(env!("CARGO_MANIFEST_DIR"), "/../../testdata/report_whole_golden.json")`, `got = serde_json::to_string_pretty(&build_report(..))`, 환경 변수 `REPORT_WHOLE_GOLDEN_UPDATE`가 있으면 `std::fs::write(path, format!("{got}\n"))`, 그 뒤 항상 `std::fs::read_to_string(path)`와 `assert_eq!(got, want.trim_end())`.
  - 파일은 실행 때 읽는다(`include_str!`을 쓰지 않는다 — 골든이 아직 없을 때 컴파일이 깨져 골든을 만들 수 없다).

  **지금 코드로** `REPORT_WHOLE_GOLDEN_UPDATE=1 cargo nextest run -p handicap-controller whole_report_matches_golden`을 한 번 돌려 골든을 만들고, 환경 변수 없이 다시 돌려 PASS하는지 본 뒤, 이 테스트와 골든만 먼저 커밋한다(`test(controller): 전체 구간 리포트 골든 — steady 도입 전 기준`). 이 뒤로는 골든을 다시 만들지 않는다 — 깨지면 구현을 고친다.

- [ ] **Step 1: 실패하는 테스트를 쓴다.** 픽스처 도우미 `fn rows_ramp_then_steady() -> Vec<WindowWithHdr>`: 스텝 `"a"`, 워커 `"w"`, 초 100..=109(상승)는 초당 2건·전부 500 ms·오류 1·status `{"500":1,"200":1}`, 초 110..=129(유지)는 초당 10건·20 ms·오류 0·`{"200":10}`. `run_row()`는 `started_at 100_000`, `ended_at 130_000`, `status Completed`. `fn scope(whole) -> SteadyScope`는 `lo 110, hi 130, warmup 0, open_loop None`.

  | 테스트 | 기대 |
  |---|---|
  | `whole_report_matches_golden`(Step 0) | 구현 뒤에도 PASS — `scope None` 결과가 이 task 전 코드와 같다. 기존 `build_report` 테스트 전부도 `, None` 인자만 더해 그대로 통과한다. |
  | `steady_summary_uses_window_only` | `summary.count == 200`, `duration_seconds == 20`, `rps == 10.0`, `errors == 0`, `p95_ms == 20`; 전체 구간은 `count 220`, `errors 10`, `p95_ms`가 100 이상 |
  | `steady_steps_and_status_use_window_only` | `steps[0].count == 200`, `error_count == 0`, `status_distribution == {"200":200}`; `latency`·`speed_bands`가 `Some` |
  | `steady_windows_keep_whole_run` | `windows.len() == 30`(100..=129) |
  | `steady_verdict_follows_window` | `criteria.max_p95_ms = Some(100)` → 유지 `verdict.passed == true`, 전체 `false`(전체 220건 가운데 느린 것 20건 = 9% > 5%). 반대 픽스처 `rows_fast_ramp_slow_steady()`(초 100..=109는 초당 100건·20 ms, 초 110..=129는 초당 1건·500 ms — 전체 1020건 가운데 느린 것 20건 = 2%)에서는 유지 `false`, 전체 `true` |
  | `steady_step_criterion_follows_window` | 스텝 기준 `{target:"a", metric:"error_rate", op:"max", threshold:0.01}` → 유지 통과, 전체 실패 |
  | `warmup_equal_to_ramp_removes_nothing_extra` | 전용 픽스처: 초 100..=129는 상승, 초 130..=149(20초)는 초당 10건. `scope{lo 130, hi 150, warmup_seconds 0}`, `criteria{min_window_rps Some(5.0), rps_warmup_seconds Some(30)}` → `min_window_rps` 기준 행이 **있고** `actual == 10.0`. `criteria`의 30을 창에 그대로 적용하면 `ts >= 160`이라 남는 초가 없어 행이 사라진다 (Review Focus 3) |
  | `warmup_larger_than_ramp_removes_the_difference` | `scope.warmup_seconds = 4`, 초 110..=113만 초당 1건인 픽스처 → `actual == 10.0`(`ts >= 110 + 4`만 남는다), `warmup_seconds = 0`이면 `1.0`(초 111..=113이 남는다) |
  | `steady_insights_do_not_read_the_ramp_boundary_as_onset` | 전용 픽스처 `rows_clean_ramp_bad_steady()`: 초 100..=114(15초)는 초당 10건·오류 0·`{"200":10}`, 초 115..=134(20초)는 초당 10건·오류 5·`{"500":5,"200":5}`. 전체 리포트에는 `midrun_error_onset`이 있고 `onset_second == Some(15)`(픽스처가 그 인사이트를 실제로 낸다는 것을 먼저 단언한다). `scope{lo 115, hi 135}` 리포트에는 `midrun_error_onset`이 **없다**(창 안은 처음부터 오류라 「실행 중에 시작」이 아니다) |
  | `steady_onset_second_counts_from_run_start` | 전용 픽스처: 초 100..=109 상승(깨끗), 초 110..=124 깨끗, 초 125..=139는 초당 10건·오류 5·`{"500":5,"200":5}`(이 인사이트는 status `"0"`·5xx만 센다). `scope{lo 110, hi 140}` 리포트의 `midrun_error_onset.onset_second == Some(25)`(창 시작 기준 15 + 10). 같은 픽스처에서 초 110..=111의 행을 빼면(창 안 첫 데이터 초 112) 여전히 `Some(25)`(13 + 12) |
  | `steady_open_loop_recounts_dropped` | `run.dropped = 50`, `open_loop Some{target 10, dropped Some(0), totals: 창 안 20초}` → `report.dropped == 0`, `load_gen_saturated` 없음 |
  | `steady_open_loop_dropped_whole_run_adopts_whole` | `open_loop.dropped = None`, `whole`에 `load_gen_saturated` 인사이트와 `dropped 50` → 유지 리포트 `dropped == 50`, 같은 인사이트가 (필드까지 `==`) 들어 있고 `validity.reasons`에 `load_not_delivered`가 `whole`과 같게 있다 |
  | `steady_connection_is_copied_from_whole` | `phases`에 `connect` 5건 → 두 리포트의 `connection`이 `==`이고 `reuse_ratio >= 0.0` |
  | `steady_unsplittable_step_fields_match_whole` | `loops`·`phases(download)`·`error_kinds(blank_var)` 픽스처 → 두 리포트의 `steps[0].loop_breakdown`·`download`·`not_sent`가 같다 |
  | `steady_multi_worker_breakdown_uses_window` | 워커 둘 → `worker_breakdown` 합 `count == 200` |

- [ ] **Step 2: 실패 확인** — `cargo nextest run -p handicap-controller report::tests::steady_` → 컴파일 에러(인자 수).

- [ ] **Step 3: 구현.** 위 표대로. `evaluate_criteria` 시그니처에 `warmup_override: Option<u32>`를 더하고 호출부(`report.rs` 프로덕션 1곳 + 테스트)를 고친다 — `grep -rn "evaluate_criteria(" crates/`로 전부 찾는다. `adopt_whole_saturation`은 `into`에 이미 `load_gen_saturated`가 있으면 지우고 `whole`의 것을 넣은 뒤 `order_rank`로 안정 정렬한다.

- [ ] **Step 4: 통과 확인.** `cargo build --workspace --tests`(모든 `build_report(` 호출에 `, None`) → `cargo nextest run -p handicap-controller` 전체 PASS(= `scope None` 불변). 

- [ ] **Step 5: 되돌려 확인.** 행 반복문의 범위 조건을 `true`로 바꿔 `steady_summary_uses_window_only`·`steady_verdict_follows_window`가 FAIL하는지 보고 원복. `connection` 복제를 지워 `steady_connection_is_copied_from_whole`이 FAIL하는지 보고 원복. `min_window_rps`가 `scope.warmup_seconds` 대신 `criteria.rps_warmup_seconds`를 쓰게 바꿔 `warmup_equal_to_ramp_removes_nothing_extra`가 FAIL하는지 보고 원복.

- [ ] **Step 6: 커밋** — `feat(controller): 리포트 계산에 초 범위 — 유지 구간 행만으로 요약·스텝·판정·인사이트 (R5·R7)`

---

### Task 5: 기준 선택·`basis` 블록·`?basis=`·판정 배지 (R5·R6·R7, spec D5–D7)

**Files:**
- Modify: `crates/controller/src/steady.rs`(`Basis`·`BasisBlock`), `crates/controller/src/report.rs`(`ReportJson.basis`), `crates/controller/src/api/runs.rs`(`build_report_for_run` `:1140`, `report` `:1205`, 내보내기 호출 `:1239,1254,1269,1284,1341`), `crates/controller/src/grpc/coordinator.rs:1440`
- Test: `crates/controller/tests/report_test.rs`, `crates/controller/src/grpc/coordinator.rs` 인라인, `crates/controller/src/export.rs`·`report.rs` 테스트의 `ReportJson` 리터럴(`basis: None`)

**Interfaces:**
- Consumes: `steady_window`(Task 3), `SteadyScope`·`ScopedOpenLoop`·`build_report(.., scope)`(Task 4), `open_loop::{worker_starts, open_loop_seconds, sum_by_second}`.
- Produces:
  ```rust
  // steady.rs
  #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
  #[serde(rename_all = "snake_case")]
  pub enum Basis { Steady, Whole }

  #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
  pub struct BasisWindow { pub start_ms: i64, pub end_ms: i64, pub measured_seconds: i64 }

  #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
  pub struct BasisOther {
      pub rps: f64, pub p50_ms: u64, pub p95_ms: u64, pub p99_ms: u64,
      pub error_rate: f64, pub count: u64, pub duration_seconds: i64,
  }

  #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
  pub struct BasisBlock {
      pub selected: Basis,
      pub default: Basis,
      pub state: BasisState,
      pub config: SteadyConfig,
      pub window: Option<BasisWindow>,   // skip 없음 → 없으면 JSON null
      pub t0_estimated: bool,
      pub dropped_whole_run: bool,
      pub other: Option<BasisOther>,     // skip 없음 → 없으면 JSON null
  }

  // report.rs — ReportJson 맨 끝
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub basis: Option<crate::steady::BasisBlock>,

  // api/runs.rs
  pub async fn build_report_for_run(
      db: &crate::store::Db,
      run_id: &str,
      basis: Option<crate::steady::Basis>,   // None = 기본 기준
  ) -> Result<crate::report::ReportJson, ApiError>;
  ```
  REST: `GET /api/runs/{id}/report?basis=steady|whole`. 값이 그 둘이 아니면 run 종류와 무관하게 400 `"basis는 steady 또는 whole이어야 합니다"`(run을 읽기 전에 판별). **유효한 값**은 `steady` 없는 run에서 무시한다(spec R6).

**`build_report_for_run` 흐름:**
1. `row.profile.steady`가 `None` → 지금 코드 그대로(`scope None`, `basis None`). `basis` 인자를 **무시**한다. 새 DB 조회 0.
2. `Some(cfg)` → 지금 읽는 것에 더해 `worker_starts`를 읽고, `row.profile.is_open_loop()`면 `open_loop_seconds`도 읽는다(`runs.dropped`가 0이어도). 전체 구간 리포트의 `open_loop_totals`는 `needs_open_loop_totals`일 때 이미 읽은 행의 `sum_by_second`로 만든다(같은 표를 두 번 조회하지 않는다 — 계단 run과 같은 방식).
3. `w = steady_window(cfg, row.status == Completed, row.ended_at, &rows, &starts)`.
4. `whole = build_report(.., None)`.
5. `w.range == Some((lo, hi))`이면 `steady = build_report(.., Some(&scope))`:
   - `warmup_seconds = criteria.rps_warmup_seconds.unwrap_or(0).saturating_sub(cfg.ramp_seconds + cfg.discard_seconds)`
   - open-loop면 `ScopedOpenLoop { target: cfg.target.or(row.profile.target_rps) 값, dropped, totals }`. `dropped`·`totals`는 `open_loop_seconds` 가운데 `lo <= ts_second < hi`인 행으로. **다시 셀 수 없는 경우** = `rows`에 나오는 워커 가운데 `open_loop_seconds`에 행이 하나도 없는 워커가 있다 → `dropped: None`, `totals: &[]`, 블록의 `dropped_whole_run = true`.
6. `default = Steady`(창 있음) / `Whole`(창 없음). `selected = 요청.unwrap_or(default)`, 창이 없으면 요청이 `Steady`여도 `Whole`.
7. 고른 리포트에 `basis = Some(BasisBlock{..})`를 붙여 돌려준다. `window = (lo·1000, hi·1000, hi−lo)`. `other` = 고르지 않은 쪽 리포트의 `summary`에서(`error_rate = count == 0 ? 0 : errors/count`), 창이 없으면 `None`.

**호출부의 기준:** `report` 핸들러 = 쿼리 값. `persist_verdict`(`coordinator.rs:1440`)·`report_csv`·`report_xlsx`·`report_insights_csv`·`report_stairs_csv`·`resolve_comparison` = `None`(기본 기준 — 슬라이스 A에서는 내보내기가 기준을 고르지 않는다, spec §3-1).

- [ ] **Step 1: 실패하는 통합 테스트를 쓴다** (`report_test.rs`, 기존 계단 테스트 `:282-380`의 DB 시드 방식 — `runs::insert` + `metrics::insert_batch` + `open_loop::insert_worker_start`/`insert_open_loop_seconds` — 을 쓴다). 시드 도우미 `seed_steady_closed(db) -> run_id`: 프로필 `vus 2, ramp_up_seconds 10, duration_seconds 40, steady{10,30,5}`, 시작 시각 `T0 = 1_700_000_000_000`, 메트릭은 Task 4 픽스처 모양(앞 15초 느림·오류, 뒤 25초 빠름), status `completed`.

  | 테스트 | 기대 |
  |---|---|
  | `steady_run_defaults_to_steady_basis` | `GET /report` → `basis.selected == "steady"`, `default == "steady"`, `state == "measured"`, `window.measured_seconds == 25`, `window.start_ms == T0 + 15_000`, `summary.duration_seconds == 25`, `basis.other.count`가 `summary.count`보다 크다 |
  | `basis_whole_param_returns_whole_report` | `?basis=whole` → `selected == "whole"`, `default == "steady"`, `summary.duration_seconds == 40`; `basis.other.duration_seconds == 25` |
  | `whole_basis_equals_report_without_steady` | 같은 메트릭·같은 시각으로 `steady`만 뺀 run을 하나 더 시드 → `?basis=whole` 응답에서 `basis` 키와 `run`을 뺀 나머지가 그 run 응답(`run` 제외)과 `==` |
  | `run_without_steady_has_no_basis_key` | `steady` 없는 run → 응답 객체에 `"basis"` 키가 **없다**(`as_object().contains_key`); `?basis=steady`를 붙인 응답 바이트가 안 붙인 것과 같다 (US4) |
  | `invalid_basis_param_is_400` | `steady` run과 `steady` 없는 run 둘 다 `?basis=x` → 400 |
  | `aborted_before_window_falls_back_to_whole` | status `aborted`, `ended_at = T0 + 8_000` → `?basis=steady`도 `selected == "whole"`, `default == "whole"`, `state == "not_reached"`, `window`가 `null`, `other`가 `null`(키는 있다) |
  | `aborted_mid_window_is_partial` | `ended_at = T0 + 25_000` → `state == "partial"`, `measured_seconds == 10`, `verdict` 키 없음(완료 run이 아니다) |
  | `start_time_missing_sets_estimated` | `run_worker_starts` 미시드 → `t0_estimated == true`, `state == "measured"` |
  | `open_loop_steady_recounts_dropped` | open-ramp 프로필(`normalize_steady` 통과), `runs.dropped = 30`, 초 단위 계수의 버림을 상승 구간 초에만 → 기본 리포트 `dropped == 0`, `basis.dropped_whole_run == false`; `?basis=whole`은 `dropped == 30` |
  | `open_loop_steady_without_second_counts_marks_whole_run` | 위에서 `run_open_loop_seconds` 미시드 → `dropped_whole_run == true`, `dropped == 30` |
  | `warmup_copied_from_ramp_is_not_subtracted_twice` | 전용 시드: `steady{ramp 30, hold 20, discard 0}`, `ramp_up_seconds 30`, `duration_seconds 50`, 50초 모두 메트릭, `criteria{min_window_rps: 1.0, rps_warmup_seconds: 30}` → 기본 리포트 `verdict.criteria`에 `min_window_rps` 행이 있다(창 20초에 30을 다시 빼면 행이 사라진다) |
  | `exports_use_default_basis` | `GET /report.csv` 본문의 스텝 `count`가 기본 리포트 `steps[0].count`와 같다 |

- [ ] **Step 2: 실패 확인** — `cargo nextest run -p handicap-controller --test report_test steady basis` → 컴파일 에러 또는 FAIL.

- [ ] **Step 3: 구현.** 타입 → `ReportJson.basis`(리터럴 사이트 전부 `basis: None` — `cargo build --workspace --tests`가 알려 준다; `testdata/compare_golden.json`은 `#[serde(default)]`라 고치지 않는다) → `build_report_for_run` → `report` 핸들러에 `axum::extract::Query<ReportParams>`(`#[derive(Deserialize)] struct ReportParams { basis: Option<String> }` — 문자열로 받아 직접 판별해 400 사유를 한국어로 낸다) → 호출부 6곳에 `None`.

- [ ] **Step 4: 판정 배지 테스트** (`coordinator.rs` 인라인, `finalize_failed_does_not_persist_verdict` `:2713` 옆, 그 테스트의 도우미를 쓴다) `persisted_verdict_follows_default_basis`: `steady` run에 「전체로는 p95 불합격·유지 구간으로는 합격」 메트릭과 `criteria.max_p95_ms`를 넣고 완료시킨다 → `runs::get(..).verdict`가 `passed == true`. 같은 메트릭에서 `steady`를 뺀 run은 `passed == false`.

- [ ] **Step 5: 통과 확인** — `cargo nextest run -p handicap-controller` 전체 + `cargo nextest run -p handicap-controller --features in-process` PASS(실행 테스트 수가 0이 아닌지 본다).

- [ ] **Step 6: 되돌려 확인.** `build_report_for_run`의 1번 분기(`steady None`)에서 일부러 `basis`를 붙이게 바꿔 `run_without_steady_has_no_basis_key`가 FAIL하는지 보고 원복. `warmup_seconds` 계산의 `saturating_sub`를 지워(= `rps_warmup_seconds` 그대로) `warmup_copied_from_ramp_is_not_subtracted_twice`가 FAIL하는지 보고 원복.

- [ ] **Step 7: 커밋** — `feat(controller): 기준별 리포트 — ?basis=, 기본 기준, basis 블록, 판정 배지 (R5·R6·R7)`

---

### Task 6: UI 스키마와 부하 모델 순수 함수 (R8·R11의 바탕)

**Files:**
- Modify: `ui/src/api/schemas.ts`(`ProfileSchema` `:293-336`, `ReportSchema` `:764-794`), `ui/src/components/run/loadModel.ts`
- Test: `ui/src/components/run/__tests__/loadModel.test.ts`, `ui/src/api/__tests__/`의 스키마 테스트(기존 `schemas` 테스트 파일에 더한다 — `ls ui/src/api/__tests__`로 이름 확인)

**Interfaces:**
- Produces:
  ```ts
  // schemas.ts
  export const SteadyConfigSchema = z.object({
    ramp_seconds: z.number().int().nonnegative(),
    hold_seconds: z.number().int().positive(),
    discard_seconds: z.number().int().nonnegative(),
    target: z.number().int().positive().optional(),   // 서버 skip_serializing_if → absent
  }).strict();
  export type SteadyConfig = z.infer<typeof SteadyConfigSchema>;
  // ProfileSchema: steady: SteadyConfigSchema.optional()

  export const ReportBasisSchema = z.object({
    selected: z.enum(["steady", "whole"]),
    default: z.enum(["steady", "whole"]),
    state: z.enum(["measured", "partial", "not_reached", "no_common_window"]),
    config: SteadyConfigSchema,
    window: z.object({ start_ms: z.number(), end_ms: z.number(), measured_seconds: z.number() }).strict().nullable(),
    t0_estimated: z.boolean(),
    dropped_whole_run: z.boolean(),
    other: z.object({
      rps: z.number(), p50_ms: z.number(), p95_ms: z.number(), p99_ms: z.number(),
      error_rate: z.number(), count: z.number(), duration_seconds: z.number(),
    }).strict().nullable(),
  }).strict();
  export type ReportBasis = z.infer<typeof ReportBasisSchema>;
  // ReportSchema: basis: ReportBasisSchema.optional()

  // loadModel.ts
  // LoadModelState에 `rampOpen: number`(도착률 고정의 상승 — VU 고정의 `rampUp`과 따로)와
  //   `discard: number`(두 고정 모드 공용) 추가.
  // LoadProfileFields의 Partial<Pick<…>>에 "steady" 추가.
  // LoadModelErrors에 `steadyInvalid: boolean` 추가.
  export type SteadyReason =
    | "ramp_ge_duration" | "hold_too_short" | "ramp_too_long" | "discard_too_long" | "hold_too_long";
  export type SteadyPlan =
    | { kind: "none" }                                   // 상승 0·버림 0 또는 고정 모드가 아님
    | { kind: "send"; steady: SteadyConfig }
    | { kind: "fallback"; reason: SteadyReason }         // VU 고정·버림 0: steady 없이 제출, 안내만
    | { kind: "error"; reason: SteadyReason };           // 제출 막음
  export function steadyPlan(s: LoadModelState): SteadyPlan;
  /** 고정 모드의 목표 도착률. open-loop가 아니면 null. */
  export function fixedTarget(p: { target_rps?: number | null; steady?: SteadyConfig | null }): number | null;
  /** 저장본 → 폼 칸. steady가 있으면 그 값이 이긴다. */
  export function steadyFormSeed(p: {
    duration_seconds: number; ramp_up_seconds?: number; target_rps?: number | null;
    steady?: SteadyConfig | null;
  }): { rampUp: number; rampOpen: number; duration: number; discard: number };
  ```
  `deriveLoadMode`의 인자 타입에 `steady?: SteadyConfig | null` 추가.

**상승 칸이 둘인 이유:** VU 고정의 상승 칸은 간단 모드에서도 보이고 도착률 고정의 상승 칸은 상세 모드에서만 보인다. 한 state를 같이 쓰면 간단 모드에서 VU 상승을 넣고 「도착률」로 바꾼 사용자가 보이지 않는 도착률 상승을 제출한다(spec D8 「도착률 기본값 0」·「숨은 설정이 조용히 제출되지 않게」). 아래에서 `ramp`는 `loadModel === "open" ? s.rampOpen : s.rampUp`이다.

**`steadyPlan` 규칙(spec D8):** `rateMode !== "fixed"` → `none`. `ramp === 0 && discard === 0` → `none`. 성립 조건을 이 순서로 검사해 처음 걸린 것을 이유로 한다: `ramp >= duration` → `ramp_ge_duration`; `duration − ramp − discard < 5` → `hold_too_short`; `ramp > 3600` → `ramp_too_long`; `discard > 3600` → `discard_too_long`; `duration − ramp > 86400` → `hold_too_long`. 걸렸을 때: `loadModel === "closed" && discard === 0` → `fallback`, 그 밖 → `error`. 안 걸리면 `send`, `steady = { ramp_seconds: ramp, hold_seconds: duration − ramp, discard_seconds: discard, ...(open && ramp > 0 ? { target: Number(targetRps) } : {}) }`.

`hold_too_long`은 spec D8의 목록에 없다 — 이 plan이 더했다. 서버는 `hold_seconds ≤ 86400`을 요구하는데(D2) 지금 서버는 VU 고정의 실행 시간에 상한을 두지 않는다. 이 조건이 없으면 상승이 있는 24시간 넘는 VU run이 400으로 깨진다(spec D8 「지금 통하는 설정을 깨지 않는다」).

**`steadyFormSeed`:** `steady`가 없으면 `{ rampUp: ramp_up_seconds ?? 0, rampOpen: 0, duration: duration_seconds, discard: 0 }`. 있으면 `duration = ramp_seconds + hold_seconds`, `discard = discard_seconds`, 그리고 open(`steady.target != null || target_rps != null`)이면 `rampOpen = ramp_seconds`·`rampUp = 0`, closed면 `rampUp = ramp_seconds`·`rampOpen = 0`.

**`buildLoadProfile` 고정 모드 두 arm(나머지 arm은 그대로):**
- open + fixed: `plan.kind === "send"`이고 `steady.target`이 있으면 `{ vus: 0, duration_seconds: 0, ramp_up_seconds: 0, max_in_flight, steady, …worker_count }`(`target_rps` **없음**). `send`인데 `target`이 없으면(버림만) 지금 모양 + `steady`. 그 밖은 지금 모양 그대로.
- closed + fixed: `send`면 지금 모양 + `steady`. 그 밖은 지금 모양 그대로.

**`loadModelErrors`:** `steadyInvalid = steadyPlan(s).kind === "error"`. 기존 `rampInvalid = s.rampUp > s.duration`은 그대로 둔다.

**`deriveLoadMode`:** `stair` 검사 다음, `vu_stages` 검사 앞에 `if (p.steady) return { loadModel: p.steady.target != null || p.target_rps != null ? "open" : "closed", rateMode: "fixed" };`

- [ ] **Step 1: 실패하는 테스트를 쓴다** (`loadModel.test.ts`; 기존 파일의 상태 도우미에 `discard: 0`을 더한다).

  | 테스트 | 기대 |
  |---|---|
  | `steadyPlan: 상승 0·버림 0 → none` (open·closed) | `{kind:"none"}`이고 `buildLoadProfile` 결과가 **이 task 전과 `toEqual`**(기존 byte-identical 테스트가 그대로 통과) + `not.toHaveProperty("steady")` |
  | `steadyPlan: open 고정 상승 20·버림 5·실행 60·목표 "40"` | `send`, `steady == {ramp_seconds:20, hold_seconds:40, discard_seconds:5, target:40}`; 프로필 `toEqual({vus:0, duration_seconds:0, ramp_up_seconds:0, max_in_flight:N, steady:{…}})`, `not.toHaveProperty("target_rps")`·`("stages")` |
  | `steadyPlan: open 고정 버림만(상승 0·버림 5·실행 60)` | `send`, `steady`에 `target` 키 없음; 프로필에 `target_rps: 40`, `duration_seconds: 60`, `steady` |
  | `steadyPlan: closed 상승 10·버림 5·실행 60` | 프로필 `vus`, `ramp_up_seconds: 10`, `duration_seconds: 60`, `steady {10,50,5}` |
  | `steadyPlan: closed 상승만인데 성립 안 함` — `it.each` (상승=실행 / 실행−상승 3초 / 상승 3601·실행 4000 / 상승 60·실행 90000) | `fallback` + 이유 각각 `ramp_ge_duration`/`hold_too_short`/`ramp_too_long`/`hold_too_long`; 프로필에 `steady` 없음이고 **이 task 전 모양과 `toEqual`**, `steadyInvalid === false` |
  | `steadyPlan: 두 상승 칸은 섞이지 않는다` | `rampUp: 10, rampOpen: 0, discard: 0`에서 `loadModel: "open"` → `none`(프로필에 `steady`·`stages` 없음); `rampUp: 0, rampOpen: 20`에서 `loadModel: "closed"` → `none`, `ramp_up_seconds: 0` |
  | `steadyPlan: 버림 > 0인데 성립 안 함` (closed) | `error`, `steadyInvalid === true` |
  | `steadyPlan: open 상승이 성립 안 함` | `error` |
  | `steadyPlan: 곡선·계단 모드` | `none` (칸 값이 남아 있어도) |
  | `deriveLoadMode: steady 저장본` — `it.each` 세 모양(open-ramp: `stages` 2개 + `steady.target` / open 버림만 / closed) | 각각 `{open,fixed}` / `{open,fixed}` / `{closed,fixed}` |
  | `fixedTarget` | `{target_rps:80}` → 80, `{steady:{…target:40}, stages:[…]}` → 40, closed → `null` |
  | `steadyFormSeed` | open-ramp 저장본(`duration_seconds:0`) → `{rampUp:0, rampOpen:20, duration:60, discard:5}`; closed 저장본 `steady{10,50,5}` → `{rampUp:10, rampOpen:0, duration:60, discard:5}`; `steady` 없음 → `{rampUp: ramp_up_seconds ?? 0, rampOpen: 0, duration: duration_seconds, discard: 0}` |
  | `prefill_roundtrip_keeps_steady` | 세 모양 각각: 서버가 정규화한 모양의 객체를 `ProfileSchema.parse` → `steady`가 남아 있다 → `deriveLoadMode`·`steadyFormSeed`·`fixedTarget`로 상태를 만들어 `buildLoadProfile` → 처음 UI가 보낸 모양과 `toEqual` (Review Focus 2) |

  스키마 테스트: `ReportSchema`가 `basis` 블록이 있는 리포트(`window: null`, `other: null` 포함 한 건, 값이 찬 한 건)를 통과시키고, `basis`가 없는 기존 픽스처도 그대로 통과한다. `ProfileSchema`가 `steady`를 버리지 않는다.

- [ ] **Step 2: 실패 확인** — `pnpm test loadModel` → FAIL(함수 없음).

- [ ] **Step 3: 구현.** `LoadModelState`를 만드는 두 곳(`RunDialog.tsx:463`, `ScheduleForm.tsx:221` 부근)에는 이 task에서 `rampOpen: 0, discard: 0`만 넣어 타입을 맞춘다(칸 배선은 Task 7). `LoadModelErrors` 리터럴을 직접 만드는 테스트(`grep -rn "stairInvalid" ui/src --include=*.tsx --include=*.ts`로 찾는다 — zsh에서는 패턴을 따옴표로 감싼다)에 `steadyInvalid: false`를 더한다. 이 task 뒤에도 VU 고정에서 상승 > 0이고 조건이 성립하면 페이로드에 `steady`가 붙는다 — 그 모양을 `toEqual`로 단언하던 기존 RunDialog·ScheduleForm 테스트가 깨지면 기대값에 `steady`를 더하고, 고친 테스트 이름을 보고서에 적는다(기대값을 느슨하게 바꾸지 않는다).

- [ ] **Step 4: 통과 확인** — `pnpm lint && pnpm test && pnpm build` 전부 통과.

- [ ] **Step 5: 커밋** — `feat(ui): steady·basis 스키마와 고정 부하의 상승·버림 페이로드 규칙`

---

### Task 7: 실행 대화상자·스케줄 폼의 칸 (R8, spec D8)

**Files:**
- Modify: `ui/src/components/run/LoadModelFields.tsx`, `ui/src/components/run/RunDialog.tsx`(state `:138-140`, `opensDetailed` `:197`, `loadPreset` `:324-347`, `loadState` `:463`, `canSubmit` `:489`), `ui/src/components/run/ScheduleForm.tsx`(state `:100-102`, `loadState` `:221`, 제출 가능 조건), `ui/src/i18n/ko.ts`
- Test: `ui/src/components/run/__tests__/LoadModelFields.test.tsx`, `RunDialog*.test.tsx`, `ScheduleForm*.test.tsx`(기존 파일 이름은 `ls ui/src/components/run/__tests__`로 확인)

**Interfaces:**
- Consumes: Task 6의 `steadyPlan`·`steadyFormSeed`·`fixedTarget`·`LoadModelErrors.steadyInvalid`.
- Produces: `LoadModelFields`에 **필수** prop `rampOpen: number`, `setRampOpen: (n: number) => void`, `discard: number`, `setDiscard: (n: number) => void`(마운트 사이트가 둘뿐이고 둘 다 넘긴다).

**문구(`ko.ts`, 정확한 글자 — 새 키는 `ko.loadModel` 아래):**

| 키 | 글자 |
|---|---|
| `rampSeconds` | `상승 시간(초)` |
| `discardSeconds` | `앞부분 버림(초)` |
| `discardHelp` | `목표 부하에 도달한 직후 몇 초는 불안정합니다. 그 초를 유지 구간 집계에서 뺍니다.` |
| `rampHelpOpen` | `처음부터 목표 도착률로 보내지 않고 0에서 목표까지 이 시간 동안 올립니다. 실행 시간에 포함됩니다.` |
| `rampHelpVuMax` | `VU 수가 상승 초보다 적으면 더 일찍 다 뜹니다 — 상승 시간은 최대값입니다.` |
| `discardRecommend` | `권장 5초` |
| `steadySummary(ramp, hold, measured)` | `` `상승 ${ramp}초 → 유지 ${hold}초 · 리포트 기본 기준은 뒤 ${measured}초` `` — `ramp === 0`이면 앞부분 없이 `` `유지 ${hold}초 · 리포트 기본 기준은 뒤 ${measured}초` `` |
| `steadyFallback` | `이 설정으로는 유지 구간을 잴 수 없어 리포트는 전체 구간 기준입니다` |
| `steadyReason.ramp_ge_duration` | `상승이 실행 시간과 같거나 깁니다` |
| `steadyReason.hold_too_short` | `상승 뒤 남는 시간이 5초보다 짧습니다` |
| `steadyReason.ramp_too_long` | `상승이 3600초를 넘습니다` |
| `steadyReason.discard_too_long` | `앞부분 버림이 3600초를 넘습니다` |
| `steadyReason.hold_too_long` | `상승 뒤 남는 시간이 24시간을 넘습니다` |
| `steadyError(reason)` | `` `유지 구간을 잴 수 없습니다 — ${reason}` `` |

기존 `ko.loadModel.rampUp`(「점진 시작(초)」)·`ko.glossary.rampUp`·`ko.validation.rampUp`은 고치지 않는다. VU 고정의 상승 칸 도움말에는 기존 `ko.glossary.rampUp` 뒤에 `rampHelpVuMax`를 `<span className="block">` 줄로 덧붙인다.

**화면 규칙:**
- **VU 고정**: 지금의 상승 칸은 그대로(위치·간단 모드에서도 보임). 그 아래 줄에 「앞부분 버림(초)」 칸 — `!simpleMode`일 때만.
- **도착률 고정**(`rateMode === "fixed"` arm, `:831` 부근): 실행 시간 칸 다음에 「상승 시간(초)」·「앞부분 버림(초)」 두 칸 — `!simpleMode`일 때만. 상승 칸은 `rampOpen` state를 쓴다(VU 고정의 `rampUp`과 따로 — Task 6).
- 두 칸은 `type="number" min={0}`, `numeric={numeric}`, `Field` + `HelpTip`(기존 상승 칸과 같은 모양).
- 지금 모드의 상승(`ramp`) > 0이고 `discard === 0`이면 버림 칸의 `Field` 힌트 자리에 `discardRecommend`. 자동으로 채우지 않는다.
- 칸 아래 한 줄(고정 모드, `steadyPlan`으로) — **간단 모드에서도 그린다**(상세 모드에서 넣은 버림·도착률 상승이 간단 모드로 돌아온 뒤에도 무엇이 제출되는지 보이게):
  - `send` → `steadySummary(ramp, duration − ramp, duration − ramp − discard)` (`text-sm text-slate-600`)
  - `fallback` → `steadyFallback` + ` — ` + 이유 (`role="status"`, `text-sm text-amber-800`)
  - `error` → `steadyError(이유)` (`role="alert"`, `text-sm text-red-600`), 해당 칸이 보이면 그 칸에 `aria-invalid`
  - `none` → 아무것도 없음
- 곡선·계단 모드에서는 새 칸·줄을 그리지 않는다.

**state·프리필:**
- `RunDialog`·`ScheduleForm`: `const seed = initial ? steadyFormSeed(initial.profile) : null`로 `rampUp`·`rampOpen`·`duration`·`discard` 초기값을 정한다(없으면 지금 기본값, `rampOpen`·`discard` 0). `targetRps` 초기값은 `fixedTarget(initial.profile)`이 `null`이 아니면 그 글자.
- `RunDialog.loadPreset`: 같은 seed로 `setRampUp`·`setRampOpen`·`setDuration`·`setDiscard`를 부르고, `if (prof.target_rps != null) setTargetRps(…)`를 `fixedTarget(prof)` 기준으로 바꾼다.
- `opensDetailed`에 `|| (profile.steady?.discard_seconds ?? 0) > 0 || (profile.steady?.target != null)`.
- `canSubmit`(두 폼): 고정 모드 가지에 `&& !loadErrs.steadyInvalid`.
- `RunDialog`의 「막힌 이유」 목록(`blockedReasons`, `:1150` 부근): `mode === "simple" && loadErrs.steadyInvalid`면 `steadyError(이유)`를 더한다(간단 모드에서는 오류가 난 칸이 안 보일 수 있다).
- `rpsWarmup` 자동 채움(`RunDialog.tsx:565-572`, `ScheduleForm.tsx:184`)은 고치지 않는다(spec D6이 서버에서 두 번 빼지 않게 처리).

- [ ] **Step 1: 실패하는 테스트를 쓴다.**

  `LoadModelFields.test.tsx`:
  | 테스트 | 기대 |
  |---|---|
  | `도착률 고정: 상세 모드에 상승·버림 칸` | `getByRole("spinbutton", {name: "상승 시간(초)"})`·`{name: "앞부분 버림(초)"}` 존재 |
  | `도착률 고정: 간단 모드에는 두 칸이 없다` | `simpleMode` → 둘 다 `queryByRole(…)` null |
  | `VU 고정: 간단 모드에 상승 칸은 있고 버림 칸은 없다` | 기존 상승 칸(`점진 시작(초)`) 존재, 버림 칸 null |
  | `곡선·계단: 새 칸이 없다` — `it.each` | 버림 칸 null |
  | `요약 줄` | open, 상승 30·실행 300·버림 5 → `getByText("상승 30초 → 유지 270초 · 리포트 기본 기준은 뒤 265초")` |
  | `fallback 안내는 간단 모드에서도 보인다` | closed, `simpleMode`, 상승 5·실행 5 → `getByRole("status")`에 `전체 구간 기준` + `상승이 실행 시간과 같거나 깁니다` |
  | `error 안내` | closed, 상승 0·버림 10·실행 12 → `getByRole("alert")`에 `상승 뒤 남는 시간이 5초보다 짧습니다`; 버림 칸 `aria-invalid="true"` |
  | `권장 5초 안내` | 상승 10·버림 0 → `권장 5초` 보임; 버림 5 → 안 보임; 버림 칸 값이 저절로 바뀌지 않는다 |

  `RunDialog` 테스트:
  | 테스트 | 기대 |
  |---|---|
  | `도착률 고정 + 상승 → steady 페이로드` | 상세 모드, 도착률 40·실행 60·상승 20·버림 5로 제출 → `createRun` 호출 본문의 `profile`에 `steady: {target:40, ramp_seconds:20, hold_seconds:40, discard_seconds:5}`, `duration_seconds: 0`, `target_rps` 키 없음 |
  | `기본 간단 프로필은 그대로` | 기존 `toEqual(DEFAULT_SIMPLE_PROFILE)` 테스트가 수정 없이 통과(US4) |
  | `error면 실행 버튼이 꺼진다` | 버림 10·실행 12 → 실행 버튼 `disabled` |
  | `VU 상승만·성립 안 함은 제출된다` | 상승 5·실행 5 → 버튼 활성, 제출 본문에 `steady` 없음, `ramp_up_seconds: 5` |
  | `간단 모드에서 VU 상승을 넣고 도착률로 바꿔도 도착률 상승은 0` | 간단 모드, VU 상승 10 입력 → 「도착률」 선택 → 제출 본문에 `steady`·`stages` 없음, `target_rps` 있음 |
  | `상세에서 넣은 버림은 간단 모드에서도 요약 줄로 보인다` | 상세 모드에서 버림 5(실행 60) → 간단 모드로 전환 → `유지 60초 · 리포트 기본 기준은 뒤 55초`가 보이고 `상승 0초`는 없다 |
  | `간단 모드에서 숨은 steady 오류는 막힌 이유에 뜬다` | 상세 모드 도착률 고정에서 상승 100·실행 60 → 간단 모드로 전환 → 버튼 `disabled`, 막힌 이유 목록에 `상승이 실행 시간과 같거나 깁니다` |
  | `steady 저장본 프리필` — open-ramp `initial`(서버 정규화 모양) | 모드 「도착률」+「고정」, 목표 칸 `40`, 실행 시간 `60`, 상승 `20`, 버림 `5`, 상세 모드로 열린다 |
  | `VU 상승만 있는 다시 실행은 지금처럼 간단 모드` | `steady {10,50,0}` closed → 간단 모드 |
  | `프리셋 불러오기가 steady 칸을 채운다` | open-ramp 프리셋 로드 → 위와 같은 칸 값 |

  `ScheduleForm` 테스트: `steady 저장본으로 열면 칸이 채워지고 그대로 저장하면 같은 steady가 나간다`.

- [ ] **Step 2: 실패 확인** — `pnpm test LoadModelFields`, `pnpm test RunDialog`, `pnpm test ScheduleForm`.

- [ ] **Step 3: 구현**(위 규칙).

- [ ] **Step 4: 통과 확인** — `pnpm lint && pnpm test && pnpm build`. 기존 RunDialog·ScheduleForm·LoadModelFields 테스트는 새 필수 prop을 넘기도록 렌더 도우미만 고친다(단언은 그대로 통과해야 한다 — Task 6에서 이미 고친 페이로드 기대값 말고 더 깨지는 단언이 있으면 구현을 의심한다).

- [ ] **Step 5: 커밋** — `feat(ui): 고정 부하에 상승 시간·앞부분 버림 칸 (R8)`

---

### Task 8: `steady` run을 「고정 + 상승·버림」으로 읽기 (R11, spec D9·F14)

**Files (전부 Modify):**

| 파일 | 지금 | 바꿈 |
|---|---|---|
| `ui/src/runs/profileSummary.ts:20-21` | `p.target_rps ?? 0` | `fixedTarget(p) ?? 0`; `steady`가 있으면 요약 끝에 `ko.runSummary.steadySuffix(ramp, discard)` |
| `ui/src/print/conditions.ts:45-46,90-91` | `rateMode`로 가른 뒤 `target_rps ?? 0` | `fixedTarget(profile) ?? 0` (모드 판별은 이미 `deriveLoadMode` 경유 — 그 사실을 `grep -n "deriveLoadMode" ui/src/print/conditions.ts`로 확인) |
| `ui/src/pages/RunDetailPage.tsx:516-540`(실행 중 프로필 목록) | `stages`가 있으면 곡선 줄, 아니면 `target_rps = …` | `deriveLoadMode(profile).rateMode === "fixed"`이고 open이면 지금 글자 그대로 `target_rps = {fixedTarget}/s` 줄(라벨은 바꾸지 않는다 — 기존 테스트가 `target_rps = 25/s`를 잠근다). `steady`가 있으면 open·closed 둘 다 상승·버림 줄 |
| `ui/src/components/report/ReportHeadline.tsx:22-30` | `profile.target_rps != null` → 고정 문장, `stages` → 곡선 문장 | `fixedTarget(profile)`이 `null`이 아니면 고정 문장(`targetRps: fixedTarget`) — 곡선 검사보다 먼저 |
| `ui/src/components/report/openLoopRates.ts:30-40` | `target_rps` 없고 `stages` 있으면 `curve = true` | 아래 「달성 도착률과 기준」 |
| `ui/src/components/report/Summary.tsx:26-28`(버림 비율) | `dropped / (dropped + summary.count)` | 아래 「`dropped_whole_run`의 분모」 |
| `ui/src/components/run/sizing.ts:185-200`(`pickLatestOpenRun`·`pickLatestFixedOpenRun`) | `stages` 유무로 open·곡선 판별 | 고정 판별을 `fixedTarget(p) != null`로(「고정 rate만」 고르는 함수가 `steady` run을 받아들인다) |
| `ui/src/components/run/WorkerSizingHelper.tsx:30-36` | `latest?.profile.target_rps ?? 0`, `dropped / summary.duration_seconds` | `latest ? fixedTarget(latest.profile) ?? 0 : 0`; 분모는 아래 「`dropped_whole_run`의 분모」 |
| `ui/src/print/compare/fairness.ts:110-120,133` | `NAMED_PROFILE_KEYS`에 `steady` 없음; `rateMode === "curve" ? p.stages : p.target_rps` | `NAMED_PROFILE_KEYS`에 `"steady"` 추가; 고정이면 `fixedTarget(p)` |
| `ui/src/runs/runFilterSort.ts` | `deriveLoadMode` 경유 | 코드 변경 없음 예상 — 테스트만 더한다 |

`ko.ts` 새 키: `ko.runSummary.steadySuffix = (ramp: number, discard: number) => ` 상승 ${ramp}초 · 버림 ${discard}초``(앞에 `· ` 구분자를 붙여 쓴다. 상승 0이면 `버림 N초`만, 버림 0이면 `상승 N초`만). `ko.runDetail.profileSteady = (ramp, discard) => `상승 ${ramp}초 · 앞부분 버림 ${discard}초``.

**달성 도착률과 기준(`openLoopRates`):** 도착률 고정 + 상승 run은 유지 구간 안에서만 목표가 평평하다. 전체 구간에는 상승이 섞여 「목표 − 버림 ÷ 기간」 식이 맞지 않는다(버림이 0이어도 실제 평균은 목표보다 낮다). 그래서:
- 시그니처에 다섯째 인자 `basis?: ReportBasis`를 더한다. `LooseProfile`에 `steady` 추가.
- `p.target_rps != null` → 지금처럼 고정(버림만 쓰는 `steady` run 포함 — 전체 구간도 평평하다).
- `p.steady?.target != null`이고 `basis?.selected === "steady"` → `target = steady.target`, `curve = false`.
- `p.steady?.target != null`이고 그 밖(전체 구간을 보고 있거나 `basis` 없음) → 지금의 곡선 가지(`target = stages 최대`, `curve = true`, 달성은 인사이트가 있을 때만).

**`dropped_whole_run`의 분모(spec D5 「창 안 요청 수와 run 전체 버림 수를 섞어 비율을 만들지 않는다」):** `basis.selected === "steady" && basis.dropped_whole_run`이면 리포트의 `dropped`는 run 전체 값이다(Task 4). 이때 버림에서 나오는 화면 계산은 분모도 전체 구간 값(`basis.other.count`·`basis.other.duration_seconds`)을 쓴다:
- `Summary`: optional prop `dropBase?: { count: number }`를 더하고 `ReportView`가 위 조건일 때 `{ count: basis.other.count }`를 넘긴다 → 버림 비율 = `dropped / (dropped + dropBase.count)`.
- `ReportView`가 `openLoopRates`에 넘기는 기간: 위 조건이면 `basis.other.duration_seconds`.
- `WorkerSizingHelper`(기본 기준 리포트를 읽는다): `report.data.basis?.selected === "steady" && basis.dropped_whole_run`이면 `duration = basis.other.duration_seconds`.
**단, 도착률 고정 + 상승 run(`steady.target` 있음)은 이 조건에서 「목표 − 버림 ÷ 기간」 식을 쓰지 않는다**(전체 구간에는 상승이 섞여 있다): `openLoopRates`의 달성은 인사이트 값만(없으면 `null`), `WorkerSizingHelper`는 앵커를 내지 않는다(`null`). 버림만 쓰는 run(`target_rps` 있음)은 위 분모로 식을 쓴다.
`basis.other`가 `null`이면(이 조건에서는 생기지 않는다 — 유지 구간이 선택됐으면 다른 기준이 있다) 지금 식 그대로.

**구현 전 전수 확인(이 task의 첫 스텝):** `cd ui && grep -rn "target_rps ?? \|\.stages\b" src | grep -v "__tests__\|\.test\.\|^src/api/schemas.ts"` 결과를 위 표와 대조한다. 표에 없는 줄 가운데 **저장된 프로필**을 읽어 「곡선」으로 가르는 줄이 있으면(폼 state `s.stages`·곡선 편집기는 해당 없음) 같은 방식으로 고치고 보고서에 적는다. `LoadShapePreview.tsx`·`runSummary.ts`는 폼 state(`rateMode`)로 그리므로 `steady` 저장본이 「고정」으로 프리필되면(Task 7) 고정 모양을 그린다 — 이 사실을 테스트 `steady_prefill_draws_fixed_shape`로 잠근다.

**Interfaces:** Consumes `fixedTarget`·`deriveLoadMode`·`ReportBasis`(Task 6). Produces `openLoopRates(profile, dropped, durationSeconds, insights, basis?)`, `Summary`의 optional prop `dropBase`.

- [ ] **Step 1: 위 전수 grep을 돌리고 표와 대조한다.**

- [ ] **Step 2: 실패하는 테스트를 쓴다.** 공용 픽스처(각 테스트 파일에 리터럴로): `STEADY_OPEN = { vus:0, duration_seconds:0, max_in_flight:50, stages:[{target:80,duration_seconds:30},{target:80,duration_seconds:270}], steady:{target:80, ramp_seconds:30, hold_seconds:270, discard_seconds:5} }`.

  묶음 이름 `steady_run_reads_as_fixed_everywhere`(Review Focus 5) — 파일마다 한 건씩:
  | 파일 | 기대 |
  |---|---|
  | `profileSummary` 테스트 | 글자에 `열린 80/s`가 있고 `열린 0/s`·`곡선`이 없으며 `상승 30초 · 버림 5초`로 끝난다 |
  | `print/__tests__/conditions` | 조건 줄에 `초당 80회`가 있고 `초당 0회`가 없다 |
  | `ReportHeadline` 테스트 | 고정 문장(`headlineOpenFixed`)이 렌더되고 숫자 `80`이 있다 — 곡선 문장의 고유 낱말이 없다 |
  | `openLoopRates` 테스트 | `basis.selected:"steady"` → `{target: 80, curve: false, achieved: 80 − dropped/duration}`; `selected:"whole"` 또는 `basis` 없음 → `{target: 80, curve: true, achieved: null}`(인사이트 없음); 버림만 쓰는 `steady` run(`target_rps: 80`)은 두 기준 모두 `curve: false` |
  | `Summary` 테스트 | `dropBase: {count: 1000}`, `dropped: 100`, `summary.count: 400` → 버림 비율 `9.1%`(100 ÷ 1100, `floorPct`는 소수 1자리); `dropBase` 없으면 `20.0%` |
  | `ReportView` 테스트 | `basis{selected:"steady", dropped_whole_run:true, other:{count:1000, duration_seconds:300, …}}` → 버림 비율 카드가 `other.count` 분모 값 |
  | `sizing` 테스트 | `pickLatestFixedOpenRun([steady run])`이 그 run을 돌려준다 |
  | `fairness` 테스트 | 두 run이 `steady`만 다를 때 「그 밖의 설정 다름」 줄이 생기지 않는다; 규모 칸에 `80` |
  | `runFilterSort` 테스트 | 모드 필터 「도착률」+「고정」에 걸린다 |
  | `RunDetailPage` 테스트(실행 중 프로필 목록) | `target_rps = 80/s` 줄과 `상승 30초 · 앞부분 버림 5초` 줄; 곡선 줄 없음 |
  | `WorkerSizingHelper` 테스트 | 지난 실행 목표가 80으로 계산에 들어간다(0이 아님); 지난 실행 리포트가 `dropped_whole_run`이면 버림만 쓰는 run은 달성률 분모가 `other.duration_seconds`, 도착률 고정 + 상승 run은 앵커 `null` |

  숫자 단언은 리터럴 글자(`"80"`)로 쓴다 — `ko.x(80)`끼리 비교하지 않는다(자기참조 단언).

- [ ] **Step 3: 실패 확인** — 해당 테스트 파일들 FAIL.

- [ ] **Step 4: 구현**(표대로).

- [ ] **Step 5: 통과 확인** — `pnpm lint && pnpm test && pnpm build`.

- [ ] **Step 6: 커밋** — `fix(ui): steady run을 고정 + 상승·버림으로 읽는다 — 요약·머리 문장·달성 도착률·사이징·조건 점검 (R11)`

---

### Task 9: 리포트 화면 — 기준 전환·기준 줄·표지·주소 (R9의 A 몫, spec D9)

**Files:**
- Create: `ui/src/components/report/BasisBar.tsx`
- Modify: `ui/src/api/client.ts:276`, `ui/src/api/hooks.ts:49,245`, `ui/src/pages/RunDetailPage.tsx:65,330`, `ui/src/components/report/ReportView.tsx`, `ui/src/components/ui/Segmented.tsx`(선택지별 `disabled`), 표지를 받는 컴포넌트(`ErrorKindTable`·`ConnectionCostCard`·`LoopExitSummary`·`LoopExitPanel`·`BranchStatsTable`·`GroupLatencyTable`·`StepPhaseBreakdown` → `StepStatsTable`·`Summary`), `ui/src/i18n/ko.ts`
- Test: `ui/src/components/report/__tests__/BasisBar.test.tsx`, `ReportView` 테스트, `StepStatsTable` 테스트, `ui/src/components/ui/__tests__/`의 `Segmented` 테스트, `ui/src/pages/__tests__/RunDetailPage*.test.tsx`, `ui/src/api/__tests__/hooks` 테스트

**Interfaces:**
- Consumes: `ReportBasis`(Task 6).
- Produces:
  ```ts
  // client.ts
  getRunReport: (id: string, basis?: "steady" | "whole") => …   // basis가 있으면 `?basis=`를 붙인다
  // hooks.ts
  queryKeys.runReport: (id: string, basis?: "steady" | "whole") => ["runs", id, "report", basis ?? "default"] as const
  export function useRunReport(id: string | undefined, terminal: boolean, basis?: "steady" | "whole")
  // BasisBar.tsx
  export function BasisBar(props: { basis: ReportBasis; onSelect: (b: "steady" | "whole") => void }): JSX.Element
  // ReportView.tsx
  type Props = { report: Report; profile: Profile; onSelectBasis?: (b: "steady" | "whole") => void };
  ```
  ```ts
  // Segmented.tsx — Option에 disabled 추가
  type Option<T extends string> = { value: T; label: string; disabled?: boolean };
  ```
  꺼진 선택지는 `disabled` + `aria-disabled="true"`, 클릭해도 `onChange`가 안 불리고, 방향키는 꺼진 선택지를 건너뛴다(켜진 선택지가 하나뿐이면 방향키는 아무것도 하지 않는다). `disabled`를 넘기지 않는 기존 사용처의 렌더는 그대로다.

  라벨 수정 뒤의 무효화(`hooks.ts:219`)는 `queryKeys.run(id)` = `["runs", id]` 접두사라 기준별 리포트 키까지 이미 닿는다 — 고칠 것이 없다. 사이징 도우미 3종·인쇄 화면은 `basis` 없이 부른다(기본 기준, spec D7·§3-1).

**문구(`ko.report.basis` 아래, 정확한 글자):**

| 키 | 글자 |
|---|---|
| `switchAria` | `집계 기준` |
| `steady` / `whole` | `유지 구간` / `전체 구간` |
| `lineSteady(from, to, secs, ramp, discard)` | `` `유지 구간 · ${from}–${to} (${secs}초) · ${exclude} 제외` `` — `exclude`는 상승·버림 가운데 0이 아닌 것만 `상승 30초·버림 5초`로 잇는다 |
| `lineWhole(ramp)` | `` `전체 구간 · 상승 ${ramp}초 포함` `` (상승 0이면 `전체 구간`) |
| `partial(planned, got)` | `` `일찍 끝남 — 계획 ${planned}초 중 ${got}초` `` |
| `estimated` | `시작 시각 추정` |
| `notReached` | `유지 구간에 닿기 전에 끝나 전체 구간만 볼 수 있습니다` |
| `noCommonWindow` | `워커 시작 시각 차이가 커서 공통 유지 구간이 없습니다 — 전체 구간만 볼 수 있습니다` |
| `otherLine(label, rps, p95, errPct)` | `` `${label}: 초당 요청 ${rps} · p95 ${p95} ms · 오류 ${errPct}` `` |
| `wholeBadge` | `전체 구간` |
| `wholeBadgeHelp` | `이 값은 초 단위로 저장되지 않아 유지 구간만 따로 셀 수 없습니다. run 전체 값입니다.` |
| `rampOnlyLine(ramp)` | `` `상승 ${ramp}초 포함 전체 구간 값` `` |
| `latencyNote` | `응답 시간은 응답이 끝난 초에 기록됩니다. 상승 끝에 보낸 느린 요청은 유지 구간 첫 초들에 들어갈 수 있어 앞부분 버림으로 뺍니다.` |

`partial`의 `planned` = `config.hold_seconds − config.discard_seconds`, `got` = `window.measured_seconds`. 시각은 `HH:MM:SS`(로컬, `window.start_ms`·`end_ms`). `otherLine`의 숫자: `rps` 소수 1자리, 오류율은 기존 `floorPct`.

**`BasisBar` 모양:** `ui/src/components/ui/Segmented.tsx`(`role="radiogroup"`, `aria-label={switchAria}`)로 두 선택지. `state`가 `not_reached`·`no_common_window`면 「유지 구간」 선택지를 `disabled`로 하고 그 아래 안내 줄(`role="status"`). 전환 아래 기준 줄(`text-sm text-slate-700`) — `selected`에 따라 `lineSteady`/`lineWhole`, `partial`이면 ` · ` + `partial(..)`, `t0_estimated`면 ` · ` + `estimated`. 그 옆(좁으면 아래 줄) 참고 줄 `otherLine`(`text-sm text-slate-500`, `other`가 `null`이면 없음) — 유지 구간을 볼 때 `label`은 「전체 구간」, 반대는 「유지 구간」. 기준 줄 끝에 `HelpTip`으로 `latencyNote`. 긴 줄은 줄바꿈을 허용한다(`flex-wrap`, `truncate` 금지).

**`ReportView` 배치:** `report.basis`가 있으면 `ReportHeadline` **위**에 `BasisBar`. `report.basis`가 없고 `deriveLoadMode(profile)`이 `{closed, fixed}`이며 `profile.ramp_up_seconds > 0`이면 `Summary` 바로 위에 `rampOnlyLine(profile.ramp_up_seconds)` 한 줄(`text-sm text-slate-500`).

**「전체 구간」 표지:** `report.basis?.selected === "steady"`일 때만. 작은 배지(`ui/src/components/ui/Badge.tsx`) + `HelpTip(wholeBadgeHelp)`를 **제목의 형제**로 둔다(제목 요소 안에 넣지 않는다 — 접근명 오염).
- 표 머리: 오류 종류(`ErrorKindTable`), 연결 비용(`ConnectionCostCard`), 조건 반복 종료(`LoopExitSummary`·`LoopExitPanel`), 분기(`BranchStatsTable`), 묶음 지연(`GroupLatencyTable`).
- 스텝 표의 하위 줄: 반복 횟수별 집계, 다운로드·대기 단계, 조건 반복 응답 분리, 「보내지 않음」 — 각 하위 줄 제목(또는 열 머리) 옆. `ReportView`는 스텝 표를 `StepPhaseBreakdown`(`ReportView.tsx:257`)을 거쳐 그리므로 prop을 `StepPhaseBreakdown` → `StepStatsTable`(두 렌더 가지 `:43`·`:77` 모두)로 내려보낸다. 하위 줄이 실제로 그려지는 파일은 `grep -n "loop_breakdown\|download\|wait\|loop_split\|not_sent" ui/src/components/report/StepStatsTable.tsx ui/src/components/report/StepPhaseBreakdown.tsx`로 확인한다.
- `basis.dropped_whole_run`이면 `Summary`의 버림 수·버림 비율·달성 도착률 카드 옆.
각 컴포넌트에 optional prop `wholeRunBadge?: boolean`을 더한다(미전달 = 지금과 같은 렌더).

**`RunDetailPage` 주소:** `useSearchParams`로 `basis`를 읽는다 — 값이 `"steady"`/`"whole"`이 아니면 없는 것으로 본다. `useRunReport(id, terminal, basis)`. `onSelectBasis(b)`: `b === report.basis.default`면 주소에서 `basis`를 지우고, 아니면 `basis=b`로 `setSearchParams(.., { replace: true })`. 전환 중(새 기준 리포트를 받는 동안)에는 **같은 run의** 이전 기준 리포트를 그대로 보여 준다: `hooks.ts`에 순수 함수 `export function sameRunPlaceholder(id: string | undefined) { return <T,>(prev: T | undefined, prevQuery: { queryKey: readonly unknown[] } | undefined) => (prevQuery?.queryKey[1] === id ? prev : undefined); }`를 두고 `useRunReport`가 `placeholderData: sameRunPlaceholder(id)`로 쓴다. `keepPreviousData`를 그대로 쓰지 않는다 — 이 훅은 인쇄 화면·사이징 도우미도 쓰고, run A에서 B로 넘어갈 때 A의 리포트가 B 머리 아래에 잠깐 그려진다.

- [ ] **Step 1: 실패하는 테스트를 쓴다.**

  `BasisBar.test.tsx`(픽스처 `B = {selected:"steady", default:"steady", state:"measured", config:{ramp_seconds:30, hold_seconds:270, discard_seconds:5}, window:{start_ms, end_ms, measured_seconds:265}, t0_estimated:false, dropped_whole_run:false, other:{rps:71.24, p50_ms:20, p95_ms:48, p99_ms:90, error_rate:0.003, count:21372, duration_seconds:300}}`):
  | 테스트 | 기대 |
  |---|---|
  | `전환은 radiogroup이고 지금 기준이 선택돼 있다` | `getByRole("radiogroup", {name:"집계 기준"})`; 「유지 구간」 `aria-checked="true"` |
  | `다른 기준을 누르면 onSelect` | 「전체 구간」 클릭 → `onSelect("whole")` 1회 |
  | `유지 구간 기준 줄` | 글자에 `(265초)`·`상승 30초·버림 5초 제외`가 있다(리터럴) |
  | `전체 구간 기준 줄` | `selected:"whole"` → `전체 구간 · 상승 30초 포함` |
  | `참고 줄` | `전체 구간: 초당 요청 71.2 · p95 48 ms · 오류 0.3%` |
  | `partial` | `state:"partial"`, `measured_seconds:120` → `일찍 끝남 — 계획 265초 중 120초` |
  | `추정` | `t0_estimated:true` → `시작 시각 추정` |
  | `not_reached` | 「유지 구간」 선택지 `disabled`; `getByRole("status")`에 `유지 구간에 닿기 전에 끝나` |
  | `no_common_window` | `disabled` + `워커 시작 시각 차이가 커서` |
  | `버림만 있는 설정` | `ramp_seconds:0` → 기준 줄에 `버림 5초 제외`만, `상승` 낱말 없음 |

  `ReportView` 테스트:
  | 테스트 | 기대 |
  |---|---|
  | `basis 없는 리포트에는 전환이 없다` | `queryByRole("radiogroup", {name:"집계 기준"})` null (US4) |
  | `유지 구간 리포트의 나눌 수 없는 표에 표지` | 오류 종류·연결 비용 구역 `within(..)`에 `전체 구간` 배지; `selected:"whole"`이면 배지 0개 |
  | `표지는 제목 접근명에 섞이지 않는다` | 오류 종류 제목 요소의 `textContent`에 `전체 구간`이 없다 |
  | `스텝 표 하위 줄에 표지`(`StepStatsTable` 테스트 + `ReportView` 경유 한 건) | `loop_breakdown`이 있는 스텝, `wholeRunBadge` → 반복 횟수별 집계 줄 `within(..)`에 `전체 구간` 배지; prop 없으면 0개. `ReportView`에 `basis.selected:"steady"` 리포트를 넣으면 같은 배지가 보인다(`StepPhaseBreakdown`을 거쳐 내려갔다는 증명) |
  | `dropped_whole_run이면 버림 수 옆 표지` | `Summary` 구역에 배지 |
  | `steady 없는 상승 run의 한 줄` | `basis` 없음 + `ramp_up_seconds:10` closed → `상승 10초 포함 전체 구간 값`; 상승 0이면 없음; open-loop 곡선이면 없음 |

  `RunDetailPage` 테스트(`createMemoryRouter`/기존 렌더 도우미, `fetch` 모킹은 URL로 가른다):
  | 테스트 | 기대 |
  |---|---|
  | `주소의 basis=whole로 열면 그 기준을 받는다` | `/runs/R?basis=whole` → `…/report?basis=whole` 요청 |
  | `전환하면 주소가 바뀌고 새 기준을 받는다` | 「전체 구간」 클릭 → 주소에 `basis=whole`, `?basis=whole` 요청 1회 |
  | `기본 기준으로 돌아오면 주소에서 사라진다` | 다시 「유지 구간」 → 주소에 `basis` 없음 |
  | `잘못된 basis 값은 무시한다` | `?basis=x` → `/report`(파라미터 없음) 요청 |

  `hooks` 테스트: `queryKeys.runReport("R")`과 `("R","whole")`가 다르고 둘 다 `["runs","R","report"]`로 시작한다. `sameRunPlaceholder("R")`(새 테스트 파일 `ui/src/api/__tests__/hooks.test.ts`에서 직접 부른다): 같은 id에서 기준만 바뀌면 이전 데이터를 돌려주고, id가 바뀌면 `undefined`.

  `Segmented` 테스트: 꺼진 선택지는 `disabled`이고 클릭해도 `onChange` 0회; 선택지 셋 가운데 가운데가 꺼져 있으면 `ArrowRight`가 첫째에서 셋째로 간다; 켜진 것이 하나뿐이면 방향키에 `onChange` 0회; `disabled` 없는 기존 테스트는 그대로 통과.

- [ ] **Step 2: 실패 확인** — `pnpm test BasisBar`, `pnpm test ReportView`, `pnpm test RunDetailPage`.

- [ ] **Step 3: 구현**(위 규칙).

- [ ] **Step 4: 통과 확인** — `pnpm lint && pnpm test && pnpm build`. `find ui/src -name '*.test.ts*' | grep -v __tests__` 출력 0.

- [ ] **Step 5: 실제 응답으로 스키마 확인(커밋하지 않는 임시 테스트).** 워크트리 바이너리(`cargo build -p handicap-worker && cargo build -p handicap-controller --bin controller`)로 컨트롤러를 띄우고 `steady` run 하나를 curl로 만든다(open-ramp, 실행 30초 안쪽). 끝나면 `GET /report`와 `?basis=whole` 응답을 스크래치패드에 저장 → `ui/src/api/__tests__/`에 임시 테스트로 `ReportSchema.safeParse`가 둘 다 통과하는지 본다(`null` 필드 포함) → 임시 테스트 삭제. 포트는 `lsof`로 비었는지 확인하고 8080이 남의 것이면 `--rest 127.0.0.1:8099 --grpc 127.0.0.1:8098`.

- [ ] **Step 6: 커밋** — `feat(ui): 리포트 기준 전환·기준 줄·전체 구간 표지 (R9)`

---

## 구현 뒤 (plan 밖, 슬라이스 파이프라인 4–6단계)

- 최종 리뷰 `handicap-reviewer`(와이어 1:1 — `SteadyConfig`·`BasisBlock` ↔ Zod, 초점: 「`build_report` 인자 추가로 옛 동작에 기대던 호출부」·`closed-loop 시작 시각을 새로 받게 된 컨트롤러 소비자`). 보안 게이트는 `/finish-slice` §0 grep으로 판단.
- 라이브 검증 = spec §5 「라이브」 표의 US1–US4(US5는 슬라이스 B). US1의 「오른 뒤 유지」는 시계열 그림 모양으로 본다. 극단값: 상승 3600초 문구·긴 기준 줄(추정 + 일찍 끝남 + 참고 줄이 다 붙은 경우)이 리포트 폭을 넘지 않는지 rect로, 여러 워커 run의 창. 진입 화면: 실행 대화상자(새 run·다시 실행·프리셋)·스케줄 폼·run 상세(주소 직접 진입 포함).
- 슬라이스 A와 B 사이에는 릴리즈하지 않는다. A 머지 때 roadmap §B에 spec §6 비용·한계와 이 plan의 판단을 옮긴다. ADR-0061은 B 마무리 때. 옮길 판단:
  - Task 2 STOP 결과(F2b가 재현됐는지).
  - closed-loop 고정 run마다 `run_worker_starts` 1행이 생기고, `steady` 여부와 무관하게 메트릭 배치마다 `INSERT OR IGNORE` 한 번이 더 돈다(open-loop가 이미 하던 것과 같은 비용).
  - `steady` run의 리포트 계산이 두 번 돈다(두 기준 + 참고 줄).
  - UI가 `hold_too_long`(상승 뒤 24시간 초과) 조건을 spec D8 목록에 더했다.
  - 도착률 고정 + 상승 run의 전체 구간 리포트는 달성 도착률을 곡선 방식(포화 인사이트가 있을 때만)으로 보인다.
  - 유지 구간 밖에서만 실행된 스텝은 유지 구간 리포트의 스텝 표에 없다(그 스텝의 반복·다운로드·「보내지 않음」 줄도 함께 빠진다). 반복이 유지 구간보다 긴 시나리오에서는 「요청 없는 스텝」 인사이트가 뜰 수 있다 — 해소: 스텝 표에 전체 구간에만 있는 스텝을 0건 행으로 넣는다.
  - 슬라이스 A와 B 사이에는 비교 보고서 조건 점검이 상승·버림만 다른 두 run의 차이를 보이지 않는다(`NAMED_PROFILE_KEYS`에 `steady`를 넣었고 「집계 기준」 줄은 B).
