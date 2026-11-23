# 응답 시간 표본 슬라이스 A — 통과한 요청 기준 + 실패한 요청 분리 (passed-latency-a) 설계

- 날짜: 2026-11-23
- 상태: 설계 초안 (spec-plan-reviewer 4차에 clean APPROVE, 2026-11-23 · 사용자 목업 확인 「진행하자」 2026-11-23). plan `docs/superpowers/plans/2026-11-23-passed-latency-a.md`도 clean APPROVE → 구현 대기. US1 문구 변경(실패 60%)은 사용자 확인 2026-11-23.
- 유형: `user-path`
- 출처: 사용자 결정 2026-11-23 — 「평균에 LoadRunner하고 동일하게 통과 트랜잭션만 평균내는게 맞지 않아?」 → 응답 시간 통계 전체를 통과한 요청 기준으로, 실패한 요청·모든 요청도 볼 수 있게. roadmap §A17 진행 순서 ①.
- 목업(시각 기준): `2026-11-23-passed-latency-mockups/screens.html` — 이 슬라이스는 1-가·3·4·5·6. 1·2(전환 단추)는 슬라이스 B.
- 관련 결정: ADR-0012(워커 사전 집계 HDR), ADR-0027(워커별 메트릭 머지), ADR-0028(판정 기준), ADR-0046(실측 점유시간 사이징), ADR-0059(계단 자동 정지), ADR-0061(유지 구간 기준 — `?basis=` 선례).
- ADR: **ADR-0063 신규** — 「응답 시간 표본: 통과한 요청 기준 + 실패 분포 분리」. 와이어(proto·DB)와 응답 시간 숫자의 뜻이 바뀐다.
- 슬라이스 나누기: **A(이 문서)** = 엔진·와이어·저장·표본 계산·기본 표본을 통과한 요청으로·판정·계단·표시와 「—」 규칙·서버의 `?sample=`. **B** = 화면의 표본 전환 단추(US-B: 실패한 요청·모든 요청으로 바꿔 보기)와 그 안내. A ↔ B ↔ ② ↔ ③ ↔ ④ 사이에는 릴리즈하지 않는다.
- 작업 브랜치: `worktree-verdict-stats`(verdict-stats A 설계 초안이 같은 브랜치에 있다 — 문서일 뿐이고 함께 master에 들어간다).

## 사용자 스토리 (US)

- **US1**: QA가 요청의 절반 넘게 빨리 실패한 run의 리포트를 연다 — 성공하면 요약·스텝별·시간대별 응답 시간이 통과한 요청만으로 계산되어 있고 「응답 시간은 통과한 요청만으로 계산했습니다」 표시가 보인다. 정상 응답 40ms에 즉시 실패(2ms)가 60% 섞여도 p50이 40ms 근처로 나온다(실패를 섞어 계산하면 2ms 근처다).
- **US3**: QA가 응답 시간 판정 기준을 건 run에서 요청이 전부 실패한다 — 성공하면 그 기준이 통과로 나오지 않고 「통과한 요청 없음」으로 실패한다(지금은 0ms로 계산되어 통과). 표·그래프·인쇄에도 0ms가 찍히지 않는다.
- **US4**: QA가 계단 시험을 돌린다 — 성공하면 실행 중 계단 판정·자동 정지와 종료 뒤 계단 표가 모두 통과한 요청의 p99로 판정하고, 둘의 숫자가 같다.
- **US5**: QA가 이번 변경 전에 돌린 run을 연다 — 성공하면 응답 시간 숫자와 판정이 지금과 같고 「모든 요청 (실패한 요청 포함)」 표시가 붙는다.
- (US2 「표본을 실패한 요청·모든 요청으로 바꿔 본다」는 슬라이스 B. 번호는 사용자 승인 때의 것을 유지한다.)

R21(내보내기·인쇄에 표본 적기)·R22(비교 안내)는 특정 US가 아니라 §1.4 「표시 없이 숫자를 보여 주지 않는다」에서 나온다.

## 1. 배경

### 1.1 지금 상태 (2026-11-23, `38905b00` 기준 — 사실은 §11 명령으로 확인)

- **엔진** `crates/engine/src/aggregator.rs`: `StepWindow`(초·스텝 단위)에 분포 `histogram` 하나. `StepWindow::record(latency_us, status, is_error)`가 성공·실패를 가리지 않고 그 분포에 넣고, `is_error`면 `error_count`만 올린다. `record_not_sent`는 건수·오류만 올리고 표본·상태 코드를 남기지 않는다.
- **「오류」의 뜻** `crates/engine/src/executor.rs`·`runner.rs`: `is_error = outcome.error.is_some()`. 오류가 되는 경우는 보내기 실패(시간 초과 포함)·본문 읽기 실패·상태 코드 검사(`assert: status`) 불일치·값 추출 실패(엄격 모드). 상태 코드 검사가 없는 스텝에서는 4xx·5xx 응답도 오류가 아니다(이것을 바꾸는 일은 roadmap §A17 ②).
- **와이어** `crates/proto/proto/coordinator.proto` `MetricWindow`: 필드 1–6, `hdr_histogram = 5`. 운영 코드에서 만드는 곳은 `crates/worker/src/lib.rs` `flush_to_batch` 하나(데스크톱·풀 부하기도 같은 함수). 같은 proto에 `optional` 필드가 이미 있다.
- **저장** `run_metrics(run_id, ts_second, step_id, worker_id, count, error_count, hdr_histogram BLOB NOT NULL, status_counts)`. 마지막 마이그레이션 번호 0027.
- **읽는 곳**(스텝 창 분포를 디코드하는 운영 코드 — 전수 셋):
  1. `report.rs` `build_report`의 행 루프 → 초·스텝 창 분포, `overall`, `per_step`, 워커별 분포. 여기서 요약·스텝·창 목록·분포 곡선(`ReportJson.latency`)·속도 구간·워커별 표·판정·인사이트·유효성이 나온다.
  2. `stair.rs` `build_stair_report` → 종료 뒤 계단 표.
  3. `stair_monitor.rs` `StairMonitor::on_batch` → 실행 중 계단 판정·즉시 정지(들어오는 proto 배치를 직접 읽는다).
  2와 3은 `StairAccumulator`·`judge()`를 함께 쓴다. 표본이 없는 분포의 p99는 0으로 다룬다(`q()`).
- **응답 시간을 「점유 시간」으로 쓰는 곳**: 열린 루프 슬롯 사이징(`ui/src/components/run/SlotSizingHelper.tsx` — 지난 run 리포트의 스텝 p50·`summary.mean_ms`), 포화 원인 판정의 지연 상승(`crates/controller/src/insights.rs` `latency_rose` → `sut_stress` — 초별 창 p95).
- **기준 선택 선례** `steady.rs`·`api/runs.rs`: `?basis=steady|whole`(없는 기준을 요청하면 조용히 있는 기준으로), `build_reports_for_run`, 리포트의 `basis` 블록.
- **다른 분포들**(이번 범위 밖 — 실패가 섞인 채로 남는다): 준비 스텝(`run_section_step_metrics`), 병렬 묶음(`run_group_metrics`), 다운로드·대기 구간(`run_phase_metrics`), 조건 반복 분리(`loop_split`).
- **워커 버전**: `Register` 메시지에 버전이 없다. 컨트롤러는 부하기 버전을 모른다.

### 1.2 왜 바꾸나

빨리 실패하는 요청(연결 거부·즉시 오류)은 평균과 백분위를 낮추고, 시간 초과는 끌어올린다. 실패가 섞인 응답 시간은 「성공했을 때 얼마나 빠른가」도 「얼마나 실패하는가」도 말해 주지 못한다. 실패는 오류율이 따로 말한다. LoadRunner의 트랜잭션 응답 시간도 통과한 트랜잭션 기준이다.

### 1.3 목표가 아닌 것

- 화면의 표본 전환 단추(슬라이스 B). 이 슬라이스는 서버가 `?sample=`을 받는 데까지만 한다.
- 준비 스텝·병렬 묶음·다운로드/대기 구간·조건 반복 분리의 통과/실패 나누기(사용자 결정 2026-11-23 — 표지를 붙이고 다음 일로).
- 내보내기·인쇄·비교를 다른 표본으로 뽑기 — 기본 표본만 쓰고 어느 표본인지 적는다.
- 4xx·5xx를 기본으로 오류로 세기(roadmap §A17 ②).
- 실행 중 화면의 응답 시간 차트(ADR-0051).

### 1.4 하면 안 되는 것

- 성공한 요청의 기록 경로에 일을 더하는 것(working-rules §10 — 워커 요청당 CPU).
- 이번 변경 전 run의 응답 시간 숫자·판정을 바꾸는 것(US5).
- 통과한 요청이 없는데 응답 시간을 0으로 찍거나 기준을 통과로 판정하는 것.
- 화면·인쇄·XLSX·비교에서 어느 표본인지 표시 없이 응답 시간을 보여 주는 것. (CSV는 §10에 연기.)
- 「얼마나 오래 붙잡혔나」를 재는 계산(슬롯 사이징·포화 원인)이 시간 초과를 뺀 값을 쓰는 것.
- 실행 중 계단 판정과 종료 뒤 계단 표가 서로 다른 표본을 쓰는 것.

## 2. 요구사항 (R-id)

| ID | 요구사항 | acceptance | seam? |
|---|---|---|---|
| R1 | MUST 엔진이 실패한 요청의 응답 시간을 창마다 따로 모은다. 실패 분포는 그 창의 첫 실패 때 만들고, 성공한 요청의 경로에는 새 일이 없다. 전체 분포(`histogram`)는 지금과 같다. | 엔진 단위 테스트: 성공만 있는 창은 실패 분포가 없음 · 실패 표본 수 = 표본을 남긴 오류 수 · 전체 분포 불변. | |
| R2 | MUST 워커가 창마다 `MetricWindow.failed_hdr_histogram`(`optional bytes`, 필드 7)을 **항상** 싣는다 — 실패가 없으면 빈 바이트, 있으면 V2 직렬화. | 워커 단위 테스트 + 필드 번호 고정 테스트(`hand_built_batch_bytes_pin_field_numbers`) 갱신. | ✅ proto |
| R3 | MUST 컨트롤러가 그 값을 `run_metrics.failed_hdr_histogram`(BLOB, NULL 허용, 마이그레이션 0028)에 저장한다 — 필드가 없으면(옛 부하기) NULL, 빈 바이트면 길이 0 BLOB(NULL 아님). 재시작해도 깨지지 않는다(멱등). | store 테스트: 세 경우 왕복(빈 벡터가 NULL로 바뀌지 않음을 단언) · 마이그레이션 두 번 실행. | ✅ DB |
| R4 | MUST run이 「나눌 수 있음」 = 그 run의 `run_metrics` 행이 하나 이상 있고 **모든** 행의 실패 칸이 NULL이 아님. | 단위 테스트: 전부 있음 / 전부 NULL / 섞임 / 행 없음. | |
| R5 | MUST 표본 셋: `passed`(전체 − 실패), `failed`, `all`. 나눌 수 있는 run의 기본 표본은 `passed`, 나눌 수 없는 run은 `all`뿐. | 단위 테스트(통과 표본 수 + 실패 표본 수 = 전체 표본 수, 통과 분포 = 통과 값만 기록한 분포). | |
| R6 | MUST 리포트의 응답 시간 값이 고른 표본에서 나온다: 요약(`mean_ms`·p50·p95·p99), 스텝별, 초별 창, 분포 곡선·히스토그램, 워커별. 요청 수·오류 수·RPS·상태 코드 분포는 표본과 무관하다. | `build_report` 단위 테스트: 실패가 섞인 픽스처에서 각 표본의 값 = 손 계산. | |
| R7 | MUST 판정·유효성·속도 구간·「느린 스텝」류 인사이트는 요청한 표본과 상관없이 **기본 표본**으로 계산한다. | 단위 테스트: `sample=failed`·`all`로 만든 리포트의 `verdict`·`speed_bands`·`insights`가 기본 표본 리포트와 같다. | |
| R8 | MUST 「얼마나 오래 붙잡혔나」를 재는 두 계산은 **모든 요청** 표본을 쓴다: (가) 포화 원인 판정의 지연 상승(`latency_rose`)에 넣는 초별 p95, (나) 슬롯 사이징 도우미가 읽는 스텝 p50·평균(도우미가 `?sample=all`로 요청). | (가) 단위 테스트: 시간 초과가 늘어나는 픽스처에서 통과 p95는 평평해도 원인이 `sut`로 나온다. (나) RTL: 도우미의 요청 URL에 `sample=all` + 리포트 캐시 열쇠(`queryKeys.runReport`)에 표본이 들어 있어, 같은 run의 기본 표본 리포트가 캐시에 있어도 `all` 리포트를 따로 받는다. | |
| R9 | MUST 실패 칸 디코드나 빼기(전체 − 실패)가 실패해도 리포트는 계속 만든다. 깨진 행 하나가 다른 행의 값을 지우지 않는다: 누적 자리의 빼기가 실패하면 그 자리를 행 단위로 다시 계산해 깨진 행만 버린다. 빼다 만 분포를 쓰지 않는다. 「계산 실패」와 「통과한 요청 없음」을 구분한다 — 계산 실패로 분포가 없는 자리에는 R13의 `no_sample` 판정을 하지 않고 지금의 깨진 BLOB 처리(값 0, 기준은 지금 경로)와 같게 둔다. 나눌 수 없는 run은 실패 칸을 아예 읽지 않는다. | 단위 테스트: 깨진 실패 BLOB 한 행 + 정상 행 여럿(정상 행의 통과 값이 남는다) · 실패가 전체보다 많은 칸 · 섞인 run에서 깨진 실패 칸이 있어도 결과가 지금과 같다. | |
| R10 | MUST 리포트 요청에 `?sample=passed\|failed\|all`을 받는다. 모르는 값은 400 + 한국어 사유. 나눌 수 없는 run에 `passed`·`failed`를 요청하면 조용히 `all`로 준다(`?basis=` 선례). `?basis=`와 함께 쓸 수 있다. | 통합 테스트. | ✅ REST |
| R11 | MUST 리포트에 `sample: { selected, default, split }` 블록을 **항상** 싣는다(`split` = 나눌 수 있음). | 단위 테스트 + Zod. 골든 `testdata/report_whole_golden.json` 재생성 — 차이가 `sample` 키뿐임을 확인. | ✅ `ReportJson` ↔ Zod |
| R12 | MUST 나눌 수 없는 run의 리포트는 `sample` 블록 말고는 지금과 바이트 동일하고 판정도 같다(US5). | 기존 리포트·판정 테스트가 실패 칸 NULL 픽스처로 그대로 통과 + 골든 차이 확인(R11). | |
| R13 | MUST 기본 표본이 `passed`일 때, 요청이 있었는데(`count > 0`) 통과 표본이 없으면 응답 시간 기준(run의 p50·p95·p99, 스텝의 `p50_ms`·`p95_ms`·`p99_ms`)은 `passed: false` + `no_sample: true` 행이 된다(`actual`은 0). `no_sample`은 참일 때만 직렬화한다. 요청이 0인 스텝은 지금처럼 건너뛴다. | `evaluate_criteria` 단위 테스트: 전부 실패한 run·스텝 / 요청 0 스텝 / 나눌 수 없는 run(지금 동작). | ✅ `CriterionResult` ↔ Zod |
| R14 | MUST 계단: 실행 중 감시(`StairMonitor`)와 종료 뒤 계단 표(`build_stair_report`)가 **창마다 같은 규칙**으로 표본을 고른다 — 그 창에 실패 분포 칸이 있으면 통과 표본, 없으면 전체. 한 함수를 함께 쓴다. 통과 표본이 없는 초·계단의 p99는 지금의 「표본 없음」과 같게 다룬다(0). | 단위 테스트: 같은 입력에서 감시 숫자 = 리포트 숫자(기존 `monitor_matches_report_for_completed_steps`를 실패 섞인 픽스처로 확장) · 실패만 있는 초의 p99. | |
| R15 | MUST 저장되는 목록 배지 판정(`persist_verdict`)이 기본 표본을 따른다. | 단위 테스트: 실패가 섞인 run의 저장 판정 = 통과 표본 판정. | |
| R16 | MUST 화면 리포트 머리에 「응답 시간 표본」 줄을 둔다: 나눌 수 있는 run은 「통과한 요청」 표지 + 도움말 + 설명, 나눌 수 없는 run은 「모든 요청 (실패한 요청 포함)」 표지 + 설명. 요청이 하나도 없는 run에는 줄을 보이지 않는다(화면 판정식: `report.windows.length === 0`). | RTL(`SampleBar`). | |
| R17 | MUST 표본에 해당하는 요청이 없으면 응답 시간 자리에 0을 찍지 않고 「—」(또는 그 표면의 「없음」 표현)를 쓴다. 판정식은 한 함수(`hasLatency`)가 단일 소스다: `passed` → `count − error_count > 0`, `failed` → 표본을 남긴 실패 `> 0`, `all` → 지금 규칙 그대로. 적용 자리: 화면 스텝 표·요약 카드·리포트 머리말(`ReportHeadline`), 인쇄 단계 표(`StepCodeTable`/`stepTable.ts`)·자동 요약 문장(`sentences.ts`), 비교 인쇄 아령 그림(`compare/dumbbell.ts`), 인쇄 KPI 카드(`print/verdict.ts` `kpiCards` — 평균·p95), 비교 화면(`compare/compareReports.ts` — run p50·p95·p99와 스텝 p95: 한쪽에 값이 없으면 차이를 내지 않는다), 비교 인쇄 변화 표(`print/compare/change.ts`), 워커별 표(`WorkerBreakdownTable`). **계단 표면**(`StairTable`·인쇄 `stairTable.ts`·`stairBandSeries`)은 `p99_us > 0`을 「표본 있음」으로 쓴다(분포의 바닥이 1µs라 0은 표본 없음뿐이다 — `StairCurveChart`가 이미 쓰는 식). plan에서 `p50_ms`·`p95_ms`·`p99_ms`·`mean_ms`를 읽는 UI 자리를 `grep`으로 전수 확인해 표로 남긴다. | 단위 테스트(`hasLatency` 표) + 각 자리 RTL·인쇄 테스트(전부 실패한 스텝 픽스처). | |
| R18 | MUST 시간대별 응답 시간 그래프는 그 초에 표본에 해당하는 요청이 없으면 점을 찍지 않는다(선이 끊긴다). 초별 「보내지 않음」 = `count − 상태 코드 합`. | 단위 테스트(`bySecond`) + RTL. 비교 겹침 그래프(`overlaySeries`)도 같은 값을 받는다. | |
| R19 | MUST 판정 표·목록 배지 툴팁·인쇄 판정 행·인쇄 KPI 카드의 「측정」 글자가 `no_sample` 행의 실측을 「통과한 요청 없음」으로 찍는다. | RTL·인쇄 테스트. | |
| R20 | MUST 나눌 수 있는 run에서, 아직 나누지 않은 구획(준비 스텝·병렬 묶음·스텝 표의 대기/다운로드 열·구간 표·조건 반복 분리)에 「실패 포함」 표지를 단다. 나눌 수 없는 run에는 달지 않는다. | RTL: 구획별 표지 유무. | |
| R21 | MUST 인쇄 보고서 머리, XLSX Summary 시트(맨 끝 행 `latency_sample`), 비교 XLSX의 Runs 시트(맨 끝 열)에 응답 시간 표본을 적는다. 기존 행·열의 자리는 바뀌지 않는다. 인쇄·내보내기·비교는 기본 표본만 쓴다. CSV에는 표본을 적지 않는다(§10). | 인쇄 테스트 · export 테스트(기존 행 번호 단언 무수정 통과). | ✅ XLSX |
| R22 | MUST 비교 화면·비교 인쇄에서 고른 run들의 표본이 다르면(나눌 수 있는 run과 없는 run이 섞임) 안내를 보인다(`basisNotice` 선례). | 단위·RTL. | |
| R23 | MUST 실행 중 계단 패널의 p99에 「통과한 요청」임을 적는다(도움말 또는 머리 글). | RTL. | |
| R24 | MUST 용어 풀이·도움말에서 응답 시간을 「전체 요청의 …」라고 설명한 문구를 표본과 어긋나지 않게 고친다(`ko.glossary`의 p50·p95·p99, `ko.print`의 같은 풀이, 속도 구간 문구). plan에서 「전체 요청」 문구를 `grep`으로 전수 확인한다. | 문구 테스트(있다면 갱신) + `grep` 결과를 plan에 기록. | |
| R25 | MUST 워커 요청당 CPU가 기준(master) 대비 측정 가능한 만큼 늘지 않는다 — 전부 성공하는 시나리오에서. 실패가 100%인 시나리오의 비용도 재서 기록한다. 그러려고 `/perf-ab`에 오류가 있는 라운드를 버리지 않는 선택지(`--allow-errors`)를 더한다. | `/perf-ab`: 기본 시나리오 「ranges OVERLAP」 + 실패 100% 시나리오 수치를 build-log에. | |
| R26 | MUST 실패가 run 내내 있는 긴 run의 리포트 빌드 시간을 기준(master)과 비교해 기록한다. | `#[ignore]` 성능 테스트 또는 라이브 측정 수치를 build-log에. | |
| R28 | MUST 내보내기도 같은 규칙을 따른다: 나눌 수 있는 run에서 통과한 요청이 없는 run·스텝의 응답 시간 칸은 XLSX(단일 Summary·Steps, 비교 Summary·Steps)와 비교 CSV에서 **빈 칸**이고, 그 칸으로 만드는 차이(Δ)도 쓰지 않는다. 화면 비교(`compareReports.ts`)와 같은 결과다(ADR-0030 패리티). 단일 CSV의 스텝 표도 빈 칸. 나눌 수 없는 run은 지금 그대로다. | export 테스트(빈 칸·Δ 없음·옛 run 불변) + `testdata/compare_golden.json`에 「한쪽에 통과한 요청 없음」 경우를 더해 TS·Rust가 같은 결과를 내는지 대조. | ✅ CSV/XLSX ↔ 화면 비교 |
| R27 | SHOULD 도움말이 「통과」의 뜻을 말한다: 오류로 세지 않은 요청이고, 상태 코드 검사가 없는 스텝에서는 4xx·5xx 응답도 통과로 센다. | 문구 존재(RTL). | |

## 3. 설계 근거

1. **전체 분포는 그대로 두고 실패 분포를 더한다.** 반대(통과·실패 두 분포로 바꾸기)는 지금 `hdr_histogram`을 읽는 모든 곳과 옛 run의 뜻을 바꾼다. 통과 = 전체 − 실패는 같은 칸 구조의 HDR 사이에서 칸 단위로 정확하다(`Histogram::subtract` — 최소·최대·총수도 다시 계산한다).
2. **실패 분포는 첫 실패 때 만든다.** 창마다 미리 만들면 스텝·초마다 할당이 는다. 대부분의 창은 실패가 없다.
3. **`optional bytes`로 「없음」과 「비어 있음」을 가른다.** proto3의 `bytes`는 없음과 빈 값이 같다. 컨트롤러는 부하기 버전을 모르므로 창 단위로 갈라야 run이 나눌 수 있는지 안다. 빈 값은 창당 2바이트다. 빈 BLOB은 `decode_hdr`가 이미 「분포 없음」으로 읽는다.
4. **합친 뒤 한 번 뺀다.** 행마다 디코드해서 빼면 실패가 있는 행마다 칸 전체를 한 번씩 돈다. 대신 `build_report`가 누적 자리마다(초·스텝 창, 스텝, 워커, 전체) 전체 분포와 실패 분포를 따로 합치고, 끝에 자리마다 한 번 뺀다. 결과는 같고(더하기·빼기가 칸 단위 정수 연산), 한 번의 빌드로 세 표본의 값을 모두 낼 수 있어 다른 표본을 요청해도 리포트를 두 번 만들지 않는다.
5. **표본을 고르는 값과 판정하는 값을 가른다.** 요청한 표본은 「보여 주는 응답 시간 숫자」만 바꾼다(R6). 판정·속도 구간·인사이트는 늘 기본 표본이다(R7) — 실패한 요청의 속도 구간이나 판정은 뜻이 없다. 한 번의 빌드에 두 표본이 다 있으므로 옮겨 끼우는 단계가 없다.
6. **점유 시간은 모든 요청.** 슬롯은 시간 초과가 가장 오래 붙잡는다. 통과한 요청만 보면 슬롯을 적게 권하고, 서버가 시간 초과로 무너지는 run을 「슬롯 부족」으로 잘못 짚는다(R8).
7. **run 단위로 한 표본, 계단은 창 단위.** 리포트는 한 행이라도 실패 칸이 NULL이면 run 전체를 `all`로 계산한다(섞인 분포는 뜻이 없다). 계단의 실행 중 감시는 run 전체를 미리 알 수 없어 창 단위로 고르고, 종료 뒤 계단 표도 같은 규칙을 써서 둘이 늘 같다(R14). 그래서 버전이 섞인 run에서는 계단 표(창 단위)와 리포트의 다른 숫자(run 단위)의 표본이 다를 수 있다(§10).
8. **통과한 요청 없음 = 실패.** 지금은 표본이 없으면 p95가 0이라 「≤ 3000ms」가 통과한다. 나눌 수 없는 run은 지금 동작 그대로 둔다(US5).
9. **통과한 요청 수는 새 칸 없이 구한다.** 통과 = `count − error_count`. 표본을 남긴 실패 = `error_count − 보내지 않음`(스텝은 `not_sent`, 초별 창은 `count − 상태 코드 합`).
10. **없는 표본을 요청하면 있는 것으로.** URL에 남은 `?sample=passed`로 옛 run을 열어도 오류 화면이 뜨지 않게 한다(`?basis=`와 같은 태도). 응답의 `sample.selected`가 실제로 준 표본을 말한다.
11. **낱말: 「모든 요청」.** 「전체」는 이미 「전체 구간」(유지 구간의 반대)으로 쓴다. 표본 이름은 「통과한 요청」·「실패한 요청」·「모든 요청」이다.

### 접근 비교

| 안 | 내용 | 판단 |
|---|---|---|
| **가 (채택)** | 워커가 실패 분포를 따로 보내고 컨트롤러가 전체 − 실패로 통과 표본을 만든다. 기본 = 통과. | 성공 경로 비용 0. 옛 run과 같은 저장 모양. 세 표본 모두 낼 수 있다. |
| 나 | 워커가 통과 분포만 보낸다(실패한 요청의 시간은 버린다). | 가장 작다. 실패한 요청이 얼마나 걸렸는지와 점유 시간(R8)을 잃는다. |
| 다 | 지금처럼 섞어 두고 화면에 「실패 포함」만 적는다. | 사용자 결정과 다르다. |

## 4. 와이어

### 4.1 proto (`coordinator.proto`)

```proto
message MetricWindow {
  …
  map<string, uint64> status_counts = 6;
  optional bytes failed_hdr_histogram = 7;  // 실패한 요청만. 없음 = 옛 부하기, 빈 값 = 실패 없음
}
```

`MetricWindow { … }` 리터럴(워커 2, 컨트롤러 테스트 7)에 새 칸을 명시한다.

### 4.2 DB (마이그레이션 0028)

`ALTER TABLE run_metrics ADD COLUMN failed_hdr_histogram BLOB` — `pragma_table_info`로 칸이 없을 때만(`ensure_runs_dropped` 패턴, `/new-migration` 사용, `connect()`의 맨 끝). 0008의 표 다시 만들기는 `worker_id`가 없을 때만 돌고 0028보다 앞이라 새 칸을 지우지 않는다. `MetricRow`·`WindowWithHdr`에 `failed_hdr_histogram: Option<Vec<u8>>`, `insert_batch`·`windows_with_hdr`의 칸 목록. 구조체 리터럴이 많다(`MetricRow` 약 66, `WindowWithHdr` 약 21 — plan에서 다시 세고, 테스트 쪽은 만드는 함수 하나로 모으는 것을 검토).

### 4.3 REST

`GET /api/runs/{id}/report?sample=passed|failed|all[&basis=…]`. 없으면 기본 표본. 내보내기·인사이트 CSV·계단 CSV·비교 라우트는 `sample`을 받지 않는다.

### 4.4 리포트 JSON

```jsonc
"sample": { "selected": "passed", "default": "passed", "split": true }   // 옛 run: all / all / false
"verdict": { "criteria": [ { "metric": "p95_ms", "direction": "max", "threshold": 3000, "actual": 0, "passed": false, "no_sample": true } ] }
```

- Rust: `SampleBlock { selected: Sample, default: Sample, split: bool }`, `Sample`은 `snake_case`. `ReportJson.sample`은 항상 있고 `build_report`가 채운다. 역직렬화 기본값은 `all/all/false`(`#[serde(default)]` — 옛 골든·픽스처 호환).
- `CriterionResult.no_sample: bool` + `#[serde(default, skip_serializing_if = "std::ops::Not::not")]`.
- Zod: `ReportSampleSchema`(`.strict()`), `ReportSchema.sample`은 `.optional()`(옛 픽스처 — 없으면 `all/all/false`), `CriterionResultSchema.no_sample: z.boolean().optional()`.
- 인쇄의 `matchVerdict`는 (metric, target, 방향, 기준값)으로 짝짓는다 — `no_sample` 행도 같은 열쇠라 그대로 맞는다.

### 4.5 내보내기

- XLSX Summary 시트 맨 끝에 `latency_sample` 행(값 `passed` 또는 `all`) — 모든 run에 쓴다. 기존 행 번호는 그대로다.
- 비교 XLSX Runs 시트 맨 끝에 `latency_sample` 열(기준 열이 있는 run 묶음과 없는 묶음에서 열 번호가 다르다 — plan에서 두 경우를 테스트로 고정).
- CSV(단일·비교·계단·인사이트)에는 표본을 적지 않는다 — 단일 CSV는 스텝 표뿐이라 적을 자리가 없다(§10).
- 통과한 요청이 없는 칸은 빈 칸으로 쓴다(R28): `export.rs`의 요약 숫자(`write_summary_numbers`)·스텝 표·비교의 차이 계산이 「값 없음」을 알게 한다. 판정은 리포트의 `sample.default == passed`와 그 run·스텝의 `count − error_count == 0`.

## 5. 엔진·워커

- `StepWindow`에 `failed_histogram: Option<Histogram<u64>>`. `record`: `is_error`일 때만 `get_or_insert_with`로 만들고 같은 값(1..=60,000,000µs로 자른 값)을 넣는다. `record_not_sent`는 그대로.
- `serialize_failed_histogram() -> Result<Vec<u8>>`: 없으면 빈 벡터.
- `flush_to_batch`: `failed_hdr_histogram: Some(bytes)`. 전체 분포 직렬화가 실패해 창을 건너뛰는 지금 동작은 그대로이고, 실패 분포 직렬화가 실패해도 그 창을 건너뛴다(반쪽 창을 보내지 않는다).
- 빈 배치 건너뛰기 가드는 바뀌지 않는다.

## 6. 컨트롤러

### 6.1 표본 모듈 (`sample.rs` 새 파일)

```rust
pub enum Sample { Passed, Failed, All }
pub fn run_is_split(rows: &[WindowWithHdr]) -> bool                 // R4
/// 한 누적 자리(초·스텝 창, 스텝, 워커, 전체)의 전체·실패 분포.
pub struct SplitHist { all: Option<Histogram<u64>>, failed: Option<Histogram<u64>>, /* 행 단위 재계산에 쓸 것 */ }
pub enum Resolved<'a> {
    Hist(Cow<'a, Histogram<u64>>),   // 표본 있음
    Empty,                           // 그 표본에 해당하는 요청이 없음
    Broken,                          // 계산 실패(R9) — `no_sample` 판정 금지
}
impl SplitHist {
    pub fn add(&mut self, all: &[u8], failed: Option<&[u8]>);   // 나눌 수 없는 run은 failed에 None을 넘긴다
    pub fn resolve(&self, s: Sample) -> Resolved<'_>;
}
/// 한 창만 볼 때(계단): 실패 칸이 있으면 통과, 없으면 전체.
pub fn window_hist_per_window(all: &[u8], failed: Option<&[u8]>) -> Option<Histogram<u64>>   // R14
```

- `resolve`는 빼기가 필요 없을 때(표본이 `All`이거나 그 자리에 실패가 없을 때) 분포를 **빌려 준다**(복사 없음). 복사는 실제로 뺄 때만 한다. 그래서 실패가 없는 run은 지금과 같은 일만 한다.
- 자리의 빼기가 실패하면(있을 수 없는 상태 — 실패가 전체보다 많은 칸) 그 자리를 행 단위로 다시 계산한다: 행마다 전체 − 실패를 해서 되는 행만 합친다. 드문 경로다. 되는 행이 하나도 없으면 `Broken`, 되는 행은 있는데 통과 표본이 없으면 `Empty`(전부 실패한 run이 `Broken`으로 빠져 통과로 판정되지 않게). 행 단위 재계산에 필요한 것을 어떻게 들고 있을지(행 원본 참조 등)는 plan에서 정한다.
- 나눌 수 없는 run(`run_is_split` 거짓)은 실패 칸을 읽지 않는다 — 깨진 실패 칸 때문에 지금 나오던 값이 사라지지 않게(R12).

### 6.2 `build_report`

- 인자에 `sample: Option<Sample>`(요청한 표본). 안에서 `run_is_split`으로 기본 표본을 정하고, 요청이 없거나 줄 수 없으면 기본을 고른다(R10).
- 행 루프의 누적 자리(초·스텝 창, `per_step`, 워커별, `overall`)를 `SplitHist`로 바꾼다. 루프 뒤에 자리마다:
  - **보여 주는 값** = `resolve(selected)` → 요약·스텝·창·분포 곡선·워커별(R6).
  - **판정하는 값** = `resolve(default)` → 판정·속도 구간·느린 스텝 인사이트(R7). `selected == default`면 같은 분포를 한 번만 만든다.
  - **점유 값** = `resolve(All)`의 초별 p95 → `latency_rose`(R8). `derive_insights` 안에서 창의 응답 시간을 읽는 곳은 `latency_rose`뿐이고 나머지는 건수만 읽으므로, 인사이트에 넘기는 기존 `windows` 인자에 모든 요청 표본의 창 목록을 넣는다(함수 모양을 바꾸지 않는다). 그 목록도 지금의 `scoped_windows`와 같은 방식으로 유지 구간 범위로 자른다. plan에서 `derive_insights` 안의 `p50_ms`·`p95_ms`·`p99_ms` 사용처를 `grep`으로 다시 확인한다.
- `evaluate_criteria`·인사이트는 지금 미리 계산된 `ReportSummary`·`ReportStep`·창 목록을 받는다. 판정용 값이 보여 주는 값과 다를 수 있으므로(`selected != default`) 판정용 요약·스텝·창을 따로 만들어 넘긴다. `selected == default`(대부분의 요청)면 같은 것을 넘긴다.
- R13: `evaluate_criteria`에 「통과 표본으로 판정 중」 여부와 표본 유무(run·스텝별)를 넘긴다.
- `build_stair_report`는 표본 인자를 받지 않는다 — 창마다 `window_hist_per_window`를 쓴다(R14).
- `ReportJson.sample`을 채운다(R11).
- `build_reports_for_run`의 기준 쌍(유지 구간·전체 구간)은 지금처럼 두 번 만든다. 두 리포트 모두 같은 `sample` 인자를 받는다. `basis.other`는 다른 기준 리포트의 값이라 그 리포트가 준 표본을 따른다.

### 6.3 라우트 (`api/runs.rs`)

`ReportParams`에 `sample`, `parse_sample`은 `parse_basis` 옆(모르는 값 400). `report` 핸들러만 넘기고, 내보내기·`persist_verdict`·비교는 `None`.

### 6.4 계단 감시 (`stair_monitor.rs`)

`on_batch`가 창마다 `window_hist_per_window(&win.hdr_histogram, win.failed_hdr_histogram.as_deref())`를 쓴다. 즉시 정지의 p99와 계단 판정 입력이 함께 바뀐다. 실패가 몰려 통과 표본이 줄면 p99 규칙은 조용해지고 오류율 규칙이 잡는다. 즉시 정지의 최소 요청 수 조건은 요청 수로 센다 — 요청은 많은데 통과가 몇 건뿐인 초의 p99는 표본이 적다(§10).

### 6.5 건드리지 않는 것

준비 스텝·병렬 묶음·구간·조건 반복 분리의 분포, `metrics::summary`(실행 중 폴링 — 분포를 읽지 않는다), 모니터·TUI(trace 경로), 스케줄러, 계단·인사이트 CSV.

## 7. 화면 (목업이 시각 기준)

- **`SampleBar`**(새 부품, `BasisBar` 아래): 목업 1-가·3. 전환 단추는 없다(슬라이스 B). 도움말 문구는 R27.
- **`hasLatency(counts, sample)`**(새 순수 함수): R17의 단일 소스. R17에 적은 자리 전부가 쓴다: `Summary`·`StepStatsTable`·`ReportHeadline`·`WorkerBreakdownTable`, 인쇄 `stepTable.ts`(`requestsSent`와 그 주석)·`sentences.ts`·`print/verdict.ts` `kpiCards`, 비교 `compare/compareReports.ts`·`print/compare/change.ts`·`print/compare/dumbbell.ts`. 계단 표면(`StairTable`·인쇄 `stairTable.ts`·`stairBandSeries`)은 `p99_us > 0`.
- **`bySecond`·`TimeSeriesChart`·`overlaySeries`**: 값 없음(`null`)을 받게 하고 선을 끊는다(R18).
- **`VerdictPanel`·`VerdictBadge`(`verdictFormat`)·인쇄 판정 행**: `no_sample`(R19).
- **`MixedSampleBadge`**(「실패 포함」, `WholeRunBadge`와 같은 모양): `SetupSection`·`GroupLatencyTable`·`StepStatsTable`의 대기/다운로드 열 머리·`StepPhaseBreakdown`의 구간 표·조건 반복 분리 행(R20). 소비처는 plan에서 `grep`으로 확인한다.
- **`SlotSizingHelper`**: 리포트를 `sample=all`로 읽는다(R8). `queryKeys.runReport`·`useRunReport`·`getRunReport`에 표본 인자를 더한다(캐시 열쇠가 표본을 구분).
- **`StairLivePanel`**: p99 표기(R23).
- **인쇄**: 머리(`ReportHeader`)에 표본 한 줄(R21).
- **비교**: `sampleNotice`(R22).
- **문구**: `ko.ts` 경유. 풀이 문구 고치기(R24).
- 진입 화면: run 상세(종료 run·실행 중 계단 패널)·인쇄 미리보기·비교·비교 인쇄·실행 창의 슬롯 사이징.

## 8. 성능 (working-rules §10)

- 워커: 성공 경로는 `if is_error` 분기(지금도 있다)뿐. 실패 경로는 분포 기록 한 번 + 창의 첫 실패 때 할당 한 번. 직렬화는 실패가 있는 창만. `/perf-ab`(기준 master)로 ① 기본 시나리오(전부 200) ② 상태 코드 검사가 전부 실패하는 시나리오를 잰다. ②는 지금 `/perf-ab`가 오류 있는 라운드를 버리므로 `--allow-errors`를 더한다(R25).
- 컨트롤러: 실패가 있는 누적 자리만 분포가 하나 더 생기고 자리마다 빼기 한 번. 실패가 내내 있는 긴 run의 빌드 시간을 재서 기록한다(R26). 계단 감시는 `monitor_batch_cost_*`를 실패가 섞인 입력으로 한 번 돌려 기록한다.
- 저장: 창당 실패 없으면 0바이트, 있으면 분포 하나.

## 9. 테스트·검증

- 단위·통합: R1–R24의 acceptance. 회귀 가드로 쓰는 테스트(R1 성공 경로에 실패 분포 없음, R8 원인 판정, R12, R13, R14 감시 = 리포트)는 되돌려 확인을 한다.
- 구조체 리터럴 변경(컴파일러가 잡는다): `MetricWindow`·`MetricRow`·`WindowWithHdr`·`StepWindow`·`CriterionResult`·`ReportJson`. `cargo build --workspace --tests` + bundle 기능 빌드.
- 골든: `testdata/report_whole_golden.json` 재생성, `testdata/compare_golden.json`은 역직렬화 기본값으로 그대로 읽히는지 확인.
- 라이브(US-anchored, `/live-verify` — 응답기는 keep-alive):

| US | 절차 | 통과 신호 |
|---|---|---|
| US1 | 응답기: 40%는 40ms 뒤 200, 60%는 즉시 500. 시나리오에 `assert: status 200` | 리포트 p50 ≈ 40ms · `?sample=all`로 받은 리포트의 p50 ≈ 수 ms(curl) · 머리 표시 |
| US3 | 전부 500인 응답기 + `max_p95_ms` 기준 | 판정 표 「통과한 요청 없음」 ✗ · 목록 배지 실패 · 스텝 표·요약·머리말·인쇄 「—」 · 그래프 끊김 |
| US4 | 계단 run, 중간 계단부터 일부 즉시 실패 | 실행 중 패널의 p99와 종료 뒤 계단 표의 p99가 같고 통과 표본 값 |
| US5 | 이번 변경 전 DB 사본의 run 열기 | 숫자·판정 동일(변경 전 리포트 JSON과 대조) · 「모든 요청 (실패한 요청 포함)」 |
| R8 | 열린 루프 run에서 일부 요청이 타임아웃 | 슬롯 사이징 도우미의 점유 시간이 타임아웃을 포함한 값 |

- 극단값: 스텝 수십 개·긴 이름에서 `SampleBar`·표지의 겹침·잘림. 좁은 폭.
- 보안 게이트: 요청 실행 경로(엔진 기록)를 건드린다 → `finish-slice` §0 grep을 돌리고 매치하면 `security-reviewer`.
- 코드 리뷰 모델: 엔진·proto·마이그레이션·`sample.rs` task는 Opus.

## 10. 연기 (roadmap §B에 옮길 것)

| 항목 | 왜 미루나 | 틀렸을 때 비용 | 푸는 길 |
|---|---|---|---|
| 화면 표본 전환 단추(슬라이스 B) | 슬라이스 크기 | 실패한 요청의 시간은 API(`?sample=`)로만 본다 | 슬라이스 B |
| 준비 스텝·병렬 묶음·다운로드/대기의 통과/실패 나누기 | 분포가 다른 메시지·표로 온다(사용자 결정 2026-11-23) | 그 구획은 실패가 섞인 값 — 표지로 알린다 | 각 통계에 실패 분포를 같은 방식으로 |
| 조건 반복 분리의 통과 표본 | 범위를 줄이려고. 실패 쪽 분포는 이미 저장돼 있어 와이어 변경 없이 가능하다 | 위와 같다 | `report.rs`가 실패 쪽 분포를 읽어 빼기 |
| CSV에 표본 적기(단일·비교·계단·인사이트) | 단일 CSV는 스텝 표뿐이라 자리가 없다 | CSV만 받은 사람은 어느 표본인지 모른다 | 파일 이름에 표본을 붙이거나 머리 주석 줄 |
| 버전이 섞인 run | 드물다 | 리포트는 「모든 요청」, 계단 표는 창 단위라 둘의 표본이 다를 수 있다 | 등록 때 버전·기능 표시 |
| 통과 표본 없는 초·계단의 p99 = 0, 즉시 정지의 최소 요청 수가 통과 수가 아님 | 지금 계단 동작 유지 | 전부 실패한 계단의 p99 규칙은 조용하고(오류율 규칙이 잡는다), 통과가 몇 건뿐인 초의 p99는 표본이 적다 | 계단 숫자에 「표본 없음」 표현 · 최소 표본 수 조건 |

## 11. 사실 확인 명령 (claims-ledger)

```bash
# 엔진 기록 경로·오류 뜻
grep -n "pub struct StepWindow" -A 8 crates/engine/src/aggregator.rs
grep -n "pub fn record(&mut self, latency_us" -A 9 crates/engine/src/aggregator.rs
grep -n "outcome.error.is_some()" crates/engine/src/runner.rs
grep -n "Assertion::Status" crates/engine/src/executor.rs
# 와이어·생산자(전수)
grep -n "message MetricWindow" -A 8 crates/proto/proto/coordinator.proto
grep -n "optional " crates/proto/proto/coordinator.proto
grep -rn "MetricWindow {" crates/
grep -rn "StepWindow {" crates/
# 저장
grep -n "run_metrics" crates/controller/src/store/mod.rs
grep -n "MIGRATION_SQL_00\|async fn ensure_" crates/controller/src/store/mod.rs
grep -rn "MetricRow {" crates/controller --include='*.rs' | wc -l
grep -rn "WindowWithHdr {" crates/controller --include='*.rs' | wc -l
# 스텝 창 분포를 디코드하는 곳(전수)
grep -rn "decode_hdr(&" crates/controller/src
grep -rn "hdr_histogram" crates --include='*.rs' -l
grep -rn "windows_with_hdr(" crates/controller/src
# 점유 시간으로 쓰는 곳
grep -n "mean_ms\|p50_ms" ui/src/components/run/SlotSizingHelper.tsx
grep -n "fn latency_rose\|sut_stress" crates/controller/src/insights.rs
# 0ms가 찍힐 수 있는 UI 자리(전수 — plan에서 표로)
grep -rn "p50_ms\|p95_ms\|p99_ms\|mean_ms" ui/src --include='*.ts' --include='*.tsx' -l | grep -v __tests__
grep -rn "전체 요청" ui/src/i18n/ko.ts
# 계단 공유 코드·표본 없음
grep -n "fn q(" -A 3 crates/controller/src/stair.rs
grep -n "StairAccumulator::new" crates/controller/src/stair_monitor.rs crates/controller/src/stair.rs
# 기준 선례(없는 기준 → 있는 기준)
grep -n "fn parse_basis\|fn build_reports_for_run\|fn build_report_for_run\|fn persist_verdict" -r crates/controller/src
# 내보내기에 CSV 요약 구획이 없음
grep -n "pub fn report_to_csv" -A 30 crates/controller/src/export.rs
# 빈 BLOB = 분포 없음 / HDR 빼기 / 버전 필드 없음
grep -n "pub fn decode_hdr" -A 4 crates/engine/src/percentiles.rs
grep -n "pub fn subtract" ~/.cargo/registry/src/*/hdrhistogram-7*/src/lib.rs
grep -n "message Register" -A 9 crates/proto/proto/coordinator.proto
# perf-ab가 오류 라운드를 버림
grep -n "errors\|NOT CLEAN" .claude/skills/perf-ab/perf_ab.py
```

## 12. 1차 검토 지적 처리 (2026-11-23)

| 지적 | 처리 |
|---|---|
| CSV에 요약 구획이 없다 | R21·§4.5: CSV는 바꾸지 않고 §10에 연기 |
| `BranchStatsTable`에는 응답 시간이 없다 | 표지 목록에서 뺌(R20) |
| 요약 카드에 지금 「—」 규칙이 없다 | R17: `all`은 지금 그대로, `passed`·`failed`에만 새 규칙 |
| 조건 반복 분리의 연기 이유가 틀렸다 | §10 이유 고침(와이어 변경 없이 가능, 범위 때문에 미룸) |
| prost도 `..Default::default()`를 받는다 | 그 문장 삭제 |
| 구조체 리터럴 수 | §4.2에 대략의 수와 「plan에서 다시 센다」 |
| 슬롯 사이징이 슬롯을 적게 권한다 · 포화 원인 오진 | R8 신설(점유 값은 모든 요청) |
| 다른 기준 줄이 표시 없이 남는다 | 옮겨 끼우기를 없앰 — 두 기준 리포트가 같은 표본을 받는다(§6.2). 화면 전환이 생기는 슬라이스 B에서 다시 본다 |
| 다른 화면도 0ms를 찍는다 | R17에 자리 명시 + `hasLatency` 단일 소스 + plan에서 전수 `grep` |
| 풀이 문구 「전체 요청」 | R24 신설 |
| `/perf-ab`로 실패 경로를 못 잰다 | R25: `--allow-errors` 추가 |
| 리포트 빌드 비용 | §3.4: 합친 뒤 한 번 빼기 + R26 측정 |
| 즉시 정지 최소 요청 수 | §6.4·§10에 기록 |
| 그래프가 끊긴 선을 못 그린다 · 초별 「보내지 않음」 식 | R18·§3.9 |
| 빈 벡터가 NULL로 저장되는지 | R3 acceptance에 단언 명시 |
| R13(구 번호)과 §6.2가 어긋난다 | 계단은 실행 중·종료 뒤 모두 창 단위(R14·§3.7) |
| 400 대 조용한 대체 | R10: 모르는 값만 400, 없는 표본은 `all`로 |
| `sample` 블록을 누가 채우나·빌드 횟수 | §6.2: `build_report`가 채우고 한 번의 빌드로 세 표본 |
| 요청이 없는 run의 문구 | R16: 줄을 보이지 않는다 |
| `latency_sample` 행을 모든 run에 쓰는가 | R21: 쓴다, 맨 끝이라 기존 자리 불변 |
| 표시 없는 표면(계단 CSV·인사이트 CSV·실행 중 패널) | 패널은 R23, CSV는 §10 |
| 「전체」 낱말 충돌 | 「모든 요청」(§3.11) |
| US1이 통과와 전체를 못 가른다 | US1을 실패 60%로(사용자 재확인 필요) |
| R21·R22가 US에 안 묶인다 | US 블록 아래에 한 줄 |
| 슬라이스가 크다 | A/B로 나눔(전환 단추와 US2는 B) |

### 2차 검토 지적 처리 (2026-11-23)

| 지적 | 처리 |
|---|---|
| 리포트 캐시 열쇠에 표본이 없어 슬롯 사이징이 통과 표본 리포트를 받는다 | R8 acceptance·§7 |
| 0ms가 찍히는 자리가 더 있다(인쇄 KPI 카드·비교 화면·비교 인쇄 변화 표·워커별 표·계단 표면) | R17·R19, 계단은 `p99_us > 0` |
| 빼기 실패가 「통과한 요청 없음」으로 보인다 · 깨진 행 하나가 자리 전체를 지운다 | R9·§6.1(`Resolved::Broken`, 행 단위 재계산) |
| 나눌 수 없는 run이 깨진 실패 칸 때문에 행을 잃는다 | R9·§6.1(실패 칸을 읽지 않음) |
| `resolve`가 분포를 매번 복사한다 | §6.1(빌려 주기) |
| 요청 없는 run을 화면이 어떻게 아나 | R16(`windows.length === 0`) |
| 비교 XLSX 열 번호 | §4.5 |
| `latency_rose` 입력을 인자 추가 없이 | §6.2 |

### 3차 검토 지적 처리 (2026-11-23)

| 지적 | 처리 |
|---|---|
| 화면 비교는 값 없음인데 내보내기는 0과 「−100%」를 쓴다 | R28 신설(내보내기도 빈 칸·Δ 없음, 골든 경우 추가) |
| §7의 `hasLatency` 소비처 목록이 짧다 | R17 목록 전부로 |
| 행 단위 재계산 뒤 `Empty`/`Broken` 구분 | §6.1 |
| 모든 요청 창 목록도 유지 구간으로 자르기 | §6.2 |

4차 검토(2026-11-23): **clean APPROVE**. plan에 넘길 메모(막는 것은 아님):

- 골든 테스트 `golden_summary_deltas_match`는 지금 「Δ가 없는 것은 기준 run뿐」을 단언한다. 「통과한 요청 없음」 경우를 더하려면 값 없음을 따로 표시해(예: `values[i] = null`) 기준 run의 Δ 없음과 구분한다.
- 골든 픽스처의 새 리포트에는 `sample`(`default: passed, split: true`)과 `errors == count`가 필요하다. 기준 run에 값이 없는 경우와 비교 run에 값이 없는 경우를 둘 다 둔다.
- 비교 XLSX의 Δ 열 카운터는 칸을 건너뛰어도 비교 run마다 올린다(쓰기와 묶으면 열이 밀린다 — `crates/controller/CLAUDE.md`의 Steps 시트 함정).
- 「Other basis」 시트도 `write_steps_table`을 쓴다 — 그 리포트의 `sample` 블록으로 같은 규칙을 적용한다.
