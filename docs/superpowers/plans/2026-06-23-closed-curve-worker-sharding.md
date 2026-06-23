# closed-loop VU 곡선 비-풀 fan-out 샤딩 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

<!-- REVIEW-GATE: APPROVED -->

**Goal:** 비-풀 closed-loop VU 곡선(`vu_stages`)이 fixed-VU와 동일하게 capacity-derived fan-out(`N=ceil(peak/capacity)`)으로 워커에 샤딩되게 한다 (현재는 N=1 단일워커 강제).

**Architecture:** 컨트롤러 한 곳만 — vu_curve의 워커 수 `N`을 하드코드 `1` 대신 `worker_count(peak, capacity)`로 도출하고(validate·spawn 두 사이트를 공유 헬퍼 `fanout_worker_count`로 단일화), `peak>capacity` 단일워커 거부를 제거한다. 샤딩 자체(`reduce_pool_profile` 곡선+`None` 분기 = 각 stage `shard_split` 균등 분배)·`total_vus=peak`·active-VU worker_id 머지는 L5가 깔아 둔 것을 **그대로 재사용**(무변경). 엔진·proto·migration·워커·UI 0 diff.

**Tech Stack:** Rust (`crates/controller`), `crate::store::runs::Profile`, `crate::grpc::shard::{worker_count, shard_split}`, nextest.

**Spec:** `docs/superpowers/specs/2026-06-23-closed-curve-worker-sharding-design.md`

## Global Constraints

- **proto / migration / engine / worker / UI(ui/) = 0 diff.** 머지 diff는 `crates/controller/` + docs 한정. (spec §5·R6)
- **byte-identical**: peak≤capacity 곡선(N=1)·풀 모드 곡선(L5)·fixed-VU·open-loop·비-곡선 run. (R6)
- **N 상한 없음** (fixed-VU 매치), **UI 없음** (silent capacity-derived fan-out), **409/force 없음** (비-풀은 capacity-shortage 개념 없음·총량 보존). (spec §5·R8)
- `Profile`은 `crate::store::runs::Profile` (runs.rs 내 `use crate::store::runs::{self, Profile, RunStatus}`). `Default` 미derive — 테스트는 헬퍼(`curve_profile`/`ol_profile`/`unique_profile`)로 구성.

---

## Requirement Coverage (R-id → Task)

| R-id | 요구사항 (요약) | 담당 Task | seam? |
|---|---|---|---|
| R1 | vu_curve N: `1`→`worker_count(peak,cap)` (validate 434 + spawn 691) | Task 1 | |
| R2 | 단일워커 거부(258-264) 제거 | Task 1 | |
| R3 | per-worker vu_stages 샤딩 = `reduce_pool_profile` 곡선+None 재사용(무변경) | Task 1 (단위) | |
| R4 | validate-N==dispatch-N==unique-floor-N (공유 헬퍼·floor가 새 N 봄) | Task 1 | |
| R5 | peak stage==vu_count·offset disjoint·sub-peak 0-share park | Task 1 (단위) | |
| R6 | byte-identical (N=1·풀·fixed·open) + proto/migration/engine/worker/UI 0 | Task 1 (게이트) | |
| R7 | active-VU N>1 머지 재사용 (migration 0018·SUM read·무변경) | Task 1 (라이브) | ✅ (재사용·신규 0) |
| R8 | 신규 외부 노출 0 (409/force 없음·worker_id 미노출) | Task 1 (보안) | |
| R9 | e2e_kind_driver 단일 run→곡선 (워크플로 Indexed N=2 단언이 검증) | Task 2 | |

- `seam ✅`은 R7뿐이고 **L5 재사용(신규 와이어 0)** — 계약-먼저 배치 불요. Task 1이 핵심 계약(N 의미)을 한 커밋에 담는다.

---

## File Structure

| 파일 | 책임 | 변경 |
|---|---|---|
| `crates/controller/src/api/runs.rs` | run 검증·발사·N 도출 | `fanout_worker_count` 헬퍼 추가, 두 N 사이트(434·691) 헬퍼 호출로 교체, 거부(250+258-264) 제거, 단위/통합 테스트 추가·1개 flip |
| `crates/controller/src/grpc/coordinator.rs` | 샤딩(`reduce_pool_profile`) | **production 무변경** — R3/R5 인라인 단위테스트만 추가 |
| `crates/controller/src/bin/e2e_kind_driver.rs` | kind 호스트 드라이버 | 단일 run profile `vus:50`→`vu_stages` (R9) |

**무변경(명시)**: 엔진·proto·migration(0018 재사용)·워커·UI(ui/)·Zod·`reduce_pool_profile` 본문/시그니처·register·`assignment_for`·`enqueue`·`dispatch`·active-VU read/ingest. (spec §5)

**TDD 가드 메모**: 두 파일 다 이미 인라인 `#[cfg(test)] mod tests`가 있어 `tdd-guard` 자동통과(디스크에 `#[cfg(test)]` 존재). 새 `tests/*.rs`·keepalive stub 불요. e2e_kind_driver.rs는 bin이라 인라인 테스트 없지만 그 한 줄 변경은 Task 1 테스트가 깔린 뒤 진행(또는 주석/리터럴 변경은 tdd-guard 내용예외).

**커밋 경계 메모**: Task 1은 **단일 green 커밋** — 추출 헬퍼는 즉시 양 사이트가 호출하므로 dead_code 아님이고, 거부 제거로 `validate_vu_curve_nonpool_rejects`가 RED가 되니 그 flip을 같은 커밋에 fold(prod+test 분리 커밋 불가, spec §8). Task 2는 별 커밋(또는 Task 1에 fold 가능).

---

## Task 1: 컨트롤러 vu_curve fan-out N + 거부 제거 + 테스트

**충족 R:** `R1, R2, R3, R4, R5, R6, R7, R8`
**Files:**
- Modify: `crates/controller/src/api/runs.rs` — 헬퍼 + 두 N 사이트 + 거부 제거 + 테스트
- Modify: `crates/controller/src/grpc/coordinator.rs` — R3/R5 인라인 단위테스트(production 무변경)

- [ ] **Step 1: `fanout_worker_count` 헬퍼 추가**
  `crates/controller/src/api/runs.rs`의 `validate_run_config`(191) **바로 앞**(또는 `leading_idle_secs`/`startup_grace_eff` 류 free 헬퍼 근처)에 모듈-레벨 `fn` 추가:
  ```rust
  /// Non-pool fan-out worker count N, shared by validate_run_config (unique-floor, R4)
  /// and spawn_run (dispatch) so they can never drift. A closed-loop VU curve fans out
  /// on its peak VU exactly as a fixed-VU run fans out on `vus` (R1).
  fn fanout_worker_count(profile: &Profile, capacity: u32) -> u32 {
      if profile.is_vu_curve() {
          crate::grpc::shard::worker_count(profile.vu_curve_max(), capacity)
      } else if profile.is_open_loop() {
          profile.worker_count.unwrap_or(1)
      } else {
          crate::grpc::shard::worker_count(profile.vus, capacity)
      }
  }
  ```
  **Acceptance (R1):** 헬퍼가 vu_curve에 대해 `worker_count(vu_curve_max(), capacity)`를 반환(fixed-VU 동일 수식). open/closed arm은 종전 로직 보존.

- [ ] **Step 2: validate N 사이트(434-440)를 헬퍼 호출로 교체**
  `validate_run_config` 안의 다음 블록(434-440)을:
  ```rust
      let n = if profile.is_vu_curve() {
          1 // 단일 워커 v1 (curve: 검증 ⑦이 capacity 이내 보장)
      } else if profile.is_open_loop() {
          profile.worker_count.unwrap_or(1)
      } else {
          crate::grpc::shard::worker_count(profile.vus, state.settings.worker_capacity_vus())
      };
  ```
  로 교체:
  ```rust
      let n = fanout_worker_count(profile, state.settings.worker_capacity_vus());
  ```
  (위 주석 `// Worker count — only consumed by the Unique row-count check below; hoisted so it's computed once.`는 유지.)
  **Acceptance (R4):** unique floor(runs.rs:470 `rows >= n`)가 이제 vu_curve에서 `ceil(peak/cap)`를 본다(헬퍼 단일 소스).

- [ ] **Step 3: spawn_run N 사이트(691-697)를 헬퍼 호출로 교체**
  `spawn_run` 안의 동일 3-way `if`(691-697, 위 `// vu-curve is single-worker v1 …` 주석 포함 5줄)를:
  ```rust
      let n = fanout_worker_count(profile, state.settings.worker_capacity_vus());
  ```
  로 교체(앞의 `// vu-curve is single-worker v1 (검증 ⑦이 capacity 이내 보장, spec §9).` 주석은 삭제 — 더 이상 사실 아님). `total_vus`(701-707)·`enqueue`(852)·`dispatch`(871) 무변경.
  **Acceptance (R1):** dispatch-N이 validate-N과 동일 헬퍼 — vu_curve peak>cap이면 N>1로 워커 fan-out.

- [ ] **Step 4: 단일워커 거부 + unused `capacity` local 제거**
  `validate_run_config`의 vu_curve 검증 블록에서 (a) `let capacity = state.settings.worker_capacity_vus();`(250) **삭제**, (b) 거부(258-264) **삭제**:
  ```rust
              if !state.coord.is_pool_mode() && s.target > capacity {
                  return Err(ApiError::BadRequest(format!(
                      "최대 목표 VU {}가 워커 용량 {capacity}을 초과합니다 \
                       (vu_stages는 단일 워커 — 멀티워커 곡선 샤딩 미지원, spec §9)",
                      s.target
                  )));
              }
  ```
  결과 블록은 stage 루프에 `duration_seconds == 0` 검사(253-257)만 남고, 그 뒤 `>=1 target>0`(266) 검사는 유지:
  ```rust
          let stages = profile.vu_stages.as_deref().unwrap_or_default();
          for s in stages {
              if s.duration_seconds == 0 {
                  return Err(ApiError::BadRequest(
                      "stage duration_seconds must be >= 1".into(),
                  ));
              }
          }
          if !stages.iter().any(|s| s.target > 0) {
              return Err(ApiError::BadRequest(
                  "최소 한 stage의 target은 0보다 커야 합니다".into(),
              ));
          }
  ```
  **Acceptance (R2):** 비-풀 vu_curve peak>cap이 validate 통과(거부 제거). 노브충돌(240·245)·stage duration(253)·`>=1 target>0`(266)은 유지.

- [ ] **Step 5: `fanout_worker_count` 단위테스트 추가**
  `runs.rs`의 `#[cfg(test)] mod tests` 안에 추가(`curve_profile` 헬퍼는 같은 모듈에 이미 존재):
  ```rust
  #[test]
  fn fanout_worker_count_vu_curve_uses_peak() {
      // vu_curve N = ceil(peak / capacity), peak = max(vu_stages.target).
      let p = curve_profile(vec![
          handicap_engine::Stage { target: 10, duration_seconds: 5 },
          handicap_engine::Stage { target: 50, duration_seconds: 5 },
      ]);
      assert_eq!(fanout_worker_count(&p, 50), 1, "peak <= capacity → N=1");
      assert_eq!(fanout_worker_count(&p, 25), 2, "ceil(50/25)");
      assert_eq!(fanout_worker_count(&p, 20), 3, "ceil(50/20)");
  }
  ```
  **Acceptance (R1/R4):** 헬퍼가 곡선 peak 기반 N을 정확히 산출.

- [ ] **Step 6: `validate_vu_curve_nonpool_rejects` → `validate_vu_curve_nonpool_fans_out` flip**
  `runs.rs` tests의 기존 테스트(2263-2279)를 교체(거부 제거로 RED가 되므로 같은 커밋에서 의미를 뒤집는다):
  ```rust
  /// B9: non-pool mode now FANS OUT a curve whose peak exceeds single-worker
  /// capacity (N = ceil(peak/cap)) instead of rejecting. (was validate_vu_curve_nonpool_rejects)
  #[tokio::test]
  async fn validate_vu_curve_nonpool_fans_out() {
      let db = crate::store::connect("sqlite::memory:").await.unwrap();
      let state = state_with(db, 2000).await; // pool_mode false; peak 5000 > 2000 → N=3
      let p = curve_profile(vec![handicap_engine::Stage {
          target: 5000,
          duration_seconds: 10,
      }]);
      assert!(
          validate_run_config(&state, &p).await.is_ok(),
          "non-pool: peak>capacity now fans out (N=ceil(peak/cap)), not rejected"
      );
  }
  ```
  (`validate_vu_curve_pool_defers_to_guard`(2248)는 그대로 — 풀 경로 무변경.)
  **Acceptance (R2):** 비-풀 곡선 peak>cap이 validate 통과.

- [ ] **Step 7: unique-floor 곡선 통합테스트 + `unique_curve_profile` 헬퍼 추가**
  `runs.rs` tests에 헬퍼 + 두 테스트 추가(`unique_rejected_when_rows_below_worker_count`(1325)의 dataset insert를 미러):
  ```rust
  fn unique_curve_profile(dataset_id: String, peak: u32) -> Profile {
      Profile {
          data_binding: Some(DataBinding {
              dataset_id,
              policy: BindingPolicy::Unique,
              mappings: vec![],
          }),
          ..curve_profile(vec![handicap_engine::Stage {
              target: peak,
              duration_seconds: 5,
          }])
      }
  }

  #[tokio::test]
  async fn nonpool_vu_curve_unique_rows_lt_workers_rejected() {
      let db = crate::store::connect("sqlite::memory:").await.unwrap();
      // 1 row; cap 25, peak 50 → N = ceil(50/25) = 2; rows 1 < 2 → reject (R4).
      let dataset_id =
          crate::store::datasets::insert(&db, "d", &["c".to_string()], &[vec!["a".to_string()]], 0)
              .await
              .unwrap();
      let state = state_with(db, 25).await;
      assert!(
          matches!(
              validate_run_config(&state, &unique_curve_profile(dataset_id, 50)).await,
              Err(ApiError::BadRequest(_))
          ),
          "curve peak 50 @ cap 25 → N=2; unique rows 1 < 2 must reject"
      );
  }

  #[tokio::test]
  async fn nonpool_vu_curve_unique_rows_ge_workers_ok() {
      let db = crate::store::connect("sqlite::memory:").await.unwrap();
      // 2 rows; cap 25, peak 50 → N=2; rows 2 >= 2 → ok.
      let dataset_id = crate::store::datasets::insert(
          &db,
          "d",
          &["c".to_string()],
          &[vec!["a".to_string()], vec!["b".to_string()]],
          0,
      )
      .await
      .unwrap();
      let state = state_with(db, 25).await;
      assert!(
          validate_run_config(&state, &unique_curve_profile(dataset_id, 50))
              .await
              .is_ok(),
          "curve peak 50 @ cap 25 → N=2; unique rows 2 >= 2 must pass"
      );
  }
  ```
  (`DataBinding`/`BindingPolicy`는 이미 `use crate::binding::{BindingPolicy, ...}` + `unique_profile`이 `DataBinding`을 쓰므로 import 존재. 필요 시 `unique_profile` 위쪽 import 미러.)
  **Acceptance (R4):** floor가 vu_curve의 실제 fan-out N(=2)을 봐 rows<N 거부·rows>=N 통과.

- [ ] **Step 8: `reduce_pool_profile` 곡선 샤딩 불변식 단위테스트 추가 (coordinator.rs, production 무변경)**
  `crates/controller/src/grpc/coordinator.rs`의 `#[cfg(test)] mod tests`(기존 `reduce_pool_profile_curve_none_weights_even_split`(2935) 근처)에 추가:
  ```rust
  #[test]
  fn nonpool_vu_curve_shard_split_peak_and_subpeak() {
      // Non-pool fan-out: slot_weights=None → each stage shard_split across N (R3).
      // peak stage (target=peak) scaled == shard_split(peak,N,i).1 == vu_count (R5);
      // sub-peak stage target < N → some workers 0-share (engine parks); Σ preserved.
      let stages = vec![
          pb::Stage { target: 2, duration_seconds: 5 },  // sub-peak: < N=3
          pb::Stage { target: 50, duration_seconds: 5 }, // peak
      ];
      let n = 3u32;
      let (mut sub_sum, mut peak_sum) = (0u32, 0u32);
      for i in 0..n {
          let mut p = pb::Profile {
              vu_stages: stages.clone(),
              ..Default::default()
          };
          let vu_count = shard_split(50, n, i).1; // register's slab size for worker i
          reduce_pool_profile(&mut p, i, n, vu_count, None);
          assert_eq!(
              p.vu_stages[1].target, vu_count,
              "peak stage == vu_count (slab size) for worker {i}"
          );
          sub_sum += p.vu_stages[0].target;
          peak_sum += p.vu_stages[1].target;
      }
      assert_eq!(sub_sum, 2, "sub-peak Σ preserved (some workers 0-share)");
      assert_eq!(peak_sum, 50, "peak Σ preserved");
  }
  ```
  **Acceptance (R3/R5):** 곡선 None-weights 샤딩이 stage별 균등·peak==vu_count·Σ 보존·sub-peak 0-share.

- [ ] **Step 9: 게이트 — 빌드·테스트·clippy + byte-identical 확인 (R6/R7/R8)**
  워크트리 루트에서 (출력은 파이프 말고 로그파일 후 exit code):
  ```bash
  cargo build -p handicap-worker --bin worker > /tmp/ccws-warm.log 2>&1 && echo OK
  cargo build --workspace --tests > /tmp/ccws-build.log 2>&1 && echo BUILD_OK
  cargo clippy --workspace --all-targets -- -D warnings > /tmp/ccws-clippy.log 2>&1 && echo CLIPPY_OK
  cargo nextest run -p handicap-controller > /tmp/ccws-test.log 2>&1 && echo TEST_OK
  git diff --stat
  ```
  **Acceptance (R6):** 빌드/clippy/nextest 모두 OK; `git diff --stat`이 `crates/controller/` 한정(proto/·migration·engine/·worker/·ui/ 없음). 기존 곡선/fixed/open/풀 스위트 + active-VU 테스트 green(= N=1 byte-identical, active-VU 머지 무변경 R7).
  **Acceptance (R8):** 신규 REST/엔드포인트/필드 0 — 409/force 미도입(grep `ConflictJson` 신규 0), active-VU worker_id 미노출(무변경).

- [ ] **Step 10: 커밋 (단일 green)**
  명시 경로만 `git add`(절대 `-A` 금지), 파이프 없는 단일 foreground 커밋:
  ```bash
  git add crates/controller/src/api/runs.rs crates/controller/src/grpc/coordinator.rs
  git commit -m "feat(controller): closed-loop VU 곡선 비-풀 fan-out 샤딩 (N=ceil(peak/cap), B9)"
  git log -1
  ```
  (subagent면 commit은 `run_in_background:false` + timeout 600000ms 단일 호출, 폴링 금지.)

---

## Task 2: e2e_kind_driver 단일 run을 곡선으로 교체 (R9)

**충족 R:** `R9`
**Files:**
- Modify: `crates/controller/src/bin/e2e_kind_driver.rs` — run profile `vus:50`→`vu_stages`

- [ ] **Step 1: driver run profile 교체**
  `crates/controller/src/bin/e2e_kind_driver.rs`의 run 생성 JSON(86-88)을:
  ```rust
              "profile": {"vus": 50, "ramp_up_seconds": 2, "duration_seconds": 10},
  ```
  에서:
  ```rust
              "profile": {"duration_seconds": 0, "vu_stages": [{"target": 50, "duration_seconds": 10}]},
  ```
  로 교체. **⚠ top-level `"duration_seconds": 0`은 반드시 유지** — `store::runs::Profile::duration_seconds`는 serde-required(`#[serde(default)]` 없음·`store/runs.rs:116`)라 빼면 `POST /api/runs`가 422로 깨지고(driver `.error_for_status()?`가 bail → Job 미생성 → 워크플로 단언 실패), vu_curve는 `duration_seconds`가 0이어야 검증 통과(runs.rs:240). 정확한 곡선 JSON 선례 = `tests/pool_vu_curve_capacity_test.rs:166`(`"duration_seconds": 0` + `vu_stages`). top-level `vus`/`ramp_up_seconds`만 제거(곡선이 VU 수 정의). 다른 부분(시나리오·wiremock seed·폴링·`count>0`·`steps==2` 단언)은 무변경. 헤더 주석 `e2e_kind_driver.rs:11`("3. POST /api/runs — 50 VUs, 10 s duration…")을 곡선으로 갱신(`//! 3. POST /api/runs — closed-loop VU curve (peak 50, cap 25 → N=2)`).
  **Acceptance (R9):** driver가 곡선 run을 생성. 배포 cap=25(scripts/e2e-kind.sh:9)라 peak50→N=2. 워크플로(`.github/workflows/e2e-kind.yml`)의 기존 `completionMode=Indexed && completions=2` 라이브 단언이 곡선 Indexed Job을 검증(워크플로·Helm·script 수정 0). REST smoke(count>0·steps==2) 유지.

- [ ] **Step 2: 검증 (빌드 — bin은 cargo build로 컴파일 확인, kind 실행은 라이브)**
  ```bash
  cargo build -p handicap-controller --bin e2e_kind_driver > /tmp/ccws-driver.log 2>&1 && echo DRIVER_OK
  ```
  **Acceptance (R9):** driver bin 컴파일 통과. 실제 kind 실행은 머지 전 라이브(아래).

- [ ] **Step 3: 커밋**
  ```bash
  git add crates/controller/src/bin/e2e_kind_driver.rs
  git commit -m "test(e2e-kind): driver run을 VU 곡선으로 교체해 곡선 fan-out 검증 (B9 R9)"
  git log -1
  ```

---

## 머지 / 마무리

- **라이브 검증 필수**(spec §6 — run-생성·dispatch·report-파싱 경로 변경, S-D 갭): `/live-verify`로 subprocess 스택(50ms responder·격리 DB·`--worker-capacity-vus`를 작게 예 25) → peak>cap 곡선 run 생성 → ① N개 워커 spawn(컨트롤러 로그/run completed) ② `active_vu_series` SUM 머지(actual peak ≈ 곡선 peak·`GET /report`의 `active_vu_series`) ③ 총 VU/RPS 보존 ④ `/report`가 `ReportSchema` 파싱(곡선 run 응답). **+ kind**(R9): `scripts/e2e-kind.sh` 1회 실행 — 곡선으로 교체된 driver run이 워크플로 라이브 `Indexed && completions=2` 단언 + REST smoke 통과.
- **최종 리뷰**: `handicap-reviewer`(① validate-N↔dispatch-N 단일 소스 ② peak-stage==vu_count 불변식 ③ byte-identical proto/migration/engine/worker/ui 0). 보안 path-gate(요청실행/샤딩) 매치 시 `security-reviewer`.
- **워크트리 ff-merge**(루트 CLAUDE.md): 실제 브랜치명 확인(`git -C /Users/sgj/develop/handicap branch --list 'worktree-*'` → `worktree-closed-curve-worker-sharding`) → 메인 클린·ff 가능 사전확인(`merge-base --is-ancestor master <branch>`) → `git -C /Users/sgj/develop/handicap merge --ff-only worktree-closed-curve-worker-sharding` → `ExitWorktree(remove, discard_changes:true)`. 세션 중 master 전진 시 rebase 후 ff(docs 충돌 가능 — build-log/상태줄).
- **잔류 정리**: Playwright 미사용(백엔드 슬라이스) — `.playwright-mcp`/루트 png 정리 불요.

## Self-Review (작성자 체크)

- **R 커버리지**: R1–R9 전부 담당 task 있음(미매핑 0). `seam ✅` R7은 L5 재사용(신규 와이어 0)이라 계약-먼저 불요. ✓
- **인라인 acceptance**: 각 step이 자기 R의 acceptance를 인라인 보유 — subagent가 spec 없이 닫을 수 있음. ✓
- **Placeholder scan**: 모든 코드 블록이 실제 코드(헬퍼·call-site·테스트·driver 교체 전부 구체) — `...`/TODO 없음. ✓
- **Type/idiom consistency**: `fanout_worker_count(&Profile, u32)->u32`가 Step 1 정의·Step 2/3 호출·Step 5 테스트에서 일관. `curve_profile`/`unique_profile`/`state_with`/`shard_split`/`pb::Profile`/`pb::Stage`는 코드 실재 확인. `Profile`=`store::runs::Profile`(Default 미derive→헬퍼 구성). ✓
- **커밋 경계**: Task 1은 헬퍼+call-site+거부제거+테스트(flip 포함)를 단일 green 커밋(dead_code/RED 단독 불가, spec §8). Task 2 별 커밋. ✓
