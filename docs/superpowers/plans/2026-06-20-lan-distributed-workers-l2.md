# LAN 분산 워커 L2 (워커 대시보드 + RunDialog 풀 프리뷰) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

<!-- REVIEW-GATE: APPROVED -->
<!-- spec-plan-reviewer: spec APPROVE-WITH-FIXES(전부 반영·fact-verified) → plan APPROVE-WITH-FIXES(전부 반영) → 포커스 확인 패스 clean APPROVE(2026-06-20). 모든 finding 코드 대조 검증 후 반영. -->

**Goal:** L1 백엔드 워커 풀을 읽기전용 UI로 노출 — `/workers` 대시보드(연결 워커 hostname·유휴/Busy·capacity) + RunDialog 풀 프리뷰 + 워커 hostname 와이어 전파.
**Architecture:** 인메모리 `CoordinatorState.pool`에 읽기 접근자(`pool_snapshot`)를 더하고, 그걸 read-only REST(`GET /api/pool/workers`)로 노출한 뒤, React Query 폴링으로 대시보드+RunDialog가 소비한다. 워커는 register에 hostname(additive proto field)을 실어 식별성을 준다. 제어 액션·과부하·mTLS는 후속.
**Tech Stack:** Rust(tonic/prost, axum 0.8, tokio Mutex), `gethostname` 0.5; TypeScript/React(React Query v5, Zod, react-router).
**Spec:** `docs/superpowers/specs/2026-06-20-lan-distributed-workers-l2-design.md`

## Global Constraints

- **MSRV 1.85 / edition 2024.** 새 dep `gethostname = "0.5"`(0.5.0 resolve 확인됨, 워커 빌드 green) — `[workspace.dependencies]` + `crates/worker/Cargo.toml`.
- **migration 0 / 엔진(`crates/engine`) 0** — 풀은 인메모리(spec §5).
- **proto는 additive만**: `Register.hostname = 5`(field 1~4 무변경). prost 구조체는 exhaustive라 `Register{…}` 리터럴(client.rs:100) 1곳도 같은 커밋에서 갱신.
- **조건부 byte-identical(R9)**: `pool_mode` off AND hostname 빈 = pre-slice. 신규 REST 라우트 read-only(off=빈), UI 프리뷰는 `pool_mode` 게이트.
- **보안(R12·L1 S1/S2)**: 엔드포인트 DTO에 token/env/dataset 0. register 로그에 token 금지(기존 `token_set` bool 유지). 풀 스냅샷이 `tx` 노출 0.
- **UI 문구는 `ko.*` 경유(ADR-0035)** — 인라인 한국어/영어 0.
- **커밋**: cargo-영향 커밋마다 전체 워크스페이스 게이트(수분). `git add` 명시 경로만(`-A` 금지). subagent commit은 `run_in_background:false`+timeout 600000ms 단일 foreground(폴링 금지). 직후 `git log -1` 확인. 파이프 금지(exit code 마스킹).

---

## Requirement Coverage (R-id → Task) ⟵ 커버리지 게이트

| R-id | 요구사항 (요약) | 담당 Task | seam? |
|---|---|---|---|
| R1 | `pool_snapshot()` 읽기 접근자(tx 비노출·정렬 결정적) | Task 2 | |
| R2 | `GET /api/pool/workers` → `{pool_mode, workers[]}` (off=빈 200) | Task 3 (계약-먼저) | ✅ REST |
| R3 | proto `Register.hostname = 5` additive | Task 1 (계약-먼저) | ✅ proto |
| R4 | 워커가 hostname 시작 시 1회 resolve→register 운반(폴백 빈) | Task 1 | |
| R5 | `PoolEntry.hostname` + `pool_register_idle` 시그니처 + 핸들러 `reg.hostname` | Task 2 | |
| R6 | `/workers` 대시보드(usePoolWorkers 폴링·표·카운트·run 링크) | Task 4 | ✅ REST(Zod↔R2) |
| R7 | 빈-상태 2종 + 로딩/에러(role) | Task 4 | |
| R8 | RunDialog 풀-모드 프리뷰 배너(유휴 M·과부하 미표시) | Task 5 | |
| R9 | byte-identical(off+빈 hostname)·비-풀 RunDialog 불변 | Task 5 (+ 매 task 게이트) | ✅ proto additive |
| R10 | 신규 UI 문구 `ko.nav.workers`/`ko.workers` 경유 | Task 4 (+ Task 5 프리뷰 문구) | |
| R11 | 라이브니스=스트림(하트비트 없음)·half-open 캐비엇 런북 | Task 6 | |
| R12 | 엔드포인트 DTO token/env/dataset 0·tx 비노출 | Task 3 | |

- **계약-먼저**: R3(proto, Task 1)·R2(REST, Task 3)가 seam. Task 1→2→3 순서로 백엔드 계약을 먼저 freeze한 뒤 UI(Task 4/5).

---

## File Structure

| 파일 | 책임 | 변경 |
|---|---|---|
| `crates/proto/proto/coordinator.proto` | gRPC 계약 | `Register.hostname = 5` 추가 |
| `Cargo.toml` `[workspace.dependencies]` | dep 핀 | `gethostname = "0.5"` |
| `crates/worker/Cargo.toml` | 워커 dep | `gethostname = { workspace = true }` |
| `crates/worker-core/src/client.rs` | register I/O | `connect_and_register` hostname 인자 + `Register{…,hostname}` |
| `crates/worker-core/src/reconnect.rs` | backoff 연결 | `connect_with_backoff` hostname 인자 스레드 |
| `crates/worker/src/lib.rs` | 워커 진입 | `resolve_hostname()` + `run`/`run_pool`서 스레드 |
| `crates/controller/src/grpc/coordinator.rs` | 풀 레지스트리 | `PoolEntry.hostname`·`pool_register_idle` 시그니처·핸들러·`PoolWorkerInfo`·`pool_snapshot` |
| `crates/controller/src/api/pool.rs` (신규) | REST 핸들러 | `list_workers` + DTO |
| `crates/controller/src/api/mod.rs` | 모듈 등록 | `pub mod pool;` |
| `crates/controller/src/app.rs` | 라우터 | `.route("/pool/workers", get(...))` |
| `crates/controller/tests/pool_api_test.rs` (신규) | 통합 | 엔드포인트 on/off |
| `ui/src/api/pool.ts` (신규) | 클라+Zod | raw fetch + 인라인 스키마 |
| `ui/src/api/hooks.ts` | React Query | `queryKeys.poolWorkers`+`usePoolWorkers` |
| `ui/src/pages/WorkerDashboardPage.tsx` (신규) | 대시보드 | 표·빈-상태·카운트 |
| `ui/src/pages/__tests__/WorkerDashboardPage.test.tsx` (신규) | RTL | 행·빈-상태·에러 |
| `ui/src/routes.tsx` | 라우트 | `{path:"workers"}` |
| `ui/src/components/Layout.tsx` | 네비 | '워커' 링크 |
| `ui/src/components/RunDialog.tsx` | 프리뷰 | 풀-모드 배너 |
| `ui/src/components/__tests__/` (RunDialog 기존 test 확장) | RTL | 배너 표시/부재 |
| `ui/src/i18n/ko.ts` | 문구 | `nav.workers`+`workers` 네임스페이스 |
| `docs/dev/lan-workers.md` | 런북 | "풀 상태 보기" 절 |

**무변경(명시)**: `crates/engine`·migration·DB·리포트·CSV/XLSX/비교·메트릭 머지·shard_split·토큰 검사 로직·`schemas.ts`(per-resource 인라인 컨벤션)·기존 라우트·비-풀 RunDialog.
**TDD 가드 메모**: Rust — `coordinator.rs`·`lib.rs`는 인라인 `#[cfg(test)]` 보유(내용-변경 편집 자동통과). 단 **C-1 트랩**: 새 src 편집이 인라인-test-추가보다 먼저면 막힘 → orchestrator가 `crates/worker/tests/_tdd_keepalive.rs`·`crates/worker-core/tests/_tdd_keepalive.rs`·`crates/controller/tests/_tdd_keepalive.rs`(trivial `#[test] fn k(){}`)를 task 시작 전 깔아 unblock, implementer는 명시-경로 `git add`만(절대 `-A` 금지), task 끝나면 keepalive `rm`(커밋 안 됨). Task 3/4는 `tests/*.rs`·`*.test.tsx`를 먼저 만들므로 keepalive 불요(self-unblock). UI — 항상 `*.test.tsx`(RED)를 src보다 먼저 편집.
**커밋 경계 메모**: 각 task는 헬퍼+RED-test+구현을 **하나의 green 커밋으로 fold**(dead-code/RED 단독 커밋은 전체 게이트가 거부). Task 1은 proto+worker+client 리터럴이 한 컴파일 단위라 한 커밋. Task 2는 시그니처 변경+11 단위테스트 site(+핸들러 847)+신규 test 한 커밋.

---

## Task 1: proto `Register.hostname` + 워커 hostname 송신

**충족 R:** R3, R4
**Files:**
- Modify: `crates/proto/proto/coordinator.proto` — `Register`에 field 5
- Modify: `Cargo.toml` + `crates/worker/Cargo.toml` — `gethostname` dep
- Modify: `crates/worker-core/src/client.rs:80,100` — `connect_and_register` hostname 인자
- Modify: `crates/worker-core/src/reconnect.rs:35` — `connect_with_backoff` hostname 스레드
- Modify: `crates/worker/src/lib.rs` — `resolve_hostname()` + `run`(474)·`run_pool`(512) 호출

**Interfaces:**
- Produces: `connect_with_backoff(controller_url, worker_id, run_id, capacity_vus, token, hostname: &str, cancel)`; `connect_and_register(..., token, hostname: &str, cancel)`; `Register{worker_id, run_id, capacity_vus, token, hostname}`(prost). 컨트롤러는 Task 2에서 `reg.hostname`을 읽는다.

- [ ] **Step 1: proto field 추가**
  `crates/proto/proto/coordinator.proto`의 `Register`(현재 token=4까지)에 추가:
  ```proto
    string hostname = 5;      // worker machine hostname (LAN L2 display); "" = unset
  ```

- [ ] **Step 2: gethostname dep 추가**
  `Cargo.toml` `[workspace.dependencies]`(예: `futures = "0.3"` 줄 뒤)에 `gethostname = "0.5"`. `crates/worker/Cargo.toml` `[dependencies]`(`ulid = { workspace = true }` 줄 뒤)에 `gethostname = { workspace = true }`.

- [ ] **Step 3: `resolve_hostname()` + 워커 스레딩**
  `crates/worker/src/lib.rs`에 헬퍼 추가(`resolve_pool_worker_id` 근처):
  ```rust
  /// Best-effort machine hostname for pool dashboard display. Empty on
  /// failure / non-UTF8 (display-only; never load-bearing).
  fn resolve_hostname() -> String {
      gethostname::gethostname()
          .to_str()
          .map(str::to_owned)
          .unwrap_or_default()
  }
  ```
  `run()`(lib.rs:474 부근 `connect_with_backoff(...)` 호출)에서 `let hostname = resolve_hostname();`를 connect 호출 전에 두고, 인자 `args.token.as_deref().unwrap_or("")` **뒤·`cancel.clone()` 앞**에 `&hostname` 추가. `run_pool()`(lib.rs:503 `let worker_id = ...` 뒤)도 동일하게 `let hostname = resolve_hostname();` + `connect_with_backoff(..., token, &hostname, cancel.clone())`.
  `crates/worker-core/src/reconnect.rs:35` `connect_with_backoff` 시그니처에 `hostname: &str`을 `token: &str` 뒤에 추가하고, 내부 `connect_and_register(..., &token, &cancel_for_attempt)` 호출에 `hostname`을 `&token` 뒤로 전달(클로저 캡처 — `let hostname = hostname.to_string();`로 owned 캡처 후 `&hostname`).
  `crates/worker-core/src/client.rs:80` `connect_and_register` 시그니처에 `hostname: &str`을 `token: &str` 뒤에 추가하고, `Register{…}`(client.rs:100)에 `hostname: hostname.to_string(),` 추가. register 로그(client.rs:109)는 **변경 금지(token 미포함 유지)**.
  **Acceptance (R3):** `cargo build --workspace`(+`--features bundle`) green — prost가 `hostname=5` 생성, `Register` 리터럴 1곳 갱신으로 컴파일. 빈 hostname = wire 무변화.
  **Acceptance (R4):** 워커가 `resolve_hostname()`을 `run`/`run_pool`서 1회 호출해 `Register.hostname`에 운반(폴백 빈 문자열).

- [ ] **Step 4: 워커 단위테스트(resolve_hostname 폴백) — 인라인**
  `crates/worker/src/lib.rs`의 기존 `#[cfg(test)] mod tests`에 추가:
  ```rust
  #[test]
  fn resolve_hostname_returns_string_or_empty() {
      // 머신마다 값이 다르므로 "panic 없이 String 반환"만 단언(빈 폴백 포함 OK).
      let h = resolve_hostname();
      let _ = h.len(); // 호출이 패닉하지 않음
  }
  ```
  **Acceptance:** `cargo test -p handicap-worker resolve_hostname` PASS.

- [ ] **Step 5: 검증** — `cargo build -p handicap-worker && cargo build --workspace` 후 `cargo nextest run -p handicap-worker -p handicap-worker-core > /tmp/l2-t1.log 2>&1`; exit 0 확인. (controller는 아직 hostname 미사용 — 컴파일 green이어야 함.)

- [ ] **Step 6: 커밋** — `git add crates/proto/proto/coordinator.proto Cargo.toml Cargo.lock crates/worker/Cargo.toml crates/worker-core/src/client.rs crates/worker-core/src/reconnect.rs crates/worker/src/lib.rs` → 단일 foreground 커밋 `feat(lan): proto Register.hostname + 워커 hostname 송신 (L2 R3/R4)` → `git log -1`.

---

## Task 2: 컨트롤러 `PoolEntry.hostname` + `pool_snapshot` 읽기 접근자

**충족 R:** R1, R5
**Files:**
- Modify: `crates/controller/src/grpc/coordinator.rs` — PoolEntry(81-93)·pool_register_idle(300)·핸들러(847)·신규 `PoolWorkerInfo`·`pool_snapshot`

**Interfaces:**
- Consumes: `Register.hostname`(Task 1).
- Produces: `pub struct PoolWorkerInfo { pub worker_id: String, pub hostname: String, pub capacity_vus: u32, pub assigned_run: Option<String> }`; `pub async fn pool_snapshot(&self) -> Vec<PoolWorkerInfo>`(Task 3 엔드포인트가 소비).

- [ ] **Step 1: PoolEntry + pool_register_idle 시그니처**
  `PoolEntry`(coordinator.rs:81-93)에 필드 추가:
  ```rust
      /// Worker machine hostname (display-only; "" if unset). LAN L2.
      hostname: String,
  ```
  `pool_register_idle`(300)에 `hostname: String` 인자를 `capacity_vus: u32` 뒤에 추가하고 엔트리 생성 시 `hostname,` 저장. **핸들러(coordinator.rs:847)** `pool_register_idle(&reg.worker_id, tx.clone(), reg.capacity_vus, reg.hostname.clone())`로 갱신.
  **C-1/F1**: `pool_register_idle` 호출부는 총 12곳 = **인라인 단위테스트 11곳**(coordinator.rs `#[cfg(test)]` 내 `coord.pool_register_idle("w0", tx0, 100).await` 형태: 1206·1230·1248-49·1270 등) + **프로덕션 핸들러 1곳(847)**. 테스트 11곳엔 4번째 인자 `"host".into()`(또는 `String::new()`) 추가, **핸들러(847)는 `reg.hostname.clone()`** 전달. 기계적·동작 불변. `grep -n "pool_register_idle" crates/controller/src/grpc/coordinator.rs`로 전수 확인.

- [ ] **Step 2: `PoolWorkerInfo` + `pool_snapshot`**
  `pool_idle_count`(313) 근처에 추가:
  ```rust
  #[derive(Debug, Clone)]
  pub struct PoolWorkerInfo {
      pub worker_id: String,
      pub hostname: String,
      pub capacity_vus: u32,
      pub assigned_run: Option<String>,
  }

  /// Read-only snapshot of all connected pool workers for the dashboard
  /// (LAN L2 R1). Copies display fields under the lock; never exposes `tx`.
  pub async fn pool_snapshot(&self) -> Vec<PoolWorkerInfo> {
      let g = self.pool.lock().await;
      let mut out: Vec<PoolWorkerInfo> = g
          .iter()
          .map(|(id, e)| PoolWorkerInfo {
              worker_id: id.clone(),
              hostname: e.hostname.clone(),
              capacity_vus: e.capacity_vus,
              assigned_run: e.assigned_run.clone(),
          })
          .collect();
      drop(g);
      out.sort_by(|a, b| {
          (a.hostname.as_str(), a.worker_id.as_str())
              .cmp(&(b.hostname.as_str(), b.worker_id.as_str()))
      });
      out
  }
  ```
  (풀 락 타입이 `tokio::sync::Mutex`면 `.lock().await`, `std::sync::Mutex`면 `.lock().unwrap()` — `pool_idle_count` 구현과 동일 형태를 따를 것.)

- [ ] **Step 3: 단위테스트 — 인라인**
  coordinator.rs `#[cfg(test)] mod tests`에 추가:
  ```rust
  #[tokio::test]
  async fn pool_snapshot_lists_idle_and_busy() {
      let db = crate::store::connect("sqlite::memory:").await.unwrap();
      let coord = CoordinatorState::new(db);
      let (tx1, _r1) = fake_tx();
      let (tx2, _r2) = fake_tx();
      coord.pool_register_idle("wb", tx1, 100, "beta".into()).await;
      coord.pool_register_idle("wa", tx2, 200, "alpha".into()).await;
      // 한 워커를 busy로(reserve가 assigned_run=Some 마킹; DB run 행 불요 — 풀 맵만 건드림)
      let _ = coord.reserve_idle_pool("run-1", 1).await;
      let snap = coord.pool_snapshot().await;
      assert_eq!(snap.len(), 2);
      // 정렬: hostname alpha < beta (결정적)
      assert_eq!(snap[0].hostname, "alpha");
      assert_eq!(snap[1].hostname, "beta");
      // 정확히 하나가 busy(어느 워커인지는 비결정적이라 run_id로만 단언)
      let busy: Vec<_> = snap.iter().filter(|w| w.assigned_run.is_some()).collect();
      assert_eq!(busy.len(), 1);
      assert_eq!(busy[0].assigned_run.as_deref(), Some("run-1"));
  }

  #[tokio::test]
  async fn pool_register_stores_hostname() {
      let db = crate::store::connect("sqlite::memory:").await.unwrap();
      let coord = CoordinatorState::new(db);
      let (tx, _r) = fake_tx();
      coord.pool_register_idle("w1", tx, 50, "myhost".into()).await;
      let snap = coord.pool_snapshot().await;
      assert_eq!(snap[0].hostname, "myhost");
      assert_eq!(snap[0].capacity_vus, 50);
  }
  ```
  (`crate::store::connect("sqlite::memory:")` + `fake_tx()`(coordinator.rs:1434)는 기존 coordinator.rs 풀 단위테스트(1206 등)가 쓰는 idiom 그대로. `reserve_idle_pool`은 DB run 행 없이 풀 맵의 `assigned_run`만 마킹하므로 seed 불요.)
  **Acceptance (R1):** `pool_snapshot_lists_idle_and_busy` PASS — 유휴+busy 혼합·정렬 결정적·busy run_id 정확·`tx` 미노출(`PoolWorkerInfo`에 tx 필드 없음).
  **Acceptance (R5):** `pool_register_stores_hostname` PASS — hostname 저장·반환.

- [ ] **Step 4: 검증** — `cargo build -p handicap-worker && cargo build --workspace` 후 `cargo nextest run -p handicap-controller > /tmp/l2-t2.log 2>&1`; exit 0(12 call site 갱신으로 기존 풀 테스트 green 포함).

- [ ] **Step 5: 커밋** — `git add crates/controller/src/grpc/coordinator.rs` → 단일 foreground 커밋 `feat(lan): PoolEntry.hostname + pool_snapshot 읽기 접근자 (L2 R1/R5)` → `git log -1`.

---

## Task 3: REST `GET /api/pool/workers`

**충족 R:** R2, R12
**Files:**
- Create: `crates/controller/src/api/pool.rs`
- Modify: `crates/controller/src/api/mod.rs` — `pub mod pool;`
- Modify: `crates/controller/src/app.rs` — 라우트 + import
- Create: `crates/controller/tests/pool_api_test.rs`

**Interfaces:**
- Consumes: `state.coord.pool_snapshot()`·`is_pool_mode()`(Task 2).
- Produces: JSON `{ "pool_mode": bool, "workers": [{ "worker_id", "hostname", "capacity_vus", "busy", "run_id": string|null }] }`. UI(Task 4)가 Zod로 소비.

- [ ] **Step 1: 통합 테스트 먼저(RED)**
  `crates/controller/tests/pool_api_test.rs` 생성. **`make_app(db)->Router`(environments_api_test.rs:11)와 `send(&Router, Method, &str, Option<Value>)->(StatusCode, Value)`(environments_api_test.rs:30)를 그대로 복사**하고, coord 핸들을 공유하는 변형 `make_app_with_coord_pool`만 신규로 둔다:
  ```rust
  use axum::http::{Method, StatusCode};
  use serde_json::Value;
  use std::sync::Arc;
  use handicap_controller::{app, grpc::coordinator::CoordinatorState};
  use handicap_proto::v1::ServerMessage;
  use tonic::Status;

  // make_app(db)->Router, send(&app, Method, uri, Option<Value>)->(StatusCode, Value):
  // environments_api_test.rs:11/30에서 verbatim 복사(AppState 필드 6개·SubprocessDispatcher
  // 더미·SettingsState::build·scheduler_tz=UTC).

  /// make_app 변형: pool_mode=true + 공유 coord 핸들 반환(coord는 Clone+Arc 내부).
  async fn make_app_with_coord_pool() -> (axum::Router, CoordinatorState) {
      let db = handicap_controller::store::connect("sqlite::memory:").await.unwrap();
      let coord = CoordinatorState::new(db.clone());
      coord.set_pool_mode(true);
      // make_app 본체와 동일하되 이 coord.clone()을 AppState.coord로 주입(make_app을
      // (db, coord) 파라미터화하거나 본체를 인라인 복제).
      let app = app::router(app::AppState {
          db: db.clone(),
          coord: coord.clone(),
          dispatcher: Arc::new(handicap_controller::dispatcher::SubprocessDispatcher::new(
              "/nonexistent".to_string(), "127.0.0.1:0".parse().unwrap(), db,
          )),
          ui_dir: None,
          settings: handicap_controller::settings::SettingsState::build(
              &std::collections::HashMap::new(), &[],
          ),
          scheduler_tz: chrono_tz::UTC,
      });
      (app, coord)
  }

  #[tokio::test]
  async fn pool_workers_endpoint_off_returns_empty() {
      let db = handicap_controller::store::connect("sqlite::memory:").await.unwrap();
      let app = make_app(db); // pool_mode 미설정(기본 false)
      let (status, body) = send(&app, Method::GET, "/api/pool/workers", None).await;
      assert_eq!(status, StatusCode::OK);
      assert_eq!(body["pool_mode"], false);
      assert_eq!(body["workers"].as_array().unwrap().len(), 0);
  }

  #[tokio::test]
  async fn pool_workers_endpoint_lists() {
      let (app, coord) = make_app_with_coord_pool().await;
      // WorkerTx는 private alias지만 transparent — 동일 concrete 타입으로 직접 구성 가능.
      let (tx, _rx) = tokio::sync::mpsc::channel::<Result<ServerMessage, Status>>(8);
      coord.pool_register_idle("w1", tx, 100, "host-a".into()).await;
      let _ = coord.reserve_idle_pool("run-1", 1).await; // w1 busy 마킹(DB run 행 불요)
      let (status, body) = send(&app, Method::GET, "/api/pool/workers", None).await;
      assert_eq!(status, StatusCode::OK);
      assert_eq!(body["pool_mode"], true);
      let w = &body["workers"][0];
      assert_eq!(w["hostname"], "host-a");
      assert_eq!(w["busy"], true);
      assert_eq!(w["run_id"], "run-1");
      assert!(w.get("token").is_none()); // 보안(R12): token/env/dataset 키 부재
  }
  ```
  (`grpc::coordinator::CoordinatorState`·`app::{router,AppState}`는 pub(environments_api_test가 사용). `WorkerTx` alias가 private이어도 concrete `Sender<Result<ServerMessage,Status>>`로 호출 가능 — alias는 transparent. `ServerMessage` 경로는 빌드 에러 시 coordinator.rs:78의 import로 정정.)

- [ ] **Step 2: RED 확인** — `cargo test -p handicap-controller --test pool_api_test > /tmp/l2-t3r.log 2>&1`; FAIL(엔드포인트 미존재) 확인.

- [ ] **Step 3: 핸들러 + 라우트**
  `crates/controller/src/api/pool.rs`:
  ```rust
  use axum::{extract::State, Json};
  use serde::Serialize;

  use crate::app::AppState;

  #[derive(Serialize)]
  pub struct PoolWorkerSummary {
      pub worker_id: String,
      pub hostname: String,
      pub capacity_vus: u32,
      pub busy: bool,
      pub run_id: Option<String>,
  }

  #[derive(Serialize)]
  pub struct PoolWorkersResponse {
      pub pool_mode: bool,
      pub workers: Vec<PoolWorkerSummary>,
  }

  /// GET /api/pool/workers — read-only pool snapshot for the dashboard (L2).
  /// Off-pool deployments return `{pool_mode:false, workers:[]}` (not 404).
  /// Exposes only display fields — never token/env/dataset (R12).
  pub async fn list_workers(State(state): State<AppState>) -> Json<PoolWorkersResponse> {
      let pool_mode = state.coord.is_pool_mode();
      let workers = state
          .coord
          .pool_snapshot()
          .await
          .into_iter()
          .map(|i| PoolWorkerSummary {
              worker_id: i.worker_id,
              hostname: i.hostname,
              capacity_vus: i.capacity_vus,
              busy: i.assigned_run.is_some(),
              run_id: i.assigned_run,
          })
          .collect();
      Json(PoolWorkersResponse { pool_mode, workers })
  }
  ```
  `crates/controller/src/api/mod.rs`에 `pub mod pool;`. `crates/controller/src/app.rs`: environments import 패턴 미러로 `use crate::api::pool as pool_api;`(또는 기존 import 스타일) + 라우터에 `.route("/pool/workers", get(pool_api::list_workers))`(`/api` nest 하위, environments 라우트 인근).
  **Acceptance (R2):** `pool_workers_endpoint_lists`/`pool_workers_endpoint_off_returns_empty` PASS — off=빈 200·등록 후 목록·busy/run_id 반영.
  **Acceptance (R12):** 응답 JSON에 token/env/dataset 키 부재(테스트 단언) + DTO 정의에 해당 필드 없음.

- [ ] **Step 4: 검증** — `cargo build --workspace` 후 `cargo nextest run -p handicap-controller --test pool_api_test > /tmp/l2-t3.log 2>&1`; exit 0.

- [ ] **Step 5: 커밋** — `git add crates/controller/src/api/pool.rs crates/controller/src/api/mod.rs crates/controller/src/app.rs crates/controller/tests/pool_api_test.rs` → `feat(lan): GET /api/pool/workers 읽기전용 엔드포인트 (L2 R2/R12)` → `git log -1`.

---

## Task 4: `/workers` 대시보드 페이지 + 데이터 레이어

**충족 R:** R6, R7, R10
**Files:**
- Create: `ui/src/api/pool.ts`
- Modify: `ui/src/api/hooks.ts` — queryKeys + usePoolWorkers
- Create: `ui/src/pages/WorkerDashboardPage.tsx`
- Create: `ui/src/pages/__tests__/WorkerDashboardPage.test.tsx`
- Modify: `ui/src/routes.tsx`, `ui/src/components/Layout.tsx`, `ui/src/i18n/ko.ts`

**Interfaces:**
- Consumes: `GET /api/pool/workers`(Task 3 와이어).
- Produces: `usePoolWorkers()` 훅, `ko.nav.workers`·`ko.workers.*`(Task 5 프리뷰가 `ko.workers.poolPreview` 사용).

- [ ] **Step 0: RED 테스트 스텁 먼저 (tdd-guard 언블록 — 모든 `ui/src` 편집보다 앞)**
  `ui/src/pages/__tests__/WorkerDashboardPage.test.tsx`를 **가장 먼저** 생성(pending diff 없으면 첫 `ui/src` 편집[ko.ts]이 tdd-guard에 막힘 — ui/CLAUDE.md). 최소 스텁:
  ```tsx
  import { describe, it } from "vitest";
  describe("WorkerDashboardPage", () => {
    it.todo("풀-모드: 워커 행·hostname·상태·카운트·run 링크");
    it.todo("풀 아님: emptyNotPool 안내");
    it.todo("풀-모드 0대: emptyNoWorkers 안내");
    it.todo("fetch 실패: role=alert 에러");
  });
  ```
  (Step 7에서 `it.todo`를 실제 RTL 단언으로 채운다.)

- [ ] **Step 1: ko 문구**
  `ui/src/i18n/ko.ts` `nav` 블록(151)에 `workers: "워커",` 추가. 신규 네임스페이스(최상위 객체에):
  ```ts
  workers: {
    title: "연결된 워커",
    subtitle: "풀 모드 컨트롤러에 연결된 LAN 워커 (읽기 전용)",
    colHostname: "호스트",
    colWorkerId: "워커 ID",
    colStatus: "상태",
    colCapacity: "용량(VU, 선언값·미적용)",
    statusIdle: "유휴",
    statusBusy: "실행 중",
    countSummary: (idle: number, busy: number) => `유휴 ${idle} · 실행 중 ${busy}`,
    emptyNotPool: "이 컨트롤러는 풀 모드가 아닙니다. 풀 모드로 실행하면 연결된 워커가 여기 표시됩니다.",
    emptyNoWorkers: "연결된 워커가 없습니다. 각 PC에서 워커를 풀 모드로 기동하세요.",
    runbookHint: "설정 방법: 운영 런북(docs/dev/lan-workers.md) 참고",
    loadError: "워커 목록을 불러오지 못했습니다.",
    poolPreview: (idle: number) =>
      `연결된 유휴 워커 ${idle}대 — 이 run은 유휴 워커에 분산 실행됩니다(use-all).`,
  },
  ```

- [ ] **Step 2: pool.ts 클라(raw fetch + 인라인 Zod — environments.ts 컨벤션)**
  `ui/src/api/pool.ts`:
  ```ts
  import { z } from "zod";

  // BASE 상수는 environments.ts와 동일 출처를 따름(그 파일의 import/const 패턴 재사용).
  const BASE = "/api";

  export const PoolWorkerSummarySchema = z.object({
    worker_id: z.string(),
    hostname: z.string(),
    capacity_vus: z.number(),
    busy: z.boolean(),
    run_id: z.string().nullable(),
  });
  export type PoolWorkerSummary = z.infer<typeof PoolWorkerSummarySchema>;

  export const PoolWorkersResponseSchema = z.object({
    pool_mode: z.boolean(),
    workers: z.array(PoolWorkerSummarySchema),
  });
  export type PoolWorkersResponse = z.infer<typeof PoolWorkersResponseSchema>;

  export async function listPoolWorkers(): Promise<PoolWorkersResponse> {
    const res = await fetch(`${BASE}/pool/workers`);
    if (!res.ok) throw new Error(`pool workers ${res.status}`);
    return PoolWorkersResponseSchema.parse(await res.json());
  }
  ```
  (environments.ts가 `BASE`를 import하면 동일 import를 쓰고, const면 동일 const — 그 파일과 lockstep.)

- [ ] **Step 3: hooks.ts**
  `queryKeys`(35)에 `poolWorkers: () => ["pool", "workers"] as const,` 추가. 훅 추가:
  ```ts
  export function usePoolWorkers() {
    return useQuery({
      queryKey: queryKeys.poolWorkers(),
      queryFn: listPoolWorkers,
      refetchInterval: (q) => (q.state.data?.pool_mode ? 3000 : false),
    });
  }
  ```
  (`listPoolWorkers` import 추가. 함수형 refetchInterval은 hooks.ts:147 precedent.)

- [ ] **Step 4: RTL 테스트 채우기 (Step 0 스텁 → 실제 단언, RED — 페이지 미존재로 실패)**
  `ui/src/pages/__tests__/WorkerDashboardPage.test.tsx`의 `it.todo`를 실제 RTL 단언으로 교체 — `usePoolWorkers`를 mock(또는 fetch mock)해 4 케이스:
  ```tsx
  // 1) pool_mode:true, 워커 2(1 idle/1 busy) → 행 2·hostname·상태·카운트·run 링크
  // 2) pool_mode:false → emptyNotPool 안내
  // 3) pool_mode:true, workers:[] → emptyNoWorkers 안내
  // 4) fetch reject → role="alert" 에러
  ```
  (EnvironmentsPage.test 패턴 미러 — `QueryClientProvider` + `MemoryRouter` 래핑. busy 행은 `screen.getByRole("link", { name: /run-1/ })`로 `/runs/run-1` 링크 단언.)

- [ ] **Step 5: WorkerDashboardPage 구현**
  `ui/src/pages/WorkerDashboardPage.tsx`(EnvironmentsPage 구조 미러):
  ```tsx
  import { Link } from "react-router-dom";
  import { usePoolWorkers } from "../api/hooks";
  import { ko } from "../i18n/ko";

  export function WorkerDashboardPage() {
    const { data, isLoading, isError } = usePoolWorkers();
    if (isLoading) return <p role="status">{ko.common.loading}</p>;
    if (isError) return <p role="alert">{ko.workers.loadError}</p>;
    if (!data) return null;
    if (!data.pool_mode)
      return (
        <section>
          <h1>{ko.workers.title}</h1>
          <p>{ko.workers.emptyNotPool}</p>
          <p>{ko.workers.runbookHint}</p>
        </section>
      );
    const idle = data.workers.filter((w) => !w.busy).length;
    const busy = data.workers.length - idle;
    return (
      <section>
        <h1>{ko.workers.title}</h1>
        <p>{ko.workers.subtitle}</p>
        <p>{ko.workers.countSummary(idle, busy)}</p>
        {data.workers.length === 0 ? (
          <p>{ko.workers.emptyNoWorkers}</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>{ko.workers.colHostname}</th>
                <th>{ko.workers.colWorkerId}</th>
                <th>{ko.workers.colStatus}</th>
                <th>{ko.workers.colCapacity}</th>
              </tr>
            </thead>
            <tbody>
              {data.workers.map((w) => (
                <tr key={w.worker_id}>
                  <td>{w.hostname || "—"}</td>
                  <td title={w.worker_id}>{w.worker_id}</td>
                  <td>
                    {w.busy ? (
                      <>
                        {ko.workers.statusBusy}
                        {w.run_id ? <Link to={`/runs/${w.run_id}`}> ({w.run_id})</Link> : null}
                      </>
                    ) : (
                      ko.workers.statusIdle
                    )}
                  </td>
                  <td>{w.capacity_vus}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    );
  }
  ```
  (스타일/클래스는 EnvironmentsPage 컨벤션 따름. `ko.common.loading` 키가 없으면 `ko.workers`에 로컬 로딩 문구 추가.)

- [ ] **Step 6: 라우트 + 네비**
  `ui/src/routes.tsx` children에 `{ path: "workers", element: <WorkerDashboardPage /> }` + import. `ui/src/components/Layout.tsx` 네비(`/templates`·`/schedules` 인근)에 `<Link to="/workers" className="hover:text-slate-900">{ko.nav.workers}</Link>` 추가.
  **Acceptance (R6):** RTL 케이스1 PASS — 행 2·hostname·유휴/Busy·카운트·run 링크(`/runs/run-1`).
  **Acceptance (R7):** RTL 케이스2/3/4 PASS — 빈-상태 2종 + `role="alert"` 에러.
  **Acceptance (R10):** grep `ui/src/pages/WorkerDashboardPage.tsx ui/src/api/pool.ts`에 인라인 한국어 리터럴 0(전부 `ko.*`); `ko.nav.workers`·`ko.workers.*` 참조.

- [ ] **Step 7: 검증** — `cd ui && pnpm lint > /tmp/l2-t4-lint.log 2>&1 && pnpm test > /tmp/l2-t4-test.log 2>&1 && pnpm build > /tmp/l2-t4-build.log 2>&1`; 각 exit 0.

- [ ] **Step 8: 커밋** — `git add ui/src/api/pool.ts ui/src/api/hooks.ts ui/src/pages/WorkerDashboardPage.tsx ui/src/pages/__tests__/WorkerDashboardPage.test.tsx ui/src/routes.tsx ui/src/components/Layout.tsx ui/src/i18n/ko.ts` → `feat(lan): /workers 워커 대시보드 + usePoolWorkers (L2 R6/R7/R10)` → `git log -1`.

---

## Task 5: RunDialog 풀 프리뷰 (읽기전용)

**충족 R:** R8, R9
**Files:**
- Modify: `ui/src/components/RunDialog.tsx` — 풀-모드 배너
- Modify: `ui/src/components/__tests__/`(RunDialog 기존 test 파일) — 배너 표시/부재
- (ko.workers.poolPreview는 Task 4서 추가됨)

- [ ] **Step 1: RTL 테스트 먼저(RED)**
  RunDialog 기존 RTL에 2 케이스 추가: ① `usePoolWorkers` mock이 `{pool_mode:true, workers:[2 idle]}` → 배너 `유휴 워커 2대` 텍스트 존재. ② mock `{pool_mode:false}` → 배너 부재(`queryByText(/유휴 워커/)` null) + 기존 open-loop `worker_count` 입력 회귀 0(기존 단언 유지).

- [ ] **Step 2: 배너 구현**
  `ui/src/components/RunDialog.tsx`에 `const pool = usePoolWorkers();` 추가하고, `LoadModelFields`(RunDialog.tsx:494-524 fieldset) 인근에 조건부 렌더:
  ```tsx
  {pool.data?.pool_mode ? (
    <p className="text-sm text-slate-600">
      {ko.workers.poolPreview(pool.data.workers.filter((w) => !w.busy).length)}
    </p>
  ) : null}
  ```
  **Acceptance (R8):** RTL 케이스① PASS — 풀-모드서 "유휴 워커 N대" 배너. 케이스② PASS — 비-풀 배너 부재.
  **Acceptance (R9):** 비-풀 모드 RunDialog 기존 RTL 전부 green(배너 미렌더)·`worker_count`/buildLoadProfile 무변경. `git diff`에 RunDialog 로직 변경은 배너 1블록 + 훅 1줄뿐.

- [ ] **Step 3: 검증** — `cd ui && pnpm lint && pnpm test && pnpm build`(각 `> /tmp/l2-t5-*.log` + exit 0). 비-풀 RunDialog 테스트 green 재확인.

- [ ] **Step 4: 커밋** — `git add ui/src/components/RunDialog.tsx ui/src/components/__tests__/<runDialog test>` → `feat(lan): RunDialog 풀-모드 유휴 워커 프리뷰 (L2 R8/R9)` → `git log -1`.

---

## Task 6: 런북 + 라이브니스 문서

**충족 R:** R11
**Files:**
- Modify: `docs/dev/lan-workers.md`

- [ ] **Step 1: "풀 상태 보기" 절 추가**
  `docs/dev/lan-workers.md`에 추가: `/workers` 대시보드 사용법(네비 '워커')·hostname 표시·유휴/Busy·RunDialog 프리뷰. **라이브니스 한계 명시**: 대시보드의 "연결됨"은 gRPC 스트림 존재 기반이며 하트비트가 없다 → 워커 PC의 비정상 네트워크 단절(half-open)은 전송 타임아웃 전까지 **유령 워커**로 남을 수 있다(정상 종료/프로세스 kill은 즉시 사라짐). 하트비트/last-seen은 L3 후속.
  **Acceptance (R11):** 런북에 대시보드 사용법 + half-open 캐비엇 단락 존재.

- [ ] **Step 2: 커밋** — `git add docs/dev/lan-workers.md` → `docs(lan): /workers 대시보드 + 라이브니스 한계 런북 (L2 R11)` → `git log -1`. (docs-only — fast-path.)

---

## 머지 / 마무리

- **라이브 검증 필수**(spec §6): RunDialog(run-인접) + 신규 응답-파싱(`/api/pool/workers` Zod) 변경 → S-D 갭. **localhost 풀 스택**(`/live-verify`): `cargo build -p handicap-worker --bin worker && cargo build -p handicap-controller --bin controller` 워밍 → `./target/debug/controller --db /tmp/l2.db --ui-dir ui/dist --worker-mode pool --grpc 127.0.0.1:8081 --worker-token X` + `./target/debug/worker --controller http://127.0.0.1:8081 --token X`(`--run-id` 없이) ×2 → Playwright로 ① `/workers` 2워커·hostname·유휴 ② run 발사 후 1 Busy+run 링크 ③ RunDialog 프리뷰 "유휴 M대" ④ 워커1 kill→폴링 내 사라짐 ⑤ 비-풀 컨트롤러서 `/workers` 빈-상태. **실화면 사용자 리뷰**(사용자 요청): `/workers`·RunDialog 프리뷰 스크린샷/스냅샷을 사용자에게 보이고 의견 수렴 → 반영.
- **최종 리뷰**: `handicap-reviewer`(와이어 1:1 — proto hostname worker↔controller, REST DTO↔Zod) + **`security-reviewer`**(요청실행/env 무관하나 신규 엔드포인트가 풀 상태 노출 → R12 게이트: token/env/dataset 미노출·tx 비노출 확인). path-gate: 신규 REST + 와이어라 둘 다 돌린다.
- **워크트리 ff-merge**: `git -C /Users/sgj/develop/handicap branch --list 'worktree-*'`로 실제 브랜치명(`worktree-lan-workers-l2`) 확인 → 메인 클린+ff 가능 확인 → `git -C /Users/sgj/develop/handicap merge --ff-only worktree-lan-workers-l2` → `ExitWorktree(remove, discard_changes:true)`.
- **잔류 정리**: Playwright 썼다면 `rm -rf .playwright-mcp` + 루트 png.
- **finish-docs**: ADR-0041 §귀결(L2 완료 반영)·roadmap §LAN(완료)·build-log 한 단락·도메인 CLAUDE.md(controller: `/api/pool/workers`·`pool_snapshot`; ui: 워커 대시보드 폴링·환경 컨벤션 / worker: `gethostname` resolve)·메모리 갱신.

## Self-Review (작성자 체크)

- **R 커버리지**: R1–R12 전부 담당 task 매핑(미매핑 0). seam R3(Task1 proto)·R2(Task3 REST)·R6(Task4 Zod↔R2)는 계약-먼저(1→2→3→4) 배치 ✓.
- **인라인 acceptance**: 각 task가 자기 R acceptance를 인라인 보유 ✓.
- **Placeholder scan**: 코드 블록은 실제 코드(proto/resolve_hostname/pool_snapshot/엔드포인트/Zod/훅/페이지/배너/테스트). `make_app`/`BASE`는 "기존 파일 미러" 명시(의사코드 아님·실존 패턴 참조) ✓.
- **Type/idiom consistency**: 와이어 1:1 — Rust `PoolWorkerSummary{worker_id,hostname,capacity_vus:u32,busy:bool,run_id:Option<String>}` ↔ Zod `{worker_id:string,hostname:string,capacity_vus:number,busy:boolean,run_id:string.nullable()}` ✓. `pool_snapshot`/`PoolWorkerInfo` 명칭 Task2 정의→Task3 소비 일치 ✓.
- **커밋 경계**: 각 task green fold(헬퍼+RED+구현 1커밋), proto+worker 한 컴파일 단위(Task1), 시그니처+12site+test(Task2) ✓.
- **TDD 가드**: Rust keepalive(worker/worker-core/controller) 선배치 메모, UI test-먼저 메모 ✓.
- **byte-identical(R9)**: off+빈 hostname·비-풀 RunDialog 불변 — Task5 + 매 task 게이트로 검증 ✓.
