# LAN 풀 운영 견고성 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** LAN 풀 하트비트 임계값(interval/stale)을 `/settings`에서 재배포 없이 런타임 가변으로 만들고, 하트비트 리퍼를 하드닝(try_send·interval-0 clamp)하며, `/workers` 제어 액션 mutation 실패를 컨텍스트 인라인으로 표면화한다.

**Architecture:** 컨트롤러는 기존 `SettingsState` 레지스트리(`settings.rs`)에 3개 항목(interval/stale 가변·keepalive 읽기전용)을 additive로 편입하고, 리퍼가 매 sweep `settings` accessor로 임계값을 fresh 재읽는다. `stale > interval` 불변식은 PUT·DELETE·startup 3진입점에서 보존. 리퍼의 Ping 전송을 `tx.try_send`로 바꿔 head-of-line block을 없애고 interval을 `.max(1)`로 clamp. UI는 `/settings`에 3행 + 페이지-레벨 경고를, `/workers`에 인라인 에러/배너를 추가(새 토스트 primitive 0).

**Tech Stack:** Rust(axum·tokio·sqlx) 컨트롤러 + React/TS(Zod·React Query·vitest/RTL) UI. 변경 경로 = `crates/controller/src/{settings,api/settings,api/pool,grpc/coordinator,main,app}.rs` + `ui/src/{pages/SettingsPage,pages/WorkerDashboardPage,api/settings,api/pool,api/hooks,i18n/ko}.tsx?`.

## Global Constraints

이 섹션은 모든 task에 암묵 적용된다(spec §5 무변경·§2 불변식에서 verbatim).

- **migration 0 · proto 0 · engine 0 · worker 0** — 변경은 위 controller 6파일 + UI 5파일 한정. `crates/proto`·`crates/engine`·`crates/worker`·`crates/worker-core`는 0-diff. 새 SQL/마이그레이션 없음(`settings` 테이블 0017 재사용).
- **byte-identical when no DB override (R7)** — interval/stale/keepalive 유효값 = CLI 시드 = 현행 동작. 레지스트리 default(interval 10·stale 30·keepalive 20)는 현 CLI default와 동일.
- **registry `group`은 기존 `Group::Limits` 재사용 — 신규 enum variant 금지** (UI Zod `SettingSchema.group` enum `["limits","test_run","scheduler"]`을 안 건드림; `SettingsPage`는 `group`이 아니라 `mutable`/`readonly`로 분할 렌더).
- **서버 검증 메시지는 `settings.rs` 인라인 한국어**(기존 `validate` 스타일) — `ko.ts`(UI 전용) 아님. UI 노출 문구(③·R6)만 `ko.ts` 경유(ADR-0035).
- **settings store 값은 `i64`** — accessor는 `u64`로 캐스트(`self.get(key) as u64`), 시드는 `as i64`로 build에 전달.
- **pre-commit = cargo-영향 커밋마다 전체 워크스페이스 게이트(수 분)** — `git commit`은 **foreground 단일 호출**(파이프 금지), 직후 `git log -1 --oneline`로 landed 확인. RED-only/미사용-헬퍼 단독 커밋 불가 → 각 Task는 **하나의 green 커밋**(아래 "verify fail" 스텝은 로컬 확인이지 커밋 아님).
- **tdd-guard**: `settings.rs`·`coordinator.rs`·`main.rs`는 이미 인라인 `#[cfg(test)] mod tests`가 있어 src 편집이 자동 통과한다(`main.rs`는 `:366-389`). `app.rs`만 인라인 테스트가 없는데, Task 2는 `pool_api_test.rs`(test-path) 편집을 *먼저* 해 그 src 편집(`app.rs` 포함)을 unblock한다. **Task 3은 `main.rs`+`coordinator.rs`만 건드리고 둘 다 자동 통과 → keepalive·test-path 선편집 불요.** `api/settings.rs`·`api/pool.rs`도 인라인 테스트가 없으나 각 task가 test-path 편집(Task 1 Step 6·Task 2 Step 1)을 먼저 해 unblock하므로 **task 내 스텝 순서를 바꾸지 말 것**.
- **UI 게이트**: UI 커밋 전 `cd ui && pnpm lint && pnpm test && pnpm build` 모두 green(특히 `tsc -b`가 Zod 누출/타입을 잡음). UI task는 **test 파일을 src보다 먼저** 편집(tdd-guard).
- **라이브 검증**: Task 3(리퍼 런타임 재읽기·spawn)은 main-only 와이어링이라 통합/e2e 미커버 → 머지 전 `/live-verify` 스택으로 R2/R7 라이브 확인 필수(이 plan 끝 "라이브 검증" 절). Task 1/2/4/5는 단위·통합·RTL로 닫힌다.

---

### Task 1: settings 레지스트리 3행 + accessor + `check_heartbeat_pair` + PUT/DELETE 교차필드 가드

**Files:**
- Modify: `crates/controller/src/settings.rs` (SETTINGS 3행, accessor 2종, `seed_of`, `check_heartbeat_pair`, 인라인 테스트)
- Modify: `crates/controller/src/api/settings.rs` (PUT·DELETE 교차필드 검사)
- Test: `crates/controller/tests/settings_api_test.rs` (교차필드 400 통합 테스트)

**Interfaces:**
- Produces: `SettingsState::pool_heartbeat_interval_seconds(&self) -> u64`, `SettingsState::pool_stale_timeout_seconds(&self) -> u64`, `SettingsState::seed_of(&self, key: &str) -> Option<i64>`, `settings::check_heartbeat_pair(interval: u64, stale: u64) -> Result<(), String>`, 레지스트리 키 `pool_heartbeat_interval_seconds`·`pool_stale_timeout_seconds`·`pool_keepalive_seconds`.

- [ ] **Step 1: 인라인 테스트 작성 (settings.rs `mod tests`)** — `settings.rs`는 이미 `#[cfg(test)] mod tests`가 있어 tdd-guard 자동 통과. `mod tests` 안에 추가:

```rust
    #[test]
    fn pool_heartbeat_keys_registered() {
        let i = def("pool_heartbeat_interval_seconds").expect("interval key");
        assert!(i.mutable && i.min == 1 && i.max == 3600 && i.default == 10);
        let s = def("pool_stale_timeout_seconds").expect("stale key");
        assert!(s.mutable && s.min == 2 && s.max == 86400 && s.default == 30);
        let k = def("pool_keepalive_seconds").expect("keepalive key");
        assert!(!k.mutable && k.default == 20);
    }

    #[test]
    fn check_heartbeat_pair_requires_stale_gt_interval() {
        assert!(check_heartbeat_pair(10, 30).is_ok());
        assert!(check_heartbeat_pair(10, 11).is_ok());
        assert!(check_heartbeat_pair(10, 10).is_err()); // equal → reject
        assert!(check_heartbeat_pair(10, 5).is_err()); // stale < interval → reject
    }

    #[test]
    fn pool_heartbeat_accessors_and_seed() {
        let st = SettingsState::seeded_for_test();
        assert_eq!(st.pool_heartbeat_interval_seconds(), 10);
        assert_eq!(st.pool_stale_timeout_seconds(), 30);
        assert_eq!(st.seed_of("pool_stale_timeout_seconds"), Some(30));
        assert_eq!(st.seed_of("trace_body_cap_bytes"), None); // readonly → no seed
    }
```

- [ ] **Step 2: 실패 확인** — Run: `cargo test -p handicap-controller --lib settings:: 2>&1 | tail -20`. Expected: 컴파일 실패(`check_heartbeat_pair`/accessor/`seed_of` 미정의, 키 부재).

- [ ] **Step 3: 레지스트리 3행 추가 (settings.rs `SETTINGS`)** — `max_test_run_requests` 항목 바로 뒤(읽기전용 `// 읽기전용 표시` 주석 *앞*)에 2개 mutable 추가:

```rust
    // LAN 풀 하트비트 임계값(런타임 가변). 리퍼가 매 sweep 읽음. spec R1/R2.
    SettingDef {
        key: "pool_heartbeat_interval_seconds",
        label: "풀 하트비트 ping 주기",
        group: Group::Limits,
        min: 1,
        max: 3600,
        unit: "초",
        mutable: true,
        default: 10,
    },
    SettingDef {
        key: "pool_stale_timeout_seconds",
        label: "풀 워커 stale 타임아웃",
        group: Group::Limits,
        min: 2,
        max: 86400,
        unit: "초",
        mutable: true,
        default: 30,
    },
```

그리고 `scheduler_tick_seconds`(읽기전용 마지막 항목) 뒤에 keepalive 읽기전용 추가:

```rust
    SettingDef {
        key: "pool_keepalive_seconds",
        label: "풀 gRPC keepalive (서버측)",
        group: Group::Limits,
        min: 0,
        max: i64::MAX,
        unit: "초",
        mutable: false,
        default: 20,
    }, // 컨트롤러 서버측 h2 keepalive(transport-baked). 워커 클라 keepalive는 별도 20s 상수(worker-core/client.rs) — R4/§5.
```

- [ ] **Step 4: accessor + seed_of + check_heartbeat_pair 추가 (settings.rs)** — `max_test_run_requests()` accessor 뒤에:

```rust
    pub fn pool_heartbeat_interval_seconds(&self) -> u64 {
        self.get("pool_heartbeat_interval_seconds") as u64
    }
    pub fn pool_stale_timeout_seconds(&self) -> u64 {
        self.get("pool_stale_timeout_seconds") as u64
    }
    /// 가변 키의 CLI/registry 시드(R5 DELETE-revert 교차검사용). 읽기전용/미지 키는 None.
    pub fn seed_of(&self, key: &str) -> Option<i64> {
        self.seeds.get(key).copied()
    }
```

`validate` 함수 바로 뒤(top-level)에:

```rust
/// R5: stale 타임아웃은 ping 주기보다 반드시 커야 한다(같거나 작으면 건강한 워커가
/// 매 sweep 조기 evict → idle flap·busy run 실패). PUT(결과 쌍)·DELETE(revert 후 쌍)·
/// startup(시드, main.rs)이 공유하는 단일 소스.
pub fn check_heartbeat_pair(interval: u64, stale: u64) -> Result<(), String> {
    if stale <= interval {
        return Err(format!(
            "stale 타임아웃({stale}초)은 ping 주기({interval}초)보다 커야 합니다 (먼저 stale를 올리세요)"
        ));
    }
    Ok(())
}
```

- [ ] **Step 5: 인라인 테스트 통과 확인** — Run: `cargo test -p handicap-controller --lib settings:: 2>&1 | tail -20`. Expected: PASS(신규 3 + 기존 `registry_is_single_source` 등 전부). `registry_is_single_source`는 default∈[min,max]를 검사하므로 새 mutable 2행(10∈[1,3600]·30∈[2,86400])이 자동 통과.

- [ ] **Step 6: 통합 테스트 작성 (settings_api_test.rs)** — 파일 끝에 추가(기존 `send`/`make_app` 헬퍼 재사용):

```rust
/// PUT interval ≥ 현재 stale → 400 (R5a).
#[tokio::test]
async fn put_interval_ge_stale_400() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);
    // default interval=10, stale=30 → interval=40 violates (40 >= 30)
    let (status, _) = send(
        &app,
        Method::PUT,
        "/api/settings/pool_heartbeat_interval_seconds",
        Some(json!({ "value": 40 })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

/// PUT stale ≤ 현재 interval → 400 (R5a).
#[tokio::test]
async fn put_stale_le_interval_400() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);
    let (status, _) = send(
        &app,
        Method::PUT,
        "/api/settings/pool_stale_timeout_seconds",
        Some(json!({ "value": 5 })), // 5 <= interval 10
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

/// 유효 순서(stale 먼저↑ 후 interval↑) → 둘 다 200 (R5a edit-ordering).
#[tokio::test]
async fn put_valid_order_200() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);
    let (s1, _) = send(&app, Method::PUT, "/api/settings/pool_stale_timeout_seconds", Some(json!({ "value": 100 }))).await;
    assert_eq!(s1, StatusCode::OK);
    let (s2, _) = send(&app, Method::PUT, "/api/settings/pool_heartbeat_interval_seconds", Some(json!({ "value": 40 }))).await;
    assert_eq!(s2, StatusCode::OK); // 40 < 100 ok
}

/// 부분 revert로 stale ≤ interval 재현 → DELETE 400 (R5b).
#[tokio::test]
async fn delete_revert_creating_violation_400() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);
    // interval override 5 (5 < 30 ok)
    let (s1, _) = send(&app, Method::PUT, "/api/settings/pool_heartbeat_interval_seconds", Some(json!({ "value": 5 }))).await;
    assert_eq!(s1, StatusCode::OK);
    // stale override 8 (8 > 5 ok)
    let (s2, _) = send(&app, Method::PUT, "/api/settings/pool_stale_timeout_seconds", Some(json!({ "value": 8 }))).await;
    assert_eq!(s2, StatusCode::OK);
    // DELETE interval → reverts to seed 10; pair (10, current stale 8) → 8 <= 10 → reject
    let (s3, _) = send(&app, Method::DELETE, "/api/settings/pool_heartbeat_interval_seconds", None).await;
    assert_eq!(s3, StatusCode::BAD_REQUEST);
}
```

- [ ] **Step 7: 실패 확인** — Run: `cargo test -p handicap-controller --test settings_api_test 2>&1 | tail -30`. Expected: 4 신규 테스트 FAIL(교차필드 미구현 — PUT interval=40 현재 200·DELETE 현재 204).

- [ ] **Step 8: PUT 교차필드 가드 추가 (api/settings.rs `put`)** — `validate(&key, body.value)?` 뒤, `def` 재탐색 뒤(`let def = ...`), `settings_store::upsert` *앞*에:

```rust
    // R5(a): 하트비트 키는 stale > interval 불변식 — 결과 쌍 검사.
    if def.key == "pool_heartbeat_interval_seconds" {
        crate::settings::check_heartbeat_pair(
            body.value as u64,
            state.settings.pool_stale_timeout_seconds(),
        )
        .map_err(ApiError::BadRequest)?;
    } else if def.key == "pool_stale_timeout_seconds" {
        crate::settings::check_heartbeat_pair(
            state.settings.pool_heartbeat_interval_seconds(),
            body.value as u64,
        )
        .map_err(ApiError::BadRequest)?;
    }
```

- [ ] **Step 9: DELETE 교차필드 가드 추가 (api/settings.rs `delete`)** — 읽기전용 거부(`if !def.mutable {...}`) 뒤, `settings_store::delete` *앞*에:

```rust
    // R5(b): 하트비트 키 revert가 stale ≤ interval을 만들면 거부(부분 revert).
    if def.key == "pool_heartbeat_interval_seconds" {
        let interval_seed = state.settings.seed_of(def.key).expect("mutable key has seed") as u64;
        crate::settings::check_heartbeat_pair(interval_seed, state.settings.pool_stale_timeout_seconds())
            .map_err(ApiError::BadRequest)?;
    } else if def.key == "pool_stale_timeout_seconds" {
        let stale_seed = state.settings.seed_of(def.key).expect("mutable key has seed") as u64;
        crate::settings::check_heartbeat_pair(state.settings.pool_heartbeat_interval_seconds(), stale_seed)
            .map_err(ApiError::BadRequest)?;
    }
```

- [ ] **Step 10: 통합 테스트 통과 확인** — Run: `cargo test -p handicap-controller --test settings_api_test 2>&1 | tail -30`. Expected: 전부 PASS(신규 4 + 기존).

- [ ] **Step 11: 커밋** — Run(foreground, no pipe): 
```bash
git add crates/controller/src/settings.rs crates/controller/src/api/settings.rs crates/controller/tests/settings_api_test.rs
git commit -m "feat(lan-ops/t1): 하트비트 임계값 settings 레지스트리 3행 + accessor + stale>interval 교차필드 가드(PUT/DELETE)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
직후 `git log -1 --oneline`로 landed 확인.

---

### Task 2: (byte-identical 리팩터) AppState 2필드 제거 + 대시보드 settings 소스 + 3 시드 + startup clamp

**Files:**
- Modify: `crates/controller/src/api/pool.rs` (`list_workers`가 settings accessor 읽기)
- Modify: `crates/controller/src/main.rs` (3 시드 + R5c startup clamp; AppState 생성에서 2필드 제거)
- Modify: `crates/controller/src/app.rs` (`AppState` struct에서 2필드 제거)
- Modify: 모든 `AppState { … }` literal 사이트(컴파일러-driven, ~50: `tests/*.rs` + `runs.rs`/`schedule/runner.rs` 인라인 fixture)
- Test: `crates/controller/tests/pool_api_test.rs` (대시보드가 settings override 반영)

**Interfaces:**
- Consumes: Task 1의 `pool_heartbeat_interval_seconds()`/`pool_stale_timeout_seconds()`/`check_heartbeat_pair`.
- Produces: `AppState`에 `heartbeat_interval_seconds`/`stale_timeout_seconds` 필드 **없음**(settings가 단일 소스). 리퍼는 이 task에서 미변경(아직 `args` Duration 사용) → 동작 byte-identical.

- [ ] **Step 1: 통합 테스트 작성 (pool_api_test.rs)** — 이 파일은 이미 `make_app`(:13)·`send`(:34) 헬퍼를 가지므로 그대로 재사용한다. **단, import가 `use serde_json::Value;`만이라 `use serde_json::{Value, json};`로 확장**(신규 테스트가 `json!` 사용). **이 test-path 편집이 Task 2의 src 편집을 tdd-guard에서 unblock한다.**

```rust
/// 대시보드 임계값은 settings 유효값에서 온다 — PUT override가 GET /api/pool/workers에 반영(R3).
#[tokio::test]
async fn dashboard_reflects_heartbeat_settings_override() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);
    // stale 먼저 올리고(99 > 10) interval(15 < 99) — 유효 순서.
    let (s1, _) = send(&app, Method::PUT, "/api/settings/pool_stale_timeout_seconds", Some(json!({ "value": 99 }))).await;
    assert_eq!(s1, StatusCode::OK);
    let (s2, _) = send(&app, Method::PUT, "/api/settings/pool_heartbeat_interval_seconds", Some(json!({ "value": 15 }))).await;
    assert_eq!(s2, StatusCode::OK);

    let (status, body) = send(&app, Method::GET, "/api/pool/workers", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["heartbeat_interval_seconds"], 15);
    assert_eq!(body["stale_timeout_seconds"], 99);
}
```

> pool_api_test.rs의 `make_app`은 이 Step에서 아직 `heartbeat_interval_seconds: 10, stale_timeout_seconds: 30`을 포함(Step 7에서 제거). 이 파일엔 `make_app`·`make_app_with_coord_pool` 두 fixture가 있어 둘 다 정리 대상(Step 7).

- [ ] **Step 2: 실패 확인** — Run: `cargo test -p handicap-controller --test pool_api_test 2>&1 | tail -30`. Expected: `dashboard_reflects...` FAIL(대시보드가 AppState 고정 10/30을 읽어 override 무시).

- [ ] **Step 3: 대시보드가 settings를 읽도록 (api/pool.rs `list_workers`)** — `Json(PoolWorkersResponse { ... })`의 두 필드 교체:

```rust
        heartbeat_interval_seconds: state.settings.pool_heartbeat_interval_seconds(),
        stale_timeout_seconds: state.settings.pool_stale_timeout_seconds(),
```
(기존 `state.heartbeat_interval_seconds`/`state.stale_timeout_seconds` 대체.)

- [ ] **Step 4: main.rs — 3 시드 + R5c startup clamp** — `SettingsState::build` 호출 *앞*에 clamp 계산 추가:

```rust
    // R5(c): build()는 CLI 시드를 range-check 안 하므로(§3.6), stale ≤ interval 시드를
    // 여기서 clamp(+warn)해 startup이 destructive flapping 상태로 부팅하는 걸 막는다.
    let pool_interval_seed = args.pool_heartbeat_interval_seconds;
    let pool_stale_seed = if args.pool_stale_timeout_seconds <= pool_interval_seed {
        tracing::warn!(
            interval = pool_interval_seed,
            stale = args.pool_stale_timeout_seconds,
            "stale ≤ interval 시드 — interval+1로 clamp"
        );
        pool_interval_seed + 1
    } else {
        args.pool_stale_timeout_seconds
    };
```

그리고 `SettingsState::build`의 `cli_seeds` 슬라이스에 3행 추가:

```rust
            ("worker_capacity_vus", args.worker_capacity_vus as i64),
            ("dataset_max_rows", args.dataset_max_rows as i64),
            ("scheduler_tick_seconds", args.scheduler_tick_seconds as i64),
            ("pool_heartbeat_interval_seconds", pool_interval_seed as i64),
            ("pool_stale_timeout_seconds", pool_stale_seed as i64),
            ("pool_keepalive_seconds", args.pool_keepalive_seconds as i64),
```

- [ ] **Step 5: main.rs — AppState 생성에서 2필드 제거** — `let state = app::AppState { ... }`에서 다음 두 줄 삭제:

```rust
        heartbeat_interval_seconds: args.pool_heartbeat_interval_seconds,
        stale_timeout_seconds: args.pool_stale_timeout_seconds,
```
> 리퍼 spawn 블록(`if coord_state.is_pool_mode() { ... }`)은 **이 task에서 미변경** — 여전히 `args.pool_heartbeat_interval_seconds`/`args.pool_stale_timeout_seconds`로 `interval`/`stale` Duration을 만들어 쓴다(byte-identical). 런타임 재읽기는 Task 3.

- [ ] **Step 6: app.rs — AppState struct에서 2필드 제거** — `pub heartbeat_interval_seconds: u64,`와 `pub stale_timeout_seconds: u64,` 및 각 doc 주석 삭제.

- [ ] **Step 7: 모든 AppState literal 사이트 정리** — Run: `grep -rln "stale_timeout_seconds:" crates/controller` 로 잔존 사이트를 찾아, 각 **`AppState { … }`** literal에서 `heartbeat_interval_seconds: …,`·`stale_timeout_seconds: …,` 두 줄을 삭제(컴파일러가 "no field" 에러로 전부 지목). 대상: `tests/*.rs` 다수(`pool_api_test.rs`의 `make_app`·`make_app_with_coord_pool` 둘 다·`settings_api_test.rs`의 `make_app` 포함) + `src/api/runs.rs` 인라인 fixture(`state_with`) + `src/schedule/runner.rs` 인라인 fixture(`test_state`). `src/main.rs`(Step 5)·`src/app.rs`(Step 6)는 이미 처리. **⚠ `src/api/pool.rs`는 제외** — 거기 `heartbeat_interval_seconds:`/`stale_timeout_seconds:` 매치는 `PoolWorkersResponse { … }` DTO 필드(Step 3에서 RHS만 `state.settings.*`로 교체, 필드 자체는 유지)지 `AppState` literal이 아니다(삭제 금지).

- [ ] **Step 8: 전체 빌드 + 테스트 통과 확인** — Run: `cargo build -p handicap-worker --bin worker && cargo test -p handicap-controller 2>&1 | tail -30`. Expected: 전부 PASS(`dashboard_reflects...` 포함). 잔존 literal 누락이 있으면 "no field" 컴파일 에러로 드러남 → Step 7 반복.

- [ ] **Step 9: grep으로 AppState 필드 제거 확인** — Run: `grep -rc "heartbeat_interval_seconds:" crates/controller/src/app.rs`. Expected: `0`(struct에서 제거됨). `grep -rn "state\.heartbeat_interval_seconds\|state\.stale_timeout_seconds" crates/controller/src` → 0(모두 settings accessor 경유).

- [ ] **Step 10: 커밋** — foreground, no pipe:
```bash
git add crates/controller/src/api/pool.rs crates/controller/src/main.rs crates/controller/src/app.rs crates/controller/src/api/runs.rs crates/controller/src/schedule/runner.rs crates/controller/tests
git commit -m "refactor(lan-ops/t2): AppState 하트비트 2필드 제거→settings 단일소스(대시보드 accessor)+3 시드+startup clamp (byte-identical)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
직후 `git log -1 --oneline` 확인.

---

### Task 3: (동작 변경) 리퍼 try_send + interval clamp + settings 런타임 재읽기

**Files:**
- Modify: `crates/controller/src/grpc/coordinator.rs` (`pool_heartbeat_tick`의 Ping 전송 `try_send` + 인라인 테스트 2종)
- Modify: `crates/controller/src/main.rs` (리퍼 클로저: `settings.clone()` 캡처 + sleep-per-iter 재읽기 + `.max(1)`)

**Interfaces:**
- Consumes: Task 1의 accessor 2종; `pool_heartbeat_tick(now, stale)` 시그니처는 **불변**(R8은 내부 send 한 줄만 변경).
- tdd-guard: `coordinator.rs`·`main.rs` 둘 다 인라인 `#[cfg(test)]`가 있어 자동 통과(keepalive·test-path 선편집 불요).

- [ ] **Step 1: try_send 단위 테스트 작성 (coordinator.rs `mod tests`)** — 기존 `fresh_idle_pinged_not_evicted` 옆에 추가(같은 `pool_register_idle("w1", tx, 10, "h".into())` 헬퍼 사용):

```rust
    #[tokio::test]
    async fn full_channel_skips_not_evicts() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let coord = CoordinatorState::new(db);
        let (tx, _rx) = tokio::sync::mpsc::channel(32);
        // Fill the bounded channel so the reaper's try_send returns Full.
        let filler = tx.clone();
        for _ in 0..32 {
            filler
                .try_send(Ok(ServerMessage { payload: None }))
                .expect("prefill");
        }
        coord.pool_register_idle("w1", tx, 10, "h".into()).await;
        tokio::time::pause();
        tokio::time::advance(std::time::Duration::from_secs(10)).await; // fresh (< stale 30)
        coord
            .pool_heartbeat_tick(tokio::time::Instant::now(), std::time::Duration::from_secs(30))
            .await;
        assert_eq!(coord.pool_idle_count().await, 1, "Full channel → skip, not evict");
    }

    #[tokio::test]
    async fn closed_channel_evicts() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let coord = CoordinatorState::new(db);
        let (tx, rx) = tokio::sync::mpsc::channel(32);
        coord.pool_register_idle("w1", tx, 10, "h".into()).await;
        drop(rx); // close the channel → try_send returns Closed
        tokio::time::pause();
        tokio::time::advance(std::time::Duration::from_secs(10)).await; // fresh; eviction must come from Closed, not stale
        coord
            .pool_heartbeat_tick(tokio::time::Instant::now(), std::time::Duration::from_secs(30))
            .await;
        assert_eq!(coord.pool_idle_count().await, 0, "Closed channel → evict");
    }
```

> `ServerMessage`/`ServerPayload`는 이 모듈 스코프에서 이미 import됨(기존 테스트가 `super::ServerPayload::Ping` 사용). `pool_idle_count`/`pool_register_idle`는 기존 테스트가 쓰는 헬퍼.

- [ ] **Step 2: 실패 확인** — Run: `timeout 30 cargo test -p handicap-controller --lib coordinator::tests::full_channel_skips_not_evicts coordinator::tests::closed_channel_evicts 2>&1 | tail -20`. Expected: `full_channel_skips_not_evicts`는 현 `send().await`가 full 채널에 영영 backpressure 대기 → **hang(= `timeout`이 kill, RED)**. `closed_channel_evicts`는 현재도 PASS일 수 있음(닫힌 채널 send→Err→evict 기존 동작). **핵심 RED는 full-channel hang** — `timeout`으로 감싸 세션이 멈추지 않게(전체 게이트로 RED 확인 금지: 멈춘다).

> `full_channel_skips_not_evicts`의 hang이 곧 현행 `send().await` head-of-line 증상(D1) — Step 3 try_send 적용 후 즉시 반환으로 해소돼 PASS.

- [ ] **Step 3: `pool_heartbeat_tick` try_send 적용 (coordinator.rs)** — fresh 워커 ping 전송부 `if tx.send(Ok(ping)).await.is_err() { self.pool_disconnect(&wid).await; }`를 교체:

```rust
        match tx.try_send(Ok(ping)) {
            Ok(()) => {}
            // Closed = stream gone → evict (현 dead-tx 의미 유지).
            Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => {
                self.pool_disconnect(&wid).await;
            }
            // Full = 일시적 backpressure(워커가 안 읽음). evict 안 함 — last_seen 미갱신이라
            // 다음 sweep stale 체크 + h2 keepalive가 죽은 연결을 자가치유(R8).
            Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => {}
        }
```
> R14 락 규율(스냅샷 락 안 `.await` 0 → 락 밖 send/evict)·stale evict 분기·`pool_disconnect` 라우팅은 무변경. 시그니처 `(now, stale)` 불변.

- [ ] **Step 4: 단위 테스트 통과 확인** — Run: `cargo test -p handicap-controller --lib coordinator:: 2>&1 | tail -30`. Expected: 신규 2 + 기존 pool_heartbeat 테스트(`fresh_idle_pinged_not_evicted`·`stale_idle_evicted`·`stale_busy_routes_worker_disconnected`·`double_evict_idempotent`) 전부 PASS.

- [ ] **Step 5: main.rs 리퍼 런타임 재읽기 (settings.clone 캡처 + sleep-per-iter + clamp)** — `if coord_state.is_pool_mode() { ... }` 블록 전체를 교체:

```rust
    if coord_state.is_pool_mode() {
        let coord = coord_state.clone();
        let settings = state.settings.clone(); // R2: 매 sweep 임계값 fresh 재읽기 위해 캡처
        tokio::spawn(async move {
            loop {
                // R9: interval 0(시드 우회)이어도 tight-loop 방지.
                let interval = settings.pool_heartbeat_interval_seconds().max(1);
                let stale = settings.pool_stale_timeout_seconds();
                tokio::time::sleep(std::time::Duration::from_secs(interval)).await;
                coord
                    .pool_heartbeat_tick(
                        tokio::time::Instant::now(),
                        std::time::Duration::from_secs(stale),
                    )
                    .await;
            }
        });
        tracing::info!(
            interval_s = settings.pool_heartbeat_interval_seconds(),
            stale_s = settings.pool_stale_timeout_seconds(),
            keepalive_s = args.pool_keepalive_seconds,
            "pool heartbeat reaper started (runtime-tunable)"
        );
    }
```
> `state.settings.clone()`은 `app::router(state)`(state 소비)보다 *앞*이라 안전. `MissedTickBehavior::Skip` + `tokio::time::interval`은 sleep-per-iter로 대체(catch-up 불요, spec §7).

- [ ] **Step 6: 빌드 확인** — Run: `cargo build -p handicap-controller 2>&1 | tail -20`. Expected: clean build.

- [ ] **Step 7: 커밋** — foreground, no pipe:
```bash
git add crates/controller/src/grpc/coordinator.rs crates/controller/src/main.rs
git commit -m "fix(lan-ops/t3): 리퍼 try_send(Full=skip/Closed=evict, D1)+interval .max(1) clamp(D2)+settings 런타임 재읽기(R2)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
직후 `git log -1 --oneline` 확인.

---

### Task 4: `/settings` UI — 3행 자동 렌더 + 페이지-레벨 2× 경고 + 하트비트 적용 안내

**Files:**
- Modify: `ui/src/pages/SettingsPage.tsx` (페이지-레벨 note 영역)
- Modify: `ui/src/i18n/ko.ts` (`opsSettings`에 label/desc/effect 3키 + `heartbeatMarginHint`/`heartbeatApplyNote`)
- Test: `ui/src/pages/__tests__/SettingsPage.test.tsx` (기존 파일에 신규 케이스)

**Interfaces:**
- Consumes: GET `/api/settings`가 이제 3 신규 행 반환(Task 1). UI는 `mutable`/`readonly` 분할로 자동 렌더 — 행 추가에 코드 변경 불요. 신규 작업 = 페이지-레벨 경고/안내뿐.

- [ ] **Step 1: 테스트 작성 (SettingsPage.test.tsx)** — **test 파일 먼저**(tdd-guard). 기존 SettingsPage.test.tsx의 fetch/hook mock 셋업을 그대로 따라(`useSettings` 결과 fixture에 두 하트비트 mutable 행 포함) 추가. 두 행이 `stale < 2×interval`인 fixture와 `≥`인 fixture로 경고 노출/미노출을 단언:

```tsx
// fixture rows (mirror existing MUTABLE_ROW shape):
//   interval: {key:"pool_heartbeat_interval_seconds", value:20, ... mutable:true}
//   stale:    {key:"pool_stale_timeout_seconds", value:30, ... mutable:true}  // 30 < 2*20=40 → 경고
it("shows 2x margin hint when stale < 2x interval", async () => {
  // render SettingsPage with useSettings → [interval(20), stale(30), ...]
  expect(await screen.findByText(ko.opsSettings.heartbeatMarginHint)).toBeInTheDocument();
});

it("hides 2x margin hint when stale >= 2x interval", async () => {
  // render with stale(60) → 60 >= 2*20 → no hint
  expect(screen.queryByText(ko.opsSettings.heartbeatMarginHint)).not.toBeInTheDocument();
});

it("shows heartbeat apply note (overrides global next-run banner)", async () => {
  // render with the two heartbeat rows present
  expect(await screen.findByText(ko.opsSettings.heartbeatApplyNote)).toBeInTheDocument();
});
```

> 기존 SettingsPage.test.tsx가 `useSettings`를 `vi.mock("../../api/hooks")`로 스텁하는지, fetch를 mock하는지 확인해 같은 방식으로 fixture 주입(커스텀 에러 클래스 없으니 bare auto-mock 무방). `ko`는 `../../i18n/ko`.

- [ ] **Step 2: 실패 확인** — Run: `cd ui && pnpm test SettingsPage 2>&1 | tail -25`. Expected: 신규 3 FAIL(`heartbeatMarginHint`/`heartbeatApplyNote` 키 부재 → `ko.opsSettings.heartbeatMarginHint`가 `undefined`라 `findByText(undefined)` throw, 그리고 렌더 영역 부재).

- [ ] **Step 3: ko.ts 키 추가 (opsSettings)** — `opsSettings`에 추가: `desc`/`effect`에 3키, 그리고 최상위 2개 안내 키:

```ts
    heartbeatMarginHint:
      "권장: stale 타임아웃을 ping 주기의 2배 이상으로 두세요. 너무 가까우면 일시적 지연에도 건강한 워커가 응답 없음으로 잘못 처리될 수 있습니다.",
    heartbeatApplyNote:
      "하트비트 ping 주기·stale 타임아웃은 진행 중인 풀에 다음 하트비트 점검부터 즉시 적용됩니다(위 '다음 run부터' 안내는 이 두 값엔 해당하지 않음).",
```
`desc`에:
```ts
      pool_heartbeat_interval_seconds: "풀 컨트롤러가 유휴/실행 중 워커에 ping을 보내는 주기(초).",
      pool_stale_timeout_seconds: "이 시간(초) 동안 워커 응답(pong)이 없으면 풀에서 제외합니다. ping 주기보다 충분히 커야 합니다.",
      pool_keepalive_seconds: "컨트롤러 gRPC 서버측 HTTP/2 keepalive 주기(초). 배포 설정(재시작 필요).",
```
`effect`에(2× 여유·readonly 특성 반영):
```ts
      pool_heartbeat_interval_seconds:
        "⬆ 올리면 ping이 뜸해져 네트워크 부담이 줄지만, 죽은 워커 감지가 느려집니다.\n⬇ 내리면 빨리 감지하지만 ping이 잦아집니다. stale 타임아웃을 항상 이 값의 2배 이상으로 유지하세요.",
      pool_stale_timeout_seconds:
        "⬆ 올리면 느린 워커에 관대해지지만 죽은 워커가 오래 남습니다.\n⬇ 내리면 빨리 정리하지만, ping 주기에 너무 가까우면 건강한 워커를 잘못 제외합니다(최소 2배 권장).",
```
> keepalive는 readonly라 `effect` 키 불요(SettingsPage가 readonly 행엔 effect HelpTip을 안 그림). `label`은 레지스트리(Task 1)가 소유 — ko.label 별도 키 없음(DTO `label` 사용). desc는 mutable 행만 렌더되나 readonly keepalive도 desc는 안 그려도 무방(SettingsPage readonly 행은 label+value만). 즉 keepalive desc는 옵션 — 넣어도 무해.

- [ ] **Step 4: SettingsPage.tsx 페이지-레벨 note 영역 추가** — mutable `<section>`의 `</ul>` 바로 뒤(`</section>` 앞)에, 두 하트비트 값을 읽어 표시하는 note 블록 추가:

```tsx
{(() => {
  const find = (k: string) => settings?.find((s) => s.key === k);
  const intervalRow = find("pool_heartbeat_interval_seconds");
  const staleRow = find("pool_stale_timeout_seconds");
  if (!intervalRow || !staleRow) return null;
  const num = (s: Setting) => {
    const d = s.key in drafts ? drafts[s.key] : String(s.value);
    const n = Number(d);
    return Number.isInteger(n) ? n : s.value;
  };
  const interval = num(intervalRow);
  const stale = num(staleRow);
  return (
    <div className="mt-3 space-y-1">
      <p className="text-xs text-slate-500">{ko.opsSettings.heartbeatApplyNote}</p>
      {stale < 2 * interval && (
        <p role="note" className="text-xs text-amber-700">
          {ko.opsSettings.heartbeatMarginHint}
        </p>
      )}
    </div>
  );
})()}
```
> `Setting` 타입은 이미 import됨(`import type { Setting } from "../api/settings"`). draft 우선·없으면 value로 계산(저장 전 입력에도 즉시 반영). 비차단(저장 버튼과 무관).
>
> **정리(reviewer nit)**: 같은 파일 line ~147의 `{/* R12 — apply-note banner */}` 주석은 *ops-config* spec의 R-id 잔재 → 이 task에서 `{/* apply-note banner */}` 등으로 정정(R-id 혼동 방지).

- [ ] **Step 5: 테스트 통과 확인** — Run: `cd ui && pnpm test SettingsPage 2>&1 | tail -25`. Expected: 신규 3 + 기존 전부 PASS.

- [ ] **Step 6: UI 게이트 + 커밋** — Run: `cd ui && pnpm lint && pnpm test && pnpm build 2>&1 | tail -15`(전체 green). 그 뒤 foreground 커밋:
```bash
git add ui/src/pages/SettingsPage.tsx ui/src/i18n/ko.ts ui/src/pages/__tests__/SettingsPage.test.tsx
git commit -m "feat(lan-ops/t4): /settings 하트비트 3행 desc/effect + 페이지-레벨 2× 경고 + 적용시점 안내

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
직후 `git log -1 --oneline` 확인.

---

### Task 5: `/workers` 제어 mutation 에러 — 컨텍스트 인라인 + undrain 페이지 배너

**Files:**
- Modify: `ui/src/api/pool.ts` (`patchPoolWorker`/`excludePoolWorker`가 서버 `{error}` 본문을 메시지로)
- Modify: `ui/src/pages/WorkerDashboardPage.tsx` (`ConfirmDialog`/`EditModal`에 `error`/`pending` prop; `RowActions` onError; undrain 페이지 배너)
- Modify: `ui/src/i18n/ko.ts` (`workers`에 `actionError`/`bannerDismiss`/`pending`)
- Test: `ui/src/pages/__tests__/WorkerDashboardPage.test.tsx` (기존 파일에 신규 케이스)

**Interfaces:**
- Consumes: `usePatchPoolWorker`/`useExcludePoolWorker`(기존, `mutate(arg, {onSuccess, onError})` 지원). `patchPoolWorker`/`excludePoolWorker`는 이 task에서 에러 메시지를 서버 본문으로 개선.

- [ ] **Step 1: 테스트 작성 (WorkerDashboardPage.test.tsx)** — test 먼저(tdd-guard). 기존 파일의 mock 셋업(usePoolWorkers fixture + hooks mock)을 따라 추가. exclude 실패 시 alertdialog 내 에러·잔존, undrain 실패 시 페이지 배너:

```tsx
it("shows inline error in exclude dialog on failure and keeps it open", async () => {
  const user = userEvent.setup();
  // mock useExcludePoolWorker → mutate(arg, {onError}) calls onError(new Error("제외 실패"))
  // render WorkerDashboardPage with one idle worker
  // open actions menu → click 제외 → click 계속
  await user.click(screen.getByLabelText(ko.workers.actionsLabel));
  await user.click(screen.getByRole("menuitem", { name: ko.workers.exclude }));
  await user.click(screen.getByRole("button", { name: ko.workers.confirmProceed }));
  expect(await screen.findByText("제외 실패")).toBeInTheDocument();
  expect(screen.getByRole("alertdialog")).toBeInTheDocument(); // still open
});

it("shows page banner when undrain fails", async () => {
  const user = userEvent.setup();
  // worker fixture with drained:true; mock usePatchPoolWorker → onError(new Error("되돌리기 실패"))
  await user.click(screen.getByLabelText(ko.workers.actionsLabel));
  await user.click(screen.getByRole("menuitem", { name: ko.workers.undrain }));
  const banner = await screen.findByRole("alert");
  expect(banner).toHaveTextContent("되돌리기 실패");
  await user.click(screen.getByRole("button", { name: ko.workers.bannerDismiss }));
  expect(screen.queryByText("되돌리기 실패")).not.toBeInTheDocument();
});
```
> 기존 WorkerDashboardPage.test.tsx의 hooks mock 방식(아마 `vi.mock("../../api/hooks")` + `usePatchPoolWorker.mockReturnValue({ mutate, isPending:false })`)을 그대로 따른다. `mutate`를 `(arg, opts) => opts?.onError?.(new Error("..."))`로 스텁해 실패 경로를 만든다.

- [ ] **Step 2: 실패 확인** — Run: `cd ui && pnpm test WorkerDashboardPage 2>&1 | tail -25`. Expected: 신규 2 FAIL(현재 fire-and-forget — 다이얼로그가 즉시 닫히고 에러 미표시; `bannerDismiss` 키 부재).

- [ ] **Step 3: ko.ts 키 추가 (workers)** — `workers` 블록에:
```ts
    actionError: (msg: string) => `작업 실패: ${msg}`,
    bannerDismiss: "닫기",
    pending: "처리 중…",
```

- [ ] **Step 4: pool.ts 에러 메시지를 서버 본문으로** — `patchPoolWorker`/`excludePoolWorker`의 `throw new Error(\`patch worker ${res.status}\`)`를 서버 `{error}` 추출로 교체(settings.ts `errorMessage` 미러). 파일 상단에 헬퍼 추가:

```ts
async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as unknown;
    if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
      return body.error;
    }
  } catch {
    /* non-JSON */
  }
  return `HTTP ${res.status}`;
}
```
그리고 두 함수의 `if (!res.ok) throw new Error(...)`를 `if (!res.ok) throw new Error(await errorMessage(res));`로.

- [ ] **Step 5: WorkerDashboardPage.tsx — ConfirmDialog/EditModal에 error/pending prop** — 두 컴포넌트 props 타입에 `error?: string | null; pending?: boolean;` 추가. `ConfirmDialog` 본문(`warn` 블록 뒤, 버튼 div 앞)에:
```tsx
{error ? (
  <p role="alert" className="mb-3 rounded bg-red-50 px-3 py-2 text-sm text-red-700">
    {error}
  </p>
) : null}
```
proceed 버튼에 `disabled={pending}` + 라벨 `{pending ? ko.workers.pending : ko.workers.confirmProceed}`. `EditModal`도 동일 패턴(에러 줄 + apply 버튼 `disabled={pending}`/라벨).

- [ ] **Step 6: WorkerDashboardPage.tsx — RowActions onError + 페이지 배너** — 
  - `RowActions`에 로컬 `const [actionError, setActionError] = useState<string | null>(null);` 추가, `onToggle`/다이얼로그 open 시 `setActionError(null)`.
  - 4 dialog/modal 액션의 `mutate`를 fire-and-forget → 콜백형으로. 예 exclude:
    ```tsx
    onProceed={() => {
      setActionError(null);
      exclude.mutate(
        { id: worker.worker_id, reason: "" },
        { onSuccess: closeAll, onError: (e: Error) => setActionError(ko.workers.actionError(e.message)) },
      );
    }}
    ```
    drain/capacity/label도 동형(`patch.mutate(arg, { onSuccess: closeAll, onError: ... })`, 동기 `closeAll()` 제거). 각 `<ConfirmDialog>`/`<EditModal>`에 `error={actionError}` + `pending={exclude.isPending}`(또는 `patch.isPending`) 전달.
    - **⚠ capacity 모달은 기존 `if (val==="")`(→ `capacity_override: null`)·`Number.isFinite(n)` 가드 구조를 보존**한다 — exclude 템플릿으로 통째 치환 금지. 두 분기(빈 문자열 clear·유효 숫자 set) *각각*의 `mutate`만 `{ onSuccess: closeAll, onError: setActionError }`로 바꾸고, **non-finite(NaN) 입력은 현행대로 no-op**(모달 유지·PATCH 미발사·silent clear 방지) 유지.
  - **undrain(메뉴-직접, 다이얼로그 없음)**: 페이지 레벨 콜백 사용. `RowActions` props에 `onActionError: (msg: string) => void` 추가, undrain `MenuItem`의 `patch.mutate({ id, body:{ drained:false } })`를 `patch.mutate({ id, body:{ drained:false } }, { onError: (e: Error) => onActionError(ko.workers.actionError(e.message)) })`로.
  - `WorkerDashboardPage`(부모): `const [bannerError, setBannerError] = useState<string | null>(null);`, 테이블 위에 배너:
    ```tsx
    {bannerError ? (
      <div role="alert" className="mb-3 flex items-center justify-between rounded bg-red-50 px-3 py-2 text-sm text-red-700">
        <span>{bannerError}</span>
        <button type="button" aria-label={ko.workers.bannerDismiss} onClick={() => setBannerError(null)} className="ml-3 text-red-600 hover:underline">
          {ko.workers.bannerDismiss}
        </button>
      </div>
    ) : null}
    ```
    그리고 `<RowActions ... onActionError={setBannerError} />` 전달.

- [ ] **Step 7: 테스트 통과 확인** — Run: `cd ui && pnpm test WorkerDashboardPage 2>&1 | tail -25`. Expected: 신규 2 + 기존 전부 PASS.

- [ ] **Step 8: UI 게이트 + 커밋** — Run: `cd ui && pnpm lint && pnpm test && pnpm build 2>&1 | tail -15`(전체 green). foreground 커밋:
```bash
git add ui/src/api/pool.ts ui/src/pages/WorkerDashboardPage.tsx ui/src/i18n/ko.ts ui/src/pages/__tests__/WorkerDashboardPage.test.tsx
git commit -m "feat(lan-ops/t5): /workers 제어 mutation 에러 컨텍스트 인라인(다이얼로그/모달)+undrain 페이지 배너+서버 에러 본문 surface

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
직후 `git log -1 --oneline` 확인.

---

## 라이브 검증 (머지 전 필수 — R2/R7, Task 3 main-only)

`/live-verify` 스택으로 실 controller + 풀 2워커를 짧은 임계값으로 띄워 확인:

1. **빌드**: 워크트리에서 `cargo build -p handicap-worker --bin worker && cargo build -p handicap-controller --bin controller`.
2. **기동**: `./target/debug/controller --db /tmp/lanops.db --ui-dir ui/dist --worker-mode pool --pool-heartbeat-interval-seconds 2 --pool-stale-timeout-seconds 6 --pool-keepalive-seconds 4`(+ 워커 2대를 같은 grpc로 풀 등록). UI 빌드 필요 시 `just ui-build`.
3. **R2 (런타임 재읽기)**: 로그 "pool heartbeat reaper started (runtime-tunable) interval_s=2". `/settings`에서 `pool_heartbeat_interval_seconds`를 1→5로 PUT → 이후 sweep 간격이 ~5s로 바뀌는지 리퍼 로그로 확인.
4. **R5 (하드블록·startup)**: PUT `pool_stale_timeout_seconds`=1(현 interval≥1) → 400; 유효 순서(stale↑ 후 interval↑) → 200. 시작 시 `--pool-stale-timeout-seconds 1 --pool-heartbeat-interval-seconds 5`로 띄우면 "stale ≤ interval 시드 — interval+1로 clamp" warn 로그 + `/settings`에 stale=6 표시.
5. **R7 (byte-identical)**: 오버라이드 0 + 기본 임계값(interval 10/stale 30)으로 띄워 idle 워커 ping/evict 거동이 L6와 동일.
6. **R4 (keepalive readonly)**: `/settings`에서 `pool_keepalive_seconds`가 읽기전용("배포 설정")으로 표시·CLI 값(4) 노출.
7. **③ (선택, 게이트 아님)**: `/workers`에서 capacity 조정에 범위밖(예 0) 적용 → 편집 모달 내 인라인 에러; busy 아닌 워커 exclude를 끊긴 컨트롤러로 시도(또는 404 유발)해 인라인/배너 1회 육안 확인.
8. **정리**: `rm -rf .playwright-mcp` + 루트 png + `/tmp/lanops.db`.

---

## Self-Review (작성자 체크)

- **Spec 커버리지**: R1(Task1 SETTINGS 3행)·R2(Task3 재읽기·라이브)·R3(Task2 대시보드+필드제거)·R4(Task1 readonly 행+Task4 desc, 라이브 표시)·R5 a/b(Task1 PUT/DELETE)·R5c(Task2 startup clamp)·R6(Task4 경고+안내)·R7(Task2 byte-identical+라이브)·R8(Task3 try_send)·R9(Task3 .max(1))·R10(Task3 기존 단위 green)·R11(Task5 인라인)·R12(Task5 배너)·R13(Task4/5 ko 키)·R14(Global Constraints+grep). 전 R에 task 있음.
- **Placeholder 스캔**: 코드 블록 전부 실제 코드. UI 테스트는 기존 mock 셋업 mirror 지시(파일별 harness가 달라 정확 복제는 implementer가 기존 파일 보고 맞춤) — intent+단언+ko 키는 구체.
- **타입 일관성**: accessor `pool_heartbeat_interval_seconds()`/`pool_stale_timeout_seconds()`·`seed_of`·`check_heartbeat_pair`가 Task1 정의 ↔ Task2/3 사용 일치. ko 키 `heartbeatMarginHint`/`heartbeatApplyNote`(Task4)·`actionError`/`bannerDismiss`/`pending`(Task5) 정의=사용 일치.

---

## Execution Handoff

이 plan은 STOP-gate 대상(spec/plan을 이 세션에서 작성) → **커밋 후 `/clear` → fresh 컨텍스트에서 `superpowers:subagent-driven-development`로 task별 구현**. 모델 라우팅: Task 1·2·3은 동시성/요청실행/와이어를 건드리므로 code-quality 리뷰를 **Opus 승격**(path-gated), Task 4·5는 Sonnet 기본. 각 task 독립 green 커밋, task별 spec-compliance + code-quality 2단계 리뷰.

<!-- REVIEW-GATE: APPROVED -->
