# verdict-stats ③c — 응답 시간 통계 표시·1ms 미만 µs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 리포트 화면에 「평균」 카드와 스텝 표 「응답 시간 통계 더 보기」(최소·평균·최대·표준편차·p90 + 「모든 스텝」 행)를 더하고, 요약 카드·스텝 표·워커 표·「다른 기준」 줄·머리말에서 1ms 미만은 「350 µs」, 60초 칸 값은 「≥ 60,000」으로 보이게 한다.

**Architecture:** UI만 바꾼다(서버 코드 0 — ③a가 리포트 JSON에 `stats` 블록을 이미 싣는다). 「이 칸을 어떻게 찍나」는 `ui/src/components/report/format.ts`의 순수 함수 하나(`latencyShown`)가 정하고, 표 칸 글자·단위 붙은 글자·머리말 문장이 그 결과를 각자 글자로 바꾼다. 인쇄·내보내기는 건드리지 않는다 — 인쇄와 함께 쓰는 `basisOtherLine`은 화면 쪽만 새 글자를 켜는 인자를 받는다.

**Tech Stack:** TypeScript(React·vitest·RTL).

REVIEW-GATE: APPROVED

**Spec:** `docs/superpowers/specs/2026-11-23-verdict-stats-a-design.md` — 이 plan은 ③c(R22·R23·R24)다. 요구 ID(R*)는 spec 것. 시각 기준 = 목업 `docs/superpowers/specs/2026-11-23-verdict-stats-a-mockups/a-screens.html` **3번**(요약 카드)·**4-가/4-나**(스텝 표 접힘·펼침)·**4-다**(접힌 표의 60초 칸·안내)·**5번**(1ms 미만 다섯 표면)·**6번**(머리말 60초 칸 문장)·**7번**(표본 표지와 단추가 함께 선 제목 줄). 3–7번은 ③c plan 검토 뒤 실제 화면 글자(「에러」·「측정 시간」·「메서드」·「요청 수」·표 제목 「스텝」·왼쪽 정렬)에 맞춰 고쳤다(2026-11-25).

US(spec 「사용자 스토리 (US)」에서 ③c가 끝까지 닿게 하는 것): **US1 끝부분**(평균 판정 행 실측 = 「평균」 카드), **US4**(스텝 표 통계 더 보기·「≥ 60,000」·안내), **US10**(1ms 미만 µs, 다섯 표면), **US11**(1ms 이상 화면 숫자·인쇄·내보내기 불변). §B95 (1)의 「60초 칸 「≥」·안내 라이브 미검증」(판정 표)도 Task 5 US4 라이브에서 함께 본다.

## Global Constraints

- 서버·와이어 0-diff: `crates/`·`ui/src/api/schemas.ts` 변경 없음. 이미 있는 와이어: `LatencyStats { min_us, mean_us, max_us, stdev_us, p50_us, p90_us, p95_us, p99_us, capped }`(µs 정수) — `ReportSummary.stats`·`ReportStep.stats`·`WorkerBreakdown.stats`·`report.basis.other.stats`, 모두 `.optional()`(표본이 없으면 키 없음). JSON의 `summary`·`steps`는 이미 「보여 주는 표본」 값이다(서버 `shown_summary`).
- `summary.mean_ms`는 서버가 `round(mean()/1000)`으로 내며 60초 칸에서는 60000을 넘을 수 있다(예 60015) — 화면은 `Math.min(summary.mean_ms, 60000)`을 쓴다(spec R22·R24).
- 시간 글자 규칙(R23·R24): `stats`의 그 µs 값이 없으면 **지금 글자 그대로**, 60,000,000 이상이면 고정 글자 `ko.report.stats.capped` = `"≥ 60,000"`, 1,000 미만이면 `formatLatency(us)`(「350 µs」), 그 밖은 정수 ms(지금 글자). 경계: 999µs → 「999 µs」, 1,000µs → 정수 ms.
- 화면 시간 값에 천 단위 쉼표를 새로 붙이지 않는다(사용자 결정 — 판정 표만). 「≥ 60,000」은 어디서나 같은 고정 글자. 표의 요청·오류 수도 지금처럼 맨 숫자.
- 인쇄·CSV·XLSX의 숫자는 그대로(US11): `ui/src/print/`·`export` 관련 파일 무수정. `basisOtherLine`은 인쇄(`print/buildPrintDoc.ts`)가 인자 없이 부르므로 인쇄 글자가 바뀌지 않아야 한다.
- 접힌 스텝 표: 1ms 미만·60초 칸 값이 없는 run이면 `<table>` DOM이 지금과 **같다**(spec §6.4 — 되돌려 확인 대상).
- 새 화면 문구는 `ui/src/i18n/ko.ts` 경유(ADR-0035), 낱말 「응답 시간」(띄어 씀)·「모든 스텝」(「전체」 금지).
- 연기(spec §10 그대로): 조건 반복 분리 아래 줄·대기·다운로드·준비 스텝·병렬 묶음은 `stats`가 없어 정수 그대로.
- UI 커밋 전 `cd ui && pnpm lint && pnpm test && pnpm build`(UI-only라 cargo 게이트는 돌지 않는다). `| tail` 금지, `--no-verify` 금지, 커밋 전 `git diff --cached --name-only`.
- `ui/src/`를 건드리는 task는 `tdd-guard`가 pending test를 요구한다 — 각 task의 첫 스텝이 테스트다.

## Review Focus

1. **옛 JSON(`stats` 없음)에서 글자가 바뀌는 것** — 다섯 표면 모두 `stats` 없는 픽스처에서 지금 글자와 같아야 한다(§B95 (2)가 스텝·`basis.other`의 이 경우를 테스트하지 않았다고 남겼다). 각 Task의 「stats 없음」 단언.
2. **인쇄 「다른 기준」 줄이 화면을 따라 바뀌는 것** — `basisOtherLine`을 인자 없이 부르면 `stats.p95_us = 350`이어도 「p95 0 ms」 그대로(Task 2 단언 + 되돌려 확인).
3. **표본 전환과 평균 카드** — `?sample=failed`로 받은 리포트에서 통과·실패 요청이 없으면 평균 카드도 「—」(p 카드와 같은 `noLatency` 규칙), 값이 있으면 받은 `summary`(보여 주는 표본)의 평균. Task 1.
4. **펼친 표의 열 수가 줄마다 어긋나는 것** — 조건 반복 분리 아래 줄·반복 나눔 펼침(`colSpan`)·대기·다운로드 열이 함께 있는 run에서 모든 행의 칸 수 = 머리 칸 수. Task 4.
5. **60초 칸 평균이 「≥ ≥」·「60015」로 찍히는 것** — 평균 µs가 60,000,000이면 카드 「≥ 60,000 ms」, 「모든 스텝」 칸 「≥ 60,000」. Task 1·4.

## 사실 확인 명령 (claims-ledger — 디스패치 전 orchestrator가 다시 돌린다)

```bash
grep -n "LatencyStatsSchema\|stats: LatencyStatsSchema" ui/src/api/schemas.ts          # 스키마 1개 + 네 곳 optional
grep -n "mean_ms: (" crates/controller/src/report.rs                                   # round(mean()/1000), 자르지 않음
grep -n "let shown_summary" -A 11 crates/controller/src/report.rs                      # 보여 주는 summary가 stats·mean_ms를 다시 낸다
grep -n "export function formatLatency" -A 4 ui/src/components/report/format.ts         # us < 1000 → "N µs"
grep -n "const ms = \|md:grid-cols" ui/src/components/report/Summary.tsx               # 카드 글자 `${v} ms`, 7/10열
grep -n "function latency\|const colSpan\|<table" ui/src/components/report/StepStatsTable.tsx
grep -n "<StepStatsTable" ui/src/components/report/StepPhaseBreakdown.tsx               # 두 곳(표 갈래·칩 보기)
grep -rn "<StepStatsTable\|<StepPhaseBreakdown" ui/src --include='*.tsx' | grep -v __tests__   # StepPhaseBreakdown 2 + ReportView 1
grep -n "function workerLatency" -A 5 ui/src/components/report/WorkerBreakdownTable.tsx
grep -rn "basisOtherLine(" ui/src | grep -v __tests__                                  # BasisBar(화면)·buildPrintDoc(인쇄)
grep -n "otherLine:" -A 2 ui/src/i18n/ko.ts                                            # p95: number | null
grep -n "formatSecondsKo(summary.p95_ms)\|formatLatencyKo(summary.p95_ms)" ui/src/components/report/ReportHeadline.tsx
grep -n "headlineLatency" ui/src/i18n/ko.ts                                            # 세 문장(통과·실패·모든 요청)
grep -n "role=\"note\"" -A 3 ui/src/components/report/VerdictPanel.tsx                 # 60초 안내 상자 클래스
grep -n "grid-cols\|getAllByRole(\"cell\")" ui/src/components/report/__tests__/Summary.test.tsx ui/src/components/report/__tests__/StepStatsTable.test.tsx
grep -n "worker_count" ui/src/api/schemas.ts                                           # open-loop 워커 수(라이브 워커 표용)
```

---

### Task 1: 화면 시간 글자 헬퍼 + 요약 카드 「평균」·µs·「≥」 (R22, R23 요약 카드, 목업 3번)

**Files:**
- Modify: `ui/src/components/report/format.ts`, `ui/src/components/report/Summary.tsx`, `ui/src/i18n/ko.ts`
- Test: `ui/src/components/report/__tests__/format.test.ts`, `ui/src/components/report/__tests__/Summary.test.tsx`

**Interfaces:**
- Produces (`format.ts`):
  - `export const CAP_US = 60_000_000;`
  - `export type LatencyShown = { kind: "ms"; ms: number } | { kind: "us"; text: string } | { kind: "capped" };`
  - `export function latencyShown(ms: number, us: number | undefined): LatencyShown` — `us === undefined` → `{kind:"ms", ms}`; `us >= CAP_US` → capped; `us < 1000` → `{kind:"us", text: formatLatency(us)}`; 그 밖 `{kind:"ms", ms}`.
  - `export function latencyCellText(x: LatencyShown): string` — 표 칸: `"43"` · `"350 µs"` · `ko.report.stats.capped`.
  - `export function latencyUnitText(x: LatencyShown): string` — 카드·문장: `"43 ms"` · `"350 µs"` · `` `${ko.report.stats.capped} ms` ``.
  - `export function meanShown(s: Pick<ReportSummary, "mean_ms" | "stats">): LatencyShown | null` — `stats` 없으면 null, 있으면 `latencyShown(Math.min(s.mean_ms, 60000), s.stats.mean_us)`. 카드와 「모든 스텝」 행이 함께 쓰는 단일 식(R22·R24).
- Produces (`ko.ts`): `ko.report.stats = { capped: "≥ 60,000", … }`(Task 3·4가 키를 더한다), `ko.report.cardMean: "평균"`, `ko.glossary.mean`·`stdev`·`p90`·`max`(문구 아래 Step 3).

- [ ] **Step 1: 실패하는 테스트 쓰기**
  - `format.test.ts` `describe("latencyShown")`: `(43, undefined)` → `{kind:"ms",ms:43}`; `(0, 350)` → `{kind:"us",text:"350 µs"}`; `(0, 999)` → 「999 µs」; `(1, 1000)` → `{kind:"ms",ms:1}`; `(59999, 59_999_999)` → `{kind:"ms",ms:59999}`; `(60030, 60_000_000)` → capped. `latencyCellText`: 「43」·「350 µs」·「≥ 60,000」. `latencyUnitText`: 「43 ms」·「350 µs」·「≥ 60,000 ms」. `meanShown`: `{mean_ms:1843, stats:{…mean_us:1_842_613}}` → ms 1843; `{mean_ms:60015, stats:{…mean_us:60_000_000, capped:true}}` → capped; `{mean_ms:0, stats:{…mean_us:350}}` → 「350 µs」; `stats` 없음 → null.
  - `Summary.test.tsx` `describe("평균 카드·µs (R22·R23)")`(카드 값은 라벨 div의 형제 div 글자로 읽는 도우미를 하나 둔다):
    - 카드 라벨 순서 = `[ko.report.cardTotalRequests, ko.report.cardErrors, ko.report.cardAvgRps, ko.report.cardDuration, ko.report.cardMean, "p50", "p95", "p99"]`(closed-loop — 기대값은 `ko` 상수로 만든다; 지금 글자는 「에러」·「측정 시간」이다).
    - 평균: `mean_ms 1843`·`stats.mean_us 1_842_613`·`capped:false` → 「1843 ms」; 같은 값 `capped:true` → 「≥ 1843 ms」(목업 3번); `mean_us 60_000_000`·`mean_ms 60015`·`capped:true` → 「≥ 60,000 ms」(「≥ ≥」·「60015」 아님); `mean_us 350` → 「350 µs」; `stats` 없음 → 「—」; `latency={{sample:"passed", counts:{count:5,errors:5,notSent:0}, switched:true}}` + stats 있음 → 「—」.
    - p 카드: `p95_ms 0`·`stats.p95_us 350` → p95 「350 µs」; `p99_ms 60030`·`stats.p99_us 60_000_000` → p99 「≥ 60,000 ms」; `stats` 없음·`p95_ms 43` → 「43 ms」(지금 글자).
    - 평균 카드 HelpTip 접근명 「평균 설명」이 있다.
  - 기존 `"uses md:grid-cols-10 … md:grid-cols-7"` 테스트를 `md:grid-cols-11`·`md:grid-cols-8`로(카드가 하나 늘었다 — Task 5에서 실측으로 바뀔 수 있다).
  - 기존 「요약 영역의 「—」가 3개」 단언 넷을 4개로: `latencyDash.test.tsx`의 요약 영역 단언 셋(`grep -n "toBe(3)"` 중 `region` 줄 — 지금 44·266·276행)과 `ReportView.test.tsx`의 `summary` 단언(지금 196행). 픽스처에 `stats`가 없어 평균 카드도 「—」가 되기 때문이다. 같은 파일의 표 행 단언(지금 109행은 스텝 표 — 접힌 표라 그대로, 127·140행은 워커 표 — 평균 칸이 없어 그대로)은 3 그대로.
- [ ] **Step 2: 실패 확인** — `cd ui && pnpm test format` · `pnpm test Summary` → 새 케이스 FAIL.
- [ ] **Step 3: 구현** — 위 Interfaces대로 `format.ts`. `Summary.tsx`: 기존 `ms(v)`를 `(v, us) => noLatency ? "—" : latencyUnitText(latencyShown(v, us))`로, p 카드에 `summary.stats?.p50_us` 등을 넘긴다. 「측정 시간」(`ko.report.cardDuration`) 카드 뒤·p50 앞에 평균 카드 `{ label: ko.report.cardMean, value, help: ko.glossary.mean }` — `value` = `noLatency`거나 `meanShown(summary)`가 null이면 「—」, 아니면 `(x.kind !== "capped" && summary.stats?.capped ? "≥ " : "") + latencyUnitText(x)`(`meanShown`이 null이 아니어도 TS는 `summary.stats`를 좁히지 않는다 — `?.` 없이 쓰면 `tsc -b`만 실패). 격자 `md:grid-cols-8` / open-loop `md:grid-cols-11`. glossary 문구:
  - `mean: "평균 — 응답 시간을 모두 더해 요청 수로 나눈 값입니다. 느린 응답 몇 건이 있어도 낮게 나올 수 있어 p95와 함께 보세요."`
  - `stdev: "표준편차 — 응답 시간이 평균에서 얼마나 흩어져 있는지입니다. 클수록 응답 시간이 들쭉날쭉합니다."`
  - `p90: "p90 — 요청의 90%가 이 시간 안에 응답했다는 뜻입니다. 낮을수록 좋습니다."`
  - `max: "최대 — 가장 느린 응답의 시간입니다. 60초를 넘긴 응답은 60초로 기록됩니다."`
- [ ] **Step 4: 통과 확인** — `pnpm test format` · `pnpm test Summary` · `pnpm test latencyDash` · `pnpm test sampleTag` PASS(뒤 둘은 요약 카드의 「—」 규칙을 이미 본다).
- [ ] **Step 5: 되돌려 확인** — ① 평균 카드 `x.kind !== "capped"` 조건을 지우면 「≥ ≥ 60,000 ms」로 RED, 원복. ② `latencyShown`의 `us >= CAP_US` 갈래를 지우면 p99 「≥ 60,000 ms」 RED, 원복.
- [ ] **Step 6: 게이트·커밋** — `cd ui && pnpm lint && pnpm test && pnpm build`. 커밋 `feat(ui): 요약에 평균 카드, 1ms 미만은 µs·60초 칸은 「≥ 60,000」`.

### Task 2: 워커 표·「다른 기준」 줄·머리말 (R23 나머지)

**Files:**
- Modify: `ui/src/components/report/WorkerBreakdownTable.tsx`, `ui/src/components/report/basisText.ts`, `ui/src/components/report/BasisBar.tsx`, `ui/src/components/report/ReportHeadline.tsx`, `ui/src/i18n/ko.ts`
- Test: `ui/src/components/report/__tests__/WorkerBreakdownTable.test.tsx`, `ui/src/components/report/__tests__/BasisBar.test.tsx`(또는 `basisText`를 직접 부르는 새 `__tests__/basisText.test.ts`), `ui/src/components/report/__tests__/ReportHeadline.test.tsx`

**Interfaces:**
- Consumes: Task 1의 `latencyShown`·`latencyCellText`·`latencyUnitText`·`ko.report.stats.capped`.
- Produces: `basisOtherLine(basis, sample, switched = false, screen = false)` — `screen`이 참일 때만 새 글자. `ko.report.basis.otherLine`의 셋째 인자를 `p95: string | null`(단위까지 붙은 글자, 예 「43 ms」)로 바꾸고 템플릿은 `` `p95 ${p95}` ``. `ko.report.headlineLatencyCapped`·`headlineLatencyFailedCapped`·`headlineLatencyAllCapped`(인자 없는 문자열).

- [ ] **Step 1: 실패하는 테스트 쓰기**
  - 워커 표(워커 2개 픽스처): `p50_ms 0`·`stats.p50_us 350` → 칸 「350 µs」; `p99_ms 60030`·`stats.p99_us 60_000_000` → 「≥ 60,000」; `stats` 없음 → 지금 글자(「0」, 「43」); 표본 `"passed"`·통과 0건 → 「—」 그대로.
  - `basisOtherLine`(픽스처 `other.count > 0`·`other.error_rate` 0.01 — `latencyDash.test.tsx`의 `error_rate: 1` 픽스처를 쓰면 통과 표본에서 「p95 —」가 되어 차이가 안 보인다): `other.p95_ms 0`·`other.stats.p95_us 350`일 때 `basisOtherLine(b, "passed")`(인쇄 호출 모양) → 「… · p95 0 ms · …」 **그대로**(US11), `basisOtherLine(b, "passed", false, true)` → 「p95 350 µs」; `p95_us 60_000_000` + screen → 「p95 ≥ 60,000 ms」; `stats` 없음 + screen → 「p95 43 ms」. `BasisBar` 렌더 → 「p95 350 µs」(화면이 `screen`을 켠다). 기존 `buildPrintDoc.test.ts` `"p95 90 ms"` 단언은 그대로 통과해야 한다.
  - 머리말(기존 테스트 파일의 렌더 도우미 사용): `p95_ms 0`·`stats.p95_us 350`·표본 전환 없음 → 문장에 「95%가 350 µs 안에 응답」; `latency.switched`·`sample "all"` 같은 값 → 「모든 요청의 95%가 350 µs 안에 끝남」; `p95_us 60_000_000`·`p95_ms 60030` → 「5% 이상이 60초를 넘겨 응답」(「60030」·「60초 이상 안에」 없음); 전환 `"failed"` 같은 값 → 「실패한 요청의 5% 이상이 60초를 넘겨 실패」; `"all"` → 「모든 요청의 5% 이상이 60초를 넘김」; `p95_ms 1234`·`stats.p95_us 1_234_567` → 지금 글자 「1.2초」(1ms 이상 불변); `stats` 없음·`p95_ms 0` → 지금 글자(`formatSecondsKo(0)`과 같음).
- [ ] **Step 2: 실패 확인** — `pnpm test WorkerBreakdownTable` · `pnpm test BasisBar`(또는 `basisText`) · `pnpm test ReportHeadline` → 새 케이스 FAIL.
- [ ] **Step 3: 구현**
  - 워커 표: `workerLatency`가 숫자 대신 `latencyCellText(latencyShown(ms, us))`를 돌려준다(「—」 갈래 그대로). p50·p95·p99에 `w.stats?.p50_us` 등.
  - `basisText.ts`: `noValue ? null : screen ? latencyUnitText(latencyShown(other.p95_ms, other.stats?.p95_us)) : \`${other.p95_ms} ms\``. `BasisBar`가 넷째 인자 `true`.
  - 머리말: `const p95x = latencyShown(summary.p95_ms, summary.stats?.p95_us)`. 전환 없음: ms → `formatSecondsKo(ms)`(지금, §B92 (0-1) 그대로), us → `x.text`, capped → `headlineLatencyCapped`. 전환 `failed`/`all`: ms → `formatLatencyKo(ms)`(지금), us → `x.text`, capped → `headlineLatencyFailedCapped`/`headlineLatencyAllCapped`. 문구: `headlineLatencyCapped: "5% 이상이 60초를 넘겨 응답"`, `headlineLatencyFailedCapped: "실패한 요청의 5% 이상이 60초를 넘겨 실패"`, `headlineLatencyAllCapped: "모든 요청의 5% 이상이 60초를 넘김"`(spec R23 정정 — 「60초 이상」을 값 자리에 끼우면 「95%가 60초 이상 안에 응답」이 된다). 같은 파일의 Props에서 `status` 칸이 `latency` 주석과 `latency` 칸 사이에 끼어 있는 것을 바로잡는다(§B95 (2) — 주석을 `latency` 바로 위로).
- [ ] **Step 4: 통과 확인** — 위 세 파일 + `pnpm test buildPrintDoc` PASS.
- [ ] **Step 5: 되돌려 확인** — ① `basisOtherLine`에서 `screen` 조건을 지워 늘 새 글자로 하면 인쇄 호출 단언 「p95 0 ms」 RED, 원복. ② 머리말 capped 갈래를 지우면 「60초를 넘겨」 단언 RED, 원복.
- [ ] **Step 6: 게이트·커밋** — `cd ui && pnpm lint && pnpm test && pnpm build`. 커밋 `feat(ui): 워커 표·다른 기준 줄·머리말도 1ms 미만 µs·60초 칸 표시`.

### Task 3: 스텝 표(접힌 상태) — p 칸 µs·「≥ 60,000」·안내·가로 스크롤 (R23 스텝 표)

**Files:**
- Modify: `ui/src/components/report/StepStatsTable.tsx`, `ui/src/i18n/ko.ts`
- Test: `ui/src/components/report/__tests__/StepStatsTable.test.tsx`

**Interfaces:**
- Consumes: Task 1 헬퍼.
- Produces: `ko.report.stats.cappedNoteCollapsed`·`cappedNoteExpanded`(문구 아래). 표는 `<div className="overflow-x-auto">` 안.

- [ ] **Step 1: 실패하는 테스트 쓰기** (`describe("µs·60초 칸 (R23)")`)
  - `p50_ms 0`·`stats.p50_us 350` → 그 칸 「350 µs」; `p99_ms 60030`·`stats.p99_us 60_000_000` → 「≥ 60,000」 + 표 아래 `role="note"` 글자 = `cappedNoteCollapsed`; 「≥」 칸이 없는 run → `queryByRole("note")` null; `stats` 없음 → 지금 글자.
  - **기존 스냅숏을 표로 좁히기**: `StepStatsTable.test.tsx`의 「loop_split이 없으면 DOM이 작업 전과 같다」(지금 253행)는 `container.innerHTML` 전체(`<section>…<h3 class="… mb-2">스텝</h3><table …>…</table></section>`)를 인라인 스냅숏으로 고정한다 — Task 3의 스크롤 상자 `div`, Task 4의 `titleAside`(`PageSection`이 `h3`를 `div`로 감싸고 `mb-2`를 뺀다)가 둘 다 이것을 깨뜨린다. **`vitest -u`로 다시 찍지 말 것**(지금 코드의 기준값을 버리게 된다). 그 리터럴을 `<table class="min-w-full text-sm">`부터 `</table>`까지 **글자 하나 바꾸지 않고 잘라** 파일 위쪽 상수(`const OLD_TABLE_HTML`, 리터럴에 `"`가 들어 있으므로 템플릿 문자열로)로 옮기고, 단언을 `expect(container.querySelector("section > div > table")!.outerHTML).toBe(OLD_TABLE_HTML)`로 바꾼다(지금 코드에선 `section > table`이라 RED — 이것이 이 task의 첫 RED 중 하나).
  - **표 DOM 동일(되돌려 확인 대상 — 보장은 `<table>`만: 머리 줄은 Task 4 단추로 늘 바뀐다)**: 같은 픽스처의 두 스텝에 1ms 이상·60초 칸 없는 `stats`(`p50_us 1_500`·`p95_us 2_500`·`p99_us 3_500`, 나머지 칸은 아무 값, `capped: false` — 정수 칸 1·2·3과 맞다)를 더해 렌더한 바깥 표 `outerHTML`도 `OLD_TABLE_HTML`과 같다. 기준값이 지금 코드로 찍힌 리터럴이라 둘 다 새 코드로 그린 두 벌을 비교하는 함정(`ui/src/components/report/CLAUDE.md`)이 없다. 그리고 그 표의 부모가 `overflow-x-auto` 클래스를 가진 `div`다(별도 단언).
  - 기존 `StepStatsTable.test.tsx`의 `rowsOf`(`:scope > section > table > tbody > tr`, 지금 299행)를 `:scope > section > div > table > tbody > tr`로 — 감싸는 `div` 때문에 0행이 되어 그 아래 다섯 테스트가 깨진다. 반복 나눔 펼침 안의 안쪽 `<table>`이 섞이지 않게 바깥 표만 고른다.
  - 통과 0건 표본 스텝(`sample "passed"`, count=errors) → p 칸 「—」 그대로.
- [ ] **Step 2: 실패 확인** — `pnpm test StepStatsTable` → 새 케이스 FAIL.
- [ ] **Step 3: 구현** — `latency(s, ms, sample)`를 `latency(s, ms, us, sample)`로 바꿔 값 갈래에서 `latencyCellText(latencyShown(ms, us))`. 렌더한 시간 칸 중 하나라도 `kind === "capped"`면 표 아래 안내(클래스는 `VerdictPanel.tsx`의 60초 안내 `<p role="note">`와 같은 문자열 — 그 파일에서 복사). 문구: `cappedNoteCollapsed: "「≥ 60,000」: 60초를 넘긴 응답이 있습니다. 그런 응답은 60초로 기록되므로 「≥ 60,000」인 값은 실제로 더 클 수 있습니다."`, `cappedNoteExpanded: "「≥ 60,000」: 60초를 넘긴 응답이 있습니다. 그런 응답은 60초로 기록되므로 이 스텝의 평균·최대·표준편차는 실제보다 작게 나온 값입니다."`(목업 4-나 글자 그대로 — Task 4가 쓴다). 접힌 표에는 평균·표준편차 칸이 없어 목업 글자를 그대로 쓰지 않는다(아래 §B (2)).
- [ ] **Step 4: 통과 확인** — `pnpm test StepStatsTable` · `pnpm test StepPhaseBreakdown` · `pnpm test latencyDash` PASS.
- [ ] **Step 5: 되돌려 확인** — `latency()`에서 `us`를 넘기지 않게(늘 `undefined`) 하면 µs·「≥」 단언 RED, 원복. 안내 조건을 `true`로 바꾸면 「안내 없음」 단언 RED, 원복. 모든 시간 `td`에 클래스 하나를 더하면 `OLD_TABLE_HTML` 단언 둘 다 RED, 원복.
- [ ] **Step 6: 게이트·커밋** — `cd ui && pnpm lint && pnpm test && pnpm build`. 커밋 `feat(ui): 스텝 표 p 칸도 1ms 미만 µs·60초 칸 「≥ 60,000」과 안내`.

### Task 4: 스텝 표 「응답 시간 통계 더 보기」 — 통계 열·「모든 스텝」 행 (R24, 목업 4-가/4-나)

**Files:**
- Modify: `ui/src/components/report/StepStatsTable.tsx`, `ui/src/components/report/StepPhaseBreakdown.tsx`, `ui/src/components/report/ReportView.tsx`, `ui/src/i18n/ko.ts`
- Test: `ui/src/components/report/__tests__/StepStatsTable.test.tsx`, `ui/src/components/report/__tests__/StepPhaseBreakdown.test.tsx`, `ui/src/components/report/__tests__/ReportView.test.tsx`

**Interfaces:**
- Consumes: Task 1 `latencyShown`·`latencyCellText`·`meanShown`, Task 3 안내.
- Produces: `StepStatsTable`·`StepPhaseBreakdown` props에 `summary?: ReportSummary`(보여 주는 summary). `ReportView`가 `summary={report.summary}`를 넘기고 `StepPhaseBreakdown`은 두 `<StepStatsTable>` 모두에 그대로 넘긴다. `ko.report.stats`에 `toggleMore: "응답 시간 통계 더 보기"`, `toggleLess: "응답 시간 통계 접기"`, `allSteps: "모든 스텝"`, `colMin: "최소 ms"`, `colMean: "평균 ms"`, `colMax: "최대 ms"`, `colStdev: "표준편차 ms"`.

- [ ] **Step 1: 실패하는 테스트 쓰기** (`describe("응답 시간 통계 더 보기 (R24)")`)
  - 기본: 단추 `getByRole("button", {name: "응답 시간 통계 더 보기"})`가 `aria-expanded="false"`, 머리 칸에 「최소 ms」 없음, 「모든 스텝」 행 없음. 단추는 표 제목(`stepsHeading`)과 같은 머리 줄에 있다(`PageSection` `titleAside`).
  - 누르면: `aria-expanded="true"`·접근명 「응답 시간 통계 접기」(▾/▸는 `aria-hidden`). 바깥 표(`:scope > section > div > table > thead th`)의 머리 칸 글자 순서 = `[ko.report.colStep, ko.report.colMethod, "URL", ko.report.colRequests, ko.report.colErrors, ko.report.stats.colMin, colMean, colMax, colStdev, "p50 ms", "p90 ms", "p95 ms", "p99 ms"]`(기대값은 `ko` 상수로 — 지금 글자는 「메서드」·「에러」; HelpTip 글자를 뺀 각 `th`의 첫 텍스트로 비교 — `평균`·`표준편차`·`p90`·`최대` 칸에 HelpTip `ko.glossary.mean`·`stdev`·`p90`·`max`).
  - 스텝 행 값(`stats = {min_us:840, mean_us:312_600, max_us:4_105_900, stdev_us:288_600, p50_us:210_000, p90_us:655_700, p95_us:890_000, p99_us:1_420_000, capped:false}`, `p50_ms 210` 등 — 반올림과 내림이 갈리는 값으로 골랐다): 최소 「840 µs」, 평균 「313」(반올림), 최대 「4105」(내림), 표준편차 「289」(반올림), p90 「655」(내림). `max_us 60_000_000`·`capped:true` → 최대 「≥ 60,000」 + 안내 글자 = `cappedNoteExpanded`. `stats` 없는 스텝 → 새 다섯 칸 「—」.
  - 「모든 스텝」 행(맨 아래): 요청 = `summary.count`, 오류 = `summary.errors`(맨 숫자), 평균 = `meanShown(summary)` 칸 글자(`mean_ms 1843` → 「1843」, `mean_us 60_000_000` → 「≥ 60,000」), 최소·최대·표준편차·p90 = `summary.stats`, p50·p95·p99 = `summary.pNN_ms` + `summary.stats.pNN_us`. `summary.stats` 없음 → 시간 칸 모두 「—」. `summary` prop 없음 → 행 없음.
  - 열 수 일치(Review Focus 4): 대기·다운로드 열이 있고 `loop_split`이 있고 `loop_breakdown`을 펼친 스텝이 있는 픽스처를 펼침 상태로 — **바깥 표만**(`:scope > section > div > table`; 반복 나눔 펼침 안의 안쪽 표는 자기 `th`·`tr`을 가진다) 모든 `tbody > tr`(반복 나눔 펼침 행 제외, 「모든 스텝」 행 포함)의 `td` 수 = 머리 `th` 수, 반복 나눔 펼침 행의 `td[colspan]` = 머리 `th` 수. 접힘 상태도 같은 단언.
  - 다시 접으면 Task 3의 `outerHTML` 같음 테스트 조건(접힌 표)이 그대로 성립(접기 → 표 `outerHTML` = 처음 렌더와 같음).
  - `StepPhaseBreakdown.test.tsx`: 측정 run(대기 있음)의 「칩」 보기로 바꾸면 단추가 있고 펼치면 「모든 스텝」 행이 있다(`summary` 전달), 「막대」 보기에는 단추가 없다. `ReportView.test.tsx`: 리포트 렌더 후 단추를 눌러 「모든 스텝」 행의 요청 수 = `report.summary.count`.
- [ ] **Step 2: 실패 확인** — `pnpm test StepStatsTable` · `pnpm test StepPhaseBreakdown` · `pnpm test ReportView` → 새 케이스 FAIL.
- [ ] **Step 3: 구현** — `const [statsOpen, setStatsOpen] = useState(false)`로 펼침(이름 주의: 이 파일엔 이미 반복 나눔용 `open`(`Set`)이 있고 `Set`은 늘 참이라 `{open && …}`로 잘못 쓰면 새 칸이 늘 보인다). 「모든 스텝」 행은 바깥 `tbody`의 마지막 행이고, 대기·다운로드 열이 있으면 그 칸은 빈 `td`. 단추는 `titleAside`에 `SampleTag`(있으면)와 함께 두고 `ml-auto`로 오른쪽(목업 `.toggle`: `rounded border border-slate-300 bg-white px-2.5 py-0.5 text-[13px] text-slate-600`). 새 칸(머리·스텝 행·「모든 스텝」 행)은 `bg-slate-50`(목업 `.statcol` `#f8fafc`). 「모든 스텝」 행은 `font-semibold`, 첫 칸들 `border-t border-slate-300`(목업 `tr.total`). 새 칸 정수: 최소·최대·p90 = `Math.floor(us/1000)`, 평균·표준편차 = `Math.round(us/1000)` — 모두 `latencyCellText(latencyShown(정수, us))`. 펼친 상태에서 조건 반복 분리 아래 줄은 오류 칸 뒤 빈 `td` 넷, p50과 p95 사이 빈 `td` 하나(값은 지금처럼 정수). `colSpan = 8 + (펼침 ? 5 : 0) + (anyDownload ? 3 : 0) + (anyWait ? 1 : 0)`. 안내 조건은 펼친 상태에서 새 칸·「모든 스텝」 행 칸까지 포함하고, 글자는 펼침이면 `cappedNoteExpanded`. 접힌 상태 `<table>` DOM은 Task 3과 같아야 한다(새 칸·행은 `{statsOpen && …}`로만 — Task 3의 `OLD_TABLE_HTML` 단언이 지킨다; 그 단언이 표만 보므로 이 task의 머리 줄 단추로는 깨지지 않는다).
- [ ] **Step 4: 통과 확인** — 위 세 파일 + `pnpm test latencyDash` · `pnpm test sampleTag` · `pnpm test StepStatsTable.badge` PASS.
- [ ] **Step 5: 되돌려 확인** — ① 아래 줄의 빈 `td` 넷을 지우면 열 수 일치 RED, 원복. ② 「모든 스텝」 평균을 `meanShown` 대신 `Math.round(stats.mean_us/1000)`로 바꾸면 `mean_ms 1843`·`mean_us 1_842_400` 픽스처(반올림 1842 — 카드와 같은 식인지 고정)에서 RED, 원복. ③ 스텝 평균을 `Math.floor`로, 최대를 `Math.round`로 바꾸면 각각 「313」·「4105」 단언 RED, 원복.
- [ ] **Step 6: 게이트·커밋** — `cd ui && pnpm lint && pnpm test && pnpm build`. 커밋 `feat(ui): 스텝 표 「응답 시간 통계 더 보기」 — 최소·평균·최대·표준편차·p90·모든 스텝`.

### Task 5: 라이브 검증 (US1 끝·US4·US10·US11, 극단값, 목업 대조)

`/live-verify`로 이 워크트리 바이너리 + 응답기. 이 슬라이스는 UI만 바꾸므로 `just ui-build` 뒤 컨트롤러 `--ui-dir ui/dist`. 결과는 `.superpowers/sdd/`에 기록(워크트리 루트에 `.md` 쓰기 금지).

- [ ] **Step 1: US10(1ms 미만)** — 응답기 지연 0(`responder.py <port> 0`, 단일 스레드라 몰아치면 1ms를 넘는다 — 아래처럼 속도를 늦춘다)으로 ① closed-loop run: VU 2, `think_time: {min_ms: 50, max_ms: 50}`, `ramp_up_seconds: 5`, `steady: {ramp_seconds: 5, hold_seconds: 20, discard_seconds: 0}`(유지 구간이 있어야 `basis`와 「다른 기준」 줄이 생긴다 — `crates/controller/src/steady.rs`가 closed-loop에 `ramp_up_seconds == steady.ramp_seconds`를 요구) ② open-loop run: `target_rps: 20`, `max_in_flight: 10`, `worker_count: 2`, 20초(워커 표용). **화면을 보기 전에** 각 리포트 JSON의 `summary.stats.p99_us < 1000`(②는 `worker_breakdown[*].stats`도)인지 확인 — 아니면 속도를 더 늦춰 다시. 확인: 요약 p50·p95·p99·평균 카드, 스텝 표 p 칸·펼친 다섯 칸·「모든 스텝」, 워커 표, 머리말 문장, ①의 「다른 기준」 줄 p95에 「NNN µs」. 같은 run ①의 인쇄 화면(「인쇄용 보기」)은 「다른 기준」 줄·KPI가 지금처럼 정수(US11).
- [ ] **Step 2: US1 끝** — 응답기 지연 40ms, `max_mean_ms: 100` run → 판정 표 평균 행 실측(소수 3자리)을 반올림한 값 = 「평균」 카드 숫자 = 펼친 「모든 스텝」 평균.
- [ ] **Step 3: US4(60초 넘는 응답)** — 응답기 둘(지연 40ms·61000ms), 시나리오 = 빠른 스텝 → 느린 스텝 → (그 뒤에) 보낸 요청이 없는 스텝을 만드는 조건 반복(`ui/src/components/report/CLAUDE.md`의 「보내지 않음」 요령: `variables: { etag: "" }` + 반복 본문 ① 응답에서 `etag`를 뽑는 빠른 스텝 ② 빈 값을 주소에 쓰는 스텝 — 반복을 느린 스텝 **뒤**에 둔다, 앞에 두면 반복이 끝나지 않아 느린 요청이 안 나갈 수 있다), VU 4, `http_timeout_seconds: 90`, 실행 시간 75초, `max_max_ms: 10000`·`max_mean_ms: 3000`. 엔진은 스텝 사이에서만 마감을 보므로(`crates/engine/src/runner.rs` `while Instant::now() < deadline`) 진행 중인 61초 요청은 잘리지 않는다. 느린 요청이 통과 표본의 5%를 넘으므로 p95·p99와 느린 스텝 평균은 60초 칸, 전체 평균은 반복 본문의 빠른 요청까지 섞여 60초 칸이 아니다(`stats.capped`만 참) — 전체 평균 숫자는 미리 정하지 말고 JSON `summary.stats.mean_us`에서 읽는다. 화면을 보기 전에 JSON에서 `summary.stats.p95_us == 60000000`인지 확인(아니면 느린 요청 비율이 부족 — 반복 횟수를 줄인다). 기대: 스텝 표 접힘 상태 느린 스텝 p 칸 「≥ 60,000」 + 접힘 안내, 펼침 느린 스텝 평균·최대 「≥ 60,000」 + 펼침 안내, 「모든 스텝」 최대 「≥ 60,000」·평균 = JSON 값의 정수 ms(「≥」 없음), 보낸 요청 없는 스텝 「—」, 요약 평균 카드 「≥ <같은 정수> ms」, p95·p99 카드 「≥ 60,000 ms」, 머리말 「5% 이상이 60초를 넘겨 응답」, 판정 표 최대·평균 행 「≥」 ✗ + 판정 표 안내(§B95 (1)). 리포트 JSON의 `summary.stats`를 함께 남겨 화면 글자와 대조.
- [ ] **Step 4: US11** — 이 브랜치는 `crates/`·`ui/src/print/`·`ui/src/api/`를 바꾸지 않는다: `git diff --stat $(git merge-base master HEAD)..HEAD -- crates ui/src/print ui/src/api` 출력이 비었는지 확인(CSV·XLSX 불변의 근거). 인쇄는 바뀐 `ko.ts` `otherLine`·`basisText.ts`를 함께 쓰므로 근거가 diff가 아니라 테스트다 — `buildPrintDoc.test.ts`의 「p95 90 ms」 단언과 Task 2의 인쇄 호출 단언이 green. 화면은 지연 40ms run에서 요약 p 카드·스텝 표 접힘 p 칸·워커 표·머리말 글자가 리포트 JSON의 정수 칸(`p50_ms` 등)과 같은지 대조(1ms 이상 글자 불변은 Task 3의 `outerHTML` 테스트가 고정). 인쇄 화면의 「다른 기준」 줄은 Step 1에서 본다.
- [ ] **Step 5: 극단값·목업 대조** — 폭 1440·1024·768·390에서: 요약 카드 줄(closed 8장·open-loop 11장, 값 「≥ 60,000 ms」·「≥ 1843 ms」·큰 총 요청 수)에서 카드 값 `scrollWidth <= clientWidth`와 카드 rect 무교차; 펼친 스텝 표(긴 스텝 이름·긴 URL·대기·다운로드 열 있는 측정 run의 「칩」 보기)가 가로 스크롤 상자 안에서만 넘치고 페이지는 가로로 넘치지 않음(`document.documentElement.scrollWidth <= innerWidth`); 머리 줄 단추가 제목·표본 표지와 겹치지 않음. 넘치면 격자를 `md:grid-cols-4 lg:grid-cols-8`(open-loop `lg:grid-cols-11`)처럼 단계로 나눠 고치고 Task 1 테스트의 격자 클래스를 함께 바꾼다(커밋 `fix(ui): …` + 실측 기록). 목업 3번·4-가·4-나와 스크린샷 대조(새 칸 바탕색·단추 모양·안내 상자).
- [ ] **Step 6: 기록** — 실측 값·스크린샷 경로를 `.superpowers/sdd/3c-live.md`에. 결함 fix 커밋이 있으면 각 커밋 전 UI 게이트.

## §B에 옮길 판단 (finish-slice가 이 슬라이스의 roadmap §B 항목 「(0) 확인 대기」로 옮긴다 — 승인 아님)

- (1) **머리말 60초 칸 문장**(spec R23 정정): 「95%가 60초 이상 안에 응답」은 말이 안 되어 문장을 「5% 이상이 60초를 넘겨 응답」(실패 표본 「실패한 요청의 5% 이상이 60초를 넘겨 실패」, 모든 요청 「모든 요청의 5% 이상이 60초를 넘김」)으로. 비용: 60초 칸 경계는 59.998초부터라 「넘겨」가 아주 조금 과장. 해소: 문구만.
- (2) **스텝 표 안내 문구 둘**: 펼친 표는 목업 글자, 접힌 표는 평균·표준편차 칸이 없어 「「≥ 60,000」인 값은 실제로 더 클 수 있습니다」로 따로. 비용: 문구 둘. 해소: 하나로 합치려면 `ko.report.stats` 한 키.
- (3) **카드의 60초 칸 글자에 단위**: 카드·「다른 기준」 줄은 「≥ 60,000 ms」(카드엔 열 머리 단위가 없다), 표 칸은 「≥ 60,000」. 평균 µs가 60,000,000이면(모든 표본이 60초 칸) 카드 「≥ 60,000 ms」·「모든 스텝」 칸 「≥ 60,000」(서버 `mean_ms` 60015를 그대로 찍지 않음).
- (4) **숫자 칸 정렬**: 목업은 숫자 칸 오른쪽 정렬(`.num`)이지만 지금 스텝 표는 왼쪽 정렬 — 기존 열과 맞춰 왼쪽 그대로(목업 머리 글 「나머지는 지금 화면 그대로」). 해소: 표 전체를 오른쪽 정렬로 바꾸려면 별도 소형 수정.
- (5) **「최소」 머리 칸에는 HelpTip 없음**(spec §6.7이 넷만 지정). 해소: `ko.glossary.min` 하나.
- (6) **카드 격자 열 수**: closed 8·open-loop 11 — Task 5 실측으로 바뀌었으면 그 값과 근거.
- (7) **머리말 단위 띄어쓰기**: 표본을 바꿔 볼 때 1ms 이상은 지금처럼 「44ms」(`formatLatencyKo`, 붙여 씀), 1ms 미만은 「350 µs」(`formatLatency`, 띄어 씀) — 한 문장 갈래 안에서 섞인다. 비용: 글자 모양만. 해소: `formatLatencyKo`를 띄어 쓰게(다른 화면 글자도 바뀜 — 별도).

## 연기 (이 plan에서 하지 않음 — spec §10 그대로)

조건 반복 분리 아래 줄·대기·다운로드·준비 스텝·병렬 묶음의 통계 칸·µs, 화면 나머지 숫자 쉼표, 인쇄·내보내기 정수 칸의 60030, 「다른 기준」 줄의 p50·p99·평균(줄이 p95만 찍는다 — 새 값을 더하지 않음), ④ 전체(시간대별 평균 그래프·인쇄 본문·CSV/XLSX·비교 화면의 통계 칸).
