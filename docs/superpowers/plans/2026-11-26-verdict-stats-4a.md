# verdict-stats ④a — 시간대별 평균 응답 시간 그래프 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 리포트·인쇄·비교 겹쳐 보기에 초별 평균(+정확한 p95) 응답 시간 그래프를 넣고, 리포트 「스텝별로 보기」·인쇄 부록에 스텝마다 작은 평균 그래프를 넣는다.

**Architecture:** 서버가 창마다 표본 수 `n`·평균 `mean_us`·60초 칸 표지 `capped`를, 초마다 모든 스텝을 합친 `latency_by_second`(n·mean_us·p95_us·capped)를 리포트 JSON에 더한다(창 분포를 한 번만 풀어 재사용). 화면은 `bySecond`가 그 초별 값을 읽고, 스텝별 작은 그래프는 창 `mean_us`로 그린다. 작은 그래프·인쇄 선은 순수 함수 `sparkPath` 하나로 좌표를 만든다.

**Tech Stack:** Rust(axum 컨트롤러·hdrhistogram 7.5.4·serde) · TypeScript(React·Recharts·Zod·vitest·RTL) · 인쇄 SVG(mm 단위).

REVIEW-GATE: APPROVED

**Spec:** `docs/superpowers/specs/2026-11-25-verdict-stats-b-design.md` — 이 plan은 ④a(R-A1–R-A9). 요구 ID는 spec 것. 시각 기준 = 목업 `docs/superpowers/specs/2026-11-25-verdict-stats-b-mockups/b-screens.html` **1번**(리포트 그래프·스텝별 격자), **2번 그래프 부분**(겹쳐 보기 체크박스), **3번**(인쇄 응답 시간 그래프), **5번**(인쇄 부록).

US(spec 「사용자 스토리 (US)」 중 ④a): **US1**(평균선+정확한 p95선) · **US2**(스텝별로 보기, 기본 접힘) · **US3**(인쇄 본문 그래프 + 맨 뒤 부록) · **US4**(비교 겹쳐 보기 「평균」).

## Global Constraints

- 와이어(R-A1·R-A2): `ReportWindow`에 `n: u64`(`#[serde(default)]`, 늘 직렬화)·`mean_us: Option<u64>`(`#[serde(default, skip_serializing_if = "Option::is_none")]`)·`capped: bool`(`#[serde(default, skip_serializing_if = "std::ops::Not::not")]`). `ReportJson.latency_by_second: Vec<SecondLatency>`(`#[serde(default, skip_serializing_if = "Vec::is_empty")]`), `#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)] pub struct SecondLatency { ts_second: i64, n: u64, mean_us: Option<u64>, p95_us: Option<u64>, capped: bool }`(Option 둘·`capped`는 창과 같은 skip 규칙). Zod: 창 `n: z.number().int().nonnegative()`(필수, `.default()` 금지)·`mean_us: z.number().int().nonnegative().optional()`·`capped: z.boolean().optional()`, `SecondLatencySchema` `.strict()`(같은 세 규칙), `ReportSchema.latency_by_second: z.array(SecondLatencySchema).optional()`, 소비처 `report.latency_by_second ?? []`.
- 평균 µs는 `latency_stats.rs`의 한 함수(`mean_us`)만 — `(h.mean().round() as u64).min(max_us(h))`. 초별 p95는 `value_at_milli(h, 95_000)`(정수 순위·60,000,000으로 자름). `capped` = `latency_stats::is_capped(h)`. 60초 칸 상수 `CAP_US = 60_000_000`(서버 `latency_stats.rs`, 화면 `ui/src/components/report/format.ts` 같은 값).
- 창·초별 값은 유지 구간 범위와 상관없이 모든 초(지금 창과 같음), 보여 주는 표본(`selected`)을 따른다.
- 「≥」 뒤는 줄바꿈 없는 공백 `\u00a0`(③c 규칙 — `ko.report.stats.capped` = `"≥\u00a060,000"`, `Summary.tsx` 평균 카드 접두 `"≥\u00a0"`). 이 plan의 「≥ 」 글자는 모두 `≥\u00a0`이고, 테스트 기대값은 `ko` 상수로 만든다.
- 화면 색: 평균 `#2563eb` 실선, p95 `#9333ea` 점선(`strokeDasharray="6 4"`). 인쇄: 검정, 평균 실선 0.7, p95 점선 0.5(`1.6 1`).
- `TimeSeriesChart.tsx`·`ui/src/runs/liveSeries.ts`·`RunDetailPage.tsx`(실행 중 화면)는 **무수정**. `ko.report.timeSeriesP95`는 비교 겹쳐 보기 체크박스 이름으로 남지만, 리포트에서 그 그래프가 없어지므로 그 이름을 가리키던 포화 안내(`InsightPanel.tsx`의 `ko.saturation.stall` 인자)는 새 제목으로 바꾼다(Task 3). 인쇄 요약판(한 쪽) 블록 무변경. 비교 겹쳐 보기 기본 선택(`["rps","p95"]`) 무변경.
- `.tsx` 파일은 컴포넌트만 내보낸다(`react-refresh/only-export-components` 경고 + `pnpm lint --max-warnings=0`) — 순수 도우미·표는 `.ts` 모듈에.
- 새 문구는 `ui/src/i18n/ko.ts` 경유(ADR-0035), 화면 「스텝」·인쇄 「단계」, 「응답 시간」 띄어 씀.
- 수치 기대값은 근사 금지(working-rules §10-1) — 아래 테스트 값은 spec §11 스크래치(hdrhistogram 7.5.4) 출력이거나 손계산 정확값.
- 게이트: cargo-영향 커밋은 pre-commit이 `fmt --check`·build·`clippy -D warnings`·`nextest`·doctest, UI는 `cd ui && pnpm lint && pnpm test && pnpm build`. `| tail`·`| head` 금지(종료코드는 `; echo exit=$?`), `--no-verify` 금지, 커밋 전 `git diff --cached --name-only`. `ui/src`를 건드리는 스텝은 그 전에 UI 테스트 파일이 pending이어야 한다(`tdd-guard` — 인라인 Rust 테스트는 UI 쪽 pending으로 치지 않는다).
- 워크트리 `/Users/sgj/develop/handicap/.claude/worktrees/verdict-stats-b`, 기록 파일은 `.superpowers/sdd/`(워크트리 루트에 `.md` 쓰기·`git add` 금지).

## Review Focus

1. **응답 시간이 없는 초**(그 초 요청이 모두 실패해 통과 표본 0, 또는 모두 보내지 않음) — 선이 0으로 떨어지지 않고 끊긴다(서버 `n: 0`·값 없음 → 화면 `null` → 경로 `M` 재시작, 인쇄 칸 `null`). 앞뒤가 비어 혼자 남은 초는 점으로 보인다. Task 1·2·3·4·5.
2. **60초 칸** — 점이 60,000에 그려지고(그 위로 튀지 않음) 평균은 `capped`인 초·창에서 「≥」·안내로 하한임을 밝힌다(툴팁·안내 줄·인쇄 캡션·카드). Task 1·3·4·5·6.
3. **스텝 50개·이름 300자** — 격자 카드 이름 말줄임(`truncate`+`title`), 인쇄 부록이 쌍 행 단위로 쪽을 나눔(카드가 쪽 경계에서 잘리지 않음). Task 4·6·7.
4. **표본 전환**(`?sample=all`·`failed`) — 초별·창 평균이 받은 표본을 따른다(서버). Task 1·7.
5. **창이 없는 리포트**(요청 0건·`windows: []`·`latency_by_second` 없음) — 화면 그래프는 빈 그림, 격자 카드 「응답 시간 없음」, 인쇄 응답 시간 블록·부록 없음, 어디서도 throw 없음. Task 2·4·5·6.

## 사실 확인 명령 (claims-ledger — 디스패치 전 orchestrator가 다시 돌린다)

```bash
grep -n "pub struct ReportWindow" -A10 crates/controller/src/report.rs          # p50/p95/p99_ms만
grep -n "let window_of\|occupancy_windows\|let windows: Vec<ReportWindow>" crates/controller/src/report.rs
grep -n "pub fn latency_stats\|mean_us: (h.mean\|pub fn max_us\|pub fn value_at_milli\|pub fn is_capped" crates/controller/src/latency_stats.rs
grep -n "pub(crate) fn fresh_hist" crates/controller/src/report.rs
grep -n "fn split_win\|fn step_win\|fn report_with(" crates/controller/src/report.rs   # 나눌 수 있는 run 도우미
grep -n "fn whole_report_matches_golden\|REPORT_WHOLE_GOLDEN_UPDATE\|fn build_report_emits_speed_bands_and_keeps_rest" crates/controller/src/report.rs
grep -rn "ReportWindow {" crates | grep -v "pub struct"                          # 리터럴 8곳(report 2·insights 4·export 2)
grep -rn "ReportJson {" crates | grep -v "pub struct" | wc -l                     # 16 (report.rs 11·export.rs 5)
grep -n "export const ReportWindowSchema" -A12 ui/src/api/schemas.ts             # .strict()
grep -rlE "ts_second" ui/src | xargs grep -l "p99_ms" | grep -c __tests__         # 16
grep -rn "bySecond(" ui/src | grep -v __tests__                                   # ReportView·overlaySeries
grep -rln "bySecond\|overlaySeries" ui/src | grep __tests__                       # Task 2가 고칠 테스트
grep -n "timeSeriesP95" ui/src/components/report/InsightPanel.tsx ui/src/components/report/ReportView.tsx ui/src/components/compare/CompareOverlaySection.tsx
grep -n "only-export-components" ui/eslint.config.js
grep -n "capped: \"≥" ui/src/i18n/ko.ts                                           # "≥\u00a060,000"
grep -n "export function standardBlocks" -A60 ui/src/print/buildPrintDoc.ts | grep -n "chart\|appendix\|signature"
grep -n "case \"chart\"\|b.id === \"appendix\"\|it.id === \"appendix\"" ui/src/print/PrintDocument.tsx
grep -n "export function niceTicks\|export function markerX\|export const PLOT_X0_MM\|export const PLOT_X1_MM\|const seconds = Math.min" ui/src/print/chartModel.ts
grep -n "appendix: \"부록. 그 밖의 기준 전체\"\|restMixed" ui/src/i18n/ko.ts ui/src/print/verdict.ts
grep -n "export function stepNo" -A3 ui/src/print/format.ts                      # ① … ⑳, 21번째부터 「21.」
```

---

### Task 1: 서버 — 창 `n`·`mean_us`·`capped`, 초별 합계 `latency_by_second` + UI 스키마 (R-A1, R-A2)

**Files:**
- Modify: `crates/controller/src/latency_stats.rs`, `crates/controller/src/report.rs`, 테스트 리터럴 `crates/controller/src/insights.rs`·`crates/controller/src/export.rs`, `testdata/report_whole_golden.json`(다시 만듦), `ui/src/api/schemas.ts`, 창 리터럴이 있는 UI 테스트 fixture 전부(위 claims 명령의 16개 + 타입 fixture `ui/src/print/compare/__tests__/fixtures.ts` 등 — `tsc -b`가 알려 준다)
- Test: `ui/src/api/__tests__/schemas.test.ts`
- Modify(문서): `ui/src/components/report/CLAUDE.md` bySecond 항목 — 「백분위는 화면에서 합칠 수 없어 초별 합계(`latency_by_second`)는 서버가 만든다(④a)」 한 줄

**Interfaces:**
- Produces (Rust): `pub fn mean_us(h: &Histogram<u64>) -> Option<u64>`(빈 분포 None) — `latency_stats`가 이것을 쓴다. `SecondLatency`(Global Constraints). `ReportWindow.n`·`.mean_us`·`.capped`, `ReportJson.latency_by_second`.
- Produces (Zod): `SecondLatencySchema`·`type SecondLatency`, 창 `n`·`mean_us`·`capped`.

- [ ] **Step 1: 실패하는 테스트(Rust, 인라인)** — 나눌 수 있는 run 도우미 `split_win`/`step_win` + `report_with`를 쓴다(모든 행에 실패 분포 — 실패 없는 행은 빈 슬라이스. 실패 칸 없는 `win()` 행이 하나라도 있으면 `run_is_split`이 거짓이라 기본 표본이 「모든 요청」이 된다).
  - `latency_stats::tests::mean_us_matches_block`: `hist(&[1000, 2000, 3000])` → `Some(2000)`; 빈 분포 → `None`; `hist(&[60_000_000])` → `Some(60_000_000)`.
  - `report::tests::window_n_mean_capped`: ts 100 스텝 A 1000·2000·3000µs(실패 없음) → 창 `n == 3`·`mean_us == Some(2000)`·`!capped`; ts 100 스텝 B 행의 표본이 모두 실패(실패 분포 = 전체) → 창 `n == 0`·`mean_us == None`이고 `serde_json::to_value`의 그 창 객체에 `"mean_us"`·`"capped"` 키 없음, `"n": 0` 있음; ts 101 스텝 A 60,000,000µs × 2 + 1,000µs × 2 → `n == 4`·`mean_us == Some(30_007_796)`·`capped`(JSON에 `"capped": true`); 같은 리포트를 `Some(Sample::All)`로 → B 창 `n`이 그 행의 전체 표본 수.
  - `report::tests::latency_by_second_merges_steps`: ts 100 A(1,000µs × 99)·B(100,000µs × 1), ts 101 실패만인 행, ts 103 A 1,000µs 1건(102는 행 없음), ts 104 A 60,000,000µs × 2 + 1,000µs × 2 → `latency_by_second == [SecondLatency{ts_second:100, n:100, mean_us:Some(1990), p95_us:Some(1000), capped:false}, {101, 0, None, None, false}, {103, 1, Some(1000), Some(1000), false}, {104, 4, Some(30_007_796), Some(60_000_000), true}]`(값 출처: spec §11 스크래치 `RA2 len=100 mean=1990 p95=1000`·`cap mean=60014592`, 30,007,796 = (2×60,014,592 + 2×1,000)/4).
  - `report::tests::latency_by_second_skips_broken_window`: ts 100 A 정상 행(1,000µs × 3) + B 깨진 행(`hdr_histogram` 자리에 `vec![0xff; 4]` — 기존 깨진 행 테스트와 같은 방식) → 그 초 `n == 3`·`mean_us == Some(1000)`, B 창 `n == 0`.
  - `report::tests::latency_by_second_single_step_matches_window`: 한 스텝·여러 초 → 초마다 `p95_us == value_at_milli(창 분포, 95_000)`, `mean_us`·`capped`가 그 창 값과 같다.
  - `report::tests::latency_by_second_absent_when_no_windows`: 행 0개 → 빈 Vec, JSON에 `latency_by_second` 키 없음.
- [ ] **Step 2: 실패 확인** — `cargo nextest run -p handicap-controller mean_us_matches_block window_n_mean_capped latency_by_second; echo exit=$?` → 컴파일 실패(없는 이름).
- [ ] **Step 3: 구현(Rust)**
  - `latency_stats.rs`: `mean_us`를 꺼내고 `latency_stats`의 `mean_us` 칸이 그것을 쓴다(결과 불변 — 기존 `latency_stats` 테스트가 지킨다).
  - `report.rs`: `window_of` 닫힘을 「푼 분포 `Option<&Histogram<u64>>`를 받아 창을 만드는 닫힘」으로 바꾸고(`n = h.len()`, `mean_us(h)`, `capped = is_capped(h)`, 백분위 지금처럼), 점유 창은 `resolve(Sample::All)`로 풀어 넘긴다. 보여 주는 창은 `window_acc.into_iter()` **한 번의 for 루프**로: 창마다 `acc.hist.resolve(selected)`를 한 번 풀어 ① 창 ② 같은 초 임시 분포(`fresh_hist()` 하나를 재사용 — 초가 바뀌면 그 초의 `SecondLatency`를 내고 `reset()`)에 `merge_into`. `hist()`가 None인 창(빈·깨짐)은 합치지 않는다. 그 초에 창이 하나라도 있으면 항목을 낸다(`n: 0`이어도). 초 항목: `n = tmp.len()`, `mean_us(&tmp)`, `value_at_milli(&tmp, 95_000)`, `is_capped(&tmp)`(빈 분포면 `false`). 창 분포를 두 번 풀지 않는다(spec R-A2·§5).
  - 구조체 리터럴(`ReportWindow` 8곳·`ReportJson` 16곳): `n: 0`·`mean_us: None`·`capped: false`·`latency_by_second: Vec::new()` — 테스트가 다른 값을 요구하지 않는 한.
  - 영향받는 기존 테스트 둘: ① `whole_report_matches_golden` — `REPORT_WHOLE_GOLDEN_UPDATE=1 cargo nextest run -p handicap-controller whole_report_matches_golden`로 `testdata/report_whole_golden.json`을 다시 만들고, 구조로 비교한다(골든은 줄 단위 pretty JSON이라 새 키 앞 줄에 쉼표가 붙어 줄 diff로는 늘 「다른 줄도 바뀜」이 된다): `git show HEAD:testdata/report_whole_golden.json > /tmp/verdict-stats-b-golden-old.json` 뒤 `jq -S 'del(.latency_by_second) | .windows |= map(del(.n, .mean_us, .capped))' /tmp/verdict-stats-b-golden-old.json > /tmp/verdict-stats-b-a.json`, 새 파일도 같은 `jq`로 `/tmp/verdict-stats-b-b.json`, `cmp /tmp/verdict-stats-b-a.json /tmp/verdict-stats-b-b.json; echo exit=$?` → `exit=0`(아니면 STOP — 새 키 말고 결과가 바뀐 것). ② `build_report_emits_speed_bands_and_keeps_rest`의 최상위 키 목록에 `latency_by_second`를 더한다(그 fixture에 표본이 있다).
- [ ] **Step 4: UI 스키마** — 먼저 `ui/src/api/__tests__/schemas.test.ts`에 케이스(이 테스트 편집이 pending이라야 `schemas.ts` 편집이 허용된다): 창 객체에서 `n`을 빼면 `ReportWindowSchema.safeParse` 실패; 창 `{…, n: 3, mean_us: 2000, capped: true}` 통과; `SecondLatencySchema`에 모르는 키 `foo: 1`이면 실패(`.strict()`); `{ts_second:1, n:0}` 통과; 리포트 객체에 `latency_by_second`가 없어도 `ReportSchema` 통과; `capped: true`인 창 하나와 `{ts_second:2, n:4, mean_us:30007796, p95_us:60000000, capped:true}` 초 항목을 가진 리포트 객체가 `ReportSchema` 통과(`capped`는 참일 때만 오므로 이 경우가 없으면 `.strict()` 누락을 못 잡는다). 그 뒤 `schemas.ts`(Global Constraints대로), 창 리터럴이 있는 UI 테스트 fixture에 `n: 0`(값을 읽는 소비처는 Task 2부터라 0으로 충분), `ui/src/components/report/CLAUDE.md` 한 줄.
- [ ] **Step 5: 통과 확인** — `cargo build --workspace --tests; echo exit=$?` → 0, `cargo nextest run -p handicap-controller; echo exit=$?` → 0(골든 `testdata/compare_golden.json` 역직렬화 포함), `cd ui && pnpm test; echo exit=$?` → 0, `pnpm build; echo exit=$?` → 0, `pnpm lint; echo exit=$?` → 0.
- [ ] **Step 6: 되돌려 확인** — ① 초별 합치기에서 `merge_into` 대신 「그 초의 첫 창 분포만」 쓰게 바꾸면 `latency_by_second_merges_steps`의 `n:100` RED, 원복. ② 표본 없는 초(`n == 0`)는 항목을 내지 않게 바꾸면 ts 101 항목이 빠져 RED, 원복. ③ 창 `capped`를 늘 `false`로 두면 `window_n_mean_capped` RED, 원복.
- [ ] **Step 7: 커밋** — `feat(controller): 리포트 창 표본 수·평균·60초 칸 표지, 초별 모든 스텝 합계 응답 시간` (cargo+UI 게이트 둘 다 돈다 — 단일 FOREGROUND 호출, 600000ms).

### Task 2: 화면 초별 시계열 + 비교 겹쳐 보기 「평균」 (R-A3, R-A7)

**Files:**
- Modify: `ui/src/report/bySecond.ts`, `ui/src/compare/overlaySeries.ts`, `ui/src/components/compare/CompareOverlaySection.tsx`, `ui/src/i18n/ko.ts`
- Test(고침): `ui/src/report/__tests__/bySecond.test.ts`, `ui/src/report/__tests__/bySecond.sample.test.ts`, `ui/src/compare/__tests__/overlaySeries.test.ts`; (새로 또는 고침) `ui/src/components/compare/__tests__/CompareOverlaySection.test.tsx`

**Interfaces:**
- Consumes: Task 1의 `report.latency_by_second`.
- Produces: `export type Sec = { ts_second: number; count: number; errors: number; p95_ms: number | null; mean_ms: number | null; capped: boolean }`(값 = µs ÷ 1000, 반올림 없음; `capped` = 그 초 항목의 `capped ?? false`). `MetricKey = "rps" | "p95" | "mean" | "errors"`. `ko.compare.overlayMean = "평균 응답 시간 (ms)"`.

- [ ] **Step 1: 테스트 고치기·쓰기** — 지금 창 `p95_ms`만으로 응답 시간을 단언하는 기존 케이스(`bySecond.test.ts`의 「takes max p95」, `bySecond.sample.test.ts` 두 케이스, `overlaySeries.test.ts`의 p95 값 단언 — 파일 안 `p95` grep)를 `latency_by_second`를 준 fixture로 다시 쓴다(「모든 요청이 실패한 초 → null」은 이제 서버 `n: 0` 항목으로 — 서버 쪽 근거는 Task 1 `window_n_mean_capped`). 새 케이스: 창 ts 100 A(`count 99, p95_ms 1`)·B(`count 1, p95_ms 100`) + `latency_by_second: [{ts_second:100, n:100, mean_us:1990, p95_us:1000}]` → `[{ts_second:100, count:100, errors:0, p95_ms:1, mean_ms:1.99, capped:false}]`; 초 항목 `{n:0}` → 그 초 `p95_ms:null, mean_ms:null`(count·errors는 창 합); `capped:true` 항목 → `capped:true`; `latency_by_second` 키 없음 → 모든 초 `p95_ms:null, mean_ms:null, capped:false`. `overlaySeries(reports, 0, "mean")`: run 둘의 행 `run0`·`run1` 값이 각 리포트의 `mean_ms`. `CompareOverlaySection`: 체크박스 「평균 응답 시간 (ms)」가 있고 처음엔 꺼져 있다(기본 그래프는 「초당 요청 수 (RPS)」·「p95 응답 시간 (ms)」 둘), 켜면 그 제목의 그래프가 나온다(fixture에 `latency_by_second`를 준다 — 없으면 빈 데이터 문구 `role="status"`).
- [ ] **Step 2: 실패 확인** — `cd ui && pnpm test bySecond` · `pnpm test overlaySeries` · `pnpm test CompareOverlaySection` → 새 케이스 FAIL.
- [ ] **Step 3: 구현** — `bySecond`는 창으로 count·errors를 합치고, 응답 시간은 `latency_by_second`의 같은 초 항목에서만 읽는다(창 `p95_ms` 최댓값·`hasLatency` 판정 삭제, 쓰지 않게 된 import도 지운다 — `windowNotSent`는 이제 테스트에서만 쓰이면 그대로 둔다). `overlaySeries` `metricValue`에 `mean`. `OVERLAY_METRICS`에 `{ key: "mean", title: ko.compare.overlayMean, yLabel: "ms" }`를 p95와 errors 사이에.
- [ ] **Step 4: 통과 확인** — 위 셋 + `pnpm test ReportView` PASS.
- [ ] **Step 5: 되돌려 확인** — `bySecond` 응답 시간을 옛 「창 p95 최댓값」으로 되돌리면 `p95_ms:1` 단언이 100으로 RED, 원복.
- [ ] **Step 6: 게이트·커밋** — `cd ui && pnpm lint && pnpm test && pnpm build`. 커밋 `feat(ui): 초별 응답 시간을 모든 스텝 합계로, 비교 겹쳐 보기에 평균`.

### Task 3: 리포트 「응답 시간」 그래프 — 평균·p95 두 선 (R-A4, 목업 1번 위)

**Files:**
- Create: `ui/src/components/report/LatencyTimeSeriesChart.tsx`, `ui/src/report/latencyText.ts`
- Modify: `ui/src/components/report/ReportView.tsx`(p95 `TimeSeriesChart` 한 개를 이것으로 교체), `ui/src/components/report/InsightPanel.tsx`(`ko.saturation.stall` 인자), `ui/src/i18n/ko.ts`
- Test: `ui/src/report/__tests__/latencyText.test.ts`, `ui/src/components/report/__tests__/LatencyTimeSeriesChart.test.tsx`, 기존 `ReportView`·`InsightPanel` 테스트

**Interfaces:**
- Consumes: Task 2 `Sec`.
- Produces:
  - `LatencyTimeSeriesChart(props: { data: { ts_second: number; mean: number | null; p95: number | null; capped: boolean }[]; marks?: SteadyMarks | null; sampleTag?: string | null; width?: number; height?: number })`.
  - `latencyText.ts`: `latencyTooltipText(ms: number, capped: boolean): string` — `ms >= 60000` → `ko.report.latencyChart.cappedValue`, 아니면 `(capped ? "≥\u00a0" : "") + formatLatency(Math.round(ms * 1000))`(ms 소수 × 1000의 부동소수 오차를 반올림으로 없앤다); `isLonePoint(values: (number | null)[], i: number): boolean` = `values[i] !== null` 이고 앞(없으면 끝으로 침)과 뒤가 둘 다 `null`.
  - `ko.report.latencyChart = { title: "응답 시간 (ms)", mean: "평균", p95: "p95", hint: "모든 스텝의 요청을 초마다 합쳐 낸 값입니다.", hintCapped: "60초를 넘긴 응답이 있는 초의 평균은 실제보다 작게 나온 값입니다(툴팁에 「≥」).", cappedValue: "≥\u00a060,000 ms" }`.

- [ ] **Step 1: 실패하는 테스트**
  - `latencyText`: `latencyTooltipText(60000, false)` → `` `${ko.report.stats.capped} ms` ``(= `ko.report.latencyChart.cappedValue`); `(0.5, false)` → 「500 µs」; `(43.903, false)` → `formatLatency(43903)`; `(30007.796, true)` → `"≥\u00a0" + formatLatency(30007796)`. `isLonePoint([null, 5, null], 1)` → true, `([3, 5, null], 1)` → false, `([5], 0)` → true, `([null, null, null], 1)` → false.
  - `LatencyTimeSeriesChart`(명시 크기 `width={600} height={220}`): 제목 「응답 시간 (ms)」(구역 `aria-label`은 기존 `ko.report.timeSeriesAria(title)` 규칙), 범례 「평균」·「p95」 글자, 안내 `hint`, `container.querySelectorAll("path.recharts-line-curve").length === 2`; `capped: true`인 점이 하나 있으면 `hintCapped` 글이 보이고 없으면 안 보인다; `mean`이 `[null, 7, null]`이면 평균 선 층에 점 표지(`circle`) 하나.
  - `ReportView`: 「응답 시간 (ms)」 그래프가 있고 「p95 응답 시간 (ms)」 그래프 제목은 리포트 화면에 없다.
  - `InsightPanel.test.tsx`의 멈춤 안내 단언(`timeSeriesP95` 쓰는 곳)을 `ko.report.latencyChart.title`로.
- [ ] **Step 2: 실패 확인** — `pnpm test latencyText` · `pnpm test LatencyTimeSeriesChart` · `pnpm test ReportView` · `pnpm test InsightPanel` FAIL.
- [ ] **Step 3: 구현** — `TimeSeriesChart`의 구조(x = 첫 초부터 센 초, `marks`가 있으면 숫자 축 `domain=[0, xMax]`·띠·선, `PageSection` + `SampleTag`)를 따라 새 파일로(공유 코드는 고치지 않는다). 선 둘: 평균 `#2563eb`, p95 `#9333ea` `strokeDasharray="6 4"`, `type="monotone"`, `connectNulls` 없음, `isAnimationActive={false}`(`TimeSeriesChart`와 같음 — jsdom에서 점이 그려지게), `dot`은 `isLonePoint`일 때만 `r=2` 원(`<circle>`)을 그리고 그 밖에는 빈 `<g key={props.key} />`를 돌려주는 함수(recharts 2 `LineDot` 함수 타입은 `ReactElement<SVGElement>`를 돌려야 해서 `null` 반환은 `tsc -b`에서만 실패한다 — 앞뒤가 빈 초가 사라지지 않게). 값은 `Math.min(v, 60000)`으로 그린다. 툴팁 `formatter`는 `latencyTooltipText`(평균은 그 점의 `capped`, p95는 `false`). 범례는 Recharts `<Legend>` 대신 제목 줄 오른쪽 작은 글(목업 1번 — `<li>` 충돌 함정 회피). `ReportView`는 `seconds.map(s => ({ ts_second, mean: s.mean_ms, p95: s.p95_ms, capped: s.capped }))`. `InsightPanel`은 `ko.saturation.stall`에 `ko.report.latencyChart.title`.
- [ ] **Step 4: 통과 확인** — 위 넷 + `pnpm test` 전체 PASS.
- [ ] **Step 5: 되돌려 확인** — ① p95 `<Line>`을 지우면 선 개수 2 단언 RED ② `dot`을 `false`로 되돌리면 혼자 남은 점 단언 RED — 각각 원복.
- [ ] **Step 6: 게이트·커밋** — UI 게이트. `feat(ui): 리포트 응답 시간 그래프에 평균선과 p95선`.

### Task 4: 「스텝별로 보기」 — 스텝별 작은 평균 그래프 격자 (R-A5, R-A6, 목업 1번 아래)

**Files:**
- Create: `ui/src/report/sparkPath.ts`, `ui/src/report/stepLatencySeries.ts`, `ui/src/components/report/stepLatencyViews.ts`, `ui/src/components/report/StepLatencySection.tsx`, `ui/src/components/report/StepLatencyGrid.tsx`
- Modify: `ui/src/components/report/ReportView.tsx`(그래프 바로 아래), `ui/src/i18n/ko.ts`
- Test: `ui/src/report/__tests__/sparkPath.test.ts`, `ui/src/report/__tests__/stepLatencySeries.test.ts`, `ui/src/components/report/__tests__/StepLatencySection.test.tsx`

**Interfaces:**
- Consumes: Task 1 창 `n`·`mean_us`·`capped`, `report.steps[].stats`, `ReportView`의 `stepNames`(id → 이름)·`marks`, `ui/src/print/chartModel.ts` `niceTicks`, `format.ts` `latencyShown`·`latencyUnitText`.
- Produces:
  - `sparkPath(points: { x: number; y: number | null }[], box: { xMax: number; yMax: number; x0: number; x1: number; yTop: number; yBottom: number }): string` — x 좌표 `x0 + x / max(xMax, 1) × (x1 − x0)`, y 좌표 `yBottom − min(y, yMax) / yMax × (yBottom − yTop)`, 둘 다 `Math.round(v * 100) / 100`. 이어진 점 묶음마다 첫 점 `M{x},{y}`, 나머지 `L{x},{y}`; **점 하나뿐인 묶음은 `M{x},{y} L{x},{y}`**(둥근 선 끝 `strokeLinecap="round"`로 점이 보인다); 조각을 공백 하나로 잇는다. 인쇄(Task 5·6)도 이것을 쓴다.
  - `stepLatencySeries.ts`: `type StepLatencySeries = { stepId: string; name: string; stats: LatencyStats | undefined; capped: boolean; points: { x: number; meanMs: number | null }[] }`; `stepLatencySeries(report: Report, names: Map<string, string>, firstTs: number | null): StepLatencySeries[]` — 순서 `report.steps`, 이름 `names.get(id) ?? id`, 점 = 그 스텝 창마다 `x = ts_second − firstTs`, `meanMs = mean_us / 1000`(`mean_us` 없으면 `null`), `capped` = 그 스텝 창 중 `capped`가 하나라도 있음; `sharedYMax(series: StepLatencySeries[]): number` — 모든 `meanMs` 최댓값을 `niceTicks(max, 5)`의 마지막 눈금으로(값이 없으면 `niceTicks(0, 5)` = `[0, 1]` → 1); `stepMeanText(stats: LatencyStats | undefined): string` — 없으면 `ko.report.stepLatency.noData`, 있으면 `x = latencyShown(Math.min(Math.round(stats.mean_us / 1000), 60000), stats.mean_us)`, 글 `ko.report.stepLatency.mean((x.kind !== "capped" && stats.capped ? "≥\u00a0" : "") + latencyUnitText(x))`(③c 평균 카드 `Summary.tsx` 규칙과 같은 글자).
  - `stepLatencyViews.ts`: `type StepLatencyView = "grid"`, `type StepLatencyViewProps = { series: StepLatencySeries[]; yMax: number; xMax: number; marks: SteadyMarks | null }`, `const STEP_LATENCY_VIEWS: Record<StepLatencyView, { label: string; Component: (p: StepLatencyViewProps) => JSX.Element }> = { grid: { label: ko.report.stepLatency.viewGrid, Component: StepLatencyGrid } }`. 보기 고르는 단추는 `Object.keys(STEP_LATENCY_VIEWS).length > 1`일 때만 그린다(R-A6). `StepLatencyGrid.tsx`는 `StepLatencyViewProps`를 `import type`으로만 가져온다(`stepLatencyViews.ts` ↔ `StepLatencyGrid.tsx` 실행 시 import 순환 방지).
  - `ko.report.stepLatency = { toggle: "스텝별로 보기", hint: (yMax: string) => \`스텝마다 평균 응답 시간입니다. 모든 그래프가 같은 세로 눈금(0–${yMax} ms)이라 높이로 서로 비교할 수 있습니다. 순서는 스텝 표와 같습니다.\`, hintCapped: "60초를 넘긴 응답이 있는 초의 평균은 실제보다 작게 나온 값입니다.", mean: (v: string) => \`평균 ${v}\`, noData: "응답 시간 없음", viewGrid: "작은 그래프" }`.

- [ ] **Step 1: 실패하는 테스트**
  - `sparkPath([{x:0,y:0},{x:1,y:50},{x:2,y:null},{x:3,y:100}], {xMax:3, yMax:100, x0:0, x1:300, yTop:0, yBottom:80})` → `"M0,80 L100,40 M300,0 L300,0"`; 모든 y가 `null` → `""`; `y` 150 > yMax 100 → `yTop`(0)에 붙음; `xMax: 0` → 나눗셈 분모 1(x0 그대로).
  - `stepLatencySeries`: 스텝 셋(`report.steps` 순서 B·A·C), 창 A ts 100(`mean_us 52118`)·102(`mean_us` 없음, `n 0`)·103(`mean_us 60000000, capped true`), 이름 맵에 A만 → `[B(점 0개, name "B", capped false), A(name 맵 값, points [{x:0,meanMs:52.118},{x:2,meanMs:null},{x:3,meanMs:60000}], capped true), C]`(firstTs 100). `sharedYMax`: 최대 287.3 → 300, 값 없음 → 1.
  - `stepMeanText`: `mean_us 52118, capped false` → `ko.report.stepLatency.mean("52 ms")`; `350` → `mean("350 µs")`; `60_000_000, capped true` → `mean(\`${ko.report.stats.capped} ms\`)`; `17_178_000, capped true` → `mean("≥\u00a017178 ms")`; `undefined` → 「응답 시간 없음」.
  - `StepLatencySection` RTL(스텝 셋 — 평균 최댓값 287.3ms는 스텝 A, 비교 대상 카드는 최댓값이 120ms인 스텝 B): 처음엔 `button` 「스텝별로 보기」 `aria-expanded="false"`이고 카드 0개; 누르면 `true`·스텝 수만큼 카드(이름 글·`title` 속성 = 이름)·안내 글에 「0–300 ms」; 보기 고르는 단추(「작은 그래프」)가 없다; **스텝 B** 카드 `svg` 안 선 `path`의 `d`가 `sparkPath(B 점들, {xMax, yMax: 300, x0:0, x1:300, yTop:0, yBottom:80})`와 같다; `capped` 창이 있으면 `hintCapped` 글이 보이고 없으면 안 보인다; 리포트 `steps`가 비면 카드 0개·throw 없음.
- [ ] **Step 2: 실패 확인** — `pnpm test sparkPath` · `pnpm test stepLatencySeries` · `pnpm test StepLatencySection` FAIL.
- [ ] **Step 3: 구현** — 격자 `grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3`, 카드 = 이름(`truncate` + `title`) · `stepMeanText` · `svg viewBox="0 0 300 80" preserveAspectRatio="none" width="100%" height="80"`(유지 구간 띠는 `marks.bands`를 같은 x 환산으로 `rect` — 색 `#94a3b8`/`#f59e0b`, 투명도 0.22/0.16, `TimeSeriesChart`와 같음), 선 `#2563eb` `strokeWidth 1.6` `strokeLinecap="round"` `vectorEffect="non-scaling-stroke"` `fill="none"`. `xMax` = `max(마지막 창 초 − firstTs, marks의 띠 x2·선 x)`(메인 그래프와 같은 가로축). `ReportView`에서 `<StepLatencySection report stepNames marks firstTs={seconds[0]?.ts_second ?? null} />`.
- [ ] **Step 4: 통과 확인** — 위 셋 + `pnpm test` 전체.
- [ ] **Step 5: 되돌려 확인** — ① 기본 열림으로 바꾸면 「처음엔 카드 0개」 RED ② 카드마다 자기 최댓값으로 눈금을 잡게 바꾸면 스텝 B 카드 `d`(yMax 300 → 자기 눈금) RED — 각각 원복.
- [ ] **Step 6: 게이트·커밋** — UI 게이트. `feat(ui): 응답 시간 그래프 아래 「스텝별로 보기」 작은 그래프 격자`.

### Task 5: 인쇄 「시간에 따른 변화」에 응답 시간 그래프 (R-A8, 목업 3번)

**Files:**
- Create: `ui/src/print/latencyChart.ts`, `ui/src/print/components/LatencyChart.tsx`
- Modify: `ui/src/print/buildPrintDoc.ts`(`PrintDoc.latencyChart`, `standardBlocks`), `ui/src/print/PrintDocument.tsx`(`Atomic` 갈래), `ui/src/i18n/ko.ts`
- Test: `ui/src/print/__tests__/latencyChart.test.ts`, `ui/src/print/__tests__/buildPrintDoc.test.ts`, `ui/src/print/__tests__/LatencyChart.test.tsx`

**Interfaces:**
- Consumes: `ChartModel`(`durationSec`·`binSeconds`·`bins[i].startSec/seconds`·`steady`), `runT0`, Task 4 `sparkPath`, `niceTicks`·`timeTicks`·`markerX`·`PLOT_X0_MM`·`PLOT_X1_MM`·`CHART_W_MM`·`elapsedText`.
- Produces:
  - `type LatencyBin = { startSec: number; seconds: number; meanMs: number | null; p95Ms: number | null; capped: boolean }`, `type LatencyChartModel = { bins: LatencyBin[]; yTicks: number[]; capped: boolean; p95Label: string; binText: string }`.
  - `binLatency(series: SecondLatency[], t0: number, chart: ChartModel): LatencyBin[]` — 칸 경계는 `chart.bins`와 같다(초 `ts`의 칸 = `min(nBins − 1, floor((ts − t0) / binSeconds))`). 칸 평균 = `Σ(n × mean_us) / Σn ÷ 1000`(`n > 0`이고 `mean_us`가 있는 초만), 칸 p95 = 그 칸 `p95_us` 최댓값 ÷ 1000, 해당 초가 없으면 `null`. 칸 `capped` = 그 칸 초 중 `capped`가 하나라도 있음.
  - `buildLatencyChart(series: SecondLatency[], t0: number | null, chart: ChartModel): LatencyChartModel | null` — `t0`가 null이거나 어느 칸에도 `meanMs`가 없으면 `null`. `yTicks = niceTicks(max(모든 meanMs·p95Ms), 5)`, `capped` = 어느 칸이든 `capped`, `p95Label` = `binSeconds === 1 ? K.p95 : K.p95Bin`, `binText = elapsedText(binSeconds)`.
  - 점 좌표: x = `startSec + seconds / 2`, `xMax = durationSec`, 박스 `{x0: PLOT_X0_MM, x1: PLOT_X1_MM, yTop: 8, yBottom: 47}`, `yMax` = `yTicks` 마지막 값(`ErrorChart`의 `markerX`와 같은 x — `markerX(sec, d) = PLOT_X0_MM + sec / max(d,1) × (PLOT_X1_MM − PLOT_X0_MM)`).
  - `PrintDoc.latencyChart: LatencyChartModel | null`, 블록 id `"chart:latency"`(atomic, `data-measure` 같은 이름).
  - `ko.print.latencyChart = { title: "응답 시간", mean: "평균", p95: "p95", p95Bin: "p95 (구간 안에서 가장 느린 초)", caption: (bin: string) => \`모든 단계의 요청을 합친 값입니다. 한 칸 = ${bin}. 평균은 그 칸 안 요청 전체의 평균, p95는 칸이 1초보다 길면 칸 안에서 가장 느린 1초의 p95입니다.\`, capped: "60초를 넘긴 응답이 있어 그 구간의 값은 실제보다 작게 그려졌습니다.", aria: "응답 시간 그래프" }`.

- [ ] **Step 1: 실패하는 테스트**
  - `binLatency`: `binSeconds 2`, t0 100, 초 100 `{n:1, mean_us:10000, p95_us:10000}`·101 `{n:3, mean_us:20000, p95_us:30000}` → 칸 0 `meanMs 17.5, p95Ms 30, capped false`; 초 102 `{n:0}`만 있는 칸 → `null, null, false`; 초 104 `{n:4, mean_us:30007796, p95_us:60000000, capped:true}` 칸 → `capped true`.
  - `buildLatencyChart`: 빈 `series` → `null`; `t0` null → `null`; 1초 칸 → `p95Label` 「p95」, 2초 칸 → 「p95 (구간 안에서 가장 느린 초)」; 최댓값 287.3ms → `yTicks [0,100,200,300]`.
  - `standardBlocks`: `latencyChart`가 있으면 id 순서에 `"chart"` 바로 뒤 `"chart:latency"`, 없으면 없음; `summaryBlocks`(모든 단계 `l`)에는 어느 경우도 없다.
  - 컴포넌트: 제목 「응답 시간」, 범례 글 「평균」과 `p95Label`, 선 `path` 두 개(`d` = 위 좌표 규칙의 `sparkPath` 값), `capped`면 캡션에 `ko.print.latencyChart.capped`, 아니면 없음.
- [ ] **Step 2: 실패 확인** — `pnpm test latencyChart` · `pnpm test buildPrintDoc` · `pnpm test LatencyChart` FAIL.
- [ ] **Step 3: 구현** — `ErrorChart`의 세로 기하(PLOT_TOP 8·PLOT_BOTTOM 47·TIME_LABEL_Y 51.5·글자 2.3)·시간 눈금·유지 구간 점선을 따른다(`ErrorChart` 자체는 고치지 않는다). 평균 `stroke="#000" strokeWidth={0.7}`, p95 `strokeWidth={0.5} strokeDasharray="1.6 1"`, 둘 다 `strokeLinecap="round"`. `buildPrintDoc`에서 `buildLatencyChart(report.latency_by_second ?? [], t0, chart)`.
- [ ] **Step 4: 통과 확인** — 위 + `pnpm test` 전체.
- [ ] **Step 5: 되돌려 확인** — 칸 평균을 단순 평균(`n` 무시)으로 바꾸면 `17.5` 단언이 15로 RED, 원복.
- [ ] **Step 6: 게이트·커밋** — UI 게이트. `feat(ui): 인쇄 「시간에 따른 변화」에 응답 시간 그래프`.

### Task 6: 인쇄 부록 「단계별 평균 응답 시간」 (R-A9, 목업 5번)

**Files:**
- Create: `ui/src/print/stepLatencyAppendix.ts`, `ui/src/print/components/StepLatencyAppendix.tsx`
- Modify: `ui/src/print/buildPrintDoc.ts`(`PrintDoc.stepLat`·`appendixNo`, `MEASURE_IDS`, `standardBlocks`, `restMixed`에 넘길 부록 이름), `ui/src/print/verdict.ts`(`restMixed` 호출), `ui/src/print/PrintDocument.tsx`(`MeasureSheet`·`PageBody`의 `"steplat"` 갈래), `ui/src/print/components/OtherCriteriaTable.tsx`(`AppendixTitle`이 번호를 받는다), `ui/src/i18n/ko.ts`
- Test: `ui/src/print/__tests__/stepLatencyAppendix.test.ts`, `ui/src/print/__tests__/buildPrintDoc.test.ts`, `ui/src/print/__tests__/verdict.test.ts`(있는 파일), `ui/src/print/__tests__/StepLatencyAppendix.test.tsx`, 페이지 렌더 테스트(`PrintDocument` 쪽 기존 파일)

**Interfaces:**
- Consumes: `doc.table.rows`(`StepRow` — `no`·`name`·`stepId`, 순서), Task 1 창 `n`·`mean_us`·`capped`, `ChartModel`, `runT0`, `sparkPath`, `niceTicks`, `timeTicks`.
- Produces:
  - `type StepLatCard = { title: string; hasData: boolean; bins: (number | null)[] }`(`title` = `${row.no} ${row.name}` — 단계별 결과 표 이름 칸과 같은 글), `type StepLatModel = { cards: StepLatCard[]; pairs: [StepLatCard, StepLatCard | null][]; yTicks: number[]; capped: boolean; points: number[] }`(`points[i] = chart.bins[i].startSec + chart.bins[i].seconds / 2` — 마지막 칸은 짧을 수 있다), `durationSec`는 `chart.durationSec`.
  - `buildStepLatAppendix(windows: Report["windows"], rows: StepRow[], t0: number | null, chart: ChartModel): StepLatModel | null` — 칸 경계는 `chart`와 같다, 칸 값 = 그 단계 창들의 `Σ(n × mean_us)/Σn ÷ 1000`(`n > 0`이고 `mean_us`가 있는 창만), 없으면 `null`; `capped` = 창 중 `capped`가 하나라도 있음. `t0`가 null이거나 모든 카드가 `hasData false`면 `null`. `yTicks = niceTicks(모든 칸 값 최댓값, 5)`.
  - 카드 선 좌표: x = `points[i]`, `xMax = chart.durationSec`, `yMax` = `yTicks` 마지막 값, 박스 `{x0: 6, x1: 84, yTop: 2, yBottom: 22}`(카드 `svg viewBox="0 0 88 26"`).
  - `PrintDoc.stepLat: StepLatModel | null`, `PrintDoc.appendixNo: { other: string | null; stepLat: string | null }`(기존 부록이 나오는 조건 = `limitOtherRows(doc.otherRows, "standard").truncated`; 둘 다 나오면 `"1"`·`"2"`, 하나면 `null`).
  - `MEASURE_IDS.stepLatTitle = "steplat:title"`, `MEASURE_IDS.stepLatRowId = (i: number) => \`steplat:row:${i}\``, 표 블록 id `"steplat"`(`headerMm` 0 — 머리 행 없음).
  - `ko.print.section.appendixOther(no: string | null)` = no 없으면 「부록. 그 밖의 기준 전체」(지금 `appendix` 글과 같음), 있으면 「부록 1. 그 밖의 기준 전체」; `ko.print.section.appendixStepLat(no)` = 「부록. 단계별 평균 응답 시간」 / 「부록 2. 단계별 평균 응답 시간」; `ko.print.section.appendixRef(no)` = 「부록」 / 「부록 1」; `ko.print.criteria.restMixed(n, parts, ref)` = `` `외 ${n}개 기준(${parts}) — ${ref} 참조` ``; `ko.print.stepLat = { caption: (yMax: string) => \`단계마다 시간에 따른 평균 응답 시간입니다. 모든 그림이 같은 세로 눈금(0–${yMax} ms)·같은 가로 시간축입니다. 순서는 「단계별 결과」 표와 같습니다.\`, noData: "응답 시간 없음" }`(60초 칸 한 줄은 `ko.print.latencyChart.capped` 재사용).

- [ ] **Step 1: 실패하는 테스트**
  - 모델: 단계 다섯(행 순서 = 입력 `rows` 순서) → `pairs.length === 3`, 마지막 쌍 `[카드, null]`; 한 단계 창 둘이 같은 칸(2초 칸)에 `{n:1, mean_us:10000}`·`{n:3, mean_us:20000}` → 그 칸 17.5; 창이 없는 단계 → `hasData false`; 모든 단계 창 없음 → `null`; 칸 값 최댓값 287.3 → `yTicks [0,100,200,300]`; `capped` 창 하나 → `capped true`; 마지막 칸이 짧은 run(`durationSec 5`, `binSeconds 2` — `pickBinSeconds(5)`는 1을 고르므로 이 테스트는 `ChartModel`을 손으로 만든다: `bins` `[{startSec:0,seconds:2},{startSec:2,seconds:2},{startSec:4,seconds:1}]`) → `points [1, 3, 4.5]`.
  - 부록 이름: `appendixNo` 세 경우(둘 다 → 「부록 1. 그 밖의 기준 전체」·「부록 2. 단계별 평균 응답 시간」, 부록 2만 → 「부록. 단계별 평균 응답 시간」, 기존만 → 「부록. 그 밖의 기준 전체」), `restMixed` 글 끝: 둘 다 → 「— 부록 1 참조」, 기존만 → 「— 부록 참조」.
  - `standardBlocks` id 순서 끝 = `[…, "appendix"(있을 때), "steplat", "signature"]`, `stepLat`이 null이면 `"steplat"` 없음, `summaryBlocks`에는 없음. `steplat` 블록 `rowsMm.length === pairs.length`.
  - 컴포넌트: 카드 제목 글(`① 로그인`), `hasData false` 카드에 「응답 시간 없음」, 카드 선 `path` `d` = 위 좌표 규칙의 `sparkPath` 값, `capped`면 캡션 아래 `ko.print.latencyChart.capped`.
  - 페이지 렌더(쪽 그리기 경로 `PageBody`): `stepLat`이 있는 문서의 마지막 쪽에 제목 「부록. 단계별 평균 응답 시간」과 카드 `svg` 수 = 단계 수(단계별 결과 표의 이름 칸 글과 겹치지 않는, 부록만 그리는 것으로 단언). 판정 기준이 넘쳐 두 부록이 다 나오는 문서를 렌더하면 판정 글에 「— 부록 1 참조」가 보인다(`OtherCriteria`까지 배선됐는지 — `limitOtherRows` 단위 테스트만으로는 못 잡는다).
- [ ] **Step 2: 실패 확인** — `pnpm test stepLatencyAppendix` · `pnpm test buildPrintDoc` · `pnpm test verdict` · `pnpm test StepLatencyAppendix` FAIL.
- [ ] **Step 3: 구현** — 카드 칸 폭 88mm(본문 180 = 88 + 간격 4 + 88), 그림 `svg viewBox="0 0 88 26" width="88mm" height="26mm"`(세로 눈금 글은 0과 최댓값만 x 5 오른쪽 맞춤, 가로 눈금은 본문 그래프와 같은 `timeTicks`·`fmtElapsed` 글자를 y 25에), 선 검정 0.6 `strokeLinecap="round"`. 제목 블록 = 부록 제목 + 캡션(`data-measure="steplat:title"`), 행 = 카드 한 쌍(`data-measure="steplat:row:i"`, 2열 격자). `MeasureSheet`·`PageBody` 둘 다 `"steplat"` 갈래(안 하면 단계별 결과 표로 그려진다 — 인쇄 함정 노트). 이어지는 쪽 제목은 기존 부록처럼 `${title}${s.continued}`. `AppendixTitle`은 `ko.print.section.appendixOther(doc.appendixNo.other)`를 쓴다(기존 부록만 있을 때 글자 불변). `restMixed` 글은 `verdict.ts` `limitOtherRows(rows, mode)`가 만들고, 그 글을 화면에 그리는 곳은 `OtherCriteriaTable.tsx`의 `OtherCriteria` 컴포넌트(`PrintDocument.tsx` `AtomicContent`의 `case "other:standard"`가 렌더)다. `limitOtherRows`에 세 번째 인자 `appendixRef: string = ko.print.section.appendixRef(null)`을 더하고, `OtherCriteria`에 같은 이름의 선택 prop을 더해 넘기며, `case "other:standard"`가 `ko.print.section.appendixRef(doc.appendixNo.other)`를 준다(측정 시트와 쪽 그리기가 같은 `AtomicContent(id, doc)`를 쓰므로 둘이 같은 글자로 높이를 잰다 — 값을 `doc`에서만 읽을 것)(`other:summary3`·`line` 갈래와 `standardBlocks`의 `truncated` 판정은 기본값 그대로 — `truncated`는 글자와 무관). 부록 번호는 「기존 부록이 나오는가(`limitOtherRows(doc.otherRows, "standard").truncated`)」와 `stepLat !== null`만으로 정해진다.
- [ ] **Step 4: 통과 확인** — 위 + `pnpm test` 전체.
- [ ] **Step 5: 되돌려 확인** — `PageBody`의 `"steplat"` 갈래를 지우면 페이지 렌더 단언(부록 제목·카드 `svg` 수) RED, 원복.
- [ ] **Step 6: 게이트·커밋** — UI 게이트. `feat(ui): 인쇄 맨 뒤 부록에 단계별 평균 응답 시간 그래프`.

### Task 7: 라이브 검증 (US1–US4, 극단값, 목업 대조, 리포트 생성 시간)

`/live-verify`로 이 워크트리 바이너리(`cargo build -p handicap-worker` + 컨트롤러 `./target/debug/controller`, `just ui-build` 뒤 `--ui-dir ui/dist`) + 응답기. 결과는 `.superpowers/sdd/4a-live.md`.

- [ ] **Step 1: US1** — 응답기 둘(지연 20ms·200ms), 시나리오 빠른 스텝 → 느린 스텝, VU 4, 60초. 화면을 보기 전에 리포트 JSON에서 아무 초 하나의 `latency_by_second` 값과 그 초 창 둘(`n`·`mean_us`)을 적고 `|mean_us − (n_A·mean_A + n_B·mean_B)/(n_A+n_B)| ≤ 1`인지 확인(창 평균이 반올림된 값이라 생기는 차이의 상한 0.5 + 초 값 반올림 0.5). 화면: 「응답 시간 (ms)」 그래프 선 두 개, 그 초 툴팁 평균·p95 글자 = `latencyTooltipText(JSON ÷ 1000)`. 「p95 응답 시간 (ms)」 그래프가 리포트에 없다.
- [ ] **Step 2: US2·극단값** — 스텝 50개(이름 하나는 300자) 시나리오 짧은 run. 「스텝별로 보기」 접힘 → 펼침, 카드 50개, 폭 1440·1024·768·390에서 카드 rect 폭·300자 이름 칸 `scrollWidth > clientWidth`(말줄임 동작)·카드끼리 rect 무교차·`document.documentElement.scrollWidth <= innerWidth`를 표로 기록. 안내 글의 눈금 최댓값 = JSON 창 `mean_us` 최댓값 ÷ 1000을 `niceTicks`로 올린 값.
- [ ] **Step 3: 60초 칸·표본 전환** — ① 응답기 지연 61,000ms, `http_timeout_seconds: 90`, VU 2, 실행 시간 70초 run: JSON `latency_by_second`에 `p95_us == 60000000`·`capped: true`인 초가 있는지 확인 후 그래프 점이 60,000에 있고 툴팁 = `ko.report.latencyChart.cappedValue`, 안내 줄 `hintCapped`, 카드 = `ko.report.stepLatency.mean(\`${ko.report.stats.capped} ms\`)`, 인쇄 캡션 `ko.print.latencyChart.capped`(모두 `\u00a0` 든 `ko` 글자로 대조). ② 빠른 스텝 + 닫힌 포트(`http://127.0.0.1:1/`)로 보내는 스텝(즉시 실패) run — 즉시 실패가 요청 속도를 폭발시켜 로컬 포트를 고갈시키지 않게 VU 2 + `think_time: {min_ms: 100, max_ms: 100}`, 30초: 기본(통과한 요청)과 `?sample=all`의 `latency_by_second` 같은 초 `n`이 다른지 JSON으로 확인하고 화면 선이 바뀌는지 본다.
- [ ] **Step 4: US3 인쇄** — Step 1·2 run의 「인쇄용 보기」 표준판: 「시간에 따른 변화」 절에 응답 시간 그래프(60초 run은 1초 칸이라 범례 「p95」), 맨 뒤 서명란 바로 앞 「부록. 단계별 평균 응답 시간」(판정 행이 넘치는 run — 판정 기준 여러 개 — 에서는 「부록 1」·「부록 2」와 판정 글 「— 부록 1 참조」). 50단계 run에서 쪽별 rect가 본문 한계 안·카드가 쪽 경계에서 잘리지 않음, 헤드리스 Chrome `--print-to-pdf` + `pdfinfo` Pages == 화면 `.p-page` 수. 요약판에 그래프·부록 없음.
- [ ] **Step 5: US4** — Step 1 run과 지연을 바꾼 같은 시나리오 run을 비교 화면에서: 「평균 응답 시간 (ms)」 체크박스가 처음엔 꺼짐, 켜면 run마다 선.
- [ ] **Step 6: 목업 대조** — 목업 1·2(그래프 부분)·3·5와 스크린샷 대조(선 색·점선·범례 자리·격자 열·인쇄 카드 크기). 어긋나면 고치고(`fix(ui): …`) 실측을 기록.
- [ ] **Step 7: 리포트 생성 시간** — `report.rs` 테스트 모듈에 `#[ignore]` 테스트 `report_build_timing`(합성 행 3,600초 × 스텝 10개, 행마다 표본 100개·그중 실패 5개인 분포, `build_report` 5회 중앙값을 출력)을 쓰고 `cargo nextest run -p handicap-controller --run-ignored only report_build_timing --no-capture`로 잰다(두 측정이 같은 디버그 빌드면 된다). 기준선은 초별 합치기 루프 안 `merge_into`·`SecondLatency` 만들기를 건너뛰는 **커밋하지 않는 임시 편집**으로 한 번 더 재고, 그 편집만 원복(`git diff`에 타이밍 테스트만 남았는지 확인)한 뒤 타이밍 테스트를 커밋(`test(controller): 리포트 생성 시간 측정(무시 테스트)`). 두 값과 차이를 `.superpowers/sdd/4a-live.md`와 build-log 단락에.

## §B에 옮길 판단 (finish-slice가 roadmap §B 「(0) 확인 대기」로 — 승인 아님)

- (1) 인쇄 그래프의 칸 p95 = 칸 안 가장 느린 초의 p95(spec R-A8) — 범례에 뜻을 적음. 해소: 리포트 API에 칸 크기 인자.
- (2) 스텝별 작은 그래프는 Recharts가 아닌 SVG라 툴팁이 없다. 해소: (ㄱ) 「한 그래프」 보기를 Recharts로 더할 때 함께.
- (3) 격자 경계 Tailwind 640·1024px(목업 760·480px) — Task 7 실측 표 첨부.
- (4) 비교 겹쳐 보기의 「평균」 기본 꺼짐(기존 기본 선택 불변).
- (5) 혼자 남은 초는 점으로(화면 `r=2` 원, 작은 그래프·인쇄는 둥근 선 끝).
- (6) 60초 칸이 섞인 초·창의 평균은 「≥」·안내 줄로 하한임을 밝힌다(spec 정정 — ④a plan 검토가 찾은 빈틈).

## 연기 (spec §10 그대로)

(ㄱ) 한 그래프 보기, 실행 중 진행 차트의 응답 시간, 창 정수 p 칸의 µs화, ④b·④c 전체.
