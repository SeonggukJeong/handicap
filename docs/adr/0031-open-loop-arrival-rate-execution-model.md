# 0031. Open-loop / Arrival-rate 실행 모델

- 상태: 채택
- 날짜: 2026-06-04

## 맥락

기존 실행 모델은 **closed-loop 하나뿐**이다(`runner.rs::run_scenario`). VU N개가 각자
`while now < deadline { execute_steps() }`로 시나리오를 자유 반복해 RPS는 결과값으로만
나온다. "초당 500요청을 꽂아라"처럼 **목표 도착률(arrival rate)을 직접 지정하는
open-loop 실행 모델**이 없어 SLA식 정밀 부하("이 서비스가 X RPS를 버티나") 측정이
불가능하다. LoadRunner/JMeter 대체(ADR-0001)의 핵심 격차.

S-C는 이 격차를 **opt-in**으로 메운다 — `target_rps` 미지정이면 closed-loop 기본,
byte-identical.

## 결정

### 1. opt-in + 격리 함수

`Profile.target_rps: Option<u32>` 존재 시 **격리된 `run_scenario_open_loop`** 를
호출한다. 기존 `run_scenario`/`run_vu`는 한 줄도 건드리지 않는다(closed-loop 회귀 0이
careful-diff가 아니라 *구조적* 보장). 인터프리터(`execute_steps`), `Aggregator`,
플러셔, `select_branch`는 두 경로가 공유한다.

### 2. 도착 분포: 균등 틱 (v1)

`tokio::time::interval(1/target_rps)`으로 틱당 arrival 1개를 발사한다. 고RPS에서
경과 시간만큼 batch 발사로 보정할 수 있으며, batch 모드에서 풀 만석이면
`dropped += 발사 못 한 arrival 수`(틱당 +1이 아님). Poisson/exponential 분포는 연기.

### 3. 백프레셔: drop + `dropped` 카운터

슬롯 풀이 만석(목표 레이트를 서비스가 못 따라감)이면 **그 arrival을 drop하고
`dropped` 카운터를 증가**시킨다. queue/delay(레이턴시로 흡수) 방식은
coordinated-omission으로 실측 레이턴시가 실제 미달을 가려 기각. 실제 RPS < target_rps가
리포트에 그대로 드러난다(정직한 부하 도구).

`dropped`는 **`runs.dropped` 스칼라 컬럼**(migration 0009, Rust-guarded ADD COLUMN)으로
영속화한다. 전체 blast radius: 엔진 `AtomicU64` → `MetricFlush.dropped` (최종 flush 1회)
→ proto `MetricBatch.dropped=6` → 워커 forward → controller `ingest_metrics` UPDATE
→ `RunRow.dropped` → `ReportJson.dropped` → UI Summary. SLO verdict(ADR-0028)는
**advisory-only**(verdict 로직 무변경). per-second drop 시계열은 연기.

reserved-step-id 무마이그레이션 대안(sentinel `step_id`를 `run_metrics` 행으로 싣기)은
세 읽기 사이트(`summary`/`windows_with_hdr`/`build_report`)가 sentinel을 special-case해야
해서 기각. run-total 스칼라 컬럼이 더 깨끗하다.

### 4. 정체성: 재사용 슬롯 풀 (슬롯 = vu_id)

`max_in_flight: Option<u32>` 개의 **`Arc<VuClient>`를 풀**로 두고 사전 적재된
`mpsc<usize>` free-index 큐로 permit 겸 슬롯 식별자를 제공한다. bare Semaphore는 permit에
인덱스가 없어 "슬롯 = vu_id" 정체성을 못 만드므로 기각.

- **슬롯 인덱스 = `vu_id`** (`0..max_in_flight`): `${vu_id}` 렌더, 데이터바인딩 키잉,
  미래 sticky 세션이 하나의 primitive에 일관 키잉된다.
- **cookie jar 슬롯-지속**: reqwest `Jar`에 mid-life `clear()`가 없어 풀 클라이언트 재사용이
  추가 작업 0. ADR-0018("VU별 jar가 run 내내 지속")과 동일한 의미로 슬롯에 일관 적용.
- **open-loop `iter_id` = 글로벌 arrival 카운터**(`AtomicU64`): closed-loop의 per-VU
  단조 `iter_id`를 대체. `select_index(vu_id=슬롯, iter_id=arrival_index, …)` 시그니처
  무변경 호출.
- **데이터바인딩(ADR-0022)**: `per_vu` → 슬롯 % rows(≤`max_in_flight`개 행, 문서화);
  `iter_sequential`/`unique` → 공유 `AtomicU64`; `iter_random` → `mix(seed, 슬롯,
  arrival_index)` 시드(분포 재현·슬롯↔arrival 페어링 비결정적이라 정확 재현 불가).

### 5. 멀티워커: v1 단일 워커

`target_rps.is_some()` 시 **`worker_count = 1` 명시 오버라이드**
(`if profile.target_rps.is_some() { 1 } else { worker_count_for(profile.vus) }`).
이유: 현재 `worker_count_for(vus)` 도출이 `vus`/capacity 기반이라 vus가 없는 open-loop에
맞지 않음. fan-out 규칙(N = `ceil(max_in_flight/capacity)`, 각 샤드 `target_rps/N` +
`max_in_flight/N`)은 ADR-0027 위에 얹는 별도 증분으로 연기.

### 6. config 표면 + 검증

| 필드 | 위치 | 기본 |
|---|---|---|
| `target_rps: Option<u32>` | `Profile`, proto field 8 | `None` = closed-loop |
| `max_in_flight: Option<u32>` | `Profile`, proto field 9 | `None` |

open-loop 검증: `target_rps 1..=1_000_000`, `max_in_flight` 필수(없으면 400) + `1..=10_000`,
`ramp_up_seconds > 0` → 400("S-D stages"), run-level `think_time` → 400(closed-loop 전용).
`vus` 무시(부하는 `max_in_flight·target_rps`가 지배).

### 7. 노브 충돌

`ramp_up_seconds` 또는 run-level `think_time`을 `target_rps`와 같이 지정하면 **400
BadRequest**. 두 노브 모두 페이싱을 target_rps가 이미 지배하므로 모순.
per-step `think_time`(S-B)·`http_timeout_seconds`/per-step `timeout_seconds`(S-A)는 직교.

### 8. 연기

churn(fresh-session) 노브, RPS 곡선(S-D stages), Poisson/exponential 분포,
graceful drain(in-flight stop), per-VU rate cap, per-second drop 시계열,
open-loop fan-out(멀티워커 N > 1).

## 결과

**Positive**
- `target_rps` 미지정 시 closed-loop byte-identical — 기존 시나리오·워크플로 회귀 0.
- 격리 함수로 구조적 회귀 없음(조건 컴파일 없이 hot-path와 완전 분리).
- 슬롯 = vu_id 정체성 모델로 `per_vu` 데이터바인딩·`${vu_id}`·ADR-0018 cookie jar가
  단일 워커 내에서 일관 동작.
- `dropped` 리포트가 "목표 못 채움"을 숨기지 않고 노출(정직한 부하 도구).
- 단일 워커(~20k RPS 천장)가 사내 QA 대다수 시나리오를 커버.

**Negative / Trade-offs**
- 단일 워커 v1은 target_rps > ~20k를 달성 못 함(fan-out 연기).
- `runs.dropped` migration(0009) — config 필드(profile_json serde-default)와 달리 유일한
  schema 변경.
- `dropped`가 SLO verdict에 포함 안 됨(advisory-only) — 대량 drop도 verdict엔 무영향.
- `iter_random` open-loop는 분포만 재현, 정확한 per-arrival 행 할당은 비결정적
  (슬롯↔arrival 페어링이 런타임 스케줄링에 달림).
- closed-loop `MetricFlush` 리터럴에 `dropped: 0` 필드 추가 필요(additive, 컴파일러 강제).
