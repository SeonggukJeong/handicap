# verdict-stats ④b — 인쇄·CSV/XLSX·비교의 통계 칸 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ③a가 리포트에 실어 둔 µs 통계 블록(`stats`)을 CSV/XLSX 내보내기·비교 화면·비교 내보내기·인쇄 보고서·비교 인쇄에 내보이고, 60초 칸 값을 어디서도 표시 없이 보이지 않게 한다.

**Architecture:** 와이어 변경 없음 — 서버는 `latency_stats`의 `min_us` 하나와 `export.rs`만 바뀐다. 비교 변화율은 Rust `export.rs`와 TS `compareReports.ts`가 같은 지표 목록·같은 「잘림」 규칙을 갖고 `testdata/compare_golden.json` 하나로 서로 대조한다(첫 task 한 커밋). 화면·인쇄의 시간 글자는 µs 값 하나에서 「내림/반올림 → 1ms 미만 µs → 60초 칸」 규칙의 공용 함수로 만든다.

**Tech Stack:** Rust(axum 컨트롤러·`csv`·`rust_xlsxwriter` 0.79·테스트 `calamine`) · TypeScript(React·Zod·vitest·RTL) · 인쇄(mm 단위 표·SVG).

REVIEW-GATE: APPROVED

**Spec:** `docs/superpowers/specs/2026-11-25-verdict-stats-b-design.md` — 이 plan은 ④b(R-B1–R-B12). 요구 ID는 spec 것. 시각 기준 = 목업 `docs/superpowers/specs/2026-11-25-verdict-stats-b-mockups/b-screens.html` **2번 표 부분**(비교 표)·**4번**(인쇄 통계 표)·**6번**(비교 인쇄 요약 표·평균 덤벨)·**7번**(CSV).

US(spec 「사용자 스토리 (US)」 중 ④b): **US5**(최소 「≥ 60,000」 버그) · **US6**(CSV·XLSX 통계 칸) · **US7**(인쇄 통계) · **US8**(비교 화면·비교 내보내기) · **US9**(비교 인쇄 p90·최대·평균 덤벨).

사용자 결정(다시 묻지 않는다): 비교 지표 순서 `p50·p90·p95·p99·평균·최소·최대·표준편차·rps·error_rate` 승인(roadmap §B98 (4)) · 옛 run은 신경 쓰지 않는다(spec 결정 1 — `stats` 없는 리포트는 시간 칸이 빈 칸) · CSV 시간 값 ms 소수 3자리(결정 8) · ③ ↔ ④a ↔ ④b 사이 릴리즈 금지.

## Global Constraints

- **와이어·스키마·proto·마이그레이션·엔진·워커 무변경.** `ReportJson`/Zod에 칸을 더하지 않는다. 판정(`evaluate_criteria`)·속도 구간·인사이트·실행 중 화면 무변경.
- 상수: `CAP_US = 60_000_000`(서버 `latency_stats::CAP_US`, 화면 `ui/src/components/report/format.ts` `CAP_US`). 정수 ms 칸은 「≥ 60,000 ⇔ 60초 칸」(spec §1.1).
- **비교 지표(Rust `SUMMARY_METRICS`·TS `SUMMARY_METRICS` 같은 순서):** `p50_ms, p90_ms, p95_ms, p99_ms, mean_ms, min_ms, max_ms, stdev_ms, rps, error_rate`. **스텝 지표(`STEP_METRICS`, 두 쪽 같은 순서):** `p95_ms, mean_ms, min_ms, max_ms, stdev_ms, p90_ms`. 시간 지표 여덟 개는 모두 「낮을수록 좋음」.
- **시간 값** = `stats`의 µs ÷ 1000(f64 — Rust `us as f64 / 1000.0`, TS `us / 1000`; 같은 IEEE 나눗셈). **값 없음** = `stats` 없음 **또는** `latency_missing`(기본 표본이 「통과한 요청」인데 `count == errors`). 정수 `p50_ms`·`p95_ms`·`p99_ms`·`mean_ms` 칸은 비교·내보내기에서 더는 읽지 않는다.
- **「잘림」 규칙(R-B5, Rust·TS 같은 식):** 지표가 잘림 = `mean_ms`·`stdev_ms`는 `stats.capped`, 나머지 시간 지표는 그 µs 값 ≥ `CAP_US`. 양쪽 다 안 잘림 → 지금 식(`capped: false`). 한쪽만 잘림 → `pct: null`·`capped: true`, 방향은 **비교 쪽이 잘렸고 비교 값 ≥ 기준 값이면 `bad`**, **기준 쪽이 잘렸고 기준 값 ≥ 비교 값이면 `good`**, 아니면 `neutral`. 둘 다 잘림 → `pct: null`·`neutral`·`capped: true`.
- 시간 글자 규칙(화면·인쇄 공통): 최소·최대·백분위는 µs → ms **내림**, 평균·표준편차는 **반올림**, 1ms 미만(µs < 1000)은 µs, µs ≥ `CAP_US`는 60초 칸 글자.
- CSV 시간 글자: µs 정수 → `"{us / 1000}.{us % 1000:03}"`(부동소수 금지). XLSX 시간 셀은 숫자(`us as f64 / 1000.0`), `capped`는 `write_boolean`.
- 새 문구는 `ui/src/i18n/ko.ts` 경유(ADR-0035). 화면 「스텝」·인쇄 「단계」. 「≥」 뒤는 ` `(`ko.report.stats.capped` 재사용 — 테스트 기대값은 `ko` 상수로).
- `.tsx`는 컴포넌트만 내보낸다(`react-refresh/only-export-components`, `pnpm lint --max-warnings=0`) — 순수 도우미는 `.ts`.
- 기대값 근사 금지(working-rules §10-1) — 아래 숫자는 손계산 정확값이거나 spec §11 스크래치 출력.
- 게이트: cargo-영향 커밋은 pre-commit이 `fmt --check`·build·`clippy -D warnings`·`nextest`·doctest, UI는 `cd ui && pnpm lint && pnpm test && pnpm build`. `| tail`·`| head` 금지(`; echo exit=$?`), `--no-verify` 금지, 커밋 전 `git diff --cached --name-only`. `ui/src` production 편집 전에 UI 테스트 파일이 pending이어야 한다(`tdd-guard`). 구현자의 커밋은 단일 FOREGROUND 호출(600000ms).
- 워크트리 `/Users/sgj/develop/handicap/.claude/worktrees/verdict-stats-4b`, 기록 파일은 `.superpowers/sdd/`(워크트리 루트에 `.md` 쓰기·`git add` 금지).

## Review Focus

1. **`stats`가 없는 리포트**(요청 0건·옛 JSON·통과한 요청 없는 스텝) — 내보내기 시간 칸·`capped` 빈 칸, 비교 값·변화율 빈 칸, 인쇄 통계 표 「–」(전부 없으면 절 없음), 비교 인쇄 행 「비교 불가」. 어디서도 0·`false`로 찍거나 throw하지 않는다. Task 1·2·3·5·6.
2. **인쇄 「측정 조건」의 think time ≥ 60초**(상한 600,000ms) — `fmtMs`에 60초 칸 글자를 넣으면 「대기 60초 이상」으로 거짓이 된다. 길이 글자(`fmtDurMs`)와 응답 시간 글자(`fmtMs`)를 가른다. Task 4.
3. **양쪽 다 60초 칸인 비교**(같은 값 60,000 ↔ 60,000) — 「동일」·「+0.0%」가 아니라 「—」·중립, CSV `delta_pct` = `capped`. Task 1·2·3.
4. **스텝이 한쪽 run에만 있는 비교 + run 3개** — 스텝 통계 행의 값·Δ 칸이 빈 칸이고 뒤 run의 Δ가 제 열에 선다(Δ 열 카운터는 무조건 전진 — 컨트롤러 함정 노트 「per-step Δ」). 화면 표는 통계 행을 스텝 이름이 아니라 스텝 id로 제 스텝에 붙인다. Task 1(TS 값)·2(XLSX 열)·3(표).
5. **평균은 60초 미만인데 분포가 60초 칸에 걸린 run**(`stats.capped`, `mean_us` 30,007,796) — 평균·표준편차가 「하한」임이 보인다: 비교 변화율 「—」, 인쇄 통계 표 아래 안내, 비교 인쇄·핵심 지표 카드 「30.0초 이상」. Task 1·5·6.

## 사실 확인 명령 (claims-ledger — 디스패치 전 orchestrator가 다시 돌린다)

```bash
grep -n "min_us: h.min()" crates/controller/src/latency_stats.rs                       # 1줄(R-B1 원인)
grep -n "^const SUMMARY_METRICS" crates/controller/src/export.rs ui/src/compare/compareReports.ts   # 둘 다 5개짜리
grep -n "^fn delta(\|^fn delta_cell_text(\|^fn summary_value(\|^fn summary_metric(\|^fn latency_missing(\|^fn latency_csv(\|^fn write_steps_table(\|^fn write_summary_numbers(\|^fn write_setup_sheet(\|^pub fn report_to_csv(\|^pub fn report_to_xlsx(\|^pub fn comparison_to_csv(\|^pub fn comparison_to_xlsx(" crates/controller/src/export.rs   # 13줄
grep -n "write_summary_numbers(ws, 1\|write_steps_table(ws, 9\|ws.write_string(7, 0, \"validity_level\")\|let mut next_row = 9u32" crates/controller/src/export.rs   # 박힌 행 번호 4곳
grep -rn "compare_golden.json" crates ui/src                                             # 7줄(export.rs 3 + compareReports.test.ts 1 + 함정 노트 3) — 골든을 읽는 곳
python3 -c "import json;g=json.load(open('testdata/compare_golden.json'));print([r['metric'] for r in g['expected']['summary']],len(g['expected']['polarity']),len(g['missing_cases']),[len(r['steps']) for r in g['reports']])"   # 5개 지표, 12, 2, [0, 0]
grep -n "export type Delta\|export type Cell \|export type CompareRow\|export type CompareResult" ui/src/compare/compareReports.ts
grep -rn "<CompareMatrix" ui/src | grep -v __tests__                                     # ScenarioComparePage 1곳
grep -n "const floorMs\|const roundMs\|^function statText" ui/src/components/report/StepStatsTable.tsx
grep -rn "fmtMs(" ui/src | grep -v __tests__                                             # 8줄 = 정의 1 + 호출 7줄(verdict·StepCodeTable·sentences·conditions[한 줄에 둘]·change·dumbbell 2줄)
grep -n "think(fmtMs" ui/src/print/conditions.ts                                         # 1줄(Review Focus 2)
grep -c "응답시간" ui/src/i18n/ko.ts                                                      # 21 (인쇄 밖 4줄: 83·2132·2141·2148)
grep -rn "stepStatus(" ui/src | grep -v __tests__                                        # 정의 + buildPrintDoc·compare/runModel (+ errorCells의 `c.issues.stepStatus(` — 이름만 같은 ko 함수)
grep -n "export type StepRow" -A16 ui/src/print/stepTable.ts                             # stats 칸 없음
grep -n "export function sectionNumbers" -A14 ui/src/print/buildPrintDoc.ts              # setup·speed만 받음, 3부터
grep -n "it.id === \"steplat\"\|b.id === \"steplat\"" ui/src/print/PrintDocument.tsx      # MeasureSheet·PageBody 두 갈래
grep -n "^const SPECS\|major: \|export type MetricKey" ui/src/print/compare/change.ts
grep -n "cmp:kpi:bars\|cmp:kpi:plain" ui/src/print/compare/buildCompareDoc.ts ui/src/print/compare/CompareDocument.tsx
grep -n "const STANDARD_SECTIONS" -A10 ui/src/print/compare/buildCompareDoc.ts
grep -n "export type CmpTableId" ui/src/print/compare/buildCompareDoc.ts
```

---

### Task 1: 비교 지표·잘림 규칙·골든 — Rust와 TS 한 커밋 (R-B5, R-B6·R-B7의 값 출처)

**Files:**
- Modify: `crates/controller/src/export.rs`, `testdata/compare_golden.json`, `ui/src/compare/compareReports.ts`, `ui/src/components/compare/CompareMatrix.tsx`(`DeltaChip`의 잘림 갈래만), `ui/src/i18n/ko.ts`
- Test: `crates/controller/src/export.rs` 인라인, `ui/src/compare/__tests__/compareReports.test.ts`, `ui/src/components/compare/__tests__/CompareMatrix.test.tsx`

**Interfaces (Produces):**
- Rust(`export.rs`, 모두 모듈 안 비공개):
  - `const SUMMARY_METRICS: [&str; 10]`, `const STEP_METRICS: [&str; 6]`(Global Constraints 순서), `fn is_time_metric(metric: &str) -> bool`.
  - `pub struct Delta { pub pct: Option<f64>, pub polarity: Polarity, pub capped: bool }`.
  - `#[derive(Clone, Copy)] struct MetricVal { v: f64, us: Option<u64>, cut: bool }` — `us`는 시간 지표일 때만(Task 2의 CSV 글자용).
  - `fn stat_val(stats: &LatencyStats, metric: &str) -> Option<MetricVal>` — 시간 지표 이름 → 그 µs 칸, `cut`은 Global Constraints 식.
  - `fn summary_value(r: &ReportJson, metric: &str) -> Option<MetricVal>`(시간 지표: 값 없음이면 `None`; `rps`·`error_rate`: 지금 식, `cut: false`), `fn step_value(r: &ReportJson, step_id: &str, metric: &str) -> Option<MetricVal>`(스텝 없음·값 없음 → `None`).
  - `fn delta(metric: &str, base: f64, val: f64) -> Delta`(지금 식 + `capped: false`, `lower_is_better`에 시간 지표 여덟 개), `fn delta_of(metric: &str, base: MetricVal, val: MetricVal) -> Delta`(잘림 규칙).
  - `fn delta_cell_text(d: &Delta, value: f64) -> String` — `d.capped`를 먼저 본다: `Bad` → `"▲ —"`, `Good` → `"▼ —"`, `Neutral` → `"—"`.
  - `summary_metric`은 지운다(쓰는 곳이 `summary_value` 안으로 들어간다).
- TS(`compareReports.ts`):
  - `export type Delta = { pct: number | null; polarity: Polarity; capped: boolean }`.
  - `export type Cell = { value: number | null; delta: Delta | null; time?: { us: number; round: "floor" | "round" } }`(`round`: `mean_ms`·`stdev_ms`는 `"round"`, 나머지 시간 지표 `"floor"`; 값이 없으면 `time` 없음).
  - `export const SUMMARY_METRICS`, `export const STEP_METRICS`(같은 순서), `export function computeDelta(metric, base, val): Delta`(+ `capped: false`), `export function computeDeltaCapped(metric: string, base: { v: number; cut: boolean }, val: { v: number; cut: boolean }): Delta`.
  - `CompareResult.stepStats: CompareRow[]` — 스텝 id 정렬 순 × `STEP_METRICS`에서 `p95_ms`를 뺀 다섯(`mean_ms, min_ms, max_ms, stdev_ms, p90_ms`), `id` = 스텝 id, `label` = 지표 이름, `metric` = 지표. `steps`(p95 행)는 `stats.p95_us`에서 값을 얻고 **`id` = 스텝 id를 싣는다**(`ScenarioComparePage`의 `labeledResult`가 `label`을 스텝 이름으로 바꾸므로, 표가 통계 행을 제 스텝에 붙일 열쇠는 `id`뿐이다).
  - `ko.compare.cappedDeltaTitle = "60초를 넘긴 응답이 있어 변화율을 계산할 수 없습니다"`. 잘림 칩의 `aria-label`: `bad` → `ko.compare.worseAria(cappedDeltaTitle)`, `good` → `ko.compare.betterAria(cappedDeltaTitle)`, `neutral` → `cappedDeltaTitle` 그대로(`neutralAria`는 「동일: …」이라 쓰지 않는다).

**골든 `testdata/compare_golden.json` — 손계산 값(이 표가 정본):**

기본 `reports` 둘에 `summary.stats`를 넣는다(기존 정수 칸은 그대로 둔다). `count`·`errors`·`rps`는 지금 값.

| 칸(µs) | run-baseline | run-candidate | 기대 `pct` | 방향 |
|---|---|---|---|---|
| `p50_us` | 9000 | 11000 | 0.2222222222222222 (기존) | bad |
| `p90_us` | 100000 | 120000 | 0.2 | bad |
| `p95_us` | 152000 | 184000 | 0.21052631578947367 (기존) | bad |
| `p99_us` | 240000 | 251000 | 0.04583333333333333 (기존) | bad |
| `mean_us` | 25000 | 32000 | 0.28 | bad |
| `min_us` | 2000 | 3000 | 0.5 | bad |
| `max_us` | 400000 | 500000 | 0.25 | bad |
| `stdev_us` | 30000 | 36000 | 0.2 | bad |
| `capped` | false | false | | |

`expected.summary`는 `SUMMARY_METRICS` 순서 열 행(`values`는 ms — `[9, 11]`, `[100, 120]` …, 기존 `rps`·`error_rate` 행 그대로), 모든 delta에 `"capped": false`.

기본 `reports` 둘에 `steps` 한 개씩(`step_id: "s1"`, 서버 `ReportStep` serde가 요구하는 칸 — `count`·`error_count`·`status_counts: {}`·`p50_ms`·`p95_ms`·`p99_ms`[`stats`와 같은 ms]·`loop_breakdown: []` — + `stats`): baseline `{min 1000, mean 20000, max 300000, stdev 10000, p50 8000, p90 50000, p95 80000, p99 200000}`, candidate `{min 1000, mean 25000, max 240000, stdev 15000, p50 9000, p90 60000, p95 100000, p99 210000}`(둘 다 `capped: false`, `count` 100·`error_count` 0). `expected.step_deltas`(`{step_id, metric, values, deltas}` — `STEP_METRICS` 순서): p95 `[80, 100]` 0.25 bad · mean `[20, 25]` 0.25 bad · min `[1, 1]` 0 neutral · max `[300, 240]` −0.2 good · stdev `[10, 15]` 0.5 bad · p90 `[50, 60]` 0.2 bad.

`expected.capped`(함수 표 — `{metric, base, val, base_cut, val_cut, pct, polarity, capped}`):

| metric | base | val | base_cut | val_cut | pct | polarity | capped |
|---|---|---|---|---|---|---|---|
| max_ms | 1840 | 60000 | false | true | null | bad | true |
| mean_ms | 40000 | 30007.796 | false | true | null | neutral | true |
| max_ms | 60000 | 1840 | true | false | null | good | true |
| mean_ms | 30007.796 | 40000 | true | false | null | neutral | true |
| p99_ms | 60000 | 60000 | true | true | null | neutral | true |
| stdev_ms | 100 | 100 | false | true | null | bad | true |
| p95_ms | 152 | 184 | false | false | 0.21052631578947367 | bad | false |

`expected.polarity`의 12행에는 `capped`를 넣지 않는다(테스트가 `capped === false`를 단언).

`stats_cases`(리포트 단위 — 「잘림」 판정이 `stats`에서 맞게 나오는지. 각 `{name, reports[2], baseline_id, expected.summary}` — `expected.summary`는 적은 행만 검사):
- `candidate_capped`: baseline = 기본 baseline `stats`. candidate `stats` = `{min 1000, mean 30007796, max 60000000, stdev 29999796, p50 1000, p90 60000000, p95 60000000, p99 60000000, capped: true}`. 기대: `p50_ms` `[9, 1]` pct −0.8888888888888888 good capped false · `p90_ms` `[100, 60000]` null bad true · `max_ms` `[400, 60000]` null bad true · `mean_ms` `[25, 30007.796]` null bad true · `stdev_ms` `[30, 29999.796]` null bad true · `min_ms` `[2, 1]` −0.5 good false.
- `both_capped`: 두 쪽 다 위 candidate `stats`. 기대: `max_ms` `[60000, 60000]` null neutral true · `mean_ms` null neutral true · `p50_ms` `[1, 1]` 0 neutral false.
- `stats_absent`: candidate에 `summary.stats` 키 없음, `sample` 키 없음(기본 표본 「모든 요청」). 기대: 시간 지표 여덟 행 모두 candidate 값 `null`·delta `null`, `rps`·`error_rate`는 기본과 같은 값.

`missing_cases` 둘: 통과한 요청이 있는 쪽 리포트에만 `summary.stats`(정수 칸 × 1000, 새 칸은 기본 표의 baseline/candidate 값)를 넣고, `count == errors`인 쪽에는 넣지 않는다. `expected.summary`를 열 행으로 늘린다(시간 여덟 행은 없는 쪽 `null`·delta `null`, 기존 `rps`·`error_rate` 행 그대로 + `"capped": false`).

- [ ] **Step 1: 골든 다시 쓰기** — 위 표대로 `testdata/compare_golden.json` 편집. `python3 -c "import json;json.load(open('testdata/compare_golden.json'))"` 통과.
- [ ] **Step 2: 실패하는 테스트(Rust 인라인, `export.rs` `mod tests`)** — 골든 테스트 셋을 다음으로 바꾸거나 더한다.
  - `golden_summary_deltas_match`: `expected.summary`의 지표 이름 순서 == `SUMMARY_METRICS`; 행마다 `summary_value`의 `v`가 `values[i]`와 1e-9 안, `delta_of` 결과의 `pct`(1e-9)·`polarity`·`capped`가 기대와 같다.
  - `golden_step_deltas_match`: `expected.step_deltas`의 `(step_id, metric)` 순서 == 스텝 id 정렬 × `STEP_METRICS`; `step_value`·`delta_of`로 같은 단언.
  - `golden_capped_table_matches`: `expected.capped` 7행을 `delta_of(metric, MetricVal{v: base, us: None, cut: base_cut}, …)`로.
  - `golden_polarity_matches`: 기존 + 12행 모두 `!d.capped`.
  - `golden_missing_cases_match`: 열 행으로 + `golden_stats_cases_match`(`stats_cases` 셋, 적힌 행만: 값·`null`·delta).
  - `delta_cell_text_capped`: `Delta{pct: None, polarity: Bad, capped: true}` → `"▲ —"`, `Good` → `"▼ —"`, `Neutral` → `"—"`; `capped: false`인 기존 경우(`delta_cell_text_mirrors_deltachip`)는 그대로.
  - 기존 비교 테스트 fixture(`step`·`split_run`·`named_run`·`compare_trio` 등)에 **정수 칸과 같은 값의 `stats`(µs = ms × 1000, 새 칸은 임의의 정상 값)를 넣어** 기존 단언의 값·변화율이 그대로이게 한다. 행 번호를 박은 단언(`lines[4].starts_with("rps,")`, XLSX `for row in 1..=3`)은 새 행 순서에 맞게 고친다 — `rps`는 아홉째 지표라 CSV `lines[9]`. 이 task에서 깨지는 기존 `export.rs` 단언(`grep -n "lines\[\|lines().count()\|lines().nth(\|for row in 1..=" crates/controller/src/export.rs`로 전수 확인): `compare_skips_value_and_delta_when_either_side_missing`, 준비 스텝 비교 CSV의 `lines[5..8]`(`comparison_csv_setup_rows_before_basis`·`comparison_setup_exports_blank_deltas_when_baseline_has_no_setup`), `comparison_csv_without_setup_is_unchanged`(CSV 통글자 — `assert_eq!(`와 글자가 다른 줄이라 위 grep에 안 걸린다), `comparison_xlsx_roundtrips`·`comparison_xlsx_steps_delta`의 행 번호. 이 목록은 출발점이다 — `cargo nextest`가 알려 주는 나머지도 같은 식으로 고친다. **옛 run 단언은 없앤다**(spec 결정 1): 비교 쪽에서 「옛 run은 0을 그대로 찍는다」를 지키던 단언은 「`stats` 없으면 빈 칸」으로 다시 쓴다 — 0 값 `stats`를 넣어 이름과 다른 것을 검사하는 테스트로 남기지 않는다.
- [ ] **Step 3: 실패 확인** — `cargo nextest run -p handicap-controller golden_ delta_cell_text; echo exit=$?` → 컴파일 실패(없는 이름) 또는 FAIL.
- [ ] **Step 4: 구현(Rust)** — Interfaces대로. `comparison_to_csv`·`comparison_to_xlsx`의 요약 행은 `summary_value`·`delta_of`를 쓰고 값 글자는 이번 task에서는 `v.to_string()` 그대로(소수 3자리·스텝 행·`capped` 칸 글자는 Task 2). XLSX Steps 시트의 `step_p95`는 `step_value(r, sid, "p95_ms")`로. 준비 스텝 행(`setup_ok`·`setup_failed`·`setup_errors`)은 `delta(metric, b, x)` 그대로. `Delta { … }` 리터럴이 테스트에 있으면 `capped: false`.
- [ ] **Step 5: 실패하는 테스트(TS)** — `compareReports.test.ts`: ① 골든 요약 — `result.summary.map(r => r.metric)` == `golden.expected.summary.map(r => r.metric)`, 행마다 `cells[i].value`(1e-9)·`delta`의 `pct`·`polarity`·`capped`. ② `expected.step_deltas` — `p95_ms` 행은 `result.steps`, 나머지는 `result.stepStats`에서 `(id, metric)`으로 찾아 같은 단언; `result.stepStats.map(r => [r.id, r.metric])` 순서 == 골든에서 `p95_ms`를 뺀 순서. ③ `expected.capped` 7행 → `computeDeltaCapped`. ④ `expected.polarity` 12행 `capped === false`. ⑤ `missing_cases`·`stats_cases`. ⑥ 스텝이 한쪽에만: run 셋(A 기준·B에는 스텝 `s2` 없음·C에는 있음) → `stepStats`의 `s2` 행 B 칸 `{ value: null, delta: null }`, C 칸에 delta, `steps`의 `s2` 행도 같다; `result.steps.every(r => r.id !== undefined)`. ⑦ `Cell.time`: 기본 골든의 `mean_ms` 행 baseline 칸 `time` == `{ us: 25000, round: "round" }`, `min_ms` 행 == `{ us: 2000, round: "floor" }`, `rps` 행은 `time` 없음, `stats_absent`의 candidate 시간 칸은 `value: null`·`time` 없음. 기존 케이스(파일 안 `delta: { pct: …, polarity: … }` 리터럴)는 `capped: false`를 더하고 fixture에 `stats`를 넣는다 — 통째 `toEqual`하는 「no setup anywhere」 케이스는 열 행·`time`·`id`·`stepStats`까지 다시 쓴다. 「옛 run(sample 없음)… 0 그대로」 케이스는 「`stats` 없는 리포트는 시간 칸이 값 없음」으로 다시 쓴다(spec 결정 1). 같은 커밋에서 깨지는 다른 파일: `CompareMatrix.test.tsx`의 `CompareResult` 리터럴 넷(`stepStats: []` 필수), `ui/src/pages/__tests__/ScenarioComparePage.test.tsx`의 칸 글자 단언(fixture 리포트에 `stats`를 넣는다) — `pnpm test`·`pnpm build`가 알려 주는 나머지도 같은 식으로. `CompareMatrix.test.tsx`: `delta: { pct: null, polarity: "bad", capped: true }` 칸 → 글자 「▲—」, `title` == `ko.compare.cappedDeltaTitle`, `aria-label` == `ko.compare.worseAria(ko.compare.cappedDeltaTitle)`; `good` → 「▼—」; `neutral` → 「—」이고 `aria-label` == `ko.compare.cappedDeltaTitle`(글자·접근성 이름 어디에도 「신규」·「동일」이 없다).
- [ ] **Step 6: 구현(TS)** — Interfaces대로. `DeltaChip`은 `cell.delta.capped`를 `pct === null` 갈래보다 먼저 본다(글자 「—」, 색·글리프는 방향, `title`, `aria-label`은 Interfaces대로). `CellContent`의 값 글자·행 이름·접는 단추는 Task 3. `compareReports`를 쓰는 다른 곳이 `Delta` 리터럴을 만들면 `capped: false`(`tsc -b`가 알려 준다).
- [ ] **Step 7: 통과 확인** — `cargo nextest run -p handicap-controller; echo exit=$?` → 0, `cd ui && pnpm lint; echo exit=$?`·`pnpm test; echo exit=$?`·`pnpm build; echo exit=$?` → 모두 0.
- [ ] **Step 8: 되돌려 확인** — ① TS `SUMMARY_METRICS`에서 `p90_ms`를 빼면 TS 골든 RED ② Rust `delta_of`의 잘림 갈래를 지워 `delta(metric, base.v, val.v)`만 부르게 하면 `golden_capped_table_matches` RED ③ Rust `stat_val`에서 `mean_ms`의 `cut`을 `us >= CAP_US`로 바꾸면 `golden_stats_cases_match`(`candidate_capped`의 `mean_ms`) RED ④ TS `DeltaChip`의 잘림 갈래를 지우면 「▲—」 단언 RED — 각각 원복.
- [ ] **Step 9: 커밋** — `feat: 비교 지표에 p90·평균·최소·최대·표준편차, 60초 칸 변화율 규칙 (서버·화면 골든 한 짝)`.

### Task 2: 내보내기 — 최소 60초 칸, CSV·XLSX 통계 칸, 비교 CSV·XLSX 스텝 통계 (R-B1, R-B2, R-B3, R-B4, R-B6)

**Files:**
- Modify: `crates/controller/src/latency_stats.rs`, `crates/controller/src/export.rs`, `crates/controller/tests/export_routes_test.rs`(머리 글자·열 수를 단언하면), `testdata/report_whole_golden.json`(R-B1로 값이 바뀔 때만 — Step 5)
- Test: 두 `.rs` 인라인 + 위 통합 테스트

**Interfaces:**
- Consumes: Task 1 `MetricVal`·`summary_value`·`step_value`·`delta_of`·`STEP_METRICS`·`delta_cell_text`.
- Produces(`export.rs` 비공개):
  - `fn ms3(us: u64) -> String`.
  - `const STAT_COLS: [&str; 9] = ["min_ms", "mean_ms", "p50_ms", "p90_ms", "p95_ms", "p99_ms", "max_ms", "stdev_ms", "capped"]`, `fn stat_us(s: &LatencyStats) -> [u64; 8]`(같은 순서).
  - `fn cap_ms(ms: u64) -> (u64, bool)` = `ms >= 60_000`이면 `(60_000, true)`.
  - `fn write_steps_table(ws, first_row: u32, steps: &[ReportStep], summary: &ReportSummary, sample: &SampleBlock) -> u32`(다음 빈 행), `fn write_summary_numbers(ws, first_row: u32, s: &ReportSummary, sample: &SampleBlock) -> u32`(다음 빈 행).
  - `latency_csv`는 지운다.

- [ ] **Step 1: 실패하는 테스트**
  - `latency_stats::tests::min_is_cap_value_in_cap_bucket`: `hist(&[60_000_000])` → `min_us == 60_000_000`; `hist(&[59_000_000])` → `58_982_400`; `hist(&[1000, 60_000_000])` → `min_us == 1000`.
  - `export::tests::ms3_table`: `0 → "0.000"`, `1 → "0.001"`, `350 → "0.350"`, `999 → "0.999"`, `1000 → "1.000"`, `52118 → "52.118"`, `60_000_000 → "60000.000"`.
  - `csv_stats_columns`: 스텝 a(`stats` min 350·mean 4021·p50 3001·p90 7003·p95 9007·p99 21007·max 88063·stdev 3110·capped false, count 10·error 0), 스텝 b(`stats` max 60_000_000·capped true, 나머지 임의), 스텝 c(`sample.default == Passed`, `count == error_count`, `stats: None`), `summary.stats` 있음 → `lines[0] == "step_id,count,error_count,min_ms,mean_ms,p50_ms,p90_ms,p95_ms,p99_ms,max_ms,stdev_ms,capped"`, a 줄 == `"a,10,0,0.350,4.021,3.001,7.003,9.007,21.007,88.063,3.110,false"`, b 줄의 `max_ms` 칸 `60000.000`·끝 `true`, c 줄 == `"c,{count},{count},,,,,,,,,"`(시간 여덟 칸 + `capped` 빈 칸), 마지막 스텝 줄 다음이 `*,{summary.count},{summary.errors},…`(`summary.stats` 값). 통과한 요청이 있어도 `stats: None`인 스텝 → 시간 칸·`capped` 빈 칸. `summary.stats`가 없으면 `*` 줄의 시간 칸·`capped`도 빈 칸.
  - `csv_setup_caps_60s`: 준비 스텝 `p95_ms: 60030`·`max_ms: 60030`·`p50_ms: 12` → 머리 `setup_step_id,count,error_count,p50_ms,p95_ms,max_ms,capped`, 줄 `…,12,60000,60000,true`; 60,000 미만뿐인 준비 스텝 → 끝 `false`.
  - `xlsx_summary_rows_follow_stats`: Summary A열 == `["count","errors","rps","duration_seconds","p50_ms","p90_ms","p95_ms","p99_ms","mean_ms","min_ms","max_ms","stdev_ms","capped","validity_level","validity_reason_kinds", …]`(행 0부터), `p90_ms` 행 B열 == `p90_us / 1000`(Float), `capped` 행 B열 == `Data::Bool`, `basis`가 있는 리포트에서 `basis` 행이 `validity_reason_kinds` 바로 다음, 마지막 행 `latency_sample`. 값 없음이면 시간 여덟 행·`capped` 행 B열 빈 칸.
  - `xlsx_steps_sheet_stats`: Steps 머리 12열, 스텝 행 시간 칸 Float(`0.35`)·`capped` Bool, 마지막 행 A열 `"*"`.
  - `xlsx_other_basis_same_shape`: Other basis 시트 — 행 0 `basis`, 행 1부터 Summary와 같은 13행, 그 뒤 빈 행 하나, 그 다음 행이 Steps 머리(`step_id`)이고 12열.
  - `xlsx_windows_mean_and_cap`: Windows 머리 == `[…, "p99_ms", "mean_ms", "capped"]`; 창 `p95_ms: 60030, p99_ms: 60030, p50_ms: 1, mean_us: Some(30_007_796)` → p95·p99 셀 `60000.0`, `mean_ms` 셀 `30007.796`, `capped` `Bool(true)`; p 칸은 모두 60,000 미만인데 `capped: true`인 창(200건 중 1건만 60초 초과 — 평균만 하한) → p 칸 그대로·`capped` `Bool(true)`; `mean_us: None`인 창 → `mean_ms` 빈 셀; 값 없음(`latency_missing`) 창 → p 칸·`mean_ms`·`capped` 빈 셀; 60,000 미만 창 → `Bool(false)`.
  - `xlsx_setup_sheet_caps_60s`: Setup 시트 머리 끝에 `capped`(9번째 열), `60030 → 60000.0` + `Bool(true)`.
  - `comparison_csv_time_text_and_step_rows`: run 둘(스텝 `s1` 하나, Task 1 골든 기본 값과 같은 `stats`) → `p50_ms` 줄 == `"p50_ms,9.000,11.000,0.222222"`, `rps` 줄은 지금 글자, 요약 열 줄 바로 다음 여섯 줄 == `step:s1:p95_ms,80.000,100.000,0.250000` · `step:s1:mean_ms,20.000,25.000,0.250000` · `step:s1:min_ms,1.000,1.000,0.000000` · `step:s1:max_ms,300.000,240.000,-0.200000` · `step:s1:stdev_ms,10.000,15.000,0.500000` · `step:s1:p90_ms,50.000,60.000,0.200000`; 준비 스텝·`basis` 줄은 그 뒤. 비교 쪽 `max_us` 60,000,000 → 그 줄 `delta_pct` 칸 == `capped`. 스텝이 기준 run에만 있으면 비교 쪽 값·`delta_pct` 빈 칸.
  - `comparison_xlsx_step_stats_sheet`: run 셋(A 기준, B에는 스텝 `s2` 없음, C는 있음) → 시트 「Step stats」 머리 `["step_id","metric","A (base)","B","C","Δ% B","Δ% C"]`, 행 = 스텝 id 정렬 × `STEP_METRICS`, `s2` 행의 B 값·`Δ% B` 빈 칸이고 `Δ% C`는 제 열(6번째 인덱스)에 글자; 잘림 → `"▲ —"`. 시트 순서: Summary, Steps, Step stats, (Setup), Runs, (Insights).
- [ ] **Step 2: 실패 확인** — `cargo nextest run -p handicap-controller min_is_cap ms3_table csv_ xlsx_ comparison_; echo exit=$?` → 실패.
- [ ] **Step 3: 구현**
  - `latency_stats`: `min_us`가 `is_cap_value(h, h.min())`이면 `CAP_US`.
  - `report_to_csv`: 머리·스텝 줄·`*` 줄(Step 1 그대로). 시간 칸은 `stats`가 있고 `latency_missing`이 아닐 때만. 준비 스텝 블록은 `cap_ms`.
  - `write_summary_numbers`: 행 순서 = Step 1 `xlsx_summary_rows_follow_stats`의 앞 13행, 다음 빈 행 번호를 돌려준다. `report_to_xlsx`의 유효성 두 행·`basis_*`·`latency_sample`은 그 번호부터 이어 쓴다(박힌 `7`·`8`·`9u32` 제거, 「H2: rows 7–8」 주석도 고친다). Other basis는 `let next = write_summary_numbers(ws, 1, …); write_steps_table(ws, next + 1, …)`.
  - `write_steps_table`: `["step_id","count","error_count"]` + `STAT_COLS`, 스텝 행 뒤 `*` 행.
  - Windows·Setup 시트: Step 1대로. Windows `capped` = `win.capped || p50/p95/p99_ms 중 60,000 이상`(④a가 창에 실은 `ReportWindow.capped` — spec R-B4의 식보다 넓다: 옆 `mean_ms`가 하한인 창을 표시 없이 두지 않는다, spec §1.3).
  - 이 task에서 깨지는 기존 단언(머리 글자·행·열 번호를 박은 것 — `grep -n "get_value((\|lines\[\|assert_eq!(csv" crates/controller/src/export.rs`로 전수 확인): `csv_has_header_and_one_row_per_step`, `xlsx_roundtrips_summary_and_steps`(4번 열이 `mean_ms`), `xlsx_summary_includes_validity_rows`(7–9행), `xlsx_summary_has_basis_rows`, `xlsx_other_basis_sheet_holds_other_summary_and_steps`, `xlsx_without_basis_is_unchanged`, `xlsx_summary_has_latency_sample_last_row`, `missing_latency_is_blank_not_zero`(「옛 run … `s,5,5,0,0,0`」·`Float(0.0)` 단언은 「`stats` 없으면 시간 칸 빈 칸」으로 다시 쓴다 — spec 결정 1), `csv_setup_section_follows_steps_after_blank_line`·`csv_without_setup_is_unchanged`(CSV 통글자), `xlsx_setup_sheet_*`, `crates/controller/tests/export_routes_test.rs`의 CSV 머리 단언, 비교 CSV 줄 수를 세는 `comparison_exports_mark_basis_per_run`·`comparison_exports_unchanged_without_basis`·`comparison_csv_without_setup_is_unchanged`(스텝 통계 줄이 늘어난다). 목록은 출발점 — `nextest`가 알려 주는 나머지도.
  - `comparison_to_csv`: 시간 지표 값 글자 = `ms3(us)`, 그 밖은 지금처럼 `v.to_string()`. `delta_pct` = 잘림이면 `capped`, `pct`가 있으면 `{:.6}`, 없으면 빈 칸. 요약 행 뒤 스텝 통계 행(스텝 id 정렬 × `STEP_METRICS`).
  - `comparison_to_xlsx`: 시트 「Step stats」(Steps 바로 뒤). Δ 열 카운터는 비-기준 run마다 무조건 전진.
- [ ] **Step 4: 통과 확인** — `cargo build --workspace --tests; echo exit=$?` → 0, `cargo nextest run -p handicap-controller; echo exit=$?` → 0.
- [ ] **Step 5: `report_whole_golden.json`** — `cargo nextest run -p handicap-controller whole_report_matches_golden; echo exit=$?`가 0이면 손대지 않는다. 0이 아니면 `git show HEAD:testdata/report_whole_golden.json > /tmp/verdict-stats-4b-golden-old.json`, `REPORT_WHOLE_GOLDEN_UPDATE=1 cargo nextest run -p handicap-controller whole_report_matches_golden`, 두 파일을 `jq -S 'walk(if type == "object" then del(.min_us) else . end)'`로 같은 변환을 한 뒤 `cmp`가 `exit=0`(= `min_us` 말고 바뀐 것이 없음)인지 확인하고, 바뀐 `min_us`가 모두 `59998208 → 60000000`인지 `diff`의 `^[+-]` 줄로 확인한다(아니면 STOP).
- [ ] **Step 6: 되돌려 확인** — ① `min_us`를 `h.min()`으로 되돌리면 `min_is_cap_value_in_cap_bucket`이 `59_998_208`로 RED ② Other basis의 Steps 표 시작 행을 옛 `9`로 되돌리면 `xlsx_other_basis_same_shape` RED(Steps 머리는 15행이어야 한다 — 1 + 13 + 빈 행 1), Summary의 유효성 행을 옛 `7`로 되돌리면 `xlsx_summary_rows_follow_stats` RED ③ 비교 XLSX 「Step stats」의 Δ 열 카운터를 「기록할 때만 전진」으로 바꾸면 `comparison_xlsx_step_stats_sheet`의 `Δ% C` 열 단언 RED — 각각 원복.
- [ ] **Step 7: 커밋** — `feat(controller): CSV·XLSX에 최소·평균·백분위·최대·표준편차(ms 소수 3자리)와 60초 칸 표지, 비교 내보내기에 스텝 통계`.

### Task 3: 비교 화면 표 — 시간 글자·행 이름·「응답 시간 통계 더 보기」 (R-B7, 목업 2번 표)

**Files:**
- Modify: `ui/src/components/report/format.ts`, `ui/src/components/report/StepStatsTable.tsx`(공용 함수로 바꿔 끼움), `ui/src/components/compare/CompareMatrix.tsx`, `ui/src/i18n/ko.ts`
- Test: `ui/src/components/report/__tests__/format.test.ts`(있는 파일에 더함), `ui/src/components/compare/__tests__/CompareMatrix.test.tsx`, 기존 `StepStatsTable` 테스트

**Interfaces:**
- Consumes: Task 1 `Cell.time`·`CompareResult.stepStats`·`Delta.capped`.
- Produces:
  - `format.ts`: `export type TimeRound = "floor" | "round"`, `export function statMsText(us: number, round: TimeRound): string` = `latencyCellText(latencyShown(round === "floor" ? Math.floor(us / 1000) : Math.round(us / 1000), us))`. `StepStatsTable`의 `statText`가 이것을 부르고 `floorMs`·`roundMs`는 지운다(결과 불변).
  - `ko.compare.statLabel = { p90_ms: "p90", mean_ms: "평균", min_ms: "최소", max_ms: "최대", stdev_ms: "표준편차" }`(목업 — `p50_ms`·`p95_ms`·`p99_ms`·`rps`·`error_rate` 행 이름은 지금 글자 그대로), `ko.compare.stepStatLabel = (name: string) => \`└ ${name}\``. 단추 글자는 `ko.report.stats.toggleMore`·`toggleLess` 재사용.

- [ ] **Step 1: 실패하는 테스트**
  - `statMsText`: `(1499, "floor")` → `"1"`; `(1500, "round")` → `"2"`; `(1499, "round")` → `"1"`; `(350, "floor")` → `"350 µs"`; `(999, "round")` → `"999 µs"`; `(60_000_000, "floor")` → `ko.report.stats.capped`; `(59_998_207, "floor")` → `"59998"`.
  - `CompareMatrix`(run 둘, 스텝 둘, `stepStats` 열 행 — **스텝 행 `label`은 스텝 이름(「로그인」·「목록 조회」), `id`는 그와 다른 스텝 id**; 실제 화면이 `label`을 이름으로 바꿔 넘긴다): 요약 절 행 이름 순서 == `["p50_ms","p90","p95_ms","p99_ms","평균","최소","최대","표준편차","rps","error_rate"]`; `time: { us: 350, round: "floor" }` 칸 글자 「350 µs」; `time: { us: 60_000_000, round: "floor" }` 칸 글자 == `ko.report.stats.capped`; `time: { us: 52118, round: "round" }` → 「52」; `time` 없는 `rps` 칸은 지금 글자(`String(value)`); `value: null` 칸 「—」. 스텝 절 머리에 `button` 「응답 시간 통계 더 보기」 `aria-expanded="false"`이고 「└ 평균」 행 0개; 누르면 `aria-expanded="true"`·글자 「응답 시간 통계 접기」·「└ 」로 시작하는 행 수 == 스텝 수 × 5, 스텝마다 p95 행 바로 다음에 `└ 평균, └ 최소, └ 최대, └ 표준편차, └ p90` 순서; `stepStats`가 빈 배열이면 단추가 없다. React 중복 `key` 경고 없음(`console.error` 스파이에 `"same key"` 없음 — 펼친 상태에서).
- [ ] **Step 2: 실패 확인** — `cd ui && pnpm test components/report/__tests__/format` · `pnpm test CompareMatrix` FAIL.
- [ ] **Step 3: 구현** — `CellContent`: `cell.value === null` → 「—」, `cell.time`이 있으면 `statMsText(cell.time.us, cell.time.round)`, 아니면 `String(cell.value)`. 요약 절 행 이름 = `ko.compare.statLabel[row.metric] ?? row.label`. 접힘 상태(`useState(false)`)는 `CompareMatrix`가 갖고, 스텝 절 제목 칸(`th colSpan`) 안 오른쪽에 단추를 둔다(제목 글자는 그대로). 펼치면 스텝 p95 행마다 `stat.id === row.id`인 `stepStats` 다섯 행을 바로 밑에 그린다(`label`로 맞추지 않는다; 행 `key` = `` `${row.id}:${row.metric}` ``, 이름 칸은 들여쓴 작은 글자 — 목업 `└` 행).
- [ ] **Step 4: 통과 확인** — 위 + `pnpm test StepStatsTable` + `pnpm test` 전체 PASS.
- [ ] **Step 5: 되돌려 확인** — ① 기본을 펼침으로 바꾸면 「└ 평균 0개」 RED ② `CellContent`가 `time`을 무시하고 `String(value)`를 찍으면 「350 µs」 RED(0.35가 찍힌다) ③ 통계 행을 `label`로 맞추게 바꾸면 「스텝 × 5행」 RED — 각각 원복.
- [ ] **Step 6: 게이트·커밋** — UI 게이트. `feat(ui): 비교 표에 최소·평균·최대·표준편차·p90 행과 스텝별 「응답 시간 통계 더 보기」`.

### Task 4: 인쇄 글자 — 「60초 이상」·「응답 시간」 띄어쓰기·「느림」 판정 넓히기 (R-B9, R-B10)

**Files:**
- Modify: `ui/src/print/format.ts`, `ui/src/print/conditions.ts`, `ui/src/print/stepTable.ts`(`StepRow.stats`), `ui/src/print/stepStatus.ts`, `ui/src/print/buildPrintDoc.ts`, `ui/src/print/compare/runModel.ts`, `ui/src/print/components/SetupPrintTable.tsx`, `ui/src/i18n/ko.ts`
- Test: `ui/src/print/__tests__/format.test.ts`, `conditions.test.ts`, `stepStatus.test.ts`, `stepTable.test.ts`, `SetupPrintTable.test.tsx`, 글자 「응답시간」을 박은 파일(`grep -rln "응답시간" ui/src/print` — 지금 15개: 테스트 11 + 스냅샷 `.html` 2[`__snapshots__` — 테스트를 돌려 다시 만들고 diff가 띄어쓰기뿐인지 본다] + `compare/change.ts` 주석 + `print.css` 주석), `stepStatus` 호출이 있는 테스트 넷(`speedFixtures.ts`·`passedLatency.test.tsx`·`stepStatus.test.ts`·`StepCodeTable.noSamples.test.tsx` — 세 번째 인자 `null`)

**Interfaces (Produces):**
- `format.ts`: `export function fmtDurMs(ms: number): string`(지금 `fmtMs` 몸통 그대로 — 길이 글자), `export function fmtMs(ms: number): string` = `ms >= 60000 ? ko.print.fmt.capSec : fmtDurMs(ms)`(응답 시간 글자), `export function fmtMeanMs(ms: number, capped: boolean): string` = `capped && ms < 60000 ? ko.print.fmt.orMore(fmtMs(ms)) : fmtMs(ms)`.
- `ko.print.fmt.capSec = "60초 이상"`, `ko.print.fmt.orMore = (s: string) => \`${s} 이상\``.
- `StepRow.stats?: LatencyStats`(선택 칸 — `StepRow` 리터럴을 가진 기존 fixture가 깨지지 않게; `buildStepTable`이 그 스텝 `ReportStep.stats`를 싣는다 — Task 5·6도 쓴다).
- `stepStatus(row: StepRow, criteria: Criteria | null | undefined, verdictRows: CriterionResult[] | null): RowStatus` — 두 호출 지점이 `report.verdict?.criteria ?? null`을 넘긴다.
- `stepStatus.ts`: `export function isLatencyMetric(metric: string): boolean` = `metric === "mean_ms" || metric === "max_ms" || /^p\d+(\.\d+)?_ms$/.test(metric)`; `export function statUs(stats: LatencyStats, metric: string): { us: number; cut: boolean } | null` — `mean_ms`(`cut` = `stats.capped`)·`max_ms`·`p50_ms`·`p90_ms`·`p95_ms`·`p99_ms`(`cut` = `us >= CAP_US`), 그 밖은 `null`.

**「느림」 규칙(R-B10 — 이 문단이 정본):**
- ① 스텝 기준(`criteria.step_criteria` 중 `target === row.stepId`·`op === "max"`·`isLatencyMetric(metric)`): `verdictRows !== null`이면 `verdictRows` 중 `target === row.stepId`·`direction === "max"`·`isLatencyMetric(metric)`·`passed === false`·`no_sample !== true`인 행이 하나라도 있으면 느림. `verdictRows === null`이면 그 기준마다 `statUs(row.stats, metric)`를 구해(`row.stats` 없음·`null`이면 건너뜀) `cut || us > Math.round(threshold * 1000)`이면 느림.
- ② run 기준 빌려 쓰기: `(metric, threshold)` 목록 = `max_p50_ms → p50_ms`, `max_p95_ms → p95_ms`, `max_p99_ms → p99_ms`, `max_mean_ms → mean_ms`, `max_max_ms → max_ms`, `max_percentiles_ms` 중 `percentile`이 50·90·95·99인 것 → `p{N}_ms`. 같은 스텝에 같은 지표의 스텝 기준(①의 조건)이 있으면 그 지표는 건너뛴다. `row.stats`가 없으면 ② 전체를 건너뛴다. 느림 = `cut || us > Math.round(threshold * 1000)`.
- 오류율·`hasErrors`·`uncounted`·`unknown` 태그, `stepThresholds`(속도 구간·요약 문장이 쓴다), `rankRows`는 그대로.

- [ ] **Step 1: 실패하는 테스트**
  - `format`: `fmtMs(60000)`·`fmtMs(60030)` → 「60초 이상」; `fmtMs(59998)` → 「60.0초」(지금 식 그대로); `fmtMs(59998.207)` → 「60.0초」; `fmtDurMs(120000)` → 「120.0초」; `fmtMeanMs(30000, true)` → 「30.0초 이상」; `fmtMeanMs(30000, false)` → 「30.0초」; `fmtMeanMs(60030, true)` → 「60초 이상」(「이상」 한 번).
  - `conditions`: think time `{ min_ms: 60000, max_ms: 120000 }`인 프로필의 대기 줄에 「60초 이상」이 없고 대기 줄 글자 == `ko.print.conditions`의 `think(fmtDurMs(60000), fmtDurMs(120000))`(키 경로는 `conditions.ts` 머리의 별칭을 따른다).
  - `SetupPrintTable`: 준비 스텝 `p95Ms: 60030`·`maxMs: 60030`·`p50Ms: 12` → 그 두 칸 글자 == `ko.report.stats.capped`(이 표는 단위가 ms라 「≥ 60,000」), 12는 「12」, `null`은 지금처럼 「–」.
  - `stepTable`: `ReportStep.stats`가 있는 스텝 → `row.stats`가 그 객체, 없으면 `undefined`.
  - `stepStatus`(표 테스트 — spec R-B10 acceptance 그대로): 스텝 `mean_ms` 기준의 판정 행 `passed: false` → `slow` · 스텝 `p75_ms` 기준의 판정 행 `passed: false` → `slow` · 같은 판정 행이 `no_sample: true` → `slow` 아님 · run `max_mean_ms: 3000` + `stats.mean_us: 3_000_400` → `slow`, `3_000_000` → 아님 · run `max_percentiles_ms: [{ percentile: 90, max_ms: 70000 }]` + `stats.p90_us: 60_000_000` → `slow`(60,000,000 ≤ 70,000,000이라 값 비교로는 통과 — 잘림만이 느림을 만든다) · run `max_percentiles_ms: [{ percentile: 75, max_ms: 1 }]`만 → `slow` 아님 · `verdictRows: null`(중단 run) + 스텝 `mean_ms` 기준 100 + `mean_us: 100_001` → `slow` · `verdictRows: null` + 스텝 `p75_ms` 기준만 → `slow` 아님 · run `max_p95_ms: 200` + `stats` 없음 → `slow` 아님(빌려 쓰기 건너뜀) · 스텝 `p95_ms` 기준(판정 행 통과)이 있는 스텝은 run `max_p95_ms`를 넘겨도 `slow` 아님(스텝 기준 우선) · 기준 없음 → `["ok"]`. 기존 케이스 중 `p95Ms`만으로 `slow`를 기대하던 것은 fixture에 `stats`(`p95_us` = ms × 1000)를 넣어 같은 결과가 되게 고친다.
  - 문구: `grep -c "응답시간" ui/src/i18n/ko.ts` → 4(인쇄 밖 줄 83·2132·2141·2148만 — 줄 번호는 편집으로 밀릴 수 있어 개수로 판정). 테스트로도: `JSON.stringify(ko.print, (_, v) => (typeof v === "function" ? undefined : v))`에 「응답시간」이 없다(함수 값은 대표 인자로 따로 — `ko.print.sentence`의 `fallback("1ms")`, 판정 이름 `percentileName(95)`에 「응답 시간」).
- [ ] **Step 2: 실패 확인** — `cd ui && pnpm test print/__tests__/format` · `pnpm test conditions` · `pnpm test stepStatus` · `pnpm test stepTable` · `pnpm test SetupPrintTable` FAIL.
- [ ] **Step 3: 구현** — Interfaces·규칙대로. `SetupPrintTable.tsx`의 `ms` 도우미가 60,000 이상이면 `ko.report.stats.capped`(spec R-B9는 `fmtMs` 한 곳으로 준비 스텝 표까지 고쳐진다고 적었지만 그 표는 `fmtCount`를 쓴다). `conditions.ts`의 think 줄만 `fmtDurMs`로(다른 `fmtMs` 호출 여섯 줄은 응답 시간이라 그대로 — claims 명령으로 확인). `ko.print` 안 「응답시간」 17줄을 「응답 시간」으로(`python3` 스플라이스가 아니라 Edit — 줄마다). 그 글자를 박은 테스트 기대값을 같이 고친다.
- [ ] **Step 4: 통과 확인** — `pnpm test` 전체 PASS, `grep -c "응답시간" ui/src/i18n/ko.ts` → `4`.
- [ ] **Step 5: 되돌려 확인** — ① `conditions.ts`를 `fmtMs`로 되돌리면 think 테스트 RED ② ②의 느림 식에서 `cut ||`를 지우면 `max_ms: 70000` + `p90_us: 60_000_000` 케이스 RED ③ 「스텝 기준 우선」 건너뛰기를 지우면 그 케이스 RED — 각각 원복.
- [ ] **Step 6: 게이트·커밋** — UI 게이트. `feat(ui): 인쇄 응답 시간 글자에 「60초 이상」, 「응답 시간」 띄어쓰기, 단계 「느림」을 평균·최대·백분위 기준까지`.

### Task 5: 인쇄 새 절 「단계별 응답 시간 통계」 (R-B8, 목업 4번)

**Files:**
- Create: `ui/src/print/statsTable.ts`, `ui/src/print/components/StatsPrintTable.tsx`
- Modify: `ui/src/print/buildPrintDoc.ts`(`PrintDoc.stats`·`SectionNo.stats`·`sectionNumbers`·`MEASURE_IDS`·`standardBlocks`), `ui/src/print/PrintDocument.tsx`(`MeasureSheet`·`PageBody`의 `"stats"` 갈래, `AtomicContent`의 `"stats:note"`), 인쇄 CSS(다른 표가 쓰는 파일 — `grep -rn "p-setup" ui/src --include="*.css"`로 찾는다), `ui/src/i18n/ko.ts`
- Test: `ui/src/print/__tests__/statsTable.test.ts`, `buildPrintDoc.test.ts`, `StatsPrintTable.test.tsx`, `PrintDocument.test.tsx`

**Interfaces:**
- Consumes: Task 4 `StepRow.stats`, `hasLatency`·`stepCounts`(`ui/src/report/hasLatency`), `ko.report.stats.capped`.
- Produces:
  - `statsTable.ts`: `export function printStatText(us: number, round: "floor" | "round"): string` — `us >= CAP_US` → `ko.report.stats.capped`; `us < 1000` → `ko.print.stats.us(us)`(`"350µs"`); 그 밖 → `(round === "floor" ? Math.floor(us / 1000) : Math.round(us / 1000)).toLocaleString("en-US")`.
  - `export type StatsRow = { label: string; cells: string[] }`(`cells` 여덟 칸 — 최소·평균·p50·p90·p95·p99·최대·표준편차; 평균·표준편차만 `"round"`), `export type StatsModel = { rows: StatsRow[]; total: StatsRow; caption: string; cappedNote: boolean }`.
  - `export function buildStatsModel(a: { rows: StepRow[]; summary: Report["summary"]; sample: ReportSampleName; hasTime: boolean }): StatsModel | null` — 행 이름 = `` `${row.no} ${row.name}` ``(부록과 같은 글자), 순서 = `rows`. 스텝에 `stats`가 없거나 `hasLatency({ count, errors: errorCount, notSent }, sample)`이 거짓이면 여덟 칸 모두 `ko.print.fmt.noTarget`(「–」). `total` = 「모든 단계」 + `summary.stats`(없거나 `hasTime` 거짓이면 「–」 여덟 칸). `cappedNote` = 그려진 칸 중 하나라도 60초 칸 글자이거나 그려진 행의 `stats.capped`가 참. **모든 스텝 행과 `total`이 「–」이면 `null`.**
  - `PrintDoc.stats: StatsModel | null`, `SectionNo.stats: string | null`, `sectionNumbers(a: { stats: boolean; setup: boolean; speed: boolean })` — 3부터 `stats → setup → speed → chart → conditions → glossary` 순서로 있는 절만 센다.
  - 블록: 표 id `"stats"`, `MEASURE_IDS.statsTitle = "stats:title"`·`statsHeader = "stats:header"`·`statsRowId = (i: number) => \`stats:row:${i}\``(마지막 인덱스 = 「모든 단계」 행 → `rowsMm.length === rows.length + 1`), 안내 `atomic` `"stats:note"`(`cappedNote`일 때만). 자리: 「2. 단계별 결과」 묶음(표·범례·콜아웃·`notes:*`) 바로 뒤, `setup` 앞. 요약판(`summaryBlocks`)에는 없다.
  - `ko.print.section.stats = (n: number) => \`${n}. 단계별 응답 시간 통계\``; `ko.print.stats = { caption: (sample: string) => \`${sample} 기준 · 단위 ms (1ms 미만은 µs)\`, samplePassed: "통과한 요청", sampleAll: "모든 요청", cols: ["단계", "최소", "평균", "p50", "p90", "p95", "p99", "최대", "표준편차"], total: "모든 단계", us: (n: number) => \`${n}µs\`, cappedNote: "「≥ 60,000」 = 60초를 넘긴 응답이 있어 실제 값은 더 큽니다(그 단계의 평균·표준편차도 실제보다 작게 나온 값입니다)." }`. 이어지는 쪽 제목은 준비 스텝 표가 쓰는 `continued`(「 (이어짐)」) 키를 그대로 쓴다(새 키 없음).

- [ ] **Step 1: 실패하는 테스트**
  - `printStatText`: `(350, "floor")` → 「350µs」; `(999, "round")` → 「999µs」; `(1499, "floor")` → 「1」; `(1500, "round")` → 「2」; `(1_840_000, "floor")` → 「1,840」; `(2_410_880, "round")` → 「2,411」; `(60_000_000, "floor")` → `ko.report.stats.capped`.
  - `buildStatsModel`: 스텝 셋 — A(`stats` min 31_007·mean 52_118·p50 47_039·p90 71_039·p95 88_063·p99 140_031·max 402_175·stdev 19_204) → `cells == ["31","52","47","71","88","140","402","19"]`; B(`stats` max 60_000_000·`capped: true`) → 최대 칸 60초 칸 글자·`cappedNote` 참; C(통과한 요청 없음 — `sample "passed"`, `count == errorCount`) → 「–」 여덟; `total` 이름 「모든 단계」; `caption` == `ko.print.stats.caption("통과한 요청")`, `sample "all"` → 「모든 요청」. 60초 칸이 없으면 `cappedNote` 거짓. 평균만 하한인 경우(`stats.capped: true`, 모든 칸 < 60초) → `cappedNote` 참. 모든 스텝 `stats` 없음 + `summary.stats` 없음 → `null`.
  - `sectionNumbers`: `{stats: true, setup: false, speed: false}` → `stats "3. 단계별 응답 시간 통계"`·chart `4.`·conditions `5.`·glossary `6.`; `{true, true, false}` → setup `4.`·chart `5.`; `{true, false, true}` → speed `4.`·chart `5.`; `{true, true, true}` → setup `4.`·speed `5.`·chart `6.`·conditions `7.`·glossary `8.`; `{stats: false, setup: true, speed: true}` → `stats: null`·setup `3.`·speed `4.`·chart `5.`(이 슬라이스 전과 같음).
  - `standardBlocks`: `stats`가 있으면 id 순서에서 `"stats"`가 `"table"`·`"legend:full"`(·콜아웃·`notes:*`) 뒤, `"setup"`·`"speed"`·`"chart"` 앞; `cappedNote`면 바로 뒤 `"stats:note"`; `stats === null`이면 둘 다 없음; `summaryBlocks`(모든 단계 `l`)에는 없음; `rowsMm.length === 스텝 수 + 1`.
  - 컴포넌트: 머리 아홉 칸 글자 == `ko.print.stats.cols`, 캡션, 「모든 단계」 행이 마지막, `from`/`to`로 자른 조각이 그 행들만 그림.
  - `PrintDocument`(쪽 그리기 경로): `stats`가 있는 문서에 제목 「3. 단계별 응답 시간 통계」와 「모든 단계」 글자가 `.p-page` 안에 있고, 응답 시간이 없는 run 문서에는 없다; `cappedNote` 문서에 안내 글.
- [ ] **Step 2: 실패 확인** — `cd ui && pnpm test statsTable` · `pnpm test buildPrintDoc` · `pnpm test StatsPrintTable` · `pnpm test PrintDocument` FAIL.
- [ ] **Step 3: 구현** — 준비 스텝 표(`SetupPrintTable.tsx` — 제목·머리·행을 `data-measure`로 재는 `table` 블록)를 본으로 삼는다. 숫자 칸은 오른쪽 맞춤·`white-space: nowrap`, 단계 이름 칸은 다른 표의 이름 칸 규칙(줄 수 제한 + `break-all`), 머리 칸 `word-break: keep-all`. `buildPrintDoc`에서 `buildStatsModel({ rows: table.rows, summary: report.summary, sample, hasTime })`, `sectionNumbers({ stats: stats !== null, … })`. `MeasureSheet`·`PageBody` 둘 다 `"stats"` 갈래(빠뜨리면 단계별 결과 표로 그려진다 — 인쇄 함정 노트).
- [ ] **Step 4: 통과 확인** — 위 + `pnpm test` 전체(절 번호를 박은 기존 인쇄 테스트·스냅샷은 `stats`가 있는 fixture에서 한 칸씩 밀린다 — 밀린 번호가 위 `sectionNumbers` 표와 맞는지 보고 고친다).
- [ ] **Step 5: 되돌려 확인** — ① `PageBody`의 `"stats"` 갈래를 지우면 쪽 렌더 단언 RED ② `buildStatsModel`이 `hasLatency`를 보지 않으면 C 스텝 「–」 단언 RED(C fixture에 `stats`를 넣어 둔다 — 통과한 요청이 없는데 `stats`가 실린 리포트는 서버가 만들지 않지만 표본 전환 리포트에서 가능) — 각각 원복.
- [ ] **Step 6: 게이트·커밋** — UI 게이트. `feat(ui): 인쇄 보고서에 「단계별 응답 시간 통계」 절`.

### Task 6: 비교 인쇄 — 핵심 지표 p90·최대, 「단계별 평균 응답 시간 변화」 (R-B11, R-B12, 목업 6번)

**Files:**
- Modify: `ui/src/print/compare/change.ts`, `ui/src/print/compare/dumbbell.ts`, `ui/src/print/compare/buildCompareDoc.ts`, `ui/src/print/compare/tables.tsx`, `ui/src/print/compare/CompareDocument.tsx`, `ui/src/print/compare/components/KpiCompareTable.tsx`·`DumbbellTable.tsx`, `ui/src/print/verdict.ts`(`kpiCards` 평균 카드), 인쇄 CSS(`print.css` — `cmp:dbm` 블록 간격), `ui/src/i18n/ko.ts`
- Test: `ui/src/print/compare/__tests__/change.test.ts`·`dumbbell.test.ts`·`buildCompareDoc.test.ts`·`headline.test.ts`·`CompareDocument.test.tsx`·`dumbbellTable.test.tsx`, `ui/src/print/__tests__/verdict.test.ts`

**Interfaces:**
- Consumes: Task 4 `fmtMs`(60초 이상)·`fmtMeanMs`·`StepRow.stats`.
- Produces:
  - `change.ts`: `MetricKey`에 `"p90_ms" | "max_ms"`. `Spec.value: (s: Report["summary"]) => number | null`, `Spec.standardOnly?: true`, `Spec.cut?: (s: Report["summary"]) => boolean` — **응답 시간 행 다섯 모두**: `p90_ms`·`max_ms`는 그 `us >= CAP_US`, `p99_ms`·`p95_ms`는 정수 칸 `>= 60000`(spec §1.1 「정수 ms ≥ 60,000 ⇔ 60초 칸」), `mean_ms`는 `s.stats?.capped ?? s.mean_ms >= 60000`. 기존 세 행의 값 출처(정수 칸)는 그대로. `SPECS` 순서 = `error_rate, p99_ms, p95_ms, p90_ms, mean_ms, max_ms, rps, count`; 새 두 행은 `dir: "lower"`·`floor: FLOOR.ms`·`major: false`·`kind: "ms"`·`standardOnly: true`, 값 = `s.stats ? s.stats.p90_us / 1000 : null`(`max_us` 같음). `MetricRow.standardOnly: boolean`.
  - `export function cutDirection(before: number, after: number, beforeCut: boolean, afterCut: boolean): "worse" | "better" | null` — 한쪽만 잘림이고 방향이 확정일 때만(`afterCut && after >= before` → `"worse"`, `beforeCut && before >= after` → `"better"`), 그 밖(둘 다 잘림 포함)은 `null`. 호출 전제: 적어도 한쪽이 잘림.
  - `MetricRow.before`·`after`는 `number` 그대로 — 값이 `null`이면 0을 싣고 막대(`barBefore`·`barAfter`)도 0.
  - 분류: 새 두 행은 어느 쪽이든 값 `null` → `cls: "none"`, 그쪽 글자 `c.metric.notMeasured`. 응답 시간 행 다섯 모두 잘림이 있으면 `cutDirection` — `"worse"`/`"better"` → 그 `cls`, `arrow` ▲/▼, **`pct: null`·`isNew: false`**(하한값으로 낸 퍼센트를 싣지 않는다 — `headline.ts` `topRow`가 `pct`가 가장 큰 주요 행을 요약 첫 문장으로 고른다), `changeText: ko.print.cmp.change.cutNoPct`(= 「변화율 계산 불가」 — 빈 글자면 요약 문장 `L.biggest`가 「… → 60초 이상 ().」처럼 빈 괄호를 찍는다); `null` → `cls: "none"`·`pct: null`. 잘림 없음 → 지금 식.
  - 평균 행 글자: 그쪽 `summary.stats?.capped`이고 글자가 `notMeasured`가 아니면 `fmtMeanMs(mean_ms, true)`.
  - `dumbbell.ts`: `export type DbMetric = "p95" | "mean"`, `buildDumbbell(before, after, pairs, metric: DbMetric = "p95")`. `"mean"`: 값 = 그 단계 `row.stats ? row.stats.mean_us / 1000 : null`(그 밖의 「잰 적 없음」 조건은 p95와 같음), 잘림 = `row.stats.capped`, 기준선 = 양쪽 `max_mean_ms`가 같고 양쪽에 스텝 `mean_ms` 기준이 없을 때. 기준선은 p95 갈래와 같이 `<= axisMaxMs`일 때만. 잘린 쪽 값 글자에 `ko.print.fmt.orMore`(이미 「60초 이상」이면 그대로), 잘림이 있으면 퍼센트 괄호 없음, 분류는 `cutDirection`(`"worse"` → `cls "worse"`, `"better"` → `"better"`, `null` → `cls: null`·`dir: 0`·`wordText: ""`·모양은 두 점 사이가 `DB.MERGE` 미만이면 `"merged"` 아니면 `"dots"`). `"p95"` 갈래도 같은 잘림 규칙(잘림 = `row.p95Ms >= 60000`)을 쓰고, 60초 칸 값이 없는 단계의 결과는 이 task 전과 글자·모양이 같다. 이제 「양쪽 값이 다 있는데 `cls: null`」인 행이 생긴다(전에는 `cls: null` = 한쪽 값 없음뿐) — `DumbbellTable.tsx`의 색·낱말 갈래가 `cls`로 고르는 곳을 읽어 그 행을 「비슷」 색이 아닌 중립(낱말 없음)으로 그리게 하고 `dumbbellTable.test.tsx`에 그 행 렌더 케이스를 둔다.
  - `buildCompareDoc.ts`: `CompareDoc.meanDumbbell: DumbbellModel`; `CmpTableId`에 `"cmp:dbm"`; 표준판 블록 = `cmp:kpi:bars` 자리에 **`cmp:kpi:bars:std`**, `cmp:db:legend` 바로 뒤에 `tableBlock("cmp:dbm", …)`·`atom("cmp:dbm:legend")`; 요약판 블록 목록 무변경. `SectionNos.meanDumbbell: string | null`, `STANDARD_SECTIONS` = `[overview, kpi, dumbbell, meanDumbbell, errors, overlay, speed, cond, issues]`(있음 조건 = `present.steps`).
  - `KpiCompareTable`: 표준판 블록만 `standardOnly` 행을 그린다(요약판 두 블록은 `!r.standardOnly`만).
  - `verdict.ts` `kpiCards`: 평균 카드 값 = `opts.latency ? fmtMeanMs(summary.mean_ms, summary.stats?.capped ?? false) : noTarget`.
  - `ko.print.cmp.metric`: `p90: "90% 응답 시간"`, `p90Hint: "느린 쪽 10% 요청을 뺀 나머지가 이 시간 안에 끝난 값"`, `max: "최대 응답 시간"`, `maxHint: "가장 오래 걸린 요청 하나의 응답 시간"`; `ko.print.cmp.view.titles.meanDumbbell: "단계별 평균 응답 시간 변화"`; `ko.print.cmp.change.cutNoPct: "변화율 계산 불가"`. 덤벨 제목·범례·접근성 글자에 「95%」가 박혀 있으면 지표 인자를 받는 함수 키로 바꾼다(p95 글자 불변).

- [ ] **Step 1: 실패하는 테스트**
  - `change`: `metricRows(…).map(r => r.key)` == `["error_rate","p99_ms","p95_ms","p90_ms","mean_ms","max_ms","rps","count"]`; `standardOnly`가 참인 것은 `p90_ms`·`max_ms`뿐이고 둘 다 `major: false`; 양쪽 `stats` p90 98_000 → 104_000 → `cls "worse"`·`beforeText "98ms"`·`afterText "104ms"`(`fmtMs(98)`·`fmtMs(104)`가 둘 다 「0.10초」라 `valueTexts`가 `fmtMsExact`로 바꾼다 — 목업 6번의 「98ms → 0.10초」는 지금 글자 규칙과 어긋난 예시); p99 정수 `60030` ↔ `60030` → `cls "none"`·양쪽 글자 「60초 이상」; `stats.capped`인 평균 30000 → 40000(안 잘림) → `cls "none"`(방향 모름), 1000 → `capped` 30000 → `"worse"`·`changeText` == `ko.print.cmp.change.cutNoPct`·`pct null`; 한쪽 `stats` 없음 → 두 행 `cls "none"`·그쪽 글자 `notMeasured`; 최대 1_840_000 → 60_000_000 → `afterText "60초 이상"`·`cls "worse"`·`arrow "▲"`·`changeText` == `ko.print.cmp.change.cutNoPct`·`pct null`; 최대 60_000_000 → 1_840_000 → `cls "better"`·`arrow "▼"`; 둘 다 60_000_000 → `cls "none"`; `summary.stats.capped`인 `mean_ms: 30000` → 평균 행 `afterText "30.0초 이상"`(그쪽만).
  - 요약 문장(`headline.test.ts`의 `cmpSummaryLines`): p99 정수 1840 → 60030(잘림·`worse`)이고 다른 주요 행은 「비슷」인 짝 → 어느 줄에도 「()」와 「%」가 없고, p99를 든 줄이 있으면 「변화율 계산 불가」가 들어 있다. 잘린 p99(`pct null`)와 평균 +50%(`worse`)가 함께면 `id: 2` 줄(변화가 가장 큰 지표를 드는 문장 — 1번 줄은 판정 문장)의 지표는 평균이다(`topRow`가 `pct` 없는 행을 퍼센트로 줄 세우지 않는다 — `topRow`는 `(y.r.pct ?? 0)`으로 줄 세우므로 `pct: null`이면 숫자 있는 행 뒤다; 잘린 행은 `isNew: false`로 둔다 — 「새로 생김」이 맨 위 규칙에 걸리지 않게).
  - `headline`: 새 두 행이 `worse`여도 머리 문장 건수·글자가 두 행이 없을 때와 같다(같은 요약 값에 `stats`만 더한 fixture로 앞뒤 비교).
  - `dumbbell`: `buildDumbbell(b, a, pairs)`(인자 생략)의 결과가 `buildDumbbell(b, a, pairs, "p95")`와 같다(`toEqual`); p95 양쪽 `60030` → `cls null`·퍼센트 괄호 없음·글자 「60초 이상」; 측정 id: 평균 덤벨 표의 `data-measure`가 `cmp:dbm:title`·`cmp:dbm:header`·`cmp:dbm:row:0`이고 `cmp:db:`로 시작하는 것이 없다(`dumbbellTable.test.tsx`); `"mean"` — 단계 `mean_us` 61_000 → 83_000 → `beforeMs 61`·`afterMs 83`·`cls "worse"`·`shape`가 `"arrow"` 또는 `"tri"`; `stats` 없는 쪽 → 그쪽 `null`·`shape "single"`; 잘린 평균(`capped`, 30_007_796) vs 40_000_000 → `cls null`·`shape "dots"`·`dir 0`·잘린 쪽 글자에 「 이상」·퍼센트 괄호 없음; 잘린 평균 30_007_796(이후) vs 1_000_000(이전) → `cls "worse"`; 기준선: 양쪽 `max_mean_ms: 100` → `baseline.ms 100`, 스텝 `mean_ms` 기준이 있으면 `null`, `max_p95_ms`만 있으면 `null`.
  - `buildCompareDoc`: `sectionNo("standard", { steps: true, speed: true })` → dumbbell `"3"`·meanDumbbell `"4"`·errors `"5"`·overlay `"6"`·speed `"7"`·cond `"8"`·issues `"9"`; `steps: false` → meanDumbbell `null`; `"summary"` → 지금과 같음. `compareStandardBlocks` id에 `cmp:kpi:bars:std`·`cmp:dbm`·`cmp:dbm:legend`가 있고 `cmp:kpi:bars`가 없다; `compareSummaryBlocks`(단계 0–5)의 id 목록이 이 task 전과 같다(목록을 테스트에 적는다).
  - `CompareDocument` RTL: 표준판에 제목 「단계별 평균 응답 시간 변화」·핵심 지표 표에 「90% 응답 시간」·「최대 응답 시간」 행; 요약판에는 그 두 행이 없다.
  - `verdict`: `summary.stats.capped` + `mean_ms: 30000` → 평균 카드 값 「30.0초 이상」, `capped: false` → 「30.0초」.
- [ ] **Step 2: 실패 확인** — `cd ui && pnpm test compare/__tests__/change` · `pnpm test dumbbell` · `pnpm test buildCompareDoc` · `pnpm test headline` · `pnpm test CompareDocument` · `pnpm test print/__tests__/verdict` FAIL.
- [ ] **Step 3: 구현** — Interfaces대로. 표 정의는 `tables.tsx` `CMP_TABLES`에 `"cmp:dbm"` 하나(측정 시트와 쪽 렌더가 같은 정의, `no: (n) => n.meanDumbbell ?? ""`). **`DumbbellTable.tsx`는 지금 `const IDS = tableIds("cmp:db")`를 박아 두었다 — `DumbbellTitle`·`DumbbellTable`이 표 id(`CmpTableId`)와 제목을 인자로 받게 바꾼다**(안 바꾸면 평균 덤벨이 95% 덤벨과 같은 `data-measure` id를 써 높이가 0으로 읽히고 쪽 나누기가 틀린다). `blockClass`는 `cmp:dbm`·`cmp:dbm:legend`를 `cmp:db`·`cmp:db:legend`와 같은 클래스로 보낸다(`p-cmp-b--dbm`이라는 CSS는 없다). `cmp:kpi:bars:std`·`cmp:dbm:legend`는 `CompareDocument.tsx` `AtomicContent`에 갈래를 더한다(`blockClass`의 `split(":")[1]` 규칙으로 `cmp:kpi:bars:std`는 `kpi` 갈래).
- [ ] **Step 4: 통과 확인** — 위 + `pnpm test` 전체.
- [ ] **Step 5: 되돌려 확인** — ① 새 두 행을 `major: true`로 바꾸면 `headline` 앞뒤 비교 RED ② 요약판 블록이 `standardOnly` 행을 거르지 않으면 요약판 RTL RED ③-1 잘린 행에 `pct`를 그대로 실으면 요약 문장 「첫 문장은 평균」 단언 RED ③ `"mean"` 덤벨이 `capped`를 무시하면 「 이상」·`cls null` 단언 RED ④ `DumbbellTable`의 표 id를 `"cmp:db"`로 박으면 측정 id 단언 RED — 각각 원복.
- [ ] **Step 6: 게이트·커밋** — UI 게이트. `feat(ui): 비교 인쇄에 90%·최대 응답 시간과 「단계별 평균 응답 시간 변화」`.

### Task 7: 라이브 검증 (US5–US9, 극단값, 목업 대조)

`/live-verify`로 이 워크트리 바이너리(`cargo build -p handicap-worker` + `./target/debug/controller`, `just ui-build` 뒤 `--ui-dir ui/dist`, 포트는 `lsof`로 빈 것을 확인) + keep-alive 응답기. 결과는 `.superpowers/sdd/4b-live.md`. run 묶음: **R1** 응답기 둘(지연 20ms·200ms) 스텝 둘·VU 4·60초 · **R2** R1과 같은 시나리오에 지연을 바꾼 run(비교 짝) · **R3** 60초 칸 run(응답기 61,000ms + `http_timeout_seconds: 90` + VU 2 + 70초, 빠른 스텝 하나 함께) · **R4** 스텝 50개(이름 하나 300자) 짧은 run · **R5** 빠른 스텝 + 닫힌 포트 스텝(통과한 요청이 없는 스텝 — VU 2 + `think_time` 100ms로 포트 고갈 방지) · **R6** 1ms 미만 응답(릴리즈 워커 `cargo build --release -p handicap-worker` + 지연 없는 응답기 — roadmap §B97 (2)).

- [ ] **Step 1: US5** — R3 리포트 JSON에서 60초 칸 스텝 `stats.min_us == 60000000` 확인 후, 리포트 「응답 시간 통계 더 보기」의 그 스텝 최소 칸 글자 == `ko.report.stats.capped`.
- [ ] **Step 2: US6** — R1·R3·R5·R6의 `GET /api/runs/{id}/report.csv`·`report.xlsx`. CSV 머리 글자 그대로, 아무 스텝 한 줄의 여덟 시간 칸이 같은 run 리포트 JSON `stats` µs의 `ms3` 글자와 같다(스크립트로 전 스텝 대조), R3 60초 칸 스텝 `max_ms` `60000.000`·`capped` `true`, R5 통과 없는 스텝 빈 칸 아홉, R6 1ms 미만 값이 `0.xxx`, `*` 줄 == `summary.stats`. XLSX는 `python3 -c`(openpyxl이 없으면 `unzip -p … xl/worksheets/sheet1.xml`)로 Summary 행 이름 순서·Steps 열·Windows `mean_ms`·`capped` 열 확인. 유지 구간(`steady`) run 하나로 Other basis 시트가 같은 모양인지.
- [ ] **Step 3: US8** — R1↔R2, R1↔R3, R1↔R5 비교 화면: 요약 열 행 이름·순서, 시간 칸 글자가 리포트 화면 「응답 시간 통계 더 보기」의 같은 run 글자와 같다(run 하나를 골라 여덟 칸 대조), R3 쪽 「≥ 60,000」 칸의 변화율 「—」 + 색·`title`, 「응답 시간 통계 더 보기」 접힘 → 펼침(스텝 × 5행). 비교 CSV의 `delta_pct`와 화면 칩의 % 글자가 같은 수(행 셋 골라 `(csv × 100).toFixed(1)` 대조), 잘림 줄 `capped`. 비교 XLSX 「Step stats」 시트. 극단값: R4끼리 비교(스텝 50개 펼침 = 250행)·폭 1440·768·390에서 `document.documentElement.scrollWidth <= innerWidth` 또는 표 자체 가로 스크롤 안에 머무는지, 이름 300자 칸이 숫자 칸을 밀어내지 않는지 rect로 기록.
- [ ] **Step 4: US7** — R1·R3·R4·R5·R6 「인쇄용 보기」 표준판: 「3. 단계별 응답 시간 통계」 절이 단계별 결과 바로 뒤, 뒤 절 번호가 하나씩 밀림, 칸 글자가 리포트 화면 통계와 같은 숫자(쉼표·「µs」 붙여 쓰기만 다름), R3에서 「≥ 60,000」·표 아래 안내·단계별 결과 「95% 응답」 칸 「60초 이상」·핵심 지표 카드, R5 통과 없는 단계 「–」, R6 「350µs」 꼴. 응답 시간이 하나도 없는 run(R5를 닫힌 포트 스텝만으로 한 변형)에는 절이 없고 번호가 안 밀린다. R4(50단계)에서 표가 쪽을 넘길 때 행 잘림 없음·머리 반복, 쪽별 rect가 본문 한계(273mm) 안, 헤드리스 Chrome `--print-to-pdf` + `pdfinfo` Pages == 화면 `.p-page` 수. 넓은 글꼴 흉내(`letter-spacing: 0.12em` 주입)로 숫자 칸 「≥ 60,000」·「2,411」이 한 줄(`getClientRects().length === 1`)인지. 요약판에는 절이 없다. 「느림」: 스텝 `mean_ms` 기준을 일부러 넘긴 run 하나로 그 단계에 ▲ 느림 표지.
- [ ] **Step 5: US9** — R1↔R2, R1↔R3 비교 인쇄 표준판: 핵심 지표 표 행 순서(오류율·99%·95%·90%·평균·최대·처리량·요청 수), R3 쪽 최대 「60초 이상」·「나빠짐」, 「4. 단계별 평균 응답 시간 변화」 절(뒤 절 번호 밀림)·그림이 95% 덤벨과 같은 모양, 잘린 평균 글자 「 이상」. 핵심 지표 표의 「▲ 변화율 계산 불가」 칸이 한 줄인지(`getClientRects().length === 1`, 넓은 글꼴 흉내 포함 — 두 줄이면 칸 폭·글자를 고친다). 요약판(한 쪽)이 이 슬라이스 전과 같은 블록·한 쪽(PDF Pages == 1)이고 p90·최대 행이 없다. 인쇄·비교 인쇄 화면 글자에 「응답시간」 0건(`document.body.innerText.includes("응답시간") === false`).
- [ ] **Step 6: 목업 대조** — 목업 2번 표·4번·6번·7번과 스크린샷 대조(행 순서·`└` 들여쓰기·인쇄 표 열 순서·숫자 오른쪽 맞춤·덤벨 절 자리). 어긋나면 고치고(`fix(ui): …`) 실측을 기록. 목업과 일부러 다른 점(아래 「§B에 옮길 판단」)은 표로 적는다.
- [ ] **Step 7: 실제 응답 스키마** — R1·R3·R5·R6 리포트 JSON을 저장해 `ui/src/api/__tests__/`의 임시 테스트로 `ReportSchema.safeParse` 통과 확인 후 임시 테스트를 지운다(와이어는 안 바뀌었지만 `min_us` 값이 바뀌는 run 포함 — S-D 갭).

## §B에 옮길 판단 (finish-slice가 roadmap §B 「(0) 확인 대기」로 — 승인 아님)

- (1) 비교 화면 요약 행 이름: 새 다섯 행만 한글(「평균·최소·최대·표준편차·p90」), 기존 `p50_ms`·`p95_ms`·`p99_ms`·`rps`·`error_rate`는 지금 글자(목업 2번 그대로). 비용: 한 표에 영문 키와 한글이 섞인다. 해소: 열 행 모두 한글 이름으로.
- (2) spec R-B9 정정: `fmtMs` 한 곳으로는 안 된다 — think time(「측정 조건」, 비교 인쇄 조건 표도 같은 길)은 길이 글자 `fmtDurMs`로 갈랐고, 준비 스텝 인쇄 표는 `fmtCount`를 써서 따로 「≥ 60,000」을 넣었다.
- (3) 인쇄 「느림」: `stats`가 없는 단계(옛 run)는 run 기준을 빌려 쓰지 않는다(spec R-B10) — 옛 run 인쇄에서 「느림」이 사라질 수 있다(사용자 결정 1).
- (4) 비교 인쇄의 잘림 규칙을 기존 행(99%·95%·평균)과 95% 덤벨에도 넣었다(spec R-B11·R-B12는 새 행·평균 덤벨만 적었다) — 같은 표에서 새 행은 「방향 모름」인데 옛 행은 하한값으로 퍼센트를 내는 모순을 막으려고. 값 출처는 정수 칸 그대로.
- (5) XLSX Windows 시트 `capped` 칸은 응답 시간 칸이 있는 창에만 쓰고(값 없음 창은 빈 셀), 식은 spec R-B4보다 넓은 `win.capped || p ≥ 60,000`.
- (9) 비교 인쇄 핵심 지표 표의 잘린 행 변화 칸은 「▲ 변화율 계산 불가」(목업 6번은 최대 행에 「나빠짐」만) — 요약 문장의 빈 괄호를 막으려고 글자를 넣었다.
- (8) 비교 화면 잘림 칩의 접근성 이름: 방향을 모르면 안내 문장만(「동일: …」 금지).
- (6) 비교 화면의 「60초 칸」 안내는 칩 `title`뿐(표 아래 안내 줄 없음 — spec R-B7).
- (7) 인쇄 요약 문장(`sentences.ts`)·순위(`rankRows`)는 여전히 p95 기준.

## 연기 (spec §10 그대로)

비교 인쇄 요약판의 p90·최대, 비교 인쇄 최소·표준편차, 인쇄 스텝 상태의 50·90·95·99 밖 백분위 빌려 쓰기, 준비 스텝 통계 칸·µs, 창 정수 p 칸의 µs화, 인쇄 속도 구간이 평균 기준을 보게, 옛 run 전용 판정 규칙 걷어내기, ④c 전체.
