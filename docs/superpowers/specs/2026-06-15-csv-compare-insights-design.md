# CSV / Compare 인사이트 표면화 — 이미 계산된 `insights[]`를 export·비교 4표면에 노출 (A4c/B7 연기 항목)

- **날짜**: 2026-06-15
- **상태**: 설계 승인(사용자 2026-06-15) → spec 작성
- **출처**: roadmap §A4c / §B7 연기 항목 "CSV/compare 인사이트". **왜 지금**: 사용자가 "작고 가치 높은" 후속으로 지목 — 리포트를 공유(CSV 적재·다중 run 비교)할 때 actionable 인사이트(느린 스텝·에러 핫스팟·SLO 실패·포화)가 사라지고 raw 숫자만 남는 갭. 데이터는 이미 `ReportJson.insights[]`에 존재(신규 계산 0)이라 순수 표면 확장.
- **연관**: ADR-0030(run 비교 + CSV/XLSX export), ADR-0028/A4c(`insights.rs` `derive_insights`), 선행 "XLSX Insights 사이징 3열"(2026-06-15, `report_to_xlsx` Insights 시트) · A9 cause-attribution(`onset_second` 도입). 파일: `crates/controller/src/export.rs`, `crates/controller/src/api/runs.rs`, `ui/src/pages/ScenarioComparePage.tsx`, `ui/src/components/compare/`.
- **ADR**: 신규 불필요(ADR-0030 export + ADR-0028 insights 범위 내 additive). 신규 아키텍처 결정 없음 — 기존 구조화 인사이트를 기존 export/비교 표면에 펼치는 가산.

---

## 1. 문제와 목표

인사이트(`derive_insights` → `ReportJson.insights[]`)는 현재 **단일-run 화면(`InsightPanel`)** 과 **단일-run XLSX `Insights` 시트** 두 곳에만 표면화된다. 같은 데이터가 ① 단일-run **CSV**, ② **비교 화면**, ③ 비교 **CSV**, ④ 비교 **XLSX** 네 표면에서 버려진다 — 리포트를 적재/공유하는 바로 그 순간 "무엇이 문제인가"가 숫자와 함께 따라가지 못한다. 데이터·계산은 이미 있으므로 이 슬라이스는 **표면화만** 한다.

- **목표**: 4표면에 인사이트 노출. CSV는 기계 적재(read_csv/BI) 친화 = **별도 깨끗한 단일 테이블 파일**. 비교 화면은 페이지 기존 관용구(`CompareMatrix` = metric×run)와 일관된 **kind×run 매트릭스**. 4 export 표면이 **단일 정규 컬럼 셋**을 공유(드리프트 차단)하며, 그 부산물로 기존 단일 XLSX 시트의 `onset_second` 누락 갭을 해소.
- **비목표(연기)**: §7. 요약 — 비교 화면 run별 패널 나열·회귀-인식 diff·CSV 스키마 정규화.

---

## 2. 요구사항 (정규 — R-id) ⟵ 척추

| ID | 요구사항 (MUST/SHOULD, 한 문장) | acceptance (충족 확인법) | seam? |
|---|---|---|---|
| R1 | MUST 단일-run 인사이트를 별도 CSV(`report_to_insights_csv`)로 export하고 라우트 `GET /api/runs/{id}/report-insights.csv`(파일 `run-{id}-insights.csv`)로 다운로드한다 — 정규 13열, 행 = 인사이트 1개. | `cargo test` export 단언(헤더 13열 + 행/인사이트) + 라우트 200/Content-Disposition | ✅ CSV 와이어 + 신규 라우트 |
| R2 | MUST 비교 인사이트를 별도 CSV(`comparison_to_insights_csv`)로 export하고 라우트 `GET /api/scenarios/{id}/runs/compare-insights.csv?run_ids=…&baseline=…`(파일 `comparison-insights.csv`)로 다운로드한다 — `run_id` prepend한 14열 long-format, 행 = (run, insight) 하나. | `cargo test` 단언(헤더 `run_id`+13열, run당 N행) + 라우트 200 | ✅ CSV 와이어 + 신규 라우트 |
| R3 | MUST `comparison_to_xlsx`에 `Insights` 시트(14열, `run_id` prepend long-format)를 추가한다 — 어느 run이라도 인사이트가 있을 때만 시트 추가(기존 단일 XLSX 조건부와 일관). | calamine 라운드트립 테스트(비교 XLSX에 `Insights` 시트 + 행 == Σ run insights) | ✅ XLSX 직렬화 |
| R4 | MUST 기존 단일-run XLSX `Insights` 시트에 `onset_second` 열을 추가한다(정규 컬럼 셋 채택 부산물 = A9 cause-attribution 도입 후 누락 갭 해소). 기존 12열 순서·내용은 보존(append만). | calamine 라운드트립 테스트가 `onset_second` 열 + 값 확인; 기존 12열 단언 무변경 통과 | ✅ XLSX 직렬화 |
| R5 | MUST(불변식/parity) 4 export 표면이 **단일 소스 정규 컬럼 셋**을 공유한다 — 단일 표면 = 13열, 비교 표면 = `run_id` + 동일 13열, 동일 순서·동일 None→빈칸 규칙. 헤더·행 writer는 한 const + 공유 헬퍼에서 파생. | export 테스트: 단일 CSV 헤더 ≡ 단일 XLSX 헤더 ≡ (비교 CSV 헤더 minus `run_id`); 헬퍼 1곳 정의 확인 | ✅ 4표면 공유 계약 |
| R6 | MUST 비교 화면에 `InsightCompareMatrix`(kind×run 그리드)를 `ScenarioComparePage`의 `CompareMatrix` 아래 렌더한다 — 행 = 비교 run들의 distinct 인사이트 identity 합집합, 열 = 각 run, 셀 = 보유 시 severity 배지 + 대표 수치(있을 때, 상세 규칙 R12) / 미보유 시 `—`. | RTL: union 행 수·셀 severity/수치·미보유 `—` | |
| R7 | MUST(스키마 불변) 비교 화면 매트릭스는 클라가 이미 fetch한 각 run `/report` 응답의 `insights`를 재사용한다 — UI Zod(`InsightSchema`/`ReportSchema`)·서버 응답·proto·migration **무변경**. | `git diff`로 와이어/스키마 변경 0 관찰; 기존 `ReportSchema` 무수정 | ✅ 와이어 무변경(명시) |
| R8 | MUST 행 identity = `kind` + 판별자(`step_id ?? status_class ?? ∅`)로 같은 kind라도 step/class별 별 행이 되게 하고, 행 순서 = run들의 인사이트 배열 등장 순서(= 백엔드 `order_rank` 정렬) 합집합 first-seen. | RTL: `status_class`(4xx/5xx)·step-scoped 인사이트가 별 행; 순서 결정적 | |
| R9 | MUST(byte-identical 보존) 기존 4 export — `report.csv`(per-step)·`comparison.csv`(summary matrix)·`comparison.xlsx` 기존 3시트(Summary/Steps/Runs)·`report.xlsx` 비-Insights 시트 — 는 무변경. 단일 XLSX `Insights` 시트는 R4의 `onset_second` 1열 append 외 불변. | 기존 export 테스트 무수정 통과 | |
| R10 | MUST 단일 리포트 뷰 + 비교 페이지에 신규 인사이트 CSV 다운로드 버튼을 각 1개 추가한다(기존 `report.csv`/`comparison.csv` 버튼 미러: `client.ts` URL 빌더 + `downloadFile`). | RTL: 버튼 클릭 → 올바른 URL/파일명으로 `downloadFile` 호출 | |
| R11 | SHOULD 빈 상태 — 인사이트 CSV(단일·비교)는 인사이트가 없어도 **항상 헤더 행을 emit**(0바이트 다운로드 방지); 비교 화면 매트릭스는 합집합이 비면 "인사이트 없음" 빈 상태를 보인다. | export 테스트(인사이트 0 → 헤더만) + RTL(빈 매트릭스) | |
| R12 | MUST 매트릭스 셀은 인사이트 **보유 시 severity 배지를 항상** 표시(= 보유 신호)하고, 대표 수치는 `value ?? pct(%) ?? count ?? window_seconds(="Ns")` 중 첫 non-null이 있을 때만 배지 옆에 병기(없으면 배지만; numberless = `slo_pass`·`no_request_step`) — **미보유 시 `—`(배지 없음)** 로 보유/미보유를 명확히 구분한다. 행 라벨: step-scoped kind의 step 이름은 페이지 기존 `stepLabelMap`(id→label, 없으면 raw `step_id`), kind 라벨은 **신규** kind→짧은-라벨 맵(`ko.ts` 신설, 기존 `message()`/`insightActions` 재사용 아님). | RTL: numberless 인사이트(slo_pass·no_request_step) = 배지만·미보유 = `—`·step 라벨 매핑·kind 라벨 | |

- **`seam ✅`** = CSV/XLSX 와이어·라우트·UI Zod 경계. plan은 export 함수 + 라우트를 **같은/인접 커밋**으로 묶고(한쪽만 머지 = 깨진 다운로드), 최종 `handicap-reviewer`가 정규 컬럼 셋을 4표면 1:1 대조. R7은 "와이어를 **안** 건드린다"는 음(陰)의 seam — 리뷰가 변경 0을 확인.

---

## 3. 핵심 통찰 (설계 근거)

1. **CSV = 기계 적재용이므로 별도 단일 테이블 파일(R1/R2).** 한 파일에 컬럼 수가 다른 두 테이블(per-step + insights)을 빈 줄로 잇는 multi-section CSV는 `pandas.read_csv`/`read.csv`/BI 임포트를 전부 깨뜨린다(첫 헤더로 스키마 고정 후 둘째 테이블을 욱여넣어 NaN 범벅). 사람용 풍부 뷰는 XLSX `Insights` 시트·화면이 이미 담당하니, CSV는 tidy-data 원칙(파일당 1 직사각형 테이블)을 따른다. 비용 = 기존 2 CSV 라우트를 미러한 +2 라우트 +2 버튼(기계적 가산).
2. **정규 컬럼 셋 단일 소스(R5)가 이 슬라이스의 척추.** 4표면이 같은 `INSIGHT_COLUMNS` const + 공유 행-writer(CSV용 `Vec<String>` 생성, XLSX용 typed-cell 쓰기)를 쓰면 표면 간 컬럼 드리프트가 구조적으로 불가능해지고, 기존 단일 XLSX 시트를 그 헬퍼로 리팩터하는 순간 `onset_second`(R4)가 자동으로 채워진다 — 갭 해소를 별도 작업이 아니라 일관화의 부산물로 흡수.
3. **비교 화면은 페이지의 기존 관용구를 따른다(R6/R8).** `ScenarioComparePage`는 이미 `CompareMatrix`(metric × run)다. 인사이트도 "kind × run" 매트릭스로 병치하면 학습 비용 0이고 N=2~5 run에 컴팩트하다. 행 identity에 판별자(step_id/status_class)를 더하는 이유: `slowest_step`·`error_hotspot`(step별)·`status_class`(4xx/5xx별)는 같은 kind라도 *서로 다른 것을 가리키므로* 한 행으로 합치면 "어느 스텝/클래스가 어느 run에서 떴나"를 잃는다.
4. **신규 계산·신규 의미론 0(R7).** 클라는 비교 시 이미 각 run `/report`를 fetch하고 그 응답엔 `insights`가 들어 있다(단일-run 리포트가 이미 소비). 매트릭스는 그걸 pivot만 한다 — 회귀-인식 diff("candidate에만 있는 경고")는 *새 의미론*이라 의도적 비목표(§7). 이로써 와이어/스키마 변경 0 = S-D 갭(서버 응답경로 Zod 미스매치) 위험도 낮음.

---

## 4. 변경 상세

### 4.1 `crates/controller/src/export.rs` — 정규 컬럼 셋 + 공유 행-writer — 충족 R: R5, R4

- `const INSIGHT_COLUMNS: [&str; 13]` = `["kind","severity","step_id","metric","value","pct","count","status_class","window_seconds","recommended","cause","recommended_workers","onset_second"]` — 4표면 헤더 단일 소스.
- `fn insight_csv_cells(ins: &Insight) -> Vec<String>` (len 13) — `Option`은 빈 문자열, 숫자는 `to_string`/`{:.6}` 등 기존 포맷 관례 유지.
- `fn write_insight_xlsx_cells(ws, row, col_offset, ins)` — 13필드를 col_offset+i에 **타입별**(string vs number) 쓰기, `None`은 빈 셀(skip). 기존 단일 XLSX writer의 typed-cell 동작을 헬퍼로 추출.
- 기존 `report_to_xlsx`의 `Insights` 시트를 위 두 헬퍼로 리팩터 → `onset_second`(R4) 자동 포함, 헤더 = `INSIGHT_COLUMNS`.

### 4.2 `crates/controller/src/export.rs` — 단일 인사이트 CSV — 충족 R: R1, R11

`pub fn report_to_insights_csv(report: &ReportJson) -> Vec<u8>`: 헤더 = `INSIGHT_COLUMNS`(항상), 각 `report.insights`에 대해 `insight_csv_cells` 행. 인사이트 0이면 헤더만.

### 4.3 `crates/controller/src/export.rs` — 비교 인사이트 CSV + 비교 XLSX 시트 — 충족 R: R2, R3, R11

- `pub fn comparison_to_insights_csv(reports: &[ReportJson]) -> Vec<u8>`: 헤더 = `["run_id"] ++ INSIGHT_COLUMNS`, 각 run의 각 인사이트마다 `[run.id] ++ insight_csv_cells` 행. baseline 무관(인사이트엔 delta 의미 없음). 인사이트 0이면 헤더만.
- `comparison_to_xlsx`에 `Insights` 시트 추가(R3): 헤더 = `["run_id"] ++ INSIGHT_COLUMNS`(run_id col 0 = string), 각 run의 각 인사이트는 `write_insight_xlsx_cells(col_offset=1)`. **어느 run이라도 인사이트 있을 때만** 시트 add(`reports.iter().any(|r| !r.insights.is_empty())`).

### 4.4 `crates/controller/src/api/runs.rs` — 신규 2 라우트 — 충족 R: R1, R2

- `GET /api/runs/{id}/report-insights.csv` → 기존 단일 export 핸들러 패턴 미러(완료 run만, `build_report` 재사용) → `report_to_insights_csv` → CSV bytes + `Content-Disposition: attachment; filename="run-{id}-insights.csv"`.
- `GET /api/scenarios/{id}/runs/compare-insights.csv?run_ids=…&baseline=…` → 기존 비교 export 핸들러 패턴 미러(같은 시나리오·terminal-only·N 상한 검증 재사용) → `comparison_to_insights_csv` → `comparison-insights.csv`.
- 라우터 등록은 기존 `report.csv`/`compare.csv` 라우트 옆.

### 4.5 `ui/src/api/client.ts` — URL 빌더 2개 — 충족 R: R10

`reportInsightsCsvUrl(runId)` · `compareInsightsCsvUrl(scenarioId, runIds, baseline)` — 기존 `reportCsvUrl`/`compareCsvUrl` 미러. **주의**: 비교 라우트는 `resolve_comparison`의 게이트를 재사용하므로 `baseline`이 **필수**(∈ run_ids)다 — deser 필드 `runs.rs:722`, 거부 게이트 `runs.rs:754-757`. 내용상 baseline을 안 쓰더라도 누락/무효면 400. 비교 페이지는 이미 baseline을 들고 있어(기존 compare.csv 버튼과 동일 입력) 자연 충족.

### 4.6 `ui/src/components/compare/InsightCompareMatrix.tsx` (신규) — kind×run — 충족 R: R6, R8, R11, R12

- props: `reports: Report[]`(각 `.insights`·`.run.id` 보유) + `stepLabelMap: Map<string,string>`(페이지가 이미 보유, `ScenarioComparePage.tsx:119-130`).
- **identity 합집합**(R8): run 배열 순회(각 run의 `insights`는 백엔드 `order_rank` 순 — `insights.rs:273` sort 검증됨) → `key = ${kind}|${step_id ?? status_class ?? ''}`, first-seen 순서로 행 수집. 충돌 없음 검증됨(`slo_*`/`load_gen_saturated`만 빈 판별자지만 kind가 서로 달라 unique, `no_request_step`은 dedup된 step_id별, `status_class`는 4xx/5xx별).
- **행 라벨**(R12): kind 라벨 = **신규** kind→짧은-라벨 맵(`ko.ts`에 신설 — 기존 `message()`는 `meta:Map<id,StepMeta>`가 필요한 *전체 산문*, `insightActions`는 *행동 문장*이라 둘 다 짧은 라벨로 부적합). step-scoped kind(`slowest_step`/`error_hotspot`/`no_request_step`)는 `stepLabelMap.get(step_id) ?? step_id`로 step 이름 병기; `status_class`는 판별자(4xx/5xx) 병기.
- **셀**(R12): 그 run이 해당 identity 보유 → severity 배지(critical/warning/info)를 **항상** 표시(보유 신호) + 대표 수치 `value ?? pct(%) ?? count ?? window_seconds("Ns")` 중 첫 non-null이 있으면 병기(numberless인 `slo_pass`·`no_request_step`은 배지만). 미보유 → `—`(배지 없음). 이로써 "보유·수치없음"(배지)과 "미보유"(`—`)가 구분됨.
- 합집합 비면 "인사이트 없음" 빈 상태(R11).

### 4.7 `ui/src/pages/ScenarioComparePage.tsx` + 단일 리포트 뷰 — 충족 R: R6, R10

- 비교 페이지: 신규 인사이트 CSV 다운로드 버튼(기존 comparison.csv 버튼 미러) + `<InsightCompareMatrix reports={…}/>`를 `<CompareMatrix>` 아래 배치.
- 단일 리포트 뷰(기존 report.csv/xlsx 버튼 위치): 인사이트 CSV 다운로드 버튼 1개 추가.

---

## 5. 무변경 / 불변식 (명시)

- **엔진·워커·proto·migration 무변경.** 부하경로·메트릭 파이프라인 무관.
- **`insights.rs`(`derive_insights`)·`Insight` 구조체·`report.rs`·`build_report` 무변경** — 인사이트는 이미 13필드 다 갖고 emit 중(신규 필드 0).
- **UI `InsightSchema`·`ReportSchema`·서버 응답·React Query 무변경(R7)** — 비교 화면은 기존 fetch 결과 재사용.
- **기존 4 export byte-identical(R9)**: `report.csv`(per-step)·`comparison.csv`(summary matrix)·`comparison.xlsx` 기존 3시트·`report.xlsx` 비-Insights 시트. 단일 `report.xlsx` Insights 시트는 `onset_second` 1열 append만(기존 12열 보존).
- **`ko.ts`**: 기존 `message()`/`insightActions`는 **무변경**(재사용 아님). 신규 카탈로그 = ① 매트릭스 **kind→짧은-라벨 맵**(R12, 표시되는 모든 kind 커버) + ② 섹션 제목·빈 상태 문구(ADR-0035 한국어). 기존 단일-run `InsightPanel` 산문은 그대로.

---

## 6. 테스트 / 검증

| R-id | 검증 방법 | 라이브? |
|---|---|---|
| R1 | `export.rs` 테스트: 단일 insights CSV 헤더 13열 + 행/인사이트; 라우트 200 | |
| R2 | 테스트: 비교 insights CSV 헤더 `run_id`+13 + run당 행 수; 라우트 200 | |
| R3 | calamine 라운드트립: 비교 XLSX `Insights` 시트 존재 + 행 == Σ run insights | |
| R4 | calamine 라운드트립: 단일 XLSX `Insights` 시트 `onset_second` 열 + 값; 기존 12열 단언 무변경 | |
| R5 | 테스트: 단일 CSV 헤더 ≡ 단일 XLSX 헤더 ≡ (비교 CSV 헤더 − `run_id`); 컬럼 const 단일 정의 | |
| R6 | RTL `InsightCompareMatrix`: union 행·셀 severity/수치·미보유 `—` | |
| R7 | `git diff` 와이어/스키마 변경 0; 기존 `ReportSchema`/proto 무수정 | |
| R8 | RTL: `status_class`/step-scoped 별 행·순서 결정적 | |
| R9 | 기존 export 테스트(csv_has_header_and_one_row_per_step 등) 무수정 통과 | |
| R10 | RTL: 다운로드 버튼 → 올바른 URL/파일명으로 `downloadFile` | |
| R11 | 테스트: 인사이트 0 → CSV 헤더만; RTL 빈 매트릭스 | |
| R12 | RTL: numberless 인사이트(slo_pass)=배지만·미보유=`—`·step 라벨(`stepLabelMap`)·kind 라벨 | |

- **라이브 검증**: 백엔드 export는 **calamine 라운드트립 + CSV 문자열 단언이 직렬화 계약**이라 백엔드 자체는 라이브 불요(선행 "XLSX Insights 사이징 3열" 슬라이스 선례). UI 비교 매트릭스는 **기존 검증된** `/report.insights`를 재사용(신규 와이어 0)이라 S-D 갭 위험 낮음 → **라이브는 라이트 1회 권장**: 완료 run 2개로 비교 페이지 열어 매트릭스 렌더 + 신규 CSV 2종 다운로드가 깨끗이 파싱(`pandas.read_csv` 또는 헤더/행 육안)되는지 확인. `/live-verify` 스택 재사용.

---

## 7. 의도적 연기 (roadmap §A4c/§B7에 누적)

- **비교 화면 run별 패널 나열**(InsightPanel 재사용, 사용자 선택지 2): 매트릭스가 부족하다 싶으면 후보. 매트릭스는 컴팩트하나 인사이트 *상세 문장*을 다 못 보여줌 — 패널 나열은 그 보완.
- **비교 화면 회귀-인식 diff**(사용자 선택지 3): baseline 대비 candidate에 신규/해소된 인사이트 강조("이 run에만 5xx 핫스팟"). **신규 diff 의미론** 필요(현재는 pivot만) = 범위 확장이라 별도 슬라이스.
- **CSV 스키마 정규화**: 현 sparse-wide(value/pct/count/recommended/cause… 옵션 다수, 빈칸 다수) 그대로. per-kind 좁은 테이블·long key-value 정규화는 비목표.
- **비교 export delta/baseline 강조**: 인사이트엔 metric delta 의미가 없어 `comparison.csv`의 delta_pct 같은 처리 없음(run_id long-format만).
- **단일 리포트 화면 InsightPanel 변경**: 이미 표면화돼 있어 무관.

---

## 8. 구현 순서 (plan 입력)

> cargo-영향 커밋마다 전체 워크스페이스 게이트 → 미사용 헬퍼만/RED 테스트만 단독 커밋 불가. 아래는 green-fold 경계 가이드.

1. **(green fold) export 백엔드** — `INSIGHT_COLUMNS` const + 공유 CSV/XLSX 행-writer + 기존 단일 XLSX 리팩터(onset_second) + `report_to_insights_csv` + `comparison_to_insights_csv` + 비교 XLSX `Insights` 시트 + export 테스트(R1~R5,R9,R11). 헬퍼·사용처·테스트를 한 커밋으로 fold.
2. **라우트 배선** — `runs.rs` 2 라우트 + 라우터 등록(R1,R2). export 함수와 같은/인접 커밋(한쪽만 머지 = 깨진 다운로드).
3. **UI** — `client.ts` URL 빌더 2개 + 단일/비교 다운로드 버튼 2개(R10) + `InsightCompareMatrix`(R6,R8,R11) + 비교 페이지 배선 + RTL. (kind→라벨 공유 헬퍼 추출 필요 시 동반.)
4. **라이브 라이트 검증**(§6) — 비교 매트릭스 + 신규 CSV 2종 파싱.
