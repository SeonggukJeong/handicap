# ADR-0027 — 멀티 워커 fan-out: 계획된 분산 실행 (컨트롤러 권위 + per-run 상태머신)

* Status: Accepted (A3a 머지; A3b/A3c 후속)
* Date: 2026-06-02
* Deciders: handicap maintainers
* Tags: scale-out, coordinator, worker, proto, engine, fan-out

## Context

§4.3 성능 목표(5,000 RPS)는 단일 워커로 이미 ~20,000 RPS(Slice 6 baseline) 달성이라, "다중 워커
자동 스케일링"(spec §4.5)은 처리량보다 **분산 실행/조정** 문제다. 한 run 의 VU 를 N 개 워커에 나눠
돌리되, `${vu_id}`·데이터바인딩 결과가 단일 워커와 동일해야 하고, 워커 하나가 죽으면 run 이
조용히 부분 부하만 생성하는 일이 없어야 한다.

설계 명세: `docs/superpowers/specs/2026-06-01-multi-worker-fanout-design.md`(roadmap 영역 A3).
A3a 구현 계획: `docs/superpowers/plans/2026-06-02-multi-worker-fanout-a3a.md`.

## Decision Drivers

- 부하 생성기는 "정해진 VU 를 안정적으로 생성"이 목적 — run 중 동적 스케일은 측정 노이즈.
- `${vu_id}`/데이터바인딩이 워커 수와 무관하게 단일 워커와 동일 결과(결정론).
- 샤드 누락(워커 크래시) = 요청 부하 미생성 = **명시적 실패**가 안전(조용한 부분 부하 금지).
- 기존 단일 워커 경로 회귀 0(capacity 기본값으로 N=1 → byte-identical).

## Considered Options

1. **반응형 HPA(autoscaling)** — run 중 부하/CPU 에 따라 워커를 동적으로 합류/이탈. 부하 생성기엔
   안티패턴(VU 수가 흔들려 측정이 불안정), 메트릭 머지가 워커 수 가변이라 복잡. **거절.**
2. **계획된 fan-out(채택)** — run 시작 시 `N = ceil(총VU / worker_capacity)` 를 **고정**하고,
   컨트롤러가 각 워커에 disjoint VU 샤드를 배정. 워커 mid-run 합류/이탈 없음.

## Decision

**계획된 fan-out. 컨트롤러가 권위자.** (A3a 가 조정 인프라; 메트릭 머지=A3b, K8s Indexed Job=A3c.)

### 컨트롤러 권위 / N 산정 (§2.1)

- N 은 **컨트롤러**가 `--worker-capacity-vus`(기본 2000)로 유도: `N = ceil(총VU / capacity)`,
  최소 1. 워커가 자기 capacity 를 보고하는 모델(register `capacity_vus`)이 **아니다** —
  capacity 는 컨트롤러 정책. (순수 산술은 `grpc/shard.rs::worker_count`/`shard_split`.)
- VU 구간은 contiguous·disjoint·합=총VU 로 분할; 앞쪽 `총VU % N` 샤드가 VU 1개씩 더 받는다.

### proto: `RunAssignment` shard 4 필드 (§4)

- `shard_index(6)`/`shard_count(7)`/`vu_offset(8)`/`vu_count(9)` (모두 uint32). 단일 워커 run 은
  `shard_count=1, vu_offset=0, vu_count=총VU` → 워커가 보던 값과 동일.

### 엔진: 글로벌 vu_id (§3)

- `RunPlan.vu_offset` 추가. VU 번호 = `vu_offset + local_spawn_index`(`spawned` 로컬 카운터는
  종료조건·ramp 슬라이스 크기 계산에 그대로 유지, **vu_id 만 글로벌**). `vu_offset=0` = 레거시.
- vu_id 는 **identity-only**(`${vu_id}` 렌더 + 데이터셋 `select_index` 의 `% len` modulo + seed
  `mix`) — vus-크기 구조의 인덱스로 쓰는 곳이 없어 글로벌화가 out-of-bounds 를 안 낸다.

### 컨트롤러: per-run 멀티워커 상태머신 (§2.3)

- 기존 `pending`(단일 assignment) + `active`(단일 tx) 맵을 **per-run `RunWorkers`** 맵으로 재작성.
  각 run 은 `expected`/`total_vus`/`next_shard`/`workers: HashMap<worker_id, WorkerEntry>`/
  `reg_deadline` 토큰/`terminal` 플래그를 든다.
- `register` 가 등록 순서대로 shard 를 배정(`RegisterOutcome::Assigned`), 동일 워커 재등록은
  shard 소비 없이 `Resend`(멱등), 초과 등록·terminal run 은 `Reject`. 전원 등록 시 watchdog
  토큰 cancel.
- **등록 watchdog**: `enqueue` 가 per-run watchdog 태스크를 띄워 `REGISTRATION_DEADLINE`(60s,
  worker-core `reconnect::TOTAL_CAP` 와 정렬) 안에 전원 등록 안 되면 run 을 Failed + 등록한
  워커에 AbortRun.

### fail-fast 종료 집계 (§8)

- 전원 Completed(AND `workers.len()==expected`) → run Completed.
- 어느 워커든 Failed/조기 단절(terminal phase 보고 전 stream close) → run Failed + **형제 워커에
  AbortRun fan-out**. 사용자 abort 는 전 워커에 fan-out.
- **완료 집계 불변(코드리뷰에서 발견·수정한 함정)**: 워커는 terminal phase 를 보고한 직후
  stream 을 닫으므로, `worker_disconnected` 가 terminal 워커의 entry 를 **map 에서 지우면**
  `workers.len()==expected` 게이트가 N≥2 에서 영영 충족되지 않아 run 이 `running` 에 멈춘다.
  → terminal phase 워커의 entry 는 **보존**하고, 비-terminal(크래시) 단절일 때만 제거 + fail-fast.

### A3a 한정 스코프 결정 (리뷰어 주목 — "누락"이 아니라 "결정")

- **`dispatcher.cleanup()` 호출은 A3c 로 연기**: 현재 코드는 완료/abort 어느 경로에서도 cleanup 을
  부르지 않고(코디네이터가 dispatcher 핸들을 안 듦), subprocess 는 self-terminate, K8s Job 은
  `ttlSecondsAfterFinished` + ownerRef GC 로 정리된다. fail-fast 의 기능적 핵심(형제 AbortRun)은
  A3a 가 구현; 외부 Job 정리 배선만 A3c(K8s Indexed Job 재작성과 함께).
- **K8s 디스패처는 A3a 에서 단일 Job 유지**(`worker_count>1` 이면 warn). Indexed Job
  (`parallelism=N`)은 A3c. `build_job_spec` 무변경 → 단위 테스트 무변경.
- **메트릭 머지는 A3b**: A3a 의 `run_metrics`/loop/if 집계는 step_id/loop_index/branch 로 누적
  (count 가산은 N 워커여도 합이 맞음). 워커별 HDR 머지(레이턴시 퍼센타일 정확도)는 A3b
  (`run_metrics` PK 에 worker_id, migration 0008). **A3a 단독은 같은 (step_id,ts_second) 행을
  마지막 워커가 keep-first 로 덮어 레이턴시가 부정확** — A3a+A3b 한 세트로 출하해야 정확.

## Consequences

**Positive**
- N=1 경로는 pre-A3a 와 byte-identical(capacity 기본 2000 → 모든 기존 테스트 N=1 → 회귀 0).
- 워커 크래시/미등록이 run 을 조용히 부분 부하로 두지 않고 명시적 Failed + 형제 정리.
- 글로벌 vu_id 로 데이터바인딩/`${vu_id}` 가 워커 수 불변.

**Negative / Trade-offs**
- A3a 단독은 멀티워커 레이턴시 메트릭이 부정확(A3b 전까지 keep-first) — counts 는 정확.
- per-run `RunWorkers` 엔트리는 run GC 경로가 없어 run 수만큼 누적(엔트리는 `expected` 로 bounded,
  pre-existing 한 run-map 수명 문제 — A3a 신규 회귀 아님).
- terminal 워커 entry 보존(완료 집계용)으로 닫힌 tx 가 map 에 남지만 `fan_out_abort` 는 닫힌
  채널을 무시(no-op)라 무해.

## Out of scope (연기)

- **A3b** 메트릭 워커별 머지(migration 0008), **A3c** K8s Indexed Job + dispatcher cleanup 배선 +
  Helm 충실도(`datasetMaxRows`/resources) values.
- **반응형 HPA**, **best-effort/degraded 모드**(워커 일부 실패해도 지속) — profile 이음새만, spec §11.
- **`unique` 바인딩(중앙 커서)** — A3 인프라 위 후속(spec §6.4 스텁). A3 본체는 unique 여전히 거부.

## Links

- ADR-0010 (Controller↔Worker gRPC bidi, pull/등록 모델) — register 흐름의 출처
- ADR-0012 (워커 메트릭 사전집계, HDR) — A3b 머지의 대상
- ADR-0016 (VU = tokio task per VU) — 글로벌 vu_id 가 번호만 바꾸고 실행 모델 불변
- ADR-0019 (Worker dispatcher 추상화 subprocess/K8s) — `dispatch(run_id, worker_count)` 시그니처
- Spec `docs/superpowers/specs/2026-06-01-multi-worker-fanout-design.md`
- Plan `docs/superpowers/plans/2026-06-02-multi-worker-fanout-a3a.md`
