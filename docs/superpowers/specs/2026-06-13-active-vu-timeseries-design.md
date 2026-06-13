# Active-VU 초당 시계열 — 설계

- **날짜**: 2026-06-13
- **출처**: `docs/roadmap.md` §B9 "active-VU per-second 시계열" (closed-loop VU 곡선 / ADR-0037 후속 연기 항목)
- **ADR**: 신규 불필요 — ADR-0037(closed-loop VU 곡선) 범위 내 additive 와이어 확장.
- **성격**: 리포팅/배관 슬라이스. **핫패스(요청당) 계측 아님** → 부하 생성 처리량(RPS) 무회귀.

## 1. 문제 / 동기

closed-loop VU 곡선(`vu_stages`, ADR-0037)은 시간에 따라 active VU 수를 piecewise-linear로 변화시킨다. 그러나 리포트에는 그 곡선이 **실제로 어떻게 실현됐는지**가 직접 보이지 않는다 — 현재는 per-second RPS가 간접 프록시일 뿐이다. 부하 도구의 핵심 질문 **"엔진이 내가 설계한 VU 곡선을 실제로 따라갔나?"** 에 리포트가 직접 답하지 못한다.

이 슬라이스는 곡선 run의 리포트에 **초당 active-VU 시계열**(목표 vs 실제 두 줄)을 추가해 그 갭을 메운다.

## 2. 범위

- **In**: closed-loop VU 곡선(`run_scenario_vu_curve`) run에 한해 초당 `{desired, actual}` 시계열을 수집·영속·리포트·차트.
- **Out (byte-identical 불변식)**: 비-곡선 run(고정 closed-loop `run_scenario`, open-loop `run_scenario_open_loop`)은 이 시리즈를 **전혀 emit하지 않음** → 와이어·리포트·DB 모두 pre-feature와 동일.
- **포워드 호환(B)**: 와이어 전체(aggregator 메서드 → `MetricFlush` 벡터 → proto → 테이블 → `ReportJson` → UI 차트)를 **모드 무관 "초당 active-VU 시계열"** 로 둔다. 고정 closed-loop(B)로 확장할 때는 `run_scenario`에 초당 샘플러 하나를 더해 같은 `Aggregator::record_active_vu(...)`를 호출하면 끝 — 다운스트림 0 변경.

### 비목표 (연기)

- CSV/XLSX export에 active-VU 열 추가 (현재 미포함).
- 멀티워커 곡선 샤딩 시 per-worker active-VU 머지(worker_id + read-time SUM) — 곡선은 단일워커 v1이므로 B9의 곡선 샤딩 슬라이스에서 함께.
- 고정 closed-loop(B) 샘플러 — 위 "포워드 호환" 이음새만 비워둠.
- active-VU 기반 SLO criteria.
- active-VU 곡선을 run 비교 뷰에 오버레이.

## 3. 데이터 모델 & 의미

초당 1점, 점마다 `{ ts_second, desired, actual }`:

- **`desired`** = 슈퍼바이저가 그 초에 명령한 목표 active VU 수 = `round(rate_at(vu_stages, elapsed)).clamp(0, max_vus)`. 슈퍼바이저가 이미 매 250ms 틱마다 계산하는 값. **곡선이 명령한 의도(intent)**.
- **`actual`** = 그 초의 샘플 instant에 slab에서 활성 토큰(`Some(CancellationToken)`)을 가진 VU 수 = **실제로 iteration을 도는 VU**. park/retire 지연(긴 iteration·graceful ramp-down)이 자연히 드러난다.
- 두 값 모두 `u32`(VU 수). active-VU는 **run-level 게이지**(스텝과 무관)라 step별 키인 기존 `windows`(`(ts_second, step_id)`)에 얹을 수 없다 → **독립 시계열**로 나란히 둔다.

`ts_second`는 `aggregator`의 `windows`와 동일한 wall-clock 초 버킷(`current_second()`)을 쓴다 → 리포트에서 RPS 시계열과 X축이 정렬된다.

## 4. 엔진 (`crates/engine`)

### 4.1 샘플링 — `run_scenario_vu_curve`만

- 슈퍼바이저 루프(`runner.rs`, 250ms tick, deadline까지)가 **1초 경계마다 한 번** `agg.record_active_vu(ts_second, desired, actual)`를 호출한다.
  - `desired`: 그 초의 `rate_at` 평가값(슈퍼바이저가 이미 가지고 있음).
  - `actual`: slab 뮤텍스를 **1회/초** 락한 뒤 `slab.iter().flatten().count()`. (immediate 모드는 매 틱 이미 락하므로 신규 락은 graceful 모드에서만 초당 1회 — 모두 핫패스 밖. 요청당 추가 작업 0 → 처리량 무회귀.)
  - 샘플 cadence: 슈퍼바이저는 250ms로 돌지만 같은 `ts_second`에 대해서는 한 번만 기록(직전 기록한 초를 추적해 1초당 1점).
- 샘플링 구간은 `[started_at, deadline)` — 슈퍼바이저 루프가 deadline에서 break하므로 graceful drain 꼬리(deadline 후 join 대기)는 비포함. windows 구간과 일관.

### 4.2 `Aggregator` (`aggregator.rs`)

- 신규 필드: `active_vu: BTreeMap<i64, (u32, u32)>` (key=`ts_second`, val=`(desired, actual)`). HDR가 아닌 scalar라 merge 문제 없음.
- `pub fn record_active_vu(&mut self, ts_second: i64, desired: u32, actual: u32)` — 해당 초의 엔트리를 set(keep-last; 같은 초는 한 번만 기록되지만 방어적으로 덮어쓰기).
- `pub fn drain_active_vu(&mut self) -> Vec<ActiveVuSample>` — `std::mem::take` 후 `Vec`로 변환(ts_second 오름차순). `drain_branch_deltas`/`drain_group_deltas` 패턴과 동형.
- 신규 타입 `pub struct ActiveVuSample { pub ts_second: i64, pub desired: u32, pub actual: u32 }`(engine).

### 4.3 `MetricFlush` (`runner.rs`)

- 7번째 벡터 `pub active_vu_samples: Vec<ActiveVuSample>` 추가.
- **struct 리터럴 6곳 전부 갱신**(컴파일러 강제): closed periodic/final, open periodic/final, vu-curve periodic/final. **곡선 2곳만** `agg.drain_active_vu()`로 실제 drain, 나머지 4곳은 `active_vu_samples: vec![]`.
- **send-guard**: 워커 forwarder의 빈-배치 스킵 가드(`|| !<vec>.is_empty()`)에 곡선 **periodic + final 2곳**만 `|| !active_vu_samples.is_empty()` 추가(active_vu는 곡선만 채우므로 다른 4곳은 불필요 — over-plumbing 회피).
- 드레인은 windows/group_stats처럼 **periodic + final 둘 다**(final-only `dropped`의 "open-loop final 무가드" 특례를 새로 만들지 않음 — 버퍼 무한 증가 방지 + 패턴 일관).

## 5. proto / 워커

- `crates/proto/proto/*.proto`:
  - 신규 메시지 `message ActiveVuSample { int64 ts_second = 1; uint32 desired = 2; uint32 actual = 3; }`.
  - `MetricBatch`에 `repeated ActiveVuSample active_vu_samples = 9;` (다음 free 필드 — 현재 phase_stats=8까지 사용).
- 워커(`crates/worker`): `MetricFlush.active_vu_samples` → `MetricBatch.active_vu_samples`로 그대로 forward(엔진 타입 → proto 타입 변환). `MetricBatch { … }` struct 리터럴(워커 `main.rs`)에 신규 필드 명시(prost exhaustive 함정).
- proto enum/필드 추가는 backward-compat 안전(controller+worker 동시 배포).

## 6. 컨트롤러 (`crates/controller`)

### 6.1 마이그레이션 0016 + 저장

- 신규 테이블 **`run_active_vu_metrics`**:
  ```sql
  CREATE TABLE IF NOT EXISTS run_active_vu_metrics (
    run_id     TEXT    NOT NULL,
    ts_second  INTEGER NOT NULL,
    desired    INTEGER NOT NULL,
    actual     INTEGER NOT NULL,
    PRIMARY KEY (run_id, ts_second)
  );
  ```
  - `MIGRATION_SQL_0016` const + `connect()`에 `execute` 라인 추가. `CREATE TABLE IF NOT EXISTS`라 멱등(ALTER 가드 불필요). **리넘버 함정 주의**: const 개수 == execute 개수 교차검증(`grep -c MIGRATION_SQL`).
  - **worker_id 없음**: 곡선은 단일워커 v1(`max(vu_stages[].target) > capacity` → 400 거부). 멀티워커 곡선 샤딩(B9 연기) 시 worker_id 추가.
- ingest(`ingest_metrics`): `batch.active_vu_samples`를 `INSERT INTO run_active_vu_metrics … ON CONFLICT(run_id, ts_second) DO UPDATE SET desired=excluded.desired, actual=excluded.actual`(keep-last; 게이지=완전 스냅샷, 단일워커라 초당 1행이지만 방어적 멱등). `dropped` ingest처럼 `if let Err` 패턴(내부 `warn!`, `?` 금지 — `ingest_metrics`는 `()` 반환).

### 6.2 read + `build_report`

- 신규 read 헬퍼: `run_active_vu(run_id) -> Vec<ActiveVuRow>`(ts_second ORDER BY).
- `build_report`에 **8번째 param** `active_vu: &[ActiveVuRow]` 추가 → `ReportJson.active_vu_series: Vec<ActiveVuSample>`(ts_second 정렬 매핑).
  - **summary/windows/overall/RPS/per_step 절대 미접촉** — 독립 게이지(group_latency/download phase가 summary를 안 건드리는 것과 동형).
  - **모든 call site 8번째 인자 추가**: `api/runs.rs`의 실 경로 + `build_report_for_run` 헬퍼 경로(report JSON·단일 export·비교 export 공유) + `report.rs` 테스트 fixture ~16곳(각 `&[]` 추가, 컴파일러-driven).
- `ReportJson`:
  ```rust
  #[serde(default)]
  pub active_vu_series: Vec<ActiveVuSample>,  // controller 측 ActiveVuSample {ts_second:i64, desired:u32, actual:u32}
  ```
  `#[serde(default)]`라 역직렬화 호환(골든 fixture·기존 run). struct 리터럴(테스트·`export.rs` 픽스처)엔 필드 명시 필요.

## 7. UI (`ui/src`)

- Zod: `ActiveVuSampleSchema = z.object({ ts_second: z.number(), desired: z.number(), actual: z.number() })`, `ReportSchema`에 `activeVuSeries: z.array(ActiveVuSampleSchema).optional()`(또는 `.default([])`) — 서버 빈 배열/absent 흡수(`.nullish()` 계열, S-D 갭 주의).
- 신규 **`ActiveVuChart.tsx`**(Recharts):
  - 두 줄: **목표(desired)** = 점선, **실제(actual)** = 실선.
  - X축 = 상대 초(`ts_second - series[0].ts_second`, 기존 `TimeSeriesChart` 컨벤션 미러), Y축 = VU 수.
  - 단위/축 라벨·범례 한국어.
- `ReportView.tsx`: `activeVuSeries`가 **비어있지 않을 때만** `<section aria-label="활성 VU">`로 렌더(곡선 run에서만 등장). 기존 per-second `TimeSeriesChart` 인근 배치.
- 문구: `ko.ts` 신규 키 — 차트 제목 "활성 VU (시간별)", 범례 "목표"/"실제", HelpTip "목표 = 곡선이 명령한 VU 수, 실제 = 실제로 활성화된 VU 수(park/retire 지연 반영)".

## 8. 불변식 & 회귀 가드

1. **비-곡선 run byte-identical** — `run_scenario`/`run_scenario_open_loop`는 `record_active_vu` 미호출 → `active_vu_samples` 빈 → 테이블 0행 → `ReportJson.active_vu_series` 빈 → UI 차트 미렌더. 엔진·와이어·DB·리포트 전부 pre-feature 동일.
2. **summary 비오염** — active-VU 시리즈는 `summary`/`windows`/`overall`/RPS/per-step에 절대 합산 안 됨(독립 게이지).
3. **처리량 무회귀** — 샘플링은 초당 1회(핫패스 밖). 머지 전 RPS A/B(곡선 run 계측 전후)로 변동 범위 내 확인.
4. **N=1 단일워커** — worker_id 없음. 곡선은 capacity 초과 시 400이라 멀티워커 진입 경로 없음.

## 9. 테스트

- **엔진**: `record_active_vu`/`drain_active_vu` 단위(초당 1점·drain 리셋) + 곡선 run 통합이 `MetricFlush.active_vu_samples`를 emit(desired는 곡선 따라가고 actual > 0) + 비-곡선 run은 빈 시리즈.
- **컨트롤러**: migration 0016 멱등(재연결) + ingest round-trip(`ON CONFLICT` keep-last) + `build_report`가 `active_vu_series` 매핑·summary 비오염.
- **UI**: Zod 파싱(서버 바이트 safeParse) + `ActiveVuChart` RTL(두 줄·상대 X축) + `ReportView` 시리즈 없으면 미렌더.
- **라이브(머지 전 필수)**: controller+worker 띄우고 곡선 run 1회 → 리포트에서 desired 점선/actual 실선 + ramp lag 가시화 확인 + 비-곡선 run에 차트 부재 + 실 `/report`가 `ReportSchema.parse` 통과(S-D 갭 차단) + RPS A/B 처리량 무회귀.

## 10. 파이프라인 요약 (레이어별)

| 레이어 | 변경 |
|---|---|
| 엔진 `aggregator.rs` | `active_vu` 맵 + `record_active_vu`/`drain_active_vu` + `ActiveVuSample` 타입 |
| 엔진 `runner.rs` | 슈퍼바이저 초당 샘플(desired+slab count) + `MetricFlush.active_vu_samples`(6 리터럴 / 2 drain / 2 guard) |
| proto | `ActiveVuSample` 메시지 + `MetricBatch.active_vu_samples = 9` |
| 워커 | `MetricFlush → MetricBatch` forward + struct 리터럴 |
| 컨트롤러 store | migration 0016 `run_active_vu_metrics` + ingest UPSERT + read 헬퍼 |
| 컨트롤러 `report.rs` | `build_report` 8번째 param + `ReportJson.active_vu_series` + 호출부 전부 |
| UI | Zod 스키마 + `ActiveVuChart.tsx` + `ReportView` 슬롯 + `ko.ts` 문구 |

byte-identical 회귀 가드와 함께, 비-곡선 경로는 전부 `vec![]`/빈 배열/미렌더로 흘러간다.
