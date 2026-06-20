# 0041. LAN 분산 워커 L1 — 상시 워커 풀 + push 배정 + 공유 토큰 인증

- 상태: 채택 (2026-06-20)
- 관련: [ADR-0039](0039-windows-desktop-distribution.md)(LAN feasibility — 프로토콜상 이미 가능·격차=바인딩/오케스트레이션/mTLS), [ADR-0010](0010-controller-worker-grpc.md)(gRPC bidi·워커 pull/등록), [ADR-0027](0027-multi-worker-fanout.md)(멀티워커 fan-out·shard 배정·메트릭 머지), [ADR-0040](0040-tauri-desktop-wrapper.md)(데스크톱 셸·`ControllerBackend` 추상). 런북 `docs/dev/lan-workers.md`. spec/plan `docs/superpowers/{specs,plans}/2026-06-20-lan-distributed-workers-l1*`.

## 맥락

ADR-0039는 사내 QA가 여러 사무실 PC를 모아 한 부하 테스트에 동원하는 **LAN 분산 실행**이 프로토콜상 이미 가능하다고 봤다(ADR-0010의 워커 pull/등록 모델·ADR-0027의 fan-out shard 배정/메트릭 머지가 그대로 재사용 가능). 격차는 *코드*가 아니라 *운영 형상*이었다: ① 워커는 지금 컨트롤러가 run마다 spawn하는 per-run 프로세스라 "미리 띄워 둔 상시 워커"가 없다 ② 채널에 인증이 없어 LAN 바인드 시 아무 호스트나 붙는다 ③ 컨트롤러/워커가 localhost에만 바인드.

L1(Level 1)은 백엔드 제어판만 만든다(UI·자동 발견·mTLS·과부하 가드는 후속 L2). 목표: **워커를 각 PC에 미리 띄워 두면, 컨트롤러가 run 발사 시 연결된 유휴 워커들을 모아 부하를 분산**한다.

## 결정

기존 per-run dispatcher-spawn(pull) 모델 **옆에** 세 번째 워커 모드 `pool`을 더한다(기존 subprocess/kubernetes 무변경).

1. **상시 워커 풀(R1/R5):** 워커를 `--run-id` 없이 띄우면 풀 모드 — 빈 `run_id`로 register하여 컨트롤러의 인메모리 `CoordinatorState.pool`(`worker_id → PoolEntry{tx, capacity_vus, assigned_run}`)에 유휴로 들어가 첫 배정을 기다린다. run 종료 후 재연결해 다시 유휴(**reconnect-per-run**). worker_id는 명시 `--worker-id`가 없으면 프로세스 1회 랜덤 ULID(R12).

2. **use-all push 배정(R4/R6):** `--worker-mode pool` 컨트롤러는 run 발사 시 `spawn_run`이 유휴 워커를 **부하 상한**까지 예약(`reserve_idle_pool` — 풀 락 안에서 원자적 필터+마킹)→`enqueue`→`assign_pool_workers`가 **기존 fan-out 머신**(`register`/`assignment_for`/`stream_dataset`)으로 샤드를 push한다. N = min(유휴 워커 수, 부하 상한). 부하 상한 = closed-loop `vus` / open-loop `min(max_in_flight, target_rps|곡선 peak)` / vu-curve 1. **per-worker capacity는 L1에서 무시**(과부하 가드는 L2).

3. **공유 토큰 인증(R2/R3):** proto `Register.token`(field 4, additive) + 컨트롤러 `check_token`. `--worker-token` 설정 시 불일치는 `AbortRun("authentication failed")`+stream break로 거부(풀 등록 전). 미설정이면 모든 토큰 수용 = 인증 없음(opt-in). 평문 채널이라 plain `==`(timing-safe 불필요 — 기밀성은 mTLS 후속).

4. **LAN 바인드(R11):** `--rest`/`--grpc` 기본 `127.0.0.1`을 `0.0.0.0`(또는 특정 인터페이스)으로 오버라이드. 워커는 `--controller http://<ip>:<grpc>`로 dial. 운영 런북에 바인드·방화벽·use-all·과부하 미가드·토큰 보안 한계를 문서화.

5. **조건부 byte-identical(R10):** `--worker-mode subprocess`(기본) AND `--worker-token` 미설정이면 슬라이스 전과 동일. proto는 additive(token 기본 빈), pool 분기는 `spawn_run`에서 기존 enqueue/dispatch *앞*에 early-return, 토큰 미설정 시 `check_token`은 pass-through. **migration 0 / 엔진 무변경**(풀은 순수 인메모리).

## 근거

- **"이미 가진 걸 재사용"**: 샤드 분할·글로벌 vu_id·워커별 메트릭 머지·등록 watchdog·fail-fast(dead-tx/disconnect)·terminal-phase 보존이 ADR-0027 fan-out에 이미 있다. push 배정은 그 함수들을 호출만 하면 됨 — 새 실행/머지 코드 0, N=1 회귀 위험 최소.
- **push(컨트롤러 권위) vs 워커 self-claim**: 풀 워커가 run을 스스로 집는 모델은 경합·중복 배정·공정성 문제를 낳는다. 컨트롤러가 예약 락(`assigned_run=Some`)으로 한 워커를 한 run에 원자 배정하는 게 fan-out의 권위-N 모델과 일관되고 단순하다.
- **reconnect-per-run**: run 사이 워커가 끊고 재등록하는 단순 루프가 "한 스트림에 다수 run 멀티플렉싱"보다 상태가 단순하다(run 격리·정리가 기존 disconnect 경로 그대로). 대가는 run 사이 sub-second 갭(L1 허용).
- **토큰=접근 통제, 기밀성 아님**: L1 채널은 평문. 토큰은 "아무 LAN 호스트나 풀에 붙어 시나리오 env(시크릿 가능)·데이터셋을 받는 것"을 막는 접근 통제다. 와이어 도청 방어(mTLS)는 명시적 후속. plain `==`로 충분(timing 공격은 평문 채널에서 무의미).
- **capacity 무시(L1)**: closed-loop은 `vus`를 유휴 워커 수로 나눠 배정하므로 워커당 부하가 그 PC 능력을 넘을 수 있다. 용량 인지 배정은 복잡도가 커 L2로 미룸 — 런북에 ⚠ 경고로 명시(silent 아님).

## 대안 (기각)

- **워커 self-claim(pull run from a queue)**: 경합/공정성/중복 배정 복잡. 컨트롤러-권위 push가 fan-out과 일관.
- **per-run spawn 유지 + LAN dispatcher**: 각 run마다 원격 PC에 워커를 spawn하려면 원격 실행 채널(SSH/agent)이 필요 — 상시 풀이 훨씬 단순(워커가 자기 PC에서 미리 떠 있음).
- **L1에 mTLS**: 인증서 배포·로테이션 운영 부담이 "가볍게 쓰는 QA" 대상과 안 맞음. 접근 통제(토큰)부터, 기밀성(mTLS)은 수요 확인 후.
- **capacity-aware 배정을 L1에 포함**: 워커 capacity 보고·가중 분할·재조정이 L1 범위를 키움. use-all(균등 분할)부터.

## 귀결

- 워커 모드 3종(subprocess/kubernetes/pool). pool은 단일 컨트롤러 권위·인메모리 풀·reconnect-per-run.
- 후속(L2 후보): ~~풀 상태 UI~~ **✅ L2 완료 (2026-06-20)** — 읽기전용 `/workers` 대시보드 + RunDialog 풀 프리뷰 + proto `Register.hostname` additive(워커 식별) + `GET /api/pool/workers`(인메모리 `pool_snapshot`); migration 0/엔진 0, 조건부 byte-identical, spec/plan `2026-06-20-lan-distributed-workers-l2*`.
- 후속(L3 후보): ~~과부하(capacity) 가드~~ **✅ L3 완료 (2026-06-20)** — capacity-aware closed-loop 풀 배정. 워커 `--capacity-vus` 선언을 존중하는 순수 water-fill `capacity_split`(균등 출발→over-cap 회수→여유 워커 재분배; 무바인딩 시 `shard_split` 균등과 byte-identical) + `register` precomputed-or-fallback. 용량 부족(`idle>0 && vus>Σcap`)은 `spawn_run` **insert 전** 사전검사가 `409 {achievable_vus, requested_vus}`로 거름(run row 0=R3); `?force=true`(ephemeral 쿼리)는 가드 스킵→L1 균등 과부하. RunDialog 총 용량 프리뷰+초과 힌트+409 확인 다이얼로그(줄여 진행=`vus`를 가용으로 / 강행=`?force`). **closed-loop만** 가드(open-loop/VU곡선 미적용=후속). proto/worker/engine/migration 0, spec/plan `2026-06-20-lan-distributed-workers-l3-capacity-guard*`. 잔여 후속: open-loop/곡선 capacity 가드·capacity-비례 dataset 슬라이싱·워커 자동 발견·mTLS·풀 워커 헬스/하트비트(half-open 유령 워커)·다중 동시 run 멀티플렉싱·제어 액션(disconnect/exclude).
- 검증: 단위(check_token·reserve cap·shard 배정·fail-fast·terminal 보존·reconnect 재사용)·e2e(`pool_e2e.rs` 연속 2 run 재사용 + 토큰 거부)·라이브 5/5(use-all·토큰 거부·빈풀 400·재사용·report 머지). 보안: `security-reviewer` APPROVE-WITH-FIXES — 시작 로그 `info!(?args)`가 토큰 PSK를 평문 노출하던 것을 명시 필드+`*_set` bool로 교체(S1/S2 fix).
