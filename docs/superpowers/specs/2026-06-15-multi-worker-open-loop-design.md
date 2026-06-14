# 멀티워커 open-loop (계획된 레이트 fan-out) — 설계

> **상태**: 설계(brainstorming 승인 2026-06-15).
> **출처**: A9/D 후속 brainstorming 중 방향 전환 — 처음엔 "open-loop `vus` misconfig 가드"로 출발했으나, `spawn_run`이 open-loop을 N=1로 하드 고정(`api/runs.rs` `n = if is_vu_curve() || is_open_loop() { 1 }`)함을 확인하면서 "N× 부하 트랩"이 실재하지 않음이 드러났다(spec-plan-reviewer 검증). 진짜 격차는 **open-loop이 수평 확장되지 않는다**는 것 — 단일 워커가 목표 RPS를 못 내면 정확한 도착률 제어를 포기하고 closed-loop으로 가야만 했다. 사용자 결정(2026-06-15): 멀티워커 open-loop을 제대로 구현.
> **ADR**: **신규 필요** — ADR-0031의 "open-loop = 단일워커 v1" 결정을 **계획된 멀티워커 fan-out으로 확장**(supersede가 아니라 v2 확장; 반응형 HPA는 여전히 비목표). 자세한 결정 = §7.
> **관련**: ADR-0027(멀티워커 fan-out — 계획된 N, shard 배정, 워커별 메트릭 머지), ADR-0031(open-loop·`dropped`·단일워커 v1), ADR-0018(VU별 jar = 슬롯), ADR-0001(LoadRunner/JMeter 대체). `docs/dev/capacity-planning.md` §4(단일워커 — 단, §4 현재 서술은 현 코드를 잘못 기술[N× 트랩은 N=1 핀으로 불가], 이 슬라이스가 멀티워커로 실현하며 §4 **정정**: §9-7).

---

## 1. 배경·문제

open-loop(`target_rps`/`stages`, ADR-0031)은 부하 강도가 **도착률**로 정해져 정확한 RPS 제어를 준다 — LoadRunner/JMeter의 arrival-rate 모델. 그러나 **단일 워커로만 실행된다**(`spawn_run`이 `is_open_loop() ⇒ n=1`로 고정, `api/runs.rs`). 단일 워커가 목표 RPS를 못 내면(`dropped > 0`), 현재 유일한 우회는 **closed-loop으로 전환**인데 — closed-loop은 VU를 워커들에 분배해 수평 확장되지만 RPS가 latency에 따라 떠다녀 **정확한 도착률을 포기**한다(`docs/dev/capacity-planning.md` §2). 즉 "정확한 레이트"와 "수평 확장"을 동시에 못 가졌다.

closed-loop은 이미 `worker_count = ceil(vus/capacity)`로 N개 워커에 fan-out하고(ADR-0027), 워커별 메트릭은 `run_metrics`의 worker_id PK + 읽기-머지로 합쳐진다(A3b). **이 인프라가 그대로 깔려 있는데 open-loop만 N=1로 잠겨 있다.** 이 슬라이스는 그 잠금을 풀어 open-loop도 `target_rps`(와 `stages`)를 N개 워커에 쪼개 합이 목표가 되게 한다 — 정확한 레이트 제어를 유지한 채 수평 확장.

### 왜 "계획된 fan-out"인가 (반응형 아님)
ADR-0027이 closed-loop에 대해 정한 것과 동일: run 시작 시 N을 고정, mid-run 합류/이탈 없음. 부하 생성기는 "정해진 부하를 안정적으로 생성"이 목적이라 run 중 워커 수가 흔들리면 측정이 흔들린다. open-loop도 같은 철학 — N은 시작 시 고정.

---

## 2. 목표 / 비목표

### 목표
- open-loop run을 N개 워커에 fan-out — `target_rps`·`stages[].target`·`max_in_flight`를 워커별로 **정확히 분할**(합 = 총량, 드리프트 0), 각 워커가 자기 몫을 독립 생성.
- N을 정하는 **명시적 `worker_count` 노브**(profile, 기본 1 = opt-in). 사용자가 워커당 천장을 램프-테스트로 재고 직접 지정(계획된 fan-out 철학).
- **초보자 안전**: 기본 1(오늘과 동일·숨김) + UI 접이식 고급 필드 + 사후 포화 인사이트가 "워커를 ~M개로" 직접 안내.
- 기존 N=1 open-loop·closed-loop·vu-curve run **byte-identical**.

### 비목표 (연기 — §8)
- **create-time worker_count 사이징 헬퍼**(prior-run 천장 → 권장 N을 폼에서 미리; A9 사이징 헬퍼 4종 패턴). v1은 사후 인사이트 안내로 갈음.
- **반응형 스케일링**(run 중 CPU/메트릭 기반 워커 증감) — ADR-0027 비목표 유지.
- **best-effort/degraded**(워커 일부 실패 시 잔여로 지속) — A3는 fail-fast(샤드 누락=명시적 실패). §B2'' 연기 항목 유지.
- **per-stage 워커 분해 리포트**(어느 stage에서 어느 워커가 꺾였나).
- **closed-loop에 worker_count 오버라이드**(closed-loop은 vus/capacity로 N 유도 — v1은 open-loop 전용 노브).

---

## 3. 설계

### 3.1 핵심 메커니즘 — 컨트롤러가 워커별 프로필을 미리 분할

현재 코디네이터 `assignment_for`(`grpc/coordinator.rs`)는 register한 각 워커에게 **base 프로필을 그대로 clone**해 보낸다(profile은 모든 워커 동일, shard 필드만 워커별). open-loop N>1일 때 **여기서 워커별로 프로필을 축소**한다 — `target_rps`/`max_in_flight`/`stages[].target`을 워커 몫으로 줄인 clone을 보낸다.

결과: **워커·엔진·proto는 받은 프로필을 그대로 실행하므로 무변경.** 워커는 자기가 받은 `target_rps`(=총량/N)로 발사하고, N개 합 = 총 `target_rps`. 분할은 전적으로 컨트롤러의 단일 지점(assignment_for) 책임.

분할 가드 = `is_open_loop(profile) && shard_count > 1`. N=1이면 블록 스킵 → clone 그대로 → **byte-identical**.

### 3.2 N 결정 — 명시적 `worker_count` 노브

- 컨트롤러 `Profile`(`store/runs.rs`)에 `worker_count: Option<u32>` 추가. **`#[serde(default, skip_serializing_if = "Option::is_none")]`** → profile_json 직렬화라 **migration 0**, 기존 행은 None(=1)으로 역직렬화. **proto에는 추가하지 않는다** — 컨트롤러가 중앙에서 분할하므로 워커는 worker_count를 알 필요 없고 `shard_count`(기존 proto 필드) + 축소 프로필만 받는다.
- `spawn_run`(`api/runs.rs`)의 워커 수 계산. **현재 코드는 `let n = if profile.is_vu_curve() || profile.is_open_loop() { 1 } else { worker_count_for(profile.vus) }` 결합 arm(`runs.rs:515`)** — 이를 vu-curve와 open-loop으로 **분리**한다(vu-curve 먼저 = N=1 유지):
  ```rust
  let n = if profile.is_vu_curve() {
      1
  } else if profile.is_open_loop() {
      profile.worker_count.unwrap_or(1)        // ← N=1 하드코드 해제
  } else {
      state.coord.worker_count_for(profile.vus) // closed-loop 무변경
  };
  ```
- `enqueue`에 넘기는 `total_vus`(register의 `shard_split` 기준). **현재 코드는 `is_vu_curve`만 특수처리(`runs.rs:522`)하고 else가 `profile.vus`(open-loop=0)** — open-loop arm 추가:
  ```rust
  let total_vus = if profile.is_vu_curve() {
      profile.vu_curve_max()
  } else if profile.is_open_loop() {
      profile.max_in_flight.unwrap_or(1)       // ← 슬롯 풀을 분할 기준으로. 반드시 unwrap_or(1)(0 금지)
  } else {                                     //    — shard_split(0,…)이 vu_count=0을 만들어 §3.3 약속
      profile.vus                              //    위반(vu_curve_max 주석과 동일 가드). validate가 open-loop
  };                                           //    max_in_flight=Some 보장하므로 unwrap_or는 방어적.
  ```
- **unique-binding 워커 수 사이트도 동일하게**(`runs.rs:374`의 결합 `is_vu_curve() || is_open_loop() ⇒ 1`을 같은 형태로 분리) — 두 사이트가 같은 N을 봐야 dataset row 분할(`row_count >= n` 게이트)이 정합.

### 3.3 슬롯/동시성 + 전역 vu_id 분할 — `shard_split(max_in_flight)` 재사용

open-loop에서 **`max_in_flight` 슬롯 풀 = 동시 VU 수**(각 슬롯이 vu_id를 가진 재사용 jar·VuClient, ADR-0018). 그래서 슬롯 분할 = VU 분할이고, 기존 `shard_split`(closed-loop VU 분할 기계)을 그대로 쓴다:

- `spawn_run`이 `total_vus = max_in_flight`로 enqueue → register의 `shard_split(max_in_flight, n, i)` → 워커 i에 `(vu_offset_i, slot_i)`.
- `assignment_for`에서 워커별 프로필 `max_in_flight = slot_i`(= shard_split의 vu_count), 전역 `vu_offset = vu_offset_i` → **워커별 슬롯이 겹치지 않는 vu_id 범위**를 가져 `${vu_id}` 전역 유일.
- `shard_split`이 나머지를 앞 워커에 분배 → Σ slot_i = max_in_flight 정확.

### 3.4 레이트 분할 — `shard_split(target_rps)` / `shard_split(stage.target)`

`shard_split(total, n, i)`은 범용 "정수를 n개 disjoint 정수로 쪼개기(나머지 앞 분배)"라 레이트에도 그대로:

- 고정모드: 워커별 `target_rps = shard_split(target_rps_total, shard_count, shard_index).1` (반환은 `(offset, count)` 튜플). Σ = 총 target_rps 정확.
- 곡선모드: 각 stage의 `target = shard_split(stage.target_total, shard_count, shard_index).1` (반환은 `(offset, count)` 튜플), `duration_seconds` 불변. 워커별 곡선이 생기고, `rate_at`이 **선형 보간**이라 Σ(워커별 rate_at) = 총 rate_at(엔드포인트 합이 정확 + 선형성) → 램프 전 구간에서 합 = 총 곡선.
- **곡선 0-share 워커**: `worker_count > stage.target_total`이면 일부 워커가 그 stage에 0-share를 받아 등록은 하되 그 구간 부하 0(`rate_at`→0→100ms poll). **정합**(Σ 정확·고정모드 §3.5 #4 면제 근거와 동일)하지만 그 워커는 그 구간 유휴 — per-stage 워커 floor는 비목표(§8 연기, 드문 코너).
- **새 산술 함수 0** — `shard_split` 단일 splitter.

### 3.5 검증 (`validate_run_config`)

`worker_count`/`vus` 정합 검증 5종 (위반 = 400). **배치**: `validate_run_config`는 `if is_vu_curve … else if is_open_loop … else …` 상호배타 체인(`runs.rs:189/241/319`)이라 — #1·#2(worker_count는 vu-curve·closed-loop에도 걸려야 함)는 체인 **앞**에, #3·#4·#5(open-loop 전용)는 open-loop arm **안**(#5는 `// vus ignored in open-loop` 주석 `runs.rs:318` 자리)에 둔다.

1. **worker_count는 open-loop 전용**: `worker_count = Some(w) && w > 1`인데 `!is_open_loop()`(closed-loop/vu-curve) → 400("worker_count는 open-loop 전용 — closed-loop은 vus로 워커 수가 정해집니다"). `worker_count = Some(1)`/None은 무해(no-op) 허용.
2. **worker_count 범위**: `worker_count = Some(w)`면 `1 <= w <= 64`(상한 = 폭주 방지 하드캡; §8에서 설정 페이지 노출 예정) — 위반 400.
3. **슬롯 충분(open-loop, w>1)**: `max_in_flight >= w`(워커당 ≥1 슬롯; 0-슬롯 워커는 자기 도착을 전부 drop) → 위반 400. (unique-binding `row_count >= n` 선례와 동형.)
4. **레이트 충분(open-loop 고정모드, w>1)**: `target_rps >= w`(워커당 ≥1 rps — 엔진 `target_rps.unwrap_or(1).max(1)`의 `.max(1)`이 0-share를 1로 왜곡해 Σ를 부풀리는 것 차단) → 위반 400. **곡선모드 면제**(0-share stage는 `rate_at`→0→100ms poll이라 무해, Σ 정확).
5. **(신규·fold-in) open-loop에 vus 금지 — 리다이렉트**: `is_open_loop() && profile.vus > 0` → 400("open-loop에선 vus가 무시됩니다 — 수평 확장은 worker_count, VU 기반 부하는 closed-loop을 쓰세요"). open-loop에서 `vus`는 **실행·fan-out 양쪽 다 무시**(N은 `worker_count`, total_vus는 `max_in_flight` 기준)되므로 비정합 신호. **UI는 open 모드에서 vus=0을 보내(`ui/src/components/loadModel.ts` open arm 2곳 = open+fixed·open+curve; closed+curve도 vus=0이나 그건 open-loop 아님)므로 UI-생성 run/preset/schedule은 무영향** — 손-API/curl config만 거절(백워드-호환 위험 최소). 원래 "vus misconfig 가드" 아이디어가 worker_count 도입으로 **N× 트랩 방지가 아니라 *리다이렉트* 형태로 실현**된 것(N× 트랩은 fan-out이 worker_count 기반이라 구조적으로 불가 — 이 슬라이스의 출발점이었던 오해를 정직하게 마감).

### 3.6 N=1 byte-identical 불변식
`worker_count` 생략/1 → `n=1` → register `shard_count=1` → §3.1 분할 블록 스킵 → 워커가 받는 프로필 = 오늘과 동일. open-loop·closed-loop·vu-curve 기존 run 전부 와이어·동작 무변경.

### 3.7 재사용 인프라 (변경 0 — reviewer 확인 포인트)
- **N-워커 dispatch**: subprocess N-spawn(A3a) / K8s Indexed Job parallelism=N(A3c) — closed-loop이 쓰는 경로 그대로.
- **워커별 메트릭 머지**: `run_metrics` worker_id PK + summary/windows/build_report 읽기-머지(A3b) — open-loop 메트릭도 자동 합산.
- **`dropped` 합산**: 각 워커 final flush의 `dropped`를 `ingest_metrics`가 `UPDATE runs SET dropped = dropped + ?`로 합산 — N개 워커 drop 합 = run-total. 무변경.
- **등록 watchdog**(60s 전원 등록 or run fail), **fail-fast**(샤드 누락=실패), **dispatcher cleanup** — 전부 N 무관하게 동작.
- **unique 데이터 바인딩**: `shard_split`로 워커별 disjoint row 슬라이스 — open-loop에도 그대로 적용(`row_count >= n` 게이트 재사용).

---

## 4. 초보자 안전 (논의 결정)

### 4.1 UI — 점진 노출
- RunDialog open 모드(고정·곡선 둘 다)에 **접이식 고급 섹션**으로 `worker_count` 입력(기본 1, 접힘). 영역 U `ui-optional-sections-collapsible` 이디엄(기본 접힘·값>1이면 "N개" 힌트·seed 시 펼침). closed/vu-curve 모드엔 미렌더.
- 신규 문구는 `ko.ts` 카탈로그(ADR-0035). 라벨 예: "부하 생성기 워커 수 (수평 확장)" + HelpTip("한 워커가 목표 RPS를 못 내면 늘리세요. 리포트가 권장값을 알려줍니다").
- 클라 Zod `worker_count: z.number().int().min(1).max(64).optional()`(default 누출 금지 — `.optional()`만), `buildLoadProfile` open arm에서만 emit(closed/curve는 미전송 → byte-identical).

### 4.2 사후 포화 인사이트 — 워커 추천 한 줄
기존 `load_gen_saturated`(insights.rs, A9)는 `dropped>0`일 때 관측 천장 `peak_observed`(peak per-second RPS)·cause(`slots`/`capacity`)를 계산한다. cause=`capacity`(슬롯은 충분했는데 포화 = 워커 CPU 또는 SUT 한계) 분기에 워커 추천을 가산:
- **공식(reviewer 지적 반영)**: `peak_observed`는 **N개 워커 합산**(A3b 읽기-머지)이라 `ceil(target_total / peak_observed)`를 그대로 쓰면 이미 N>1인 run에서 ≈N(현 N과 같은 값)이 나와 무용하다. **워커당 천장으로 정규화**해야 한다: `per_worker_peak = peak_observed / worker_count_current`(=stored profile의 `worker_count`, 기본 1), `M = ceil(target_rps_total / per_worker_peak) = ceil(target_total × worker_count_current / peak_observed)`. 예: 1워커가 1000 RPS에서 포화·목표 3000 → M=3 / 2워커가 1800 합산에서 포화·목표 3000 → per_worker 900 → M=4(현 2보다 큼=실행 가능 조언). 곡선은 `target_total` = peak target.
- **div-by-zero 가드(필수)**: `peak_observed`는 `summary.rps.round()` 폴백(`insights.rs:215`)을 포함해 **0일 수 있다**(예: 다초 run에 완료 1건 + dropped>0). `peak_observed > 0` 확인 후에만 `per_worker_peak`/`M`을 계산·emit(0이면 추천 생략 — 안 그러면 `target/0 = inf`→`u64::MAX` 쓰레기 추천). 단위 테스트: `count=1·장-run·dropped>0` → `recommended_workers` 미emit.
- **`M > worker_count_current`일 때만 emit**(M ≤ 현재면 워커를 늘려도 목표 미달 = SUT-bound → 워커 추천 생략, cause=capacity 문구의 "대상 서버 한계" 분기가 안내). `derive_insights`에 `worker_count_current: u32`(stored profile, report.rs 주입) 입력 추가(기존 9-인자 → 10, `#[allow(clippy::too_many_arguments)]` 이미 적용).
- `Insight`에 **`recommended_workers: Option<f64>`** 가산(`#[serde(skip_serializing_if = "Option::is_none")]`, A9의 `recommended`/`cause` 가산과 동형) — 기존 `recommended`(=max_in_flight, slots용)와 의미 충돌 회피를 위해 **별도 필드**(reuse 금지). UI Zod `.optional()`.
- UI 문구(ko, 정직하게 양분기 병기): "현 워커가 ~N RPS에서 포화 — **부하기(워커 CPU) 한계라면 worker_count를 ~M개로** 올리세요. **대상 서버 한계라면** 워커를 늘려도 무익(에러·지연이 함께 높으면 SUT)." 자동 귀속(B②)은 하지 않고 사용자 판단 위임 유지.
- **`dropped==0`이면 미emit → byte-identical.** cause=`slots`는 기존 max_in_flight 추천 유지(워커 추천 없음 — 슬롯부터 올리는 게 먼저).

---

## 5. 변경 요약 (reviewer 체크리스트)

| 영역 | 변경 | byte-identical 근거 |
|---|---|---|
| **엔진** | 무변경 | 받은 (축소)프로필 그대로 실행 |
| **워커** | 무변경 | profile.target_rps/max_in_flight/stages 그대로 + vu_offset 그대로 |
| **proto** | 무변경 | worker_count는 컨트롤러-only, shard_count(기존)로 충분 |
| **migration** | 무변경 | worker_count = profile_json serde default |
| controller `store/runs.rs` | `worker_count: Option<u32>` 필드 | serde default |
| controller `api/runs.rs` `validate_run_config` | 검증 5종(§3.5) | open-loop+w>1만 영향 |
| controller `api/runs.rs` `spawn_run` + unique count | N=1 해제 → `worker_count`, total_vus=max_in_flight | w=1이면 동일 |
| controller `grpc/coordinator.rs` `assignment_for` | open-loop+shard_count>1 워커별 프로필 분할(§3.1) | shard_count=1 스킵 |
| controller `insights.rs` | cause=capacity에 워커 추천(§4.2) | dropped==0 미emit |
| UI RunDialog | worker_count 접이식 필드 + Zod + ko | open+w미설정=미전송 |
| **ADR** | 신규(0031 → 멀티워커 확장) | — |

---

## 6. 테스트

### 6.1 controller 단위
- `shard_split`을 레이트에 쓰는 분할: `split_sum_exact`(임의 total·n에 대해 Σ shares == total — 이미 `shard_split` 테스트가 VU로 보장하나, 레이트/슬롯 재사용을 명시 케이스로). 
- `validate_run_config` 5종(§3.5): worker_count on closed-loop(>1)→Err / 범위 0·65→Err / max_in_flight<w→Err / 고정 target_rps<w→Err / 곡선 target<w 면제→Ok / **open-loop+vus>0→Err(리다이렉트) / open-loop+vus=0→Ok** / w=1 or None open-loop→Ok / closed-loop w=None·vus>0 무영향→Ok.
- `assignment_for` 워커별 분할: N=2 open-loop에서 두 워커의 (target_rps, max_in_flight) 합 == 총량, vu_offset disjoint, N=1이면 프로필 unchanged(byte-identical 핀).

### 6.2 controller 통합
- `POST /api/runs` open-loop + `worker_count=2`(NoopDispatcher) → 201, coordinator `expected==2`. (실 dispatch는 e2e/라이브.)
- 검증 거절 1–2건(worker_count on closed-loop, max_in_flight<w) → 400.

### 6.3 e2e (controller `tests/multi_worker_fanout_e2e.rs`, subprocess 2-워커)
- open-loop `worker_count=2` + `target_rps` run이 completed에 도달 + 두 워커 메트릭 머지(같은 파일 `two_worker_fanout_completes:85` 패턴 차용 — closed-loop 선례). dropped 합산·summary.rps ≈ target 확인.

### 6.4 라이브 검증 (머지 전 필수 — 분산 실행이라 S-D 갭 위험)
`/live-verify` 스택(워크트리 자체 바이너리 + 200-responder + 격리 DB). open-loop `target_rps=4000, worker_count=2`로 run → 리포트 `summary.rps ≈ 4000`(단일 워커 천장의 ~2배), `dropped` 합산, 메트릭 머지. UI: RunDialog 접이식 worker_count 입력 → run → 리포트, 콘솔 Zod 0. 인사이트: 의도적 과부하(작은 max_in_flight)로 포화 유발 → 워커 추천 문구 노출.

---

## 7. ADR (신규)

- **결정**: open-loop을 단일워커 v1에서 **계획된 멀티워커 fan-out**으로 확장. N = 명시적 `worker_count`(profile, 기본 1). 컨트롤러가 register 시 워커별로 `target_rps`/`max_in_flight`/`stages` 분할(`shard_split` 재사용) → 엔진·워커·proto·migration 무변경. 메트릭/dropped 머지는 A3b 재사용.
- **거절안**: ② max_in_flight÷capacity 유도(CPU 병목이 동시성보다 레이트에서 먼저 오면 과소 워커), ③ target_rps÷워커당-RPS-예산(워커당 RPS 천장은 지연/페이로드 종속이라 고정 상수 불가 — capacity-planning이 명시 경고). 반응형 HPA(측정 흔들림).
- **근거**: 명시 노브 = ADR-0027 "계획된 fan-out, 사용자 사이징" 철학 + capacity-planning "단정 말고 측정" 정합. 정확한 레이트 제어 + 수평 확장 동시 달성(ADR-0001 LoadRunner 대체).
- ADR-0031을 supersede하지 않고 **확장**(반응형은 여전히 비목표). 다음 번호로 작성, 루트 CLAUDE.md "알아둘 결정들" 한 줄.

---

## 8. 연기 (roadmap에 누적)

- **create-time worker_count 사이징 헬퍼**: prior-run 천장(`load_gen_saturated` value 또는 종료 open-loop run summary) → 권장 N을 RunDialog에서 미리(A9 사이징 헬퍼 4종 패턴 — `sizing.ts` + 자족 헬퍼 컴포넌트). v1은 사후 인사이트로 갈음.
- **`worker_count` 상한(64) 설정 페이지 노출**: v1은 코드 하드캡. → **roadmap §B2'' "운영 상한 관리자 화면"**(capacityVus·loop_breakdown_cap·dataset-max-rows·trace body cap와 함께)에 추가할 값으로 기록(사용자 결정 2026-06-15).
- **per-stage 워커 분해** · **best-effort/degraded**(§B2'') · **반응형 스케일** · **곡선 멀티워커와 vu-curve 곡선 샤딩**(B9 — 별개) · **closed-loop worker_count 오버라이드**.

---

## 9. 구현 순서 (plan 입력)

루트 CLAUDE.md 게이트 제약(미사용 헬퍼-only·RED-only 단독 커밋 불가)에 맞춰 task별 green 커밋. proto/migration 무변경이라 와이어 레이어가 얕다.

1. **`worker_count` 필드 + 검증**(store/runs.rs 필드 + validate_run_config 5종 + 단위 테스트). 
2. **fan-out 배선**(spawn_run n/total_vus 해제 + unique count 사이트 + 통합 테스트 201/400).
3. **워커별 프로필 분할**(coordinator.rs assignment_for + 단위: Σ==총량·vu_offset disjoint·N=1 byte-identical 핀).
4. **e2e 2-워커 open-loop**(tests/multi_worker_fanout_e2e.rs).
5. **인사이트 워커 추천**(insights.rs cause=capacity 분기 + ko + 단위).
6. **UI**(worker_count 접이식 필드 + Zod + ko + RTL).
7. **ADR** 작성 + 루트 CLAUDE.md 인덱스 한 줄 + **capacity-planning.md §4 정정**. 현재 §4(`:101`·`:106`)는 "open-loop은 프로필을 복제해 워커가 N대면 합계 `target_rps × N`"·"큰 vus가 N>1 워커를 띄울 수 있다"고 적었으나 **이는 현재 코드를 잘못 기술한 것**(`runs.rs:515`가 open-loop을 N=1로 하드 핀해 그 트랩은 발생 불가). 단순 "해소"가 아니라 ① 옛 서술이 틀렸음을 정정하고 ② 새 동작(`worker_count`로 명시 fan-out, `target_rps`가 워커별 분할돼 합=목표; `vus`는 open-loop에서 무시)을 기술 — 독자가 "× N" 오개념을 신뢰하지 않게.
8. 게이트 green → 머지 전 **라이브 검증**(§6.4) + `handicap-reviewer` 최종.
