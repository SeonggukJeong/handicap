# LAN 워커 하트비트 / last-seen / 유령 워커 정리 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

<!-- REVIEW-GATE: APPROVED -->

**Goal:** 풀 워커별 능동 하트비트(`last_seen`)+stale evict로 half-open/죽은 워커가 capacity 가드에 계수되거나 대시보드에 유휴로 남거나 run을 영영 `running`에 묶는 것을 막고, h2 keepalive로 죽은 연결을 teardown해 워커 재등록을 구동한다.

**Architecture:** 하이브리드 — (앱) 컨트롤러 리퍼 태스크가 풀의 모든 워커에 주기적 `Ping`을 push, 워커가 `Pong`을 echo, 임의 인바운드에 `last_seen` 스탬프; 같은 리퍼가 `last_seen > stale`인 엔트리를 기존 `pool_disconnect`(idle=조용히 제거, busy=`worker_disconnected` fail-fast)로 evict. (전송) tonic 서버+워커 Endpoint h2 keepalive가 죽은 연결을 닫아 기존 stream-close 경로 + 워커 reconnect→재등록을 구동. 기존 inert `Ping`/`Pong` 메시지를 활성화만 — proto/migration/엔진 0.

**Tech Stack:** Rust(tonic 0.12·tokio·`crates/controller`·`crates/worker-core`), TypeScript/React(`ui/`), Zod.

**Spec:** `docs/superpowers/specs/2026-06-22-lan-worker-heartbeat-design.md`

## Global Constraints

- **proto·migration·엔진 무변경**(R12): 풀은 in-memory `CoordinatorState.pool`, `Ping`/`Pong`은 기존 메시지. `git diff` proto 0줄·`store/` migration 추가 0.
- **byte-identical when off**(R11): `pool_mode` off → 리퍼 미spawn, 기존 경로 100% 보존. 빈 풀 → tick no-op.
- **임계값 기본값**: heartbeat interval 10s · stale timeout 30s · h2 keepalive 20s (CLI 플래그로 override; ops-settings 페이지 통합은 연기).
- **`Instant`는 비직렬화** — DTO 노출은 `Instant`→경과초(`u64`) 변환.
- **CoordinatorState엔 config를 두지 않는다**(capacity 제거 선례) — 임계값은 `pool_heartbeat_tick` 파라미터 + 리퍼 클로저 캡처.
- 한국어 UI copy는 `ko.ts` 카탈로그 경유(ADR-0035). 응답 스키마 필드는 Option 아니면 `.nullish()` 금지(`z.number()`).

---

## Requirement Coverage (R-id → Task) ⟵ 커버리지 게이트

| R-id | 요구사항 (요약) | 담당 Task | seam? |
|---|---|---|---|
| R1 | 풀 워커별 `last_seen` 추적·임의 인바운드 갱신 | Task 1 | |
| R2 | 리퍼가 전원 Ping push + 워커가 idle-wait·pump 두 곳서 Pong | Task 1(컨트롤러)·Task 2(워커) | ✅ (Ping/Pong 활성화, proto 무변경) |
| R2b | idle 워커가 반복 Ping에 스트림 안 끊음(legacy byte-identical) | Task 2 | |
| R3 | `last_seen > stale` evict = idle/busy 공통 `pool_disconnect` | Task 1 | |
| R4 | evict 멱등(재호출 no-op) | Task 1 | |
| R5 | half-open busy 워커 evict→run fail-fast | Task 1 | |
| R6 | 서버 빌더 두 arm h2 keepalive | Task 3 | ✅ transport |
| R7 | 워커 Endpoint keepalive→reconnect→재등록 | Task 2 | |
| R8 | snapshot/`PoolWorkerSummary`/응답 래퍼에 last_seen+임계값 | Task 4 | ✅ REST DTO↔Zod |
| R9 | UI 열·stale 배지·Zod(`PoolWorkerSummarySchema`+래퍼) | Task 4 | ✅ Zod↔REST |
| R10 | CLI 플래그 3종 + 상수 기본값 | Task 3 | |
| R11 | pool_mode off/빈 풀 byte-identical | Task 1·Task 3 | |
| R12 | proto/엔진/migration 0 | (전 task 불변식) | |
| R13 | 리퍼 tick 본체 주입형 헬퍼 + 가상시계 단위 | Task 1 | |
| R14 | 리퍼 락 `.await` 너머 보유 금지 | Task 1 | |

- **계약-먼저**: R2의 컨트롤러측(Task 1: Ping push + Pong 수신 touch)과 워커측(Task 2: Pong echo)은 같은 브랜치서 함께 머지(한쪽만 = 워커가 Ping에 죽거나 컨트롤러가 영영 evict). R8↔R9는 Task 4 한 머지(와이어 1:1).

---

## File Structure

| 파일 | 책임 | 변경 |
|---|---|---|
| `crates/controller/src/grpc/coordinator.rs` | 풀 상태머신 | `PoolEntry.last_seen` 필드 + `pool_register_idle` init + `pool_touch` + `pool_heartbeat_tick` + `pool_snapshot(now)` + 핸들러 touch + 인라인 단위 |
| `crates/worker-core/src/client.rs` | 워커 gRPC connect/stream | idle-wait 루프(Ping→Pong) + `forward_inbound` `out_tx` Ping→Pong + Endpoint keepalive + 단위 |
| `crates/controller/src/main.rs` | 컨트롤러 부팅·CLI·서버 빌더 | CLI 플래그 3종 + 리퍼 spawn + 서버 두 arm keepalive + 임계값을 AppState 노출 |
| `crates/controller/src/app.rs` | AppState | 임계값 2종 필드(응답 노출용) |
| `crates/controller/src/api/pool.rs` | `/api/pool/workers` | `PoolWorkerSummary.last_seen_secs_ago` + `.map()` + 응답 래퍼 임계값 2종 |
| `ui/src/api/pool.ts` | Zod·fetch | `PoolWorkerSummarySchema`·`PoolWorkersResponseSchema` 필드 가산 |
| `ui/src/pages/WorkerDashboardPage.tsx` | 대시보드 | "마지막 응답" 열 + stale 배지 |
| `ui/src/i18n/ko.ts` | 한국어 copy | 열 헤더·배지 문구 키 |

**무변경(명시)**: proto(`coordinator.proto`)·엔진(`crates/engine`)·migration(`store/`)·`crates/worker/src/lib.rs`의 `load_datasets`/`abort_listener`/`execute_assignment` 본체·`usePoolWorkers` 훅(`hooks.ts`, 폴링 그대로).

**TDD 가드 메모**: `coordinator.rs`·`client.rs`엔 이미 인라인 `#[cfg(test)] mod tests`가 있어 *자동 통과*(tdd-guard는 디스크에 `#[cfg(test)]`가 이미 있는 파일 편집을 허용). `app.rs`/`main.rs`/`api/pool.rs`는 같은 task의 인라인-test 파일(coordinator.rs) 편집이 pending diff를 만들어 unblock — 단, 새 src 파일 Write는 없음(전부 기존 파일 수정)이라 keepalive stub 불요. UI는 **테스트 파일(`__tests__/WorkerDashboardPage.test.tsx`)을 먼저 편집**해 pending RED를 만든 뒤 src 편집(루트 C-1·ui/CLAUDE.md).

**커밋 경계 메모**: 각 task는 헬퍼+테스트를 **하나의 green 커밋**으로 fold(전체 워크스페이스 게이트가 미사용 헬퍼=clippy dead_code·RED-only=test 실패로 단독 커밋을 막음). Task 1의 `pool_heartbeat_tick`/`pool_touch`는 추가하는 즉시 인라인 테스트가 호출하므로 dead_code 안 뜸. **`pool_snapshot(now)` 시그니처 변경은 호출부(`api/pool.rs:28`)+테스트 2곳이 같은 커밋에 갱신돼야 컴파일** → Task 1이 시그니처를 바꾸면 그 커밋에서 호출부도 함께(아니면 Task 4까지 미룰 수 없음 — 컴파일 게이트). **결정: `pool_snapshot(now)` 시그니처 변경 + 호출부 갱신은 Task 1에 포함**(Task 4는 `PoolWorkerInfo`/`PoolWorkerSummary` 필드 *값*만 추가).

---

## Task 1: 컨트롤러 코어 — last_seen·pool_touch·pool_heartbeat_tick·evict

**충족 R:** R1, R3, R4, R5, R11, R13, R14 (+ R2 컨트롤러측 Ping push)
**Files:**
- Modify: `crates/controller/src/grpc/coordinator.rs` — `PoolEntry`·`pool_register_idle`·`pool_snapshot`·`pool_touch`(신규)·`pool_heartbeat_tick`(신규)·핸들러 touch·인라인 단위

- [ ] **Step 1: `PoolEntry`에 `last_seen` 필드 추가 + init**

  `PoolEntry`(coordinator.rs:81) 구조체에 필드 추가:
  ```rust
  struct PoolEntry {
      tx: WorkerTx,
      #[allow(dead_code)]
      capacity_vus: u32,
      hostname: String,
      assigned_run: Option<String>,
      /// Last time we heard from this worker (Pong/MetricBatch/RunStatus/re-Register).
      /// Reaper evicts entries older than the stale timeout. (LAN L6, R1.)
      last_seen: tokio::time::Instant,
  }
  ```
  `pool_register_idle`(coordinator.rs:332)의 struct literal에 init 추가(재-Register=fresh idle이므로 now로):
  ```rust
  g.insert(
      worker_id.to_string(),
      PoolEntry {
          tx,
          capacity_vus,
          hostname,
          assigned_run: None,
          last_seen: tokio::time::Instant::now(),
      },
  );
  ```

- [ ] **Step 2: `pool_touch` + `pool_heartbeat_tick` 추가**

  `CoordinatorState` impl에 추가(`pool_snapshot` 근처):
  ```rust
  /// Stamp a pool worker's last_seen on any inbound message (R1). No-op if the
  /// worker_id is not a pool entry (non-pool stream or already-evicted).
  pub async fn pool_touch(&self, worker_id: &str) {
      if let Some(e) = self.pool.lock().await.get_mut(worker_id) {
          e.last_seen = tokio::time::Instant::now();
      }
  }

  /// One heartbeat sweep (R13, injectable for the virtual-clock unit test):
  /// ping every pool worker, evict any whose last_seen is older than `stale`.
  /// Lock discipline (R14): snapshot (id, tx, is_stale) UNDER the lock with no
  /// `.await`, drop the lock, then do all `.await` (Ping send / pool_disconnect)
  /// outside it. A dead tx (send Err) means the stream is gone → evict (R3).
  pub async fn pool_heartbeat_tick(&self, now: tokio::time::Instant, stale: std::time::Duration) {
      let snapshot: Vec<(String, WorkerTx, bool)> = {
          let g = self.pool.lock().await;
          g.iter()
              .map(|(id, e)| (id.clone(), e.tx.clone(), now.duration_since(e.last_seen) > stale))
              .collect()
      };
      for (wid, tx, is_stale) in snapshot {
          if is_stale {
              // idle → silent remove; busy → worker_disconnected fail-fast (R3/R5).
              self.pool_disconnect(&wid).await;
              continue;
          }
          let ping = ServerMessage {
              payload: Some(ServerPayload::Ping(pb::Ping { nonce: 0 })),
          };
          if tx.send(Ok(ping)).await.is_err() {
              self.pool_disconnect(&wid).await;
          }
      }
  }
  ```
  (`nonce: 0` 상수 — 워커가 그대로 echo하고 컨트롤러는 nonce를 correlate하지 않는다[임의 인바운드에 touch]. `ServerPayload`/`ServerMessage`/`pb`는 파일 상단에 이미 import됨 — register/abort arm이 `ServerPayload::Abort`를 씀.)

  **Acceptance (R1):** `pool_touch`가 last_seen을 갱신 — 단위 `pool_touch_advances_last_seen`.
  **Acceptance (R3/R5):** stale 엔트리가 `pool_disconnect`로 evict, busy면 `worker_disconnected` 라우팅 — 단위 `stale_idle_evicted`·`stale_busy_routes_worker_disconnected`.
  **Acceptance (R13/R14):** tick이 `(now, stale)` 파라미터를 받고 가상시계로 결정적, 락을 `.await` 너머로 안 들고 감(스냅샷 후 drop) — 단위 + 코드 검토.

- [ ] **Step 3: `pool_snapshot`를 `now` 인자로 + last_seen 변환 (호출부 동시 갱신)**

  `pool_snapshot`(coordinator.rs:363) 시그니처+매핑:
  ```rust
  pub async fn pool_snapshot(&self, now: tokio::time::Instant) -> Vec<PoolWorkerInfo> {
      let g = self.pool.lock().await;
      let mut out: Vec<PoolWorkerInfo> = g
          .iter()
          .map(|(id, e)| PoolWorkerInfo {
              worker_id: id.clone(),
              hostname: e.hostname.clone(),
              capacity_vus: e.capacity_vus,
              assigned_run: e.assigned_run.clone(),
              last_seen_secs_ago: now.saturating_duration_since(e.last_seen).as_secs(),
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
  `PoolWorkerInfo`(coordinator.rs:100)에 필드 추가: `pub last_seen_secs_ago: u64,`.
  호출부 `crates/controller/src/api/pool.rs:28`을 `.pool_snapshot(tokio::time::Instant::now())`로, 인라인 테스트 `pool_snapshot_lists_idle_and_busy`(coordinator.rs:2264)의 두 `pool_snapshot()` 호출(2277·2296)을 `pool_snapshot(tokio::time::Instant::now())`로 갱신(컴파일 게이트 — 같은 커밋).
  > `PoolWorkerSummary`(api/pool.rs)의 *값* 매핑은 Task 4. 여기선 `PoolWorkerInfo`만 필드를 들고, `api/pool.rs`의 `.map()`은 아직 그 필드를 안 읽어도 컴파일됨(추가 필드는 무시).

  **Acceptance (R8 일부):** `pool_snapshot`가 last_seen_secs_ago를 채움 — 단위 `snapshot_includes_last_seen`(register 후 advance, secs_ago>0).

- [ ] **Step 4: 스트림 핸들러에서 풀 인바운드에 touch**

  `channel` 핸들러의 `while let` 루프 `match msg.payload { … }` **블록 바로 뒤**(coordinator.rs:1133, `None => {}` arm을 닫는 `}` 다음, `while` 본문 끝 전)에 추가:
  ```rust
  // R1: any inbound from a pool connection refreshes liveness. Gated on
  // pool_conn so per-run/k8s MetricBatch hot path never touches the pool lock,
  // and worker_id is Some only after the Register arm ran.
  if pool_conn {
      if let Some(wid) = &worker_id {
          state.pool_touch(wid).await;
      }
  }
  ```
  Pong arm(`coordinator.rs:1131` `Some(WorkerPayload::Pong(_)) => {}`)은 그대로 둔다(touch가 공통 처리).

  **Acceptance (R1):** 풀 워커의 Pong/MetricBatch가 last_seen을 갱신(라이브 검증으로 종합 — 단위는 `pool_touch` 직접 호출로 커버).

- [ ] **Step 5: 인라인 단위 테스트 (가상시계)**

  `coordinator.rs`의 `#[cfg(test)] mod tests`에 추가. coord/db 구성은 기존 `pool_*` 테스트(예 `pool_busy_disconnect_fails_run` 2158, `pool_register_idempotent_resets_assigned` 2055)와 **동일 방식**으로(그 테스트들의 in-memory DB + `CoordinatorState::new` 셋업을 미러). `start_paused`는 controller `[dev-dependencies]`의 `tokio` `test-util` feature 필요(A3a 함정 — 이미 있음).
  ```rust
  use std::time::Duration;

  #[tokio::test(start_paused = true)]
  async fn pool_touch_advances_last_seen() {
      let coord = /* 기존 pool 테스트와 동일하게 CoordinatorState 구성 */;
      let (tx, _rx) = tokio::sync::mpsc::channel(32);
      coord.pool_register_idle("w1", tx, 10, "h".into()).await;
      tokio::time::advance(Duration::from_secs(5)).await;
      let before = coord.pool_snapshot(tokio::time::Instant::now()).await[0].last_seen_secs_ago;
      assert!(before >= 5);
      coord.pool_touch("w1").await;
      let after = coord.pool_snapshot(tokio::time::Instant::now()).await[0].last_seen_secs_ago;
      assert_eq!(after, 0);
  }

  #[tokio::test(start_paused = true)]
  async fn stale_idle_evicted() {
      let coord = /* … */;
      let (tx, _rx) = tokio::sync::mpsc::channel(32);
      coord.pool_register_idle("w1", tx, 10, "h".into()).await;
      assert_eq!(coord.pool_idle_count().await, 1);
      tokio::time::advance(Duration::from_secs(31)).await;
      coord.pool_heartbeat_tick(tokio::time::Instant::now(), Duration::from_secs(30)).await;
      assert_eq!(coord.pool_idle_count().await, 0);
  }

  #[tokio::test(start_paused = true)]
  async fn fresh_idle_pinged_not_evicted() {
      let coord = /* … */;
      let (tx, mut rx) = tokio::sync::mpsc::channel(32);
      coord.pool_register_idle("w1", tx, 10, "h".into()).await;
      tokio::time::advance(Duration::from_secs(10)).await; // < stale 30
      coord.pool_heartbeat_tick(tokio::time::Instant::now(), Duration::from_secs(30)).await;
      assert_eq!(coord.pool_idle_count().await, 1); // not evicted
      // fresh worker got a Ping (tick_pings_all_entries)
      let msg = rx.try_recv().expect("ping pushed");
      assert!(matches!(
          msg.unwrap().payload,
          Some(crate::grpc::pb::server_message::Payload::Ping(_))
      ));
  }

  #[tokio::test(start_paused = true)]
  async fn stale_busy_routes_worker_disconnected() {
      // Register idle, reserve to a run (busy), let it go stale, tick.
      // Mirror pool_busy_disconnect_fails_run (2158): after the tick the run is
      // marked failed (worker_disconnected) and the pool entry is gone.
      let coord = /* … with a pending run enqueued, mirror existing busy test */;
      // reserve → assigned_run = Some(run_id)
      // advance 31s; tick; assert run failed + pool_idle_count==0 + worker removed
  }

  #[tokio::test(start_paused = true)]
  async fn double_evict_idempotent() {
      let coord = /* … */;
      let (tx, _rx) = tokio::sync::mpsc::channel(32);
      coord.pool_register_idle("w1", tx, 10, "h".into()).await;
      tokio::time::advance(Duration::from_secs(31)).await;
      coord.pool_heartbeat_tick(tokio::time::Instant::now(), Duration::from_secs(30)).await;
      coord.pool_disconnect("w1").await; // late stream-close → no panic, no-op
      assert_eq!(coord.pool_idle_count().await, 0);
  }

  #[tokio::test(start_paused = true)]
  async fn empty_pool_tick_noop() {
      let coord = /* … */;
      coord.pool_heartbeat_tick(tokio::time::Instant::now(), Duration::from_secs(30)).await; // no panic
      assert_eq!(coord.pool_idle_count().await, 0);
  }
  ```
  (`tick_pings_all_entries` acceptance는 `fresh_idle_pinged_not_evicted`가 Ping push를 단언해 함께 닫음. `stale_busy_routes_worker_disconnected`의 run 셋업은 `pool_busy_disconnect_fails_run`을 그대로 미러 — 거기 db/enqueue/reserve 패턴 복사 후 disconnect 대신 advance+tick.)

  **Acceptance (R4):** `double_evict_idempotent` green(패닉/이중 fail 없음). **Acceptance (R11):** `empty_pool_tick_noop` green + 기존 스위트 무변.

- [ ] **Step 6: 검증** — `cargo build -p handicap-worker && cargo build --workspace` → `cargo nextest run -p handicap-controller > /tmp/lanl6-t1.log 2>&1` (exit code 확인, 파이프 금지). clippy: `cargo clippy --workspace --all-targets -- -D warnings`. 6개 신규 단위 + 기존 pool 단위 green.

- [ ] **Step 7: 커밋** — `git add crates/controller/src/grpc/coordinator.rs crates/controller/src/api/pool.rs` (명시 경로만, `-A` 금지) → 파이프 없는 단일 foreground 커밋(`run_in_background:false`, timeout 600000ms) → `git log -1`로 landed 확인.

---

## Task 2: 워커 — idle-wait Ping 루프 + forward_inbound Pong + Endpoint keepalive

**충족 R:** R2(워커측), R2b, R7
**Files:**
- Modify: `crates/worker-core/src/client.rs` — `connect_and_register` idle-wait 루프 + `forward_inbound` `out_tx` + `Endpoint` keepalive + 단위

- [ ] **Step 1: worker-core 단위 테스트 먼저(RED)**

  `crates/worker-core/src/client.rs`의 인라인 `#[cfg(test)] mod tests`(또는 기존 `forward_tests`)에 추가:
  ```rust
  // idle-wait: a Ping while waiting for the assignment must NOT end the stream;
  // the worker answers Pong and keeps waiting; a later Assignment resolves it. (R2b)
  #[tokio::test]
  async fn idle_wait_survives_repeated_pings() {
      // Build an inbound stream that yields Ping, Ping, then RunAssignment.
      // Assert connect path resolves to the assignment (no NoAssignment error)
      // and that two Pong WorkerMessages were sent on the outbound channel. (R2/R2b)
  }

  // forward_inbound: a Ping is answered with Pong via out_tx and is NOT forwarded
  // to fwd_tx (consumer never sees it); a non-Ping (AbortRun) IS forwarded. (R2)
  #[tokio::test]
  async fn pump_answers_ping_and_forwards_others() {
      let (fwd_tx, mut fwd_rx) = tokio::sync::mpsc::channel::<ServerMessage>(8);
      let (out_tx, mut out_rx) = tokio::sync::mpsc::channel::<WorkerMessage>(8);
      let inbound = tokio_stream::iter(vec![
          Ok(ServerMessage { payload: Some(ServerPayload::Ping(pb::Ping { nonce: 7 })) }),
          Ok(ServerMessage { payload: Some(ServerPayload::Abort(pb::AbortRun { run_id: "r".into(), reason: String::new() })) }),
      ]);
      forward_inbound(inbound, fwd_tx, std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)), out_tx).await;
      // Pong(7) went out; Ping was NOT forwarded; Abort WAS forwarded.
      let pong = out_rx.try_recv().expect("pong");
      assert!(matches!(pong.payload, Some(WorkerPayload::Pong(p)) if p.nonce == 7));
      let fwd = fwd_rx.try_recv().expect("abort forwarded");
      assert!(matches!(fwd.payload, Some(ServerPayload::Abort(_))));
      assert!(fwd_rx.try_recv().is_err()); // Ping was NOT forwarded
  }
  ```
  Run: `cargo test -p handicap-worker-core pump_answers_ping > /tmp/lanl6-t2.log 2>&1` → FAIL(컴파일/함수 시그니처) 확인.

- [ ] **Step 2: `connect_and_register` idle-wait를 루프로 (R2b)**

  `client.rs:113-131`의 단발 `select!`+`match first`를 루프로 교체:
  ```rust
  // Wait for the first RunAssignment, answering heartbeat Pings while we wait.
  // Pool idle workers block here until the controller pushes an assignment; the
  // reaper pings them periodically, so a single-shot wait would error on the
  // first Ping. Legacy (run_id present) gets the assignment as the first message
  // → loop breaks immediately → byte-identical. (R2/R2b)
  let assignment = loop {
      let next = tokio::select! {
          _ = cancel.cancelled() => return Err(WorkerError::Cancelled),
          m = inbound.next() => m,
      };
      match next {
          Some(Ok(msg)) => match msg.payload {
              Some(ServerPayload::Assignment(a)) => break a,
              Some(ServerPayload::Ping(p)) => {
                  tx.send(WorkerMessage {
                      payload: Some(WorkerPayload::Pong(Pong { nonce: p.nonce })),
                  })
                  .await
                  .map_err(|_| WorkerError::SendFailed)?;
                  // keep waiting for the assignment
              }
              other => {
                  warn!(?other, "expected RunAssignment, got something else");
                  return Err(WorkerError::NoAssignment);
              }
          },
          Some(Err(e)) => return Err(WorkerError::Rpc(e)),
          None => return Err(WorkerError::NoAssignment),
      }
  };
  ```
  `Pong`을 import에 추가: `use pb::{Pong, Register, RunAssignment, ServerMessage, WorkerMessage};`(line 10).

  **Acceptance (R2b):** `idle_wait_survives_repeated_pings` green — Ping에 Pong 응답 후 대기 유지, Assignment로 resolve. legacy는 첫 메시지 Assignment라 즉시 break(byte-identical).

- [ ] **Step 3: `forward_inbound`에 `out_tx` + Ping→Pong (R2)**

  `forward_inbound`(client.rs:52) 시그니처에 파라미터 추가 + `Ok(m)` arm에서 Ping 처리:
  ```rust
  async fn forward_inbound<S>(
      mut inbound: S,
      fwd_tx: mpsc::Sender<ServerMessage>,
      shutdown: Arc<AtomicBool>,
      out_tx: mpsc::Sender<WorkerMessage>,
  ) where
      S: futures::Stream<Item = Result<ServerMessage, tonic::Status>> + Unpin,
  {
      while let Some(msg) = inbound.next().await {
          match msg {
              Ok(m) => {
                  // Answer heartbeat pings here (the single always-running drainer)
                  // so the controller's reaper sees liveness regardless of whether
                  // load_datasets or abort_listener is the active consumer. Do NOT
                  // forward Ping to fwd_tx. (R2, §4.3-(2))
                  if let Some(ServerPayload::Ping(p)) = &m.payload {
                      let _ = out_tx
                          .send(WorkerMessage {
                              payload: Some(WorkerPayload::Pong(Pong { nonce: p.nonce })),
                          })
                          .await;
                      continue;
                  }
                  tracing::debug!(?m.payload, "controller msg");
                  if fwd_tx.send(m).await.is_err() {
                      break;
                  }
              }
              Err(e) => {
                  if shutdown.load(Ordering::Relaxed) {
                      tracing::debug!(error = %e, "inbound stream closed after shutdown (expected)");
                  } else {
                      warn!(error = %e, "inbound stream closed before terminal status");
                  }
                  break;
              }
          }
      }
  }
  ```
  spawn 사이트(client.rs:137)에 `tx.clone()` 전달:
  ```rust
  let fwd_handle = tokio::spawn(forward_inbound(inbound, fwd_tx, shutdown.clone(), tx.clone()));
  ```
  (`tx`는 그 다음 `WorkerLink{tx, …}`로 move되므로 `tx.clone()`을 먼저 — clone은 원본 move 전에 호출.)
  **두 번째 호출부도 같은 커밋에 갱신**(컴파일 게이트): `forward_inbound`엔 spawn 외에 **테스트 호출부** `forward_tests::capture_close`(`client.rs:239`, 현 3-arg `forward_inbound(stream, fwd_tx, shutdown).await`)가 있다 — 4번째 인자 추가 후 깨지므로 더미 채널로 갱신: `let (out_tx, _) = mpsc::channel::<WorkerMessage>(8); forward_inbound(stream, fwd_tx, shutdown, out_tx).await;`.

  **Acceptance (R2):** `pump_answers_ping_and_forwards_others` green — Pong이 out_tx로 나가고 Ping은 forward 안 됨, 비-Ping은 forward됨.

- [ ] **Step 4: 워커 `Endpoint` keepalive (R7)**

  `connect_and_register`(client.rs:89)의 channel 빌더에 keepalive:
  ```rust
  let channel = Channel::from_shared(controller_url.to_string())?
      .keep_alive_while_idle(true)
      .http2_keep_alive_interval(std::time::Duration::from_secs(20))
      .keep_alive_timeout(std::time::Duration::from_secs(20))
      .connect()
      .await?;
  ```
  (상수 20s — R10 워커측. CLI 노출은 선택; 상수로 둔다[spec §4.3 "또는 상수"]. 죽은 컨트롤러 연결을 워커가 감지→기존 `reconnect` 루프가 재연결→재-Register.)

  **Acceptance (R7):** 라이브로 검증(워커 stream-close→reconnect→풀 재등록) — 단위 불가(transport).

- [ ] **Step 5: 검증** — `cargo build -p handicap-worker && cargo build --workspace` → `cargo nextest run -p handicap-worker-core > /tmp/lanl6-t2.log 2>&1`(exit code). clippy green. 신규 2 단위 green.

- [ ] **Step 6: 커밋** — `git add crates/worker-core/src/client.rs` → 단일 foreground 커밋 → `git log -1` 확인.

---

## Task 3: main.rs 배선 — CLI 플래그·리퍼 spawn·서버 keepalive·임계값 노출

**충족 R:** R6, R10, R11, R13(spawn 배선), + R8(응답에 임계값 노출 배선)
**Files:**
- Modify: `crates/controller/src/main.rs` — `ControllerArgs` 플래그 3종 + 리퍼 `tokio::spawn` + 서버 빌더 두 arm keepalive + 임계값을 AppState로
- Modify: `crates/controller/src/app.rs` — `AppState`에 임계값 2종 필드

- [ ] **Step 1: `AppState`에 임계값 필드 추가**

  `crates/controller/src/app.rs`의 `AppState`에:
  ```rust
  pub heartbeat_interval_seconds: u64,
  pub stale_timeout_seconds: u64,
  ```
  **모든 `AppState { … }` literal 사이트 갱신**(컴파일러-driven, `grep -rn "AppState {" crates/controller/{src,tests}` — **50곳**; main.rs는 실제 CLI 값, 통합/e2e 테스트 literal은 두 필드를 **plain 리터럴**(예 `heartbeat_interval_seconds: 10, stale_timeout_seconds: 30`)로 직접 추가 — `SettingsState` 경유 아님). `api/pool.rs`가 이 필드를 읽어 응답 래퍼에 실음(Task 4).

  **Acceptance (R8 배선):** `cargo build --workspace --tests` 0 에러(전 literal 갱신).

- [ ] **Step 2: `ControllerArgs`에 CLI 플래그 3종 (R10)**

  `main.rs`의 `ControllerArgs`(clap derive)에:
  ```rust
  /// Pool heartbeat: how often the controller pings idle pool workers (seconds).
  #[arg(long, default_value_t = 10)]
  pool_heartbeat_interval_seconds: u64,
  /// Pool heartbeat: evict a pool worker after this many seconds of silence.
  #[arg(long, default_value_t = 30)]
  pool_stale_timeout_seconds: u64,
  /// gRPC HTTP/2 keepalive interval/timeout (seconds).
  #[arg(long, default_value_t = 20)]
  pool_keepalive_seconds: u64,
  ```
  (이 3개는 비-secret duration이라 기존 `info!(?args …)` 덤프에 실려도 안전 — token-leak 가드[main.rs:91]와 무관. 단 `?args` 덤프가 있으면 평문 노출되니 명시 필드 로깅 권장.)

  **Acceptance (R10):** `cargo run -p handicap-controller --bin controller -- --help`에 세 플래그 노출(또는 clap 파싱 단위).

- [ ] **Step 3: 서버 빌더 두 arm에 h2 keepalive (R6)**

  `main.rs`의 gRPC 서버 빌더 **두 arm**(bundle ~296, 비-bundle ~305)에 동일 적용:
  ```rust
  tonic::transport::Server::builder()
      .http2_keepalive_interval(Some(std::time::Duration::from_secs(args.pool_keepalive_seconds)))
      .http2_keepalive_timeout(Some(std::time::Duration::from_secs(args.pool_keepalive_seconds)))
      .add_service(grpc_svc)
      // … (각 arm의 기존 serve/serve_with_incoming 유지)
  ```
  (두 arm 모두 — bundle feature 코드는 pre-commit이 컴파일 안 하니 Step 5에서 `--features bundle` 수동 빌드로 확인.)

  **Acceptance (R6):** 두 arm 컴파일(`cargo build --workspace` + `cargo build -p handicap-controller --features bundle`) + 라이브 연결 teardown 관측.

- [ ] **Step 4: 리퍼 `tokio::spawn` 루프 (R11·R13 배선)**

  `main.rs`에서 `pool_mode`일 때만(off면 미spawn — R11), scheduler `run_scheduler` spawn(main.rs:254-266) 패턴을 미러:
  ```rust
  if coord_state.is_pool_mode() {
      let coord = coord_state.clone();
      let interval = std::time::Duration::from_secs(args.pool_heartbeat_interval_seconds);
      let stale = std::time::Duration::from_secs(args.pool_stale_timeout_seconds);
      tokio::spawn(async move {
          let mut tick = tokio::time::interval(interval);
          tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
          loop {
              tick.tick().await;
              coord.pool_heartbeat_tick(tokio::time::Instant::now(), stale).await;
          }
      });
      tracing::info!(
          interval_s = args.pool_heartbeat_interval_seconds,
          stale_s = args.pool_stale_timeout_seconds,
          "pool heartbeat reaper started"
      );
  }
  ```
  **배치 위치(중요)**: 이 spawn 블록은 `CoordinatorService { state: coord_state }`로 `coord_state`가 **move되는 `main.rs:269` *전***에 둔다 — `coord_state.clone()`을 그 move 전에 캡처(scheduler spawn[`main.rs:254`]이 line 269 전에 `state`를 clone하는 것과 동일 위치·패턴). 269 뒤에 두면 moved-value 컴파일 에러.
  (off면 이 블록 미진입 → 리퍼 0 → byte-identical R11. main-only 배선이라 단위 불가 — 라이브로[R13 spawn], tick 본체는 Task 1 인라인 단위가 커버.)

  **Acceptance (R11):** pool_mode off면 리퍼 미spawn(기존 스위트 green). **Acceptance (R13):** 라이브로 "pool heartbeat reaper started" 로그 + evict 관측.

- [ ] **Step 5: 검증** — `cargo build -p handicap-worker && cargo build --workspace` + `cargo build -p handicap-controller --features bundle`(bundle arm) → `cargo nextest run --workspace > /tmp/lanl6-t3.log 2>&1`(exit code) + clippy. AppState literal 전부 갱신돼 0 에러.

- [ ] **Step 6: 커밋** — `git add crates/controller/src/main.rs crates/controller/src/app.rs crates/controller/tests/`(literal 갱신된 통합테스트 포함, 명시 경로) → 단일 foreground 커밋 → `git log -1`.

---

## Task 4: UI/REST — last_seen 노출 + 대시보드 열·stale 배지

**충족 R:** R8, R9
**Files:**
- Modify: `crates/controller/src/api/pool.rs` — `PoolWorkerSummary.last_seen_secs_ago` + `.map()` + 응답 래퍼 임계값 2종
- Modify: `ui/src/api/pool.ts` — Zod 필드 가산
- Modify: `ui/src/pages/WorkerDashboardPage.tsx` — 열 + 배지
- Modify: `ui/src/i18n/ko.ts` — 문구 키
- Test: `ui/src/pages/__tests__/WorkerDashboardPage.test.tsx`

- [ ] **Step 1: REST DTO 가산 (R8)**

  `crates/controller/src/api/pool.rs`:
  ```rust
  #[derive(Serialize)]
  pub struct PoolWorkerSummary {
      pub worker_id: String,
      pub hostname: String,
      pub capacity_vus: u32,
      pub busy: bool,
      pub run_id: Option<String>,
      pub last_seen_secs_ago: u64,
  }

  #[derive(Serialize)]
  pub struct PoolWorkersResponse {
      pub pool_mode: bool,
      pub workers: Vec<PoolWorkerSummary>,
      pub heartbeat_interval_seconds: u64,
      pub stale_timeout_seconds: u64,
  }

  pub async fn list_workers(State(state): State<AppState>) -> Json<PoolWorkersResponse> {
      let pool_mode = state.coord.is_pool_mode();
      let workers = state
          .coord
          .pool_snapshot(tokio::time::Instant::now())
          .await
          .into_iter()
          .map(|i| PoolWorkerSummary {
              worker_id: i.worker_id,
              hostname: i.hostname,
              capacity_vus: i.capacity_vus,
              busy: i.assigned_run.is_some(),
              run_id: i.assigned_run,
              last_seen_secs_ago: i.last_seen_secs_ago,
          })
          .collect();
      Json(PoolWorkersResponse {
          pool_mode,
          workers,
          heartbeat_interval_seconds: state.heartbeat_interval_seconds,
          stale_timeout_seconds: state.stale_timeout_seconds,
      })
  }
  ```
  (token/env/tx 비노출 불변식 유지 — `PoolWorkerSummary`에 그 필드 자체 없음, R12.)

  **Acceptance (R8):** curl `GET /api/pool/workers` 응답에 워커별 `last_seen_secs_ago` + 최상위 `heartbeat_interval_seconds`/`stale_timeout_seconds`.

- [ ] **Step 2: UI 테스트 먼저(RED) — 열·배지 (R9)**

  `ui/src/pages/__tests__/WorkerDashboardPage.test.tsx`(없으면 생성, 형제 테스트 import 깊이 맞춤)에 추가(테스트 파일 먼저 = tdd-guard unblock·ui/CLAUDE.md):
  ```tsx
  it("shows last-seen and a stale badge past the stale timeout", async () => {
    // mock listPoolWorkers → { pool_mode:true, heartbeat_interval_seconds:10,
    //   stale_timeout_seconds:30, workers:[
    //     {…, last_seen_secs_ago: 2},   // fresh → "2초 전", no badge
    //     {…, last_seen_secs_ago: 15},  // > interval, < stale → "응답 없음" badge
    //   ] }
    // assert "2초 전" rendered; assert stale badge present for the 15s row only.
  });
  ```
  Run: `pnpm test WorkerDashboardPage > /tmp/lanl6-t4.log 2>&1` → FAIL.
  **기존 5개 fixture도 같은 Step에 갱신**(필수 필드 추가 — "targeted-green ≠ full-green" 트랩): 이 파일의 기존 워커 객체(`:38-51` 등)에 `last_seen_secs_ago` 추가 + 두 `pool_mode` 응답에 `heartbeat_interval_seconds`/`stale_timeout_seconds` 추가. 안 하면 Step 3에서 그 필드가 *required* `z.number()`가 된 순간 `PoolWorkersResponseSchema.parse`(`usePoolWorkers`→`listPoolWorkers`)가 5개 기존 테스트 전부에서 throw.

- [ ] **Step 3: Zod 스키마 가산 (R9 wire)**

  `ui/src/api/pool.ts`:
  ```ts
  export const PoolWorkerSummarySchema = z.object({
    worker_id: z.string(),
    hostname: z.string(),
    capacity_vus: z.number(),
    busy: z.boolean(),
    run_id: z.string().nullable(),
    last_seen_secs_ago: z.number(),
  });

  export const PoolWorkersResponseSchema = z.object({
    pool_mode: z.boolean(),
    workers: z.array(PoolWorkerSummarySchema),
    heartbeat_interval_seconds: z.number(),
    stale_timeout_seconds: z.number(),
  });
  ```
  (`last_seen_secs_ago`는 항상 직렬화되는 `u64`라 plain `z.number()` — `.nullish()` 금지. 임계값도 동일.)

- [ ] **Step 4: 대시보드 열·배지 + ko 문구 (R9)**

  `ui/src/i18n/ko.ts`에 키 추가(기존 `ko.workers` 네임스페이스, 헤더 키는 기존 `colHostname`/`colStatus`/`colCapacity` 컨벤션 따라 `colLastSeen`):
  ```ts
  colLastSeen: "마지막 응답",
  secsAgo: (n: number) => `${n}초 전`,
  stale: "응답 없음",
  ```
  `ui/src/pages/WorkerDashboardPage.tsx`: 기존 테이블(워커별 행)에 "마지막 응답" 열 추가 — 셀은 `ko.workers.secsAgo(w.last_seen_secs_ago)`, 그리고 `w.last_seen_secs_ago > data.heartbeat_interval_seconds && w.last_seen_secs_ago < data.stale_timeout_seconds`면 `ko.workers.stale` 배지(`role`/스타일은 기존 busy 배지 컨벤션 미러). 임계값은 **응답에서**(`data.heartbeat_interval_seconds`/`data.stale_timeout_seconds`) — 하드코딩 금지.

  **Acceptance (R9):** UI 테스트 green(열·배지) + 라이브 Playwright(`/workers`에서 stale 워커 "응답 없음" 표시→evict 시 행 사라짐).

- [ ] **Step 5: 검증** — `cd /Users/sgj/develop/handicap/.claude/worktrees/lan-workers-heartbeat/ui && pnpm lint && pnpm test && pnpm build > /tmp/lanl6-t4-ui.log 2>&1`(절대경로 cd·워크트리-스코프 로그·exit code) + `cargo build --workspace`(api/pool.rs). 전체 `pnpm test`(인자 없이) green.

- [ ] **Step 6: 커밋** — `git add crates/controller/src/api/pool.rs ui/src/api/pool.ts ui/src/pages/WorkerDashboardPage.tsx ui/src/pages/__tests__/WorkerDashboardPage.test.tsx ui/src/i18n/ko.ts` → 단일 foreground 커밋(UI 스테이지드라 pre-commit이 UI 게이트 실행) → `git log -1`.

---

## 머지 / 마무리

- **라이브 검증 필수**(spec §6): main-only 리퍼 spawn(R13)·run fail-fast(R5)·UI 응답경로(R8/R9, S-D 갭)·h2 keepalive(R6/R7)는 단위로 안 닫힌다. `/live-verify` + 실 pool 스택(2워커, `--worker-mode pool`):
  1. 2워커 등록 → `/workers`에 "마지막 응답 N초 전" + Ping/Pong으로 secs_ago가 작게 유지.
  2. 1워커 `kill -STOP`(half-open 모사) → interval 후 "응답 없음" 배지 → stale_timeout(30s) 경과 후 evict → 행 사라짐 + `GET /api/pool/workers` 워커 1로 감소(capacity 미계수).
  3. busy 워커(run 배정 중) `kill -STOP` → stale evict → 그 run `failed`(현 영영 running 해소).
  4. `kill -CONT`(또는 재기동) → h2 keepalive teardown 후 워커 reconnect → 풀 재등록(`/workers` 재등장).
  5. `pool_mode` off(legacy subprocess run) → byte-identical(리퍼 미spawn·run 정상).
- **워크트리 ff-merge**: 실제 브랜치명 확인(`git -C /Users/sgj/develop/handicap branch --list 'worktree-*'` → `worktree-lan-workers-heartbeat`) → 메인 클린·ff 가능 사전확인(`merge-base --is-ancestor master worktree-lan-workers-heartbeat` + `status --porcelain -uno`) → `git -C /Users/sgj/develop/handicap merge --ff-only worktree-lan-workers-heartbeat` → 머지 확인 후 `ExitWorktree(remove, discard_changes:true)`.
- **잔류 정리**: Playwright 썼다면 `rm -rf .playwright-mcp` + 루트 png.
- **finish-slice**: build-log 단락·roadmap §현재상태 한 줄·루트 CLAUDE 상태줄(교체)·ADR-0041 §귀결 L6 한 줄·메모리.

## Self-Review (작성자 체크)

- **R 커버리지**: 위 표의 모든 R(R1–R14+R2b)에 담당 task 있음(미매핑 0). R2 양측(컨트롤러 Task1·워커 Task2)·R8↔R9(Task4)는 한 브랜치 동시 머지 ✓.
- **인라인 acceptance**: 각 task가 자기 R의 acceptance를 인라인 보유 ✓.
- **Placeholder scan**: 프로덕션 코드 블록은 전부 실제 코드. 단위 테스트의 coord/db 셋업·busy-run 셋업은 "기존 `pool_*` 테스트 미러"로 명시(repo-specific 스캐폴드라 실재 패턴 참조 — 의사코드 아님) ✓.
- **Type/idiom consistency**: 와이어 양측 필드명·타입 1:1(`last_seen_secs_ago: u64 ↔ z.number()`, 응답 래퍼 임계값 2종 ↔ Zod) ✓. `pool_snapshot(now)` 시그니처 변경의 호출부 3곳(prod 1·테스트 2)을 Task1 같은 커밋에 ✓.
- **커밋 경계**: 각 task = 헬퍼+테스트 한 green 커밋(dead_code/RED 단독 불가 회피). `AppState` literal 50곳·`pool_snapshot` 호출부·`forward_inbound` 2번째 호출부는 컴파일 게이트라 같은 커밋 ✓.
