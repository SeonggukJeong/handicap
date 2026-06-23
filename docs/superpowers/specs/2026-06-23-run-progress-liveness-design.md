# Run 진행 라이브니스 (등록 후 hung 워커) — 설계

- **상태**: 설계 (G1). 구현은 **G1a(A+B) 먼저**, C는 G1b 후속.
- **날짜**: 2026-06-23
- **관련**: G3(실패 run 진단 사유 message, `2026-06-23-run-failure-reason-message-design.md`) 직후 잔존 갭. ADR-0010/0027(coordinator 상태머신), ADR-0009(라이브 대시보드 없음), [[load-divergence-explain-confirm]].
- **스코프**: 컨트롤러 전용(G1a). migration 0 / proto는 *추출만*(필드 추가 0) / UI 0 / engine 0 / worker 동작 0.

---

## 1. 문제: "등록 후 hung 워커" — 유일하게 남은 stuck-running

컨트롤러에는 run 라이브니스를 지키는 메커니즘이 여럿 있지만 **하나의 사각지대**가 있다:

| 기존 메커니즘 | 잡는 것 | 위치 |
|---|---|---|
| `worker_disconnected` fail-fast | gRPC **스트림이 닫힘**(워커 크래시/단절) | coordinator.rs:1350 |
| 등록 watchdog (`registration_watchdog`, 60s) | 워커가 **등록을 못 함** | coordinator.rs:1159, `enqueue` 681 |
| L6 하트비트 리퍼 (pool 모드 전용) | **half-open 죽은 연결**(Ping/Pong 무응답) | `is_pool_mode()` 게이트 main.rs |
| subprocess reaper (`child.wait()`) | 워커 프로세스 **exit** | dispatcher/subprocess.rs |
| `mark_orphans_failed` | 컨트롤러 **재시작** 복구 | main.rs:163 |

**갭**: 워커가 **등록을 마쳤고**, gRPC 스트림 연결도 **건강**하며(pool 모드라면 L6 Ping/Pong에도 계속 응답), 그런데 엔진이 **전혀 진행하지 않는** 경우 — 엔진 데드락/wedge, 0 요청, run이 영영 `running`. 위 어느 것도 "살아있지만 무진행"을 못 잡는다. (참고: 헤드라인 "stuck running"의 다른 원인들은 2026-06-05 fail-fast + G3로 이미 닫혔다 — `docs/build-log.md`.)

### 1.1 핵심 신호: "마지막 진행" ≠ "마지막 응답"

엔진은 **drain이 비어있지 않을 때만** `MetricFlush`를 워커→컨트롤러로 보낸다(`runner.rs:235` `if !drained.is_empty() || ...` 가드). 따라서 **무진행 엔진은 메트릭을 0개 보낸다**. 한편 L6의 `last_seen`은 *임의 인바운드*(Pong 포함)로 갱신되므로(coordinator.rs:1336–1343), hung-but-responsive 워커는 `last_seen`이 신선해 L6에 안 걸린다. → **진행 라이브니스는 별도 신호(마지막 *메트릭* 도착 시각)** 가 필요하다. 컨트롤러에서 모든 워커 MetricBatch의 단일 sink는 `ingest_metrics`(coordinator.rs:1319→1450).

---

## 2. 설계 철학: 3-tier — 확실한 건 자동 fail, 불확실한 건 운영자에게 알림

오탐(false positive) 위험과 "자동으로 run을 죽일 권한"을 **짝지으면 안 된다**([[load-divergence-explain-confirm]]). 신호를 확실성으로 3단계로 나눈다:

| Tier | 신호 | 확실성 | 동작 | 슬라이스 |
|---|---|---|---|---|
| **A. startup hang** | 등록 후 유효 grace 안에 **첫 메트릭 0** | **확실** — run-level think는 iteration *사이* 적용(`runner.rs:404`)이라 첫 요청은 t≈0 즉시 | **자동 `Failed`** + 사유 message | **G1a** |
| **B. duration backstop** | `started + 예상종료 + grace` 초과인데 terminal 미도달 | **확실** — 정상 run은 예상시간 안에 끝남 | **자동 `Failed`** + 사유 message | **G1a** |
| **C. mid-run stall** | 메트릭이 흐르다 `stall_threshold`간 끊김 | **불확실** — think-time/선두 rate=0 stage가 합법적으로 침묵 가능 | **자동 fail 안 함** → "정지 의심" 표시 + 운영자가 [중지] 결정 | **G1b** |

**왜 C는 advisory("알림+확인")인가:**
1. 제품에 **라이브 대시보드/푸시 인프라가 없다**(ADR-0009, WebSocket post-MVP). "모달로 물어보기"는 불가 → run 상세/목록에 **"정지 의심" 배지 + 기존 [중지] 버튼**으로 표면화 = 제품 제약 안의 "물어보기".
2. **advisory라서 오탐이 치명적이지 않다** — 틀린 경고는 "잘못된 배지"일 뿐 죽은 run이 아니다. 그래서 C의 임계값을 think-time까지 완벽 도출할 필요 없이 넉넉한 기본값으로 충분(틀려도 운영자가 무시).
3. 운영자가 무시해도 **B(backstop)가 결국 자동으로 닫는다** — C=조기경보, B=확실한 최종 차단.

> **이 spec은 A+B+C 전체 설계를 기록**하되, **G1a는 A+B만 구현**한다. C(§7)는 비전 보존을 위해 설계 의도까지만 적고, 상세 메커니즘(임계값 도출·migration·Zod·UI·중지 동선)은 **G1b에서 자체 plan**으로 확정한다.

---

## 3. G1a 아키텍처 — 등록 watchdog를 3-phase `run_watchdog`로 확장

기존 `registration_watchdog`(coordinator.rs:1161, doc 1159)는 등록 1단계만 본다. 이를 **Phase 1 로직을 보존한 채 `run_watchdog`로 재작성**(free fn 재작성 + `enqueue`의 spawn 사이트[coordinator.rs:708–710] 갱신)해 per-run 진행 watchdog로 확장한다. **새 태스크가 아니라 동일 태스크의 재작성** — run당 sleeping 태스크 수 불변.

```
run_watchdog(run_id, reg_deadline, first_load, done, startup_grace_eff, backstop_total):
  // Phase 1 (기존): 등록
  select! {
    _ = sleep(REGISTRATION_DEADLINE)  => coord.fail_incomplete_registration(run_id); return  // 기존 동작
    _ = reg_deadline.cancelled()      => {}      // 전원 등록 → 진행
    _ = done.cancelled()              => return  // 이미 terminal(매우 빠른 run/early fail)
  }
  let started = Instant::now();   // Phase 2 진입 = 전원 등록 시각 (§3.6: DB started_at[첫 워커]과 N≥2면 갭)
  // Phase 2: startup (A)
  select! {
    _ = sleep(startup_grace_eff)  => coord.fail_run_hung(run_id, MSG_A); return  // 무부하
    _ = first_load.cancelled()    => {}      // 첫 메트릭 도착 → 진행
    _ = done.cancelled()          => return
  }
  // Phase 3: backstop (B)
  select! {
    _ = sleep(backstop_total.saturating_sub(started.elapsed())) => coord.fail_run_hung(run_id, MSG_B); return
    _ = done.cancelled()          => return
  }
```

- `startup_grace_eff`/`backstop_total`은 **`Duration`**(§3.3/§3.4에서 `spawn_run`이 계산해 `enqueue`로 주입). `#[cfg(test)]` 단위테스트가 sub-second `Duration`을 직접 넣어 실타이머로 빠르게 발동시킨다(§6).
- `reg_deadline.cancel()`는 전원 등록 시점(**`register`**가 `next_shard==expected` 달성, coordinator.rs:753 — `register` 내부). **변경 없음** — Phase 1은 기존 그대로(단 `done` arm 추가).
- `started`는 watchdog-로컬 `Instant`(Phase 2 진입). DB `started_at` 재조회 불요(grace가 slop 흡수, §3.6).

### 3.1 새 신호: `RunWorkers`에 토큰 2개

`RunWorkers`(coordinator.rs:139)에 `reg_deadline: CancellationToken`(기존)과 동형으로:

- **`first_load: CancellationToken`** — `ingest_metrics`가 그 run의 **첫 배치**에 1회 `cancel()`(이후 배치는 멱등 no-op). `ingest_metrics`가 `runs` 락을 1회 잡아 호출 — 저빈도라 핫 path 아님(§3.5).
- **`done: CancellationToken`** — 모든 **finalize 사이트**가 `cancel()`(정상 완료/실패/abort). 정상 run에서 watchdog이 Phase 2/3 sleep을 즉시 빠져나와 종료(lingering 0). race는 §4의 terminal-guard가 흡수.

두 토큰 모두 `enqueue`에서 `RunWorkers` 생성 시 `CancellationToken::new()`로 초기화(reg_deadline 패턴).

**역할 분리 — `reg_deadline`("진행")와 `done`("정지")는 의미가 다르다**:
- `reg_deadline.cancel()` = "Phase 1 통과(전원 등록)" *진행* 신호. **유일 canceller = `register`(전원 등록 달성, coordinator.rs:753) 그대로 유지** — 의미를 늘리지 말 것.
- `done.cancel()` = "watchdog 전체 정지(run terminal)" 신호. **모든** terminal 전이가 cancel.
- **함정**: 현재 `cancel_dispatch_failed`(coordinator.rs:1038)는 `reg_deadline`를 cancel한다. 3-phase 모델에선 이게 "진행"으로 오작동(Phase 1이 reg_deadline arm을 타 Phase 2로 진행 후 grace만큼 lingering — terminal-guard로 무해하나 지저분). → `cancel_dispatch_failed`는 **`done`을 cancel**하도록 바꾼다(reg_deadline 아님). watchdog Phase 1의 `done` arm이 등록-전 terminal을 즉시 정리. (`fail_incomplete_registration`은 watchdog *자신이* 호출[Phase 1 timeout] 후 return이라 done cancel 불요.)

### 3.2 fail 메서드 — `fail_incomplete_registration` teardown 재사용

A/B의 fail은 `fail_incomplete_registration`(coordinator.rs:993)와 **동일 teardown**: 락 안에서 `terminal=true` + sibling tx 스냅샷 → 락 drop → `mark_failed_if_active`(사유) + `fan_out_abort`(등록 워커) + `cleanup_dispatcher`(subprocess kill / k8s Job 삭제). R14 락 규율(스냅샷 락 안 `.await` 0 → drop → DB/abort/cleanup 락 밖) 준수.

→ **공통 teardown을 `fail_run_hung(run_id, reason: &str)`로 추출**(가드 = `terminal`이면 no-op). `fail_incomplete_registration`도 이를 호출하도록 정리(reason만 다름). A=`MSG_A`, B=`MSG_B`로 호출.

- `mark_failed_if_active`(가드 `WHERE status IN ('pending','running')`)라 reaper·worker_disconnected와 race해도 terminal run을 클로버하지 않음(G3·codex eval 노트).
- `MSG_A` = `"worker registered but produced no load within {grace}s — the run appears stuck (no metrics received)"`
- `MSG_B` = `"run exceeded its expected-duration budget ({backstop_total}s, incl. grace) without reaching a terminal state — the run appears stuck"` (watchdog는 합산 `backstop_total`만 보유 → 단일 숫자)
- 둘 다 `truncate_message`(≤1000 char, G3 헬퍼) 경유. 시크릿 미포함(profile 값/URL 미노출 — secret-free 합성 문구).

### 3.3 B의 예상종료 = `run_duration_secs` 단일 소스화 (drift 0)

엔진 deadline의 단일 공식은 worker crate의 **private** `run_duration_secs(&pb::Profile)`(worker/lib.rs:609): `VU곡선 stage 합 > 레이트곡선 stage 합 > flat duration_seconds`. 불변식: "엔진 deadline = 이 값"(worker/lib.rs:608 주석).

- **proto crate로 `pub fn run_duration_secs(p: &pb::Profile) -> u64` 추출** → worker(기존 호출부)와 컨트롤러가 **동일 함수를 동일 proto Profile에** 적용. 두 표현(REST/proto) 사이 복제·parity 테스트 불요 — 구조적 동일.
- `spawn_run`(api/runs.rs)이 워커로 보낼 proto Profile(`assignment.profile`)에서 `expected_secs = run_duration_secs(&proto_profile)`를 계산 → `backstop_total: Duration = from_secs(expected_secs) + backstop_grace`를 `enqueue`로 전달(`Duration` 타입 — §6 단위테스트 sub-second 주입 가능). `backstop_grace`는 CLI flag에서 온 OnceLock 값(§3.7). **계산은 `assignment`가 `enqueue`로 *move 되기 전*에**(§9 finding) — `assignment.profile`에서 도출 후 3개 enqueue 사이트 전부에 전달.
- **proto crate 위치 근거**: 함수가 `pb::Profile`(proto 타입)에 작동하고 worker·controller 둘 다 이미 proto crate 의존 → 새 의존 엣지 0, 자연스러운 공유 홈. (engine crate는 자체 `RunPlan`만 알고 `pb::Profile`은 모름.)

### 3.4 A의 유효 grace = `max(CLI, http_timeout+margin) + leading_idle`

A가 "느린 SUT"를 hung으로 오인하지 않도록 grace를 도출한다(전부 `spawn_run`이 proto Profile + CLI에서 계산해 `enqueue`로 전달):

```
startup_grace_eff = max(cli_startup_grace, http_timeout_eff + STARTUP_MARGIN) + leading_idle_secs(profile)
```

- **`http_timeout_eff`**: `spawn_run`이 만든 **proto Profile**의 `http_timeout_seconds`(proto field 5, coordinator.proto:142)를 읽는다. 값 범위는 **REST Profile** 검증(`store::runs::Profile`, 1–600 at runs.rs:385) + spawn_run의 REST→proto 매핑(runs.rs:606)으로 1–600 보장. **방어적으로 worker의 `0→30s` fallback(lib.rs:230)을 미러**(`if t==0 {30} else {t}`) — 현 컨트롤러는 항상 1–600을 보내 실질 무의미하나 정합. 블랙홀 SUT(연결 받고 무응답)는 timeout 후에야 첫 에러-메트릭을 내므로 grace는 그보다 커야 함. (per-step `timeout_seconds` 오버라이드[scenario.rs:83]가 run-level보다 큰 극단은 §8 연기 — CLI flag가 escape hatch.)
- **`leading_idle_secs`**: open-loop `stages`(또는 `vu_stages`)의 **선두 연속 `target==0` stage 지속시간 합**(지연 출발). 일반 run = 0. 이게 없으면 선두 flat-zero stage가 A를 오발동.
- **`STARTUP_MARGIN`**: 상수(예 15s).
- 일반 run(closed vus>0 / open target_rps>0 / 곡선 첫 target>0)은 `leading_idle=0` + `http_timeout=30` → `startup_grace_eff = max(90, 45) = 90`.

### 3.5 `ingest_metrics`의 first_load cancel

`ingest_metrics`(coordinator.rs:1450)가 run의 매 배치에서 `runs` 락을 잡아 `batch.run_id`로 `RunWorkers`를 찾고 `first_load.cancel()`(멱등)을 호출 후 락 drop. **핫 path 아님**: MetricFlush는 워커당 ~1–2회/초(엔진 플러셔 500ms tick, runner.rs:220 → 워커가 flush당 1배치 전달)라 `runs` 락을 배치당 1회 잡아도 register/record_phase/abort보다 훨씬 드물어 경합 무관.

> **(리뷰어 반영) lock-free precheck는 불가** — 풀 워커는 빈 run_id로 idle 등록(coordinator.rs:1220–1234, `continue`)이라 스트림 핸들러의 connection-local에 run_id가 없고, `ingest_metrics`는 `batch.run_id`(coordinator.rs:1458)로만 run을 안다. `first_load`는 `RunWorkers`(=`runs` mutex 안)에 살아서 락 없이 `is_cancelled()`를 못 읽는다(L6 `pool_touch`의 `pool_conn` 게이트는 connection-local bool 기준이라 여기 전이 안 됨). → 단순 lock-per-batch가 정답(저빈도라 무해). 단위테스트로 "첫 배치만 cancel(이후 멱등 no-op)" 잠금.

### 3.6 fan-out / 모드 의미

- **`started`(Phase 2 진입) = 전원 등록 시각 ≠ DB `started_at`(첫 워커)**: `set_status(Running)`+`started_at`은 **첫** 워커 register(`set_running=first`, coordinator.rs:741/1296)에, watchdog Phase 2 진입은 **전원** 등록(`reg_deadline.cancel()`, line 753)에 일어난다. N=1이면 일치, **N≥2면 등록 윈도우만큼 갭**. B의 backstop(`started + run_duration_secs + grace`)은 각 워커가 자기 register+데이터셋 스트리밍 후 엔진 deadline을 시작하므로, **`backstop_grace`가 (등록 윈도우 + 데이터셋 스트리밍)을 흡수**해야 한다(기본 120s면 충분). N=1 지배 케이스는 정확.
- **B = per-run**: run은 모든 워커가 Completed일 때 finalize(coordinator.rs:882). N 워커 중 하나라도 hung이면 영영 running → B가 `started+expected+grace`에 닫는다. ✓
- **A = per-run "어느 워커도 메트릭 0"**: 전원 startup hang이면 first_load 미취소 → A 발동. 일부 워커만 메트릭을 내면 A 미발동(부분 부하) → 그 부분-hang은 B(느림)·C(G1b 빠름)가 담당. G1a 스코프엔 충분.
- **모드 무관**: watchdog은 coordinator-level이라 subprocess/pool/k8s 공통. teardown만 mode-aware(`cleanup_dispatcher`).

### 3.7 CLI flags — `OnceLock` 주입 (AppState/settings churn 회피)

- `--run-startup-grace-seconds`(기본 **90**) — A의 CLI 바닥값. · `--run-backstop-grace-seconds`(기본 **120**) — B의 grace.
- **저장 = `OnceLock` 패턴**(`set_worker_token`/`set_dispatcher` 선례, controller CLAUDE.md LAN L1): main.rs가 startup 1회 `set_watchdog_grace(Duration::from_secs(startup), Duration::from_secs(backstop))` → `spawn_run`이 `watchdog_grace()`(미설정 시 기본 90/120 반환)를 읽어 §3.3/§3.4의 최종 `Duration`을 계산.
  - **(리뷰어 finding 4 — settings 레지스트리 대신 OnceLock 선택)**: 리뷰어는 `AppState` 신규 필드(~42 literal churn) 회피를 위해 settings 레지스트리를 제안했으나, 그 churn 우려는 **OnceLock이 더 잘 해결**한다 — AppState 필드 0 · migration 0 · **/settings UI 표면 0**(사용자의 "G1a=CLI-only, /settings=B2 후속" 분할을 정확히 보존; settings 레지스트리는 readonly 행이라도 /settings에 자동 렌더돼 B2를 앞당김). 테스트 미설정 시 기본값(90/120)이라 e2e healthy run은 A/B를 못 건드림(리뷰어의 e2e-default 우려 충족). **B2(/settings 런타임 가변)는 이 OnceLock을 settings 레지스트리로 이주**(L6 ops-hardening 경로)하면 됨.
  - **`Duration`으로 주입** — `spawn_run`이 OnceLock seconds + http_timeout + leading_idle로 최종 `startup_grace_eff`/`backstop_total`(둘 다 `Duration`)을 만들어 `enqueue`로 전달. 단위테스트는 `enqueue`에 sub-second `Duration`을 직접 넣어(OnceLock·spawn_run 우회) 실타이머로 빠르게 발동(§6).
- `?args` Debug 덤프에 시크릿 없음(이 둘은 비밀 아님 — LAN L1 보안 노트는 무관).

---

## 4. 불변식

1. **healthy run 행동 불변**: A+B는 항상 무장하지만, 정상 run은 `first_load`(첫 메트릭)·`done`(완료)가 grace 전에 cancel → watchdog이 조용히 종료. **오직 "영영 running이던 run만" `Failed`+사유로 바뀐다.** 정상 완료/실패/abort run의 status·report·DB는 슬라이스 전과 동일.
2. **terminal 비클로버**: 모든 fail 경로가 `mark_failed_if_active`(terminal-guard) → reaper/worker_disconnected/정상 finalize와 race-safe. watchdog이 done-cancel 직후에 깨어 fail을 시도해도 no-op.
3. **단일 소스**: B의 예상시간 = worker가 쓰는 *바로 그* `run_duration_secs`(proto crate 공유) → 엔진 deadline과 drift 구조적 0.
4. **migration/proto-field/UI/settings/AppState/engine 0**: `runs.message`(migration 0002)·`mark_failed_if_active`·`cleanup_dispatcher`·`fan_out_abort`·`truncate_message`·`RunSchema.message`/`RunDetailPage`("실패 사유:") 전부 기존 자산. proto는 `run_duration_secs` 추출만(필드 0). worker는 자기 `run_duration_secs`를 공유본으로 교체(동작 byte-identical). grace는 OnceLock(§3.7)이라 AppState/settings/UI 무변경.

---

## 5. 요구사항 (G1a)

- **R1** 전원 등록 후, 유효 grace(`startup_grace_eff`) 안에 메트릭이 0이고 run이 여전히 `pending`/`running`이면 run을 `Failed` + `MSG_A`로 전이하고 등록 워커 abort + dispatcher cleanup.
- **R2** `started + run_duration_secs(profile) + backstop_grace` 초과인데 terminal 미도달이면 run을 `Failed` + `MSG_B`로 전이 + teardown.
- **R3** 등록 1단계(`REGISTRATION_DEADLINE` 60s + `fail_incomplete_registration`)는 **동작 불변**(Phase 1 = 기존).
- **R4** `ingest_metrics`가 run 첫 배치에 `first_load`를 cancel(매 배치 `runs` 락 1회 — §3.5, 저빈도라 핫 path 아님; 이후 멱등 no-op).
- **R5** 모든 finalize 사이트(record_phase Completed/Failed/Aborted, worker_disconnected, cancel_dispatch_failed, abort→record_phase 경유)가 `done`을 cancel → 정상 run watchdog 즉시 종료.
- **R6** A/B fail은 `fail_run_hung` 공통 teardown(terminal-guard + `mark_failed_if_active` + `fan_out_abort` + `cleanup_dispatcher`, R14 락 규율) 재사용.
- **R7** `run_duration_secs`를 proto crate `pub fn`으로 추출, worker(기존 호출부)·controller(`spawn_run`) 공용. worker 동작 byte-identical.
- **R8** `startup_grace_eff = max(cli_startup, http_timeout_eff+MARGIN) + leading_idle_secs`(`http_timeout_eff`=proto field 5, `0→30` fallback). `backstop_total = run_duration_secs + cli_backstop`. 둘 다 **`Duration`**으로 `spawn_run`이 `assignment.profile`+OnceLock에서 계산(move 전) → 3개 enqueue 사이트에 전달.
- **R9** CLI `--run-startup-grace-seconds`(90)·`--run-backstop-grace-seconds`(120) → main.rs `set_watchdog_grace` OnceLock(§3.7). 단위테스트는 `enqueue`에 sub-second `Duration` 직접 주입 + 실타이머(`pause()` 아님 — §6).
- **R10** `enqueue` arity 변경(새 timing 파라미터)은 전체 워크스페이스 게이트 — 모든 호출 사이트(프로덕션 + 단위/e2e)를 같은 green 커밋에서 갱신(L3 enqueue-arity 선례).
- **R11** healthy run byte-identical(불변식 1) — 기존 e2e(`two_worker_fanout_completes`·`full_slice_1_e2e` 등) 무변경 통과.

---

## 6. 테스트 전략 (G1a)

- **단위(주 증명) — 실타이머 패턴 (`pause()` 아님!)**: `run_watchdog`는 발동 시 `fail_run_hung → mark_failed_if_active`(DB write)를 하는 **spawned-sleep 태스크**라, `tokio::time::pause()/advance()`로 깨우면 sqlx `acquire_timeout`이 같이 터져 **`PoolTimedOut`**(coordinator.rs:2151–2156 명시 함정). → 반드시 **`watchdog_fires_after_deadline`(coordinator.rs:2147) 실타이머 패턴**을 따른다: grace를 **sub-second `Duration`으로 `enqueue`에 직접 주입**(seconds CLI 우회) + 실제 `tokio::time::sleep`로 빠르게 발동. (`pause()`-after-connect 패턴[coordinator.rs:2805+]은 동기 injected-now 함수 `pool_heartbeat_tick(now,stale)` 전용 — DB write 없는 순수 함수라 가능했던 것. run_watchdog엔 부적용.) 검증:
  - A 발동: 전원 등록 → first_load 미취소 → sub-second `startup_grace_eff` 경과 → run `Failed`+`MSG_A`.
  - A 미발동: 첫 메트릭(first_load cancel) → A sleep 빠져나감.
  - B 발동: first_load 취소 후 done 미취소 → sub-second `backstop_total` 경과 → `Failed`+`MSG_B`.
  - done-cancel(정상 완료) → A·B 둘 다 미발동(watchdog 종료).
  - Phase 1 회귀: 기존 `watchdog_fires_after_deadline`·`incomplete_registration_records_failure_message` 무변경 통과.
  - `run_duration_secs`(proto crate) 단위: closed/open-stages/vu-curve 3모드 + worker 호출부 parity.
  - `startup_grace_eff`/`leading_idle_secs` 순수함수 단위(선두 0-stage / http_timeout 큰 값).
- **enqueue-spawn 커버**: watchdog은 `enqueue`에서 spawn → 단위테스트가 coord 메서드 직접 호출로 커버(main-only 아님 — 스케줄러/리퍼와 다름).
- **라이브 검증(필수 — run 생명주기 경로)**: **subprocess 모드 + `kill -STOP`**. STOPped 워커는 reaper(exit 아님)·worker_disconnected(스트림 유지) 둘 다 미발동 = 정확히 G1 조건. L6 하트비트는 pool-only라 무간섭. **짧은 flag**(startup-grace 5s·backstop-grace 3s + duration 5s)로 A/B가 h2-keepalive teardown(~20s, L6 추가) *전에* 발동하게:
  - 첫 메트릭 *전* STOP → ~5s에 `Failed`+"no load"(A) + UI "실패 사유:" 렌더.
  - 메트릭 흐른 *후* STOP → backstop에 `Failed`+"exceeded duration"(B).
  - STOP 없는 정상 run → 정상 `completed`, 오발동 0(불변식 1).

---

## 7. C (mid-run stall, advisory) — 설계 의도, **G1b 후속** (이 spec은 비전만 기록)

> **G1a 미구현.** 상세(임계값 도출·migration·Zod·UI·중지 동선)은 G1b 자체 spec/plan에서 확정.

- **신호**: first_load 취소 후(메트릭이 흐르기 시작) 마지막 메트릭으로부터 `stall_threshold`간 새 메트릭 0이고 run이 still running.
- **동작(advisory)**: run status 변경 **안 함**. 대신 run에 "정지 의심" 신호 기록(예 `runs.stall_suspected_at` + 침묵초) → run 상세/목록에 **"⚠ N초간 진행 없음 — 워커가 멈췄을 수 있음 [중지]"** 배지 + 기존 abort 동선. 운영자 결정.
- **임계값(느슨해도 됨 — advisory라)**: 넉넉한 기본값(예 `max(120s, run think 최대 간격 도출)`) + 추후 /settings 가변. 오탐=잘못된 배지(무해), 운영자 무시 시 B가 결국 닫음.
- **터치 면**: 진행추적(워커별 마지막-메트릭 시각) + `runs` 컬럼(migration) + `RunSchema`/Zod + RunDetailPage/RunsList 배지 + 중지 동선. → UI·migration 붙는 별개 슬라이스.

---

## 8. 연기 / 후속

- **C / G1b**: §7 (advisory 정지 의심 + 수동 중지 + UI).
- **/settings 런타임 가변 (B2)**: A/B/C 임계값을 재배포 없이 `/settings`로 — L6 ops-hardening(`pool_heartbeat_*`) 선례. G1a는 CLI flag만(백엔드-only). **백로그 명시**(사용자 요청).
- **G2**: k8s register-前 사망 reaper(현재 60s watchdog 폴백) — 별개 갭, 본 spec 무관.
- **per-step `timeout_seconds` > run-level 인 극단의 A grace**: scenario_yaml walk로 max step timeout 도출 — 좁은 엣지, CLI flag escape hatch로 충분(§3.4).
- **메시지 i18n / 엔진 에러 redaction**: G3 §A10 후속과 동일 정책.

---

## 9. 파일 터치 (G1a 예상)

- `crates/proto/`: `run_duration_secs` `pub fn` 추가(필드 0).
- `crates/worker/src/lib.rs`: private `run_duration_secs` → proto 공유본 호출(동작 byte-identical).
- `crates/controller/src/grpc/coordinator.rs`: `RunWorkers`에 `first_load`/`done` 토큰(`Duration` grace 2필드도), `registration_watchdog`→`run_watchdog` 3-phase 재작성 + spawn 사이트(708–710), `fail_run_hung` 추출(+`fail_incomplete_registration` 정리), `ingest_metrics` first_load cancel, **finalize 사이트 done cancel**(record_phase terminal arms 870/879/885, worker_disconnected 966, cancel_dispatch_failed 1037 — **`cancel_dispatch_failed`는 reg_deadline cancel[1038]을 `done` cancel로 교체**, §3.1), `enqueue` arity(grace `Duration` 2개 추가), 단위테스트(실타이머).
- `crates/controller/src/api/runs.rs`: `spawn_run`이 `assignment.profile`에서 `startup_grace_eff`/`backstop_total`(`Duration`)을 **`assignment`가 enqueue로 move 되기 전**(~runs.rs:642)에 계산 → **3개 enqueue 사이트(714/772/791) 전부**에 전달, `leading_idle_secs`/`startup_grace_eff` 순수 헬퍼.
- `crates/controller/src/main.rs`: CLI 2 flag + `set_watchdog_grace(...)` **OnceLock 1회 설정**(§3.7 — AppState 필드/settings 레지스트리 **불사용**). watchdog_grace OnceLock 모듈/accessor(coordinator 또는 작은 util).
- migration / proto-field / UI / settings-레지스트리 / engine / AppState: **0**.
