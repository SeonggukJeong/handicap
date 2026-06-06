# Run 스케줄러 34a (백엔드 코어) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 스케줄러의 두 백엔드 토대를 착지한다 — (1) 순수 트리거 엔진(`schedule/trigger.rs`: once/5-field cron의 다음 발사 시각 계산 + 검증) + cron/chrono 의존성, (2) run 발사 코어를 `api::runs::create`에서 `spawn_run` 헬퍼로 추출(REST·향후 스케줄러 루프가 공유, 동작 byte-identical).

**Architecture:** 두 변경 모두 컨트롤러 한정. 트리거 엔진은 `croner`(5-field 표준 crontab) + `chrono`/`chrono-tz`(IANA TZ)로 epoch ms ↔ TZ-aware 다음 발사를 계산하는 순수 함수 묶음(소비자는 34b). `spawn_run`은 기존 `create`의 insert→data_binding 해석→enqueue→dispatch 블록(`runs.rs:254-369`)을 그대로 떼어낸 순수 리팩터 — 기존 통합 테스트가 전부 GREEN인 것이 byte-identical 게이트.

**Tech Stack:** Rust(edition 2024, MSRV 1.85), `croner` 3.x, `chrono` 0.4, `chrono-tz` 0.10, axum/sqlx(기존), `cargo test`.

**Spec:** `docs/superpowers/specs/2026-06-06-run-scheduler-design.md` (§5 트리거 엔진, §6 발사 코어, §15 분할 — 이 plan = 34a).

---

## 사전 메모 (실행 전 1회 읽기)

- **TDD-guard 우회**: 각 task는 **테스트 파일을 먼저** 만든다(Task 1은 `tests/*.rs`를 Step에서 먼저 Write → self-unblock; Task 2는 `runs.rs`가 이미 인라인 `#[cfg(test)]`를 갖고 있는지 확인하고, 없으면 orchestrator가 `crates/controller/tests/_tdd_keepalive.rs`에 `#[test] fn k(){}`를 깔아 unblock 후 commit 전 `rm`). 루트 CLAUDE.md "검증 자동화" 참고.
- **pre-commit 게이트**: 비-`.md` 커밋마다 전체 워크스페이스(`cargo fmt --check + build + clippy -D warnings + test --workspace`)를 돈다(수 분). cold-build flake(worker 바이너리 race) 대비 **커밋 전 `cargo build -p handicap-worker && cargo build --workspace`로 warm**. 커밋은 `run_in_background:false` 단일 호출 + 파이프 금지(exit code 마스킹) + 직후 `git log -1`로 확인.
- **dead_code 안전**: 트리거 엔진 함수는 `pub`(lib `handicap_controller`의 공개 API)이라 34a에 비-test 소비자가 없어도 `clippy -D warnings`의 dead_code에 안 걸린다(`pub(crate)`였다면 걸림).
- **byte-identical 불변식**: Task 2 후 `POST /api/runs` 동작/응답은 변하면 안 된다. 검증 = 기존 통합 테스트(`api_test`/`data_binding`/`presets`/`datasets`/`run_dispatch_failure`) 전부 GREEN.

---

## 파일 구조

| 파일 | 책임 | Task |
|---|---|---|
| `crates/controller/Cargo.toml` | `croner`/`chrono`/`chrono-tz` 의존성 추가 | 1 |
| `crates/controller/src/lib.rs` | `pub mod schedule;` 노출 | 1 |
| `crates/controller/src/schedule/mod.rs` (신규) | `pub mod trigger;` | 1 |
| `crates/controller/src/schedule/trigger.rs` (신규) | 순수 트리거 엔진(`Trigger`/`next_fire_after`/`next_fires`/`validate_trigger`) | 1 |
| `crates/controller/tests/scheduler_trigger_test.rs` (신규) | 트리거 엔진 동작 테스트 | 1 |
| `crates/controller/src/api/runs.rs` | `spawn_run` 추출 + `create`가 호출 | 2 |

---

## Task 1: cron 의존성 + 순수 트리거 엔진

**Files:**
- Modify: `crates/controller/Cargo.toml` (`[dependencies]`)
- Create: `crates/controller/tests/scheduler_trigger_test.rs`
- Create: `crates/controller/src/schedule/mod.rs`
- Create: `crates/controller/src/schedule/trigger.rs`
- Modify: `crates/controller/src/lib.rs` (`pub mod schedule;` 추가)

- [ ] **Step 1: 의존성 추가**

`crates/controller/Cargo.toml`의 `[dependencies]` 섹션에 세 줄 추가(controller 한정 — 엔진/워커는 안 씀):

```toml
croner = "3"
chrono = "0.4"
chrono-tz = "0.10"
```

- [ ] **Step 2: 의존성이 워크스페이스 toolchain에서 빌드되는지 확인**

Run: `cargo build -p handicap-controller`
Expected: 성공(경고만 가능). **실패 시(croner 3.x가 더 높은 rustc 요구 등)**: 빌드되는 최신 `croner` 3.x로 내리거나, 그래도 안 되면 `saffron`(5-field, `Cron::parse` + `next_after`)으로 폴백 — 이 경우 Step 5의 cron 호출부를 saffron API로 교체(나머지 시그니처/테스트는 동일 유지). 빌드 성공 후 다음 단계.

- [ ] **Step 3: 실패하는 트리거 엔진 테스트 작성**

`crates/controller/tests/scheduler_trigger_test.rs` 생성(테스트-경로 파일이라 TDD-guard self-unblock):

```rust
//! 순수 트리거 엔진(schedule::trigger) 동작 테스트.
use chrono::{Datelike, TimeZone, Timelike};
use chrono_tz::Asia::Seoul;
use handicap_controller::schedule::trigger::{Trigger, next_fire_after, next_fires, validate_trigger};

fn seoul_ms(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> i64 {
    Seoul
        .with_ymd_and_hms(y, mo, d, h, mi, 0)
        .unwrap()
        .timestamp_millis()
}

#[test]
fn once_next_fire_is_the_run_at_itself() {
    let t = Trigger::Once { run_at: 5_000 };
    assert_eq!(next_fire_after(&t, 0, Seoul), Some(5_000));
    // now 이후여도 once는 run_at을 그대로 돌려준다(루프가 발사 후 비활성화).
    assert_eq!(next_fire_after(&t, 9_999, Seoul), Some(5_000));
}

#[test]
fn cron_daily_next_is_same_day_when_time_not_yet_passed() {
    // 매일 02:00. now = 2026-06-06 01:00 KST → 다음 = 같은 날 02:00 KST.
    let t = Trigger::Cron { expr: "0 2 * * *".into() };
    let now = seoul_ms(2026, 6, 6, 1, 0);
    let next = next_fire_after(&t, now, Seoul).expect("cron has a next");
    let dt = chrono::DateTime::from_timestamp_millis(next)
        .unwrap()
        .with_timezone(&Seoul);
    assert_eq!((dt.year(), dt.month(), dt.day()), (2026, 6, 6));
    assert_eq!((dt.hour(), dt.minute()), (2, 0));
}

#[test]
fn cron_daily_next_rolls_to_tomorrow_when_time_passed() {
    // now = 2026-06-06 03:00 KST, 02:00은 지남 → 다음 = 2026-06-07 02:00 KST.
    let t = Trigger::Cron { expr: "0 2 * * *".into() };
    let now = seoul_ms(2026, 6, 6, 3, 0);
    let next = next_fire_after(&t, now, Seoul).unwrap();
    let dt = chrono::DateTime::from_timestamp_millis(next)
        .unwrap()
        .with_timezone(&Seoul);
    assert_eq!((dt.year(), dt.month(), dt.day()), (2026, 6, 7));
    assert_eq!((dt.hour(), dt.minute()), (2, 0));
}

#[test]
fn next_fires_returns_count_strictly_increasing() {
    let t = Trigger::Cron { expr: "0 2 * * *".into() };
    let now = seoul_ms(2026, 6, 6, 1, 0);
    let fires = next_fires(&t, now, Seoul, 3);
    assert_eq!(fires.len(), 3);
    assert!(fires[0] < fires[1] && fires[1] < fires[2]);
    // 첫 발사 = 같은 날 02:00.
    assert_eq!(fires[0], seoul_ms(2026, 6, 6, 2, 0));
}

#[test]
fn next_fires_once_is_single() {
    let t = Trigger::Once { run_at: 42 };
    assert_eq!(next_fires(&t, 0, Seoul, 5), vec![42]);
}

#[test]
fn validate_rejects_bad_cron_and_past_once() {
    let now = seoul_ms(2026, 6, 6, 1, 0);
    assert!(validate_trigger(&Trigger::Cron { expr: "not a cron".into() }, now).is_err());
    assert!(validate_trigger(&Trigger::Once { run_at: now - 1 }, now).is_err());
    assert!(validate_trigger(&Trigger::Once { run_at: now + 1 }, now).is_ok());
    assert!(validate_trigger(&Trigger::Cron { expr: "0 2 * * *".into() }, now).is_ok());
}
```

- [ ] **Step 4: 테스트가 컴파일 실패(모듈 없음)하는지 확인**

Run: `cargo test -p handicap-controller --test scheduler_trigger_test`
Expected: FAIL — `unresolved import handicap_controller::schedule` / `could not find schedule`.

- [ ] **Step 5: 트리거 엔진 구현**

`crates/controller/src/schedule/mod.rs` 생성:

```rust
//! Run 스케줄러: 순수 트리거 엔진(34a). 영속화·루프·REST는 34b.
pub mod trigger;
```

`crates/controller/src/schedule/trigger.rs` 생성:

```rust
//! 순수 트리거 엔진 — once/5-field cron의 다음 발사 시각 계산 + 검증.
//! TZ-aware(`chrono_tz::Tz`). DB·IO 없음. 소비자는 34b(store/runner/api).
use std::str::FromStr;

use chrono::DateTime;
use chrono_tz::Tz;
use croner::Cron;

/// 스케줄 트리거: 특정 일시 1회(once) 또는 반복(5-field 표준 crontab).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Trigger {
    /// 특정 epoch ms에 1회.
    Once { run_at: i64 },
    /// 5-field crontab(분 시 일 월 요일, seconds 미사용).
    Cron { expr: String },
}

/// epoch ms → 설정 TZ의 wall-clock DateTime. 음수/범위밖은 epoch 0으로 폴백.
fn to_tz(now_ms: i64, tz: Tz) -> DateTime<Tz> {
    DateTime::from_timestamp_millis(now_ms)
        .unwrap_or_else(|| DateTime::from_timestamp_millis(0).expect("epoch 0 is valid"))
        .with_timezone(&tz)
}

/// `now_ms` 직후의 다음 발사 시각(epoch ms).
/// None = 계산 불가(잘못된 cron). validate_trigger 통과분은 항상 Some.
/// once는 항상 `Some(run_at)`(루프가 발사 후 비활성화하므로 과거여부는 루프가 처리).
pub fn next_fire_after(t: &Trigger, now_ms: i64, tz: Tz) -> Option<i64> {
    match t {
        Trigger::Once { run_at } => Some(*run_at),
        Trigger::Cron { expr } => {
            let cron = Cron::from_str(expr).ok()?;
            cron.find_next_occurrence(&to_tz(now_ms, tz), false)
                .ok()
                .map(|dt| dt.timestamp_millis())
        }
    }
}

/// 다음 `count`개 발사 시각(epoch ms). preview-next 엔드포인트(34b)용.
/// 잘못된 cron이면 빈 Vec. once는 단일 원소.
pub fn next_fires(t: &Trigger, now_ms: i64, tz: Tz, count: usize) -> Vec<i64> {
    match t {
        Trigger::Once { run_at } => vec![*run_at],
        Trigger::Cron { expr } => {
            let Ok(cron) = Cron::from_str(expr) else {
                return Vec::new();
            };
            let mut out = Vec::with_capacity(count);
            let mut cursor = to_tz(now_ms, tz);
            for _ in 0..count {
                // exclusive(false)라 매번 직전 발사 다음으로 전진.
                match cron.find_next_occurrence(&cursor, false) {
                    Ok(next) => {
                        out.push(next.timestamp_millis());
                        cursor = next;
                    }
                    Err(_) => break,
                }
            }
            out
        }
    }
}

/// 생성/수정 시 검증: cron 파싱 실패 / once run_at 과거 → Err(메시지).
/// TZ 불필요(cron 파싱·epoch ms 비교만).
pub fn validate_trigger(t: &Trigger, now_ms: i64) -> Result<(), String> {
    match t {
        Trigger::Once { run_at } => {
            if *run_at <= now_ms {
                Err("예약 시각은 미래여야 합니다".into())
            } else {
                Ok(())
            }
        }
        Trigger::Cron { expr } => Cron::from_str(expr)
            .map(|_| ())
            .map_err(|e| format!("cron 표현식이 올바르지 않습니다: {e}")),
    }
}
```

`crates/controller/src/lib.rs`에 모듈 선언 추가(기존 `pub mod store;` 등 옆):

```rust
pub mod schedule;
```

- [ ] **Step 6: 테스트 통과 확인**

Run: `cargo test -p handicap-controller --test scheduler_trigger_test`
Expected: PASS (6 tests).

- [ ] **Step 7: clippy + fmt 확인**

Run: `cargo clippy -p handicap-controller --all-targets -- -D warnings && cargo fmt --check`
Expected: 통과(경고 0). 실패 시 수정 후 재실행.

- [ ] **Step 8: 커밋**

먼저 warm: `cargo build -p handicap-worker && cargo build --workspace`
그다음(파이프 없이, foreground):
```bash
git add crates/controller/Cargo.toml crates/controller/src/lib.rs \
        crates/controller/src/schedule/ crates/controller/tests/scheduler_trigger_test.rs Cargo.lock
git commit -m "feat(controller): 스케줄러 순수 트리거 엔진 + cron/chrono 의존성 (34a)"
```
직후 `git log -1 --oneline`로 landed 확인. (pre-commit이 전체 워크스페이스를 도므로 수 분 소요; cold-build worker race flake면 warm 상태로 동일 커밋 재시도.)

---

## Task 2: `spawn_run` 발사 코어 추출 (순수 리팩터)

**Files:**
- Modify: `crates/controller/src/api/runs.rs` (`create` 분해 + `spawn_run` 신규)

리팩터라 새 동작이 없다. **게이트 = 기존 통합 테스트가 전부 GREEN**(byte-identical 증명). 트리거 엔진과 무관(독립 커밋).

- [ ] **Step 1: 추출 전 기준선 — 기존 run-create 테스트가 GREEN인지 확인**

Run: `cargo test -p handicap-controller --test api_test --test data_binding --test presets --test datasets --test run_dispatch_failure_test`
Expected: 전부 PASS. (테스트 파일명이 다르면 `ls crates/controller/tests/`로 확인 — run-create를 다루는 통합 테스트 집합을 기준선으로 잡는다.) 이 집합이 Step 4의 회귀 게이트.

> TDD-guard: 이 task는 `runs.rs`(src) 텍스트를 바꾸는 순수 리팩터다. `runs.rs`에 이미 인라인 `#[cfg(test)]`가 있으면 자동 통과. 없거나 막히면 orchestrator가 `crates/controller/tests/_tdd_keepalive.rs`(`#[test] fn k(){}`)를 깔아 unblock하고 **커밋 전 `rm`**(루트 CLAUDE.md). 위 기존 통합 테스트가 진짜 회귀 게이트다.

- [ ] **Step 2: `spawn_run` 추가**

`crates/controller/src/api/runs.rs`에 `create` 함수 **바로 앞**(또는 뒤)에 신규 함수 추가. 본문은 현 `create`의 `:254-369` 블록을 `body.profile`→`profile`, `body.env`→`env`로 치환한 것(필요 import는 이미 파일 상단 `:7-11`에 있음 — `BindingPolicy`/`datasets`/`runs`/`scenarios`):

```rust
/// 검증된 run을 발사: insert → data_binding 해석 → enqueue → dispatch.
/// dispatch 실패 시 run을 failed로 마크하고 Err 반환(cancel_dispatch_failed +
/// mark_failed 수행 후). REST `create`(권위 게이트 통과 후 호출)와 스케줄러
/// 루프(34b)가 공유한다. `validated_meta`는 `validate_run_config`가 돌려준
/// 검증된 dataset meta(TOCTOU 회피 재사용; binding 없으면 None).
pub(crate) async fn spawn_run(
    state: &AppState,
    scenario: &scenarios::ScenarioRow,
    profile: &Profile,
    validated_meta: Option<datasets::DatasetMeta>,
    env: &std::collections::HashMap<String, String>,
) -> Result<runs::RunRow, ApiError> {
    // env is map<string,string>; serialize for storage, clone for the proto.
    let env_value = serde_json::to_value(env).expect("env map serializes to a JSON object");
    let row = runs::insert(&state.db, &scenario.id, &scenario.yaml, profile, &env_value).await?;

    // Resolve the binding for the worker: proto policy, deterministic seed folded
    // from the run id, sliced row count. Reuses the meta validate already fetched.
    let data_binding = match (&profile.data_binding, validated_meta) {
        (Some(b), Some(meta)) => {
            let (policy, row_count) = match b.policy {
                BindingPolicy::PerVu => {
                    let slot_count = if profile.is_open_loop() {
                        profile.max_in_flight.unwrap_or(0) as u64
                    } else {
                        profile.vus as u64
                    };
                    (
                        handicap_proto::v1::data_binding::Policy::PerVu,
                        slot_count.min(meta.row_count as u64),
                    )
                }
                BindingPolicy::IterSequential => (
                    handicap_proto::v1::data_binding::Policy::IterSequential,
                    meta.row_count as u64,
                ),
                BindingPolicy::IterRandom => (
                    handicap_proto::v1::data_binding::Policy::IterRandom,
                    meta.row_count as u64,
                ),
                BindingPolicy::Unique => (
                    handicap_proto::v1::data_binding::Policy::Unique,
                    meta.row_count as u64,
                ),
            };
            Some(crate::grpc::coordinator::PendingDataBinding {
                dataset_id: b.dataset_id.clone(),
                policy,
                seed: fold_seed(&row.id),
                mappings: b.mappings.clone(),
                row_count,
            })
        }
        _ => None,
    };

    let assignment = crate::grpc::coordinator::PendingAssignment {
        scenario_yaml: scenario.yaml.clone(),
        profile: handicap_proto::v1::Profile {
            vus: profile.vus,
            ramp_up_seconds: profile.ramp_up_seconds,
            duration_seconds: profile.duration_seconds,
            loop_breakdown_cap: profile.loop_breakdown_cap,
            http_timeout_seconds: profile.http_timeout_seconds,
            think_time: profile
                .think_time
                .map(|t| handicap_proto::v1::ThinkTime {
                    min_ms: t.min_ms,
                    max_ms: t.max_ms,
                }),
            think_seed: profile.think_seed,
            target_rps: profile.target_rps,
            max_in_flight: profile.max_in_flight,
            stages: profile
                .stages
                .as_deref()
                .unwrap_or_default()
                .iter()
                .map(|s| handicap_proto::v1::Stage {
                    target: s.target,
                    duration_seconds: s.duration_seconds,
                })
                .collect(),
        },
        env: env.clone(),
        data_binding,
    };
    let n = if profile.is_open_loop() {
        1 // open-loop is single-worker in v1 (fan-out deferred — spec §9)
    } else {
        state.coord.worker_count_for(profile.vus)
    };
    state
        .coord
        .enqueue(row.id.clone(), assignment, n, profile.vus)
        .await;

    // Dispatch failure is an authoritative run-start failure: tear down the
    // enqueued coordinator state, mark the run failed with the cause, return 5xx.
    if let Err(e) = state.dispatcher.dispatch(&row.id, n).await {
        let message = format!("failed to dispatch workers: {e}");
        tracing::error!(run_id = %row.id, error = %e, "worker dispatch failed; marking run failed");
        state.coord.cancel_dispatch_failed(&row.id).await;
        runs::mark_failed(&state.db, &row.id, &message).await?;
        return Err(ApiError::Internal(anyhow::anyhow!(message)));
    }

    Ok(row)
}
```

> 메모: `profile.think_time.map(...)` / `profile.target_rps` / `profile.max_in_flight`는 `&Profile` 위에서도 동작한다 — `ThinkTime`/`u32`가 `Copy`라 `Option::map`이 복사(현 `create`가 `body.profile`을 think_time `.map` 이후에도 쓰므로 이미 `Copy`임이 증명됨). 만약 컴파일러가 move를 호소하면 `profile.think_time.as_ref().map(|t| ...)`로 바꾼다.

- [ ] **Step 3: `create`를 `spawn_run` 호출로 축소**

`crates/controller/src/api/runs.rs`의 `create`(`:243-372`)에서 `:254-369` 블록을 삭제하고 `spawn_run` 호출로 교체. 최종 `create`:

```rust
pub async fn create(
    State(state): State<AppState>,
    Json(body): Json<CreateRunRequest>,
) -> Result<(StatusCode, Json<RunResponse>), ApiError> {
    let scenario = scenarios::get(&state.db, &body.scenario_id)
        .await?
        .ok_or(ApiError::NotFound)?;

    let validated_meta = validate_run_config(&state, &body.profile).await?;

    let row = spawn_run(&state, &scenario, &body.profile, validated_meta, &body.env).await?;

    Ok((StatusCode::CREATED, Json(to_response(row))))
}
```

- [ ] **Step 4: 회귀 게이트 — 기존 통합 테스트가 여전히 GREEN인지 확인**

Run: `cargo test -p handicap-controller --test api_test --test data_binding --test presets --test datasets --test run_dispatch_failure_test`
Expected: 전부 PASS (Step 1과 동일). 이게 byte-identical 증명. **하나라도 FAIL이면** 추출 중 치환 실수(`body.profile`/`body.env` 잔존, `n` 계산 누락 등) — diff를 `:254-369` 원본과 라인 대조.

- [ ] **Step 5: clippy + fmt**

Run: `cargo clippy -p handicap-controller --all-targets -- -D warnings && cargo fmt --check`
Expected: 통과. (추출로 `create`가 짧아져 unused import가 생기진 않음 — 모든 심볼은 `spawn_run`이 계속 씀.)

- [ ] **Step 6: keepalive 정리(있었다면) + 커밋**

keepalive를 깔았다면 `rm crates/controller/tests/_tdd_keepalive.rs`.
warm: `cargo build -p handicap-worker && cargo build --workspace`
커밋(파이프 없이, foreground):
```bash
git add crates/controller/src/api/runs.rs
git commit -m "refactor(controller): run 발사 코어를 spawn_run 헬퍼로 추출 (34a, byte-identical)"
```
직후 `git log -1 --oneline` 확인.

---

## Self-Review 체크 (실행자 무시 가능 — 작성자 기록)

- **Spec 커버리지**: §5 트리거 엔진(`next_fire_after`/`next_fires`/`validate_trigger`, 5-field croner, chrono-tz TZ) → Task 1. §6 `spawn_run` 추출(byte-identical, 기존 테스트 게이트) → Task 2. §3 cron 문법/TZ 결정 반영(croner from_str 5-field, `to_tz`로 IANA TZ 평가). 34b/34c(store/loop/REST/UI)는 이 plan 범위 밖(별도 plan).
- **타입 일관성**: `Trigger`(Once/Cron), `next_fire_after(&Trigger,i64,Tz)->Option<i64>`, `next_fires(...,usize)->Vec<i64>`, `validate_trigger(&Trigger,i64)->Result<(),String>` — Task 1 정의와 테스트 호출 일치. `spawn_run(&AppState,&ScenarioRow,&Profile,Option<DatasetMeta>,&HashMap)->Result<RunRow,ApiError>` — Task 2 정의와 `create` 호출 일치.
- **플레이스홀더**: 없음(모든 Step에 실제 코드/명령/기대 출력).
- **연기**: ADR-0034는 34b(루프+리소스 착지)에서 생성 — 34a는 토대라 ADR 없음. CLAUDE.md/roadmap 갱신도 34b/34c.
