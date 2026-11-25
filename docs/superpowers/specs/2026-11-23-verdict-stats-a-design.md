# 판정 기준·응답 시간 통계 슬라이스 A — 평균·최대·임의 백분위 판정 + 정확한 경계 비교 + 통계 칸 + 1ms 미만 µs (verdict-stats-a) 설계

- 날짜: 2026-11-23 (초안) · **2026-11-24 다시 씀** — ①A(passed-latency)·①B(sample-switch)·②a·②b(http-error-default)가 머지된 master `3dd6d0d1` 위에서.
- 상태: **③a 구현 완료**(2026-11-24, 코드 `fa8abe79`..`2f3d77e9`, ADR-0065, roadmap §B95) · **③b 구현 완료**(2026-11-25, 코드 `39a4447a`..`d877528b`, roadmap §B96, 둘 다 사용자 지시로 master에 머지) — 다음 ③c(R22–R24). 1차 검토 지적의 처리는 §12, 2차·3차는 §13.
- 유형: `user-path`
- 출처: roadmap §A17 ③ + 항목 1·2·4·7 (사용자 결정 2026-11-23·2026-11-24 — 프로토콜 말고는 LoadRunner 이상, `docs/dev/working-rules.md` §11).
- 사용자 결정 (2026-11-24, 이 세션): **응답 시간 판정을 µs로 정확히 비교한다 — 기존 p50·p95·p99 기준과 응답 속도 구간 건수 포함, 이번 변경 뒤에 만든 run에만**(run마다 규칙 번호를 남긴다, ②의 `status_rule`과 같은 방식). 기각: 새 항목만 정확히(한 표 안에서 같은 43.9 ms가 「p95 ≤ 43」 통과·「p90 ≤ 43」 실패) · 모두 내림 유지(1ms 미만 기준을 못 씀).
- 사용자 결정 (2026-11-24, 2차 검토 뒤): **천 단위 쉼표는 판정 표·배지 툴팁의 시간 값에만**(옛 run도 글자만 `4210` → `4,210`). 스텝 표·요약 카드·워커 표의 **시간 값**은 지금처럼 쉼표 없음(건수 쉼표는 지금 있는 곳 그대로). 「≥ 60,000」은 어디서나 고정 글자.
- 목업(시각 기준): `2026-11-23-verdict-stats-a-mockups/a-screens.html` — 점선 테두리가 새로 생기는 것. 이번에 다시 쓴 결정(행 순서·「모든 스텝」·정수 ms·µs)에 맞춰 고쳤다.
- 관련 결정: ADR-0028(run 판정 기준), ADR-0061(유지 구간 기준), ADR-0063(통과한 요청 표본), ADR-0064(상태 코드 규칙 번호 — 이번 규칙 번호의 선례), ADR-0012(워커 사전 집계 HDR).
- ADR: **신규 ADR-0065** — 응답 시간 경계 비교 규칙(run별 `latency_rule`, 새 run은 µs 비교). 판정 항목 확장(평균·최대·백분위)은 ADR-0028의 additive 확장이라 같은 ADR에 함께 적는다.
- **구현 단위 (2차 검토 권고 채택)**: spec 하나, plan·구현은 셋 — **③a 서버·와이어**(R1–R16·**R19**·R25 + UI Zod 스키마 — `.strict()` 스키마가 새 키를 거절하므로 같은 슬라이스 — 정확히 비교한 실측을 정수로 찍지 않도록 판정 표시 R19도 여기), **③b 새 판정 항목 끝까지**(R17·R18·R20·R21: 입력 화면·인쇄 거울·비교 안내), **③c 통계 표시·µs**(R22–R24). 차례대로, 사이에 릴리즈 금지.
- 이어지는 슬라이스: **④ verdict-stats B** = 시간대별 평균 응답 시간 그래프 + 같은 통계 값을 인쇄 본문·CSV/XLSX·비교 화면에. **③과 ④ 사이에는 릴리즈하지 않는다.**

## 사용자 스토리 (US)

- **US1**: QA가 「평균 응답 시간 3초 이내」 같은 권고를 run 판정 기준으로 걸고 실행한다 — 성공하면 리포트 판정 표에 「평균 응답 시간 · 기준 ≤ 3,000 ms · 실측 N ms · ✓/✗」 행이 나오고, 그 실측은 리포트 요약의 「평균」 카드와 같은 값이다(둘 다 통과한 요청 기준).
- **US2**: QA가 p90처럼 원하는 백분위나 최대 응답 시간을 run 판정 기준으로 건다 — 성공하면 판정 표에 「p90」, 「최대 응답 시간」 행이 나오고 run 목록의 판정 배지에 반영된다.
- **US3**: QA가 특정 스텝에만 평균·최대·백분위 기준을 건다 — 성공하면 그 스텝의 값으로 판정한 행이 스텝 이름과 함께 나온다.
- **US4**: QA가 끝난 run의 「스텝별 결과」 표에서 「응답 시간 통계 더 보기」를 누른다 — 성공하면 스텝마다, 그리고 「모든 스텝」 행에 최소·평균·최대·표준편차·p90이 보인다. 60초를 넘긴 응답이 있는 스텝은 최대가 「≥ 60,000」으로 보이고 그 뜻을 알리는 안내가 붙는다.
- **US5**: QA가 「p95 ≤ 43 ms」 기준으로 이번 변경 뒤에 run을 했고 실제 p95가 43.9 ms다 — 성공하면 판정이 실패(✗)로 나오고, 실측이 「43.9 ms」로 보여 기준과 글자가 같아 보이지 않는다. 기존 p50·p95·p99 기준도, 응답 속도 구간 건수도 같은 경계로 센다.
- **US6**: QA가 이번 변경 전에 만든 run을 연다 — 성공하면 판정 결과·판정 표의 행·목록 배지가 지금과 같다(43.9 ms가 「≤ 43」을 통과했던 옛 run도 그대로 통과). 변경 전에 저장한 프리셋·스케줄은 같은 칸이 채워진 채 열린다.
- **US10** (roadmap §A17 항목 7, 2026-11-24 승인 — 문구 그대로): QA가 응답이 1ms 미만인 요청의 리포트를 본다 — 성공하면 요약·스텝별 표·워커별 표·「다른 기준」 줄·머리말에 「0 ms」가 아니라 「350 µs」처럼 실제 값이 나온다.
- **US11** (같은 곳, 문구 그대로): QA가 응답이 1ms 이상인 run과 이번 변경 전 내보내기 파일을 본다 — 성공하면 화면 숫자와 CSV·XLSX·인쇄·판정이 지금과 같다.

US 사이의 조정: US5는 **새 run**의 판정 표 실측만 소수로 찍는다. US11의 「판정이 지금과 같다」는 옛 run(US6)과 1ms 이상 표시 숫자에 대한 약속이고, 새 run은 정확히 비교하므로 경계(기준 ±1ms 안쪽)에서 판정이 옛 규칙과 다를 수 있다 — 이것이 US5가 바라는 동작이다. US5의 「43.9 ms」는 예시 값이다 — 실제 실측은 분포 칸의 위쪽 끝이라 「43.903 ms」처럼 소수 3자리로 보인다(§1.2). US11의 「인쇄·판정이 지금과 같다」는 옛 run(규칙 1)과 판정 기준이 없는 run에 대한 약속이다 — 규칙 2 run의 인쇄 판정 행 실측은 화면과 같이 소수가 보인다(§6.6).

## 1. 배경

### 1.1 지금 상태 (master `3dd6d0d1` — 사실은 §11 명령으로 확인)

- **판정 기준 모델** `crates/controller/src/store/runs.rs` `Criteria`: run 기준은 고정 칸(`max_p50_ms`·`max_p95_ms`·`max_p99_ms`: `Option<u64>`, 오류율·RPS·4xx/5xx 비율·건수·구간 RPS). 스텝 기준 `Criterion { metric, op, threshold: f64, target }`. `has_any`가 켜진 칸을 나열한다. `profile_json`에 저장된다.
- **검증** `crates/controller/src/api/runs.rs` `validate_criteria`: 스텝 기준 이름은 `STEP_METRICS` 8개만. `validate_run_config`를 run 생성·프리셋 저장·스케줄 저장·스케줄 발사가 함께 쓴다.
- **판정** `crates/controller/src/report.rs` `evaluate_criteria`(순수, 비-테스트 호출자는 `build_report` 하나): run 시간 기준은 `ReportSummary.p50_ms`·`p95_ms`·`p99_ms`를, 스텝 시간 기준은 `ReportStep`의 같은 칸을 읽는다. 이 칸들은 `handicap_engine::percentiles::percentiles_of`가 `value_at_quantile(q) / 1_000`으로 **내린 정수 ms**다. 그래서 p95 43.9 ms는 「≤ 43」을 통과한다(roadmap §A17 항목 7이 확인을 맡긴 점 — 확인됨).
- **판정 표본** (ADR-0063): 판정은 늘 기본 표본(나눌 수 있는 run = 통과한 요청)으로 한다. 요청이 있었는데 통과한 요청이 없으면 시간 기준 행은 `passed: false` + `no_sample: true`(`NoSample`). 화면 표본 전환(`?sample=`)은 보여 주는 숫자만 바꾼다 — `build_report`는 판정용 `summary`·`steps`와 보여 주는 `shown_summary`·`shown_steps`를 따로 만들고 JSON에는 보여 주는 쪽을 싣는다.
- **영속 배지**: run이 끝날 때 판정을 `runs.verdict_json`에 저장한다(`set_verdict`, 목록 배지용 forward-only 캐시). 리포트는 열 때마다 다시 판정한다.
- **규칙 번호 선례** (ADR-0064): `runs.status_rule INTEGER NOT NULL DEFAULT 1`(migration 0029, Rust 가드 `ensure_runs_status_rule`). 새 run은 `store::runs::insert`가 `STATUS_RULE_CURRENT`(2)를 박는다 — 비-테스트 `INSERT INTO runs`는 그 함수 하나이고, 비-테스트 호출자는 `api/runs.rs` `spawn_run`(새 실행·다시 실행·프리셋 실행)과 그것을 부르는 `schedule/runner.rs`(스케줄 발사)다. 리포트 `run.status_rule`은 늘 싣는다.
- **응답 속도 구간** `crates/controller/src/speed_bands.rs` `count_bands`: 표본마다 `value_iterated_to() / 1_000`(내린 ms)을 경계 ms와 비교한다. 같은 내림 문제가 있다.
- **계단 자동 정지·긴급 정지**는 이미 µs로 비교한다(`stair.rs` `cur.p99_us >= cap * 1000`, `auto_stop.rs` `p99_us_limit`). 이번에 건드리지 않는다.
- **분포**: `build_report`는 run 전체 분포(`overall: SplitHist`)와 스텝별 분포(`per_step`)를 표본마다 풀 수 있다(HDR, µs, 1..=60,000,000, 유효 3자리). 범위(유지 구간 `SteadyScope`)가 있으면 그 초 범위의 행만 들어간다. `ReportSummary.mean_ms`(정수 ms 반올림)만 평균을 싣는다. 스텝·워커·「다른 기준」에는 평균·최소·최대·표준편차가 없다.
- **1ms 미만**: 요약·스텝·워커·`BasisOther`(「다른 기준」 줄)의 시간 칸은 정수 ms라 1ms 미만이 「0 ms」로 보인다. 분포 그림은 `ui/src/components/report/format.ts` `formatLatency(us)`(1,000µs 미만이면 「350 µs」)를 쓴다. 머리말(`ReportHeadline.tsx`)은 p95 하나만 정수 ms에서 `formatSecondsKo`·`formatLatencyKo`로 찍어 1ms 미만이 「0.00초」로 보인다.
- **화면**: 입력 `ui/src/components/run/CriteriaFields.tsx`·`StepCriteriaFields.tsx`·`profileForm.ts`(실행 창 `RunDialog.tsx`·스케줄 `ScheduleForm.tsx` 공용). 판정 표시 `ui/src/components/report/verdictFormat.ts`(`METRIC_LABEL`·`fmt` — 시간 값은 `${v} ms`, 쉼표 없음)를 `VerdictPanel`·`VerdictBadge`가 함께 쓴다. 요약 카드 `Summary.tsx`(p50·p95·p99는 `${v} ms`, 평균 카드 없음). **화면의 시간 값에는 천 단위 쉼표가 없다**(판정 표·요약 카드 `${v} ms`·스텝 표 시간 칸). 건수는 곳마다 다르다 — 요약 카드의 총 요청·오류와 머리말·여러 패널은 `toLocaleString`으로 쉼표가 있고, 스텝 표·워커 표의 건수는 맨 숫자다. 인쇄는 시간·건수 모두 쉼표. 스텝 표 `StepStatsTable.tsx`는 대기·다운로드 측정이 없는 run(대부분)에서는 바로 나오고, 측정이 있는 run(`measure_phases`)에서는 `StepPhaseBreakdown`의 「막대」 보기가 기본이고 「칩」 보기에서 나온다.
- **인쇄**: `ui/src/print/verdict.ts` `criteriaHasAny`·`expandCriteria`가 서버의 `has_any`·결과 행 순서를 거울처럼 따라 한다. `CARD_METRIC`(KPI 카드 ↔ 기준)은 `rps`·`p95`·`errorRate`만 잇는다. `ui/src/print/format.ts` `fmtCriterionPair`는 이름이 `_ms`로 끝나면 `fmtMsExact`(소수 3자리까지·쉼표)로 찍는다. `ui/src/print/compare/fairness.ts`가 두 run의 판정 기준·`status_rule` 차이를 본다.
- **비교 화면**: `ui/src/compare/statusRuleNotice.ts`가 규칙 번호가 다른 run을 섞으면 안내를 낸다.

### 1.2 분포에서 얻을 수 있는 값과 한계

평균·최소·최대·표준편차·임의 백분위는 **엔진·워커·proto를 바꾸지 않고** 컨트롤러가 가진 분포에서 계산한다(`hdrhistogram` 7.5.4의 `mean()`·`stdev()`·`min()`·`max()`·`value_at_quantile()`·`lowest_equivalent()`). 한계:

1. **60초 상한**: 엔진이 값을 1µs..60초로 잘라 기록한다(`crates/engine/src/aggregator.rs` `clamp(1, 60_000_000)`). 60초를 넘긴 응답은 60초 칸에 들어간다(유효 3자리에서 그 칸은 59,998,208µs부터 — `max()`는 칸 위쪽 끝 60,030,975µs를, `mean()`은 칸 중간값을 돌려주므로 둘 다 60초를 넘는 값이 나온다). 통과한 요청 표본에서는 요청 타임아웃을 60초보다 길게 둔 run에서만 생긴다(시간 초과는 실패라 통과 표본에 없다).
2. **분포 근사**: 값은 유효 3자리 칸에 들어간다. `value_at_quantile`·`max`는 칸의 위쪽 끝을 돌려주므로 **최대·백분위는 실제보다 최대 약 0.1% 크게(올림 쪽)** 나온다 — 판정은 엄격한 쪽으로 기운다. 평균·표준편차는 칸 대표값으로 계산해 실제와 최대 약 0.1% 다르다.
3. **보내지 않은 요청**은 시간 표본이 없다(지금과 같음).
4. **분위 순위의 부동소수 오차**: `value_at_quantile(99.9 / 100)`은 `99.9/100 × 1000 = 999.0000000000001`이라 순위가 하나 밀려(1,000건이면 999번째가 아니라 최대) 나온다. 그래서 규칙 2의 백분위는 정수 순위로 낸다(R8).

### 1.3 목표가 아닌 것

- 시간대별 평균 그래프, 인쇄 본문·CSV/XLSX·비교 화면의 통계 칸 — ④.
- 실행 중 화면의 응답 시간(ADR-0051).
- 표준편차·최소를 판정 항목으로 — §10 연기(통계 칸에만).
- 지금 p50·p95·p99 **값**을 소수로 바꾸기 — 기각(항목 7). 정수 ms 칸은 그대로 두고 µs 통계 블록을 **더한다**.
- 준비 스텝·병렬 묶음·대기/다운로드의 통계 칸·µs — §10 연기.
- 계단·긴급 정지(이미 µs), 느린 스텝 인사이트(`insights.rs`, p95 정수로 스텝을 고른다 — 판정 아님).
- 워커가 응답 시간 합계를 따로 보내 평균을 정확히 내기 — §10 연기.

### 1.4 하면 안 되는 것

- 옛 run(`latency_rule` = 1)의 판정 결과·결과 행·`passed`·응답 속도 구간 건수를 바꾸는 것(US6).
- 정수 ms 칸(`p50_ms` 등)·`summary.mean_ms`·CSV/XLSX·인쇄의 정수 숫자를 바꾸는 것(US11).
- 60초 칸에 걸린 값을 아무 표시 없이 보여 주는 것(working-rules §9).
- 판정 표(화면)·목록 배지 툴팁·인쇄 판정 행이 서로 다른 행·순서·글자를 내는 것.
- 정확히 비교한 판정의 실측을 내린 정수로 찍어 「실측 43 ms ✗ 기준 ≤ 43 ms」처럼 보이게 하는 것(US5).

## 2. 요구사항 (R-id)

| ID | 요구사항 | acceptance | seam? |
|---|---|---|---|
| R1 | MUST `runs.latency_rule INTEGER NOT NULL DEFAULT 1`(migration 0030, Rust 가드 — `status_rule`과 같은 모양). `LATENCY_RULE_LEGACY = 1`(내린 ms 비교), `LATENCY_RULE_CURRENT = 2`(µs 비교). `store::runs::insert`가 새 run에 2를 박는다. 리포트 `run.latency_rule`은 늘 싣는다(옛 JSON 역직렬화 기본 1). | 마이그레이션 멱등 테스트(두 번 실행). 새 run 생성·다시 실행·프리셋에서 실행·스케줄 발사 각각 2(통합 테스트). 옛 행 1. | ✅ `ReportRun` ↔ Zod |
| R2 | MUST run 기준 새 칸: `max_mean_ms`·`max_max_ms`(`Option<f64>`, ms, 소수 3자리까지), `max_percentiles_ms: Vec<PercentileLimit { percentile: f64, max_ms: f64 }>`. 없거나 비면 직렬화에서 빠진다. `has_any`에 셋을 더한다. | 새 칸이 없는 `Criteria` JSON 바이트 동일 + 새 칸 왕복 테스트. | ✅ serde ↔ Zod `CriteriaSchema` |
| R3 | MUST 스텝 기준 `metric`에 `mean_ms`·`max_ms`·`p<N>_ms`를 받는다. `op`는 지금처럼 `max`·`min`. | `validate_criteria` 표 테스트. | ✅ 이름 문법 서버 ↔ UI |
| R4 | MUST 백분위 정본 표기 하나: `p` + N + `_ms`, N은 0 < N < 100·소수 3자리까지·뒤 0과 불필요한 소수점 없음·앞 0 없음(`0.5`의 `0`만). 서버는 정본이 아닌 이름(`p90.0_ms`, `p090_ms`, `p100_ms`)을 400으로 거절한다. 「소수 3자리까지」 판정(이름의 N·기준 값 모두)은 `|x×1000 − round(x×1000)| < 1e-6`(1.005×1000 = 1004.9999999999999 같은 값을 받으려고)이며 UI도 같은 식이다. 읽기 `parse_percentile_metric(&str) -> Option<f64>`·쓰기 `percentile_metric_name(f64) -> String` 두 함수가 단일 소스. | 서버 표 테스트 + UI 표 테스트가 같은 `testdata/percentile_metric_cases.json`을 읽는다(§4.2 — 이름 쪽 표와 숫자 쪽 표를 한 파일에 따로 둔다). | ✅ |
| R5 | MUST 검증(400 + 한국어 사유): 새 시간 기준 값(run 새 칸·목록·스텝 `mean_ms`/`max_ms`/`p<N>_ms`)은 유한·0 이상·60,000 이하·소수 3자리까지. run 목록은 10개 이하, 같은 N 둘이면 거절, N이 50·95·99면 거절(사유: 「위의 최대 p95 칸을 쓰세요」). 스텝의 `p50_ms`·`p95_ms`·`p99_ms`는 기존 항목 그대로(60,000 상한·소수 3자리 면제 — §10). UI도 스텝 「백분위」 N이 50·95·99면 기존 이름의 검사만 건다(R18이 서버보다 엄하지 않게). | `validate_criteria` 표 테스트 + run 생성·프리셋 저장·스케줄 저장이 같은 400(통합 각 1건). | |
| R6 | MUST 통계 블록 `LatencyStats { min_us, mean_us, max_us, stdev_us, p50_us, p90_us, p95_us, p99_us: u64, capped: bool }`를 `ReportSummary.stats`·`ReportStep.stats`·`WorkerBreakdown.stats`·`BasisOther.stats`에 싣는다(`Option`, 표본이 없으면 키를 뺀다 — `null` 금지). 값은 µs 정수: 최소는 HDR `min()`, 최대는 `min(max(), 60,000,000)`, 백분위는 R8의 정수 순위 값(60,000,000으로 자름), 평균은 `min(round(mean()), max_us)`(칸 중간값이 최대보다 커지지 않게), 표준편차는 `round(stdev())`. 보여 주는 블록은 보여 주는 표본(`?sample=`)과 기준(`?basis=`)을 따른다. 정수 ms 칸(`p50_ms` 등)은 지금 식(`value_at_quantile`) 그대로다 — 0.50·0.95·0.99는 부동소수 순위가 정수 순위와 같으므로(표본 2,000,000건까지 전수, 20,000,000건까지 순위가 정수가 되는 모든 건수 확인 — §11 마지막 명령) 60초 칸 밖에서는 정수 칸 = `floor(stats.p50_us/1000)` 등이 성립한다(60초 칸에서는 정수 칸이 60030, `stats`는 60,000,000으로 자른 값). 순위 오차는 임의 N(예: 99.9 → `99.9/100 = 0.9990000000000001`)에서만 생긴다. | `latency_stats(&Histogram<u64>) -> Option<LatencyStats>` 단위 테스트(손 계산 분포) + `build_report` 테스트(표본별·기준별·키 생략) + Zod `.optional()` 수용 테스트. | ✅ `ReportJson` ↔ Zod `.strict()` |
| R7 | MUST `capped` = `h.max() >= h.lowest_equivalent(60_000_000)`(60,000,000µs가 들어가는 칸, 곧 59,998,208µs 이상에 표본이 있음). | 단위 테스트: 60,000,000µs 기록 → 참, 59,000,000µs까지만 → 거짓, 경계값 하나씩. | |
| R8 | MUST 판정(규칙 2): 시간 기준은 판정 표본 분포의 µs 값으로 비교한다 — `actual_us <= round(threshold_ms × 1000)`(op `min`은 `>=`). 평균 = `mean_us`, 최대 = `max_us`, 백분위 = **정수 순위** `rank = max(1, ceil(N_milli × total / 100_000))`(`N_milli` = N×1000 정수, `total` = 표본 수, 곱은 `u128`)번째 표본이 든 칸의 `highest_equivalent`(60,000,000으로 자름) — 부동소수 순위 오차 없음(§1.2 4), 기존 `p50_ms`·`p95_ms`·`p99_ms`도 이 µs 값. 결과 행 `actual` = `actual_us / 1000`(ms, 소수 3자리까지 정확), `passed`는 정수 비교로 낸다(부동소수 오차 없음). run 기준은 `overall`, 스텝 기준은 그 스텝 분포. | `evaluate_criteria` 표 테스트: 43,900µs vs 43 → ✗(규칙 2)·✓(규칙 1), 0.5 ms 기준 vs 350µs → ✓, op `min`. 순위 테스트: 표본 1,000·10,000건에서 p99.9 = 999번째·9,990번째 값(최대가 아님), p50·p95·p99 경계. | |
| R9 | MUST 판정(규칙 1): 지금 경로 그대로(`p50_ms` 등 내린 정수 비교, 결과 행 `actual` 정수). 규칙 1 run에 새 항목이 있을 수 없다(새 칸은 규칙 2 run만 만든다) — 있으면 규칙 2 방식으로 판정한다(방어, 테스트 1건). | 기존 판정 테스트의 단언은 그대로 통과(호출 17곳·`CriterionResult {` 리터럴 10곳·`RunRow {` 리터럴 11곳(구조체 정의 제외, §11 명령)의 인자·필드 추가는 기계적) + 규칙 1 픽스처에서 `verdict` 바이트 동일. | |
| R10 | MUST 통과한 요청이 없는 자리(`NoSample`)에서 새 시간 기준도 `passed: false` + `no_sample: true`다(ADR-0063 결정 4). 스텝의 `no_sample` 판정이 `mean_ms`·`max_ms`·`p<N>_ms`도 덮는다. 실행 0회 스텝은 지금처럼 건너뛴다. **규칙 2에서는 요청이 있었는데 쓸 수 있는 분포가 없는 자리**(나눌 수 없는 run의 빈 분포 — 모두 보내지 않음 — 와 분포가 깨진 `Resolved::Broken`)도 시간 기준을 `passed: false` + `no_sample: true`로 둔다(지금은 실측 0으로 통과). 요청이 0건인 run(끝났는데 요청이 없음)은 규칙 2에서 시간 기준 행을 만들지 않는다(판정할 것이 없다 — 실행 0회 스텝과 같은 태도, 지금은 실측 0으로 통과). 켜진 행이 전부 빠지면 판정 자체가 없다(지금 규칙). 규칙 1은 지금 그대로. | 단위 테스트(run·스텝). 되돌려 확인. | |
| R11 | MUST 결과 행 순서(run 기준): **평균 → 백분위(고정 p50·p95·p99와 목록을 합쳐 N 오름차순) → 최대** → `error_rate` → 4xx/5xx 비율 → 4xx/5xx 수 → `rps` → `min_window_rps` → 스텝 기준(입력 순). 새 항목이 없는 run은 지금 순서와 같다. 이름 `mean_ms`·`max_ms`·`p<N>_ms`(목록 N은 정본 쓰기 함수로). | 단위 테스트(순서) + 인쇄 `expandCriteria` 같은 순서(UI 테스트). 되돌려 확인. | ✅ 서버 순서 ↔ 인쇄 거울 |
| R12 | MUST (규칙 2) `CriterionResult.capped: bool`(`skip_serializing_if` false) = **「실측이 하한일 뿐이고 실제는 더 클 수 있다」**: 최대·백분위 행은 실측이 60초 칸 값(60,000 ms로 자른 값)일 때, 평균 행은 분포가 `capped`일 때 참. 판정: `capped` 행이 op `max`면 기준과 상관없이 실패(실제가 기준을 넘었을 수 있다 — 거짓 통과보다 거짓 실패, §3.5), op `min`이면 보통 비교(하한이 기준 이상이면 실제도 이상). 규칙 1 run의 기존 항목(p50·p95·p99 등) 행에는 `capped`를 내지 않고 판정도 지금 그대로(규칙 1 run에 새 항목이 있으면 — R9 방어 경로 — 그 행은 `capped` 포함 규칙 2로 판정). | 단위 테스트: 최대·p99.9·평균 × op `max`/`min` × capped 참/거짓. 규칙 1 무변화. 되돌려 확인. | ✅ |
| R13 | MUST 응답 속도 구간(규칙 2): 경계를 µs로 고른다(`step_boundary`가 소수 기준을 `floor` 하지 않고 `round(t × 1000)` µs) — 와이어 `SpeedBandRow`에 `slow_us: u64`를 더하고(규칙 2만, 규칙 1은 키 없음) `count_bands`가 표본 µs 값을 `slow_us`·`FAST_MS × 1000`과 비교한다. `slow_ms`는 지금처럼 내린 정수. 인쇄 `print/speedBands.ts`와 인쇄 비교 `print/compare/speedCompare.ts`(경계 글자 `fmtBoundary(o.slow_ms)`·같은 경계 판정 `b.slow_ms === a.slow_ms`)는 `slow_us`가 있으면 그 값(`slow_us/1000`, 같음 판정도 µs)을 쓴다. 규칙 1은 지금 그대로. 경계 선택(p95 → p99 → p50 → 3,000)은 그대로. | 단위 테스트: 43,900µs 표본이 경계 43에서 규칙 2는 초과·규칙 1은 이내, 스텝 기준 43.5에서 경계 43,500µs. `speed_bands_test.rs` `verdict_agrees_with_over_share`가 규칙 2·소수 기준에서도 성립. UI 테스트(인쇄 경계 글자). | |
| R14 | MUST 판정은 리포트 기준(`?basis=`)을 따른다 — `build_report`가 이미 범위 안 분포만 합친다. 판정은 표본 전환과 무관하게 기본 표본이다(ADR-0063). | 유지 구간 run에서 두 기준의 평균 실측이 다른 테스트 + `?sample=all`이어도 `verdict` 동일 테스트. | |
| R15 | MUST 일치: 보여 주는 표본이 기본 표본일 때 `summary.stats.mean_us / 1000` = run 평균 기준 `actual`, 스텝 `stats.mean_us / 1000` = 그 스텝 평균 기준 `actual`(최대·p90·p50·p95·p99도). 같은 함수(`latency_stats`)에서 나온다. | 단위 테스트(동일 값). | |
| R16 | MUST 규칙 1 run의 리포트 JSON에서 달라지는 것은 `stats` 블록·`run.latency_rule` 키뿐이다. 규칙 2 run은 그에 더해 시간 행의 `actual` 소수·`capped`, 경계의 `passed`·`verdict.passed`(와 그것을 읽는 인사이트 `slo`·요약 문장), 응답 속도 구간 건수·`slow_us`가 달라질 수 있다. | `testdata/report_whole_golden.json` 재생성(`REPORT_WHOLE_GOLDEN_UPDATE`) 후 diff가 그 키들뿐임을 plan 절차로 확인. `compare_golden.json` 무수정 통과. | |
| R17 | MUST 입력 화면(실행 창·스케줄 폼): run 기준 「평균 응답 시간(ms)」·「최대 응답 시간(ms)」 칸(소수 허용), 「다른 백분위 기준」 행(추가·삭제, 새 행 N 기본 90), 스텝 기준 항목 「평균(ms)」·「최대(ms)」·「백분위(ms)」(+N 칸, 기본 90). 스텝 백분위 N이 50·95·99면 기존 이름(`p95_ms`)으로 보낸다. 저장된 `p90_ms`는 「백분위」+90으로, `p95_ms`는 「p95(ms)」로 열린다. 다시 열면(프리셋 불러오기·다시 실행·스케줄 수정) 그대로 채워진다. | RTL: 입력 → `buildCriteria` 와이어, 와이어 → `criteriaStateFrom` 왕복, 프리셋 불러오기·다시 실행 프리필, 스케줄 수정. | |
| R18 | MUST 입력 화면은 서버가 거절할 값을 보내기 전에 막고 칸 옆에 이유를 쓴다(범위 밖·겹친 N·목록의 50/95/99·60,000 초과·소수 4자리 이상·10개 초과). 실행·스케줄 저장·**프리셋 저장** 모두 막는다. | RTL: 경우마다 안내 문구 + 버튼 막힘(세 버튼). | |
| R19 | MUST 판정 표·목록 배지 툴팁: 이름 「평균 응답 시간」·「최대 응답 시간」·「p<N>」(문법으로 풀어 만든다). 시간 값 글자는 소수 3자리까지·뒤 0 생략·천 단위 쉼표(사용자 결정) + 「 ms」(`43.903 ms`, `4,210 ms`, `0.35 ms`) — 옛 run의 정수 실측은 쉼표만 붙고 숫자는 같다. `capped` 행의 실측은 앞에 「≥ 」(`≥ 60,000 ms`, `≥ 1,842.613 ms`). `capped` 행이 하나라도 있으면 표 아래 60초 안내(배지 툴팁은 「≥」만). | RTL(`verdictFormat`·`VerdictPanel`·`VerdictBadge`). | |
| R20 | MUST 인쇄 판정 행 = 화면 판정 표(KPI 카드로 옮겨 가는 행은 지금처럼 빠진다 — `print/verdict.ts`의 `CARD_METRIC` 규칙): `criteriaHasAny`·`expandCriteria`가 새 칸과 R11 순서를 안다. `CARD_METRIC`에 평균 카드 ↔ `mean_ms`를 잇는다(카드 값은 지금처럼 정수 `summary.mean_ms`, 목표 글자는 기준). `capped` 행은 「≥」를 찍는다(`fmtCriterionPair`에 넘긴다). `fairness.ts`가 새 칸과 `latency_rule` 차이를 본다 — 조건 행 「응답 시간 판정 규칙」(`statusRule`·`statusRuleName` 「오류 집계 규칙」 선례, `5d99c737`). 인쇄 항목 이름표가 새 이름을 안다. | UI 테스트(`print/__tests__/verdict.test.ts` 등). | |
| R21 | MUST 비교 화면: `latency_rule`이 다른 run을 섞으면 `statusRuleNotice`와 같은 자리에 안내. 상태 코드 규칙도 함께 다르면(②와 ③이 같은 릴리즈로 나가므로 실제로는 늘 함께 다르다) **안내 하나**로 합쳐 두 규칙을 한 문장에 적는다. | RTL. | |
| R22 | MUST 요약에 「평균」 카드(「실행 시간」 뒤·p50 앞). 값 = 보여 주는 `summary`의 평균(`stats`가 있으면 `mean_us`, 없으면 `—`). 1ms 이상이면 `summary.mean_ms`를 그대로(`${v} ms`), 1ms 미만이면 `formatLatency(mean_us)`(「350 µs」). `stats.capped`면 앞에 「≥ 」(§1.4 — 60초 칸에 걸린 평균을 표시 없이 보이지 않게, 판정 표 평균 행과 같은 뜻). 숫자 식은 R24의 「모든 스텝」 평균과 하나(1ms 이상 `min(summary.mean_ms, 60000)`). | RTL. | |
| R23 | MUST 1ms 미만 µs 표시(US10): 요약 카드·스텝 표·워커 표·「다른 기준」 줄의 p50·p95·p99·평균과 머리말의 p95(머리말은 p95 하나만 찍는다)는 `stats`가 있고 그 값이 1,000µs 미만이면 `formatLatency(us)`로, 1,000µs 이상이면 지금 글자 그대로(정수 ms). `stats`가 없으면(옛 JSON) 지금 글자. 머리말의 1–10ms 「0.00초」·「0.01초」는 그대로(§B92 (0-1) — 사용자 승인 대기). 같은 표면들에서 p50·p95·p99 값이 60초 칸 값(`stats`의 그 µs 값 = 60,000,000)이면 정수 칸(60030 등) 대신 고정 글자 「≥ 60,000」(머리말은 「60초 이상」) — µs 표시와 한 헬퍼. 접힌 스텝 표도 포함(60초 칸 값이 없는 run의 DOM은 지금과 같다). 설명 안내는 스텝 표 아래(접힘·펼침 모두 — 「≥」 칸이 하나라도 있으면)에만 붙이고, 요약 카드·워커 표·「다른 기준」 줄·머리말은 「≥ 60,000」(「60초 이상」) 글자 자체가 뜻을 말하므로 안내 없이 둔다(내 판단). | RTL: 350µs → 「350 µs」, 43,900µs → 지금 글자(「43 ms」). 표면마다 1건. | |
| R24 | MUST 스텝 표 「응답 시간 통계 더 보기」(기본 접힘, `aria-expanded`): 펼치면 요청·오류 뒤에 최소·평균·최대·표준편차, 그 뒤 p50·**p90**·p95·p99, 맨 아래 「모든 스텝」 행(값 = 보여 주는 `summary.stats`). 새 칸 값은 R23 규칙(1ms 이상 정수 ms, 미만 µs) — 정수는 최소·최대·p90을 내림(옆 p 칸과 같다), 평균·표준편차를 반올림. 「모든 스텝」 행의 평균과 요약 「평균」 카드는 **같은 식** 하나를 쓴다: 1ms 이상이면 `min(summary.mean_ms, 60000)`, 1ms 미만이면 `formatLatency(stats.mean_us)`. 카드만 `capped`일 때 앞에 「≥ 」를 붙인다(표 안의 60초 칸 평균·표준편차는 표 아래 안내가 표시한다). `stats`가 없는 스텝은 「—」. 60초 칸 값인 칸(최대, 그리고 p50·p90·p95·p99 중 그 `stats` µs 값이 60,000,000인 칸)은 고정 글자 「≥ 60,000」(R23과 같은 헬퍼 — 정수 칸이 60030처럼 나와 「최대 ≥ 60,000」 옆에 더 큰 숫자가 서지 않게, 화면만, 인쇄·내보내기 정수는 그대로) + 표 아래 안내. 「모든 스텝」 행을 위해 `StepStatsTable`에 보여 주는 `summary`를 넘긴다(`ReportView` → `StepPhaseBreakdown` → `StepStatsTable`). 펼친 상태에서도 조건 반복 분리·반복 나눔 아래 줄과 대기·다운로드 열은 지금처럼 나오고, 아래 줄의 `colSpan`은 늘어난 열 수를 따른다. 버튼은 표에 붙으므로 측정 run의 「막대」 보기에는 없다(「칩」 보기로 바꾸면 나온다). | RTL: 접힘 기본·펼침 뒤 열·행·「—」·「≥」·안내. | |
| R25 | SHOULD 분포에서 낸 평균 오차가 실제 평균의 0.1% 이내임을 테스트로 남긴다. | 합성 표본의 정확한 평균과 비교. | |

## 3. 설계 근거

1. **규칙 번호로 새 run만 정확히.** 정확한 비교가 맞다(사용자 결정). 하지만 리포트는 열 때마다 다시 판정하고 목록 배지는 끝날 때 저장한 값이라, 옛 run을 새 규칙으로 판정하면 리포트(✗)와 배지(✓)가 갈린다. 상태 코드 규칙(ADR-0064)과 같은 이유·같은 모양이다. 별도 칸으로 두는 것은 두 규칙이 독립이라서다(상태 코드 규칙만 바뀐 run과 응답 시간 규칙만 바뀐 run을 구분할 일은 없지만, 번호 하나에 두 뜻을 겹치면 다음 규칙 변경 때 조합이 꼬인다).
2. **µs 통계 블록을 더하고 정수 칸은 둔다.** 항목 7 결정(ms 값을 소수로 바꾸는 안 기각) 그대로다. 블록 하나(`stats`)에 µs 정수로 담으면 「표본 없음」을 블록 유무 하나로 표현하고, 1ms 미만 표시·통계 칸·정확한 판정이 같은 값을 읽는다. 이름은 `latency`가 아니라 `stats`다 — `ReportJson.latency`(분포 곡선)와 겹친다.
3. **판정 표 실측은 µs/1000 ms.** 기준을 ms로 적으므로 판정 표는 ms로 맞춘다(1ms 미만도 「0.35 ms」). µs 정수 / 1000은 소수 3자리로 정확해, 기준(소수 3자리까지)과 글자가 같으면 값도 같다(「실측 43 ✗ 기준 43」이 생기지 않는다).
4. **표본 없음 = 실패.** ADR-0063 결정 4. 초안의 「행 없음」은 ①A 이전 규칙이라 버린다.
5. **최대·백분위의 올림 쪽 근사와 60초 칸(`capped`).** HDR이 칸 위쪽 끝을 주므로 판정은 엄격한 쪽으로 기운다. 60초 칸 값과 그런 분포의 평균은 「실제는 이보다 크거나 같다」는 하한일 뿐이라, 상한 기준(op `max`)은 실패로 둔다 — 거짓 통과보다 거짓 실패가 정직하다(working-rules §9). 하한 기준(op `min`)은 하한이 이미 기준 이상이면 실제도 이상이라 보통 비교가 맞다.
6. **run 기준은 고정 칸 + 목록, 스텝 기준은 이름 문법.** 지금 모델의 갈래를 그대로 넓힌다. 목록에서 50·95·99를 거절해 같은 일을 하는 길을 하나로 둔다(규칙 2에서 두 길의 값은 같지만, 둘 다 채운 기준은 행이 둘 생긴다).
7. **행 순서는 사람이 읽는 순서.** 평균 → 백분위 오름차순 → 최대가 응답 시간 분포를 왼쪽에서 오른쪽으로 읽는 순서다. 옛 행(p50 → p95 → p99)의 상대 순서는 그대로라 US6과 충돌하지 않는다.
8. **판정 표만 쉼표(사용자 결정).** 화면의 시간 값은 쉼표를 쓰지 않지만(건수는 요약 카드 등 일부에만, 인쇄는 모두 쓴다), 새 run의 판정 실측은 소수 3자리가 붙어 길어지고(`4210.687`) 인쇄 판정 행(`fmtMsExact`)과 글자를 맞춘다. 스텝 표·카드는 쉼표 없는 이웃 칸과 맞춘다. 값은 같다(US6은 값·행·결과의 약속).
9. **인쇄 거울은 이번에.** 거울이 새 칸을 모르면 화면에 있는 판정 행이 인쇄에서 빠진다 — 지금 있는 표가 틀리게 되는 문제다.
10. **스텝 표 새 칸은 정수 ms.** 항목 7(「1ms 이상은 지금처럼 정수 ms」)과 같은 표의 기존 p50·p95·p99 칸에 맞춘다. 초안의 유효 숫자 4자리는 버린다.

### 접근 비교

| 안 | 내용 | 판단 |
|---|---|---|
| **가 (채택)** | 컨트롤러가 가진 분포에서 계산 + µs 통계 블록 + run별 응답 시간 규칙 번호(새 run만 µs 비교). | 엔진·워커·proto 0, 마이그레이션 1(규칙 칸). 옛 run의 판정·숫자 불변, 새 run은 정확. 최대·백분위 올림 쪽 0.1%. |
| 나 | 새 항목만 µs로 비교, 기존 p50·p95·p99는 내림 유지 | 규칙 번호가 없지만 한 표 안에서 같은 값이 항목마다 다르게 판정된다(사용자 기각). |
| 다 | 모두 내림 유지 | 1ms 미만 기준을 못 쓴다(사용자 기각). |
| 라 | 워커가 합계·최소·최대를 따로 보냄 | 평균이 정확하지만 proto·엔진·옛 run에 값 없음. 0.1% 정밀도에 비해 크다 — §10. |

## 4. 와이어

### 4.1 판정 기준 (`profile.criteria`)

```jsonc
{
  "max_mean_ms": 3000,                          // 새. 없으면 키 없음
  "max_max_ms": 10000,                          // 새
  "max_percentiles_ms": [                       // 새. 비면 키 없음
    { "percentile": 90, "max_ms": 2500 },
    { "percentile": 99.9, "max_ms": 8000 }
  ],
  "max_p95_ms": 5000,                           // 기존 그대로(u64)
  "step_criteria": [
    { "metric": "mean_ms", "op": "max", "threshold": 500, "target": "<step id>" },
    { "metric": "p90_ms",  "op": "max", "threshold": 1200, "target": "<step id>" }
  ]
}
```

- Rust: `max_mean_ms: Option<f64>`, `max_max_ms: Option<f64>`, `max_percentiles_ms: Vec<PercentileLimit>`(`#[serde(default, skip_serializing_if = "Vec::is_empty")]`). `profile_json`이라 마이그레이션 없음.
- Zod `CriteriaSchema`: `max_mean_ms`·`max_max_ms` = `z.number().nonnegative().optional()`, `max_percentiles_ms` = `z.array(z.object({ percentile: z.number(), max_ms: z.number().nonnegative() })).optional()`.

### 4.2 백분위 이름 문법 (R4)

- 정본·읽기·쓰기는 R4. `p50_ms`·`p95_ms`·`p99_ms`는 문법에 맞지만 기존 항목으로 먼저 처리한다.
- 예시 파일 `testdata/percentile_metric_cases.json`:
  ```jsonc
  { "names":   [ { "input": "p90_ms", "percentile": 90 }, { "input": "p90.0_ms", "percentile": null }, … ],
    "numbers": [ { "input": "90.0", "name": "p90_ms" }, { "input": "100", "name": null }, … ] }
  ```
  서버는 `names`(이름 → 받음/거절·N)와 `numbers`의 `name`을 쓰기 함수로 다시 만들어 대조, UI는 `numbers`(입력 글자 → 이름)와 `names`(이름 → 항목·N 복원)를 읽는다.

### 4.3 리포트

```jsonc
"run": { …기존…, "status_rule": 2, "latency_rule": 2 },
"summary": { …기존(정수 ms 그대로)…, "stats": { "min_us": 840, "mean_us": 1842613, "max_us": 60000000,
             "stdev_us": 4120020, "p50_us": 1204223, "p90_us": 3480191, "p95_us": 4210687, "p99_us": 7930879, "capped": true } },
"steps":   [ { …기존…, "stats": { … } } ],
"worker_breakdown": [ { …기존…, "stats": { … } } ],
"basis":   { …, "other": { …기존…, "stats": { … } } },
"verdict": { "criteria": [ { "metric": "p95_ms", "threshold": 43, "actual": 43.903, "passed": false, … },
                           { "metric": "max_ms", "threshold": 10000, "actual": 60000, "passed": false, "capped": true } ] }
```

- Rust `LatencyStats`(R6), 네 구조체에 `stats: Option<LatencyStats>` + `#[serde(default, skip_serializing_if = "Option::is_none")]`. `ReportRun.latency_rule: u8` + `#[serde(default = …LEGACY)]`. `CriterionResult.capped: bool` + `#[serde(default, skip_serializing_if = "std::ops::Not::not")]`.
- Zod: `LatencyStatsSchema`(`.strict()`), 네 스키마에 `stats: LatencyStatsSchema.optional()`, `ReportRun`에 `latency_rule`(없으면 1로 읽는 헬퍼 — `reportStatusRule` 선례), `CriterionResult`에 `capped: z.boolean().optional()`, 응답 속도 구간 행(`schemas.ts`의 `SpeedBandRow` 스키마와 그것을 `.extend().strict()`한 스텝 행)에 `slow_us: z.number().optional()` — 빠뜨리면 규칙 2 리포트가 전부 파싱 실패한다.
- 내보내기(`export.rs`)는 `stats`를 싣지 않는다(US11) — `ReportJson`에서 열을 고르는 코드라 자동으로 빠지는지 plan에서 확인.

## 5. 서버 변경

### 5.1 `store/` — R1·R2
- `mod.rs` `ensure_runs_latency_rule`(migration 0030, `/new-migration` 절차, pragma 가드). `runs.rs`: 상수 둘, `RunRow.latency_rule`, `narrow_latency_rule`(모르는 값 → LEGACY, `narrow_status_rule` 선례), `insert`가 CURRENT를 박는다, 두 `SELECT`가 칸을 읽는다. `Criteria` 세 칸 + `PercentileLimit` + `has_any`.

### 5.2 `api/runs.rs` `validate_criteria` — R3·R4·R5
- 새 칸 검사, `STEP_METRICS` + `mean_ms`·`max_ms` + 백분위 문법. 이름 함수 둘은 새 모듈(`crates/controller/src/percentile_name.rs` 등 — 자리는 plan)에 두고 검증·판정·결과 행 이름이 함께 쓴다.

### 5.3 `report.rs` — R6–R12·R14–R16
- `latency_stats(h) -> Option<LatencyStats>`(빈 분포 `None`). 판정용·보여 주는 summary/steps, 워커 표, `api/runs.rs` `other_of`가 부른다(`BasisOther.stats`는 `ReportSummary.stats`를 복사).
- `evaluate_criteria`에 `latency_rule`과 판정 분포를 넘긴다: run은 판정 표본 분포 `overall_h`(`build_report`에서 판정 호출 시점까지 살아 있고 `speed_bands::build`는 빌리기만 한다), 스텝은 스텝 id → 판정 분포(`per_step_hists`). 임의 백분위는 `LatencyStats`(p50·p90·p95·p99만)로 낼 수 없어 분포를 직접 읽는다. 인자가 7개라 더하면 clippy `too_many_arguments`(`-D warnings`)에 걸린다 — 판정 입력을 구조체 하나로 묶는다(`#[allow]` 금지). 호출자: `build_report` + 테스트 17곳.
- **함정 — 보여 주는 블록이 판정 통계를 물려받는다**: `shown_summary`는 `..summary.clone()`, `shown_steps`는 `..s.clone()`으로 만든다. `stats`를 판정용 구조체에 두면 `?sample=failed|all`에서 통과 표본 통계가 조용히 보인다 — 보여 주는 쪽의 `stats`는 `shown_step_p`·`shown_summary` 계산 안에서 그 표본 분포로 따로 낸다(R6 테스트가 표본별 값을 단언).
- 규칙 2의 시간 값 하나를 내는 함수 하나(`time_actual_us(metric, stats, hist)`)를 판정·통계가 함께 쓴다(R15 — 식을 두 번 쓰지 않는다).
- 성능(working-rules §10): 분포마다 `mean`·`stdev`(각각 칸 전체 순회 한 번)·정수 순위 백분위 네 번(칸 순회 — 한 번의 누적 순회로 넷을 함께 낼 수 있다)·`min`·`max`. 분포를 다시 디코드·복사하지 않는다. 대상 = 「스텝 많은 run(예: 50스텝 × 600초)의 리포트 빌드 시간」 기존 대비 한 번 측정(plan).

### 5.4 `speed_bands.rs` — R13
- `count_bands`(와 호출자 `build`)에 규칙을 넘긴다. 규칙 1 경로는 글자 그대로.

### 5.5 건드리지 않는 것
엔진·워커·proto, `export.rs`(판정 기준·`stats`를 읽지 않는다 — 확인만), `stair*.rs`·`auto_stop.rs`(이미 µs), `insights.rs`(실패한 기준 수·p95 정수로 느린 스텝), `validity.rs`(시간 기준 값을 읽지 않음 — plan에서 grep 확인), `crates/tui`·`desktop`(운영 모니터 판정이라 무관).

## 6. 화면 변경 (목업이 시각 기준)

### 6.1 입력 — `CriteriaFields.tsx`·`StepCriteriaFields.tsx`·`profileForm.ts`·`RunDialog.tsx`·`ScheduleForm.tsx` (R17·R18)
- run 기준 격자 맨 앞에 「평균 응답 시간(ms)」·「최대 응답 시간(ms)」. 격자 아래 도움말 한 줄: 「평균은 느린 응답 몇 건이 있어도 낮게 나올 수 있습니다. 대부분의 사용자가 겪는 속도를 보려면 p95를 함께 거세요.」
- 그 아래 「다른 백분위 기준 (선택)」: 행 = `p [N] ≤ [값] ms ×`, 「+ 백분위 기준 추가」.
- 스텝 기준 항목 선택 맨 앞에 「평균(ms)」·「최대(ms)」·「백분위(ms)」. 「백분위」면 N 칸(기본 90).
- `CriteriaState`에 `maxMean`·`maxMax`·`percentiles: { p: string; ms: string }[]`. **`criteriaHasValue`의 `Object.values(...).trim()`은 배열 칸에서 깨진다 — 배열을 따로 본다.** `criteriaActiveCount`(접힘 머리 「N개 설정됨」)·`buildCriteria`·`criteriaStateFrom`이 새 칸을 안다. 값이 빈 백분위 행은 보내지 않는다.
- `RunDialog`는 칸마다 `useState`·`loadPreset`·조립·setter 네 곳이 새 칸을 알아야 한다(모르면 프리셋 불러오기가 조용히 버린다). `ScheduleForm`도 칸마다 `useState`·조립·setter 세 곳이 있다(같은 누락 위험). `canSubmit`의 모든 갈래와 「프리셋으로 저장」(지금 `canSubmit` 밖)에 기준 검사를 건다.
- 잘못된 입력은 그 행 아래 붉은 글씨 이유. 두 진입 화면(실행 창: 새 run·다시 실행·프리셋 불러오기 / 스케줄 폼: 새로·수정)에서 확인(working-rules §4).

### 6.2 판정 표시 — `verdictFormat.ts`·`VerdictPanel.tsx`·`VerdictBadge` (R19)
- `METRIC_LABEL` + 문법 풀이(`p<N>_ms` → 「p<N>」). 시간 값 `fmt`: R19 규칙. 인쇄 `fmtMsExact`와 같은 글자 규칙이므로 공유 함수 하나로(자리는 plan).
- `capped` 행(R12의 뜻 — 실측이 하한): 실측 앞에 「≥ 」, 표 아래 안내(목업 문구 — 평균·최대 행이 없어도 `capped` 행이 하나라도 있으면). 배지 툴팁은 「≥」만.

### 6.3 요약 카드 — `Summary.tsx` (R22·R23)
「실행 시간」 뒤, p50 앞에 「평균」. 격자 열이 하나 늘어난다 — 좁은 폭·큰 숫자에서 겹침·잘림을 라이브로 잰다.

### 6.4 스텝 표 — `StepStatsTable.tsx` (R23·R24)
- 표 제목 줄 오른쪽 「응답 시간 통계 더 보기 ▸」/「응답 시간 통계 접기 ▾」. 접힌 상태 DOM은 지금 표와 같다(되돌려 확인 대상).
- 열이 늘어 넓어지므로 가로 스크롤 상자 안에 둔다. 「모든 스텝」 행 데이터·아래 줄 `colSpan`·대기/다운로드 열은 R24.

### 6.5 µs 표시 표면 (R23)
요약 카드(`Summary.tsx`)·스텝 표·워커 표(파일은 plan에서 grep)·「다른 기준」 줄(`BasisOther`를 그리는 곳)·머리말(`ReportHeadline.tsx`). 공유 헬퍼 하나(`msOrUs(ms, us?)` 같은 것 — 1,000µs 이상이면 지금 글자를 그대로 돌려준다).

### 6.6 인쇄·비교 — `print/verdict.ts`·`format.ts`·`compare/fairness.ts`·`compare/statusRuleNotice.ts` 곁·`ko.ts` (R20·R21)
- 인쇄 본문 숫자는 정수 그대로(US11). 판정 행 실측은 서버 `actual`을 `fmtMsExact`로 찍으므로 규칙 2 run은 소수가 보인다(화면과 같다). 응답 속도 구간 경계 글자는 R13(`slow_us`).
- `stepStatus.ts`·`speedBands.ts`·`compare/dumbbell.ts`는 p95만 읽는다 — 그대로(§10).

### 6.7 문구
모든 새 문구는 `ko.ts` 경유(ADR-0035). 띄어쓰기는 화면 「응답 시간」으로 통일(인쇄 「응답시간」은 ④에서). 용어 풀이(`ko.glossary`)에 「평균 응답 시간」·「표준편차」·「p90」·「최대 응답 시간」을 더하고 표 머리 HelpTip에 건다. 「전체」 대신 「모든 스텝」(사용자 낱말 결정 — 「모든 요청」 표본 이름과 겹치지 않게).

## 7. 다른 도구의 판정 항목 대조 (roadmap §A17 항목 5)

착수 시점에 아는 범위의 대조다(공식 문서를 이 세션에서 다시 읽지 않았다 — 항목을 더할 때 그 도구 문서로 확인).

| 항목 | LoadRunner SLA | k6 thresholds | Gatling assertions | JMeter | handicap (③ 뒤) |
|---|---|---|---|---|---|
| 평균 응답 시간 | ✓ | ✓ `avg` | ✓ `mean` | (Duration Assertion은 요청별) | ✓ |
| 임의 백분위 | ✓ | ✓ `p(N)` | ✓ `percentile(N)` | — | ✓ |
| 최대 | — | ✓ `max` | ✓ `max` | 요청별 | ✓ |
| 최소·중앙값 | — | ✓ `min`·`med` | ✓ `min` | — | 중앙값 = p50 ✓, 최소 ✗ |
| 표준편차 | — | — | ✓ `stdDev` | — | ✗(통계 칸만) |
| 오류율 | ✓ | ✓ rate | ✓ `failedRequests.percent` | — | ✓ |
| 초당 오류 수 | ✓ Errors per Second | ✓ rate/count | — | — | ✗ |
| 처리량(RPS) 하한 | ✓ Hits per Second | ✓ rate | ✓ `requestsPerSec` | — | ✓ |
| 전송량(바이트) | ✓ Throughput | ✓ data metrics | — | — | ✗ |
| 구간별(시간대) 판정 | ✓ 구간별 SLA | — | — | — | 부분(최소 구간 RPS) |
| Apdex | — | — | — | ✓ 대시보드 | ✗ |

빠진 것(✗)은 §10에 후보로 남긴다.

## 8. 사용자에게 알릴 차이

- 평균·백분위·최대는 통과한 요청 기준이다(LoadRunner와 같다 — ADR-0063).
- 이번 변경 뒤 run은 응답 시간 기준을 µs로 비교한다. 옛 run과 기준 ±1ms 안쪽에서 판정이 다를 수 있다(비교 화면이 알린다). 릴리즈 노트에 적는다.
- 최대·백분위는 실제보다 최대 0.1% 크게, 평균은 ±0.1% 안에서 나온다(3,000 ms 기준이면 ±3 ms).
- 60초를 넘긴 응답은 60초로 기록된다. 그런 값에 영향을 받은 실측은 하한이라 앞에 「≥」가 붙고(최대·60초 칸 백분위는 「≥ 60,000 ms」, 평균은 「≥ 1,842.613 ms」처럼), 상한 기준(≤)은 실패, 하한 기준(≥)은 보통 비교로 판정한다(R12).

## 9. 테스트·검증

- 서버 단위: R1–R16·R25 표 테스트. 회귀 가드(R9 규칙 1 바이트 동일, R10 표본 없음, R11 순서, R7 `capped`, R13 규칙 갈래, R16)는 되돌려 확인.
- UI: R4 예시 파일, R17–R24 RTL. `.strict()` 스키마라 `stats`가 있는 픽스처·없는 픽스처를 둘 다.
- 골든: R16 절차.
- 라이브(US-anchored, `/live-verify`):

| US | 절차 | 통과 신호 |
|---|---|---|
| US1 | 고정 지연 응답기(예: 40 ms)로 run, `max_mean_ms` | 평균 행 실측 ≈ 지연, 「평균」 카드와 같은 값(반올림). 기준을 지연보다 작게 준 run은 ✗ + 목록 배지 실패 |
| US2 | p90·p99.9·최대 기준, 90%는 빠르고 10%는 느린 응답기 | 행 이름·값, p90과 p95가 갈림 |
| US3 | 두 스텝 지연이 다른 시나리오, 스텝 평균 기준 | 스텝 이름 붙은 행, 그 스텝 값 |
| US4 | 60초 넘게 붙잡는 응답기(요청 타임아웃 > 60초, run 길이 > 60초 + 타임아웃) | 「≥ 60,000」(최대·60초 칸 p 칸)·안내, 평균 기준 행 「≥ …」 ✗. 보낸 요청 없는 스텝은 「—」 |
| US5 | 지연을 기준 + 0.9 ms로(예: 43.9 ms) 맞추고 `max_p95_ms: 43` | ✗, 실측 소수 3자리(예: 「43.903 ms」). 인쇄 판정 행 같은 글자. 응답 속도 구간 「초과」에 들어감 |
| US6 | 이번 변경 전 DB의 run·프리셋·스케줄을 새 바이너리로 열기 | 판정 표·배지·속도 구간 지금과 같음. 비교 화면에 옛·새 run → 규칙 안내 |
| US10 | localhost 응답기(1ms 미만) | 다섯 표면에 「NNN µs」 |
| US11 | 1ms 이상인 옛 run(규칙 1)과 판정 기준 없는 새 run의 CSV·XLSX·인쇄를 변경 전 바이너리 출력과 대조 | 같음(규칙 2 run의 인쇄 판정 행 소수는 US5 쪽) |

- 극단값: 백분위 기준 10개 + 스텝 기준 여럿 + 긴 스텝 이름에서 실행 창·판정 표·펼친 스텝 표·요약 카드 줄의 겹침·잘림을 rect로 잰다.
- 진입 화면: 실행 창(새 run·다시 실행·프리셋 불러오기)·스케줄 폼(새로·수정).
- 보안 게이트: 요청 실행·템플릿·바인딩 무접촉 예상 — `finish-slice` §0 grep을 직접 돌린다.

## 10. 연기 (roadmap §B에 옮길 것)

| 항목 | 왜 미루나 | 틀렸을 때 비용 | 푸는 길 |
|---|---|---|---|
| 표준편차·최소·초당 오류 수·전송량·Apdex 판정(§7 ✗) | US에 없음 | 다른 도구 판정을 옮겨 올 수 없다 | 같은 `stats`·문법 위에 항목 추가 |
| 준비 스텝·병렬 묶음·대기/다운로드의 통계 칸·µs | 표마다 분포 출처가 다르다 | 본 스텝 표에만 통계·µs | 각 분포에 `latency_stats` |
| 평균을 정확히(워커 합계 전송) | proto·엔진 | 기준 경계 ±0.1%에서 판정이 뒤집힐 수 있다 | `MetricWindow`에 `sum_us` |
| 스텝 `p50/p95/p99_ms`·run 고정 칸의 60,000 상한 검사 | US6(지금 동작 유지) | 판정할 수 없는 기준을 받는다 | 새 항목 검사로 통일 |
| 속도 구간·계단 경계가 평균·임의 백분위를 읽게 | 범위 밖 | 평균 기준만 건 run은 속도 구간 경계가 기본값 | `run_boundary`에 평균 추가 |
| 인쇄 `stepStatus.ts`·`speedBands.ts`·`compare/dumbbell.ts`가 p95만 | 인쇄 본문은 ④ | 인쇄 스텝 상태가 새 기준을 모른다 | ④ |
| 「응답시간」(인쇄) 띄어쓰기 | 인쇄 본문은 ④ | 화면과 인쇄 낱말이 다르다 | ④ |
| 화면의 나머지 숫자(스텝 표·요약 카드·워커 표 등)에 천 단위 쉼표 | 사용자 결정(2026-11-24): 이번엔 판정 표만, 나머지는 다음에 | 큰 숫자를 읽기 어렵고 판정 표와 글자 모양이 다르다 | 화면 숫자 표시 헬퍼 하나로 일괄(별도 소형 슬라이스) |
| 분포가 깨진 자리(`Broken`)의 안내 문구 | 드물다(저장 BLOB 손상) | 규칙 2에서 「통과한 요청 없음」으로 보인다(실제는 「계산하지 못함」) | `no_sample` 옆에 사유 칸 |
| 인쇄·내보내기 정수 칸의 60초 칸 값(60030) | US11 | 인쇄 p99가 60030으로 보일 수 있다 | ④에서 「≥ 60,000」 |
| ④ 전체 | — | ③만 나가면 화면과 내보내기 칸이 다르다 | ③·④ 사이 릴리즈 금지 |

## 11. 사실 확인 명령 (claims-ledger)

```bash
# 판정 기준 모델·has_any·규칙 번호 선례
grep -n "pub struct Criteria" -A 28 crates/controller/src/store/runs.rs
grep -n "pub fn has_any" -A 16 crates/controller/src/store/runs.rs
grep -n "STATUS_RULE\|fn narrow_status_rule\|INSERT INTO runs\|pub async fn insert(" crates/controller/src/store/runs.rs
grep -rn "runs::insert(" crates/controller/src --include='*.rs'
grep -rn "INSERT INTO runs" crates/controller/src --include='*.rs'
grep -n "ensure_runs_status_rule" -A 16 crates/controller/src/store/mod.rs
# 검증·공유 호출자
grep -n "fn validate_criteria\|STEP_METRICS" crates/controller/src/api/runs.rs
grep -rn "validate_run_config(" crates/controller/src --include='*.rs'
# 판정 함수·호출자(전수)·내림
grep -rn "evaluate_criteria(" crates/controller/src crates/controller/tests
grep -n "pub fn percentiles_of" -A 7 crates/engine/src/percentiles.rs
grep -n "push_max\|step_no_sample" crates/controller/src/report.rs
# 판정 표본·보여 주는 표본
grep -n "default_sample\|shown_summary\|shown_steps\|no_sample_run\|per_step_hists" crates/controller/src/report.rs
# 영속 배지
grep -n "pub async fn set_verdict" -A 6 crates/controller/src/store/runs.rs
# 속도 구간 내림·계단 µs
grep -n "value_iterated_to() / 1_000" crates/controller/src/speed_bands.rs
grep -n "p99_us >=\|p99_us_limit" crates/controller/src/stair.rs crates/controller/src/auto_stop.rs
# 분포 상한·구조체
grep -n "clamp(1, 60_000_000)" crates/engine/src/aggregator.rs
grep -n "pub struct ReportSummary\|pub struct ReportStep\|pub struct WorkerBreakdown\|pub struct CriterionResult\|pub latency: Option<LatencyDistribution>" crates/controller/src/report.rs
grep -n "pub struct BasisOther" -A 9 crates/controller/src/steady.rs
grep -n "let other_of" -A 14 crates/controller/src/api/runs.rs
# 골든
grep -n "REPORT_WHOLE_GOLDEN_UPDATE\|report_whole_golden" crates/controller/src/report.rs
# 판정 함수 인자·보여 주는 블록 복사·속도 구간 경계 내림
grep -n "let shown_summary\|let shown_steps\|\.\.summary.clone()\|\.\.s.clone()" crates/controller/src/report.rs
grep -n "fn step_boundary" -A 16 crates/controller/src/speed_bands.rs
grep -n "pub struct SpeedBandRow" -A 7 crates/controller/src/speed_bands.rs
grep -n "enum Resolved" -A 8 crates/controller/src/sample.rs
# hdrhistogram 칸 경계(유효 3자리) lowest_equivalent(60_000_000)=59_998_208, highest_equivalent=60_030_975:
#   ③a의 R7 단위 테스트가 이 두 값을 단언한다(그 테스트가 재현 명령 — `cargo nextest run -p handicap-controller latency_stats`)
# 부동소수 순위 = 정수 순위 (p50·p95·p99) — 기대 출력 세 줄: `0.5 0 0 []` / `0.95 0 0 []` / `0.99 0 0 []`
python3 -c "import math
for q,k,st in [(0.50,50,2),(0.95,95,20),(0.99,99,100)]:
    a=[n for n in range(1,2_000_001) if math.ceil(q*n)!=-(-k*n//100)]
    b=[n for n in range(st,20_000_001,st) if math.ceil(q*n)!=k*n//100]
    print(q,len(a),len(b),b[:5])"
# 화면·인쇄
grep -n "formatSecondsKo\|formatLatencyKo" ui/src/components/report/ReportHeadline.tsx
grep -n "{s.count}\|{s.error_count}" ui/src/components/report/StepStatsTable.tsx
grep -n "phaseViewChips\|phaseViewWaterfall" ui/src/i18n/ko.ts
grep -n "useState" ui/src/components/run/ScheduleForm.tsx
grep -n "export function fmt\b\|export function fmt(" ui/src/components/report/verdictFormat.ts
grep -n "const ms" ui/src/components/report/Summary.tsx
grep -n "export function formatLatency" -A 3 ui/src/components/report/format.ts
grep -n "CARD_METRIC" ui/src/print/verdict.ts
grep -n "export function fmtMsExact\|export function fmtCriterionPair" ui/src/print/format.ts
grep -rn "StepStatsTable" ui/src/components --include='*.tsx'
grep -n "view === \"chips\"" ui/src/components/report/StepPhaseBreakdown.tsx
grep -rln "status_rule\|statusRule" ui/src
grep -rln "max_p95_ms\|step_criteria" crates ui/src desktop --include='*.rs' --include='*.ts' --include='*.tsx'
```

## 12. 1차 검토 지적(2026-11-23)의 처리

| # | 지적 | 처리 |
|---|---|---|
| 1 | 행 순서가 목업과 R7에서 다름 | R11 하나로(평균 → 백분위 오름차순 → 최대), 목업 고침 |
| 2 | 60초 상한 값 표현·`capped` 술어 | R6(60,000,000으로 자름)·R7(술어 고침)·R12(`CriterionResult.capped` — 배지·인쇄도 「≥」) |
| 3 | 시간 글자 형식이 기존 행을 바꿈 | R19: 쉼표는 판정 표에만(사용자 결정 2026-11-24)·소수 3자리, 값 불변(§3.8). 옛 run 정수는 소수가 안 붙는다 |
| 4 | 전체 리포트 골든 RED | R16 재생성 절차 |
| 5 | 측정 run(`measure_phases`)의 「막대」 보기 | R24: 버튼은 표(「칩」 보기)에 붙는다 |
| 6 | 반올림한 `actual`로 `passed` | R8: µs 정수 비교로 대체(부동소수 경계 없음) |
| 7 | 최대·백분위 올림 쪽, 60초 칸 백분위 | §1.2·§8·R12 |
| 8 | 인쇄 「평균」 KPI 카드 | R20: `CARD_METRIC`에 평균 ↔ `mean_ms` |
| 9 | 자릿수·50/95/99·60,000 상한 범위 | R19·R23·R24(자릿수), R5·R17(50/95/99: run 목록 거절, 스텝은 기존 이름으로), R5(스텝 p50/95/99 면제 명시) |
| 10 | 연기 행·US 재확인 | §10 첫 행·§7, US1·US5·US6 사용자 재승인(2026-11-24) |
| 그 밖 | `criteriaHasValue` 배열·`RunDialog` 네 곳·`canSubmit`·프리셋 저장 버튼·호출 수·이름 겹침·인쇄 p95-only·띄어쓰기·예시 파일 입력 차이·`op=min` capped·US4 run 길이 | §6.1·§5.3·§4.3(`stats`)·§10·§6.7·§4.2·R12(행마다 `capped`)·§9 US4 |

## 13. 2차 검토 지적(2026-11-24)의 처리

| 지적 | 처리 |
|---|---|
| 1 `insert_run` 이름 | `store::runs::insert`로 고침(§1.1·R1·§5.1), 호출자 둘 명시 |
| 2 쉼표 전제 거짓·목업 기존 칸 쉼표 | 사용자 결정: 판정 표·배지만 쉼표(머리 결정 줄·R19·§3.8). 목업의 판정 표 밖 숫자에서 쉼표를 뺐다 |
| 3 머리말 사실 | §1.1·R23(머리말은 p95 하나, 1–10ms 「0.00초」는 §B92 그대로) |
| 4 스텝 표가 나오는 조건·보기 이름 | §1.1·R24(측정 run만 「막대」 기본, 표 보기 이름 「칩」) |
| 5 `capped` 경계 숫자 | §1.2·R7(59,998,208µs) |
| 6 「기존 테스트 무수정」 | R9: 단언 불변, 호출·리터럴 개수 명시 |
| 7 R16 「뿐」 | R16: 규칙 1/2 나눠 적음 |
| F1 run 임의 백분위·인자 수 | §5.3: `overall_h` 전달 + 판정 입력 구조체 |
| F2 분위 순위 부동소수 | §1.2 4·R8: 정수 순위, 순위 테스트 |
| F3 평균이 최대를 넘음 | R6: `mean_us ≤ max_us` |
| F4 정수 p 칸 60030 | R24: 화면은 60초 칸 값을 「≥ 60,000」(정수 칸 불변), §10 인쇄·내보내기 행 |
| F5 속도 구간 경계 내림 | R13: `slow_us`(규칙 2) + 인쇄 경계 글자 |
| F6 보여 주는 블록이 판정 통계 물려받음 | §5.3 함정 |
| F7 빈·깨진 분포 | R10(규칙 2는 실패 + `no_sample`), §10 Broken 문구 행 |
| F8 소수 3자리 판정식 | R4(허용 오차 식, UI 같은 식) |
| F9 `ScheduleForm` 세 곳 | §6.1 |
| F10 「모든 스텝」 데이터·`colSpan`·아래 줄 | R24 |
| C1 R12 규칙·op 범위 | R12 다시 씀(규칙 2만, op별) |
| C2 행 `capped`의 뜻 | R12: 「실측이 하한」으로 정의, 안내는 `capped` 행 하나라도 있으면 |
| C3 capped 평균 거짓 통과 | R12·§3.5: op `max` 실패, 목업 평균 행 ✗ 「≥」로 고침 |
| C4 평균 카드 글자 | R22: 1ms 이상은 `summary.mean_ms` 그대로 |
| C5 새 칸 반올림 | R24: 최소·최대·p90 내림, 평균·표준편차 반올림 |
| C6 US5 「43.9」 | US 조정 문단·§9 US5(예시 값, 실제 소수 3자리) |
| C7 US11 vs 규칙 2 인쇄 | US 조정 문단·§9 US11 대상 한정. roadmap §A17 항목 7 ④ 문구는 ③a 마무리 때 고친다 |
| C8 스텝 N=95와 상한 | R5(UI도 기존 이름 검사만) |
| C9 인쇄 = 화면(카드로 옮겨 가는 행) | R20: 카드 규칙 예외 명시 + 「≥」 |
| C10 두 비교 안내 동시 | R21: 하나로 합침 |
| 범위 | ③a·③b·③c 셋으로 나눔(머리 줄) |
| fairness 조건 행 이름 | R20: 「응답 시간 판정 규칙」 |

### 3차 검토(2026-11-24) 처리

| 지적 | 처리 |
|---|---|
| 1 화면 쉼표 사실 | §1.1 정정(시간 값만 쉼표 없음, 건수는 곳마다). 목업 총 요청 카드 「182,400」 복원 |
| 2 목업 「≥ 60000」 | 목업을 「≥ 60,000」으로 |
| 3 `slow_us` Zod·인쇄 비교 | §4.3 Zod 목록, R13에 `speedCompare.ts` |
| 4 평균 카드 표시 없는 60초 칸 평균 | R22: `capped`면 「≥」 |
| 5 「≥ 60,000」 적용 표면 | R23: µs 표시와 같은 표면·같은 헬퍼(접힌 표 포함) |
| 6 「모든 스텝」 평균 vs 카드 | R24: `summary.mean_ms` |
| 7 §8 ↔ R12 | §8 다시 씀 |
| 8 요청 0건 run | R10: 규칙 2는 시간 행을 만들지 않음 |
| 9 R19 소속 | 머리 줄: ③a |
| 10 낡은 글 | 머리 상태 줄·§1.2 번호·§5.3 성능 줄·§12 5행·§11 경계 줄(③a R7 테스트가 재현) |

### 4차 검토·직접 재확인(2026-11-24) 처리

사용자 지적(「똑바로 확인하자」) 뒤 §11 명령 전부와 검토가 낸 사실 주장을 직접 다시 돌렸다(§11 출력·스크래치 Rust `hdrhistogram 7.5.4`: 칸 경계 59,998,208/60,030,975, 전부 60초 칸일 때 `max()` 60,030,975·`mean()` 60,014,592, 표본 1,000건 p99.9 = 1000(정답 999)·10,000건 = 99,967(정답 99,903), 43,900µs 칸 위쪽 끝 43,903). 리포트는 `client.ts` `parser.parse`라 `.strict()` 스키마의 모르는 키는 리포트 화면 오류 — 해당 스키마 6개 `.strict()` 확인, `CriterionResultSchema`만 `.strict()`가 아니다(`capped`를 빠뜨리면 조용히 버려진다). 틀렸던 것: 리터럴 개수(10·11로 정정), 처음 판의 `insert_run`(없는 이름).

| 지적 | 처리 |
|---|---|
| 1 쉼표 문장 셋 | 머리 결정 줄·§3.8·목업 머리 글 정정(「시간 값」) |
| 2 「모든 스텝」 평균 = 카드 | R22·R24: 같은 식 하나(`min(summary.mean_ms, 60000)`), 카드만 「≥」 |
| 3 R6 과장 | 「60초 칸 밖에서」 |
| 4 펼친 표 밖 「≥」 안내 | R23: 안내는 스텝 표 아래만, 나머지 표면은 글자만(내 판단) |
| 5 §11 기대 출력 | 고침 |
