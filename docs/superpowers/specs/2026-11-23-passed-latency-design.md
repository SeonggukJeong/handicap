# 응답 시간 표본 — 통과한 요청 기준 + 실패한 요청 분리 (passed-latency) 설계

- 날짜: 2026-11-23
- 상태: 설계 초안
- 유형: `user-path`
- 출처: 사용자 결정 2026-11-23 — 「평균에 LoadRunner하고 동일하게 통과 트랜잭션만 평균내는게 맞지 않아?」 → 권장안(응답 시간 통계 전체를 통과한 요청 기준으로, 실패·전체도 볼 수 있게) 채택. roadmap §A17의 앞 단계다. 이 슬라이스 뒤에 verdict-stats A(`2026-11-23-verdict-stats-a-design.md`, 보류)를 그 위에서 다시 쓴다.
- 목업(시각 기준): `2026-11-23-passed-latency-mockups/screens.html` — 점선 테두리가 새로 생기는 것.
- 관련 결정: ADR-0012(워커 사전 집계 HDR), ADR-0027(워커별 메트릭 머지), ADR-0028(판정 기준), ADR-0059(계단 자동 정지), ADR-0061(유지 구간 기준 — `?basis=` 선례).
- ADR: **ADR-0063 신규** — 「응답 시간 표본: 통과한 요청 기준 + 실패 분포 분리」. 와이어(proto·DB)와 모든 응답 시간 숫자의 뜻이 바뀐다.
- 작업 브랜치: `worktree-verdict-stats`(verdict-stats A 설계 초안이 같은 브랜치에 있다 — 문서일 뿐이고 이 슬라이스와 함께 master에 들어간다).
- 릴리즈: 이 슬라이스 ↔ verdict-stats A ↔ B 사이에는 릴리즈하지 않는다. 릴리즈 노트에 「실패한 요청이 있었던 run은 응답 시간 숫자의 뜻이 달라졌다」를 적는다.

## 사용자 스토리 (US)

- **US1**: QA가 일부 요청이 실패한 run의 리포트를 연다 — 성공하면 요약·스텝별·시간대별 응답 시간이 통과한 요청만으로 계산되어 있고 「응답 시간은 통과한 요청만으로 계산했습니다」 표시가 보인다. 정상 응답 40ms에 즉시 실패(2ms)가 20% 섞여도 p50이 40ms 근처로 나온다.
- **US2**: QA가 리포트에서 응답 시간 표본을 「실패한 요청」이나 「전체」로 바꿔 본다 — 성공하면 요약 카드·스텝 표·시간대별 그래프의 응답 시간이 그 표본의 값으로 바뀌어, 실패한 요청이 얼마나 걸렸는지(시간 초과인지 즉시 실패인지)를 숫자로 본다.
- **US3**: QA가 응답 시간 판정 기준을 건 run에서 요청이 전부 실패한다 — 성공하면 그 기준이 통과로 나오지 않고 「통과한 요청 없음」으로 실패한다(지금은 0ms로 계산되어 통과).
- **US4**: QA가 계단 시험을 돌린다 — 성공하면 실행 중 계단 판정·자동 정지와 종료 뒤 계단 표가 모두 통과한 요청의 p99로 판정하고, 둘의 숫자가 같다.
- **US5**: QA가 이번 변경 전에 돌린 run을 연다 — 성공하면 응답 시간 숫자와 판정이 지금과 같고 「전체 (실패한 요청 포함)」 표시가 붙는다.

## 1. 배경

### 1.1 지금 상태 (2026-11-23, `38905b00` 기준 — 사실은 §11 명령으로 확인)

- **엔진** `crates/engine/src/aggregator.rs`: `StepWindow`(초·스텝 단위)에 분포 `histogram` 하나. `StepWindow::record(latency_us, status, is_error)`가 성공·실패를 가리지 않고 그 분포에 넣고, `is_error`면 `error_count`만 올린다. `record_not_sent`는 건수·오류만 올리고 표본을 남기지 않는다.
- **「오류」의 뜻** `crates/engine/src/executor.rs`·`runner.rs`: `is_error = outcome.error.is_some()`. 오류가 되는 경우는 보내기 실패(시간 초과 포함)·본문 읽기 실패·상태 코드 검사(`assert: status`) 불일치·값 추출 실패(엄격 모드). **상태 코드 검사가 없는 스텝에서는 4xx·5xx 응답도 오류가 아니다.**
- **와이어** `crates/proto/proto/coordinator.proto` `MetricWindow`: 필드 1–6, `hdr_histogram = 5`(V2 직렬화). 만드는 곳은 `crates/worker/src/lib.rs` `flush_to_batch` 하나(데스크톱·풀 부하기도 같은 함수).
- **저장** `run_metrics(run_id, ts_second, step_id, worker_id, count, error_count, hdr_histogram BLOB NOT NULL, status_counts)`. 마지막 마이그레이션 번호 0027.
- **읽는 곳**(스텝 창 분포를 디코드하는 운영 코드 — 전수 셋):
  1. `report.rs` `build_report`의 행 루프 → 초·스텝 창 분포, `overall`, `per_step`, 워커별 분포. 여기서 요약·스텝·창 목록·분포 곡선(`ReportJson.latency`)·속도 구간·워커별 표·판정·인사이트·유효성이 나온다.
  2. `stair.rs` `build_stair_report` → 종료 뒤 계단 표.
  3. `stair_monitor.rs` `StairMonitor::on_batch` → 실행 중 계단 판정·즉시 정지(들어오는 proto 배치를 직접 읽는다).
  2와 3은 `StairAccumulator`·`judge()`를 함께 쓴다. 표본이 없는 분포의 p99는 0으로 다룬다(`q()`).
- **기준 선택 선례** `steady.rs`·`api/runs.rs`: `?basis=steady|whole`, `build_reports_for_run`, 리포트의 `basis` 블록. 화면은 `BasisBar.tsx`(`Segmented`), `RunDetailPage.tsx`가 `?basis=`를 읽고 `useRunReport(id, terminal, basis)`에 넘긴다.
- **다른 분포들**(이번 범위 밖 — 실패가 섞인 채로 남는다): 준비 스텝(`run_section_step_metrics`), 병렬 묶음(`run_group_metrics`), 다운로드·대기 구간(`run_phase_metrics`), 조건 반복 분리(`loop_split`).
- **워커 버전**: `Register` 메시지에 버전이 없다. 컨트롤러는 부하기 버전을 모른다.

### 1.2 왜 바꾸나

빨리 실패하는 요청(연결 거부·즉시 오류)은 평균과 백분위를 낮추고, 시간 초과는 끌어올린다. 실패가 섞인 응답 시간은 「성공했을 때 얼마나 빠른가」도 「얼마나 실패하는가」도 말해 주지 못한다. 실패는 오류율이 따로 말한다. LoadRunner의 트랜잭션 응답 시간도 통과한 트랜잭션 기준이다.

### 1.3 목표가 아닌 것

- 준비 스텝·병렬 묶음·다운로드/대기 구간·조건 반복 분리의 통과/실패 나누기(사용자 결정 2026-11-23 — 표지를 붙이고 다음 일로).
- 내보내기·인쇄·비교를 「실패한 요청」·「전체」 표본으로 뽑기 — 이들은 기본 표본만 쓰고 어느 표본인지 적는다.
- 4xx·5xx를 기본으로 오류로 세기 — 「통과」의 뜻은 지금의 오류 판정을 따른다. 화면에 그 뜻을 적는다. 후보로 roadmap에 올린다(§10).
- 실행 중 화면의 응답 시간 차트(ADR-0051).

### 1.4 하면 안 되는 것

- 성공한 요청의 기록 경로에 일을 더하는 것(working-rules §10 — 워커 요청당 CPU).
- 이번 변경 전 run의 응답 시간 숫자·판정을 바꾸는 것(US5).
- 통과한 요청이 없는데 응답 시간을 0으로 찍거나 기준을 통과로 판정하는 것.
- 어느 표본인지 표시 없이 숫자를 보여 주는 것 — 화면·인쇄·내보내기·비교 모두.
- 실행 중 계단 판정과 종료 뒤 계단 표가 서로 다른 표본을 쓰는 것(같은 버전 부하기만 있는 run에서).

## 2. 요구사항 (R-id)

| ID | 요구사항 | acceptance | seam? |
|---|---|---|---|
| R1 | MUST 엔진이 실패한 요청의 응답 시간을 창마다 따로 모은다. 실패 분포는 그 창의 첫 실패 때 만들고, 성공한 요청의 경로에는 새 일이 없다. 전체 분포(`histogram`)는 지금과 같다. | 엔진 단위 테스트: 성공만 있는 창은 실패 분포가 없음 · 실패 표본 수 = 표본을 남긴 오류 수 · 전체 분포 불변. | |
| R2 | MUST 워커가 창마다 `MetricWindow.failed_hdr_histogram`(`optional bytes`, 필드 7)을 **항상** 싣는다 — 실패가 없으면 빈 바이트, 있으면 V2 직렬화. | 워커 단위 테스트 + 필드 번호 고정 테스트(`hand_built_batch_bytes_pin_field_numbers`) 갱신. | ✅ proto |
| R3 | MUST 컨트롤러가 그 값을 `run_metrics.failed_hdr_histogram`(BLOB, NULL 허용, 마이그레이션 0028)에 저장한다 — 필드가 없으면(옛 부하기) NULL, 빈 바이트면 빈 BLOB. 재시작해도 깨지지 않는다(멱등). | store 테스트: 세 경우 왕복 · 마이그레이션 두 번 실행. | ✅ DB |
| R4 | MUST run이 「나눌 수 있음」 = 그 run의 `run_metrics` 행이 하나 이상 있고 **모든** 행의 실패 칸이 NULL이 아님. 아니면 「나눌 수 없음」(옛 run·버전이 섞인 run). | 단위 테스트: 전부 있음 / 전부 NULL / 섞임 / 행 없음. | |
| R5 | MUST 표본 셋: `passed`(전체 − 실패), `failed`, `all`. 나눌 수 있는 run의 기본 표본은 `passed`, 나눌 수 없는 run은 `all`뿐. | 단위 테스트(분포 표본 수: 통과 + 실패 = 전체). | |
| R6 | MUST 리포트의 응답 시간 값 전부가 기본 표본에서 나온다: 요약(`mean_ms`·p50·p95·p99), 스텝별, 초별 창, 분포 곡선·히스토그램, 속도 구간, 워커별, 판정, 인사이트, 계단 표. 요청 수·오류 수·RPS·상태 코드 분포는 표본과 무관하다. | `build_report` 단위 테스트: 실패가 섞인 픽스처에서 통과 표본 값 = 손 계산. | |
| R7 | MUST 빼기(전체 − 실패)가 실패하거나 실패 칸 디코드가 실패하면 그 행의 분포를 버리고(지금의 깨진 BLOB 처리와 같게) 리포트는 계속 만든다. | 단위 테스트: 깨진 실패 BLOB. | |
| R8 | MUST 리포트 요청에 `?sample=passed\|failed\|all`을 받는다. 모르는 값·나눌 수 없는 run에 `passed`/`failed`를 요청하면 400 + 한국어 사유. `?basis=`와 함께 쓸 수 있다. | 통합 테스트. | ✅ REST |
| R9 | MUST 기본이 아닌 표본을 고르면 **응답 시간 숫자만** 그 표본으로 바뀐다: 요약 응답 시간·스텝별 응답 시간·초별 창 응답 시간·분포 곡선/히스토그램·워커별 응답 시간. 판정·인사이트·유효성·속도 구간·계단 표·`basis.other`는 기본 표본 그대로다. | 단위 테스트: 같은 run의 `sample=failed` 리포트에서 바뀌는 칸과 안 바뀌는 칸. | |
| R10 | MUST 리포트에 `sample: { selected, default, split }` 블록을 **항상** 싣는다(`split` = 나눌 수 있음). | 단위 테스트 + Zod `.strict()` 스키마. 골든 `testdata/report_whole_golden.json` 재생성 — 차이가 `sample` 키뿐임을 확인. | ✅ `ReportJson` ↔ Zod |
| R11 | MUST 나눌 수 없는 run의 리포트는 `sample` 블록 말고는 지금과 바이트 동일하고 판정도 같다(US5). | 기존 리포트·판정 테스트가 실패 칸 NULL 픽스처로 그대로 통과 + 골든 차이 확인(R10). | |
| R12 | MUST 표본이 `passed`일 때, 요청이 있었는데(`count > 0`) 통과 표본이 없으면 응답 시간 기준(run의 p50·p95·p99, 스텝의 `p50_ms`·`p95_ms`·`p99_ms`)은 `passed: false` + `no_sample: true` 행이 된다. `no_sample`은 참일 때만 직렬화한다. 요청이 0인 스텝은 지금처럼 건너뛴다. | `evaluate_criteria` 단위 테스트: 전부 실패한 run·스텝 / 요청 0 스텝 / 나눌 수 없는 run(지금 동작). | ✅ `CriterionResult` ↔ Zod |
| R13 | MUST 계단: 실행 중 감시(`StairMonitor`)와 종료 뒤 계단 표(`build_stair_report`)가 같은 규칙으로 표본을 고른다 — 창에 실패 분포 칸이 있으면 통과 표본, 없으면 전체. 한 함수를 함께 쓴다. 통과 표본이 없는 초·계단의 p99는 지금의 「표본 없음」과 같게 다룬다(0). | 단위 테스트: 같은 입력에서 감시 숫자 = 리포트 숫자(기존 `monitor_matches_report_for_completed_steps`를 실패 섞인 픽스처로 확장) · 실패만 있는 초의 p99. | |
| R14 | MUST 저장되는 목록 배지 판정(`persist_verdict`)이 기본 표본을 따른다(새 코드 없이 `build_report_for_run(.., None)` 경로로). | 단위 테스트: 실패가 섞인 run의 저장 판정 = 통과 표본 판정. | |
| R15 | MUST 화면 리포트 머리에 「응답 시간 표본」 줄을 둔다: 나눌 수 있는 run은 전환(통과한 요청 · 실패한 요청 · 전체) + 도움말 + 한 줄 설명, 나눌 수 없는 run은 전환 없이 「전체 (실패한 요청 포함)」 표지 + 설명. 선택은 URL `?sample=`에 남고 기본값이면 지운다. | RTL(`SampleBar`, `RunDetailPage`). | |
| R16 | MUST 기본이 아닌 표본을 보는 동안 「응답 시간 숫자만 바뀌었고 판정·인사이트·속도 구간·계단 표는 통과한 요청 기준 그대로」 안내를 보인다. | RTL. | |
| R17 | MUST 표본에 해당하는 요청이 없는 스텝의 응답 시간 칸은 「—」다: `passed`면 `count − error_count == 0`, `failed`면 `error_count − not_sent == 0`, `all`이면 지금 규칙(`count − not_sent == 0`). 요약 카드도 같다. | RTL(`StepStatsTable`, `Summary`). | |
| R18 | MUST 시간대별 응답 시간 그래프는 그 초에 표본에 해당하는 요청이 없으면 점을 찍지 않는다(0으로 내려가지 않게 선이 끊긴다). | 단위 테스트(`bySecond`) + RTL. | |
| R19 | MUST 판정 표·목록 배지 툴팁·인쇄 판정 행이 `no_sample` 행의 실측을 「통과한 요청 없음」으로 찍는다. | RTL·인쇄 테스트. | |
| R20 | MUST 나눌 수 있는 run에서, 아직 나누지 않은 구획(준비 스텝·병렬 묶음·분기·다운로드/대기 열과 구간 표·조건 반복 분리)에 「실패 포함」 표지를 단다. 나눌 수 없는 run에는 달지 않는다(머리 안내가 전체를 말한다). | RTL: 구획별 표지 유무. | |
| R21 | MUST 인쇄 보고서 머리와 내보내기(CSV 요약·XLSX Summary)에 응답 시간 표본을 한 줄로 적는다(「통과한 요청」 또는 「전체 (실패한 요청 포함)」). 인쇄·내보내기·비교는 기본 표본만 쓴다. | 인쇄 테스트 · export 테스트. | ✅ CSV/XLSX |
| R22 | MUST 비교 화면에서 고른 run들의 표본이 다르면(나눌 수 있는 run과 없는 run이 섞임) 안내를 보인다(`basisNotice` 선례). | 단위·RTL. | |
| R23 | MUST 워커 요청당 CPU가 기준(master) 대비 측정 가능한 만큼 늘지 않는다 — 전부 성공하는 시나리오에서. 실패가 많은 시나리오의 비용도 재서 기록한다. | `/perf-ab`: 기본 시나리오 「ranges OVERLAP」 + 실패 100% 시나리오 수치를 build-log에. | |
| R24 | SHOULD 도움말이 「통과」의 뜻을 말한다: 오류로 세지 않은 요청이고, 상태 코드 검사가 없는 스텝에서는 4xx·5xx 응답도 통과로 센다. | 문구 존재(RTL). | |

## 3. 설계 근거

1. **전체 분포는 그대로 두고 실패 분포를 더한다.** 반대(통과·실패 두 분포로 바꾸기)는 지금 `hdr_histogram`을 읽는 모든 곳과 옛 run의 뜻을 바꾼다. 더하기는 옛 데이터와 같은 모양이고, 통과 = 전체 − 실패는 같은 칸 구조의 HDR 사이에서 정확하다(`Histogram::subtract`).
2. **실패 분포는 첫 실패 때 만든다.** 창마다 미리 만들면 스텝·초마다 분포 하나의 할당이 는다. 대부분의 창은 실패가 없다.
3. **`optional bytes`로 「없음」과 「비어 있음」을 가른다.** proto3의 `bytes`는 없음과 빈 값이 같다. 컨트롤러는 부하기 버전을 모르므로, 옛 부하기가 보낸 창(필드 없음)과 새 부하기의 실패 없는 창(빈 바이트)을 창 단위로 갈라야 run이 나눌 수 있는지 안다. 빈 바이트는 창당 2바이트다. 빈 BLOB은 `decode_hdr`가 이미 「분포 없음」으로 읽는다.
4. **run 단위로 한 표본.** 행마다 표본이 다르면 합친 분포의 뜻이 없다. 한 행이라도 실패 칸이 NULL이면 run 전체를 「전체」로 계산한다. 계단의 실행 중 감시는 run 전체를 미리 알 수 없어 창 단위로 고른다 — 같은 버전 부하기만 있으면 둘이 같다(R13). 버전이 섞인 run에서는 실행 중과 종료 뒤가 다를 수 있다(§10에 기록).
5. **표본 전환은 「숫자 보기」 전용.** 실패한 요청의 속도 구간·인사이트·판정은 뜻이 없다. 판정은 통과한 요청으로 한다는 사용자 결정과도 맞는다. 그래서 기본이 아닌 표본의 리포트는 기본 리포트에 응답 시간 칸만 바꿔 끼운다(R9).
6. **통과한 요청 없음 = 실패.** 지금은 표본이 없으면 p95가 0이라 「≤ 3000ms」가 통과한다. 요청이 전부 실패한 run이 응답 시간 기준을 통과하면 안 된다. 나눌 수 없는 run은 지금 동작 그대로 둔다(US5).
7. **통과한 요청 수는 새 칸 없이 구한다.** 통과 = `count − error_count`, 표본을 남긴 실패 = `error_count − not_sent`. 화면의 「—」 규칙(R17)이 이 식을 쓴다.
8. **내보내기·인쇄·비교는 기본 표본만.** 표본 × 기준 × 형식의 조합을 다 만들면 표면이 커진다. 필요한 것은 「이 숫자가 어느 표본인가」를 적는 것이다.

### 접근 비교

| 안 | 내용 | 판단 |
|---|---|---|
| **가 (채택)** | 워커가 실패 분포를 따로 보내고 컨트롤러가 전체 − 실패로 통과 표본을 만든다. 기본 = 통과. | 성공 경로 비용 0. 옛 run과 같은 저장 모양. 세 표본 모두 볼 수 있다. |
| 나 | 워커가 통과 분포만 보낸다(실패한 요청의 시간은 버린다). | 가장 작다. 실패한 요청이 얼마나 걸렸는지(시간 초과 vs 즉시 실패)를 잃는다 — US2 불가. |
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

`MetricWindow { … }` 리터럴 전부(워커 2, 컨트롤러 테스트 7)에 새 칸을 명시한다(prost는 `..Default::default()`가 안 통한다).

### 4.2 DB (마이그레이션 0028)

`ALTER TABLE run_metrics ADD COLUMN failed_hdr_histogram BLOB` — `pragma_table_info`로 칸이 없을 때만(`ensure_runs_dropped` 패턴, `/new-migration` 사용). 쓰기·읽기: `MetricRow`·`WindowWithHdr`에 `failed_hdr_histogram: Option<Vec<u8>>`, `insert_batch`·`windows_with_hdr`의 칸 목록.

### 4.3 REST

- `GET /api/runs/{id}/report?sample=passed|failed|all[&basis=…]`. 없으면 기본 표본.
- 내보내기·인사이트 CSV·계단 CSV·비교 라우트는 `sample`을 받지 않는다(기본 표본).

### 4.4 리포트 JSON

```jsonc
"sample": { "selected": "passed", "default": "passed", "split": true }   // 옛 run: all / all / false
"verdict": { "criteria": [ { "metric": "p95_ms", "direction": "max", "threshold": 3000, "actual": 0, "passed": false, "no_sample": true } ] }
```

- Rust: `SampleBlock { selected: Sample, default: Sample, split: bool }`, `Sample`은 `snake_case` 직렬화(`passed`·`failed`·`all`). `ReportJson.sample`은 `Option`이 아니다(항상 있음). 역직렬화 기본값은 `all/all/false`(`#[serde(default)]` — 옛 골든·픽스처 호환).
- `CriterionResult.no_sample: bool` + `#[serde(default, skip_serializing_if = "std::ops::Not::not")]`.
- Zod: `ReportSampleSchema`(`.strict()`), `ReportSchema.sample`(서버가 항상 보내지만 옛 픽스처를 위해 `.optional()` — 없으면 `all/all/false`로 본다), `CriterionResultSchema.no_sample: z.boolean().optional()`.

### 4.5 내보내기

CSV 요약 구획과 XLSX Summary 시트에 `latency_sample` 행 하나(값 `passed` 또는 `all`). 비교 CSV/XLSX는 run마다 같은 값을 Runs 시트·요약에 싣는다(기준 `basis_label` 선례 옆).

## 5. 엔진·워커

- `StepWindow`에 `failed_histogram: Option<Histogram<u64>>`. `record`: `is_error`일 때만 `get_or_insert_with`로 만들고 같은 값(1..=60,000,000µs로 자른 값)을 넣는다. `record_not_sent`는 그대로(표본 없음).
- `serialize_failed_histogram() -> Result<Vec<u8>>`: 없으면 빈 벡터.
- `flush_to_batch`: `failed_hdr_histogram: Some(bytes)`. 전체 분포 직렬화가 실패해 창을 건너뛰는 지금 동작은 그대로이고, 실패 분포 직렬화가 실패하면 그 창도 건너뛴다(반쪽 창을 보내지 않는다).
- 빈 배치 건너뛰기 가드는 바뀌지 않는다(실패 분포는 창 안에 있다).
- `StepWindow { … }` 리터럴(워커 테스트 1곳)에 새 칸.

## 6. 컨트롤러

### 6.1 표본 고르기 — 한 함수 (`sample.rs` 새 모듈)

```rust
pub enum Sample { Passed, Failed, All }
/// 한 창의 분포를 표본에 맞게 돌려준다. 디코드·빼기 실패는 Err.
pub fn window_hist(all: &[u8], failed: Option<&[u8]>, sample: Sample) -> Result<Option<Histogram<u64>>, …>
pub fn run_is_split(rows: &[WindowWithHdr]) -> bool   // R4
```

- `All`: 전체만 디코드(지금과 같은 일).
- `Failed`: 실패 칸이 비었으면 `None`, 아니면 디코드.
- `Passed`: 전체 디코드, 실패 칸이 비어 있지 않으면 디코드해서 뺀다. 실패가 없는 창(대부분)은 지금과 같은 일만 한다.
- `build_report`·`build_stair_report`·`StairMonitor::on_batch`가 이 함수를 쓴다(R13).

### 6.2 `build_report`

- 인자에 `sample: Sample`. 행 루프의 `decode_hdr(&r.hdr_histogram)` 자리를 `window_hist(...)`로 바꾼다. 그 뒤(`overall`·`per_step`·창·워커별)는 그대로 흘러간다(R6).
- `evaluate_criteria`에 「통과 표본으로 판정 중인가」와 표본 수를 넘겨 R12를 판정한다(run: `overall` 표본 수, 스텝: 그 스텝 분포 표본 수).
- `build_stair_report`에는 run의 기본 표본을 넘긴다.

### 6.3 표본 선택 (`api/runs.rs`)

- `build_reports_for_run(db, run_id, basis, sample)`:
  1. 행을 읽고 `run_is_split`으로 기본 표본을 정한다.
  2. 기본 표본으로 리포트를 만든다(지금의 기준 처리 그대로).
  3. 요청 표본이 기본과 다르면 그 표본으로 한 번 더 만들고, **기본 리포트에 응답 시간 칸만 옮겨 끼운다**(`graft_latency(default, selected)` — 옮기는 칸: `summary.{mean_ms,p50_ms,p95_ms,p99_ms}`, `steps[].{p50_ms,p95_ms,p99_ms}`, `windows[].{p50_ms,p95_ms,p99_ms}`, `latency`, 워커별 응답 시간). 스텝·창은 id와 초로 짝짓는다.
  4. `sample` 블록을 채운다.
- 기본 표본 요청(대부분)은 리포트를 한 번만 만든다 — 지금과 같은 비용에 실패가 있는 창의 디코드·빼기만 더해진다.
- `parse_sample`은 `parse_basis` 옆에 둔다. 내보내기·`persist_verdict`·비교는 `None`(기본).

### 6.4 계단 감시 (`stair_monitor.rs`)

`on_batch`가 창마다 `window_hist(&win.hdr_histogram, win.failed_hdr_histogram.as_deref(), …)`를 쓴다 — 필드가 있으면 `Passed`, 없으면 `All`. 즉시 정지의 p99와 계단 판정 입력이 함께 바뀐다. 실패가 몰려 통과 표본이 줄면 p99 규칙은 조용해지고 오류율 규칙이 잡는다(지금도 둘 다 있다).

### 6.5 건드리지 않는 것

준비 스텝·병렬 묶음·구간·조건 반복 분리의 분포, `metrics::summary`(실행 중 폴링 — 분포를 읽지 않는다), 모니터·TUI(trace 경로), 스케줄러.

## 7. 화면 (목업이 시각 기준)

- **`SampleBar`**(새 부품, `BasisBar` 옆·아래): 목업 1–3. `Segmented` 재사용. 도움말 문구는 R24.
- **`RunDetailPage`**: `?sample=`을 읽어 `useRunReport(id, terminal, basis, sample)`에 넘기고, 고르면 URL을 바꾼다(기본값이면 지운다). 쿼리 키에 표본을 더한다.
- **`ReportView`**: 기본이 아닌 표본이면 안내(R16)를 `SampleBar` 아래에 붙인다. 내보내기·인쇄 링크는 표본을 싣지 않는다.
- **`Summary`·`StepStatsTable`**: 「—」 규칙(R17)에 표본을 넘긴다.
- **`bySecond`·`TimeSeriesChart`**: 표본에 해당하는 요청이 없는 초는 값 없음 → 선이 끊긴다(R18). 지금 차트 부품이 값 없음을 받는지 plan에서 확인하고, 안 받으면 받게 한다.
- **`VerdictPanel`·`VerdictBadge`(`verdictFormat`)**: `no_sample` 행(R19).
- **「실패 포함」 표지**(`MixedSampleBadge`, `WholeRunBadge`와 같은 모양): `SetupSection`·`GroupLatencyTable`·`BranchStatsTable`·`StepStatsTable`의 대기/다운로드 열 머리·`StepPhaseBreakdown`의 구간 표·조건 반복 분리 행. `report.sample.split`이 참일 때만(R20). 소비처는 plan에서 `grep`으로 전수 확인한다.
- **인쇄**: 머리(`ReportHeader`)에 표본 한 줄(R21), 판정 행 `no_sample`(R19).
- **비교**: `sampleNotice`(R22) — `ScenarioComparePage`·비교 인쇄.
- 문구는 전부 `ko.ts` 경유. 용어: 「통과한 요청」·「실패한 요청」·「전체」. 「표본」은 줄 이름(「응답 시간 표본」)에만 쓰고 도움말에서 풀어 쓴다.
- 진입 화면: run 상세(종료 run)·인쇄 미리보기·비교. 실행 중 run 상세의 계단 패널(US4).

## 8. 성능 (working-rules §10)

- 워커: 성공 경로는 `if is_error` 분기(지금도 있다)뿐. 실패 경로는 분포 기록 한 번 + 창의 첫 실패 때 할당 한 번. 직렬화는 실패가 있는 창만. `/perf-ab`(기준 master)로 ① 기본 시나리오(전부 200) ② 상태 코드 검사가 전부 실패하는 시나리오(`--scenario`)를 잰다(R23).
- 컨트롤러: 리포트 빌드에서 실패가 있는 창만 디코드·빼기가 는다. 계단 감시는 배치마다 같은 일 — `monitor_batch_cost_*`(`#[ignore]` 성능 테스트)를 실패가 섞인 입력으로 한 번 돌려 기록한다.
- 저장: 창당 실패 없으면 0바이트 BLOB, 있으면 분포 하나.

## 9. 테스트·검증

- 단위·통합: R1–R22의 acceptance. 회귀 가드로 쓰는 테스트(R1 성공 경로에 실패 분포 없음, R11, R12, R13 감시 = 리포트)는 되돌려 확인을 한다.
- 구조체 리터럴 변경(컴파일러가 잡는다): `MetricWindow`·`MetricRow`·`WindowWithHdr`·`StepWindow`·`CriterionResult`·`ReportJson`. `cargo build --workspace --tests` + bundle 기능 빌드.
- 골든: `testdata/report_whole_golden.json` 재생성, `testdata/compare_golden.json`은 역직렬화 기본값으로 그대로 읽히는지 확인.
- 라이브(US-anchored, `/live-verify` — 응답기는 keep-alive):

| US | 절차 | 통과 신호 |
|---|---|---|
| US1 | 응답기: 80%는 40ms 뒤 200, 20%는 즉시 500. 시나리오에 `assert: status 200` | 리포트 p50 ≈ 40ms(전체로 바꾸면 더 낮다) · 머리 표시 |
| US2 | 같은 run에서 「실패한 요청」·「전체」 전환 + 일부를 요청 타임아웃에 걸리게 | 실패 표본 p50 ≈ 수 ms, p99 ≈ 타임아웃 · 스텝 표·그래프도 바뀜 · 판정은 그대로 |
| US3 | 전부 500인 응답기 + `max_p95_ms` 기준 | 판정 표 「통과한 요청 없음」 ✗ · 목록 배지 실패 · 스텝 표 「—」 · 그래프 끊김 |
| US4 | 계단 run, 중간 계단부터 일부 즉시 실패 | 실행 중 패널의 p99와 종료 뒤 계단 표의 p99가 같고 통과 표본 값 |
| US5 | 이번 변경 전 DB 사본의 run 열기 | 숫자·판정 동일(변경 전 리포트 JSON과 대조) · 「전체 (실패한 요청 포함)」 |

- 극단값: 스텝 수십 개·긴 이름에서 `SampleBar`·표지의 겹침·잘림. 좁은 폭.
- 보안 게이트: 요청 실행 경로(엔진 기록)를 건드린다 → `finish-slice` §0 grep을 돌리고 매치하면 `security-reviewer`.
- 코드 리뷰 모델: 엔진·proto·마이그레이션 task는 Opus.

## 10. 연기 (roadmap §B에 옮길 것)

| 항목 | 왜 미루나 | 틀렸을 때 비용 | 푸는 길 |
|---|---|---|---|
| 준비 스텝·병렬 묶음·다운로드/대기·조건 반복 분리의 통과/실패 나누기 | 분포가 다른 메시지·표로 온다(사용자 결정 2026-11-23) | 그 구획은 실패가 섞인 값 — 「실패 포함」 표지로 알린다 | 각 통계에 실패 분포를 같은 방식으로 |
| 내보내기·인쇄·비교를 다른 표본으로 | 조합이 많다 | 실패한 요청의 시간은 화면에서만 본다 | 라우트에 `?sample=` |
| 4xx·5xx를 기본으로 오류로 세기 | 「오류」의 뜻을 바꾸는 별도 결정 | 상태 코드 검사가 없는 스텝은 즉시 500도 「통과」로 평균에 들어간다 — 도움말로 알린다 | 스텝 기본 검사 옵션(roadmap §A 후보) |
| 버전이 섞인 run | 드물다 | run 전체가 「전체」로 계산되고, 계단의 실행 중 판정(창 단위)과 종료 뒤 표가 다를 수 있다 | 등록 때 버전·기능 표시 |
| 통과 표본 없는 초·계단의 p99 = 0 | 지금 계단 동작 유지 | 전부 실패한 계단의 p99 규칙은 조용하다(오류율 규칙이 잡는다) | 계단 숫자에 「표본 없음」 표현 |

## 11. 사실 확인 명령 (claims-ledger)

```bash
# 엔진 기록 경로·오류 뜻
grep -n "pub struct StepWindow" -A 8 crates/engine/src/aggregator.rs
grep -n "pub fn record(&mut self, latency_us" -A 9 crates/engine/src/aggregator.rs
grep -n "outcome.error.is_some()" crates/engine/src/runner.rs
grep -n "Assertion::Status" crates/engine/src/executor.rs
# 와이어·생산자(전수)
grep -n "message MetricWindow" -A 8 crates/proto/proto/coordinator.proto
grep -rn "MetricWindow {" crates/
grep -rn "StepWindow {" crates/
# 저장
grep -n "run_metrics" crates/controller/src/store/mod.rs
grep -n "MIGRATION_SQL_00\|async fn ensure_" crates/controller/src/store/mod.rs
grep -rn "MetricRow {\|WindowWithHdr {" crates/controller --include='*.rs' -l
# 스텝 창 분포를 디코드하는 곳(전수)
grep -rn "decode_hdr(&" crates/controller/src
grep -rn "hdr_histogram" crates --include='*.rs' -l
# 계단 공유 코드·표본 없음
grep -n "fn q(" -A 3 crates/controller/src/stair.rs
grep -n "StairAccumulator::new" crates/controller/src/stair_monitor.rs crates/controller/src/stair.rs
# 기준 선례
grep -n "fn parse_basis\|fn build_reports_for_run\|fn build_report_for_run\|fn persist_verdict" -r crates/controller/src
grep -rn "basisQuery\|useRunReport\|BasisBar" ui/src --include='*.ts' --include='*.tsx' -l
# 빈 BLOB = 분포 없음
grep -n "pub fn decode_hdr" -A 4 crates/engine/src/percentiles.rs
# HDR 빼기
grep -n "pub fn subtract" ~/.cargo/registry/src/*/hdrhistogram-7*/src/lib.rs
# 버전 필드 없음
grep -n "message Register" -A 9 crates/proto/proto/coordinator.proto
```
