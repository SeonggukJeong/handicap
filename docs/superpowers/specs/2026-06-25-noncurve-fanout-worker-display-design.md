# Fan-out 워커별 분해 표 (비-곡선 fan-out 워커 표시)

- **날짜**: 2026-06-25
- **상태**: 설계 (브레인스토밍 → spec)
- **출처**: roadmap §B9 연기 항목 "non-곡선 fan-out 워커 표시" + 사용자 선택(2026-06-25). 직전 슬라이스 `curve-fanout-worker-display`(곡선 fan-out 워커 표시, `033d052`/`17ce084`)의 자매·일반화.
- **ADR**: 신규 불필요 (ADR-0027 멀티워커 fan-out · ADR-0037 closed-loop VU 곡선 범위 내 additive read-path).

---

## 1. 배경 & 동기

직전 슬라이스(`curve-fanout-worker-display`)는 **closed-loop VU 곡선** fan-out run(N≥2)에 대해 RunDetailPage에서 워커 수 + per-worker active-VU(desired/actual) 분해를 보여준다. 그러나 그 표시는 `run_active_vu_metrics`(per-worker active-VU 게이지, 곡선 run만 emit)에 의존하므로 **고정-VU 닫힌 루프(ADR-0027/A3a)·열린 루프(ADR-0038/L4) fan-out run에는 적용되지 않는다**.

결과적으로 비-곡선 fan-out run은:
- "몇 대의 워커로 분산 실행됐나"가 리포트 어디에도 안 보인다.
- 한 워커가 straggler(부하 share 불균형·지연/오류 편차)였는지 알 수 없다 — 집계 리포트는 모든 워커를 SUM/merge해 worker-agnostic 단일값으로 collapse한다(`build_report` `report.rs:463-506`).

핵심 관찰: **비-곡선 fan-out run의 per-worker 데이터는 이미 `run_metrics`에 존재한다.** migration 0008(A3b)이 `run_metrics` PK에 `worker_id`를 추가했고, per-`(ts_second, step_id, worker_id)`로 count·error_count·status_counts·HDR 히스토그램이 저장된다. `build_report`는 이 per-worker 행을 `windows_with_hdr`로 받아 **이미 순회**하지만 worker 차원을 버린다.

따라서 이 슬라이스는 신규 메트릭 파이프라인·신규 SQL 없이, **기존 build_report 루프에 worker_id 키 누적기 하나를 추가**해 per-worker 분해 표를 emit한다.

## 2. 범위

### 적용 대상 (사용자 결정 2026-06-25)
**모든 fan-out run** (게이트 = `run_metrics`의 distinct non-empty worker_id ≥ 2). 게이트가 순수하게 worker 수이므로 곡선 fan-out run도 자동 포함된다 — 곡선 run은 기존 active-VU 차트 옆에 처리량/지연 표가 추가로 붙는다(직교 정보). "비-곡선 only"는 `!is_vu_curve()` 억제 조건이 *추가로* 필요하므로 오히려 코드가 늘고 유용한 데이터를 숨긴다.

### 표시 깊이 (사용자 결정 2026-06-25)
**per-worker 분해 표** — 워커별: 요청 수, 오류 수(+UI 계산 오류율), p50/p95/p99 지연. 워커 수 N은 표 행 수로 자명.

### 비목표 (§11 연기)
- per-worker rps 열 (run duration 의존 — count로 share는 충분)
- per-worker status 분포(4xx/5xx) 열
- per-worker 초당 처리량 시계열 차트 (브레인스토밍에서 거부된 무거운 옵션)
- per-step × worker 2차원 분해
- per-worker 기대-share(VU/rate 분할) 병기 (미영속 — actual만 정직 표시)
- run 목록 워커 배지 (별도 슬라이스)

## 3. 요구사항 (R-id 스파인)

- **R1**: `build_report`가 종료 run의 `run_metrics` 행에서 distinct non-empty worker_id가 **≥2**일 때 `ReportJson.worker_breakdown: Vec<WorkerBreakdown>`를 채운다. <2이면 빈 Vec.
- **R2**: 각 `WorkerBreakdown`은 그 워커의 전체-스텝 집계: `worker_id`, `count`(요청 수 SUM), `errors`(오류 수 SUM), `p50_ms`/`p95_ms`/`p99_ms`(그 워커 행들의 HDR을 merge한 분포). 와이어에 `error_rate`는 싣지 않는다(summary 컨벤션 — UI가 `errors/count`로 계산).
- **R3**: per-worker 누적은 `build_report`의 **기존** `run_metrics` 행 루프(`report.rs:479`) 안에서 수행한다 — 신규 SQL 쿼리·신규 fetch-gate 0.
- **R4**: 단일 워커·legacy(`worker_id == ''`) run → `worker_breakdown` 빈 Vec → `#[serde(default, skip_serializing_if = "Vec::is_empty")]`로 직렬화 생략 → 기존 리포트·골든 fixture **byte-identical**.
- **R5**: 단일 워커 run의 리포트 **빌드 비용**도 본질적으로 불변이어야 한다 — per-worker HDR merge는 사전 스캔으로 멀티워커가 확인된 경우에만 수행(아래 §5, §9).
- **R6**: 워커 행 정렬·라벨은 곡선 슬라이스와 동일 — worker_id 오름차순(BTreeMap), UI 서수 라벨 "워커 N"(`title={worker_id}`).
- **R7**: `worker_breakdown.length >= 2`일 때만 UI 표를 렌더(서버 게이트 미러·방어). 곡선 run은 active-VU 차트와 표가 공존한다.
- **R8**: 신규 UI 문구는 전부 `ko.ts` 카탈로그 경유(ADR-0035) — 표 제목·열 헤더·`워커 N` 라벨·`aria-label`.
- **R9**: proto·engine·worker·migration **0-diff**. 변경은 controller read-path(`report.rs` + 그 호출부 컴파일러-driven churn) + `ui/`로 한정.
- **R10**: `WorkerBreakdown` 와이어(snake_case 필드) ↔ UI Zod `WorkerBreakdownSchema`(`.strict()`)가 필드별 1:1.
- **R11**: 라이브 검증 — 실 2워커 고정-VU run + 실 2워커 open-loop run의 `/report`가 `ReportSchema.parse`를 통과하고, 표 행 수 == 워커 수, per-worker `count` 합 == `summary.count`(S-D 갭 차단).
- **R12**: 핫 부하 경로 무영향 — 엔진/워커/ingest 무변경(R9에 포함되나 성능 불변식으로 명시).

## 4. 데이터 모델 & 와이어 포맷

### 컨트롤러 (`report.rs`)
```rust
#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct WorkerBreakdown {
    pub worker_id: String,
    pub count: u64,
    pub errors: u64,
    pub p50_ms: u64,
    pub p95_ms: u64,
    pub p99_ms: u64,
}
```
> **지연 필드 타입 = `u64`** (f64 아님). `Percentiles { p50_ms: u64, p95_ms: u64, p99_ms: u64 }`(`engine/src/percentiles.rs:6-10`)와 `percentiles_of` 반환값·모든 sibling 리포트 지연 필드(`ReportSummary`/`ReportStep`/`ReportWindow`/`PhaseStats`)가 전부 `u64`다. §5.4의 `p50_ms: p.p50_ms`(`p: Percentiles`)가 캐스트 없이 컴파일되려면 u64여야 한다. UI Zod `z.number()`는 정수도 수용하므로 영향 없음.

`ReportJson`에 추가:
```rust
#[serde(default, skip_serializing_if = "Vec::is_empty")]
pub worker_breakdown: Vec<WorkerBreakdown>,
```
(곡선 슬라이스 `active_vu_by_worker`(`report.rs:34-35`, struct `:187-190`)와 동형 패턴. `if_breakdown`/`group_latency`/`active_vu_series`와 같은 최상위 배열 — `ReportStep` 안이 아님.)

### UI (`schemas.ts`)
```ts
export const WorkerBreakdownSchema = z
  .object({
    worker_id: z.string(),
    count: z.number(),
    errors: z.number(),
    p50_ms: z.number(),
    p95_ms: z.number(),
    p99_ms: z.number(),
  })
  .strict();
export type WorkerBreakdown = z.infer<typeof WorkerBreakdownSchema>;
```
`ReportSchema`에 `worker_breakdown: z.array(WorkerBreakdownSchema).optional()`.
(`ReportSchema`가 `.strict()`이지만 `.optional()`이라 기존 full-report fixture는 absent로 통과 — 비-optional summary 필드와 달리 fixture 갱신 불요.)

## 5. 컨트롤러 변경 (read-path only)

`build_report` 본문(`report.rs:463-506`)을 다음과 같이 확장:

1. **사전 스캔(R5)**: 루프 진입 전 `let multi_worker = { let mut s = std::collections::HashSet::new(); rows.iter().for_each(|r| { if !r.worker_id.is_empty() { s.insert(r.worker_id.as_str()); } }); s.len() >= 2 };` — HDR 디코드 없는 값싼 문자열 해시. 단일 워커면 per-worker 작업을 전혀 안 함.
2. **누적기**: `multi_worker`일 때만 `let mut worker_acc: BTreeMap<String, WorkerAcc>` 사용. `struct WorkerAcc { count: u64, errors: u64, hist: Option<Histogram<u64>> }`.
3. **기존 행 루프(`:479`) 안** (`multi_worker && !r.worker_id.is_empty()`일 때): count/errors는 **행 본문에서** 누적(`acc.count += r.count as u64; acc.errors += r.error_count as u64` — `WindowWithHdr.count`/`error_count`가 `i64`라 캐스트 필수, window_acc의 `:489-490`과 동형·HDR 디코드 성공 여부 무관). per-worker HDR merge는 **기존 `if let Ok(Some(h)) = decode_hdr(...)` 블록(`:492`) 안에서** `merge_into(worker_hist, &h)`(이미 디코드된 `h` 재사용 — 추가 디코드 0·fail-soft: bad blob이면 그 워커 hist에 그 행만 누락). 기존 `overall`/per-step/window 누적은 무변경.
4. **emit**: 루프 후 `let worker_breakdown = if multi_worker { worker_acc.into_iter().map(|(worker_id, acc)| { let p = acc.hist.as_ref().map(percentiles_of).unwrap_or_else(Percentiles::empty); WorkerBreakdown { worker_id, count: acc.count, errors: acc.errors, p50_ms: p.p50_ms, p95_ms: p.p95_ms, p99_ms: p.p99_ms } }).collect() } else { Vec::new() };` (BTreeMap → worker_id 오름차순).
5. **fetch-gate 변경 없음**: 데이터가 이미 `rows: &[WindowWithHdr]`에 있다(curve의 `active_vu_by_worker` 별도 쿼리·`is_vu_curve()` fetch-gate(`api/runs.rs:933-937`)와 대조). `build_report` 시그니처·호출부 인자 **무변경**.
6. **호출부 churn**: `ReportJson` struct 리터럴은 워크스페이스 전체에 **딱 2곳** — 프로덕션 `report.rs:823`(이 슬라이스가 채움) + `export.rs::report_with_steps`(`:487`) 테스트 fixture. fixture에만 `worker_breakdown: vec![]` 추가(컴파일러-driven). `report.rs` 단위 테스트는 `build_report(...)`를 *호출*할 뿐 `ReportJson` 리터럴을 안 만들어 무수정. `testdata/compare_golden.json`은 `#[serde(default)]`로 역직렬화 호환·단일워커라 직렬화 byte-identical → **무수정**(`golden_summary_deltas_match`는 `.summary`만 읽음). (mean_ms 트랩[4개 `ReportSummary` 리터럴]은 `ReportJson`이 2곳·optional default라 **해당 없음**.)

기존 helper 재사용: `decode_hdr`·`merge_into`·`fresh_hist`·`percentiles_of`·`Percentiles`(HDR merge bound 처리가 overall/per-step과 동일 — 자체 구현 금지).

## 6. UI 변경 (`ui/`)

- **`schemas.ts`**: §4의 `WorkerBreakdownSchema` + `ReportSchema` 필드.
- **신규 `WorkerBreakdownTable.tsx`**: prop `breakdown: WorkerBreakdown[]`. `breakdown.length >= 2`일 때만 렌더(R7). 표: 행=워커(서수 라벨 "워커 N"·`title={worker_id}`, R6), 열=워커·요청 수·오류 수·오류율(`errors/count` 백분율, count 0이면 "—")·p50·p95·p99(ms). `StepStatsTable` 단위-헤더 컨벤션 차용.
- **`ReportView.tsx`**: active-VU 차트 섹션(`:182-187`) 근처에 `<section aria-label={ko.report.workerBreakdownTitle}>` 슬롯. `breakdown={report.worker_breakdown ?? []}`. 곡선 run은 차트+표 둘 다, 비-곡선 fan-out run은 표만, 단일워커 run은 둘 다 미렌더.
- **`ko.ts`**: 신규 `ko.report.worker*` — 표 제목(`workerBreakdownTitle`), 열 헤더(워커/요청 수/오류 수/오류율/p50/p95/p99), `workerLabel(n) => 워커 ${n}`(새 키 — 곡선 `activeVuWorkerLabel`과 출력은 같으나 역할 분리로 독립 키. U2 연기 노트의 "동일 문자열 별도 키=역할 분리 변호 가능" 선례), `aria-label`.

## 7. 표시 세부 (기본값 — 리뷰에서 조정 가능)

- **워커 라벨**: 서수 "워커 1/2/3"(worker_id 오름차순), `title={worker_id}` 호버 시 실제 id.
- **정렬**: worker_id 오름차순(라벨 안정성·곡선 슬라이스 일치). 지연 열을 눈으로 스캔해 straggler 식별.
- **지연 출처**: 그 워커의 전체-스텝 merged HDR(overall과 동형 — per-step 분해는 비목표).
- **오류율**: UI 계산 `errors/count` 백분율, count 0이면 "—".
- **단위**: 지연 ms(StepStatsTable 컨벤션).
- **"기대 share" 없음**: per-worker 기대 VU/rate 분할은 미영속 → **실제값만** 표시(부하 divergence가 아니라 actual 관측 — [[load-divergence-explain-confirm]]는 설정과 다르게 *발생*시킬 때의 규칙이고, 여기는 실제로 발생한 것의 정직 관측이라 무관).
- **"N개 워커" 캡션 중복**: 곡선 run은 active-VU 차트가 이미 "N개 워커로 분산 실행"을 표시. 표 섹션은 자체 제목 + 행 수로 N이 자명하므로 그 문장을 반복하지 않는다(표 제목만). 비-곡선 run은 표가 유일한 워커 표시.

## 8. 불변식

- **migration 0 · proto 0 · engine 0 · worker 0** (R9). 변경 = controller `report.rs`(+컴파일러-driven fixture) + `ui/`(+docs).
- **byte-identical**: 단일 워커·legacy(`''`) run → 빈 Vec → `skip_serializing_if` 생략 → 기존 리포트/CSV/XLSX/골든 fixture 무변경(`#[serde(default)]` 역직렬화 호환).
- **ADR 신규 불필요**: ADR-0027/0037 범위 내 additive read-path.
- **export(CSV/XLSX) 무변경**: `worker_breakdown`은 리포트 JSON에만 추가 — export 시트는 이 슬라이스에서 미반영(연기). `ReportJson` 입력만 받는 export 순수 함수라 컴파일은 통과(fixture 리터럴만 필드 추가).

## 9. 성능 & 확장성 분석 (사용자 명시 우려)

- **핫 부하 경로(부하 생성, ~20k RPS)**: **0 영향**. 엔진·워커·proto·`ingest_metrics` 전부 무변경. 이 슬라이스는 read-path(리포트 빌드)+UI만.
- **리포트 빌드 (on-demand only)**: `/report`는 polling 금지·`staleTime: Infinity`(컨트롤러 CLAUDE.md) — 사용자가 리포트를 *열 때* 한 번 실행. `build_report`는 이미 `run_metrics` 행을 한 번 순회(O(rows)·행당 HDR decode+merge). 추가 비용:
  - **단일 워커/legacy run(대다수)**: 값싼 문자열 HashSet 사전 스캔(HDR decode 없음) → `<2` 감지 → per-worker 작업 0 → **빌드 비용·출력 byte-identical**(R5).
  - **fan-out run(N≥2)**: 행당 `merge_into` 1회 추가(HDR add) + W개 히스토그램 메모리. O(rows) 차수 불변·이미-O(rows)인 on-demand 연산의 상수배 증가. W = `run_metrics`에 행을 쓴 distinct 워커 수 = 배포 규모로 유계(closed/pool fan-out N=`ceil(vus/capacity)`로 정해지는 실제 워커 수 — **open-loop `worker_count` 노브의 1~64 캡과는 무관**). 무한 증가 경로 없음(BTreeMap/HashSet over W는 W가 현실적 워커 수라 무해).
- **DB**: 신규 쿼리 0·신규 인덱스 0(`run_metrics` PK가 worker_id 포함)·migration 0 → 쿼리 부하·스키마 확장성 영향 0.
- **와이어/UI**: 리포트 JSON이 fan-out run에서만 작은 유계 배열(W ≤ 64 × 6 필드)을 얻음. UI는 W행 표 — trivial.
- **결론**: 추가 비용은 오직 멀티워커 run을 리포트로 열 때만 발생 = 기능 자체. 무한 증가 경로 없음. 악영향 없음.

## 10. 테스트 & 라이브 검증

### 컨트롤러 단위(`report.rs`)
- 2-worker 행(`run_metrics`) → `worker_breakdown` 2개·worker_id 오름차순·count/errors SUM·per-worker HDR 분리(서로 다른 분포).
- 1-worker 행 → `worker_breakdown` 빈 Vec(byte-identical).
- legacy `''` worker_id만 → 빈 Vec(제외).
- 잘못된 HDR blob 한 워커 → 그 워커 p50/p95/p99=0, 나머지 정상(fail-soft, 기존 `build_report_tolerates_bad_hdr_blob` 정신).

### UI RTL
- `length >= 2` 렌더 게이트(length 0·1 → 미렌더).
- 열·서수 라벨·`title=worker_id`·오류율 계산(count 0 → "—").

### 라이브 검증 (필수 — run-create/report-parse 경로·S-D 갭, R11)
- `/live-verify` 스택(워크트리 자체 바이너리·responder·격리 DB).
- **2워커 고정-VU run**: capacity를 낮춰(`--worker-capacity-vus`/settings) vus가 N=2가 되게 → 실 `/report`가 `ReportSchema.parse` 통과·표 행 2개·per-worker count 합 == summary.count.
- **2워커 open-loop run**: 동일하게 N=2 → 표 행 2개.
- **단일워커 run**: `worker_breakdown` absent·기존 리포트 byte-identical.
- Playwright: RunDetailPage에서 표 렌더·서수 라벨·`title`·콘솔 Zod 0.

## 11. 연기 항목

- per-worker rps 열 · per-worker status 분포(4xx/5xx) 열
- per-worker 초당 처리량 시계열 차트(거부된 무거운 옵션)
- per-step × worker 2차원 분해 · per-worker 지연을 스텝별로
- per-worker 기대-share(VU/rate 분할) 병기 (영속 필요)
- export(CSV/XLSX)에 worker_breakdown 열
- run 목록 워커 배지(별도 슬라이스)
- 곡선 run에서 active-VU 차트와 표의 시각적 통합(현재는 두 섹션 공존)
