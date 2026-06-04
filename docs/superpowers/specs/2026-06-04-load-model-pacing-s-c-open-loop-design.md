# S-C 오픈루프 (open-loop / arrival-rate 실행 모델) — 설계

> **상태**: 설계(brainstorming 완료) — 2026-06-04. 영역 D(부하 모델·페이싱)의 **3번째 슬라이스, 헤드라인**. 영역 umbrella spec = `docs/superpowers/specs/2026-06-03-load-model-pacing-config-design.md` §5 S-C. 선행 슬라이스: S-A 타임아웃(머지), S-B think time(머지).
>
> **신규 ADR**: **ADR-0031** "open-loop / arrival-rate 실행 모델" — 이 spec과 함께 작성. 결정 = §11.
>
> **이 문서의 성격**: 새 *실행 모델*을 들이므로 umbrella가 "자체 spec + ADR 필수"로 못박은 슬라이스. umbrella §5 S-C의 6개 설계 포인트를 전부 확정한다.
>
> **연관 ADR**: 0013(scenario vs run config), 0016(VU = tokio task per VU), 0012(워커측 메트릭 집계), 0018(VU별 cookie jar), 0014(변수 표기), 0022(data-driven), 0027(멀티워커 fan-out), 0028(SLO verdict).

---

## 1. 목표 / 동기

현재 실행 모델은 **closed-loop 하나뿐**이다(`crates/engine/src/runner.rs::run_scenario`). VU N개를 띄우면 각 VU가 `while Instant::now() < deadline { execute_steps(...) }`로 시나리오를 자유 반복한다. **RPS는 "VU 수 × 응답속도"의 *결과값*** 이라, "초당 500요청을 꽂아라" 같은 **목표 도착률(arrival rate)** 을 직접 줄 수 없다. SLA식 정밀 부하("이 서비스가 X RPS를 버티나")가 불가능하다. LoadRunner/JMeter 대체(ADR-0001)의 핵심 격차.

S-C는 **목표 도착률을 직접 주는 open-loop 실행 모델을 opt-in으로 추가**한다. closed-loop는 기본·무변경.

## 2. 현재 상태 (코드 기준, 확인됨)

- **실행 진입**: `runner.rs::run_scenario(scenario, plan, out, cancel)` → spawn 루프가 `plan.vus`개 VU를 선형 ramp로 spawn, 각 `run_vu`가 deadline까지 반복. 워커는 `crates/worker/src/main.rs:292`에서 이 함수를 단일 호출.
- **`RunPlan`**(`runner.rs:22`): `vus, ramp_up, duration, env, loop_breakdown_cap, vu_offset, data_binding, http_timeout, think_time, think_seed`.
- **HTTP 클라이언트**: `run_vu`가 `VuClient::with_timeout(scenario.cookie_jar, http_timeout)`로 **VU당 1개** 생성(`executor.rs:28`). cookie jar는 VU 수명 내내 지속(ADR-0018: 로그인 1회 → 반복 재사용).
- **데이터바인딩**(`dataset.rs`): `select_index(vu_id, iter_id, seq_counter)` — `per_vu`=`vu_id % rows`, `iter_sequential`/`unique`=공유 `AtomicU64`, `iter_random`=`mix(seed,vu_id,iter)` 시드. `${vu_id}`는 `template.rs`가 식별자로만 렌더.
- **Profile 배선**: `RunDialog` → `POST /api/runs` → controller `store::runs::Profile`(`runs.rs:76`, profile_json JSON 컬럼, `#[serde(default)]`) → proto `Profile`(`coordinator.proto:103`, 필드 1..=7) → worker `main.rs:181`이 `RunPlan` 빌드. **data_binding/criteria는 proto Profile에 없음**(controller-side: 바인딩은 `DatasetBatch`로, criteria는 리포트 시 verdict). 따라서 엔진에 필요한 새 필드만 proto Profile에 추가한다.
- **검증**: `api/runs.rs:62 validate_run_config`(run-create + preset-save 공유). 현재: `vus>0 && duration>0`, `loop_breakdown_cap<=10000`, `http_timeout 1..=600`, `think_time min<=max<=600000`, criteria, data_binding 컬럼/행 검증.
- **마이그레이션**: SQL `0001`..`0007`(`store/migrations/`) + Rust-guarded `0008`(`ensure_run_metrics_worker_id`, run_metrics PK에 worker_id). **다음 번호 = 0009.**

## 3. 핵심 통찰 — 풀 모델 + 슬롯 정체성

open-loop 표준 구현(k6 constant-arrival-rate, Gatling)은 `max_in_flight`를 **재사용 가능한 "VU-슬롯" 풀**로 둔다. 이게 두 가지를 동시에 준다:

1. **성능**: 풀 클라이언트가 연결 keep-alive를 재사용한다. fresh-client-per-arrival은 고RPS에서 connection churn으로 부하 생성기 자신이 병목이 된다.
2. **정체성 일관성**: **슬롯 인덱스 = `vu_id`** 로 두면 `per_vu`·`${vu_id}`·(미래의) sticky 세션이 전부 같은 primitive에 키잉된다.

이 두 결정이 S-C 코어를 **closed-loop와 일관**되게 만들고(아래 §4), 후속 정밀화(§9)를 *순수 가산*으로 만든다.

## 4. 정체성 모델 — 슬롯 = VU 아날로그, jar 슬롯-지속

- **슬롯 인덱스 = `vu_id`** (`0..max_in_flight`). `${vu_id}` → 슬롯 인덱스.
- **cookie jar = 슬롯 지속** (해당 슬롯이 도는 반복들에 걸쳐 유지). 이유: ① reqwest `cookie::Jar`는 mid-life `clear()`가 없어 "반복마다 리셋"은 clearable 커스텀 store를 새로 짜야 하는 작업이지만, 풀 클라이언트 재사용(=지속)은 추가 작업 0; ② **closed-loop ADR-0018이 이미 "VU별 jar가 run 내내 지속"** 이라, 슬롯=VU 아날로그면 슬롯 jar 지속이 *동일한* 의미 — 오늘 작성된 login-once-then-reuse 시나리오가 open-loop에서도 똑같이 동작.
- **open-loop `iter_id`** = **글로벌 arrival 카운터**(`AtomicU64`, arrival 발사마다 `fetch_add`). closed-loop의 per-VU 단조 `iter_id`(`runner.rs:301`)를 대체. `select_index(vu_id=슬롯, iter_id=arrival_index, seq_counter)` 시그니처 무변경으로 호출.
- **데이터바인딩**(ADR-0022, `select_index` 무변경): `per_vu` → `슬롯 % rows`(≤`max_in_flight`개 행, 문서화 — closed-loop가 `vus`로 제한되는 것과 동형). `iter_sequential` → 공유 `AtomicU64` 카운터(closed-loop 메커니즘 동일). `iter_random` → `mix(seed, 슬롯, arrival_index)` 시드. `unique` → 공유 카운터 + **소진 시 신규 arrival 발사 중단**(closed-loop stop-VU 아날로그).
- **IterRandom 결정성 한계**: 슬롯↔arrival 페어링은 런타임 스케줄링(어느 슬롯이 비었나)에 달려 *비결정적*이라, open-loop `iter_random`은 **시드되지만 정확한 per-arrival 행 할당은 재현 불가**(행 *분포*만 재현). closed-loop의 완전 재현성과 다름 — §10 테스트는 "seeded·분포 재현"만 단언.
- **per-step think time(S-B)·timeout(S-A)** 은 iteration 안에서 그대로 적용 — per-step think time은 슬롯을 그만큼 더 점유(= 현실적인 세션 길이, drop에 반영).

**이 정체성 모델이 두 유스케이스를 모두 커버한다**: 용량/한계점 측정(스테이트리스 → 쿠키 무관)과 현실적 세션(= `max_in_flight`개의 *지속 동시 사용자*가 target_rps를 생성). 진짜로 미루는 건 "매 arrival이 완전 새 사용자(churn)" 하나뿐(§9).

## 5. 실행 모델 — arrival 스케줄러 + 경계 슬롯 풀

`target_rps` 지정 시 closed-loop와 **격리된 새 함수 `run_scenario_open_loop`** 로 분기한다. 워커가 `profile.target_rps`로 `run_scenario`(기존, 무변경) vs `run_scenario_open_loop`를 선택 호출 — **기존 `run_scenario`/`run_vu`는 한 줄도 안 건드린다**(회귀 0이 구조적 보장이지 careful-diff가 아님).

`run_scenario_open_loop`의 구조:

- **슬롯 풀**: `pool: Vec<Arc<VuClient>>`, 길이 `max_in_flight`. 각 `Arc<VuClient>`는 자기 cookie jar + 슬롯 인덱스(= `pool`의 인덱스 = `vu_id`). `VuClient::with_timeout(scenario.cookie_jar, http_timeout)`로 생성. (`VuClient`는 `Clone` 아님 — `Arc`로 감싸 spawn에 `'static`으로 넘김.)
- **슬롯 할당 = free-index 풀**(bare `Semaphore` ❌ — permit엔 인덱스가 없어 "슬롯=vu_id"를 못 만든다): `0..max_in_flight`로 미리 채운 **free-slot-index 큐**(`crossbeam::queue::ArrayQueue<usize>` 또는 사전 적재 `mpsc`). 이 큐가 permit *겸* 슬롯 식별자.
  - 큐가 permit *겸* 인덱스라 별도 세마포어 불필요.
- **스케줄러 루프**: `1/target_rps` 간격으로 arrival을 발사. 매 arrival마다 free-slot 큐 `pop`(논블로킹):
  - **Some(idx)** → `tokio::spawn`으로 iteration 1회 실행: `execute_steps`(기존 인터프리터 재사용)에 `pool[idx].clone()`(Arc) + `agg.clone()`/`env.clone()`/`dataset.clone()`/`cancel.clone()`(전부 이미 `Arc`/`Clone`) 전달. 끝나면 `idx`를 큐에 반납.
  - **None**(빈 슬롯 없음) → **`dropped` 카운터++, 그 arrival 스킵**(§6 backpressure).
- **arrival 분포**: **균등 틱**(v1). Poisson은 분포 노브와 묶어 후속(§9).
- **deadline·cancel**: closed-loop와 동형 — 스케줄러 루프가 `tokio::select!`로 deadline/cancel에 즉시 반응, deadline 넘겨 매달리지 않음. cancel 시 in-flight는 closed-loop처럼 hard-cut(graceful drain은 §9 연기).
- **메트릭 플러셔**: closed-loop와 동일(`Aggregator` + `MetricFlush` 채널). per-step http 메트릭 의미 무변경.
- **고RPS 정밀도**: 단순 `tokio::time::interval`이 틱당 1 arrival을 발사. 매우 높은 target_rps에서 틱 오버헤드가 보이면 "경과 시간만큼 batch 발사"로 보정 — **단 batch 모드에선 풀 만석 시 `dropped += 발사 못 한 arrival 수`**(틱당 +1이 아님). plan 단계 구현 디테일이나 drop 회계는 모델의 일부라 명시.

> **별도 함수 vs 분기**: umbrella §5는 "기존 `run_scenario` 분기 or 별도 함수"를 허용. **별도 함수**를 택하는 이유 = closed-loop byte-identical을 *구조적으로* 보장(공유 코드 0). 인터프리터(`execute_steps`)와 `Aggregator`/플러셔/`select_branch`는 공유.

## 6. backpressure — drop + `dropped` 카운터

슬롯 풀 만석(목표 레이트를 못 따라감) 시 **drop + 명시 카운터**:

- arrival을 못 쏘고 **최상위 `dropped` 카운터++**. 실제 RPS < `target_rps`가 리포트에 그대로 드러난다 — 부하 도구로선 정직(목표 못 채움을 숨기지 않음). queue/delay(레이턴시로 흡수)는 coordinated-omission으로 측정 latency가 실제 미달을 가려 기피.
- 이게 영역 spec §3.4가 명시적으로 허용한 **"S-C만 메트릭에 새 개념을 들임"** 의 유일한 지점.

**파이프라인 — 전체 blast radius**(plan이 각 사이트를 개별 task로). `dropped`는 7-1/9d와 달리 *전용 테이블 델타 누적*이 아니라 **`runs` 행의 스칼라 UPDATE** 라 이 repo에 선례 없는 새 write shape — 그래서 사이트를 빠짐없이 나열:

1. **엔진**: `run_scenario_open_loop`가 `AtomicU64 dropped` 증가.
2. **`MetricFlush`에 `dropped: u64` 필드 추가**(periodic + final flush 델타). **공유 타입** → closed-loop `run_scenario`의 두 `MetricFlush{}` 리터럴(`runner.rs:169`, `:203`)에 `dropped: 0` 명시(additive). (engine CLAUDE.md: `MetricFlush` 변경은 모든 consumer 재빌드 강제 — 여기선 additive라 리터럴만.)
3. **proto `MetricBatch`에 `uint64 dropped = 6;`**(현재 1..=5, additive, closed-loop=0).
4. **워커 포워드**(`main.rs`): forwarder가 `flush.dropped`를 읽어 `MetricBatch{ …, dropped }`(유일 리터럴 `main.rs:259`)에 세팅. (proto Profile 신규 필드는 별개로 `api/runs.rs`의 `Profile{}` 빌드 리터럴 갱신 — §7.1.)
5. **controller 누적**(신규 write): `ingest_metrics`(`grpc/coordinator.rs:~783`)에 `UPDATE runs SET dropped = dropped + ?`(batch.dropped>0일 때). 멀티워커는 v1 단일워커라 합산 자명(미래 fan-out도 같은 UPDATE로 워커별 누적).
6. **저장 스키마**: `runs.dropped INTEGER NOT NULL DEFAULT 0`(**마이그레이션 0009**) — `runs.message`(connect()의 `pragma_table_info` 가드 ADD COLUMN)·`run_metrics.worker_id`(0008)와 동형 **idempotent Rust-guarded ADD COLUMN**.
7. **읽기 경로**: `runs::get`(SELECT에 `dropped` 추가) → `RunRow`에 `dropped: i64` 필드 → `build_report`(`api/runs.rs`)가 `RunRow.dropped`를 `ReportJson.dropped: u64`로 thread. `ReportRun.profile`은 이미 `serde_json::Value`(`report.rs:28`)라 `target_rps`는 무료.
8. **UI**: summary에 `target_rps`(설정) / achieved RPS(기존 `summary.rps`) / `dropped`(+drop율).

> **reserved-step-id 무마이그레이션 대안을 기각하는 이유**: `dropped`를 sentinel `step_id`(예: `"__dropped__"`)의 `run_metrics` 행으로 실으면 마이그레이션은 피하나 — (a) dropped는 레이턴시 윈도가 아니라 HDR/status가 없는 count-only 가짜 윈도라 부자연, (b) `summary`/`windows_with_hdr`/`build_report` **세 읽기 사이트가 sentinel을 special-case**해야 per-step 리포트 오염을 막음. run-total 스칼라 컬럼(write 1 + read 1) 쪽이 깨끗 → 컬럼 채택, §10 deviation 감수.
>
> **영역 spec §10("S-C 포함 마이그레이션 0")과의 의도된 어긋남**: §3.4(S-C 메트릭 예외)가 §10보다 우선. **config 필드(target_rps/max_in_flight)는 여전히 profile_json serde-default라 마이그레이션 0**; dropped 메트릭만 0009. **per-second drop 시계열은 연기**(§9) — v1은 run-total 스칼라.
>
> **SLO verdict(criteria)와의 관계**: v1에서 `dropped`는 **advisory-only** — verdict(ADR-0028)는 achieved RPS·error_rate·percentile만 보고 dropped는 판정에 안 들어간다(verdict 로직 무변경). dropped를 verdict 신호로 묶는 건 후속.

## 7. config 표면 + 검증

### 7.1 Profile / proto 필드 (additive)

| 위치 | 필드 | 기본/미설정 |
|---|---|---|
| `store::runs::Profile` | `#[serde(default)] target_rps: Option<u32>` | `None` = closed-loop |
| `store::runs::Profile` | `#[serde(default)] max_in_flight: Option<u32>` | `None` |
| proto `Profile` | `optional uint32 target_rps = 8;` | absent = closed-loop |
| proto `Profile` | `optional uint32 max_in_flight = 9;` | absent |
| `RunPlan` | `target_rps: Option<u32>`, `max_in_flight: Option<u32>` | `None` = `run_scenario` |

미지정 → `run_scenario`(closed-loop) byte-identical, **profile_json 마이그레이션 0**.

> **prost exhaustive 함정**: proto `Profile`에 필드 2개 추가 시 worker가 받는 쪽 외에 **`Profile{}` 빌드 리터럴**(`api/runs.rs`의 `PendingAssignment.profile` ~`:209`)도 갱신해야 컴파일된다(controller CLAUDE.md). plan은 `grep -n "Profile {" crates/` + `grep -n "MetricBatch {" crates/`(후자는 `worker/src/main.rs:259` 단일)로 모든 리터럴을 잡는다.

### 7.2 검증 (`validate_run_config`, mode-aware)

`target_rps.is_some()` = open-loop 모드. 검증을 모드별로:

- **closed-loop**(target_rps 없음): 현행 그대로(`vus>0 && duration>0` 등).
- **open-loop**(target_rps 있음):
  - `target_rps`: **`1..=1_000_000`**. (레이트는 스케줄링만이라 싸다 — 단일워커 achievable는 ~20k지만 상한은 넉넉히.)
  - `max_in_flight`: **필수**(없으면 400 "open-loop은 max_in_flight가 필요합니다"), **`1..=10_000`**. 이 상한은 *자원 안전* 경계 — **슬롯 1개 = `reqwest::Client` 1개 + cookie jar 1개**(per-slot jar라 Client 공유 불가)라, 큰 값은 connection pool·fd·메모리를 폭증시킨다. 10_000도 보수적 상한이지 권장치 아님(실사용은 보통 수백~수천).
  - **`vus`는 open-loop에서 무시**(부하는 max_in_flight·target_rps가 지배) → open-loop에선 `vus>0` 강제 안 함. `duration>0`은 여전히 필수. **슬롯 풀 크기는 `plan.max_in_flight`이지 `plan.vus`가 아니다**(워커가 `RunPlan{vus: assignment.vu_count}`로 채워도 open-loop 함수는 `vus`를 안 본다 — §5).
  - **충돌 거부(400)**: `ramp_up_seconds > 0`(→ "RPS 곡선은 S-D stages") 또는 run-level `think_time.is_some()`(→ "run-level think time은 closed-loop 전용"). 둘 다 페이싱을 target_rps가 지배하므로 모순.
  - data_binding/criteria/http_timeout/per-step 검증은 그대로 유효(직교).

- **워커 수 강제(단일워커 v1)**: run-create의 `n = worker_count_for(body.profile.vus)`(`api/runs.rs:~227`)는 `vus≠0`이면 1을 안 준다 → **`let n = if profile.target_rps.is_some() { 1 } else { worker_count_for(profile.vus) };`** 로 명시 오버라이드. (안 하면 `vus=5000` open-loop가 3워커로 fan-out돼 각자 full target_rps를 쏨 = 3×.) fan-out은 §9 연기.

preset-save도 같은 게이트라 모순 프리셋이 저장 시점에 걸린다.

### 7.3 기존 노브 상호작용 요약

✅ open-loop서 유효: `duration_seconds`, **per-step** `think_time`(S-B), `http_timeout_seconds`/per-step `timeout_seconds`(S-A), `data_binding`(§4 키잉), `loop`/`if` 노드, `criteria`(SLO verdict — achieved RPS·error_rate 기준).
❌ 거부(400): `ramp_up_seconds`(→S-D), run-level `think_time`. ⊘ 무시: `vus`(open-loop 부하에 미사용).

## 8. UI (RunDialog)

- **부하 모델 토글**: RunDialog에 "Load model: Closed-loop (VUs) / Open-loop (arrival rate)" 선택. open-loop 선택 시 필드 셋 스왑:
  - open-loop: `target_rps`(필수), `max_in_flight`(필수), `duration_seconds`. `vus`·`ramp_up_seconds`·run-level think time 숨김(보내지 않거나 무시되는 값을 노출 안 함 → 충돌 400 자체를 UI에서 예방).
  - closed-loop: 현행 그대로.
- **검증 1:1**: target_rps/max_in_flight 범위를 UI에서도 검사(controller와 동일 상한 `1..=1_000_000` / `1..=10_000`), 빈 max_in_flight 게이트. Zod는 **`z.number().int().positive().max(...).optional()`**(`.default()` ❌ — nested `.default()`는 `number|undefined` parent-infer 누출, ui/CLAUDE.md).
- **리포트**: Summary에 `target_rps`(설정) / achieved RPS(기존) / `dropped`(+drop율) 노출. `ui-optional-sections-collapsible` 선호 준수(open-loop 섹션 접이식 가능).
- 와이어: `ScenarioTrace`/test-run은 무관(test-run은 단일패스 trace라 부하 모델 미적용).

## 9. 범위 밖 / 연기

- **churn 노브 (매 arrival 새 세션)** — clearable cookie jar opt-in(`fresh_session_per_iteration` 류). reqwest용 clearable CookieStore 구현 필요. 기본 off → §4 슬롯-지속이 default. umbrella가 "S-C2"라 칭한 정체성 정밀화지만, **이 문서에선 "churn 노브"로 부른다**("S-C2"는 dropped-persistence 분리 논의와 명칭이 겹쳐 혼동 — §9 task-순서 가드 참조). 슬롯=정체성 + 풀 모델 위에 *순수 가산*(플래그 + store)이라 후환 없음.
- **멀티워커 open-loop fan-out** — v1은 **단일 워커**(controller가 `target_rps` 있으면 worker_count=1 강제). 이유: 멀티워커 worker-count 도출이 현재 `vus`/capacity 기반(`worker_count_for(vus)`)인데 open-loop엔 vus가 없어 **`max_in_flight` 기반 재도출 + `target_rps/N`·`max_in_flight/N` 샤딩**이 필요 — A3 shard 인프라(ADR-0027) 위에 얹는 별도 증분. **고정 규칙**(N = `ceil(max_in_flight/capacity)`, 각 샤드 `target_rps/N`+`max_in_flight/N`, ceil)은 ADR-0031에 박아두되 구현은 follow-up. 단일 워커 baseline(~20k RPS)이 사내 QA 대부분을 커버.
- **RPS 곡선/다단계 ramp** = S-D(`stages`). **Poisson/exponential 도착 분포**, **per-second drop 시계열**, **graceful stop(in-flight drain)**, **per-VU rate cap** = 후속.

> **task 순서 가드(plan 작성 지침)**: `dropped` *영속화* 파이프라인(§6.3–6.8: proto 필드 → 워커 forward → migration 0009 → `ingest_metrics` UPDATE → `runs::get`/`RunRow` → `build_report`/`ReportJson` → UI)은 실행모델 코어(§5 스케줄러+슬롯풀+config)와 **분리 가능**하다. 코어가 예상보다 커지면 dropped *영속화* 를 follow-up으로 떼고 코어는 dropped를 엔진 로그/in-memory로만 노출해도 acceptance(achieved≈target, closed-loop byte-identical)는 성립. **그래서 plan은 dropped 영속화 task를 *맨 뒤*에 배치**해 필요 시 잘라낼 수 있게 한다.

## 10. 하위 호환 / 테스트 / acceptance

- **byte-identical**: `target_rps` 미지정 → 워커가 `run_scenario`(무변경) 호출. `RunPlan`/`MetricFlush`/proto 새 필드는 closed-loop서 default(None/0). profile_json 마이그레이션 0. closed-loop 회귀 0이 acceptance(별도 함수라 구조적).
- **엔진 통합 테스트**(wiremock):
  - 충분한 `max_in_flight` → achieved RPS ≈ `target_rps`, `dropped ≈ 0`.
  - 작은 `max_in_flight`(느린 stub) → `dropped > 0` & achieved < target(drop 정직성).
  - 슬롯=`vu_id` 렌더, `per_vu`=슬롯%rows, jar 슬롯-지속(같은 슬롯 2회 반복 시 쿠키 유지) 검증. `iter_random`은 **seeded·행 분포 재현**만 단언(정확한 per-arrival 할당은 비결정적 — §4).
  - cancel → 즉시 Aborted, deadline 안에서 종료.
- **controller**: `validate_run_config` open-loop 분기(max_in_flight 필수, 충돌 400, vus 무시) + **`target_rps` 있으면 worker_count=1**(`vus`가 커도 단일워커 — §7.2 override 단언). dropped 누적(`ingest_metrics` UPDATE) + 리포트 노출. e2e smoke(워커 subprocess → 리포트에 dropped).
- **UI**: RunDialog 모드 토글 + 필드 스왑 + 검증, 리포트 dropped 렌더(RTL).
- **perf**: adequate `max_in_flight`에서 closed-loop 천장 근처 `target_rps` 지속(수동 RPS 검증, umbrella의 python `ThreadingHTTPServer` 하네스 재사용 — closed-loop think time 검증과 동형).
- **게이트**: `cargo fmt/clippy/test --workspace` + UI `pnpm lint && pnpm test && pnpm build` + 최종 `handicap-reviewer` 와이어 1:1(proto↔controller↔engine↔UI).

## 11. ADR-0031 결정 목록

ADR-0031 "open-loop / arrival-rate 실행 모델"에 박을 결정:

1. **opt-in**: `target_rps` 존재 = open-loop, 부재 = closed-loop(기본·byte-identical). 격리된 `run_scenario_open_loop`.
2. **arrival 분포**: 균등 틱(v1). Poisson 후속.
3. **backpressure**: drop + 최상위 `dropped` 카운터(coordinated-omission 회피). queue/rate-down 기각.
4. **정체성**: `max_in_flight` 재사용 슬롯 풀(`Vec<Arc<VuClient>>` + free-index 큐, bare Semaphore 아님), 슬롯 인덱스 = `vu_id`. cookie jar 슬롯-지속(ADR-0018 일관). `per_vu`→슬롯, `iter_*`/`unique`→글로벌 카운터. **open-loop `iter_id` = 글로벌 arrival 카운터**; `iter_random`은 seeded·분포 재현(슬롯↔arrival 페어링 비결정적이라 정확 재현 불가).
5. **멀티워커**: v1 단일 워커 — `n = if target_rps.is_some() {1} else {worker_count_for(vus)}`(명시 override, `worker_count_for(vus)`는 vus≠0이면 1을 안 줌). fan-out 규칙(N from max_in_flight, `/N` 샤딩) 고정·구현 follow-up.
6. **메트릭**: dropped run-total **`runs.dropped` 스칼라 컬럼**(마이그레이션 0009, §3.4 예외; reserved-step-id 무마이그레이션 대안은 3 읽기사이트 special-case 때문에 기각). 전체 blast radius §6. SLO verdict엔 **advisory-only**(verdict 무변경). per-second 시계열 연기.
7. **노브 충돌**: `ramp_up_seconds`·run-level `think_time` + `target_rps` → 400. `vus` 무시.
8. **연기**: churn(fresh-session) 노브, RPS 곡선(S-D), Poisson, graceful drain.
