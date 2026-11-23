# 판정 기준·응답 시간 통계 슬라이스 A — 평균·최대·임의 백분위 판정 + 리포트 통계 칸 (verdict-stats-a) 설계

- 날짜: 2026-11-23
- 상태: **보류 (2026-11-23)** — 사용자 결정: 응답 시간 통계를 「통과한 요청만」 기준으로 바꾸는 슬라이스(통과/실패 분리)를 먼저 한다. 그 뒤 이 설계를 그 위에서 다시 쓴다. 1차 검토 결과는 APPROVE-WITH-FIXES이고 지적은 아직 반영하지 않았다(§11). REVIEW-GATE 없음.
- 유형: `user-path`
- 출처: roadmap §A17 (사용자 결정 2026-11-23 — 프로토콜 말고는 LoadRunner 이상, `docs/dev/working-rules.md` §11). 실무가이드의 「평균 응답 시간 3초 이내」를 판정 기준으로 걸 수 없다.
- 목업(시각 기준): `2026-11-23-verdict-stats-a-mockups/a-screens.html` — 점선 테두리가 새로 생기는 것.
- 관련 결정: ADR-0028(run 판정 기준), ADR-0061(유지 구간 기준 리포트), ADR-0012(워커 사전 집계 HDR), ADR-0017(MVP 리포트 범위).
- ADR: 신규 불필요 — ADR-0028의 판정 항목을 넓히는 additive 변경(새 항목이 없으면 와이어·판정 결과가 지금과 같다).
- 이어지는 슬라이스: **B** = 시간대별 평균 응답 시간 그래프 + 같은 통계 값을 인쇄 보고서 본문·CSV/XLSX·비교 화면에. **A와 B 사이에는 릴리즈하지 않는다**(화면과 내보내기의 숫자 칸이 달라진다).

## 사용자 스토리 (US)

- **US1**: QA가 「평균 응답 시간 3초 이내」 같은 권고를 run 판정 기준으로 걸고 실행한다 — 성공하면 리포트 판정 표에 「평균 응답 시간 · 기준 ≤ 3,000 ms · 실측 N ms · ✓/✗」 행이 나오고, 그 실측 값은 리포트 요약의 「평균」 카드와 같은 값이다(판정 표는 소수 3자리까지, 카드는 유효 숫자 4자리로 보인다).
- **US2**: QA가 p90처럼 원하는 백분위나 최대 응답 시간을 run 판정 기준으로 건다 — 성공하면 판정 표에 그 항목 이름(「p90」, 「최대 응답 시간」)으로 행이 나오고 run 목록의 판정 배지에 반영된다.
- **US3**: QA가 특정 스텝에만 평균·최대·백분위 기준을 건다 — 성공하면 그 스텝의 값으로 판정한 행이 스텝 이름과 함께 나온다.
- **US4**: QA가 종료된 run의 「스텝별 결과」 표에서 「응답 시간 통계 더 보기」를 누른다 — 성공하면 스텝마다, 그리고 「전체」 행에 최소·평균·최대·표준편차·p90이 보인다. 60초를 넘긴 응답이 있는 스텝은 최대가 「≥ 60,000」으로 보이고 그 뜻을 알리는 안내가 붙는다.
- **US5**: QA가 새 판정 항목을 쓰지 않은 run(이번 변경 전에 만든 run·프리셋·스케줄 포함)을 연다 — 성공하면 판정 결과와 판정 표의 행이 지금과 같다.

(roadmap §A17의 「시간대별 평균 응답 시간 그래프」는 슬라이스 B의 US다.)

## 1. 배경

### 1.1 지금 상태 (2026-11-23, `38905b00` 기준 — 사실은 §10 명령으로 확인)

- **판정 기준 모델** `crates/controller/src/store/runs.rs`: run 기준 `Criteria`는 항목마다 고정 칸(`max_p50_ms`·`max_p95_ms`·`max_p99_ms`: `Option<u64>`, 오류율·RPS 하한·4xx/5xx 등)이고, 스텝 기준 `Criterion { metric: String, op, threshold: f64, target }`은 이름으로 항목을 고른다. `Criteria::has_any`가 켜진 칸을 하나씩 나열한다.
- **검증** `crates/controller/src/api/runs.rs` `validate_criteria`: 스텝 기준 이름은 `STEP_METRICS` 8개만 받는다. `validate_run_config`를 run 생성·프리셋 저장·스케줄 저장·스케줄 발사가 함께 쓴다.
- **판정** `crates/controller/src/report.rs` `evaluate_criteria`(순수 함수, 호출자는 `build_report` 하나): run 기준은 `ReportSummary`의 `p50_ms`·`p95_ms`·`p99_ms`(정수 ms, 내림)에서, 스텝 기준은 `ReportStep`의 같은 칸에서 읽는다. 결과 행 `CriterionResult { metric, direction, threshold: f64, actual: f64, passed, target }`.
- **분포** `build_report`는 run 전체 분포 `overall`과 스텝별 분포 `per_step`(둘 다 HDR, µs, 1..=60,000,000, 유효 3자리)을 이미 만든다. 유지 구간 기준(`SteadyScope`)이면 그 초 범위의 행만 들어간다. 평균은 `ReportSummary.mean_ms`(정수 ms 반올림)만 싣는다. 스텝에는 평균·최소·최대·표준편차가 없다.
- **입력 화면** `ui/src/components/run/`: `CriteriaFields.tsx`(run 기준 칸 격자)·`StepCriteriaFields.tsx`(스텝 기준 행)·`profileForm.ts`(상태 ↔ 와이어). `RunDialog.tsx`와 `ScheduleForm.tsx`가 같은 부품을 쓴다. 프리셋은 실행 창에서 저장·불러오기 한다.
- **판정 표시** `ui/src/components/report/verdictFormat.ts`(`METRIC_LABEL`·`fmt`)를 `VerdictPanel`(리포트)과 `VerdictBadge`(목록 배지 툴팁)가 함께 쓴다. `fmt`는 시간 값을 `${v} ms`로 찍는다(소수 처리 없음).
- **인쇄 보고서** `ui/src/print/verdict.ts`의 `criteriaHasAny`·`expandCriteria`는 서버의 `has_any`와 결과 행 순서를 **거울처럼 따라 한다**. `ui/src/print/format.ts`의 `fmtCriterionPair`는 이름이 `_ms`로 끝나면 `fmtMsExact`(소수 3자리까지)로 찍는다. `ui/src/print/compare/fairness.ts`도 판정 기준을 읽는다.
- **스텝 표** `ui/src/components/report/StepStatsTable.tsx`: 스텝·Method·URL·요청·오류·p50·p95·p99(+ 있을 때 대기·다운로드). 보낸 요청이 하나도 없는 스텝은 시간 칸이 「—」.
- **요약 카드** `ui/src/components/report/Summary.tsx`: 총 요청·오류·평균 RPS·실행 시간·p50·p95·p99. 평균 응답 시간 카드는 없다.

### 1.2 분포에서 얻을 수 있는 값과 한계

워커는 초·스텝마다 응답 시간 분포(HDR) 전체를 보내고 컨트롤러가 그대로 저장한다. 그래서 평균·최소·최대·표준편차·임의 백분위를 **엔진·워커·proto·마이그레이션을 바꾸지 않고** 컨트롤러에서 계산할 수 있다(`hdrhistogram`의 `mean()`·`min()`·`max()`·`stdev()`·`value_at_quantile()`). 한계 셋:

1. **60초 상한**: 엔진이 응답 시간을 1µs..60초로 잘라 기록한다(`crates/engine/src/aggregator.rs`의 `clamp(1, 60_000_000)`). 60초를 넘긴 응답은 60초로 들어가 평균·최대·표준편차가 실제보다 작아진다.
2. **보내지 않은 요청**: `record_not_sent`는 건수만 올리고 시간 표본을 남기지 않는다. 통계는 보낸 요청만 다룬다. 보낸 요청이 0이면 통계가 없다.
3. **분포 근사**: HDR은 값을 유효 3자리 칸에 넣는다. 평균·표준편차·백분위는 칸 대표값으로 계산한 값이라 실제와 최대 0.1%쯤 다를 수 있다.

평균에는 실패한 요청(시간 초과·거부)의 걸린 시간도 들어간다 — 지금의 p50·p95·p99와 같은 표본이다.

### 1.3 목표가 아닌 것

- 시간대별 평균 응답 시간 그래프, 인쇄 보고서 본문·CSV/XLSX·비교 화면의 통계 칸 — 슬라이스 B.
- 실행 중 화면의 응답 시간(서버가 실행 중에는 분포를 보내지 않는다, ADR-0051).
- 표준편차·최소 응답 시간을 판정 항목으로 — 통계 칸에만 넣는다.
- 지금의 p50·p95·p99 칸(정수 ms 내림)을 소수로 바꾸는 것 — 와이어 타입이 바뀌어 내보내기·비교 골든·인쇄가 함께 움직인다. roadmap §B에 남긴다(§9).
- 준비 스텝·그룹·분기·대기/다운로드·워커별 표의 통계 칸 — roadmap §B에 남긴다(§9).
- 워커가 응답 시간 합계를 따로 보내 평균을 정확히 내는 것(§1.2 한계 3) — roadmap §B에 남긴다.
- 계단 자동 정지(`auto_stop`)·속도 구간(`speed_bands`)이 새 기준을 읽는 것 — 지금처럼 p95→p99→p50만 본다.

### 1.4 하면 안 되는 것

- 새 항목을 쓰지 않은 run의 판정 결과·결과 행·`profile_json` 바이트를 바꾸는 것(US5).
- 60초를 넘긴 응답이 있는데 평균·최대를 아무 표시 없이 보여 주는 것(working-rules §9 — 숫자가 실제를 속이지 않게).
- 보낸 요청이 없는 스텝에 0을 찍거나, 그런 스텝의 기준을 통과·실패로 판정하는 것.
- 판정 표(화면)와 인쇄 보고서의 판정 행이 서로 다른 것 — 인쇄의 거울 코드를 함께 고친다.

## 2. 요구사항 (R-id)

| ID | 요구사항 | acceptance | seam? |
|---|---|---|---|
| R1 | MUST run 기준에 평균 응답 시간 상한 `max_mean_ms`, 최대 응답 시간 상한 `max_max_ms`(둘 다 ms, 소수 허용), 백분위 상한 목록 `max_percentiles_ms: [{ percentile, max_ms }]`를 둔다. 없으면 직렬화에서 빠진다. | 새 칸이 없는 `Criteria`의 JSON이 지금과 바이트 동일(단위 테스트). 새 칸 왕복 테스트. | ✅ serde ↔ Zod `CriteriaSchema` |
| R2 | MUST 스텝 기준 `metric`에 `mean_ms`·`max_ms`·`p<N>_ms`(N = 0 초과 100 미만, 소수 3자리까지)를 받는다. `op`는 지금처럼 `max`·`min`. | `validate_criteria` 단위 테스트(받는 이름·거절하는 이름 표). | ✅ 이름 문법 서버 ↔ UI |
| R3 | MUST 백분위 표기는 정본 하나다: `p` + N을 뒤 0 없이(`p90_ms`, `p99.9_ms`) + `_ms`. 서버는 정본이 아닌 표기(`p90.0_ms`, `p090_ms`)를 400으로 거절하고, UI는 입력을 정본으로 바꿔 보낸다. | 서버 테스트(거절 표) + UI 테스트(`90.0` 입력 → `p90_ms`). 이름 예시 표를 `testdata/percentile_metric_cases.json` 하나로 서버·UI가 같이 읽는다. | ✅ |
| R4 | MUST 검증: 새 시간 기준 값은 유한·0 이상·60,000 ms 이하. 백분위는 R2 범위. run 백분위 목록은 10개 이하이고 같은 백분위가 둘이면 거절, 50·95·99는 목록에서 거절(고정 칸을 쓰라는 사유). 위반은 400 + 한국어 사유. | `validate_criteria` 단위 테스트. run 생성·프리셋·스케줄 저장이 같은 400을 낸다(통합 테스트 1건씩). | |
| R5 | MUST 판정: 평균 = 분포의 평균, 최대 = 분포의 최대, 백분위 = `value_at_quantile(N/100)` — 모두 µs 값을 1000으로 나눈 ms(소수 3자리까지). run 기준은 `overall`, 스텝 기준은 그 스텝 분포. `p50_ms`·`p95_ms`·`p99_ms`는 지금 경로(정수 ms 내림) 그대로. | `evaluate_criteria` 단위 테스트: 손으로 계산한 분포에서 기대 실측·통과 여부. | |
| R6 | MUST 분포에 표본이 없으면(보낸 요청 0) 새 시간 기준의 결과 행을 만들지 않는다. 그래서 켜진 기준이 전부 건너뛰어지면 판정 자체가 없다(지금 규칙). | 단위 테스트: 보내지 않은 요청만 있는 run·스텝. | |
| R7 | MUST 결과 행 순서: 지금 순서 그대로 두고, run 기준의 새 행은 `p99_ms` 행 바로 뒤에 평균 → 최대 → 백분위(입력 순)로 넣는다. 스텝 기준은 지금처럼 맨 뒤에 입력 순. 결과 행 `metric`은 `mean_ms`·`max_ms`·`p<N>_ms`. | 단위 테스트(순서). 인쇄 `expandCriteria`가 같은 순서(UI 테스트). | ✅ 서버 순서 ↔ 인쇄 거울 |
| R8 | MUST 판정은 리포트 기준(`?basis=`)을 따른다 — 새 코드가 기준을 따로 고르지 않고 `build_report`가 이미 만든 범위 안 분포를 쓴다. | 유지 구간이 있는 run에서 두 기준의 평균 실측이 다르게 나오는 단위 테스트. | |
| R9 | MUST 리포트의 `summary`와 각 스텝에 통계 블록 `latency: { min_ms, mean_ms, max_ms, stdev_ms, p90_ms, capped }`를 싣는다(ms, 소수 3자리까지). 표본이 없으면 키를 뺀다(`null` 금지). | `build_report` 단위 테스트(값·키 생략) + Zod `.optional()` 수용 테스트. | ✅ `ReportJson` ↔ Zod `.strict()` |
| R10 | MUST `capped` = 그 분포에 60초 상한 칸의 표본이 하나라도 있음. | 단위 테스트: 60,000,000µs를 기록한 분포는 참, 59초까지만 있는 분포는 거짓. | |
| R11 | MUST 같은 분포에서 나온 값은 한 리포트 안에서 일치한다: `summary.latency.mean_ms` = run 평균 기준의 `actual`, 스텝 `latency.mean_ms` = 그 스텝 평균 기준의 `actual`(최대도 같다). | 단위 테스트(동일 값 단언). | |
| R12 | MUST 입력 화면(실행 창·스케줄 폼)에서 run 기준 「평균 응답 시간(ms)」·「최대 응답 시간(ms)」 칸과 「다른 백분위 기준」 행(추가·삭제), 스텝 기준의 「평균」·「최대」·「백분위」 항목(백분위면 N 입력 칸)을 쓸 수 있다. 저장된 값은 다시 열면 그대로 채워진다. | RTL: 입력 → `buildCriteria` 와이어, 와이어 → `criteriaStateFrom` 상태 왕복. 프리셋 불러오기·다시 실행 프리필. | |
| R13 | MUST 입력 화면은 서버가 거절할 값을 보내기 전에 막고 이유를 칸 옆에 보여 준다(범위 밖 백분위, 겹친 백분위, 50·95·99, 60,000 ms 초과). | RTL: 각 경우 안내 문구 + 제출 막힘. | |
| R14 | MUST 판정 표·목록 배지 툴팁이 새 항목을 「평균 응답 시간」·「최대 응답 시간」·「p90」처럼 이름 붙여 보여 주고, 시간 값은 인쇄와 같은 규칙(소수 3자리까지·뒤 0 생략·천 단위 쉼표)으로 찍는다. 기준과 실측이 다른데 글자가 같아지면 안 된다. | RTL(`verdictFormat`): 이름·값 글자. | |
| R15 | MUST 인쇄 보고서의 판정 행이 화면 판정 표와 같다: `criteriaHasAny`·`expandCriteria`가 새 칸을 알고, 새 항목의 이름이 찍힌다. `fairness.ts`의 기준 비교도 새 칸을 본다. | UI 테스트(`print/__tests__/verdict.test.ts` 등): 새 기준이 있는 리포트의 인쇄 판정 행 = 서버 결과 행. | |
| R16 | MUST 요약에 「평균」 카드를 둔다(값 = `summary.latency.mean_ms`, 유효 숫자 4자리). `latency`가 없으면 「—」. | RTL. | |
| R17 | MUST 스텝 표에 기본 접힌 「응답 시간 통계 더 보기」 버튼을 두고, 펼치면 최소·평균·최대·표준편차·p90 열과 「전체」 행이 나온다(유효 숫자 4자리). `latency`가 없는 스텝은 「—」. | RTL: 접힘 기본·펼침 뒤 열·행. | |
| R18 | MUST `capped`인 스텝·전체는 최대를 「≥ 60,000」으로 찍고, 표 아래와 판정 표 아래에 60초 안내를 붙인다(판정 표 안내는 평균·최대 기준 행이 있고 그 대상이 `capped`일 때). | RTL: 표시·안내 유무. | |
| R19 | MUST 새 항목이 없는 run에서 판정 결과 행·`passed`가 지금과 같다. 리포트 JSON에서 달라지는 것은 `latency` 블록이 생기는 것뿐이다. | 기존 판정 테스트 무수정 통과 + 기존 픽스처로 `verdict` 동일 단언. | |
| R20 | SHOULD 분포에서 낸 평균의 오차가 실제 평균의 0.1% 이내임을 테스트로 남긴다. | 단위 테스트: 합성 표본의 정확한 평균과 비교. | |

## 3. 설계 근거

1. **run 기준은 고정 칸 + 목록, 스텝 기준은 이름 문법.** 지금 모델이 그렇게 갈라져 있다. run 기준에 이름 목록을 새로 만들면 같은 일을 하는 길이 둘이 되고(`max_p95_ms` 칸 vs 목록의 `p95_ms`), 옛 프리셋을 옮겨야 한다. 평균·최대는 하나씩이라 고정 칸이 맞고, 백분위만 개수가 정해지지 않아 목록이다. 스텝 기준은 이미 `metric` 글자라 이름만 늘린다.
2. **새 값은 소수 ms(µs 정밀도).** 사용자의 실제 대상에 응답이 1ms 안쪽인 API 게이트웨이가 있다. 정수 ms로 내리면 평균 0.8ms가 0이 된다. 지금 칸(`p50_ms` 등)은 그대로 두므로 한 표에 정수 칸과 소수 칸이 섞인다 — §9에 연기로 적는다.
3. **기준 상한 60,000 ms.** 분포가 60초에서 잘리므로 그보다 큰 기준은 절대 실패하지 않는다. 판정할 수 없는 기준은 받지 않는다(지금의 p50·p95·p99 칸에는 이 검사가 없고, 이번에 넣지 않는다 — US5).
4. **표본 없음 = 행 없음.** 스텝 기준의 「실행 0회 → 건너뜀」과 같은 태도다(거짓 실패·거짓 통과 금지). 지금의 run p95 칸은 표본이 없으면 0으로 통과하는데, 그 동작은 바꾸지 않는다(US5).
5. **50·95·99를 백분위 목록에서 거절.** 고정 칸(정수 내림)과 목록(소수)이 같은 백분위를 다른 숫자로 판정하는 일을 막는다. 스텝 기준의 `p50_ms`·`p95_ms`·`p99_ms`는 이름이 같아 지금 경로로 간다.
6. **판정이 분포를 직접 읽는다.** `evaluate_criteria`는 지금 미리 계산된 `ReportSummary`·`ReportStep`만 받는다. 임의 백분위는 미리 계산해 둘 수 없으므로 분포(`overall`, `per_step`)를 인자로 넘긴다. 순수 함수 성질은 그대로다.
7. **통계 블록은 한 덩어리 `latency`.** 다섯 값과 `capped`를 스텝 칸에 낱개로 늘어놓으면 「표본 없음」을 칸마다 표현해야 한다. 블록 하나의 유무로 표현한다.
8. **인쇄 거울은 이번에 고친다.** 인쇄의 `expandCriteria`가 새 칸을 모르면 화면에는 있는 판정 행이 인쇄에는 없다. 통계 칸을 인쇄 본문에 싣는 일(슬라이스 B)과 달리 이것은 지금 있는 표가 틀리게 되는 문제라 미룰 수 없다.

### 접근 비교

| 안 | 내용 | 판단 |
|---|---|---|
| **가 (채택)** | 컨트롤러가 이미 가진 분포에서 계산. run 기준 고정 칸 + 백분위 목록, 스텝 기준 이름 문법. | 엔진·워커·proto·마이그레이션 0. 옛 run도 다시 계산하면 통계가 나온다. 평균이 0.1% 근사. |
| 나 | 워커가 초·스텝마다 응답 시간 합계·최소·최대를 따로 보낸다. | 평균이 정확하다. proto·마이그레이션·엔진 집계가 바뀌고 옛 run에는 값이 없다. 지금 필요한 정밀도(±0.1%)에 비해 크다 — §9에 남긴다. |
| 다 | run 기준을 스텝 기준과 같은 이름 목록으로 통일(`{metric, op, threshold}`). | 모델은 깔끔하지만 옛 프리셋·스케줄의 고정 칸과 길이 둘이 되고 입력 화면을 통째로 바꿔야 한다. US에 필요 없다. |

## 4. 와이어

### 4.1 판정 기준 (`profile.criteria`)

```jsonc
{
  "max_mean_ms": 3000,                 // 새 칸. 없으면 키 없음
  "max_max_ms": 10000,                 // 새 칸
  "max_percentiles_ms": [              // 새 칸. 비면 키 없음
    { "percentile": 90, "max_ms": 2500 },
    { "percentile": 99.9, "max_ms": 8000 }
  ],
  "max_p95_ms": 5000,                  // 기존 그대로
  "step_criteria": [
    { "metric": "mean_ms", "op": "max", "threshold": 500, "target": "<step id>" },
    { "metric": "p90_ms",  "op": "max", "threshold": 1200, "target": "<step id>" }
  ]
}
```

- Rust: `max_mean_ms: Option<f64>`, `max_max_ms: Option<f64>`, `max_percentiles_ms: Vec<PercentileLimit>`(`#[serde(default, skip_serializing_if = …)]`), `PercentileLimit { percentile: f64, max_ms: f64 }`. `has_any`에 셋을 더한다.
- Zod: `max_mean_ms`·`max_max_ms` = `z.number().nonnegative().optional()`, `max_percentiles_ms` = `z.array(z.object({ percentile: z.number(), max_ms: z.number().nonnegative() })).optional()`.
- `profile_json`에 저장되므로 마이그레이션이 없다(`#[serde(default)]`로 옛 행 호환).

### 4.2 백분위 이름 문법 (R2·R3)

- 정본: `p` + N + `_ms`. N은 0 < N < 100, 소수 3자리까지, 뒤 0과 불필요한 소수점 없이(`90`, `99.9`, `99.99`, `0.5`). 앞 0 금지(`0.5`의 `0`만 예외).
- 서버는 이름에서 N을 읽고(Rust), 읽은 N을 다시 정본으로 쓴 글자가 입력과 같을 때만 받는다. `p50_ms`·`p95_ms`·`p99_ms`는 문법에 맞지만 기존 항목으로 먼저 처리한다.
- 결과 행의 run 백분위 이름은 `percentile` 숫자를 같은 규칙으로 정본화해 만든다.
- 예시 표 `testdata/percentile_metric_cases.json`: `{ input, canonical | null }` 목록. 서버 테스트(이름 → 받음/거절)와 UI 테스트(숫자 입력 → 이름)가 같이 읽는다.

### 4.3 판정 결과 행 (`verdict.criteria[]`)

모양은 그대로(`CriterionResult`). 새 `metric` 값: `mean_ms`, `max_ms`, `p<N>_ms`. `threshold`·`actual`은 ms(소수). run 기준의 `direction`은 `max`.

순서(R7): `p50_ms` → `p95_ms` → `p99_ms` → **`mean_ms` → `max_ms` → 백분위(입력 순)** → `error_rate` → 4xx/5xx 비율 → 4xx/5xx 수 → `rps` → `min_window_rps` → 스텝 기준(입력 순).

### 4.4 리포트 통계 블록 (R9·R10)

```jsonc
"summary": { …기존…, "latency": { "min_ms": 0.84, "mean_ms": 1842.613, "max_ms": 60000, "stdev_ms": 4120.02, "p90_ms": 3480.1, "capped": true } },
"steps": [ { …기존…, "latency": { … } } ]
```

- Rust: `LatencyStats { min_ms: f64, mean_ms: f64, max_ms: f64, stdev_ms: f64, p90_ms: f64, capped: bool }`, `ReportSummary.latency`·`ReportStep.latency`: `Option<LatencyStats>` + `#[serde(default, skip_serializing_if = "Option::is_none")]`.
- 값은 µs를 1000으로 나눈 뒤 소수 3자리로 반올림한다(µs 정밀도 — 평균·표준편차는 µs 아래를 버린다).
- `ReportSummary.mean_ms`(정수)는 그대로 둔다(비교·내보내기·골든이 읽는다).
- Zod: `LatencyStatsSchema`(`.strict()`), `ReportSummarySchema`·`ReportStepSchema`에 `latency: LatencyStatsSchema.optional()`.
- `capped`의 술어는 「분포의 최대가 60,000,000µs가 들어가는 칸에 있다」이다. 그 칸의 폭 때문에 60초에 아주 가까운 응답(약 59.97초 이상)도 참이 된다. 정확한 식은 구현 중 R10 테스트로 고정한다.

## 5. 서버 변경

### 5.1 `store/runs.rs` — 충족 R1
`Criteria`에 세 칸 + `PercentileLimit`, `has_any` 갱신.

### 5.2 `api/runs.rs` `validate_criteria` — 충족 R2·R3·R4
- run 기준 새 칸 검사(유한·0..=60,000, 목록 10개 이하·중복·50/95/99 거절·백분위 범위·소수 3자리).
- 스텝 기준 이름: 기존 8개 + `mean_ms`·`max_ms` + 백분위 문법. 시간 항목(이름이 `_ms`로 끝나는 새 항목)의 기준 값은 60,000 이하.
- 백분위 이름 읽기·쓰기는 한 모듈의 두 함수(읽기 `parse_percentile_metric(&str) -> Option<f64>`, 쓰기 `percentile_metric_name(f64) -> String`)가 단일 소스다. 판정과 검증이 같이 쓴다.

### 5.3 `report.rs` — 충족 R5–R11·R19
- `latency_stats(&Histogram<u64>) -> Option<LatencyStats>`(표본 없으면 `None`). `build_report`가 `overall`과 각 스텝 분포에 부른다.
- `evaluate_criteria`에 분포 인자를 더한다(`overall: &Histogram<u64>`, `per_step: &BTreeMap<String, Histogram<u64>>`). 호출자는 `build_report` 하나와 테스트들이다.
- 평균·최대의 `actual`은 `latency_stats`가 낸 값과 같은 식에서 나온다(R11 — 식을 두 번 쓰지 않는다).
- 성능(working-rules §10): 새 일은 분포마다 `mean`·`stdev`·`min`·`max`·`value_at_quantile` 몇 번이다. 분포를 다시 디코드하거나 복사하지 않는다(`build_report`가 이미 합쳐 둔 것을 읽는다). 리포트 빌드는 요청당 한 번이라 측정 대상은 「스텝 수가 많은 run의 리포트 빌드 시간」이고, 기존 대비 차이를 plan에서 한 번 잰다.

### 5.4 건드리지 않는 것
엔진·워커·proto·마이그레이션, `export.rs`(판정 기준을 읽지 않는다), `speed_bands.rs`·`auto_stop.rs`·`stair*.rs`, `insights.rs`(실패한 기준 수만 센다), `crates/tui`(판정 기준을 읽지 않는다).

## 6. 화면 변경 (목업이 시각 기준)

### 6.1 입력 — `CriteriaFields.tsx`·`StepCriteriaFields.tsx`·`profileForm.ts` (R12·R13)
- run 기준 격자 맨 앞에 「평균 응답 시간(ms)」·「최대 응답 시간(ms)」 칸(소수 허용). 격자 아래 도움말 한 줄: 「평균은 느린 응답 몇 건이 있어도 낮게 나올 수 있습니다. 대부분의 사용자가 겪는 속도를 보려면 p95를 함께 거세요.」
- 그 아래 「다른 백분위 기준 (선택)」: 행 = `p [N] ≤ [값] ms ×`, 「+ 백분위 기준 추가」. 새 행의 N 기본값은 90.
- 스텝 기준의 항목 선택에 「평균(ms)」·「최대(ms)」·「백분위(ms)」를 맨 앞에 더한다. 「백분위」를 고르면 N 입력 칸이 나타난다(기본 90). 와이어 이름은 N에서 만든다. 저장된 `p90_ms`는 「백분위」 + N=90으로, `p95_ms`는 지금처럼 「p95(ms)」로 열린다.
- `CriteriaState`에 `maxMean`·`maxMax`·`percentiles: { p: string; ms: string }[]` 추가. `criteriaHasValue`·`criteriaActiveCount`(접힘 머리의 「N개 설정됨」)·`buildCriteria`·`criteriaStateFrom`이 새 칸을 안다. 값이 빈 백분위 행은 보내지 않는다.
- 잘못된 입력(R13)은 그 행 아래에 붉은 글씨로 이유를 쓰고 실행·저장 버튼을 막는다(지금의 `canSubmit` 게이트에 합친다).
- 실행 창·스케줄 폼 두 진입 화면 모두에서 확인한다(working-rules §4).

### 6.2 판정 표시 — `verdictFormat.ts`·`VerdictPanel.tsx`·`VerdictBadge` (R14·R18)
- 이름: `mean_ms` → 「평균 응답 시간」, `max_ms` → 「최대 응답 시간」, `p<N>_ms` → 「p<N>」(표에 없는 백분위 이름은 문법으로 풀어 만든다).
- 시간 값 글자는 인쇄의 `fmtMsExact`·`fmtMsPair` 규칙을 화면도 쓴다(같은 함수를 공유 — 위치는 plan에서 정한다). 지금 항목(`p95_ms` 등 정수)은 글자가 그대로다(`420 ms`).
- `capped` 안내: 판정 표에 평균·최대 기준 행이 있고 그 대상(run 또는 그 스텝)의 `latency.capped`가 참이면 표 아래에 안내를 붙이고, 최대 기준 행의 실측은 「≥ 60,000 ms」로 찍는다.

### 6.3 요약 카드 — `Summary.tsx` (R16)
「실행 시간」 뒤, p50 앞에 「평균」 카드. 격자 열 수가 하나 늘어난다(닫힌 루프 7 → 8, 열린 루프 10 → 11) — 좁은 폭과 큰 숫자에서 겹침·잘림을 라이브로 잰다.

### 6.4 스텝 표 — `StepStatsTable.tsx` (R17·R18)
- 표 제목 줄 오른쪽에 「응답 시간 통계 더 보기 ▸」 버튼(`aria-expanded`), 기본 접힘(UI 선호 — 대량 열은 opt-in). 접힌 상태는 지금 표와 같다.
- 펼치면 열 순서: 요청·오류 뒤에 최소·평균·최대·표준편차, 그 뒤 p50·**p90**·p95·p99. 맨 아래 「전체」 행(값 = `summary`).
- 새 값은 유효 숫자 4자리(`41.2`, `312.1`, `1,843`, `0.84`), 천 단위 쉼표. `capped`면 최대 칸 「≥ 60,000」 + 표 아래 안내.
- 열이 늘어 넓어지므로 표는 가로 스크롤 상자 안에 둔다(지금 대기·다운로드 열이 있을 때와 같은 처리인지 구현 때 확인).

### 6.5 인쇄 — `ui/src/print/verdict.ts`·`format.ts`·`compare/fairness.ts`·`ko.ts` (R15)
- `criteriaHasAny`·`expandCriteria`에 새 칸(순서 = §4.3).
- 인쇄가 항목 이름을 찍는 곳(`ko.print`의 항목 이름 표)이 새 이름을 알게 한다(백분위는 문법으로).
- `fairness.ts`가 두 run의 판정 기준이 같은지 볼 때 새 칸도 본다.
- 인쇄 본문의 통계 칸·그래프는 슬라이스 B.

### 6.6 문구
모든 새 문구는 `ko.ts` 경유(ADR-0035). 번역투 명사구를 만들지 않는다(working-rules §8). 용어 풀이(`ko.glossary`)에 「평균 응답 시간」·「표준편차」·「p90」을 더하고 표 머리의 HelpTip에 건다.

## 7. 테스트·검증

- 서버 단위: R1–R11·R19·R20의 표 테스트. 회귀 가드로 쓰는 테스트(R6 「행 없음」, R10 `capped`, R7 순서, R19)는 되돌려 확인을 한다.
- UI: R3 예시 표, R12–R18 RTL. `ReportSummarySchema`·`ReportStepSchema`가 `.strict()`라 전체 리포트 픽스처에 `latency`를 넣는 테스트와 넣지 않는 테스트를 둘 다 둔다.
- 골든 `testdata/compare_golden.json`: `latency`는 `Option` + `serde(default)`라 픽스처를 고치지 않아도 역직렬화된다 — plan에서 실제로 돌려 확인한다.
- 라이브(US-anchored, `/live-verify`):

| US | 절차 | 통과 신호 |
|---|---|---|
| US1 | 지연을 아는 응답기(예: 고정 40ms)로 run, `max_mean_ms` 기준 | 판정 표에 평균 행, 실측 ≈ 응답기 지연, 요약 카드와 같은 값. 기준을 지연보다 작게 준 run은 ✗ + 목록 배지 실패 |
| US2 | p90·p99.9·최대 기준 | 행 이름·값. 지연이 섞인 응답기(90%는 빠르고 10%는 느림)에서 p90과 p95가 갈린다 |
| US3 | 두 스텝의 지연이 다른 시나리오, 스텝 평균 기준 | 스텝 이름이 붙은 행, 값이 그 스텝의 것 |
| US4 | 60초 넘게 붙잡는 응답기(요청 타임아웃을 그보다 길게) 한 스텝 포함 | 「≥ 60,000」·안내. 보낸 요청 없는 스텝은 「—」 |
| US5 | 새 항목 없이 run, 이번 변경 전 DB의 run·프리셋 열기 | 판정 표가 지금과 같다 |

- 극단값: 백분위 기준 10개 + 스텝 기준 여럿 + 긴 스텝 이름에서 실행 창·판정 표·펼친 스텝 표의 겹침·잘림을 잰다. 1ms 안쪽 응답(localhost)에서 평균이 0이 아닌 소수로 나오는지 본다.
- 진입 화면: 실행 창(새 run·다시 실행·프리셋 불러오기)·스케줄 폼(새로·수정).
- 보안 게이트: 요청 실행·템플릿·바인딩 무접촉. `finish-slice` §0 grep을 돌려 확인한다.

## 8. 사용자에게 알릴 차이 (LoadRunner 대비)

- handicap의 평균은 실패한 요청의 걸린 시간도 포함한다(지금 백분위와 같은 표본). LoadRunner의 평균 트랜잭션 응답 시간은 통과한 트랜잭션 기준이다.
- 평균은 분포에서 계산한 값이라 최대 0.1%쯤 다를 수 있다(3,000 ms 기준이면 ±3 ms).
- 60초를 넘긴 응답은 60초로 계산된다(화면에 표시).

## 9. 연기 (roadmap §B에 옮길 것)

| 항목 | 왜 미루나 | 틀렸을 때 비용 | 푸는 길 |
|---|---|---|---|
| p50·p95·p99 칸을 소수 ms로 | 와이어 타입(`u64`) 변경 — 내보내기·비교 골든·인쇄가 함께 움직인다 | 1ms 안쪽 대상에서 p50이 0으로 보이는데 평균은 0.8로 보여 한 표 안에서 정밀도가 다르다 | `latency` 블록에 p50·p95·p99 소수 값을 더하고 표가 그것을 읽게 |
| 준비 스텝·그룹·분기·대기/다운로드·워커별 표의 통계 칸 | 표마다 분포 출처가 다르다 | 본 스텝 표에만 통계가 있다 | 각 표의 분포에 `latency_stats` 호출 |
| 평균을 정확히(워커가 합계 전송) | proto·마이그레이션·엔진 | 기준 경계 ±0.1%에서 판정이 뒤집힐 수 있다 | `MetricWindow`에 `sum_us` 추가 |
| 지금 p50·p95·p99 기준 칸의 60,000 ms 상한 검사·표본 없음 처리 | US5(지금 동작 유지) | 판정할 수 없는 기준이 통과로 보인다 | 새 항목과 같은 검사로 통일 |
| 속도 구간·계단 판정이 새 기준을 읽게 | 범위 밖 | 평균 기준만 건 run은 속도 구간 경계가 기본값 | `speed_bands` 경계 선택에 평균 추가 |
| 슬라이스 B 전체 | — | A만 나가면 화면과 내보내기의 칸이 다르다 | A와 B 사이 릴리즈 금지 |

## 10. 사실 확인 명령 (claims-ledger)

```bash
# 판정 기준 모델·has_any
grep -n "pub struct Criterion" -A 6 crates/controller/src/store/runs.rs
grep -n "pub struct Criteria" -A 28 crates/controller/src/store/runs.rs
grep -n "pub fn has_any" -A 16 crates/controller/src/store/runs.rs
# 검증·공유 호출자
grep -n "fn validate_criteria\|STEP_METRICS" crates/controller/src/api/runs.rs
grep -rn "validate_run_config(" crates/controller/src --include='*.rs'
# 판정 함수와 호출자(전수)
grep -rn "evaluate_criteria(" crates/controller/src crates/controller/tests
# 분포·평균
grep -n "HDR_LO_US\|HDR_HI_US\|HDR_SIGFIG\|overall.mean()\|per_step" crates/controller/src/report.rs
grep -n "clamp(1, 60_000_000)" crates/engine/src/aggregator.rs
grep -n "fn record_not_sent" -A 4 crates/engine/src/aggregator.rs
# 리포트 구조체
grep -n "pub struct ReportSummary" -A 10 crates/controller/src/report.rs
grep -n "pub struct ReportStep" -A 20 crates/controller/src/report.rs
# 판정 기준을 읽는 곳(전수) — 서버·UI·TUI
grep -rln "max_p95_ms\|step_criteria" crates ui/src desktop --include='*.rs' --include='*.ts' --include='*.tsx'
# 화면 부품
grep -rln "CriteriaFields\|verdictFormat\|expandCriteria\|criteriaHasAny" ui/src
grep -n "fmtMsExact\|fmtMsPair\|fmtCriterionPair" ui/src/print/format.ts
grep -n "p50_ms\|p95_ms\|p99_ms\|mean_ms" ui/src/api/schemas.ts
```

## 11. 1차 검토 지적 (spec-plan-reviewer, 2026-11-23 — 미반영, 재개할 때 처리)

사실로 확인된 것: `build_report`가 `evaluate_criteria`의 유일한 비-테스트 호출자 · `export.rs`·`crates/tui`·`desktop`은 판정 기준을 읽지 않음 · hdrhistogram 7.5.4에 필요한 API 전부 있음 · 새 `Criteria` 칸을 막는 `deny_unknown_fields`/`.strict()` 없음 · 마이그레이션 불필요.

고쳐야 할 것:

1. **결과 행 순서**가 목업(평균 → p95 → p90 → 최대)과 R7(p50 → p95 → p99 → 평균 → 최대 → 백분위)에서 다르다. 하나로.
2. **60초 상한 값의 표현**: `max()`는 칸의 위쪽 끝(60,030.975 ms)을 돌려준다 — §4.4 예시(60000)와 R5가 어긋난다. 서버가 60,000으로 자르거나 `CriterionResult`에 `capped` 표시를 더해, 목록 배지 툴팁·인쇄도 「≥」를 그릴 수 있게(둘은 리포트의 `latency`를 못 본다). `capped` 술어는 `h.max() >= h.lowest_equivalent(60_000_000)`(경계 59.998초 — §4.4의 「59.97초」는 틀림).
3. **시간 글자 형식**: 인쇄 `fmtMsExact`는 `4,210ms`(띄어쓰기 없음·쉼표)라 화면이 그것을 쓰면 기존 행 글자(`4210 ms`)가 바뀐다 — US5와 충돌. 형식 하나를 정하고 R14·US5·목업을 맞춘다.
4. **골든**: `report.rs`의 `whole_report_matches_golden`이 `testdata/report_whole_golden.json`과 바이트 비교한다 — `latency` 추가로 RED. 재생성(`REPORT_WHOLE_GOLDEN_UPDATE`)하고 「차이 = latency 키뿐」을 R19 acceptance로.
5. **`measure_phases` run**: `StepPhaseBreakdown`의 기본 보기가 「waterfall」이라 `StepStatsTable`(과 새 버튼)이 「chips」로 바꿔야 보인다. 그 경로의 버튼 자리를 정하거나 §9에 좁힘으로 기록(사용자 질문).
6. **`passed`는 반올림한 `actual`로** 계산(3000.0004 vs 3000이 「3,000 ≤ 3,000 ✗」로 보이지 않게).
7. **최대·백분위는 항상 올림 쪽**(칸 위쪽 끝, 최대 약 0.1%) — §8에 적는다. 60초 칸에 걸린 백분위 행에도 안내.
8. **인쇄 「평균」 KPI 카드**가 이미 있다(정수 `summary.mean_ms`, `CARD_METRIC`에 평균 없음 → 평균 기준을 걸어도 「목표 없음」). 연결 여부·어느 값을 찍는지 결정.
9. **자릿수 규칙**(1000 이상은 정수인지, 뒤 0 생략) · **50/95/99**(run 목록은 거절, 스텝은 조용히 옛 경로 — UI 규칙 통일) · **60,000 ms 상한의 범위**(스텝 `p50/p95/p99_ms`는 면제임을 명시).
10. **연기 행 추가**: 표준편차·최소를 판정 항목으로(Gatling·k6은 받는다), roadmap §A17 항목 5(다른 도구 대조). US1 문구 변경·US5 추가는 사용자 재확인.

그 밖: `CriteriaState`에 배열 칸을 넣으면 `criteriaHasValue`의 `Object.values(...).trim()`이 깨진다 · `RunDialog`의 칸별 `useState`·`loadPreset`·조립·setter 네 곳이 새 칸을 알아야 한다(모르면 프리셋 불러오기가 조용히 버린다) · `canSubmit` 네 갈래 모두에 기준 검사 · 「프리셋으로 저장」 버튼은 `canSubmit` 게이트 밖 · `evaluate_criteria` 인자 추가는 테스트 호출 16곳 · `ReportJson.latency`(분포 곡선)가 이미 있어 이름이 겹친다(`latency_stats` 검토) · 인쇄 `stepStatus.ts`·`speedBands.ts`·`compare/dumbbell.ts`는 p95만 읽는다(§9에 기록) · 화면 「응답 시간」 vs 인쇄 「응답시간」 띄어쓰기 통일 · 예시 표 파일의 입력이 서버(이름)와 UI(숫자)에서 다르다 · 스텝 기준 `op=min`일 때 `capped` 표시 · US4 라이브는 run 길이를 60초 + 타임아웃보다 길게.
