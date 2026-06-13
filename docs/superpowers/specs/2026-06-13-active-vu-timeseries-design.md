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

`ts_second`는 `aggregator`의 `windows`와 동일한 epoch-초 버킷을 쓴다 → 리포트에서 RPS 시계열과 X축이 정렬된다. **함수**: aggregator의 `current_second()`는 private이므로, vu-curve flusher가 이미 쓰는 동일-모듈 헬퍼 **`chrono_second()`**(`runner.rs:1361`, byte-identical epoch-초 구현; 슈퍼바이저 샘플러도 같은 모듈이라 도달 가능)를 그대로 쓴다.

## 4. 엔진 (`crates/engine`)

### 4.1 샘플링 — `run_scenario_vu_curve`만

- 슈퍼바이저 루프(`runner.rs:731-743`, 250ms tick, deadline까지)가 **1초 경계마다 한 번** `agg.record_active_vu(chrono_second(), desired, actual)`를 호출한다.
  - `desired`: **슈퍼바이저가 그 틱에 이미 계산한 값을 그대로 기록**(`runner.rs:742-743`의 `(rate_at(&stages, elapsed).round() as i64).clamp(0, i64::from(max_vus)) as u32`) — 샘플러가 wall-clock으로 재계산하지 않는다. `elapsed`는 monotonic `Instant` 기반이고 `ts_second`는 epoch-초라 시계가 다르지만, 차트엔 무해(windows도 epoch-초). 즉 샘플은 `(chrono_second(), 이미-계산된-desired, actual)`.
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
- **struct 리터럴 6곳 전부 갱신**(컴파일러 강제, `runner.rs:230,274,711,826,1111,1263`): closed periodic/final, open periodic/final, vu-curve periodic/final. **곡선 2곳만**(`:711`, `:826`) `agg.drain_active_vu()`로 실제 drain, 나머지 4곳은 `active_vu_samples: vec![]`.
- **가드는 두 레이어다 — 둘 다 갱신해야 데이터가 안 샌다(C1 `dropped` 함정과 동형):**
  1. **엔진측 send 조건**(`runner.rs`, MetricFlush를 엔진→워커 채널로 보낼지 결정하는 `if !windows.is_empty() || …`): 곡선 **periodic + final 2곳**(`:705-723`, `:819-835`)에 `|| !active_vu_samples.is_empty()` 추가. (active_vu는 곡선만 채우므로 closed/open 4곳은 불필요 — over-plumbing 회피.)
  2. **워커 forwarder 스킵 가드**(`crates/worker/src/main.rs:332-340`, 받은 배치를 컨트롤러로 forward할지 결정하는 **단일** 가드 — `windows/loop/branch/group/phase` 전부 empty `&& flush.dropped == 0`이면 `continue`): 여기에 **`&& flush.active_vu_samples.is_empty()`** 를 추가한다. **이게 빠지면** rate=0 stage 구간·ramp-down park 꼬리·저처리량 초처럼 windows가 빈데 active_vu만 실린 곡선 flush가 `:339`에서 `continue`로 **silently drop**된다(`dropped`가 같은 가드에 `&& flush.dropped == 0`을 둔 이유와 동일).
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
  - `MIGRATION_SQL_0016` const + `connect()`에 `sqlx::query(MIGRATION_SQL_0016).execute(...)` 라인 추가(0010/0011/0013/0015 메커니즘 그대로). `CREATE TABLE IF NOT EXISTS`라 멱등(ALTER 가드 불필요). **리넘버 함정 주의**(컨트롤러 CLAUDE.md): const를 추가하면 대응 `execute` 라인도 빠짐없이 추가됐는지 눈으로 확인(execute 누락 시 런타임 `no such table`). 단순 `grep -c`는 doc-comment의 `MIGRATION_SQL_*` 언급까지 세므로 숫자만 믿지 말 것.
  - **worker_id 없음**: 곡선은 단일워커 v1(`max(vu_stages[].target) > capacity` → 400 거부). 멀티워커 곡선 샤딩(B9 연기) 시 worker_id 추가.
- ingest(`ingest_metrics`): `batch.active_vu_samples`를 `INSERT INTO run_active_vu_metrics … ON CONFLICT(run_id, ts_second) DO UPDATE SET desired=excluded.desired, actual=excluded.actual`(keep-last; 게이지=완전 스냅샷, 단일워커라 초당 1행이지만 방어적 멱등). `insert_phase_batch`/`insert_group_batch`(`grpc/coordinator.rs:865,881`)처럼 per-batch `if let Err(e) = … { warn!(…) }` 패턴(`?` 금지 — `ingest_metrics`는 `()` 반환, `coordinator.rs:799`).

### 6.2 read + `build_report`

- 신규 read 헬퍼: `run_active_vu(run_id) -> Vec<ActiveVuRow>`(ts_second ORDER BY).
- `build_report`에 **8번째 param** `active_vu: &[ActiveVuRow]` 추가 → `ReportJson.active_vu_series: Vec<ActiveVuSample>`(ts_second 정렬 매핑).
  - **summary/windows/overall/RPS/per_step 절대 미접촉** — 독립 게이지(group_latency/download phase가 summary를 안 건드리는 것과 동형).
  - **모든 call site 8번째 인자 추가**(컴파일러-driven): **프로덕션 호출은 정확히 1곳** — `build_report_for_run`(`api/runs.rs:498`) 내부의 단일 `build_report(...)`(report JSON·단일 export·비교 export가 전부 이 헬퍼를 경유, 별도 "실 경로" 없음). 그 외엔 **`report.rs` 테스트 fixture 17곳**(각 `&[]` 추가). `export.rs`·통합 테스트엔 `build_report` 호출 없음.
- `ReportJson`:
  ```rust
  #[serde(default)]
  pub active_vu_series: Vec<ActiveVuSample>,  // controller 측 ActiveVuSample {ts_second:i64, desired:u32, actual:u32}
  ```
  `#[serde(default)]`라 역직렬화 호환(골든 fixture·기존 run). struct 리터럴(테스트·`export.rs` 픽스처)엔 필드 명시 필요.

## 7. UI (`ui/src`)

- Zod: `ActiveVuSampleSchema = z.object({ ts_second: z.number(), desired: z.number(), actual: z.number() })`, `ReportSchema`에 **`active_vu_series`**`: z.array(ActiveVuSampleSchema).optional()` — 서버 빈 배열/absent 흡수. **필드명은 snake_case `active_vu_series`** (camelCase 금지): `ReportJson`엔 `rename_all`이 없어 serde가 snake_case로 직렬화하고(`group_latency`/`ts_second`와 동일), `ReportSchema`는 `.strict()`(`schemas.ts:363`)라 camelCase 키를 쓰면 **unknown key → 영영 빈 시리즈 → 차트 미렌더**(와이어 미스매치). **`.default([])`는 금지**(ui/CLAUDE.md "응답 스키마 top-level `.default()` 누출" 함정 — `T | undefined`가 부모 `z.infer`로 새고 `pnpm build`만 잡음). 직접 선례 `group_latency`도 `.optional()`(`schemas.ts:357`) + 서버측 `#[serde(default)]`(`skip_serializing_if` 없이 항상 직렬화) 조합 — `active_vu_series`와 동일 패턴 미러.
- 신규 **`ActiveVuChart.tsx`**(Recharts):
  - 두 줄: **목표(desired)** = 점선, **실제(actual)** = 실선.
  - X축 = 상대 초(`ts_second - series[0].ts_second`, 기존 `TimeSeriesChart` 컨벤션 미러), Y축 = VU 수.
  - 단위/축 라벨·범례 한국어.
- `ReportView.tsx`: `active_vu_series`가 **비어있지 않을 때만** `<section aria-label="활성 VU">`로 렌더(곡선 run에서만 등장). 기존 per-second `TimeSeriesChart` 인근 배치.
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
| docs | `crates/engine/CLAUDE.md`(MetricFlush "드레인 6 / send-guard 5" 노트에 7번째 벡터 `active_vu_samples` = 곡선 send 2곳·워커 forwarder 가드 반영) + `crates/controller/CLAUDE.md`(신규 `run_active_vu_metrics` 테이블·read 헬퍼·forwarder 가드 한 줄) 갱신 — 루트 CLAUDE.md "새 함정을 배우면" 규칙 |

byte-identical 회귀 가드와 함께, 비-곡선 경로는 전부 `vec![]`/빈 배열/미렌더로 흘러간다.
