# 판정 기준·응답 시간 통계 ④ — 시간대별 평균 응답 시간 그래프 + 인쇄·CSV/XLSX·비교의 통계 칸 (verdict-stats-b) 설계

- 날짜: 2026-11-25 · 기준 master `c9e6574d`(③c 머지 뒤)
- 상태: spec 검토 APPROVE(2026-11-26, 3라운드 — 1차 지적 9건·2차 5건 반영). ④a plan 검토(1차)가 찾은 빈틈 — 60초 칸이 섞인 초·창의 평균이 표시 없이 하한값으로 보임 — 을 창·초별 `capped` 표지로 메움(R-A1·R-A2·R-A4·R-A5·R-A8·R-A9, 같은 날 재검토 APPROVE). ④a plan `docs/superpowers/plans/2026-11-26-verdict-stats-4a.md` 검토 APPROVE(3라운드). **④a 구현·최종 리뷰·라이브 끝(2026-11-26, 코드 `33fbd79c`..`3367b864`, 판단·연기 roadmap §B98 — 「요청이 없던 초는 잇기」·부록 카드 상자 x0 10 등 spec/plan과 다른 판단 포함).** ④b·④c plan은 다음. **④b plan 검토(2026-11-26)가 찾은 정정**: R-B9 「`fmtMs` 한 곳에서 모든 정수 칸」은 틀렸다 — 인쇄 「측정 조건」의 think time도 `fmtMs`를 쓰고(길이 글자 `fmtDurMs`로 가른다), 준비 스텝 인쇄 표는 `fmtCount`를 쓴다(따로 고친다). R-B4 Windows `capped`는 ④a가 창에 실은 `capped`도 본다. R-B11·R-B12의 잘림 규칙은 비교 인쇄 기존 응답 시간 행·95% 덤벨에도 넣는다. 목업 6번 「98ms → 0.10초」는 글자 규칙과 어긋난 예시(실제 「98ms → 104ms」). 상세는 ④b plan.
- 유형: `user-path`
- 출처: roadmap §A17 ④ + 항목 3·4(나머지 표면) · ③ spec(`2026-11-23-verdict-stats-a-design.md`) §1.3·§10이 ④로 넘긴 것 · roadmap §B97 (1) 「60초 칸 스텝의 최소가 59998」.
- 목업(시각 기준): `2026-11-25-verdict-stats-b-mockups/b-screens.html` — 점선 테두리가 새로 생기는 것. 사용자가 「대체로 괜찮다」로 승인(2026-11-25), 해석하다 필요한 것은 나중에 더 말하기로 함.
- 관련 결정: ADR-0009·0051(실시간 화면 범위), ADR-0030(비교 골든 패리티), ADR-0061(유지 구간 표시), ADR-0063(통과한 요청 표본), ADR-0065(µs 통계 블록 `stats`).
- ADR: 신규 없음 — 리포트 응답에 칸을 **더하는** 일이고(ADR-0065의 `stats`와 같은 결), 새 구조 결정이 없다. 「서버는 초별 원자료 창만 보낸다」는 리포트 함정 노트(`ui/src/components/report/CLAUDE.md` bySecond 항목)의 예외는 그 노트에 적는다(R-A1).

### 사용자 결정 (2026-11-25, 이 세션 — 다시 묻지 않는다)

1. **옛 run은 신경 쓰지 않는다**(사용자: 「다 날려버릴 거야」). 내보내기 파일 모양을 옛 것과 맞추려고 새 칸을 맨 뒤에 몰아 붙이지 않는다. 옛 리포트 JSON을 읽을 수 있게 하는 serde 기본값 정도만 둔다(골든 fixture가 옛 모양 JSON이라서). 옛 run 전용 판정 규칙(`status_rule`·`latency_rule` 1)을 걷어내는 일은 ④ 밖 — roadmap 후보로 적는다(§10).
2. **슬라이스 셋**: ④a 「응답 시간 그래프」 · ④b 「통계 칸」 · ④c 「비교 인쇄의 시간 흐름에 응답 시간」. 기능으로 자른다(층으로 자르는 안 기각 — 비교 골든 짝이 갈라지고 ④a만으로 라이브 검증할 것이 없다). **③ ↔ ④a ↔ ④b 사이 릴리즈 금지**, ④c는 덧붙이는 기능이라 그 앞에서 릴리즈해도 된다.
3. 화면 그래프 = **(다)**: 기본은 모든 스텝을 합친 선, 「스텝별로 보기」를 펼치면 스텝별.
4. 지금 「p95 응답 시간」 그래프와의 관계 = **(1) 한 그래프 「응답 시간」에 평균선 + p95선**. p95는 「같은 초 스텝들 중 가장 큰 p95」 근사를 버리고 서버가 초마다 모든 스텝을 합쳐 낸 정확한 값으로.
5. 「스텝별로 보기」 = **(ㄴ) 스텝마다 작은 그래프 격자, 같은 세로 눈금**. **나중에 (ㄱ) 한 그래프에 선 겹치기를 더할 수 있게 확장 가능하게**(R-A6).
6. 인쇄: 본문 그래프 자리에 모든 단계 합친 응답 시간 그래프(평균·p95), **스텝별 세부는 문서 맨 뒤 부록**에 단계마다 작은 그래프. 부록 위치 = **기존 부록 바로 뒤, 서명란 앞**.
7. 비교 인쇄: 요약 표에 p90·최대 + 「단계별 평균 응답 시간 변화」 덤벨(④b). 시간 흐름 겹쳐 보기의 응답 시간은 **④c**.
8. CSV/XLSX 시간 값 = **(A) ms 소수 3자리**(`0.350`, `43.903`), 60초 칸은 `60000.000`으로 자르고 `capped` 열로 표시.

## 사용자 스토리 (US)

(2026-11-25 사용자 승인 — 문구 그대로)

**④a 응답 시간 그래프**
- **US1**: QA가 끝난 run의 리포트를 연다 — 성공하면 「응답 시간」 그래프에 초마다 모든 스텝을 합친 **평균선과 p95선**이 함께 보이고, 그 p95는 그 초의 모든 요청을 합쳐 낸 값이다(지금처럼 스텝들 중 가장 큰 p95를 찍지 않는다).
- **US2**: QA가 그래프의 「스텝별로 보기」를 펼친다 — 성공하면 스텝마다 평균선이 스텝 이름과 함께 보여서 어느 스텝이 언제 느려졌는지 가려낼 수 있다. 처음 열면 접혀 있다.
- **US3**: QA가 run 보고서를 인쇄한다 — 성공하면 본문 그래프 자리에 평균·p95 응답 시간 그래프가, 문서 맨 뒤 「부록」에 스텝마다 작은 평균 응답 시간 그래프가 본문 스텝 표 순서대로 들어 있다.
- **US4**: QA가 비교 화면 겹쳐 보기에서 지표 「평균」을 고른다 — 성공하면 run마다 초별 평균 응답 시간 선이 겹쳐 보인다.

**④b 통계 칸**
- **US5** (버그) — 재현: 모든 응답이 60초를 넘긴 스텝의 리포트에서 「응답 시간 통계 더 보기」를 펼친다. 기대: 최소가 「≥ 60,000」. 실측: 「59998」(60초 미만 응답이 있었던 것처럼 읽힌다).
- **US6**: QA가 run 리포트를 CSV·XLSX로 내려받는다 — 성공하면 스텝마다·모든 스텝 합계에 최소·평균·p50·p90·p95·p99·최대·표준편차가 ms 소수 3자리로(1ms 미만도 `0.350`처럼) 들어 있고, 60초를 넘긴 값이 있는 스텝은 `capped`가 표시된다.
- **US7**: QA가 run 보고서를 인쇄한다 — 성공하면 본문에서 스텝마다·모든 스텝 합계의 최소·평균·최대·표준편차·p90을 볼 수 있다.
- **US8**: QA가 두 run을 비교 화면에서 본다 — 성공하면 요약 표에 최소·평균·최대·표준편차·p90 행이 기준 run 대비 변화율과 함께 나오고, 「응답 시간 통계 더 보기」를 펼치면 스텝마다 같은 행이 보인다. 비교 CSV·XLSX에도 같은 값이 들어간다.
- **US9**: QA가 비교 보고서를 인쇄한다 — 성공하면 요약 표에 p90·최대가 있고, 「단계별 평균 응답시간 변화」 그림에서 어느 단계의 평균이 나빠졌는지 보인다.

**④c 비교 인쇄의 시간 흐름**
- **US10**: QA가 비교 보고서를 인쇄한다 — 성공하면 시간 흐름 겹쳐 보기 절에 이전·이후 run의 초별 평균 응답 시간 선이 함께 보인다.

US 사이의 조정: US9의 「응답시간」은 사용자 승인 문구 그대로 두되, 인쇄 화면 글자는 R-B9에 따라 「단계별 평균 응답 시간 변화」로 띄어 쓴다.

## 1. 배경

### 1.1 지금 상태 (master `c9e6574d` — 사실은 §11 명령으로 확인)

- **초별 창** `crates/controller/src/report.rs` `ReportWindow { ts_second, step_id, count, error_count, status_counts, p50_ms, p95_ms, p99_ms }`. `build_report`가 행마다 `(ts_second, step_id)` 키의 `WindowAcc { count, error_count, status, hist: SplitHist }`에 쌓고(유지 구간 범위와 상관없이 **모든 행** — 그림용), 닫힘 `window_of`가 `acc.hist.resolve(sample).hist().map(percentiles_of)`로 정수 ms 백분위를 낸다(`value_at_quantile(q) / 1_000` 내림). 보여 주는 창(`windows`)은 `window_acc.into_iter()`로 옮겨 가며 만들고, 보여 주는 표본이 모든 요청이 아닐 때(`selected != Sample::All` — 나눌 수 있는 run의 기본 표본 「통과한 요청」 포함) 점유 창(`occupancy_windows`, 모든 요청)을 따로 만든다. 평균·표본 수는 창에 없다.
- **창의 스텝**: 창은 http 잎 스텝(loop·parallel 자식 포함)마다다. 준비 스텝(`setup:`)은 다른 테이블(`run_section_step_metrics`)이라 창에 없다. if·loop·parallel 묶음 id는 창에 없다.
- **표본**: `SplitHist`(`crates/controller/src/sample.rs`)가 모든 요청·실패 분포를 쌓고 `resolve(Sample)`이 통과한 요청 = 모든 요청 − 실패를 낸다(행 단위 빼기라 창별로 풀어 합쳐도 전체를 풀어도 같다). 화면 표본(`?sample=`)은 창 백분위에도 적용된다(`selected`).
- **통계 블록** `crates/controller/src/latency_stats.rs` `LatencyStats { min_us, mean_us, max_us, stdev_us, p50_us, p90_us, p95_us, p99_us, capped }`가 `ReportSummary.stats`·`ReportStep.stats`·`WorkerBreakdown.stats`에 실린다. `max_us`·백분위는 60초(`CAP_US`)로 자르고 `mean_us`는 `min(max)`로 자르지만, **`min_us`는 `h.min()` 그대로**라 60초 칸뿐인 분포에서 칸 아래쪽 끝 59,998,208을 낸다(US5의 원인). 화면 `latencyShown`(`ui/src/components/report/format.ts`)은 `us >= CAP_US`면 「≥ 60,000」을 찍으므로 서버가 60,000,000을 주면 화면은 고칠 것이 없다.
- **화면 시계열** `ui/src/report/bySecond.ts` `bySecond(report)`가 창을 초별로 합쳐 `{ ts_second, count, errors, p95_ms }`를 낸다 — `p95_ms`는 **같은 초 창들 중 가장 큰 p95**(주석: "coarse signal"). 쓰는 곳: `ReportView.tsx`(그래프 셋: 초당 요청 수·p95·초당 에러, `TimeSeriesChart` — 선 하나짜리 Recharts)와 비교 겹쳐 보기 `ui/src/compare/overlaySeries.ts`(`MetricKey = "rps" | "p95" | "errors"`, 화면 `CompareOverlaySection.tsx` 체크박스·`CompareTimeSeriesChart.tsx`). 실행 중 진행 차트(`ui/src/runs/liveSeries.ts` + `RunDetailPage.tsx`)는 따로이고 응답 시간 선이 없다(초당 요청·에러만). 단 그 화면도 `TimeSeriesChart`를 쓴다 — 그래서 이번 응답 시간 그래프는 `TimeSeriesChart`를 고치지 않고 새 컴포넌트로 만든다(R-A4).
- **인쇄** `ui/src/print/`: 표준판 절 = 1 종합 결과(계단 시험 run이면 계단 블록이 그 뒤에) · 2 단계별 결과(`StepCodeTable` — 응답 시간은 「95% 응답」 한 칸, `fmtMs(row.p95Ms)`, 정수 `p95_ms`라 60초 칸이면 60030) · 준비 스텝 · 응답 속도 구간 · 시간에 따른 변화(블록 `chart` = `ErrorChart` — 처리량 선 + 오류 막대, `chartModel.ts` `pickBinSeconds`가 막대 120개 이하가 되게 1·2·5·…·300초 칸) · 측정 조건 · 용어 풀이 · 「부록. 그 밖의 기준 전체」(판정 행이 넘칠 때만) · 서명란. 쪽 나누기 `paginate.ts`: 블록은 `atomic`(나누지 않음) 또는 `table`(행 단위로 나눔), 높이는 180mm 숨은 시트에서 잰다(`data-measure`). 요약판(한 쪽)은 그래프·부록이 없다. 인쇄 스텝 상태 `stepStatus.ts`는 오류율·**p95 기준만** 보고 「느림」을 단다. 인쇄 글자는 「응답시간」(붙여 씀)이다.
- **내보내기** `crates/controller/src/export.rs`(서버): 단일 run CSV `report_to_csv`(`step_id,count,error_count,p50_ms,p95_ms,p99_ms` 정수, 통과한 요청이 없으면 빈 칸 — `latency_missing`), XLSX `report_to_xlsx`(시트 Summary·Steps·Windows·Setup·Status·Branches·Insights·Other basis·Stairs — Summary 시트는 `write_summary_numbers`가 0–6행 고정 7행, 유효성 행이 7–8행에 박혀 있고(주석 「H2: rows 7–8」), Other basis 시트가 같은 도우미 `write_summary_numbers`·`write_steps_table`을 쓴다), 비교 CSV `comparison_to_csv`(`SUMMARY_METRICS = [p50_ms, p95_ms, p99_ms, rps, error_rate]` 행 × run 열 + `delta_pct`), 비교 XLSX `comparison_to_xlsx`(Summary·Steps[스텝별 p95]·Setup·Runs·Insights).
- **비교 골든 패리티**(ADR-0030): `testdata/compare_golden.json`을 Rust(`export.rs` `golden_summary_deltas_match`·`golden_polarity_matches`·`golden_missing_cases_match`)와 TS(`ui/src/compare/__tests__/compareReports.test.ts`)가 함께 읽는다. fixture는 `Vec<ReportJson>`으로 역직렬화된다. fixture의 리포트에는 `stats`가 없다(요약 키 `count, errors, rps, duration_seconds, mean_ms, p50_ms, p95_ms, p99_ms`, `windows: []`). 변화율 `pct: None`은 지금 「기준이 0」을 뜻하고 화면 `DeltaChip`·Rust `delta_cell_text`가 「신규」/「동일」로 찍는다.
- **화면 ms 글자 규칙**(③c, `StepStatsTable.tsx`): 최소·최대·백분위는 µs를 ms로 **내림**, 평균·표준편차는 **반올림**, 1ms 미만은 µs(`latencyShown`), 60초 칸은 「≥ 60,000」.
- **비교 화면** `ui/src/compare/compareReports.ts`: 요약 행 = `SUMMARY_METRICS` 같은 다섯(정수 `summary.p50_ms` 등), 스텝 행 = 스텝마다 `p95_ms` 하나. 표 `components/compare/CompareMatrix.tsx`는 `String(cell.value)`로 찍는다(단위·60초 칸 처리 없음). 접는 장치 없음.
- **인쇄의 정수 ms ≥ 60,000은 60초 칸에서만 나온다**: 정수 백분위는 `value_at_quantile`(칸 위쪽 끝)을 1000으로 내린 값이라 60초 칸이면 60,030, 그 아래 칸의 위쪽 끝은 59,998,207µs → 59,998이다(③ spec §11 스크래치 — 칸 경계 59,998,208/60,030,975). 정수 평균·최대도 60초 칸 값이 없으면 59,998,207µs를 넘을 수 없다. 그래서 「정수 ms ≥ 60,000 ⇔ 그 값이 60초 칸」이 성립한다(R-B9가 이것을 쓴다).
- **판정 비교 규칙**(③a, `report.rs` `rule2_row`): 기준 µs = `(threshold × 1000).round()`, 상한 기준은 `!capped && us <= t_us`(60초 칸이면 실패), 평균의 `capped`는 분포 전체 플래그(`latency_stats.capped`), 최대·백분위는 그 값이 60초 칸인지. 판정 행 `CriterionResult { metric, direction, threshold, actual, passed, target, no_sample, capped }` — 스텝 기준 행은 `target = step_id`. 스텝 기준 백분위는 아무 백분위(`p75_ms`·`p99.9_ms`)나 받지만 `stats`는 p50·p90·p95·p99만 싣는다.
- **비교 인쇄** `ui/src/print/compare/`: 절 = 개요 · 핵심 지표(`change.ts` `SPECS` = 오류율·p99·p95·평균·처리량·요청 수, `Spec.value`는 맨 숫자, `major` 플래그가 머리 문장 건수를 정한다 — `headline.ts`; 핵심 지표 블록 `cmp:kpi:plain`/`bars`는 한 쪽 요약판에도 나온다) · 단계별 95% 응답시간 변화(`dumbbell.ts`, p95만) · 단계별 오류 · 시간 흐름(`overlay.ts` — 처리량·오류만) · 응답 속도 구간 · 조건 · 문제 단계. 번호는 `sectionNo`가 있는 절만 센다.

### 1.2 목표가 아닌 것

- 실행 중 진행 차트에 평균(사용자 범위 밖 — 끝난 리포트·인쇄만, ADR-0051 범위 안이지만 이번엔 안 함).
- 「스텝별로 보기」의 (ㄱ) 한 그래프 선 겹치기 — 자리만 남긴다(R-A6).
- 인쇄 요약판(한 쪽)에 그래프·부록·통계 표.
- 준비 스텝·병렬 묶음·대기/다운로드의 시계열·통계 칸(③ §10 그대로).
- 인쇄 응답 속도 구간(`speedBands.ts`)이 평균을 보게 — 속도 구간 경계 자체가 평균을 모른다(③ §10 「속도 구간·계단 경계가 평균·임의 백분위를 읽게」와 한 묶음).
- 비교 인쇄의 최소·표준편차(비교 화면·CSV/XLSX에는 있다).
- 워커가 응답 시간 합계를 보내 평균을 정확히(③ §10).

### 1.3 하면 안 되는 것

- 60초 칸 값을 표시 없이 보여 주는 것(그래프 점·표 칸·CSV 모두 — working-rules §9).
- 같은 값이 화면·인쇄·CSV/XLSX·비교에서 다른 숫자로 나오는 것(표시 자릿수 차이는 괜찮다 — 출처 µs 값이 같아야 한다).
- 비교 화면과 비교 CSV/XLSX의 변화율이 다른 것(골든 패리티).
- 많은 데이터를 기본으로 펼치는 것(「스텝별로 보기」·비교 스텝 통계 행은 접힌 채 시작 — 사용자 선호).
- 실행 중 화면·라이브 진행 차트를 바꾸는 것.

## 2. 요구사항

### ④a 응답 시간 그래프

| ID | 요구사항 | acceptance | seam? |
|---|---|---|---|
| R-A1 | MUST `ReportWindow`에 `n: u64`(보여 주는 표본의 표본 수 = 풀린 분포 `len()`, 분포가 비거나 깨지면 0)와 `mean_us: Option<u64>`(`n > 0`일 때 `latency_stats`와 같은 평균 — 반올림, 60초로 자름), `capped: bool`(그 창 분포에 60초 칸 값이 있음 = `is_capped(h)` — 그때 `mean_us`는 실제 평균의 하한. `false`면 직렬화에서 빠진다 `skip_serializing_if = "std::ops::Not::not"`)를 더한다. `mean_us`는 `None`이면 직렬화에서 빠진다(`skip_serializing_if`), `n`은 늘 싣는다. 둘 다 `#[serde(default)]`(옛 JSON·골든 fixture 역직렬화). 평균 계산은 `latency_stats.rs`의 함수 하나를 `latency_stats`와 함께 쓴다(단일 소스). `ui/src/components/report/CLAUDE.md` bySecond 노트에 「백분위는 화면에서 합칠 수 없어 초별 합계(R-A2)는 서버가 만든다」 예외를 적는다. `n`이 Zod에서 필수라 창 리터럴을 가진 UI 테스트 fixture가 모두 바뀐다 — 지금 `grep -rlE "ts_second" ui/src | xargs grep -l "p99_ms" | grep -c __tests__` = 16개 파일 + 타입 fixture(`print/compare/__tests__/fixtures.ts` 등) — **스키마와 같은 커밋에서** 고친다(`.default(0)` 금지 — ui/CLAUDE.md Zod default 누출). Rust 구조체 리터럴(`rwin` 등)도 같은 커밋. | 단위 테스트: 창 하나에 표본 3개(µs 1000·2000·3000) → `n=3`·`mean_us=2000`(HDR `mean()` = 2000.3333…, 3000은 칸 중간값 3001로 센다 — §11 스크래치); 통과 표본이 빈 창 → `n=0`·`mean_us` 없음·JSON에 키 없음; 60초 칸 표본만 → `mean_us=60_000_000`·`capped: true`; 60초 칸 값이 없는 창 → JSON에 `capped` 키 없음(null도 아님). 표본 전환(`?sample=all`)에서 `n`이 모든 요청 수. UI: `capped: true` 창·초를 가진 리포트 JSON이 `ReportSchema`를 통과. | ✅ `ReportWindow` ↔ Zod `ReportWindowSchema`(`.strict()` — 같은 task에서 스키마) |
| R-A2 | MUST `ReportJson.latency_by_second: Vec<SecondLatency { ts_second, n, mean_us: Option<u64>, p95_us: Option<u64>, capped: bool }>`(`capped` = 합친 분포에 60초 칸 값이 있음, R-A1과 같은 직렬화 규칙) — 초마다 그 초의 **모든 스텝 창**의 보여 주는 표본 분포를 합친 값. `mean_us`는 R-A1과 같은 함수, `p95_us`는 `value_at_milli(h, 95_000)`(정수 순위·60초로 자름 — `stats.p95_us`와 같은 계산). 창과 같이 유지 구간 범위와 상관없이 모든 초. 창이 있는 초만, ts 오름차순. 빈 Vec이면 직렬화에서 빠진다. 계산은 보여 주는 창을 만드는 기존 `window_acc.into_iter()` 한 번의 훑기 안에서(BTreeMap이 (ts, step) 순이라 같은 초 창이 이어 나온다) **창에서 이미 푼 분포를 다시 쓰며**, 같은 초 동안 임시 분포 하나(`new_with_bounds(1, 60_000_000, 3)` — `merge_into`의 `.expect`가 같은 범위를 요구한다)에 합치고 초가 바뀔 때 `SecondLatency`를 내고 비운다. 창 분포를 두 번 풀지 않는다(통과 표본 풀기는 복사·빼기 — working-rules §10). 깨진 창(`Broken`)·빈 창은 합치지 않는다(초 전체를 한 번에 풀 때보다 너그럽다 — 깨진 행은 분포에서만 빠지는 지금 규칙과 같은 결). | 단위 테스트: 한 초에 스텝 A(1,000µs × 99건)·B(100,000µs × 1건) → `n=100`·`p95_us=1000`·`mean_us=1990`(지금 「가장 큰 p95」 방식이면 창 p95가 A 1ms·B 100ms라 100ms — §11 스크래치 출력 `RA2 len=100 mean=1990 p95=1000 p95A_ms=1 p95B_ms=100`). 표본 전환 시 그 표본으로. 창 없는 초는 항목 없음. 60,000,000µs × 2 + 1,000µs × 2인 초 → `mean_us=30_007_796`·`p95_us=60_000_000`·`capped: true`, 60초 칸 값이 없는 초 → `capped` 키 없음. 스텝 하나짜리 run에서 `p95_us`가 같은 창 분포의 `value_at_milli(95_000)`와 같다. | ✅ 새 칸 ↔ Zod `.optional()` + 소비처 `?? []` |
| R-A3 | MUST `bySecond`가 `latency_by_second`로 초별 `p95_ms`·`mean_ms`(µs/1000 소수, 없으면 `null`)를 낸다 — 「가장 큰 p95」 근사 제거. 초당 요청·에러는 지금처럼 창 합. 비교 겹쳐 보기의 p95도 이 값을 쓰게 된다. | 단위 테스트: R-A2 예와 같은 리포트 JSON → 그 초 `p95_ms === 1`·`mean_ms === 1.99`(µs ÷ 1000 그대로). `latency_by_second`가 없는 리포트 → 응답 시간 칸 모두 `null`(초당 요청·에러는 그대로). | |
| R-A4 | MUST 리포트 「p95 응답 시간」 그래프 자리를 「응답 시간 (ms)」 그래프로 — **새 컴포넌트**(`TimeSeriesChart`는 실행 중 화면도 쓰므로 고치지 않는다), 제목은 새 `ko` 키(`ko.report.timeSeriesP95`는 비교 겹쳐 보기 체크박스 이름이라 그대로 둔다). 평균(실선)·p95(점선) 두 선 + 범례, 유지 구간 띠·선(`marks`)·표본 표지(`sampleTag`) 지금처럼. 60초 칸 점은 60,000에 그리고 툴팁 「≥ 60,000 ms」, 1ms 미만은 툴팁 µs(`formatLatency`). 그 초가 `capped`이면 평균 툴팁 앞에 「≥ 」(실제 평균의 하한)를 붙이고, `capped`인 초가 하나라도 있으면 안내 줄에 「60초를 넘긴 응답이 있는 초의 평균은 실제보다 작게 나온 값입니다(툴팁에 「≥」).」를 덧붙인다. 그래프 아래 안내 한 줄 「모든 스텝의 요청을 초마다 합쳐 낸 값입니다」. 초당 요청 수·초당 에러 그래프는 그대로. | RTL: 제목·범례 두 항목·안내 글. 선 두 개(`path.recharts-line-curve` 2개 — 명시 크기). 툴팁 글자 함수: `capped`인 초의 평균은 「≥ 」로 시작, 아니면 없음. `capped`인 초가 있을 때만 덧붙는 안내 문장(두 경우). 라이브: 스크린샷. | |
| R-A5 | MUST 그래프 아래 「스텝별로 보기」 펼침 단추(기본 접힘, `aria-expanded`). 펼치면 스텝마다 작은 그래프 — 순서는 `report.steps`(스텝 표와 같음), 카드 = 스텝 이름(말줄임 + `title`) · 「평균 N ms」(그 스텝 `stats.mean_us`, 1ms 미만 µs, 60초 칸 「≥ 60,000」, 없으면 「응답 시간 없음」) · 평균선. **모든 카드가 같은 세로 눈금**(0 ~ 모든 스텝 초별 평균 최댓값을 올린 값)과 같은 가로 시간축(리포트의 첫 초 기준). 유지 구간 띠를 지금 그래프와 같은 색으로. 격자는 넓이에 따라 3·2·1열. 작은 그래프는 Recharts가 아닌 가벼운 SVG(스텝 수 × 초 수만큼 점이 많아서). 위에 「모든 그래프가 같은 세로 눈금(0–N ms)」 안내, `capped`인 창이 하나라도 있으면 그 아래 「60초를 넘긴 응답이 있는 초의 평균은 실제보다 작게 나온 값입니다.」. | RTL: 기본 접힘(카드 없음) → 누르면 스텝 수만큼 카드·이름·평균 글. `capped` 창이 있을 때만 안내 줄(두 경우). 눈금 함수 단위 테스트(최댓값·모두 빈 경우). 라이브: 스텝 50개·이름 300자에서 카드 글자 넘침 없음(rect 실측)·1440/768/390. | |
| R-A6 | MUST (ㄱ) 확장 자리: 스텝별 계열은 `stepLatencySeries(report) → { stepId, name, points: {x, meanMs|null}[] }[]` + 공통 눈금 하나로 만들고, 보기는 `StepLatencyView = "grid"` 타입과 보기별 그리기 표(`{ grid: StepLatencyGrid }`)로 고른다. 보기 고르는 단추는 **보기가 둘 이상일 때만** 그린다(이번엔 그리지 않음). 새 보기(「한 그래프」)는 같은 계열을 받아 그리는 컴포넌트 하나 + 표 항목 하나 + `ko` 이름 하나로 더해진다. | 코드 리뷰(구조). RTL: 보기 단추가 없다. | |
| R-A7 | MUST 비교 겹쳐 보기 체크박스에 「평균 응답 시간 (ms)」(`MetricKey`에 `"mean"`) — 기본은 꺼짐(지금 기본 `rps`·`p95` 그대로). 값은 R-A3의 `mean_ms`. | 단위: `overlaySeries(…, "mean")`이 run마다 초별 평균. RTL: 체크박스·라벨. | |
| R-A8 | MUST 인쇄 「시간에 따른 변화」 절의 지금 그래프(`chart`) 아래에 새 블록 「응답 시간」 그래프(`atomic`, 같은 180mm 폭·같은 칸 나누기 `pickBinSeconds`·같은 가로 눈금·유지 구간 표시선) — 평균 실선·p95 점선(흑백 구분). 칸 평균 = 칸 안 초들의 `Σ n·mean_us / Σ n`(정확), 칸 p95 = 칸 안 초들 `p95_us` 중 **가장 큰 값**(여러 초의 p95는 합칠 수 없다). 칸이 1초면 범례 「p95」, 1초보다 크면 「p95 (구간 안에서 가장 느린 초)」. 60초 칸 점은 60,000에 붙이고, 칸에 든 초 중 `capped`가 하나라도 있으면 캡션에 한 줄(「60초를 넘긴 응답이 있어 그 구간의 값은 실제보다 작게 그려졌습니다.」). 응답 시간이 하나도 없는 run이면 블록을 만들지 않는다. | 단위: 칸 모델 — 2초 칸에 (n=1, mean 10ms, p95 10ms)·(n=3, mean 20ms, p95 30ms) → 평균 17.5ms·p95 30ms. 범례 글 두 경우. `capped` 초가 든 칸이 있을 때만 캡션 줄(두 경우). RTL: 블록 렌더·선 둘. | |
| R-A9 | MUST 인쇄 표준판 맨 뒤(기존 「그 밖의 기준 전체」 부록 바로 뒤, 서명란 앞)에 「부록. 단계별 평균 응답 시간」 — 단계마다 작은 그래프, 2열, 순서·이름·번호는 「2. 단계별 결과」 표와 같음(`buildStepTable` 순서). 같은 세로 눈금·같은 가로 시간축·같은 칸(R-A8과 같은 `binSeconds`), 칸 평균은 그 단계 창의 `Σ n·mean_us / Σ n`. 캡션에 「같은 세로 눈금(0–N ms)」, `capped`인 창이 하나라도 있으면 R-A8과 같은 한 줄. 응답 시간이 없는 단계는 카드에 「응답 시간 없음」. 기존 부록을 가리키는 판정 글 「— 부록 참조」(`ko.print.criteria.restMixed`)는 부록 번호가 붙으면 「— 부록 1 참조」. 쪽 나누기: `table` 블록, 행 = 카드 한 쌍(행 사이에서만 나뉜다). 부록이 둘이면 「부록 1. 그 밖의 기준 전체」·「부록 2. 단계별 평균 응답 시간」, 하나면 번호 없이 「부록.」. 모든 단계에 응답 시간이 없으면 부록을 만들지 않는다. | 단위: 부록 이름 두 경우, 판정 글 「— 부록 1 참조」/「— 부록 참조」 두 경우(그 글은 `verdict.ts` `limitOtherRows`가 만들고 `OtherCriteriaTable.tsx` `OtherCriteria` — 인쇄 `other:standard` 블록 — 가 그린다: `limitOtherRows`가 부록 이름 인자를 받고 `OtherCriteria`가 그것을 넘긴다. `buildPrintDoc.ts` `standardBlocks`의 다른 호출은 `truncated`만 읽어 글자와 무관. 화면에 「— 부록 1 참조」가 보이는지는 문서 렌더 테스트로), `capped` 창이 있을 때만 캡션 줄, 행 수 = ceil(단계/2), 눈금. 라이브: 단계 50개 run 인쇄 미리보기에서 쪽 넘김·카드 잘림 없음. | |

### ④b 통계 칸

| ID | 요구사항 | acceptance | seam? |
|---|---|---|---|
| R-B1 | MUST `latency_stats`의 `min_us`가 60초 칸 값이면 `CAP_US`(60,000,000) — `is_cap_value(h, h.min())`. | 단위: 60,000,000µs만 기록 → `min_us == 60_000_000`(되돌려 확인: 고치기 전 `59_998_208`로 RED). 59,000,000µs만 → `min_us == 58_982_400`(그 칸 아래쪽 끝 그대로 — §11 스크래치 `59s min=58982400`). 화면: 해당 스텝 최소 「≥ 60,000」(라이브 또는 RTL fixture). | |
| R-B2 | MUST 시간 ms 글자 함수 하나(서버 `export.rs`): µs 정수 → `"{정수}.{3자리}"`(부동소수 거치지 않음 — `52118` → `52.118`, `350` → `0.350`). 60초 칸은 `latency_stats`가 이미 자른 60,000,000 → `60000.000`. | 표 테스트(0·1·350·999·1000·52118·60_000_000). | |
| R-B3 | MUST 단일 run CSV 머리 `step_id,count,error_count,min_ms,mean_ms,p50_ms,p90_ms,p95_ms,p99_ms,max_ms,stdev_ms,capped` — 시간 값은 그 스텝 `stats`에서 R-B2로(p50·p95·p99도 `stats`의 µs 값 — 정수 칸을 버린다), `capped`는 `true`/`false`. 마지막 줄 `step_id = *` = 모든 스텝(`summary.stats`, count·error_count는 요약 합). 통과한 요청이 없거나(`latency_missing`) `stats`가 없으면 시간 칸·`capped` 빈 칸. 준비 스텝 CSV 블록은 열을 늘리지 않되(준비 스텝 통계는 ③ §10 연기) 정수 ms 칸(`p50_ms`·`p95_ms`·`max_ms`)이 60,000 이상이면 `60000`으로 쓰고 머리 끝에 `capped` 열(그 행에 60,000 이상 값이 하나라도 있으면 `true`)을 더한다 — 「정수 ms ≥ 60,000 ⇔ 60초 칸」(§1.1). | 테스트: 머리 글자 그대로, 1ms 미만·60초 칸·빈 칸 행, `*` 줄, 준비 스텝 60030 → `60000`·`true`. | |
| R-B4 | MUST 단일 run XLSX: Steps 시트 = R-B3과 같은 열·같은 `*` 행(시간 칸은 숫자 셀 = µs ÷ 1000 — XLSX는 숫자로, 글자 3자리는 CSV만; `capped`는 불리언 셀 `write_boolean`). Summary 시트: 시간 행을 `p50_ms·p90_ms·p95_ms·p99_ms·mean_ms·min_ms·max_ms·stdev_ms·capped`(값 `summary.stats`) 순서로 — `count·errors·rps·duration_seconds` 뒤. **행 번호를 박지 않는다**: `write_summary_numbers`가 다음 빈 행 번호를 돌려주고 유효성·`basis_*`·`latency_sample` 행이 그 뒤에 이어 쓴다(지금 「H2: rows 7–8」 고정 제거). Other basis 시트는 같은 도우미를 쓰므로 **같이 바뀐다**(같은 열·같은 행 — 시트끼리 모양이 같아야 한다). Windows 시트: `p99_ms` 뒤에 `mean_ms`(R-A1 `mean_us` ÷ 1000, 없으면 빈 셀)와 `capped`(그 창 `p50/p95/p99_ms` 중 60,000 이상이 있으면 `true`, 그 값들은 `60000`으로) 열. Setup 시트: R-B3 준비 스텝과 같은 60,000 처리 + `capped` 열. 나머지 시트(Status·Branches·Insights·Stairs) 그대로. | 시트 셀 읽기 테스트(기존 XLSX 테스트 방식): Summary 행 이름 순서·유효성 행이 그 뒤로 밀림·Other basis 같은 모양·Windows 60030 → 60000 + `true`. | |
| R-B5 | MUST 비교 지표 목록 하나(TS `SUMMARY_METRICS`·Rust `SUMMARY_METRICS` 같은 순서): `p50_ms·p90_ms·p95_ms·p99_ms·mean_ms·min_ms·max_ms·stdev_ms·rps·error_rate`(백분위끼리 모은다 — 목업 비교 표의 행 순서는 이 순서로 대체, 내 판단). 시간 값 = `stats`의 µs ÷ 1000(소수), **`stats`가 없으면 값 없음**(지금 「통과한 요청 없음」 칸과 같은 빈 칸). 시간 지표는 모두 「낮을수록 좋음」(`delta`·`LOWER_IS_BETTER`에 새 이름). **60초 칸 변화율 규칙**(잘린 값은 실제 값의 하한 — 자르기는 1-Lipschitz 단조 변환이라 평균·표준편차도 줄이기만 한다): 지표가 「잘림」인 조건 = 평균·표준편차는 `stats.capped`, 나머지 시간 지표는 그 값 ≥ 60,000ms. 한쪽만 잘림 → `pct: null` + 방향은 잘린 쪽 보이는 값 ≥ 다른 쪽 값일 때만 확정(잘린 쪽이 나쁨 — 기준 쪽이 잘렸으면 `good`, 비교 쪽이 잘렸으면 `bad`), 아니면 `neutral`; 둘 다 잘림 → `pct: null`·`neutral`. 모든 경우 `Delta.capped = true`(새 칸 — 「기준이 0」인 `pct: null`과 구별). TS `Delta`·Rust `Delta` 둘 다. 값 없음 판정은 `stats` 없음 **또는** 지금 `latency_missing`(통과한 요청 없음) 둘 다 본다. 골든: fixture의 리포트에 `stats` 블록을 넣되 기존 `p50/p95/p99_ms`·`mean_ms`와 같은 값(µs = ms × 1000)으로 넣어 기존 기대값(`pct`·`values`)이 그대로 맞게 하고 — **단 `missing_cases`에서 통과한 요청이 없는 쪽 리포트(`count == errors`)에는 `stats`를 넣지 않는다**(실제 서버도 빈 분포에 `latency_stats`가 `None` — 기대값 `null` 그대로), 새 지표 행·60초 칸 세 경우(한쪽 잘림 방향 확정·한쪽 잘림 방향 모름·둘 다)·`stats` 없음 한 경우를 손계산 기대값으로 더한다. 스텝 통계 변화율(R-B6·R-B7)도 골든 `expected.step_deltas`로 두 쪽이 대조한다. | 골든 Rust·TS 둘 다 통과. 되돌려 확인: TS 쪽 새 지표 하나를 목록에서 빼면 TS 골든 RED, Rust 쪽 잘림 규칙을 빼면 Rust 골든 RED. | ✅ 골든 패리티 |
| R-B6 | MUST 비교 CSV: R-B5 요약 지표 행(값 R-B2 글자) 뒤에 스텝 통계 행 — `metric` 칸 = `step:{step_id}:{지표}`, 지표 = `p95_ms·mean_ms·min_ms·max_ms·stdev_ms·p90_ms`(화면 스텝 행 순서와 같게), 스텝 순서는 지금 비교 스텝 행 순서(`step_id` 정렬). `delta_pct` 칸: 숫자(지금처럼 `{:.6}`), 기준 0이면 빈 칸(지금), **잘림이면 `capped`**. 비교 XLSX: Summary 시트 = 같은 요약 행, Steps 시트의 스텝별 p95를 `stats.p95_us` ÷ 1000으로(지금 정수 `p95_ms` — 같은 스텝이 60030과 60000.000으로 갈리지 않게), 새 시트 「Step stats」(긴 형식: `step_id, metric, 각 run 값, Δ% 각 비교 run` — CSV 스텝 행과 같은 지표·순서). Δ 셀 글자(`delta_cell_text`)는 잘림이면 방향 글리프 + 「—」(`▲ —`·`▼ —`·`—`). | 테스트: 머리·행·`capped` 칸·Δ 글자 세 경우. | |
| R-B7 | MUST 비교 화면 표: 요약 절 행 = R-B5 목록(시간 지표 이름은 `ko` — 「평균」·「최소」·「최대」·「표준편차」·「p90」 등). 시간 칸 글자는 리포트 화면 규칙의 단일 소스(§1.1 「화면 ms 글자 규칙」 — 최소·최대·백분위 내림, 평균·표준편차 반올림, 1ms 미만 µs, 60초 칸 「≥ 60,000」)를 `format.ts`의 공용 함수 하나로 꺼내 `StepStatsTable`과 함께 쓴다. 스텝 절의 p95 행도 `stats.p95_us`로(R-B6과 같은 출처). 변화율 칩: 잘림이면 「—」 + 방향 색(`bad`/`good`/중립) + `title`「60초를 넘긴 응답이 있어 변화율을 계산할 수 없습니다」. 스텝 절 머리에 「응답 시간 통계 더 보기」(기본 접힘, `aria-expanded`) — 펼치면 스텝마다 p95 행 밑에 `└ 평균·최소·최대·표준편차·p90` 행. 통과한 요청이 없는 칸은 지금 규칙(빈 칸 표시). | RTL: 기본 접힘(└ 행 없음)·펼치면 스텝 × 5행·60초 칸 글자·µs 글자·잘림 칩 글자와 `title`. 공용 글자 함수 표 테스트(내림/반올림 경계 1499µs → 「1」·평균 1500µs → 「2」). | |
| R-B8 | MUST 인쇄 표준판 새 절 「단계별 응답 시간 통계」 — 「2. 단계별 결과」 바로 뒤(뒤 절 번호가 하나씩 밀린다). `table` 블록. 열 = 단계 · 최소 · 평균 · p50 · p90 · p95 · p99 · 최대 · 표준편차, 마지막 행 「모든 단계」(`summary.stats`). 행 순서·이름 = 단계별 결과 표. 칸 글자: R-B7의 공용 함수와 같은 숫자(내림/반올림 규칙)에 인쇄 모양만 다르게 — 1ms 이상 정수 ms 천 단위 쉼표, 1ms 미만 「350µs」(인쇄는 붙여 씀 — 목업), 60초 칸 「≥ 60,000」(이 표는 단위가 ms라 「60초 이상」이 아니라 ms 글자 — R-B9의 초 단위 칸과 의도적으로 다르다), 통과한 요청이 없거나 `stats`가 없으면 「–」. 캡션 「{표본} 기준 · 단위 ms (1ms 미만은 µs)」(표본 이름은 지금 인쇄 `sampleNote` 규칙), 60초 칸이 하나라도 있으면 표 아래 안내 「「≥ 60,000」 = 60초를 넘긴 응답이 있어 실제 값은 더 큽니다(그 단계의 평균·표준편차도 실제보다 작게 나온 값입니다).」. **응답 시간이 하나도 없는 run**(모든 단계와 `summary.stats`가 없음)이면 절을 만들지 않는다(R-A8 그래프와 같은 규칙). 근거: US7 + ③ §10 「인쇄 본문은 ④」. | 단위: 칸 글자 표 테스트·절 번호(계단·준비·속도 구간 유무 조합 — 있음/없음 네 경우)·응답 시간 없는 run에서 절 없음. RTL: 머리·모든 단계 행·안내 글 유무. | |
| R-B9 | MUST 인쇄(단일·비교)의 초·ms 글자 함수 `fmtMs`가 정수 ms ≥ 60,000이면 「60초 이상」(평균 값은 그 밖에 분포가 60초 칸에 걸리면 「 이상」 — R-B11) — §1.1의 「정수 ms ≥ 60,000 ⇔ 60초 칸」이라 이 한 곳에서 모든 정수 칸(단계별 결과 「95% 응답」·핵심 지표 카드·준비 스텝 표·비교 핵심 지표·덤벨 값 글)이 함께 고쳐진다. 인쇄 글자 「응답시간」을 모두 「응답 시간」으로. 근거: ③ §10 「인쇄·내보내기 정수 칸의 60초 칸 값(60030) → ④」·「「응답시간」(인쇄) 띄어쓰기 → ④」, US7. | 단위: `fmt` 60초 칸 경우. `ko.print` 블록(인쇄·비교 인쇄 문구) 안 「응답시간」 0건 — 지금 `grep -n "응답시간" ui/src/i18n/ko.ts` 21줄 중 인쇄 밖(SLO 도움말 80행·슬롯 도우미 2109–2125행)은 화면 문구라 이번 범위 밖(그대로 둔다). | |
| R-B10 | MUST 인쇄 스텝 상태(`stepStatus.ts`)의 「느림」을 넓힌다. ① **스텝 기준**(`step_criteria`, `target` = 그 스텝)의 응답 시간 행(`mean_ms`·`max_ms`·`p<N>_ms` — 아무 백분위)은 **서버 판정 행**(`report.verdict.criteria`에서 `target === stepId`이고 응답 시간 지표, `direction === "max"`)의 `passed === false`(`no_sample`은 제외 — 지금 「느림」은 값이 있을 때만)로 정한다 — 서버가 이미 µs·60초 칸 규칙으로 비교했다. 판정은 끝난(`completed`) run에만 있다(`report.rs` `(RunStatus::Completed, Some(c)) if c.has_any()`) — **`report.verdict`가 없으면**(중단·실패 run — 지금 `stepStatus`는 상태와 상관없이 p95를 본다) 스텝 기준도 ②와 같은 식으로 `stats`와 견주고, `stats`에 없는 백분위 기준은 건너뛴다(§10). 호출하는 곳 둘(`buildPrintDoc.ts`의 단계별 결과, `print/compare/runModel.ts`의 비교 인쇄)이 판정 행을 넘기도록 함께 바꾼다. ② **run 기준을 스텝에 빌려 쓰는 것**(지금 `max_p95_ms`를 스텝마다 견주는 것과 같은 결): `max_p50_ms`·`max_p95_ms`·`max_p99_ms`·`max_mean_ms`·`max_max_ms`와 `max_percentiles_ms` 중 백분위가 50·90·95·99인 것만 그 스텝 `stats`와 서버와 같은 식으로 견준다 — `t_us = round(threshold × 1000)`, 느림 = `잘림 || us > t_us`(잘림 = 평균은 `stats.capped`, 나머지는 값 ≥ `CAP_US`). 그 밖의 백분위(예 p75)는 `stats`에 없어 스텝에 빌려 쓰지 않는다(§10). 같은 스텝에 스텝 기준이 있으면 그 지표는 스텝 기준만 본다(지금 `pick`과 같은 우선순위). `stats`가 없으면 ②는 건너뛴다. 근거: ③ §10 「인쇄 `stepStatus.ts`… p95만 → ④」, US7. | 표 테스트: 스텝 평균 기준 판정 행 실패 → 느림 · 스텝 p75 기준 판정 행 실패 → 느림 · run `max_mean_ms` 3000에 스텝 `mean_us` 3,000,400 → 느림, 3,000,400이 아니라 3,000,000이면 아님(`t_us` 3,000,000 경계) · run p90 기준에 `stats.p90_us` 60,000,000 → 느림 · 중단 run(판정 없음)에 스텝 `mean_ms` 기준 100, `mean_us` 100,001 → 느림 · 중단 run에 스텝 `p75_ms` 기준만 → 느림 아님(건너뜀) · 기준 없음 → 지금과 같음. | |
| R-B11 | MUST 비교 인쇄 핵심 지표 표(`change.ts` `SPECS`)에 「90% 응답 시간」·「최대 응답 시간」 — 순서 오류율·p99·p95·**p90**·평균·**최대**·처리량·요청 수(목업). `Spec.value`를 `number \| null`로 넓혀 `stats`가 없으면 `null` → 그 행은 지금 「응답 시간 없음」 칸과 같은 `cls: "none"`. 값 = `stats` µs ÷ 1000, 글자 `fmtMs`(R-B9 — 60,000 이상 「60초 이상」). 변화 분류는 R-B5의 잘림 규칙을 그대로(방향 확정이면 나빠짐/좋아짐, 아니면 「비교 불가」 = `cls: "none"`). 두 행은 `major: false`(머리 문장 건수 `headline.ts`를 바꾸지 않는다 — 최대는 튀는 값이라), **표준판에만**(한 쪽 요약판의 `cmp:kpi` 블록에는 넣지 않는다 — 요약판 한 쪽 맞춤 불변, `Spec`에 `standardOnly` 표지). 지금 표준판과 요약판 0단계가 같은 측정 블록 `cmp:kpi:bars`를 쓰므로(`buildCompareDoc.ts` 표준·요약 두 곳) 표준판 핵심 지표 표는 **새 블록 id `cmp:kpi:bars:std`**로 따로 재고 그린다 — 요약판 블록의 내용·높이 불변. 평균 행은 `summary.stats.capped`이면 값 글에 「 이상」(R-B12·R-B8 안내와 같은 뜻 — 단일 run 인쇄 핵심 지표 카드의 평균도 같게). 근거: US9. | 단위: 행 순서(표준판·요약판 각각)·`stats` 없음·잘림 세 경우·`major` 집계 불변·`summary.stats.capped`인 평균 30,000ms → 비교 핵심 지표 평균 행 글 「30.0초 이상」(`fmtMs(30000)` = 「30.0초」 — `ui/src/print/format.ts` `fmtMs` 1,000ms 이상은 소수 1자리 초), 단일 run 인쇄 핵심 지표 평균 카드도 「30.0초 이상」(각 1건). | |
| R-B12 | MUST 비교 인쇄 새 절 「단계별 평균 응답 시간 변화」 — 지금 95% 덤벨 절 바로 뒤, 같은 그림 모델을 지표 인자(`"p95" \| "mean"`)로 일반화해 그린다(같은 「비슷」 5% 기준·같은 모양). 평균 = 그 단계 `stats.mean_us` ÷ 1000(`stats` 없으면 그 단계 점 없음 — 지금 p95 덤벨의 「응답 시간 없음」과 같은 모양). 기준선: 지금 p95 덤벨이 스텝 `p95_ms` 기준 → run `max_p95_ms`를 그리듯, 평균 덤벨은 스텝 `mean_ms` 기준 → run `max_mean_ms`(둘 다 없으면 기준선 없음). 잘린 평균(`stats.capped`)은 보이는 값 자리에 그리고 값 글에 「 이상」을 붙인다(그 값은 하한). 「비슷」 판정·화살표 방향은 R-B5 잘림 규칙(방향을 모르면 화살표 없이 점 둘). 단계가 있을 때만(지금 덤벨과 같은 조건), 표준판에만. 절 번호는 `sectionNo`에 새 키 `meanDumbbell`(덤벨 다음). 근거: US9. | 단위: 평균 덤벨 행 값·모양·기준선 출처 두 경우·잘림 글, 절 번호(단계 있음/없음). RTL: 절 제목. | |

### ④c 비교 인쇄의 시간 흐름 (outline — plan은 ④b 뒤에 따로)

| ID | 요구사항 | acceptance |
|---|---|---|
| R-C1 | MUST 비교 인쇄 시간 흐름 절(`overlay.ts`)에 이전·이후 run의 칸별 평균 응답 시간 선(R-A8과 같은 칸 평균 계산을 공유). | 단위: 칸 평균. 라이브: 비교 인쇄 미리보기. |

## 3. 설계 근거

### 접근 비교 (사용자 선택: (Y))

- **(X) 층으로**: ④a 서버·와이어·내보내기 / ④b 화면 전부 — 비교 골든 짝(서버 비교 CSV ↔ 클라 비교 표)이 두 슬라이스에 갈라지고 ④a만으로는 사용자가 볼 것이 없어 라이브 검증 거리가 적다. 기각.
- **(Y) 기능으로**: ④a 그래프(서버 초별 칸 + 화면·인쇄·비교 겹쳐 보기) / ④b 통계 칸(내보내기·인쇄 표·비교 표·비교 인쇄) / ④c 비교 인쇄 시간 흐름 — 슬라이스마다 서버에서 화면까지 이어지고 비교 짝이 ④b 하나에 모인다. 와이어 변경은 ④a에만(④b는 ③a가 이미 싣는 `stats`를 쓴다). **채택.**

### 초별 p95를 서버가 내는 이유

백분위는 창별 백분위에서 합칠 수 없다(가장 큰 값은 위로 기운 근사, 지금 방식). 평균은 `n`·`mean_us`가 있으면 화면에서 정확히 합칠 수 있지만, p95와 같은 곳에서 같은 표본 규칙으로 내야 어긋나지 않으므로 둘 다 서버가 낸다. 스텝별 평균선은 창(`mean_us`)만으로 그린다.

### 인쇄 칸 p95 = 칸 안 가장 큰 초별 p95

인쇄는 120칸 이하로 묶으므로 칸 하나가 여러 초다. 서버에 칸 크기를 넘겨 다시 합치게 하려면 리포트 API에 인자가 생기고(인쇄·화면이 같은 리포트를 쓴다) 칸마다 분포를 다시 쌓아야 한다. 칸 안 가장 느린 초를 그리는 것은 보수적이고(나빠 보이는 쪽), 범례에 뜻을 적어 숨기지 않는다. 화면은 1초 단위라 정확하다.

### 작은 그래프를 가벼운 SVG로

스텝 50개 × 3,600초면 점 18만 개 — Recharts 50개는 펼칠 때 무겁다. 작은 그래프는 툴팁 없이 선만 보면 되는 용도다. 인쇄 부록도 SVG라 칸 계산(눈금·좌표)을 같은 순수 함수로 나눈다.

## 4. 와이어 (④a만)

```jsonc
// ReportWindow — 세 칸 추가(n·mean_us·capped)
{ "ts_second": 1764000000, "step_id": "01J…", "count": 120, "error_count": 2,
  "status_counts": {"200": 118, "500": 2}, "p50_ms": 41, "p95_ms": 120, "p99_ms": 310,
  "n": 118, "mean_us": 52118 }            // n = 보여 주는 표본 수, mean_us 없으면 키 없음, capped는 참일 때만
{ "ts_second": 1764000002, "step_id": "01J…", "count": 4, "error_count": 0,
  "status_counts": {"200": 4}, "p50_ms": 1, "p95_ms": 60030, "p99_ms": 60030,
  "n": 4, "mean_us": 30007796, "capped": true }

// ReportJson — 새 칸(빈 배열이면 키 없음)
"latency_by_second": [
  { "ts_second": 1764000000, "n": 590, "mean_us": 51002, "p95_us": 119807 },
  { "ts_second": 1764000001, "n": 0 },    // 표본 없는 초: mean_us·p95_us 없음
  { "ts_second": 1764000002, "n": 4, "mean_us": 30007796, "p95_us": 60000000, "capped": true }
  // ↑ 60,000,000µs 2건 + 1,000µs 2건: HDR 평균 = (2×60,014,592 + 2×1,000)/4 = 30,007,796(60초 칸 중간값 60,014,592 — §11 스크래치 `cap mean=60014592`)
]
```

Zod: `ReportWindowSchema`(`.strict()`)에 `n: z.number().int().nonnegative()`·`mean_us: z.number().int().nonnegative().optional()`·`capped: z.boolean().optional()`. `SecondLatencySchema = z.object({ ts_second: z.number().int(), n: z.number().int().nonnegative(), mean_us: z.number().int().nonnegative().optional(), p95_us: z.number().int().nonnegative().optional(), capped: z.boolean().optional() }).strict()`. `ReportSchema`에 `latency_by_second: z.array(SecondLatencySchema).optional()`, 소비처 `report.latency_by_second ?? []`. (`capped`는 참일 때만 나오므로 `capped`를 빠뜨린 `.strict()` 스키마는 60초 칸이 있는 리포트에서만 깨진다 — 픽스처에 `capped: true` 창·초를 넣어 확인한다.) 서버가 늘 `n`을 싣지만 옛 리포트 JSON fixture가 UI 테스트에 있으면 `n`을 `.default(0)`이 아니라 fixture를 고친다(ui/CLAUDE.md Zod default 누출).

④b는 와이어를 바꾸지 않는다(서버 변경은 `latency_stats` 값 하나와 내보내기 파일).

## 5. 서버 변경

- `latency_stats.rs`: 평균 함수 하나(`mean_us(h) -> Option<u64>`)를 꺼내 `latency_stats`·창·초별이 함께 쓴다(④a). `min_us` 60초 칸(④b R-B1).
- `report.rs` `build_report`: `window_of`가 `n`·`mean_us`를 채운다(점유 창도 같은 닫힘이라 같이 채워진다 — 쓰는 곳은 없다). 보여 주는 창을 만드는 `window_acc.into_iter()` 훑기에서 창마다 한 번 푼 분포로 창 칸을 채우고 같은 분포를 초별 임시 분포에 합친다(R-A2 — 창 분포를 두 번 풀지 않는다). 지금 `window_of`는 푼 분포를 밖으로 내주지 않으므로 「푼 분포를 받아 창을 만드는 함수」와 「풀기」를 나눈다(구조는 plan이 정한다). 테스트 도우미 `rwin`·`report_with_steps` 등 구조체 리터럴이 새 칸을 받는다.
- `export.rs`(④b): R-B2–R-B6. `latency_csv`(정수 ms 칸 함수)는 쓰는 곳이 없어지면 지운다.
- 건드리지 않는 것: 엔진·워커·proto·마이그레이션, 판정(`evaluate_criteria`), 속도 구간, 인사이트(`insights.rs`는 창 `p95_ms` 정수를 그대로 쓴다), 실행 중 상태 API.

## 6. 화면 변경 (목업이 시각 기준)

### 6.1 리포트 (④a) — `ReportView.tsx`·새 `LatencyTimeSeriesChart.tsx`(`TimeSeriesChart.tsx`는 실행 중 화면도 쓰므로 손대지 않는다)·새 `StepLatencySection.tsx`(펼침 + 보기 표)·`StepLatencyGrid.tsx`·`report/bySecond.ts`·새 `report/stepLatencySeries.ts`

색: 평균 `#2563eb`(지금 선 색) 실선, p95 `#9333ea` 점선(유지 구간 띠 노랑·회색과 겹치지 않게). 작은 그래프 카드의 이름 칸은 `truncate` + `title`(리포트 함정 노트의 고정폭 라벨 규칙). 격자 `grid-cols-1 sm:grid-cols-2 lg:grid-cols-3`(Tailwind 경계 640px·1024px — 목업의 760·480px 대신 저장소의 기존 경계를 쓴다). 라이브에서 폭 1440·1024·768·390마다 카드 rect 폭과 이름 칸 `scrollWidth > clientWidth`(말줄임 동작)·카드끼리 rect 무교차를 재서 표에 적는다.

### 6.2 비교 (④a 겹쳐 보기, ④b 표) — `overlaySeries.ts`·`CompareOverlaySection.tsx`·`compareReports.ts`·`CompareMatrix.tsx`

표 칸 글자에 단위·60초 칸이 들어오므로 시간 칸 `Cell`에 표시용 µs와 지표 종류(내림/반올림 — 평균·표준편차만 반올림)를 싣고 표가 R-B7 공용 글자 함수로 찍는다. 변화율은 ms 소수 값(µs ÷ 1000)으로 — Rust와 같은 수(골든). `Delta`에 `capped: boolean`(R-B5). `DeltaChip`·Rust `delta_cell_text`가 `capped`를 「신규」/「동일」보다 먼저 본다.

### 6.3 인쇄 (④a 그래프·부록, ④b 통계 표·글자) — `chartModel.ts`·새 `print/latencyChart.ts`(칸 모델 — ④c가 재사용)·새 `components/LatencyChart.tsx`·새 `components/StepLatencyAppendix.tsx`·`buildPrintDoc.ts`(블록·절 번호·`MEASURE_IDS`)·`PrintDocument.tsx`·새 `print/statsTable.ts` + 컴포넌트·`stepStatus.ts`·`format.ts`·`ko.ts`

인쇄 선 색은 검정(흑백) — 평균 0.7pt 실선, p95 0.5pt 점선. 작은 그래프 칸 한 장 = 폭 88mm(본문 180mm = 88 + 간격 4 + 88) × 그림 높이 26mm + 제목 줄(높이는 숨은 시트에서 잰 값). 부록 표 행 높이는 다른 표처럼 숨은 시트에서 잰다.

### 6.4 비교 인쇄 (④b) — `change.ts`·`dumbbell.ts`(지표 인자)·`buildCompareDoc.ts`(`STANDARD_SECTIONS`·`SectionNos`에 `meanDumbbell`)·`components/DumbbellTable.tsx`·`ko.ts`

### 6.5 문구 (모두 `ko.ts`, ADR-0035)

화면: 「응답 시간 (ms)」·「평균」·「p95」·「모든 스텝의 요청을 초마다 합쳐 낸 값입니다.」·「스텝별로 보기」·「모든 그래프가 같은 세로 눈금(0–{N} ms)이라 높이로 서로 비교할 수 있습니다. 순서는 스텝 표와 같습니다.」·「평균 {v}」·「응답 시간 없음」·「평균 응답 시간 (ms)」(겹쳐 보기)·비교 행 이름 「평균·최소·최대·표준편차·p90」·「응답 시간 통계 더 보기」. 인쇄: 「응답 시간」·「p95 (구간 안에서 가장 느린 초)」·「부록. 단계별 평균 응답 시간」·「단계별 응답 시간 통계」·「모든 단계」·「60초 이상」·「단계별 평균 응답 시간 변화」·「90% 응답 시간」·「최대 응답 시간」. 화면은 「스텝」, 인쇄는 지금처럼 「단계」.

## 7. 사용자에게 알릴 차이 (릴리즈 노트 — ④b 끝에서 한 번에)

- 리포트 「p95 응답 시간」 그래프가 「응답 시간」(평균·p95)으로 바뀌고, p95가 같은 초의 모든 요청을 합친 값이 되어 전보다 낮게 나올 수 있다(전에는 스텝들 중 가장 큰 값).
- CSV/XLSX 시간 칸이 정수 ms에서 ms 소수 3자리로, 열이 늘고 순서가 바뀐다(옛 파일과 열이 다르다).
- 인쇄 보고서에 「단계별 응답 시간 통계」 절이 생겨 뒤 절 번호가 하나씩 밀린다. 「응답시간」이 「응답 시간」으로.
- 비교 화면·비교 CSV/XLSX의 p50·p95·p99(스텝 p95 포함)가 µs 기준 소수로 계산된다(변화율이 조금 다를 수 있다). 60초를 넘긴 값이 낀 비교는 변화율 대신 「—」(방향을 알 수 있으면 색·▲▼로).
- XLSX Summary·Other basis 시트의 행이 늘어 유효성 행 위치가 아래로 밀린다. 60초 칸 정수 값(60030)은 내보내기에서 60000 + `capped`, 인쇄에서 「60초 이상」.

## 8. 테스트·검증

- **서버**: R-A1·R-A2·R-B1–R-B6 단위·골든. 되돌려 확인: R-A2(「가장 큰 p95」로 되돌리면 RED — 화면 쪽 R-A3), R-B1, R-B5(지표 하나 빼면 TS 골든 RED).
- **UI**: R-A3–R-A9·R-B7–R-B12 단위·RTL, `pnpm lint && pnpm test && pnpm build`.
- **라이브(필수 — 리포트 응답·인쇄·비교를 건드린다)**: 슬라이스마다 `/live-verify`. US 행 척추. 극단값: 스텝 50개·이름 300자·1ms 미만 run(릴리즈 워커, roadmap §B97 (2))·60초 칸 run(타임아웃 > 60초 + 지연 응답) · 폭 1440/768/390 · 인쇄 미리보기 쪽 넘김. 컴포넌트가 붙는 모든 진입 화면(리포트 화면·인쇄 표준판·비교 화면·비교 인쇄 — 요약판에는 없음을 확인).
- **성능**: R-A2는 리포트 만들기에 초마다 분포 합치기를 더한다 — 긴 run(예: 3,600초 × 스텝 10개) 리포트 생성 시간을 머지 전후로 한 번 재서 build-log에 적는다(결과 불변, 정확성 우선 — working-rules §10).

## 9. 슬라이스 경계 요약

| 슬라이스 | 요구사항 | 와이어 | 골든 |
|---|---|---|---|
| ④a | R-A1–R-A9 | `ReportWindow.n·mean_us`, `latency_by_second` | 손대지 않음(fixture 역직렬화만 — serde default) |
| ④b | R-B1–R-B12 | 없음 | 리포트에 `stats`(기존 기대값 불변, 통과한 요청 없는 쪽 제외) + 새 지표 행·잘림 세 경우·`stats` 없음·스텝 통계 변화율 — **첫 task 한 커밋에서 Rust·TS 함께** |
| ④c | R-C1 | 없음 | 없음 |

④b plan의 task 묶음 순서(검토 권고 채택): ① 골든·비교 지표·`Delta.capped`(Rust+TS 한 커밋) → ② 내보내기(R-B1–R-B4·R-B6) → ③ 비교 화면(R-B7) → ④ 인쇄(R-B8–R-B10) → ⑤ 비교 인쇄(R-B11·R-B12).

## 10. 연기 (roadmap §B에 옮길 것)

| 항목 | 왜 미루나 | 비용 | 해소 |
|---|---|---|---|
| 「스텝별로 보기」 (ㄱ) 한 그래프 선 겹치기 | 사용자: 나중에 | 두 스텝 선을 정확히 겹쳐 보기 어렵다 | R-A6 표에 보기 하나 추가 |
| 옛 run 전용 판정 규칙(`status_rule`·`latency_rule` 1) 걷어내기 | 사용자 결정 1(옛 run 지움)로 가능해졌으나 ④ 밖 | 갈래 코드·테스트 유지비 | 별도 정리 슬라이스 |
| 실행 중 진행 차트의 응답 시간 | 범위 밖 | 실행 중 그래프에는 응답 시간 선이 없다(초당 요청·에러만) | `liveSeries`에 평균·p95 |
| 인쇄 스텝 상태가 run 기준의 50·90·95·99 밖 백분위(예 p75)를 스텝에 빌려 쓰기 | `stats`에 그 백분위가 없다 | run에 p75 기준만 걸면 인쇄 「느림」이 그 기준을 모른다(판정 표에는 나온다) | 스텝별 임의 백분위를 서버가 싣기 |
| 비교 인쇄 요약판의 p90·최대 | 한 쪽 맞춤 | 요약판에는 p90·최대가 없다 | 요약판 사다리에 행 |
| 인쇄 속도 구간이 평균 기준을 보게 | 경계 자체가 평균을 모른다(③ §10) | 평균 기준만 건 run은 기본 경계 | `run_boundary`에 평균 |
| 비교 인쇄 최소·표준편차 | 입문자 판독 | 비교 화면·CSV에만 | `SPECS`에 행 |
| 창 `p50/p95/p99_ms`(정수)·인사이트의 µs화 | 그래프는 `latency_by_second`로 충분 | XLSX Windows 시트 p 칸은 정수(60초 칸은 R-B4가 60000 + `capped`) | 창에 µs 백분위 |
| 준비 스텝 통계 칸·µs | ③ §10 그대로 | 준비 스텝 CSV/XLSX는 정수 칸(60초 칸만 60000 + `capped`) | 준비 분포에 `latency_stats` |

## 11. 사실 확인 명령 (claims-ledger — 디스패치 전 다시 돌린다)

```bash
# 창 구조·누적·닫힘·점유 창
grep -n "pub struct ReportWindow" -A10 crates/controller/src/report.rs
grep -n "struct WindowAcc\|let window_of\|occupancy_windows\|let windows: Vec<ReportWindow>" crates/controller/src/report.rs
grep -n "그림용 창은 모든 행" crates/controller/src/report.rs
# 표본 풀기·합치기
grep -n "pub struct SplitHist\|pub fn resolve\|pub fn hist" crates/controller/src/sample.rs
grep -n "pub fn merge_into\|pub fn percentiles_of" -A4 crates/engine/src/percentiles.rs
# 통계 블록·min 원인
grep -n "min_us: h.min()\|pub fn value_at_milli\|pub fn is_cap_value\|pub const CAP_US" crates/controller/src/latency_stats.rs
grep -n "export function latencyShown" -A6 ui/src/components/report/format.ts
# 준비 스텝은 다른 테이블
grep -n "run_section_step_metrics" crates/controller/src/store/*.rs | head
# 화면 시계열·쓰는 곳
grep -rn "bySecond(" ui/src --include=*.ts --include=*.tsx | grep -v __tests__
grep -n "max across steps\|coarse" ui/src/report/bySecond.ts
grep -n "MetricKey" ui/src/compare/overlaySeries.ts
# Zod strict
grep -n "export const ReportWindowSchema" -A12 ui/src/api/schemas.ts
# 인쇄 절·블록·부록·서명란
grep -n "export function standardBlocks" -A60 ui/src/print/buildPrintDoc.ts
grep -n "appendix: \"부록. 그 밖의 기준 전체\"" ui/src/i18n/ko.ts
grep -n "const MAX_BARS\|export function pickBinSeconds" ui/src/print/chartModel.ts
grep -n "p95Ms: pick" ui/src/print/stepStatus.ts
grep -c "응답시간" ui/src/i18n/ko.ts
# 내보내기·골든
grep -n "pub fn " crates/controller/src/export.rs
grep -n "const SUMMARY_METRICS" crates/controller/src/export.rs ui/src/compare/compareReports.ts
grep -rn "compare_golden.json" crates ui/src
# 비교 인쇄
grep -n "const STANDARD_SECTIONS" -A10 ui/src/print/compare/buildCompareDoc.ts
grep -n "key: \"" ui/src/print/compare/change.ts
```

HDR 기대값(R-A1·R-A2·R-B1)은 스크래치 Rust로 냈다 — `hdrhistogram = "=7.5.4"`, `Histogram::<u64>::new_with_bounds(1, 60_000_000, 3)`, 백분위는 `latency_stats.rs` `value_at_milli`와 같은 정수 순위(`div_ceil(n_milli × len, 100_000)` 번째 표본 칸의 `highest_equivalent`, 60,000,000으로 자름). 출력(2026-11-25):

```
RA1 mean=2000.3333333333335 round=2000 len=3              # 1000·2000·3000 µs
RA2 len=100 mean=1990 p95=1000 p95A_ms=1 p95B_ms=100      # 1,000µs×99 + 100,000µs×1 합침
cap min=59998208 mean=60014592 max=60030975 lowest=59998208   # 60,000,000µs 1건
59s min=58982400 lowest=58982400 high=59015167             # 59,000,000µs 1건
mix len=4 mean=30007796 round=30007796 p95=60000000 max=60030975   # 60,000,000µs×2 + 1,000µs×2 (2026-11-26)
```
