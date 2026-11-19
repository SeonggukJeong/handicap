# 계단 시험 b·c — 자동 정지 + 실행 중 계단 판정 (설계)

- 날짜: 2026-11-18 · 유형: user-path · roadmap §A16의 b(+c)
- **상태: b 구현·머지 완료 (2026-11-19, `dc925569`..`65da0721`, 판단·연기 roadmap §B69, 결과 build-log) · c(§8) 미착수**
- **슬라이스 분할 (사용자 결정 2026-11-18)**: 설계 문서는 이 하나, 구현은 둘.
  - **b = `stage-auto-stop`**: 공유 누적기 리팩터 → 감시 + 두 정지 규칙 → 종료·영속(migration 0025) → 리포트·내보내기·인쇄 → 실행 창 상자 → 성능 증명. US1·US2·US4·US5. plan은 b만.
  - **c = `stage-live-panel`**: 실행 중 패널 + `auto_stop_live` + ADR-0059. US3. b 머지 뒤 바로(§8). c의 plan은 c 착수 때 이 문서 §8로 쓴다.
- 선행: a = stage-saturation-table(`c6bd24e5`..`918f8404`, spec `2026-11-18-stage-saturation-table-design.md` — 이하 「a spec」). a spec §9의 b 범위를 이 문서가 대체·확정한다.
- 화면 기준: a 목업 `2026-11-18-stage-saturation-mockup.html`의 꼬리표 **b** 요소 + 이 문서의 텍스트 스케치(판정 방식 선택·최소 요청 수·「일부 실행」 행·실행 중 패널은 목업에 없음 — 이번 대화에서 추가).

## 사용자 스토리 (US)

(사용자 승인 2026-11-18. US1은 spec 리뷰 뒤 사용자 재승인 — 다음 계단에 일부 들어가는 사실을 정직하게)

- **US1** [b]: 운영자가 운영 환경 저트래픽 시간대에 계단 run을 돌린다. 두 계단이 연속으로 실패하면, 성공 시 판정 계단 측정이 끝난 뒤 몇 초 안에 1초 RPS가 0으로 떨어진다. 다음 계단에 얼마나 들어갔는지는 리포트에 「9계단 상승 2초 진입 후 정지」처럼 표시되고, 그 뒤 계단은 「실행 안 함」으로 남는다. run 상태는 「완료」이고 리포트 맨 위에 자동 정지 줄(판정 계단·사유·시각), run 상세·목록에 「자동 정지」 표지가 보인다. CSV·XLSX·인쇄도 같다.
- **US2** [b]: QA가 계단 run 중 오류나 지연이 갑자기 치솟는 상황(상승·버림 구간 포함)을 만난다. 성공하면 즉시 정지 기준(기본 켜짐 · 오류율 5% · p99 2000 ms 초과 · 3초 연속, 수정 가능)을 넘은 지 몇 초 안에 run이 멈춘다. 리포트에는 「k계단 (상승/버림/측정) 중 즉시 정지 — 사유 · 시각 · 마지막 정상 계단」이 보이고, 측정이 덜 된 계단 숫자는 「—」로 비어 있다.
- **US3** [c]: 운영자가 계단 run을 서버 대시보드 옆에 띄워 놓고 지켜본다. 성공하면 실행 중 화면에 현재 계단, 계단별 판정(정상/실패/측정 중/예정), 즉시 정지 현재값과 기준, 「다음 계단이 실패하면 자동 정지」 예고가 보인다. 멈추는 순간 이유가 바로 보인다. 실행 중에 본 판정은 끝난 뒤 리포트의 판정과 같다.
- **US4** [b]: QA가 운영 시험에서 실패 뒤 한 계단도 더 올리고 싶지 않아 「첫 실패에서 바로 정지」를 고른다. 성공하면 고를 때 경고(튄 계단으로도 멈출 수 있음)가 보이고, 첫 실패 계단 측정 끝에서 멈추며, 리포트는 「포화 확인 못 함」으로 남는다.
- **US5** [b, c는 자기 비용 재측정]: 운영자가 자동 정지를 켠 채 높은 RPS의 계단 run을 돌린다. 성공하면 같은 조건에서 켬 / 끔 / 기존 master를 비교해 달성 RPS, 부하기 CPU, 컨트롤러 CPU, 데이터 수신 지연이 §7 기준 안에 있다. 계단이 아닌 run은 리포트와 와이어가 바이트 단위로 이전과 같다.

## 1. 왜

사용자의 신규 MSA 시스템 수용성 시험은 **운영 환경 저트래픽 시간대**에 돈다(메모 `new-system-capacity-test`). a는 계단 run이 끝난 뒤 포화 계단을 알려 주지만 run은 설정한 계단을 끝까지 돈다 — 포화 뒤에도 더 높은 부하를 운영 시스템에 넣고 짧은 시험 시간대를 쓴다. 또 지켜보는 사람은 run이 끝날 때까지 판정을 볼 수 없다(리포트는 terminal 뒤 한 번만 조회 — `ui/src/api/hooks.ts` `useRunReport` `refetchInterval: false`).

## 2. 목표 / 비목표 / 반목표

**목표**
- 포화 정지: 판정 방식 2종 — 「연속 두 계단 실패」(기본) / 「첫 실패에서 바로 정지」(경고 동반).
- 즉시 정지: 초 단위 전 부하기 합산 오류율·p99가 기준을 N초 연속 넘으면 정지. 상승·버림 포함 run 전체 감시. 초당 완료 수가 적은 초는 판정 보류.
- 자동 정지 run = 상태 「완료」 + 정지 기록 영속. 다음 계단 일부 진입을 정직하게 표시.
- 리포트·CSV·XLSX·인쇄: 정지 줄 + 「일부 실행」·「실행 안 함」·「즉시 정지」 행.
- [c] 실행 중 패널.
- **성능 저하 없음을 수치 기준으로 증명**(§7).

**비목표**
- 즉시 정지를 계단 아닌 run에 적용 — 사용자 결정: 이번엔 계단만, **모든 run 확장은 roadmap §B 연기 항목**(b 마무리 때 비용·해소법 기록).
- 멈춘 뒤 대상 회복 관찰(서버 대시보드 영역; 리포트는 시각만 정확히).
- 실행 중 계단 표 전체·차트 실시간 갱신.
- run 목록 필터에 「자동 정지」 축.

**반목표 (돌아가도 실패)**
- 부하기(엔진·워커)의 부하 정확도·처리량 저하. **엔진·워커·proto 무변경.**
- 실행 중 감시 판정 ≠ 끝난 뒤 리포트 판정(§4.3 동등성 테스트로 고정).
- 반쯤 측정된 계단 숫자를 측정값처럼 보여 주는 것 / 그 계단을 판정에 넣는 것(§5.1).
- 데이터가 다 오지 않은 초·계단을 판정해 **거짓 정지**, 또는 표본이 너무 적은 초로 거짓 정지.
- 설정과 다르게 덜 간 부하(일부 실행·실행 안 함)를 리포트에서 못 보는 것(메모 `load-divergence-explain-confirm`).
- 계단 아닌 run의 리포트·run 응답·CSV·XLSX·인쇄 바이트 변화.

## 3. 접근 (사용자 결정 2026-11-18)

| 접근 | 내용 | 결과 |
|---|---|---|
| **A. 컨트롤러 감시** | run마다 감시 작업. 리포트와 같은 누적·판정 코드로 계단 경계마다 판정, 초마다 즉시 정지 확인 | **채택** |
| B. 실행 중 리포트를 몇 초마다 재계산 | 화면 작업 최소 | 기각 — 리포트 계산은 초마다 HDR 재디코드(§B68 N3), 진행 중 계단이 깜빡여 오해 |
| C. 브라우저가 판정 | | 기각 — 판정 2벌, p99용 HDR이 화면 API에 없음 |

**데이터 출처 (사용자 결정 — 성능)**: 컨트롤러가 이미 받는 MetricBatch 흐름에서 바로 누적(추가 DB 조회 0). 리포트의 계단 집계를 누적기로 리팩터해 리포트(DB 행)와 감시(받은 배치)가 **같은 누적기·같은 판정 함수**를 쓴다.

## 4. 설계 (b)

### 4.1 profile `stair.auto_stop` (controller-only, 와이어 아님)

`StairConfig`(`crates/controller/src/stair.rs`)에 가산:

```rust
#[serde(default, skip_serializing_if = "Option::is_none")]
pub auto_stop: Option<AutoStopConfig>,

pub struct AutoStopConfig {
    #[serde(default)] pub saturation: Option<SaturationStopMode>, // "two_fails" | "first_fail"; null = 끔
    #[serde(default)] pub emergency: Option<EmergencyStop>,       // null = 끔
}
pub struct EmergencyStop {
    pub error_rate_pct: f64,       // 0 < x ≤ 100, 기본 5 (소수 허용)
    pub p99_ms: u32,               // 1..=600_000, 기본 2000
    pub consecutive_seconds: u32,  // 1..=60, 기본 3
    pub min_requests: u32,         // 1..=100_000, 기본 20 — 초당 완료가 이보다 적으면 그 초는 판정 보류
}
```

- 직렬화: `auto_stop` 키는 None이면 생략, 안의 `saturation`·`emergency`는 **항상 키가 있고 끄면 `null`**. 입력은 키 생략도 허용(serde default).
- **absent = 둘 다 끔** → a에서 저장된 계단 run·프리셋·스케줄과 바이트 동일. **새 계단 run의 기본 켜짐은 UI가 채운다**(실행 창·스케줄 폼의 「계단」 초기값: `two_fails` + 5 % · 2000 ms · 3초 · 20개). 「다시 실행」·프리셋 불러오기는 **저장된 그대로**(absent면 꺼짐) — 실행 창 상자에 상태가 보이므로 숨은 동작 아님. 【내 판단】 서버 기본을 켬으로 두면 a 저장본이 말없이 다른 동작을 얻는다.
- 검증은 `validate_stair`에 가산(범위 밖 = 400, 한국어). 5개 진입점(run 생성·프리셋·스케줄·다시 실행·스케줄 발사)은 `stair`를 통째로 저장·전달 — plan이 진입점마다 round-trip 테스트.
- `expand_stair`·워커로 가는 `stages`는 무변경.

### 4.2 정지 규칙 (순수 함수, 표 테스트로 고정)

#### (a) 포화 정지 — 계단 판정

입력 = 길이 n의 `StepNumbers` 목록. **모든 워커에서 측정 구간이 끝난(§4.4) 계단만 숫자 그대로**, 나머지는 `measured=false`(목록을 자르지 않는다 — 자르면 `judge`가 마지막 계단 실패를 「포화」로 읽는다). a의 `judge`를 그대로 돌린다.

실패 계단 정의: `fail(i)` = 계단 i가 측정 완결 ∧ (`states[i] ∈ {Saturated, Unconfirmed, Spike}` ∨ (`states[i] == After` ∧ `reasons[i]` 비어 있지 않음)). 슬롯 부족 의심 사유도 실패에 포함(【내 판단】 목표를 못 거는데 더 높은 계단은 무의미; 정지 줄에 「슬롯 부족 의심」 병기).

`fn saturation_stop(j, done: &[bool], mode) -> Option<SaturationStop>`. **판정 안 된 계단이 하나도 안 남았으면(마지막 계단까지 완결) 항상 None** — 자연 종료와 같다.

| mode | 정지 조건 | 기록 |
|---|---|---|
| `two_fails` | 완결된 이웃 두 계단 i, i+1이 `fail(i) ∧ fail(i+1)`인 가장 이른 i | `failed_steps = [i, i+1]`, `decided_step = i+1` |
| `first_fail` | 가장 이른 `fail(i)` | `failed_steps = [i]`, `decided_step = i` |

- 이 일반 규칙이 a 판정의 특수 경우를 다 덮는다: 튐(Spike 다음은 정상이라 쌍이 안 됨) · 첫 계단 실패 뒤 계단 1 정상(`states[1] = After` 사유 없음 → 쌍 아님, 계속 감) · 그 뒤 `After` 계단 둘이 연속 사유를 가지면 정지.
- 정지 줄 사유 문구는 a 머리말의 「포화 계단」과 섞이지 않게 **「7·8계단 연속 실패」**(two_fails) / **「7계단 실패 — 첫 실패에서 정지」**(first_fail)로 쓴다(첫 계단 예외에서 머리말 포화 지점과 정지 사유 계단이 달라도 모순이 아니게).
- `first_fail`의 리포트 머리말은 a의 `unconfirmed`(다음 계단이 판정에 안 들어가므로 — §5.1).

#### (b) 즉시 정지 — 초 판정

- 초 t = **절대 초(`ts_second`)**. 값 = 그 초에 모든 활성 워커가 보낸 metric window(전 스텝) 합: 오류율 = Σerror/Σcount, p99 = 머지 HDR 0.99 분위.
- **판정 보류 초**: `Σcount < min_requests`(0 포함). 연속 계수를 끊지도 늘리지도 않는다(사용자 승인 — 첫 계단 상승 첫 초처럼 표본이 몇 개뿐인 초의 거짓 정지 방지, 완전히 멈춘 순간 계수가 끊기지 않게).
- **나쁜 초**: 오류율 > `error_rate_pct/100` ∨ p99 > `p99_ms`(엄격한 초과 — 화면 「초과」 표기와 같음; 같으면 정상).
- 보류 초를 건너뛴 순서로 나쁜 초가 `consecutive_seconds`개 이어지면 정지. 기록 = 마지막 나쁜 초 시각 · 그 N초의 최대 오류율 · 최대 p99 · 두 조건 각각 걸렸는지(같은 초에 함께 판정되므로 둘 다 기록) · 그 초가 속한 계단·구간(가장 이른 t0 워커 기준, `ramp`/`discard`/`measure`).
- 감시 범위 = 첫 워커 t0부터 마지막 계단 끝까지(상승·버림 포함).
- 같은 처리 순간 두 정지가 다 성립하면 즉시 정지 기록이 이긴다.

### 4.3 공유 누적기 (리포트 ↔ 감시 단일 코드)

a `build_stair_report`의 워커별 반복을 누적기로 뽑는다.

- `StairAccumulator::new(cfg)` · `set_worker(w, t0_ms, last: Bound)` · `push_open_loop(w, row)` · `push_metric(w, ts, step_id, count, errors, &Histogram)` · `numbers(complete: &[bool]) -> Vec<StepNumbers>`.
  - **리포트**: a와 같은 사전 패스로 워커별 t0(없으면 최소 ts로 추정 — `t0_estimated`)·활성 여부·`last`를 정한 뒤 `set_worker(w, t0, Bound::Upto(last))`, DB 행을 밀어 넣는다. 비활성 워커는 a처럼 제외.
  - **감시**: 워커 t0는 배치의 `open_loop_started_at_ms`(첫 값 유지 — 저장 테이블과 같은 규칙), `Bound::Open`(측정 구간을 `last`로 자르지 않음; 판정엔 완결 계단만 쓰므로 잘림이 불필요). 시작 시각을 아직 안 보낸 워커는 행을 보류 버퍼에 두었다가 t0가 오면 반영.
- **비트 동일성 조건**: (1) 워커별 **정수 계수**로만 누적하고, 나눗셈·f64 합은 `numbers()` 안에서 **worker_id 정렬 순서**로 한다(도착 순서 합 금지 — a의 `achieved += completed/d` 순서 의존 제거). (2) ingest와 **같은 중복·타당성 규칙**을 공유 함수로: metric·open-loop 행은 (워커, 초[, 스텝]) 첫 값 유지(DB `ON CONFLICT DO NOTHING`·`run_metrics` 첫 행), 시계에서 먼 초·시작 시각은 버림(`coordinator.rs` ingest 필터). (3) HDR 머지는 교환법칙이 성립해 순서 무관.
- 동등성이 보장되는 범위 = **모든 활성 워커에서 측정 구간이 끝난 계단** (예외: run 전체에서 도착을 한 번도 만들지 않은 워커 — 리포트는 빼고 감시는 시작 시각을 보낸 워커로 세므로 t0 정렬에 따라 측정 초가 1 차이 날 수 있다; 계단 목표 < 워커 수 같은 몫 0 분할에서만. §11). 테스트: 같은 행 집합을 (1) DB 경로 리포트, (2) 배치 순서를 무작위로 섞은 감시 누적기로 계산해 그 계단들의 `StepNumbers`가 **비트 단위로 같음**. 되돌려 확인 2개: 계단 배정 한 줄 변경 → RED, 도착 순서 f64 합으로 변경 → RED(섞기 시드 고정 + 여러 시드).
- a 리포트 테스트 **무수정 통과**(리팩터 회귀 가드).

### 4.4 데이터 완결 (거짓 정지 방지)

- 엔진 flusher는 500 ms마다 **끝난 초만** 보내고 open-loop 초 계수는 `now_s−1`까지 0행으로 채워 보낸다; metric window와 open-loop 계수를 같은 `now_s`로 같은 잠금 안에서 꺼내고(`runner.rs` flusher), 워커는 open-loop 초만 있는 flush도 버리지 않는다. 그래서 **워커 수위 = 받은 open-loop 초의 최댓값**이면 그 초까지 window도 다 왔다. (리뷰 확인.) 고정 테스트는 **엔진을 고치지 않고** 컨트롤러 쪽에서 엔진 공개 실행 진입점으로 짧은 계단 open-loop를 돌려 받은 `MetricFlush` 열에서 이 성질을 단언한다(`OpenLoopCounters`는 `pub(crate)` — 엔진 diff 0 유지).
- 0행 채우기는 스케줄 종료(`end_s`)에서 멈춘다 — 마지막 계단 뒤엔 판정할 것이 없어 무관.
- 초 t 완결 = 활성 워커 전부 수위 ≥ t. 계단 i 완결 = 워커마다 수위 ≥ 그 워커의 측정 구간 끝 초(`hi_i(w) − 1`). 등록 미달(`expected`보다 적은 워커가 시작 시각을 보냄)이면 판정 안 함.
- **스케줄이 끝난 워커**: 0행 채우기는 워커 자신의 스케줄 끝(`end_s`)에서 멈추므로(`open_loop_counters.rs`), 수위 ≥ `floor((t0_ms + 전체 계단 ms)/1000) − 1`(1초 여유 — `end_s`가 마감 초보다 1 작을 수 있음)인 워커, 또는 **end-phase를 보고한 워커**(unique 데이터셋 소진 등 스케줄 조기 종료 포함 — coordinator가 감시 채널로 「워커 종료」를 알림)는 이후 모든 초·계단에 대해 「완결」로 보고 아래 지연 폭에서도 뺀다(시작 시각이 어긋난 워커들의 run 꼬리에서 판정이 멈추거나 거짓 보류가 나지 않게). 경계값 테스트로 고정. **조기 종료 워커 = 포화 판정 동결** (리뷰 S1·T1, 【내 판단】 option B): 워커가 시간 기준 끝(위 `−1` 경계) **전에** end-phase를 보고하면(unique 데이터셋 소진 등) 그 run은 더 이상 설정한 부하가 아니므로, 감시는 그 시점에 아직 완결 안 된 모든 계단에 대해 **포화 정지 판정을 멈춘다**(`judged_through` 동결 — 이후 포화 정지 없음). 즉시 정지는 남은 워커로 계속. 이유: 그 워커의 완료 꼬리(소진 뒤 끝난 요청 — `runner.rs` `join_next` 대기)는 이미 `Bound::Open`으로 진행 중 계단에 들어갔고 HDR 머지는 되돌릴 수 없어, 리포트(`last`로 자름)와 같은 숫자를 낼 수 없다. 판정을 멈추면 기록된 정지 결정이 그 계단들에 기대지 않으므로 「실행 중 판정 = 리포트 판정」이 기록 범위에서 유지된다. 리포트는 그 계단들을 a의 `Upto(last)` 규칙대로 판정한다(동결 뒤 계단의 실행 중 표시는 c §8 「판정 중단 — 부하기 데이터 소진」). 시간 기준 완결(수위 ≥ 끝−1)은 자연 종료라 해당 없음.
- **계단 완결에 「스케줄 증거」 추가** (리뷰 U1 — 소진 뒤 end-phase 보고 전 완료 꼬리 동안 수위만 오르는 틈): 워커 w에서 계단 i 완결 = 수위 조건 **그리고** (`max_scheduled(w) ≥ hi_i(w) − 1` — 그 측정 구간 마지막 초 이후에 도착을 만든 적이 있음, launched > 0 ∨ dropped > 0 — **또는** 그 워커의 계단 i 배정 목표가 0). 몫 ≥ 1 req/s인 워커는 유지 구간에서 매초 도착을 만들므로(간격 ≤ 1초) 정상 실행 중엔 판정을 늦추지 않고, 소진된 워커는 이 조건을 영영 못 채워 end-phase 보고(→ 동결)까지 그 계단이 미완결로 남는다. 워커별 배정 목표는 coordinator가 워커별 profile을 만들 때 아는 값(`reduce_pool_profile`·`shard_split`)을 감시에 넘긴다.
- **계단 판정은 한 계단씩**: 늦던 워커가 따라잡아 한 배치로 여러 계단이 완결되면, 완결 순서대로 계단마다 `saturation_stop`을 돌리고 첫 정지에서 멈춘다. saturation 기록은 정의상 `judged_through = decided_step`(리뷰 R3 — first_fail이 k+1까지 판정에 넣어 「포화 확인 못 함」을 잃지 않게).
- 늦는 워커는 **기다린다**(반쪽 데이터로 판정하지 않음). 끊긴 워커 = 기존 fail-fast. 연결은 됐지만 멈춘 워커(G1) = 기존 backstop(계획 시간 + 120초)이 run을 실패시킨다.
- **감시 보류 (버퍼 상한 하나로)**: 즉시 정지용 초 버퍼(아직 완결 안 된 절대 초들)가 **30초 분량**을 넘으면 가장 오래된 초부터 버리고 그 초를 「보류」로 센다(판정 없음). 등록이 덜 된 동안(최대 60초 등록 기한)·워커 하나가 늦는 동안 모두 같은 규칙. 시작 시각을 아직 안 보낸 워커의 보류 행 버퍼도 같은 30초 상한(넘으면 버리고 `warn!`). 계단 판정은 정수 계수라 계속 쌓는다. 【내 판단】 메모리 상한 — 늦는 워커를 무한정 버퍼링하지 않는다.
- **보류 초 집계**: 감시가 run 엔트리(`RunWorkers`)의 공유 카운터(잠금 아래 `u32`)에 보류 초를 더한다. finalize는 `record_phase`의 classify 잠금 구간에서 그 값을 읽는다(§4.6).
- **중복 제거 (상수 메모리)**: 엔진은 초마다 한 번만 보내고 재연결은 run 실패라, 워커별 「이전 배치까지 받은 최대 초」보다 이전 초의 행은 버린다(한 배치 안의 여러 초는 모두 받음) — DB의 첫 값 유지와 같은 결과를 run 길이와 무관한 메모리로.
- 메모리: 살아 있는 HDR = 초 버퍼(≤ 30초) + 아직 모든 워커가 끝내지 않은 계단의 계단 HDR(≤ 30초가 걸치는 계단 수 + 1). 완결 계단은 `StepNumbers`만 남긴다. → **run 길이와 무관한 상한**.

### 4.5 감시 작업·수신 경로 (성능 핵심)

- 감시 객체는 **계단 run이고 `auto_stop`의 칸이 하나라도 켜져 있을 때만** 생긴다(b). c가 「계단 run이면 항상」으로 넓힌다(§8).
- 수신 경로 추가 비용: `ingest_metrics`가 이미 배치마다 잡는 `runs` 잠금 구간에서 감시 송신자를 꺼내고(추가 잠금 0), DB 쓰기 뒤 **배치를 소유권째 무제한 채널로 send**(`WorkerPayload::MetricBatch(batch)` 가지가 배치를 소유 — 추가 HDR 복사 0, 막힘·버림 없음). 계단 아닌 run의 추가 비용 = `Option` 확인 한 번.
- HDR 디코드·머지·판정은 감시 작업(별도 tokio task)에서. 큐 길이는 계측해 §7에서 본다.
- **정지 실행은 반드시 coordinator 메서드 경유**: `CoordinatorState::auto_stop(run_id, record)`가 **한 잠금 블록 안에서** `abort_requested = true`·`auto_stop = Some(record)`를 쓰고 송신자를 복사한 뒤, 잠금 밖에서 `fan_out_abort`(사유 `"auto stop: …"`). 송신 전에 플래그가 서 있어야 한다(기존 `abort_flag_set_before_sends` 불변식). 감시가 `fan_out_abort`를 직접 부르지 않는다.
- 감시 작업은 run finalize(`rw.done`)와 함께 끝난다.

### 4.6 run 종료·영속

- **외부 중단 플래그**: `abort()`(사용자 중단·데스크톱 종료·모드 전환 — 모든 외부 정지)가 `external_abort = true`를 세운다.
- **자동 정지 run은 모든 워커가 끝날 때까지 finalize를 미룬다**: 지금은 첫 워커의 `Aborted`가 run을 finalize·제거한다(`record_phase`). `rw.auto_stop`이 있으면 워커의 `Aborted`/`Completed`는 그 워커 상태만 기록하고, **모든 워커가 end-phase가 됐을 때** finalize한다 — 형제 워커의 마지막 flush(각 워커는 RunStatus 전에 자기 마지막 flush를 보냄)가 리포트·verdict에 다 들어가게. **이 「전원 end-phase」 트리거는 `external_abort`와 무관하게 유지**한다(플래그는 결과만 정한다) — 미룬 뒤 외부 중단이 오고 남은 워커가 자연 `Completed`를 보내면, 지금 Completed 게이트(전원 Completed)도 Aborted 경로도 발동하지 않아 backstop까지 매달리는 구멍을 막는다(리뷰 R1). 외부 중단이 미룸 시작 전에 왔으면(`auto_stop` 없음) 지금 경로 그대로. `Failed`가 섞이면 지금처럼 fail-fast. 워커 끊김·backstop도 지금 그대로.
- `done` 취소(watchdog 정지)도 즉시가 아니라 이 미룬 finalize 시점으로 옮긴다(지금은 `Aborted` 가지가 바로 취소). `worker_disconnected`는 이미 end-phase를 보고한 워커를 끝난 것으로 다루므로 대기 중 스트림이 닫혀도 그 워커를 잃지 않는다; `pool_mark_finished`는 run finalize와 무관해 영향 없음(리뷰 확인).
- finalize 결과:
  - 모든 워커 `Completed`(중단 신호가 늦어 다 끝났거나 정지가 없었던 경우) → 일반 Completed. 기록 = `stop: null`이고, **보류 초 > 0일 때만** 기록을 저장(즉시 정지가 일부 시간 동작하지 않았음을 알림).
  - 하나라도 `Aborted`(자동 정지가 효과를 냄) → 기록 `stop` 채움.
  - 두 경우 모두 기록을 쓸 때는 **status와 한 UPDATE로**: `UPDATE runs SET status='completed', ended_at=?, auto_stop_json=? WHERE id=? AND status IN ('pending','running')` → **바뀐 행이 1개일 때만** 기존 Completed와 같은 verdict 배지 영속(경합한 `mark_aborted` 뒤 aborted run에 배지가 붙지 않게). 기록이 없으면 지금 Completed 경로 그대로. 【참고】 지금 Completed 경로도 `set_status`(반환 없음) 뒤 `set_verdict`가 무조건이라 같은 틈이 있다(선재) — b는 새 경로만 막고 선재 틈은 roadmap §B에 기록.
  - `external_abort`가 섰으면(자동 정지 전이든 뒤든) → 지금처럼 `aborted`.
- `abort_run`의 무조건 `mark_aborted`는 그대로. 그래서 경합으로 `aborted` 행에 기록이 남을 수 있다 → **규칙: `auto_stop_json`은 status가 `completed`일 때만 의미가 있다.** API·리포트는 그 외 status에서 기록을 싣지 않는다.
- 저장: **migration 0025** `runs.auto_stop_json TEXT NULL`(멱등 ALTER — `/new-migration`). 기존 행 NULL.
- 기록(`AutoStopRecord`, 직렬화 = 와이어):

```json
{ "stop": {
    "kind": "saturation" | "emergency",
    "mode": "two_fails" | "first_fail" | null,
    "failed_steps": [6, 7],          // saturation만, 아니면 []
    "decided_step": 7,               // saturation: 판정 계단 / emergency: 마지막 나쁜 초가 속한 계단
    "judged_through": 7,             // 결정 순간 모든 워커에서 완결된 마지막 계단(없으면 -1) — 리포트 §5.1 강제 경계
    "phase": "ramp" | "discard" | "measure" | null,  // emergency만
    "decided_at_ms": 1763443838900,  // 감시가 정지를 결정한 시각
    "stopped_at_ms": 1763443838920,  // 중단 신호를 보낸 시각
    "emergency": { "max_error_rate": 0.12, "max_p99_us": 3100000, "seconds": 3,
                   "error_hit": true, "p99_hit": false } | null,
    "slot_limited": false } | null,
  "suspended_seconds": 0 }
```

- 저장 조건: `stop`이 있거나 `suspended_seconds > 0`. (`stop: null` + 보류만 있으면 상태는 일반 완료이고 리포트에 보류 안내만.) `suspended_seconds`의 출처는 §4.4 공유 카운터.
- `RunResponse`에 `auto_stop`(위 객체, status `completed`이고 값이 있을 때만; 아니면 키 생략).
- 컨트롤러 재시작 중 진행 run은 기존처럼 통째 `failed`.

## 5. 리포트·내보내기 (b)

### 5.1 판정 입력 — 실행 중과 같게

자동 정지 run의 리포트는 `judge`에 넣기 전에 **기록의 `judged_through` 뒤 계단을 모두 `measured=false`로 강제**한다(두 정지 종류 공통). 감시가 결정 순간 실제로 판정에 쓴 경계를 그대로 쓰는 것이다 — 시작 시각이 어긋난 워커가 즉시 정지 순간 아직 앞 계단 측정 중이었으면 그 계단도 판정 밖이고, 다음 계단 측정 초가 쌓였어도(정지 지연·t0 차이, 상승 1초·버림 0초 설정) 판정에 들어가지 않는다 → 실행 중 감시가 본 판정 = 리포트 판정. saturation에선 `judged_through = decided_step`이고, `first_fail`의 `unconfirmed` 머리말도 이 강제로 성립한다. 표시 상태: `judged_through` 뒤이면서 `emergency_stopped`·`partial`·`skipped`가 아닌 계단(즉시 정지 순간 아직 완결 안 된 앞 계단)은 a의 `not_measured`(「측정 안 됨」, 숫자 「—」).

### 5.2 행 상태

`StepState`에 가산(자동 정지 기록이 있을 때만 쓰임; 숫자 칸 「—」, a의 `shown` 규칙 확장):
- `emergency_stopped` — 즉시 정지가 일어난 계단(측정 완결 전).
- `partial` — 판정 계단 뒤, 정지 시각 전에 시작한 계단: 「일부 실행 — 상승 2초 진입 후 정지」(가장 이른 t0 워커 기준 시작 시각 → `stopped_at_ms`까지 초, 구간 이름).
- `skipped` — 정지 시각 전에 시작하지 않은 계단: 「실행 안 함」.

a의 `explains`(버림 설명)는 세 상태를 「포화 뒤」와 같게 취급(설명됨).

### 5.3 정지 줄 (a 판정 머리말은 그대로, 그 위 노랑 줄 하나)

- two_fails: 「8계단(800 req/s) 판정 뒤 자동 정지 — 7·8계단 연속 실패 · 9계단 상승 2초 진입 후 멈춤 · 10계단 실행 안 함 · 14:10:40」
- first_fail: 「7계단(700) 판정 뒤 자동 정지 — 7계단 실패, 첫 실패에서 정지(포화 확인 못 함) · 8계단 상승 1초 진입 후 멈춤 · 9–10계단 실행 안 함 · 14:09:35」
- emergency: 「5계단(500) 상승 중 즉시 정지 — 오류율 12% 3초 연속 · 마지막 정상 계단 4(400) · 6–10계단 실행 안 함 · 14:06:12」
- 슬롯 부족 의심이 사유에 섞이면 「(슬롯 부족 의심 — 부하기 한계일 수 있음)」, 실행 안 함 계단이 4개 이상이면 범위(「9–20계단」), 일부 실행이 없으면 그 구절 생략.
- 보류만 있으면 회색 줄 「자동 정지 감시가 N초 보류됐습니다(부하기 등록·데이터 지연) — 그동안 즉시 정지는 동작하지 않았습니다」.
- 문구는 ko.ts 경유(ADR-0035), 보고서에 찍히므로 보고서 문체(working-rules §8).

### 5.4 내보내기·표지

- CSV 머리말 줄·XLSX `Stairs` 시트·인쇄(표준·요약): 같은 정지 줄 + 같은 행 상태 문구. 계단 아닌 run은 a처럼 출력 없음.
- run 상세 머리 상태 배지 옆, 시나리오 run 목록 행에 「자동 정지」 작은 표지(US1 — 완료 run이 설정 계단을 다 돌지 않음).
- 인쇄 verdict(`ui/src/print/verdict.ts`)는 status가 `completed`라 판정한다(중단 run의 「판정 안 함」이 아님).

### 5.5 UI 스키마

- `StairConfigSchema`는 `.strict()`이고 `ProfileSchema.stair`·`RunSchema`·`StairReportSchema.config` 안에 있다(`ui/src/api/schemas.ts`) → `auto_stop: AutoStopConfigSchema.optional()` 추가 필수(안 하면 새 계단 run 목록·상세 파싱 실패). 안의 `saturation`·`emergency`는 `.nullable()`(서버가 `null`을 보냄).
- `RunSchema.auto_stop`·`StairReportSchema.auto_stop`은 `.optional()`(서버가 키 생략), 기록 안 `mode`·`phase`·`emergency`·`stop`은 `.nullable()`. `ui/CLAUDE.md` `.nullish()` 함정 — 라이브 run 1회로 확인.

## 6. 실행 창 (b)

```
┌ 자동 정지 ───────────────────────────────────────────────┐
│ ☑ 포화가 확정되면 남은 계단을 실행하지 않음                  │
│     (●) 연속 두 계단 실패 시 (튄 계단은 넘김)                │
│     ( ) 첫 실패에서 바로 정지                                │
│        ⚠ 한 번 튄 계단으로도 멈출 수 있고, 리포트는           │
│          「포화 확인 못 함」으로 남습니다.   ← first_fail일 때만 │
│ ☑ 즉시 정지 — 오류율 [5] % 초과 또는 p99 [2000] ms 초과가 [3] 초 연속 │
│     (초당 완료 [20]개 이상인 초만 판정)                       │
│     ⓘ 상승·버림 구간도 감시합니다. 부하기 데이터가 1–2초 늦게   │
│       오므로 실제 정지는 기준을 넘은 뒤 몇 초 걸립니다.          │
│ ⚠ 자동 정지가 걸리면 설정한 계단을 다 돌지 않습니다. 판정한     │
│   다음 계단에 몇 초 들어간 뒤 멈출 수 있습니다. 실제로 준 부하와 │
│   멈춘 이유는 리포트 맨 위에 남습니다.                          │
└──────────────────────────────────────────────────────────┘
```

- 「계단」 탭 안, a의 판정 기준 접기 아래. 【내 판단】 **기본 펼침** — 기본 켜짐 보호 장치라 접히면 켜졌는지 안 보인다(UI 접힘 선호의 예외: 선택 섹션이 아님). 두 칸 다 끄면 마지막 경고 줄 숨김.
- 숫자 칸 오류는 a 절대 p99 상한과 같은 방식(빨간 오류·실행 막음).
- 스케줄 폼 계단 입력에도 같은 상자(같은 컴포넌트). 단순 모드 읽기 전용 카드에 한 줄 「자동 정지: 연속 두 계단 실패 · 즉시 정지 5%/2000 ms/3초」.
- 실행 요약 줄(a)은 무변경.

## 7. 성능 — 저하 없음 증명 (US5, b 완료 조건)

**원칙**: 엔진·워커 무변경이라 부하 정확도는 구조적으로 보존. 컨트롤러 추가 비용을 잰다. 기준 미달이면 머지하지 않고 원인을 고친다(「수용 한계」로 넘기지 않음).

1. **감시 처리 마이크로 측정**(진짜 비용이 있는 곳): 최악 배치(시나리오 스텝 16개 window + open-loop 초 2개, 실제 크기 HDR)를 워커 4대 × 50계단 run 상태의 감시 작업에 넣어 **배치당 처리 시간** p50/p99(테스트 바이너리 안 `Instant` 반복, `#[ignore]` 성능 테스트). 기준: p99 < 배치 간격(500 ms)의 1% = 5 ms. 수신 경로 쪽은 채널 send 한 번이라 별도 측정 대신 코드 리뷰로 「잠금 추가 0·복사 0」 확인.
2. **종단 A/B**: `scripts/bench-throughput.sh`에 계단 프로필(open-loop) 옵션. 같은 머신·응답기에서 ① master ② b 자동 정지 끔 ③ b 켬 **각 5회**. ③은 정지가 걸리지 않게 계단 목표 최댓값을 응답기 측정 용량의 약 80%로 두고(두 정지 모두 켠 채, 즉시 정지 기준은 높게) — 정지가 걸려 run이 짧아지면 비교가 안 된다. 기준(모두 ①의 5회 최대−최소 = 잡음 폭 대비): 계단별 달성 RPS 평균 차이 ≤ 잡음 폭 · 부하기 CPU 평균 차이 ≤ 잡음 폭 · 컨트롤러 CPU 평균 증가 ≤ 잡음 폭 **그리고** ≤ 2%p(`ps` 1초 샘플 평균) · 감시 큐 길이 최대 ≤ 워커 수 × 2.
3. **최악 조건 메모리**: 50계단 × 워커 4 × 위 ③과 같은 80% 상한 RPS × 계단 유지 60초(약 50분). 컨트롤러 RSS를 **finalize 전까지** 1분 간격으로 기록 — 계단 진행과 무관하게 평평한지(§4.4 상한). finalize 뒤 리포트 빌드의 일시 증가는 제외(a §B68 N3, 기존).
4. 결과 표를 build-log에. 측정 전 다른 세션 cargo 빌드 없는지 확인(`syspolicyd`·`XprotectService` CPU).

## 8. c 슬라이스 — 실행 중 패널 (b 머지 뒤)

- 감시 객체를 **계단 run이면 항상** 만든다(자동 정지를 끈 계단 run도 진행이 보이게; 정지 결정은 켜진 칸만).
- `RunResponse.auto_stop_live`(status running이고 감시가 있을 때만, 아니면 키 생략) = `{ current_step, phase, step_states: [ok|fail|spike|measuring|pending|partial|skipped], last_ok_step, next_fail_stops: bool, emergency_now: { error_rate, p99_us, bad_streak, held: bool } | null, suspended: bool, stop: StopInfo | null }` — 계단 최대 50 + 숫자 몇 개. 감시가 판정할 때만 갱신(`watch` 채널 — 핸들러는 마지막 값 복사). UI는 이미 run을 1초마다 폴링(`useRun`).
- 화면(실행 중 차트 위, 계단 run만):

```
계단 6/10 (600 req/s) 측정 중 · 1–4 정상 · 5 실패 → 6이 실패하면 자동 정지
[1✓][2✓][3✓][4✓][5✗][6…][7 ][8 ][9 ][10 ]
즉시 정지 감시: 오류율 0.2% · p99 340 ms  (기준 5% · 2000 ms 초과, 3초 연속)  나쁜 초 0
```

  칩 색 = a 판정색. 조기 종료 워커로 포화 판정이 동결된 뒤의 계단은 「판정 중단 — 부하기 데이터 소진」(§4.4). 50계단이면 줄바꿈(가로 스크롤 금지 — 극단값 rect 검증). 정지 결정 즉시 노랑 줄로 사유 표시. 보류·판정 보류 상태도 표시. 자동 정지를 끈 run은 예고·즉시 정지 줄 없이 칩만.
- **ADR-0059** 「계단 자동 정지: 수신 흐름 감시 + 실행 중 판정 요약」 — ADR-0051(이미 폴링 중인 windows의 클라 표시)을 넘어 서버가 실행 중 계산한 p99·판정을 기존 1초 폴링에 싣는다; ADR-0009 비목표(WebSocket/SSE·push·라이브 대시보드)는 유지.
- c도 §7의 2·3을 「켬」 조건으로 재측정(감시가 계단 run 전부로 넓어지므로).

## 9. 함정·불변식 체크리스트 (b plan이 task로 옮길 것)

1. 엔진·워커·worker-core·proto diff 0.
2. 계단 아닌 run: `RunResponse`·리포트 JSON·CSV·XLSX·인쇄 바이트 동일 테스트.
3. 누적기: a 리포트 테스트 무수정 통과 + 동등성(섞기) 테스트 + 되돌려 확인 2개(§4.3).
4. 정지 규칙 표 테스트: two_fails(연속 두 실패·튐 뒤 계속·첫 계단 실패 뒤 계단 1 정상→계속·그 뒤 After 쌍→정지·마지막 계단 완결=정지 없음) · first_fail(첫 계단 실패 포함) · 슬롯 부족 사유 · 즉시 정지(연속·보류 초 건너뜀·`min_requests` 경계·두 조건 동시·기준과 같음=정상).
5. 데이터 완결: 워커 2개 중 하나 늦으면 판정 안 함 → 도착 뒤 판정; 초 버퍼 30초 초과 → 보류 집계·버퍼 해제·재개; 시작 시각이 어긋난 워커들의 run 꼬리(먼저 끝난 워커 = 완결, `−1` 경계값)에서 판정 계속·거짓 보류 없음; end-phase 보고 워커 = 완결; 조기 종료 → 포화 판정 동결(워커 2개 중 하나가 데이터셋 소진으로 조기 종료하며 **진행 중 계단을 절반 넘게 측정했고 소진 뒤 완료 꼬리가 몇 초 있는** fixture → 그 뒤 연속 실패처럼 보여도 포화 정지 없음, 즉시 정지는 동작; 동결을 지우면 거짓 포화 정지로 RED; 꼬리가 계단 측정 구간 끝을 넘고 end-phase 전에 꼬리 배치가 오는 변형 → 「스케줄 증거」 규칙을 지우면 RED · 몫 0 워커는 증거 없이 완결); 한 배치에 여러 계단 완결 → 계단별 순서 판정. **합성 배치 시각으로 구동**(감시 규칙은 데이터 초 기준이라 가상 시간 불필요) — `tokio::time::pause()`는 DB를 쓰는 테스트(§9.6 종료 테스트 포함)에 쓰지 않는다(sqlx `PoolTimedOut`, `crates/controller/CLAUDE.md`). 엔진 수위 성질은 컨트롤러 쪽 통합 테스트(§4.4, `run_scenario_open_loop` 공개 진입점).
6. 종료: 자동 정지 → 모든 워커 end-phase까지 대기(`done` 취소도 그때) → completed + 기록(한 UPDATE, 바뀐 행 1개일 때만 verdict) · 외부 중단 먼저/나중 → aborted · 중단 신호 전 전원 Completed → `stop: null`(보류 초 있으면만 기록) · Completed/Aborted 혼합 → 기록 · Failed 혼합 → failed · 형제 워커 마지막 flush가 리포트에 포함 · 보류만 있던 자연 완료 run → 기록 저장·회색 안내 · **자동 정지 → 워커 A Aborted(미룸) → 외부 중단 → 워커 B 자연 Completed → 즉시 finalize, aborted**(R1).
7. `auto_stop()` 메서드가 한 잠금 블록에서 플래그 → 송신(감시의 `fan_out_abort` 직접 호출 없음, grep 게이트).
8. 리포트 §5.1 강제: `judged_through` 뒤 계단이 측정 초를 가져도 `judge` 입력 `measured=false`(상승 1초·버림 0초 fixture + 워커 시작 시각 몇 초 어긋난 즉시 정지 fixture — 늦은 워커의 앞 계단이 반 넘게 측정됐어도 판정 밖).
9. migration 0025 멱등(`crates/controller/CLAUDE.md` ALTER 멱등).
10. Zod §5.5 — `StairConfigSchema` strict에 `auto_stop` 추가, 라이브 run 1회로 목록·상세·리포트 파싱 확인.
11. ko.ts 경유, 보고서 문체.

## 10. 검증 (라이브 — b의 US 척추)

| US | 절차 | 통과 신호 |
|---|---|---|
| US1 | 용량 제한 응답기로 6계단 중 4계단에서 무너지게 → two_fails | 5계단 측정 끝 뒤 수 초 안 RPS 0 · 상태 완료 · 정지 줄(6계단 「일부 실행 — 상승 N초」 실측과 일치) · 상세·목록 표지 · CSV/XLSX/인쇄 같은 줄 |
| US2 | 지연 조절 응답기를 run 중 상승 구간에 3초 지연으로 | 기준 넘은 뒤 수 초 안 정지 · 「상승 중 즉시 정지」 · 그 계단 「—」 · 시작 직후(첫 계단 상승) 거짓 정지 없음 |
| US4 | first_fail로 US1 반복 | 경고 표시 · 4계단 판정 뒤 정지 · 「포화 확인 못 함」 |
| US5 | §7 1–3 | 기준 충족 표 |

추가: 진입 화면 전부(실행 창·스케줄 폼·프리셋 저장→불러오기·다시 실행·단순 모드 카드) 설정 유지 · 워커 2개 run 정지와 형제 flush 포함 · 사용자 중단 경합 · 콘솔 오류 0.

## 11. 알려진 한계 (수용)

- 즉시 정지는 **완료된 요청**으로 판단한다. 대상이 완전히 멈추면 HTTP 타임아웃(기본 30초)까지 안 보인다. 그동안 open-loop 슬롯(`max_in_flight`)이 동시 요청을 묶고, 계단 판정이 달성률·dropped로 잡는다.
- 초당 완료 < `min_requests`인 아주 낮은 목표(기본 20 req/s 미만)에서는 즉시 정지가 사실상 동작하지 않는다(사용자 승인 — 계단 판정이 대신).
- 정지까지 지연 = 나쁜 초 N + 데이터 도착(0.5–2초) + 가장 늦은 워커 대기 + 중단 신호 전파. 그 사이 다음 계단 상승에 몇 초 들어간다(정지 줄에 표시).
- `two_fails`는 처음 실패한 계단 뒤 한 계단을 더 돈다 — `first_fail`이 대안.
- 첫 계단 실패 뒤 계단 1이 정상이면 기준 계단이 없어 이후 p99 배수 규칙이 적용되지 않는다(a와 같음) — 이후 정지는 달성·dropped·오류·절대 p99 상한 사유로만.
- 30초 넘게 늦는 워커가 있으면 즉시 정지가 보류된다(리포트에 표시).
- 부하기 하나가 데이터셋 소진 등으로 일찍 끝나면 그 뒤로 포화 정지는 동작하지 않는다(즉시 정지는 동작) — 설정한 부하가 아니라서 계단 판정 근거가 없다.
- 감시는 큐를 비동기로 처리하므로 finalize가 보류 카운터를 읽는 순간 마지막 배치 몇 개가 아직 처리 전일 수 있다 — 기록된 보류 초가 실제보다 약간 적을 수 있다(run 끝 몇 초 한정).
- 자동 정지 뒤 형제 워커가 연결된 채 멈추면(G1) run은 남은 **계획 시간 + 120초**까지 `running`으로 남다가 기존 backstop이 실패시킨다 — 드문 경우라 backstop 단축은 하지 않는다.
- run 전체에서 도착을 한 번도 만들지 않는 워커가 있는 run(몫 0 분할)에서는 실행 중 판정과 리포트의 측정 초가 1 차이 날 수 있다(§4.3) — 판정은 측정 초가 `measured` 경계(측정 구간의 절반)에 정확히 걸릴 때만 달라진다.

## 부록: 근거 명령 (사실 주장 재실행용)

```
grep -n "pub fn judge\|pub fn step_ok\|pub fn build_stair_report\|fn measure_window\|achieved +=" crates/controller/src/stair.rs
grep -n "async fn ingest_metrics\|WorkerPayload::MetricBatch(batch)\|plausible" crates/controller/src/grpc/coordinator.rs
grep -n "pub async fn record_phase\|g.remove(run_id)\|pub async fn abort(" crates/controller/src/grpc/coordinator.rs
grep -rn "coord.abort(" crates/controller/src                                  # 사용자·데스크톱 종료·모드 전환
grep -n "forwarder.await\|RunStatus {" crates/worker/src/lib.rs                # 마지막 flush → RunStatus 순
grep -n "pub async fn abort_run" -A20 crates/controller/src/api/runs.rs        # 무조건 mark_aborted
grep -n "pub async fn mark_aborted\b\|pub async fn set_status" crates/controller/src/store/runs.rs
grep -n "ON CONFLICT" crates/controller/src/store/open_loop.rs crates/controller/src/store/metrics.rs
ls crates/controller/src/store/migrations | tail -1                            # 0024 → 다음 0025
ls docs/adr | tail -2                                                          # 0058 → 다음 0059
grep -n "refetchInterval" ui/src/api/hooks.ts                                  # useRun 1s · report false
sed -n 70,84p ui/src/api/schemas.ts                                            # StairConfigSchema .strict()
grep -n "drain_completed" crates/engine/src/runner.rs crates/engine/src/open_loop_counters.rs
grep -n "fn default_http_timeout" -A2 crates/controller/src/store/runs.rs        # 30
grep -n '"aborted"' ui/src/print/verdict.ts                                    # 중단 = 판정 안 함
```
