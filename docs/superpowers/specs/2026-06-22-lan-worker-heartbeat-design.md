# LAN 워커 하트비트 / last-seen / 유령 워커 정리 — 풀 워커 라이브니스 (ADR-0041 후속, LAN L6)

> 새 spec. 핵심은 **§2 요구사항 표(R-id)** — normative 척추. plan·구현·리뷰가 전부 이 ID를 참조한다.

- **날짜**: 2026-06-22
- **상태**: 설계 승인(사용자 2026-06-22) → plan 대기
- **출처**: roadmap §현재상태 LAN L1/L2 연기 항목("하트비트/last-seen") + 사용자 선택(2026-06-22). **왜 지금**: LAN 과부하 가드 4모드(L3~L5)가 완결됐지만 풀 라이브니스가 *스트림 연결*만 보므로 half-open(원격 머신 절전·네트워크 끊김)이면 죽은 워커가 풀에 유령으로 남아 — ① `/workers`에 유휴로 표시 ② capacity 가드(L3/L4/L5)에 용량으로 계수돼 죽은 워커에 예약→silent 미달 ③ busy일 때 run을 영영 `running`에 묶는다. 방금 5개 슬라이스로 쌓은 풀을 신뢰 가능하게 만드는 기초 갭.
- **연관**: ADR-0041(LAN 분산 워커 L1~L5), `docs/dev/lan-workers.md`(런북 §7/§7a half-open 유령 워커 노트), `crates/controller/src/grpc/coordinator.rs`(풀 상태머신), `crates/worker-core/src/{client.rs,reconnect.rs}`(워커 stream/재연결).
- **ADR**: 신규 불필요(ADR-0041 범위 내 additive — 세 번째 워커 모드 `pool`의 라이브니스 보강). proto·migration·엔진 무변경이라 새 결정 없음. ADR-0041 §귀결에 L6 한 줄.

---

## 1. 문제와 목표

오늘 풀 워커의 라이브니스 판정은 **gRPC bidi 스트림 연결**뿐이다(`coordinator.rs:994`의 per-connection 태스크가 `inbound.next()`에 블록). half-open TCP(워커 머신 절전·네트워크 파티션)면 FIN이 안 와 스트림이 "살아있는" 것으로 보이고 `PoolEntry`가 유령으로 남는다. 유령은 (a) 대시보드에 유휴로 표시, (b) `pool_idle_count`/`pool_achievable_capacity`로 capacity 가드(L3/L4/L5)에 계수, (c) busy면 run이 `Completed`를 영영 못 받아 `running`에 정체한다.

- **목표**: 풀 워커별 능동 하트비트(`last_seen`)로 죽은/half-open 워커를 stale-timeout 내에 풀에서 제거(idle=evict, busy=run fail-fast) + h2 keepalive로 죽은 *연결*을 teardown해 워커 재등록 구동 + 대시보드에 "마지막 응답" 가시성.
- **비목표(연기)**: §7 참조. 제어 액션(수동 disconnect/exclude/cap)·영속 worker_id·다중 동시 run·mTLS·ops-settings 페이지 통합·per-stage 라이브니스.

---

## 2. 요구사항 (정규 — R-id) ⟵ 척추

> MUST/SHOULD는 전부 여기 행. 산문(§3·§4)은 근거·방법만.

| ID | 요구사항 (MUST/SHOULD, 한 문장) | acceptance (충족 확인법) | seam? |
|---|---|---|---|
| R1 | 컨트롤러가 풀 워커별 `last_seen`을 추적하고 그 워커의 **임의 인바운드 메시지**(Pong·MetricBatch·RunStatus·재-Register)에 갱신한다 | 단위 `pool_touch_advances_last_seen` | |
| R2 | 리퍼가 **모든** 풀 워커(idle+busy)에 주기적 `Ping{nonce}`를 push하고, 워커는 **두 지점**에서 `Pong{nonce}`로 응답한다: **(a)** `connect_and_register` idle-wait(단발 "첫 메시지=RunAssignment"→*루프*, Ping→Pong 후 계속 대기·RunAssignment에서만 break), **(b)** assignment 후 항상 도는 `forward_inbound` 펌프(Ping을 Pong으로 답하고 consumer로 *전달하지 않음* — 로딩·in-run 전 구간을 한 곳에서 커버, `load_datasets`/`abort_listener`는 무변경) | 단위 `tick_pings_all_entries` + 워커 `ping_elicits_pong`(idle-wait·pump 양쪽) | ✅ wire: 기존 inert `Ping`/`Pong` proto 메시지 사용(**proto 무변경**) |
| R2b | idle 풀 워커는 반복 Ping을 받아도 스트림을 끊지 않는다 — `connect_and_register`가 Ping을 "예상치 못한 첫 메시지"(현 client.rs:124 `NoAssignment` 에러)로 취급해 재연결-churn하면 안 된다(legacy run_id-present는 assignment가 첫 메시지라 byte-identical; legacy 워커는 풀 맵에 없어 리퍼가 Ping을 *애초에* 안 보냄=불변식) | 워커 단위 `idle_wait_survives_repeated_pings`(Ping N회 후에도 대기 유지, 이후 Assignment 수신) | |
| R3 | 리퍼가 `now − last_seen > stale_timeout`인 엔트리를 idle/busy 공통 `pool_disconnect(wid)`로 evict한다(busy는 `pool_disconnect` 내부가 기존 `worker_disconnected` fail-fast로 라우팅 — 새 fail-fast 로직 0) | 단위 `stale_idle_evicted`·`stale_busy_routes_worker_disconnected` | |
| R4 | stale evict는 **멱등** — 리퍼가 evict한 뒤 그 워커의 스트림이 뒤늦게 닫혀 핸들러가 `pool_disconnect`를 재호출해도 no-op(`HashMap::remove`→None) | 단위 `double_evict_idempotent` | |
| R5 | half-open **busy** 워커(Ping 미응답)도 `last_seen` stale→evict→해당 run fail-fast — 현 "영영 running" 구멍을 닫는다 | 단위 `stale_busy_routes_worker_disconnected` + 라이브(`kill -STOP` busy 워커→run failed) | |
| R6 | tonic gRPC 서버 빌더(`main.rs` bundle + 비-bundle **두 arm**)에 `http2_keepalive_interval`/`http2_keepalive_timeout` 설정 — 죽은 연결을 teardown해 기존 stream-close 경로(`pool_disconnect`/`worker_disconnected`)로 흘린다 | 두 arm 컴파일 + 라이브(연결 teardown 관측) | ✅ transport config(proto 아님) |
| R7 | 워커 `Endpoint`(`client.rs` connect)에 `keep_alive_while_idle`+interval/timeout 설정 — 죽은 컨트롤러 연결을 감지해 기존 `reconnect` 루프가 재연결→재-Register(evict된 워커가 살아 돌아오면 풀 재등장) | 라이브(워커 stream-close→reconnect→풀 재등록) | |
| R8 | `last_seen_secs_ago: u64`(`Instant`→경과초 변환, 직렬화 안전)를 snapshot 타입 `PoolWorkerInfo`(coordinator.rs:100)→wire DTO `PoolWorkerSummary`(api/pool.rs:7, `.map()` at api/pool.rs:31)에 가산하고, `GET /api/pool/workers` 응답 **최상위**에 `heartbeat_interval_seconds`·`stale_timeout_seconds`를 실어(R9 배지가 둘 다 필요·CLI 가변이라 클라 하드코딩 drift 방지) 보낸다. token/env/tx 비노출 불변식 유지(R12) | 단위 `snapshot_includes_last_seen` + curl | ✅ wire: REST DTO(`PoolWorkerSummary`+응답 래퍼) ↔ UI Zod |
| R9 | UI `/workers`(`WorkerDashboardPage`)에 "마지막 응답 N초 전" 열 + quiet(`secs_ago > interval` & `< stale_timeout`, 임계값은 응답에서 읽음) 시 "응답 없음(stale)" 배지를 표시하고, `ui/src/api/pool.ts`의 `PoolWorkerSummarySchema`에 `last_seen_secs_ago: z.number()`(Option 아님→`.nullish()` 금지) + 응답 래퍼에 두 임계값 필드를 추가한다 | RTL(열·배지) + 라이브 Playwright | ✅ wire: UI Zod(`PoolWorkerSummarySchema`+래퍼) ↔ REST DTO |
| R10 | 임계값은 CLI 플래그 `--pool-heartbeat-interval-seconds`(기본 10)·`--pool-stale-timeout-seconds`(기본 30)·`--pool-keepalive-seconds`(기본 20) + 상수 기본값으로 노출한다(ops-settings 페이지 통합은 연기) | CLI 파싱 단위 / `--help` | |
| R11 | `pool_mode` off 또는 풀 워커 0이면 리퍼 tick이 Ping·evict 0건이고 앱 동작이 **byte-identical**. h2 keepalive는 서버 빌더가 전 워커모드 공유라 *모든* gRPC 연결(per-run·k8s 포함) 대상이지만, 건강한 연결은 h2가 PING을 자동 ACK해 앱-레벨 동작·메시지 불변 — 가산되는 건 idle 연결의 무해한 전송계층 PING 프레임뿐(pool_mode 게이트 안 함=additive 전송 하드닝, R10 기본 20s 보수적) | 기존 워크스페이스 스위트 green + 단위 `empty_pool_tick_noop` | |
| R12 | proto·엔진·migration **무변경**(풀은 in-memory `CoordinatorState.pool`, Ping/Pong은 기존 메시지) | `git diff` proto 0줄·`store/` migration 추가 0 | |
| R13 | 리퍼 tick 본체는 주입형 헬퍼 `pool_heartbeat_tick(now)`로 분리해 가상시계(`tokio::time::pause`) 단위테스트로 잠그고, main.rs의 `tokio::spawn` 루프 배선만 라이브로 검증한다(main-only 와이어 한계, scheduler 패턴) | `start_paused` 단위 + 라이브 | |
| R14 | 리퍼는 풀 락을 **`.await` 너머로 들고 가지 않는다** — 락 안에서 `(wid, tx.clone(), last_seen)` 스냅샷만 수집→락 drop→락 밖에서 Ping send·evict 라우팅 | 코드 검토 + 단위(락 보유 중 send 없음) | |

- 한 계약의 양쪽은 두 R로: **R8(REST DTO 직렬화) ↔ R9(UI Zod 수용)** — 같은 계약-task에 묶거나 함께 머지(한쪽만 = 와이어 드리프트). R2의 seam은 proto를 *바꾸지 않고 기존 메시지를 사용*하므로 "와이어 추가"가 아니라 "와이어 활성화"다.

---

## 3. 핵심 통찰 (설계 근거)

1. **하이브리드 — 관심사 분리(앱 하트비트=라이브니스/capacity-정합/표시, h2 keepalive=연결 lifecycle).** 둘은 중복이 아니라 각자 다른 일을 한다. 앱 하트비트(R1~R5)는 *워커가 언제 계수되나*(capacity 가드 정합)와 *fast·tunable·앱-레벨 evict*를 소유하고, h2 keepalive(R6/R7)는 *죽은 연결 teardown*(orphan 스트림 태스크 정리)과 *워커 재등록*을 소유한다. h2 없이 앱-evict만 하면 evict된 워커의 스트림 태스크가 half-open 소켓에 블록된 채 남고(orphan), 워커는 자신이 evict된 줄 몰라 재등록 안 한다 → desync. 앱 없이 h2만 하면 last-seen 표시·앱-wedge 감지·sub-keepalive-timeout evict를 잃는다.

2. **R2(모든 워커 Ping) — "idle만 Ping, busy는 메트릭으로 자동 갱신"은 불안전.** 엔진 forwarder는 빈-배치(요청 0 윈도, `dropped==0`)를 스킵하므로 저활동/think-time-heavy/저-RPS busy 워커는 30s 침묵할 수 있다 → 거짓 stale-evict로 *건강한 run을 fail-fast*. 따라서 리퍼는 idle·busy 모두 Ping하고 워커는 ServerMessage를 읽는 모든 경로(idle 대기 + in-run, `client.rs:29` 주석이 "AbortRun, Ping, …"로 이미 예상)에서 Pong한다. `last_seen`은 임의 인바운드(R1)로 갱신하되 Pong이 신뢰 가능한 주 소스.

3. **R3/R5(evict 단일 경로) — `pool_disconnect`가 idle/busy를 이미 분기.** `pool_disconnect`(coordinator.rs:385)는 엔트리 제거 후 `assigned_run`이 `Some`이면 기존 `worker_disconnected` fail-fast로 라우팅한다. 리퍼는 stale 워커에 `pool_disconnect(wid)`만 호출하면 idle=조용히 제거, busy=run fail-fast가 자동 — 새 fail-fast 로직 0. stream-close 핸들러(line 1136~1142)와 **같은 경로**라 동작 일관.

4. **R4(멱등) — evict 후 stream-close 재호출은 no-op.** 리퍼가 먼저 evict하면 `HashMap::remove`로 엔트리가 사라지고, 뒤늦은 stream-close의 `pool_disconnect`는 `remove→None→and_then→None`이라 `worker_disconnected` 미호출. `worker_disconnected` 자신도 run terminal/부재면 early-return(A3a terminal 보존). 이중 안전.

5. **R11(byte-identical) — h2 keepalive는 healthy idle 연결을 죽이지 않는다.** keepalive는 PING에 ACK가 timeout 내 안 올 때만 연결을 닫는데, 건강한 워커의 h2 레이어가 PING을 자동 ACK하므로 정상 연결은 무영향. 빈 풀이면 리퍼가 Ping 0건. per-run·k8s 워커는 풀 미등록이라 리퍼 무관(keepalive는 그들의 idle 연결에도 무해 — 활성 run은 메트릭 스트림으로 연결이 active).

6. **R12(migration 0·proto 0) — 풀은 in-memory, Ping/Pong은 기존(방향 주의).** `last_seen`은 `PoolEntry`(in-memory) 필드라 DB 무관. proto상 `Ping`=`ServerMessage`(server→worker, `coordinator.proto:107`), `Pong`=`WorkerMessage`(worker→server, `coordinator.proto:16`) — 둘 다 이미 존재하나 inert다: **컨트롤러는 받은 `Pong`을 버리고**(`coordinator.rs:1131` `Pong(_) => {}`), **워커는 받은 `Ping`을 무시**(`client.rs:186` load_datasets + `abort_listener` `lib.rs:400-410` 침묵). 이 슬라이스는 메시지 추가 없이 그 방향을 *활성화*한다 — 컨트롤러 리퍼가 `Ping`을 *보내고* 받은 `Pong`에 `last_seen` 스탬프, 워커가 받은 `Ping`에 `Pong`을 *보냄*.

7. **R2/R5 거짓-evict 무위험 — idle-wait는 `connect_and_register`, assignment 후는 항상 도는 `forward_inbound` 펌프가 Ping에 답한다.** 풀 idle 워커는 `execute_assignment`가 아니라 그 *앞단* `connect_and_register`의 첫-메시지 대기(`client.rs:113`)에서 idle 시간을 보낸다 → idle Ping은 거기서 루프로 처리(§4.3-(1), 단발→루프가 R2의 핵심). assignment를 받으면 `connect_and_register`가 `forward_inbound` 펌프(`client.rs:137` spawn)를 띄우는데, 이 펌프는 **raw 스트림을 무조건 계속 드레인하는 단일 상시 태스크**라 — 워커가 느린 단일 HTTP 요청에 `await` 중이든 `load_datasets`/`abort_listener` 중 무엇이 inbound_rx를 읽고 있든 무관하게 — Ping을 받아 `out_tx`로 Pong을 답하고 consumer엔 전달하지 않는다(§4.3-(2)). 따라서 busy 워커도 Ping에 즉시 Pong → `last_seen` 신선 유지 → *건강한* busy 워커는 절대 거짓-evict 안 됨(R5 evict는 Pong이 영영 안 오는 진짜 죽은/half-open 워커만). 펌프 한 곳이 로딩+in-run 전 구간을 덮으므로 `load_datasets`/`abort_listener`는 손대지 않는다(빈-배치 스킵으로 침묵하는 저활동 busy 워커도 펌프 Pong으로 갱신 — "idle만 Ping"[불안전·§3.2]을 버린 이유). 이게 세 곳(consumer마다)에 Pong을 박는 것보다 적은 변경·더 견고하다.

---

## 4. 변경 상세

### 4.1 `crates/controller/src/grpc/coordinator.rs` — 충족 R: R1, R3, R4, R13, R14
- `PoolEntry`에 `last_seen: tokio::time::Instant` 추가. `pool_register_idle`에서 `Instant::now()`로 초기화(재-Register=fresh idle이므로 갱신).
- `pool_touch(&self, worker_id: &str)`: 풀 락 잡고 해당 엔트리 `last_seen = Instant::now()`(없으면 no-op).
- **`pool_heartbeat_tick(&self, now: Instant, stale: Duration)`(R13 주입형, 임계값은 *파라미터*)**: `stale_timeout`·`interval`을 `CoordinatorState`에 OnceLock로 박지 *않는다* — capacity가 CoordinatorState에서 제거된 선례(controller CLAUDE.md "CoordinatorState엔 capacity가 없다")와 일관, config는 coordinator 상태 아님. 가상시계 단위테스트가 자기 `stale`을 넘기고, main.rs 리퍼 클로저가 CLI 값을 넘긴다. 본체: 락 안에서 `(wid, tx.clone(), assigned_run.is_some(), last_seen)` 스냅샷만 수집·락 drop(R14) → `now − last_seen > stale`로 stale/alive 분할 → **락 밖에서** alive엔 `tx.send(Ping)`(dead-tx=`send().is_err()`도 stale 취급), stale엔 `pool_disconnect(wid)`. (Ping은 매 tick 전원; interval은 리퍼 루프의 `tokio::interval`이라 tick 파라미터 아님.)
- **dead-tx evict의 동시-assign 경합은 benign**(M3): 리퍼 evict와 병행 중인 `assign_pool_workers`가 같은 워커를 push하다 실패해도 둘 다 `pool_disconnect`/`worker_disconnected`로 수렴하고, `worker_disconnected`가 run terminal/부재 가드(coordinator.rs:767-781)로 멱등이라 run을 이중 fail 하지 않는다.
- 스트림 핸들러(`channel` 루프, coordinator.rs:998~): **풀 연결의 임의 인바운드에만** `last_seen`을 갱신 — `match` *뒤*에 `if pool_conn { if let Some(wid) = &worker_id { state.pool_touch(wid).await; } }`(R1·R-B). 루프 상단에 두면 첫 Register 메시지 때 `worker_id=None`·`pool_conn=false`라 못 타고, 비-풀(per-run/k8s) 핫 MetricBatch 경로에 불필요한 풀 락을 잡는다 → `pool_conn` 게이트 필수. (R1 "임의 인바운드"는 정확히 "*풀 연결*의 임의 인바운드"다 — 비-풀 워커는 풀 엔트리가 없어 touch가 의미 없음.) Pong arm은 `{}` 유지(touch가 공통 처리).

### 4.2 `crates/controller/src/main.rs` — 충족 R: R6, R10, R13
- `ControllerArgs`에 `--pool-heartbeat-interval-seconds`(기본 10)·`--pool-stale-timeout-seconds`(기본 30)·`--pool-keepalive-seconds`(기본 20). `pool_mode`일 때만 의미(off면 리퍼 미spawn).
- `pool_mode`면 `tokio::spawn`으로 리퍼 루프(`interval` tick → `coord.pool_heartbeat_tick(Instant::now())`), scheduler `run_scheduler` 패턴(graceful: select on shutdown). off면 미spawn(R11).
- gRPC 서버 빌더 **두 arm**(bundle line ~296·비-bundle ~305)에 `.http2_keepalive_interval(Some(dur))`·`.http2_keepalive_timeout(Some(dur))`(R6).
- **임계값 주입 = 리퍼 클로저 캡처(CoordinatorState OnceLock 아님)**(R-C 결정): 리퍼 `tokio::spawn` 클로저가 `interval`(루프 `tokio::interval`)·`stale`(→`pool_heartbeat_tick(now, stale)` 인자)을 CLI 값에서 캡처. CoordinatorState엔 config를 두지 않는다(capacity 제거 선례와 일관). 두 임계값은 `GET /api/pool/workers` 응답에도 실어야(R8) UI 배지가 drift 없이 읽는다 → main.rs가 AppState/핸들러에 값을 전달(기존 `pool_mode` 노출 경로와 동일 방식).

### 4.3 `crates/worker-core/src/client.rs` — 충족 R: R2, R2b, R7
- **Pong 응답은 *두* 사이트.** outbound는 항상 `connect_and_register`의 `tx: mpsc::Sender<WorkerMessage>`(Register/MetricBatch/RunStatus 송신측, 스트림 EOF 전이라 살아있음):
  - **(1) `connect_and_register` idle-wait (`client.rs:113-131`) — load-bearing 변경**: 현재 단발 `select!`로 첫 메시지를 받아 RunAssignment가 아니면 `WorkerError::NoAssignment`(line 124 `other` arm). 풀 idle 워커는 *여기서* push될 assignment를 무한 대기하므로(pump `forward_inbound`은 link 반환 후 line 137에서야 spawn — idle-wait엔 pump 없음, raw `inbound`를 직접 읽음), 이 대기를 **루프**로 바꾼다: `Ping(p)` → `tx.send(Pong{nonce:p.nonce})` 후 `continue`(계속 대기), `Assignment(a)` → break, 그 외/Err/None → 기존 에러. legacy(run_id present)는 assignment가 첫 메시지라 즉시 break → **byte-identical**(R2b·R11).
  - **(2) `forward_inbound` 펌프 (`client.rs:52-78`, assignment 후 상시 raw-스트림 드레이너) — Ping 응답을 여기 한 곳에**: `forward_inbound`에 `out_tx: mpsc::Sender<WorkerMessage>` 파라미터 추가(`connect_and_register`가 spawn 시 `tx.clone()` 전달, `client.rs:137`). 루프의 `Ok(m)` arm에서 `m.payload`가 `Ping(p)`면 `out_tx.send(Pong{nonce:p.nonce})` 후 `continue`(consumer로 **전달 안 함**), 그 외는 기존대로 `fwd_tx`로 forward. **이 펌프가 로딩(`load_datasets`)+in-run(`abort_listener`) 전 구간의 유일한 raw-스트림 드레이너라 둘 다 무변경**(Ping은 펌프가 먹어 `inbound_rx`에 안 들어옴). 펌프는 엔진 VU 태스크와 별개 상시 태스크라 워커가 느린 단일 요청에 `await` 중이어도 Ping에 즉시 응답(거짓 evict 없음 — §3.7).
- `Endpoint`(`connect_and_register`의 connect 빌더, `client.rs:89-91`)에 `.keep_alive_while_idle(true)`·`.http2_keep_alive_interval(dur)`·`.keep_alive_timeout(dur)`(R7). 워커 CLI에 `--keepalive-seconds`(기본 20) 또는 상수.

### 4.4 `crates/controller/src/grpc/coordinator.rs` `PoolWorkerInfo` + `crates/controller/src/api/pool.rs` — 충족 R: R8
- **세 군데** 가산(snapshot 타입 → wire DTO → 응답 래퍼):
  - `PoolWorkerInfo`(coordinator.rs:100)에 `last_seen_secs_ago: u64`; `pool_snapshot(now)`가 `now.duration_since(e.last_seen).as_secs()`로 변환(Instant 비직렬화 회피 — 시그니처가 `()`→`(now)`로, 호출부 1곳 `api/pool.rs:28` + 테스트 2곳 갱신, R8 bounded).
  - **wire DTO `PoolWorkerSummary`(api/pool.rs:7)에 `last_seen_secs_ago` 필드 + 매핑 `.map()`(api/pool.rs:31) 갱신** — 응답 본문은 `PoolWorkerInfo`가 아니라 이 struct다(field-by-field map). token/env/tx 비노출 불변식 유지(R12 기존 — `PoolWorkerSummary`에 그 필드 자체가 없음).
  - 응답 래퍼(`pool_mode`/`workers`를 싣는 핸들러)에 `heartbeat_interval_seconds`·`stale_timeout_seconds` 최상위 필드 추가(M2, UI 배지용 — main.rs가 CLI 값을 핸들러로 전달).

### 4.5 UI `ui/src/pages/WorkerDashboardPage.tsx`·`ui/src/api/pool.ts`·`usePoolWorkers`(`ui/src/api/hooks.ts`) — 충족 R: R9
- `ui/src/api/pool.ts`의 Zod `PoolWorkerSummarySchema`(현 `z.object`, `.strict()` 아님 — 필수 필드 추가라 무관)에 `last_seen_secs_ago: z.number()` 추가(와이어 1:1·Option 아님→`.nullish()` 금지, run_id `.nullable()` 컨벤션 유지) + `PoolWorkersResponseSchema`에 `heartbeat_interval_seconds`·`stale_timeout_seconds: z.number()` 추가. `WorkerDashboardPage`에 "마지막 응답" 열(`{n}초 전`) + `secs_ago > interval && < stale_timeout`면 "응답 없음(stale)" 배지 — **임계값은 응답에서 읽어**(클라 하드코딩 금지, CLI 가변이라 drift). evict되면 `usePoolWorkers` 폴링(3s)에서 행 사라짐(기존 동작). ko.ts 카탈로그 경유(ADR-0035).

---

## 5. 무변경 / 불변식 (명시)

- **proto 무변경**(R12): 기존 `Ping`/`Pong`/`PoolEntry` 외 메시지·필드 추가 0.
- **migration 무변경**(R12): 풀은 in-memory, `last_seen`은 `PoolEntry` 런타임 필드. `store/` 추가 0.
- **엔진 무변경**(R12): 부하 생성·메트릭 경로 미접촉.
- **byte-identical when off**(R11): `pool_mode` off → 리퍼 미spawn, 기존 코드 경로 100% 보존. 풀 워커 0 → tick no-op. per-run subprocess·k8s 워커는 풀 미등록이라 하트비트 무관(h2 keepalive는 그들에도 무해).
- **evict 로직 신규 0**(R3): `pool_disconnect`/`worker_disconnected` 기존 경로 재사용 — fail-fast 의미론·dispatcher cleanup·sibling abort 전부 그대로.

---

## 6. 테스트 / 검증

| R-id | 검증 방법 (테스트명 / 관찰) | 라이브? |
|---|---|---|
| R1 | 단위 `pool_touch_advances_last_seen` | |
| R2 | 단위 `tick_pings_all_entries` + 워커 `ping_elicits_pong`(idle-wait·in-run) | |
| R2b | 워커 단위 `idle_wait_survives_repeated_pings`(Ping N회 후 대기 유지→Assignment 수신) | |
| R3 | 단위 `stale_idle_evicted`·`stale_busy_routes_worker_disconnected` | |
| R4 | 단위 `double_evict_idempotent` | |
| R5 | 단위(R3 busy) + 라이브 `kill -STOP` busy 워커 → run failed | ✅ |
| R6 | 두 arm 컴파일 + 라이브 연결 teardown 관측 | ✅ |
| R7 | 라이브 워커 stream-close → reconnect → 풀 재등록 | ✅ |
| R8 | 단위 `snapshot_includes_last_seen` + curl `GET /api/pool/workers` | ✅ |
| R9 | RTL(열·배지) + 라이브 Playwright(`/workers`) | ✅ |
| R10 | CLI 파싱 단위 / `--help` 관찰 | |
| R11 | 기존 워크스페이스 스위트 green + 단위 `empty_pool_tick_noop` | |
| R12 | `git diff` proto 0·migration 0 | |
| R13 | `start_paused` 가상시계 단위(stale 점프) + 라이브 리퍼 spawn | ✅ |
| R14 | 코드 검토(락 밖 send) | |

- **라이브 검증 필수**(`/live-verify` + 실 pool 스택): main-only 리퍼 spawn 배선(R13)·run fail-fast(R5)·UI 응답경로(R8/R9, S-D 갭)·h2 keepalive(R6/R7)는 단위로 안 닫힌다. 시나리오: 실 pool 2워커 → 1워커 `kill -STOP`(half-open 모사) → 대시보드 "응답 없음"→stale-timeout 후 evict→행 사라짐 + 그 사이 `GET /api/pool/workers` idle_count 감소(capacity가 죽은 워커 미계수) + busy 워커였으면 run failed + `kill -CONT` 또는 재기동 시 reconnect→재등록.

---

## 7. 의도적 연기 (roadmap §B/LAN 연기에 누적)

- **ops-settings 페이지 통합**: 임계값 3종을 `/settings` 런타임 가변 knob으로(ADR-0039 레지스트리). v1은 CLI 플래그(scheduler config도 동일하게 CLI-only로 연기 중 — 일관). 표면(레지스트리 행+DTO+Zod) 큼.
- **제어 액션**: 수동 disconnect/exclude/cap(대시보드 버튼). 라이브니스와 별개 — 별도 슬라이스.
- **영속 worker_id / 재시작 후 풀 복구**: 컨트롤러 재시작 시 풀은 비고 워커가 reconnect로 재등록(현 동작). 영속화 불요.
- **mTLS 채널 기밀성**: ADR-0041 연기 그대로. 하트비트는 평문 채널 위 — 직교.
- **per-stage/per-worker 라이브니스 시계열·하트비트 RTT 메트릭**: 진단 곁다리, YAGNI.
- **앱-wedge 정밀 감지(TCP alive·앱 deadlock)**: R2 Ping 미응답으로 이미 evict되나, 별도 워커 헬스 프로브(메모리/스레드)는 비목표.

---

## 8. 구현 순서 (plan 입력)

> cargo-영향 커밋마다 전체 워크스페이스 게이트 → 미사용 헬퍼만/RED만 단독 커밋 불가 → green fold 지점 명시.

1. **T1 컨트롤러 코어** (R1·R3·R4·R13·R14): `PoolEntry.last_seen` + `pool_touch` + `pool_heartbeat_tick(now)` + 핸들러 상단 touch + 인라인 단위(가상시계 stale·idempotent·busy 라우팅·빈 풀 no-op). 헬퍼+단위 한 green 커밋(미사용 헬퍼 dead_code 회피 위해 테스트가 즉시 호출).
2. **T2 워커** (R2·R2b·R7): `connect_and_register` idle-wait 단발→루프(Ping→Pong, Assignment break) + **`forward_inbound`에 `out_tx` 파라미터 추가 + Ping→Pong·non-forward**(`client.rs:52-78`·137, `load_datasets`/`abort_listener` 무변경) + `Endpoint` keep_alive + worker-core 단위(`idle_wait_survives_repeated_pings`·`ping_elicits_pong`(idle-wait·pump)). (proto 무변경이라 codegen 영향 0; legacy run_id-present byte-identical.)
3. **T3 main.rs 배선** (R6·R10·R13): CLI 플래그 3종 + 리퍼 `tokio::spawn` 루프 + 서버 빌더 두 arm h2 keepalive. main-only라 라이브로 검증(인라인 테스트는 T1 헬퍼가 커버).
4. **T4 UI/REST** (R8·R9): `PoolWorkerInfo`+`pool_snapshot(now)` `last_seen_secs_ago` → wire DTO `PoolWorkerSummary`(api/pool.rs:7)+`.map()`(api/pool.rs:31) → 응답 래퍼 `heartbeat_interval_seconds`·`stale_timeout_seconds` → UI `WorkerDashboardPage` 열/배지 + `PoolWorkerSummarySchema`+래퍼 Zod. R8↔R9 같은 머지(와이어 1:1).

분할 슬라이스 아님(단일 브랜치). `seam ✅` R(R2·R6·R8·R9)은 한 브랜치서 양쪽 동시 머지.
