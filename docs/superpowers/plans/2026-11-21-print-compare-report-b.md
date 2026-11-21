# 비교 보고서 슬라이스 B (단계별 그림·표 · 겹쳐 보기 · 속도 구간) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 비교 보고서 표준판에 3–6절(단계별 95% 응답시간 덤벨 · 단계별 오류 변화 표 · 겹쳐 보기 차트 · 응답 속도 구간 비교)을 넣고, 표가 쪽 경계에서 한 행만 남기고 나뉘지 않게 한다.

**Architecture:** 슬라이스 A가 만든 `RunModel`·`StepPair`(`ui/src/print/compare/`) 위에 절마다 순수 모델 함수 하나(`dumbbell.ts`·`errorTable.ts`·`overlay.ts`·`speedCompare.ts`)와 렌더 컴포넌트 하나를 얹는다. 표 블록이 1개(대조 표)에서 3개로 늘므로 `CompareDocument`의 표 배선을 id → 정의 표로 일반화한다. 쪽 나누기 한 행 규칙은 공용 `paginate`에 넣는다(측정 보고서 표에도 적용). 컨트롤러·엔진 무변경.

**Tech Stack:** TypeScript · React 18 · vitest(jsdom) · 인라인 SVG/CSS(`ui/src/print/print.css`).

**Spec:** `docs/superpowers/specs/2026-11-21-print-compare-report-design.md` — 이 계획은 **슬라이스 B**(§8.1의 3–6절, §9.1–§9.4, §13 「B」 몫)와 roadmap §B77 (0-0)의 사용자 결정 「한 행 넘김은 슬라이스 B에서」를 다룬다. 슬라이스 A 구현 중 spec 글자와 다르게 정한 것은 roadmap §B77 (0)이 우선한다.

REVIEW-GATE: APPROVED

(spec: 슬라이스 A 때 spec-plan-reviewer APPROVE · plan: 2라운드 뒤 APPROVE, 2026-11-21)

**시안(시각 기준):** `docs/superpowers/specs/assets/2026-11-05-a4-print-report/compare-report-v2.html` — 3–6절의 색·굵기·점 크기·선 굵기·칸 바탕은 이 파일의 CSS와 `<script>` 안 그리기 값을 그대로 옮긴다(working-rules §4). 화면을 그리는 task(3·5·6·7)의 brief에 이 경로를 **시각 기준**으로 넘긴다. 시안과 다르게 하는 곳은 spec §12와 이 계획의 「시안과 다른 곳」뿐이다.

## Global Constraints

- `crates/` 0-diff. `ui/src/compare/`·`ui/src/components/compare/` 0-diff. `ui/src/print/scenarioFacts.ts`·`buildPrintDoc.ts`·`stepTable.ts` 0-diff. `speedBands.ts`의 `buildSpeedModel` 본문 무변경(함수 추가·`export` 추가만). `chartModel.ts`·`components/ErrorChart.tsx`는 무변경.
- `paginate.ts`는 Task 1에서만 고친다. 측정 보고서의 기존 테스트는 Task 1이 이름을 적은 것(`paginate.test.ts`의 `float_noise_fits` 1건 + `pagedShell.test.tsx`의 파일 스냅샷 2개 재생성) 말고는 **한 글자도 고치지 않고** green.
- 슬라이스 A의 비교 보고서 테스트(`ui/src/print/compare/__tests__/`) 중 **표준판 블록 id 목록·절 번호를 글자 그대로 단언하는 곳**은 절이 끼면 값이 바뀐다 — 각 task가 고칠 곳을 줄 단위로 적었다. 그 밖의 기존 단언은 무수정 green.
- 낱말은 "이전/이후". "비슷" 규칙·하한은 `change.ts`의 `classifyChange`·`FLOOR`만 쓴다(경계 비교를 새로 쓰지 않는다 — ui/CLAUDE.md §인쇄 보고서).
- 환경 변수 값·데이터셋 값·헤더·본문은 어떤 출력 문자열에도 넣지 않는다. 새 절이 찍는 것은 단계 이름·응답 코드·건수·시간뿐이다.
- 렌더·`useMemo` 경로에서 throw 금지. **SVG 속성에 `NaN`·`Infinity`가 들어가지 않는다**(0으로 나누는 자리는 모델 함수에서 막는다).
- 사용자에게 보이는 모든 글(aria-label 포함)은 `ui/src/i18n/ko.ts`의 `ko.print.cmp.*`(측정 보고서 낱말은 기존 `ko.print.table`·`ko.print.speed`·`ko.print.chart` 재사용). 보고서 문체, 조사는 `ui/src/i18n/josa.ts`의 `josa()`. 번역투 명사구 금지(working-rules §8).
- 색만으로 뜻을 전하지 않는다: 분류는 기호 + 낱말, 차트 계열은 선 모양·빗금.
- 테스트는 `ui/src/**/__tests__/`에만. 단일 파일 실행은 `cd ui && pnpm test <이름>`(`--` 붙이지 않음). 커밋 전 `pnpm lint && pnpm test && pnpm build`(pre-commit이 돌린다) — 커밋은 단일 foreground 호출, `| tail` 금지, `--no-verify` 금지.
- ES2022까지만(`findLast` 등 금지). 결함을 변호하는 주석 금지(working-rules §7). 회귀 가드 테스트는 되돌려 확인(teeth check) 1회. `ko.*(n)` 자기참조 단언에는 리터럴 단언을 병기.
- 새 표 블록은 측정 시트와 쪽 렌더 **두 곳 모두**에서 같은 정의로 그려진다(Task 3의 표 정의 표가 보장).

## Review Focus

1. **두 run의 단계 id가 하나도 안 겹침**(시나리오를 통째로 바꿈) — 덤벨·오류 표의 모든 행이 한쪽 점·한쪽 값만 갖고 화살표·분류·`*`가 없다. `NaN`·"undefined"가 어디에도 없다. → Task 2·4 테스트.
2. **모든 단계의 p95가 0**(서브 ms) 또는 단계가 0개 — 축은 `0ms`–`1ms`, 점 x는 유한한 수, 단계가 0개면 3·4절을 생략하고 번호를 당긴다. → Task 2·3 테스트.
3. **한쪽 또는 양쪽 `windows`가 빔**(요청 0건 run) — 겹쳐 보기가 있는 쪽 선만 그리고, 읽는 법은 "오류가 없었다"가 아니라 「요청이 실행되지 않은 측정이 있어 비교하지 않았습니다」, SVG 속성에 `NaN` 없음. → Task 6 테스트.
4. **`speed_bands`가 한쪽에만 있음**(옛 리포트) — 6절 생략, 뒤 절 번호가 7·8 → 6·7. → Task 7 테스트.
5. **행이 1·2·3개인 표가 쪽 경계에 걸림** — `paginate`가 끝나고(무한 반복 없음), 빈 조각을 내지 않고, 한 행짜리 조각은 "새 쪽에서 시작해도 두 행이 함께 들어가지 않는 표"(행이 쪽 절반보다 큰 경우)와 행이 1개뿐인 표에서만 나온다. → Task 1 테스트.

## 시안과 다른 곳 (사용자 고지 — 마무리 때 roadmap §B에 옮긴다)

1. 덤벨은 통짜 SVG가 아니라 **표**다: 이름 칸(HTML) · 그림 칸(행마다 SVG) · 글자 칸(HTML). 쪽을 넘기려면 행이 따로여야 한다(spec §9.1). 시안의 좌표(이름 110 · 그림 320 · 글자 170 단위)는 칸 폭 34mm · 96mm · 50mm로 옮긴다.
2. 덤벨 글자 칸에 낱말(빨라짐/느려짐)을 항상 붙인다(spec §9.1 흑백 생존 — 시안은 %만).
3. 오류 표의 건수 칸은 화살표 뒤에서 줄바꿈을 허용한다(시안 `.cellchg`는 한 줄 고정 — 7자리 건수 둘이 한 줄에 안 들어간다). 각 숫자는 쪼개지지 않는다.
4. 겹쳐 보기의 이전 처리량 선은 점선, 이전 오류 막대는 빗금이다(spec §9.3 흑백 구분 — 시안은 색만 다름).
5. 속도 구간은 측정 보고서와 같은 표(막대 + 구간별 % 칸 + 막대 밖 실패 칸)다(spec §12의 13).
6. 표가 쪽 경계에서 나뉠 때 앞쪽·뒤쪽에 각각 **2행 이상**을 둔다(Task 1 — **사용자 결정 2026-11-21, 다시 묻지 않는다**: 2행. 3행은 앞쪽 아래가 더 비어 "첫 장이 휑해 보인다"는 이유로 기각. `paginate.ts` `KEEP_ROWS` 한 곳). 표를 통째로 다음 쪽에 넘길 때 그 표를 소개하는 앞 블록(예: 계단 표 앞 한 줄)은 앞쪽에 남는다 — 이번에는 고치지 않는다(§B에 기록: 비용 = 소개 줄과 표가 다른 쪽, 해소 = 블록에 "다음 블록과 붙이기" 표지).
7. 덤벨의 「비슷」 행은 시안대로 이후 점이 파랑이고 %를 적지 않는다(spec §9.1 글자는 "회색 점 둘"·"항상 부호 붙은 %" — 시안이 시각 기준). 낱말 "= 비슷"은 항상 있다.
8. 덤벨 기준선은 값이 축 범위 안일 때만 그린다(기준이 모든 단계 p95보다 훨씬 크면 축을 늘리지 않는다 — 점들이 왼쪽에 몰린다).
9. 오류 표에서 `*`가 붙은 칸은 바탕색이 없다(시안은 ④ 502 칸이 초록 — spec §12의 7이 그 단계를 "참고용"으로 바꿨으므로 좋아짐 색을 칠하지 않는다).
10. 겹쳐 보기의 "(측정 시간이 다릅니다 …)"는 차이가 묶음 한 칸과 긴 쪽의 5% 중 큰 값을 넘을 때만 적는다(spec은 "기간이 다르면" — 1–2초 차이로 매번 찍히지 않게).
11. 겹쳐 보기에서 요청이 0건인 측정이 있으면 읽는 법 줄은 「요청이 실행되지 않은 측정이 있어 비교하지 않았습니다.」다(spec §9.3 네 갈래에 없는 다섯째 — "이후에는 거의 없습니다"가 거짓이 된다).

---

## File Structure

| 파일 | 책임 |
|---|---|
| `ui/src/print/paginate.ts` (수정) | 표 조각 앞뒤 최소 2행 규칙 |
| `ui/src/print/compare/dumbbell.ts` (신규) | 단계별 p95 덤벨 모델(축 · 행 · 기준선) |
| `ui/src/print/compare/errorTable.ts` (신규) | 오류 변화 표 모델(열 선택·접기 · 칸 · 변화 · 각주) |
| `ui/src/print/compare/overlay.ts` (신규) | 겹쳐 보기 모델(공통 묶음 · 두 계열 · 읽는 법) |
| `ui/src/print/compare/speedCompare.ts` (신규) | 속도 구간 비교 모델(경계 같음/다름) |
| `ui/src/print/speedBands.ts` (수정) | `buildOverallBand` 추가 |
| `ui/src/print/compare/errorCells.ts` (수정) | `remainingStepIds` 추가(기존 함수 결과 불변) |
| `ui/src/print/compare/change.ts` (수정) | `valueTexts` `export`만 |
| `ui/src/print/compare/buildCompareDoc.ts` (수정) | `CompareDoc`에 네 모델, 블록 목록, 절 번호 |
| `ui/src/print/compare/tables.tsx` (신규) | 표 블록 정의 표(id → 제목·표 렌더·행 수) |
| `ui/src/print/compare/CompareDocument.tsx` (수정) | 표 정의 표로 시트·쪽 렌더, 새 블록 배선 |
| `ui/src/print/compare/components/{DumbbellTable,ErrorChangeTable,OverlayChart,SpeedCompareTable}.tsx` (신규) | 절 렌더 |
| `ui/src/print/print.css` (수정) | `p-cmp-db-`·`p-cmp-err-`·`p-cmp-ov-`·`p-cmp-spd-` 규칙 |
| `ui/src/i18n/ko.ts` (수정) | `ko.print.cmp.db`·`.err`·`.overlay`·`.speed`, `view.titles`에 절 제목 4개 |

테스트는 `ui/src/print/__tests__/`·`ui/src/print/compare/__tests__/`. 픽스처는 기존 `fixtures.ts`(`mkReport`·`scenarioYaml`)·`scene.ts`(`sceneModel`)를 쓴다.

**orchestrator 메모(디스패치 전)**: ① spec의 `## 사용자 스토리 (US)` 블록을 한 번 추출해 매 brief에 첨부 ② 화면 task(3·5·6·7) brief에 시안 경로를 "시각 기준"으로 ③ 매 prompt 첫 줄 `cd /Users/sgj/develop/handicap/.claude/worktrees/print-compare-report-b` ④ 모델: 기본 sonnet, Task 1(공용 쪽 나누기 — 측정 보고서 출력이 바뀜) code-quality 리뷰는 opus ⑤ **Task 3이 끝난 직후** 컨트롤러를 띄워 시안과 나란히 스크린샷 대조(working-rules §4) — Task 5·6·7 뒤에도 그 절만 한 번씩 ⑥ 커밋 꼬리말(Co-Authored-By 등)은 구현 세션이 받은 문구를 brief에 그대로 넘긴다(§B77 (0) 마지막 줄 — 하위 에이전트가 제 모델 이름을 적어 세 가지가 섞였다).

---

### Task 1: 표 조각 앞뒤 최소 2행 (`paginate`)

**Files:**
- Modify: `ui/src/print/paginate.ts`
- Test: `ui/src/print/__tests__/paginateKeepRows.test.ts` (신규), `ui/src/print/__tests__/paginate.test.ts` (`float_noise_fits` 1건만 수정), `ui/src/print/__tests__/__snapshots__/paged-standard.html`·`paged-summary.html` (재생성)

**Interfaces:**
- Produces: `export const KEEP_ROWS = 2;` · `paginate(blocks, bodyMm)` 시그니처·반환 타입 무변경.

**규칙** (행이 `n`개인 표, 조각이 `from`에서 시작하고 기존 방식으로 채운 끝이 `to`):
- **꼬리**: `rest = n - to`. `0 < rest < KEEP_ROWS`이면 `to2 = n - KEEP_ROWS`. `to2 - from >= KEEP_ROWS`이면 `to = to2`(뒤 조각이 2행이 된다). 아니면: `from === 0`이고 그 쪽에 이 표보다 앞선 항목이 있으면 **새 쪽에서 표를 처음부터 다시** 놓는다. 그 밖에는 기존 결과 그대로.
- **머리**: `to < n`이고 `to - from < KEEP_ROWS`이고 `from === 0`이고 그 쪽에 앞선 항목이 있으면 새 쪽에서 다시 놓는다.
- 새 쪽으로 옮기는 일은 표마다 최대 한 번이다(빈 쪽에서 시작한 표는 옮기지 않는다 → 반드시 끝난다). 한 행이 한 쪽보다 큰 표(`oversized`)의 동작은 그대로다.

- [ ] **Step 1: 실패하는 테스트 작성** — `paginateKeepRows.test.ts`

```ts
const atom = (id: string, heightMm: number): Block => ({ kind: "atomic", id, heightMm });
const table = (rowsMm: number[]): Block => ({ kind: "table", id: "t", titleMm: 8, headerMm: 6, rowsMm });
const slices = (r: ReturnType<typeof paginate>) =>
  r.pages.map((p) => p.filter((i) => i.kind === "tableSlice").map((i) => (i.kind === "tableSlice" ? [i.from, i.to] : [])));

it("KEEP_ROWS는 2", () => expect(KEEP_ROWS).toBe(2));
it("뒤에 한 행만 남으면 앞 조각에서 한 행을 넘긴다", () => {
  // 200 + 14 + 4×10 = 254 → 기존: [0,4) [4,5)
  expect(slices(paginate([atom("a", 200), table(Array(5).fill(10))], 259))).toEqual([[[0, 3]], [[3, 5]]]);
});
it("앞 조각이 2행을 못 지키면 표를 통째로 다음 쪽에", () => {
  // 210 + 14 + 2×15 = 254 → 기존: [0,2) [2,3)
  const r = paginate([atom("a", 210), table([15, 15, 15])], 259);
  expect(r.pages).toEqual([
    [{ kind: "atomic", id: "a" }],
    [{ kind: "tableSlice", id: "t", from: 0, to: 3, continued: false }],
  ]);
});
it("앞쪽에 한 행만 들어가면 표를 통째로 다음 쪽에", () => {
  // 230 + 14 + 10 = 254 → 기존: [0,1) [1,6)
  expect(slices(paginate([atom("a", 230), table(Array(6).fill(10))], 259))).toEqual([[], [[0, 6]]]);
});
it("빈 쪽에서 시작한 긴 표도 꼬리 한 행을 남기지 않는다", () => {
  // 14 + 24×10 = 254 → 기존: [0,24) [24,25)
  expect(slices(paginate([table(Array(25).fill(10))], 259))).toEqual([[[0, 23]], [[23, 25]]]);
});
it("행이 2개인 표는 나뉘지 않는다", () => {
  expect(slices(paginate([atom("a", 225), table([15, 15])], 259))).toEqual([[], [[0, 2]]]);
});
it("행 1개짜리 표·한 쪽보다 큰 행은 그대로 끝난다", () => {
  expect(slices(paginate([atom("a", 250), table([10])], 259))).toEqual([[], [[0, 1]]]);
  expect(slices(paginate([table([10, 250, 10])], 259))).toEqual([[[0, 1]], [[1, 2]], [[2, 3]]]);
});
it("빈 조각을 내지 않는다", () => {
  for (let n = 1; n <= 30; n++)
    for (const used of [0, 100, 200, 230, 244]) {
      const r = paginate([atom("a", used), table(Array(n).fill(10))], 259);
      const all = r.pages.flat().filter((i) => i.kind === "tableSlice");
      expect(all.every((i) => i.kind === "tableSlice" && i.to > i.from)).toBe(true);
      expect(all.at(-1)).toMatchObject({ to: n });
    }
});
```

(`atom("a", 0)`도 항목이므로 "앞선 항목이 있는 쪽"이다 — 위 반복문은 그 경우도 끝나는지만 본다.)

- [ ] **Step 2: 실패 확인** — `cd ui && pnpm test paginateKeepRows` → `KEEP_ROWS` import 실패.
- [ ] **Step 3: `paginate`에 위 규칙 구현.** 표 한 개를 놓는 부분을 "시작 쪽 상태를 받아 조각 목록을 내는" 안쪽 함수로 떼고, 머리·꼬리 규칙이 "다시 놓기"를 요구하면 새 쪽에서 한 번 더 부른다.
- [ ] **Step 4: `paginate.test.ts`의 `float_noise_fits`만 고친다** — 표 행을 `[15, 15, 15.000000001, 15, 15]`(5행)로 바꾼다. 단언(`to: 3`)은 그대로다. 이유: 4행이면 새 규칙이 꼬리 한 행을 막으려고 `to`를 2로 당긴다(이 테스트가 보려는 것은 부동소수 여유다).
- [ ] **Step 5: `pagedShell.test.tsx`의 파일 스냅샷 2개 재생성** — 두 픽스처 모두 2절 표의 첫 조각이 한 행(①)이라 머리 규칙이 표를 통째로 다음 쪽으로 옮긴다(리뷰어가 사본에서 실측: 표준판은 표 뒤 블록이 한 쪽씩 밀리고, 요약판 픽스처는 2쪽 → 3쪽). `cd ui && pnpm test pagedShell -u` 뒤 `git diff --stat ui/src/print/__tests__/__snapshots__/`로 두 파일만 바뀌었는지, `git diff`로 달라진 것이 **2절 표가 놓인 쪽과 그 뒤 블록의 쪽 위치뿐**인지(블록 안 마크업은 같다) 눈으로 확인한다. 테스트 파일(`pagedShell.test.tsx`) 자체는 고치지 않는다.
- [ ] **Step 6: 전체 확인** — `cd ui && pnpm test paginate` 통과, `cd ui && pnpm test` 전체 통과. 위에 적은 것(`float_noise_fits`·스냅샷 2개) 말고 다른 테스트가 깨지면 **멈추고 보고**한다(고치지 않는다 — 그 테스트가 한 행 조각을 기대한다는 뜻이라 판단이 필요하다).
- [ ] **Step 7: 되돌려 확인** — 꼬리 규칙 한 줄을 지우면 「뒤에 한 행만 남으면…」이 RED인지 보고 원복.
- [ ] **Step 8: 커밋** — `feat(ui/print): 표가 쪽 경계에서 한 행만 남기고 나뉘지 않게`

---

### Task 2: 덤벨 모델 (`dumbbell.ts`)

**Files:**
- Create: `ui/src/print/compare/dumbbell.ts`
- Modify: `ui/src/i18n/ko.ts` (`ko.print.cmp.db`)
- Test: `ui/src/print/compare/__tests__/dumbbell.test.ts`

**Interfaces:**
- Consumes: `stepPairs(before, after): StepPair[]`(`errorCells.ts` — 행 순서·`label`·`presence`), `RunModel.table.rows[].p95Ms`·`.executed`, `RunModel.criteria`, `classifyChange`·`FLOOR`(`change.ts`), `niceTicks`(`chartModel.ts`), `fmtMs`·`fmtMsExact`·`fmtBoundary`(`format.ts`).
- Produces:

```ts
/** 그림 칸 SVG 사용자 단위(시안 값). 그림 칸 폭 = PAD + PLOT_W + PAD. */
export const DB = { PLOT_W: 320, PAD: 16, ROW_H: 28, AXIS_H: 26, RAD: 5, NARROW: 22, MERGE: 4, TRI_GAP: 9, TRI_LEN: 7 } as const;
export type DbClass = "better" | "worse" | "similar";
/** arrow = 선 + 화살촉 · tri = 이후 점 바깥 삼각형 · dots = 점 둘 · merged = 겹친 점 하나 · single = 한쪽 점만 · none = 점 없음 */
export type DbShape = "arrow" | "tri" | "dots" | "merged" | "single" | "none";
export type DumbbellRow = {
  stepId: string;
  label: string;            // "① 로그인" (이전에만 있으면 번호 없음)
  note: string | null;      // "(이후 측정에 없음)" | "(이전 측정에 없음)"
  beforeMs: number | null;  // 그 단계가 없거나 실행 0회면 null
  afterMs: number | null;
  xBefore: number | null;   // DB.PAD + DB.PLOT_W * ms / axisMaxMs
  xAfter: number | null;
  cls: DbClass | null;      // 두 값이 다 있을 때만
  shape: DbShape;
  dir: -1 | 0 | 1;          // 이후가 왼쪽이면 -1
  valueText: string;        // "2.1초 → 1.5초 (−29%)"
  wordText: string;         // "빨라짐" | "느려짐" | "= 비슷" | ""
  crossText: string | null; // "기준 안으로" | "기준 초과"
};
export type DumbbellModel = {
  rows: DumbbellRow[];
  axisMaxMs: number;
  ticks: Array<{ ms: number; x: number; label: string }>;
  baseline: { ms: number; x: number; label: string } | null;
  legend: string;
};
export function buildDumbbell(before: RunModel, after: RunModel): DumbbellModel;
```

**규칙(테스트가 정하지 않는 것만)**
- 축: `maxMs` = 모든 점의 최댓값. `maxMs >= 1000`이면 초 눈금(`niceTicks(maxMs / 1000, 7)`, 글자 `ko.print.cmp.db.tickSec(n)` = "2초"), 아니면 ms 눈금(`niceTicks(maxMs, 7)`, "200ms"). `axisMaxMs` = 마지막 눈금(ms). 점이 하나도 없거나 `maxMs === 0`이면 눈금 `[0, 1]`ms.
- 모양: 두 값이 다 있고 `gap = |xAfter − xBefore|`일 때 — 비슷: `gap < DB.MERGE` → `merged`, 아니면 `dots` · 좋아짐/나빠짐: `gap >= DB.NARROW` → `arrow`, 아니면 `tri`. 한쪽만 → `single`, 둘 다 없음 → `none`.
- 글자: `fmtMs` 둘. 분류가 비슷이 아닌데 두 글자가 같으면 둘 다 `fmtMsExact`. 없는 쪽은 "–". 퍼센트 = `round(|after − before| / before × 100)`, 부호는 "−"(U+2212)/"+". `before === 0`이거나 비슷이면 괄호 없음. (비슷이 아닌 변화는 5%를 넘으므로 0%로 반올림되는 경우는 없다 — "1% 미만" 갈래를 만들지 않는다.)
- 기준선: 두 run의 `criteria?.max_p95_ms`가 같은 수이고, 어느 run의 `criteria.step_criteria`에도 `metric === "p95_ms"`가 없고, 그 값이 `axisMaxMs` 이하일 때만. 글자 `ko.print.cmp.db.baseline(fmtBoundary(ms))` = "기준 3초". `crossText`: 이전 > 기준 ≥ 이후 → "기준 안으로", 이전 ≤ 기준 < 이후 → "기준 초과".
- 범례: "○ 이전 · ● 이후 · 화살표 왼쪽 = 빨라짐, 오른쪽 = 느려짐", 기준선이 있으면 "┊ 기준"을 「이후」 뒤에 끼운다.

- [ ] **Step 1: 실패하는 테스트 작성.** 픽스처: 단계 6개(`s1`..`s6`), 리포트 단계의 `p95`를 아래 표대로(`mkReport`의 `ReportStepSpec.p95`), `sceneModel`로 두 `RunModel`.

```ts
// 시안 「화살표 방향 점검」 6사례 — 축 0–5초(최댓값 4,800ms)
const CASES: Array<[number, number, DbClass, DbShape, -1 | 0 | 1, string, string]> = [
  [1000, 1000, "similar", "merged", 0, "1.0초 → 1.0초", "= 비슷"],
  [1000, 1040, "similar", "merged", 1, "1.0초 → 1.0초", "= 비슷"],
  [1100, 950, "better", "tri", -1, "1.1초 → 0.95초 (−14%)", "빨라짐"],
  [1000, 1150, "worse", "tri", 1, "1.0초 → 1.2초 (+15%)", "느려짐"],
  [1200, 3400, "worse", "arrow", 1, "1.2초 → 3.4초 (+183%)", "느려짐"],
  [4800, 400, "better", "arrow", -1, "4.8초 → 0.40초 (−92%)", "빨라짐"],
];
it("시안 6사례", () => {
  const m = build(CASES);
  expect(m.axisMaxMs).toBe(5000);
  expect(m.ticks.map((t) => t.label)).toEqual(["0초", "1초", "2초", "3초", "4초", "5초"]);
  expect(m.ticks.map((t) => t.x)).toEqual([16, 80, 144, 208, 272, 336]);
  m.rows.forEach((r, i) => {
    const [, , cls, shape, dir, value, word] = CASES[i]!;
    expect([r.cls, r.shape, r.dir, r.valueText, r.wordText]).toEqual([cls, shape, dir, value, word]);
  });
  expect(m.rows[4]!.xBefore).toBeCloseTo(92.8, 6);
  expect(m.rows[4]!.xAfter).toBeCloseTo(233.6, 6);
});
```

그리고 각각 한 `it`:
  - 비슷인데 간격이 넓음(단계 하나, 1000 → 1040 — 축 0–1.2초, 간격 ≈ 10.7) → `shape: "dots"`.
  - 같은 글자·다른 분류: 1060 → 1140 → `valueText`가 `"1,060ms → 1,140ms (+8%)"`.
  - 서브 ms: 이전 0 · 이후 12 → `valueText`에 `(`가 없고 `wordText` "느려짐", `cls` "worse".
  - 한쪽에만 있는 단계: 이후에 없는 단계는 `note` "(이후 측정에 없음)"·`shape` "single"·`cls` null·`xAfter` null·`valueText` `"2.1초 → –"`, 행 순서는 이후 단계 뒤. 이전에 없는 단계는 `note` "(이전 측정에 없음)".
  - 한쪽 실행 0회(시나리오에는 있고 리포트 단계에 없음) → `single`, `note` null.
  - 기준선: 양쪽 `max_p95_ms: 3000` + 단계 기준 없음 → `baseline` `{ ms: 3000, label: "기준 3초" }`, 4800 → 2700 행 `crossText` "기준 안으로", 2000 → 3400 행 "기준 초과". 한쪽만 기준 / 값이 다름 / 한쪽에 `step_criteria: [{ metric: "p95_ms", … }]` / 기준이 축 밖(30000) → `baseline` null이고 모든 행 `crossText` null, `legend`에 "┊"가 없다.
  - **Review Focus 1**: 단계 id가 하나도 안 겹침 → 모든 행 `shape: "single"`, `JSON.stringify(m)`에 `"NaN"`·`"undefined"` 없음, 모든 `x*`가 null이거나 `Number.isFinite`.
  - **Review Focus 2**: 모든 p95가 0 → `axisMaxMs` 1, 눈금 글자 `["0ms", "1ms"]`, 모든 x가 `DB.PAD`(16). 단계 0개 → `rows` `[]`, 눈금 2개.

- [ ] **Step 2: 실패 확인** — `cd ui && pnpm test dumbbell` → 모듈 없음.
- [ ] **Step 3: `buildDumbbell` 구현 + `ko.print.cmp.db` 키**(`tickSec`·`tickMs`·`baseline`·`faster`·`slower`·`similar`·`crossIn`·`crossOver`·`onlyBefore`·`onlyAfter`·`none`·`legend`·`legendBaseline`). 분류는 `classifyChange("lower", before, after, FLOOR.ms)`.
- [ ] **Step 4: 통과 확인** — `cd ui && pnpm test dumbbell`.
- [ ] **Step 5: 커밋** — `feat(ui/print): 단계별 95% 응답시간 변화 모델`

---

### Task 3: 덤벨 절 렌더 + 표 블록 일반화 + 절 번호

**Files:**
- Create: `ui/src/print/compare/tables.tsx`, `ui/src/print/compare/components/DumbbellTable.tsx`
- Modify: `ui/src/print/compare/buildCompareDoc.ts`, `ui/src/print/compare/CompareDocument.tsx`, `ui/src/print/compare/components/CondTable.tsx`(id를 표 정의 표에서 받게), `ui/src/print/print.css`, `ui/src/i18n/ko.ts`(`view.titles.dumbbell`)
- Test: `ui/src/print/compare/__tests__/buildCompareDoc.test.ts`(절 번호 테스트 갱신 + 추가), `ui/src/print/compare/__tests__/CompareDocument.test.tsx`(추가), `ui/src/print/compare/__tests__/dumbbellTable.test.tsx`(신규)

**Interfaces:**
- Consumes: `buildDumbbell`·`DumbbellModel`·`DB`(Task 2).
- Produces:

```ts
// buildCompareDoc.ts
export type CompareDoc = { /* 기존 */ dumbbell: DumbbellModel; hasSteps: boolean /* stepPairs가 1개 이상 */ };
export type CmpTableId = "cmp:cond" | "cmp:db" | "cmp:err";
export const tableIds = (id: CmpTableId) => ({
  title: `${id}:title`, header: `${id}:header`, row: (i: number) => `${id}:row:${i}`,
});
export function sectionNo(kind: "standard" | "summary", present: { steps: boolean; speed: boolean }): {
  overview: string; kpi: string; dumbbell: string | null; errors: string | null;
  overlay: string | null; speed: string | null; cond: string | null; issues: string;
};
// tables.tsx
export type CmpTableDef = {
  rowCount: (doc: CompareDoc) => number;
  Title: (p: { no: string; continued: boolean; measure?: boolean }) => JSX.Element;
  Table: (p: { doc: CompareDoc; from: number; to: number; measure?: boolean }) => JSX.Element;
  no: (n: ReturnType<typeof sectionNo>) => string;
};
export const CMP_TABLES: Record<CmpTableId, CmpTableDef>; // 이 task는 "cmp:cond"·"cmp:db", "cmp:err"는 Task 5
```

- `CMP_IDS`는 **export와 세 필드 이름(`condTitle`·`condHeader`·`condRowId`)을 그대로 둔다**(기존 테스트 두 파일이 import한다) — 값만 `tableIds("cmp:cond")`에서 만든다. id 글자는 지금과 같다(`cmp:cond:title`·`cmp:cond:header`·`cmp:cond:row:<i>`).
- 절 번호: 표준판은 종합 1 · 핵심 지표 2 · (단계가 있으면) 덤벨 · (단계가 있으면) 오류 · 겹쳐 보기(**단계 유무와 무관하게 항상**) · (속도 구간이 있으면) 속도 · 대조 · 남은 문제를 **있는 절만 차례로** 매긴다. 요약판은 1 · 2 · 3(남은 문제), 나머지 null. 이 task에서는 오류·겹쳐 보기·속도 블록이 아직 없으므로 `sectionNo`는 **블록 목록에 실제로 든 절만** 센다 — 구현: `sectionNo`가 `STANDARD_SECTIONS`(절 키 배열, 이 task에서는 `["overview","kpi","dumbbell","cond","issues"]`)를 돌며 번호를 매기고, Task 5·6·7이 그 배열에 제 키를 끼운다.
- 블록(표준판): `cmp:kpi:note` 뒤에 `hasSteps`면 표 `cmp:db` + atomic `cmp:db:legend`. 요약판 블록은 그대로.
- `CompareDocument`: `MeasureSheet`와 `PageBody`의 표 갈래가 `CMP_TABLES[id]`의 `Title`·`Table`을 그린다(대조 표 하드코딩 제거). 모르는 표 id는 `null`. `blockClass`에 새 atomic id를 넣는다 — 절 제목을 가진 블록(`cmp:overlay`·`cmp:speed`, Task 6·7)은 `p-block p-cmp-b--section`, 표 뒤 덧붙임(`cmp:db:legend`, Task 5의 `cmp:err:notes`)은 `p-block p-cmp-b--note`(새 CSS 클래스를 만들지 않는다 — 이름에서 유도되는 `p-cmp-b--db` 같은 클래스는 `print.css`에 없어 위 간격이 0이 된다).
- **렌더**: `<table className="p-table p-cmp-db">`, 칸 폭 34mm · 96mm · 50mm.
  - 머리줄(`<thead>`, 측정 id `cmp:db:header`): 이름 칸 "단계", 그림 칸 = 눈금 축 SVG(`viewBox="0 0 352 26"`, **두 줄** — 윗줄(y 9)에 기준선 글자 "기준 3초"(글자 크기 8.5 — 시안. 기준선 x에서 `text-anchor="start"`, `x + 글자 수 × 8.5 > 352`이면 `"end"`), 아랫줄(y 21)에 눈금 글자 `text-anchor="middle"`; 기준이 눈금 값과 같아도 겹치지 않는다), 글자 칸 "이전 → 이후".
  - 행(측정 id `cmp:db:row:<i>`): 이름 칸 = `label`(2줄 `p-cmp-clamp2`) + `note`가 있으면 `<small>`. 글자 칸 = 첫 줄 `valueText`, 둘째 줄 굵은 `wordText` + `crossText`(줄마다 `white-space: nowrap`).
  - 그림 칸은 **두 겹**이다. `<td>`는 `position: relative; padding: 0`. ① 세로선 겹(HTML): 눈금마다 `<i className="p-cmp-db-grid" style={{ left: `${x / 352 * 100}%` }}>`(`position: absolute; top: 0; bottom: 0; border-left: 1px solid #eceef1`), 기준선이 있으면 `<i className="p-cmp-db-base">`(`border-left: 1px dashed #b42318`) — 칸 높이가 얼마든 위아래로 꽉 차서 행 사이에서 이어진다. ② 점·화살 SVG(`viewBox="0 0 352 28"`, `width="100%"`, `display: block`, 세로 가운데) — 이 SVG 안에는 **점(`<circle>`)·화살 선(`<line>`)·화살촉(`<path>`)만** 있다(눈금선은 SVG에 그리지 않는다).
  - SVG 값(시안 `drawDumbbell`): 이전 점 `#9aa1ad` r 5, 이후 점 `#3b4bc8`(나빠짐이면 `#b42318`), 화살 선·화살촉·삼각형 색 = 빨라짐 `#3b4bc8` · 느려짐 `#b42318`, 화살 선 굵기 2 — 이전 점 가장자리(`xBefore + dir×5`)에서 `tip − dir×6`까지, 화살촉 = 꼭짓점 `tip = xAfter − dir×6`·밑변 `tip − dir×7`·반높이 4.5, `tri` 모양은 꼭짓점 `xAfter + dir×(5+9)`. `merged` = 이후 점(파랑) 하나에 `stroke="#9aa1ad"` `stroke-width="3"`. 글자 색: 빨라짐 `--ok`, 느려짐 `--bad`, 비슷 `--sub`(기존 `p-cmp-ok`·`p-cmp-bad`·`p-cmp-same`).
  - 각 행 SVG에 `role="img"` + `aria-label`(= `valueText` + `wordText`).
- CSS는 `print.css` 비교 구역 끝에 `p-cmp-db-*`로. 범례 블록은 시안 `.legend` 값(7.5pt · `--sub`).

- [ ] **Step 1: 실패하는 테스트 작성**
  - **기존 단언 중 값이 바뀌는 곳(이 task가 고친다)**: `buildCompareDoc.test.ts`의 「표준판 id 순서」 목록(`cmp:kpi:note`와 `cmp:cond` 사이에 `"cmp:db"`, `"cmp:db:legend"`) · `CompareDocument.test.tsx`의 「절 번호는 1·2·3·4」(→ "3. 단계별 95% 응답시간 변화", "4. 측정 조건 대조", "5. 남은 문제"를 포함한 다섯 제목, 테스트 이름도 맞게)와 `"3. 측정 조건 대조 (이어짐)"`(→ `"4. …"`). 이 세 곳은 Task 5·6·7에서 다시 바뀐다. `CMP_IDS`를 쓰는 기존 단언은 무수정 통과.
  - `buildCompareDoc.test.ts`: 기존 `sectionNo("standard")` 단언 2줄을 새 시그니처로 바꾼다 — `sectionNo("standard", { steps: true, speed: false })` → `{ overview: "1", kpi: "2", dumbbell: "3", errors: null, overlay: null, speed: null, cond: "4", issues: "5" }`(이 task 시점), `{ steps: false, … }` → `dumbbell: null, cond: "3", issues: "4"`, `sectionNo("summary", …)` → `issues: "3"`·`cond: null`·`dumbbell: null`. 표준판 블록 id 순서에 `cmp:kpi:note` 다음 `cmp:db`, `cmp:db:legend`가 있고, 단계 0개 문서에는 둘 다 없다. `cmp:db` 블록의 `rowsMm.length === doc.dumbbell.rows.length`. 요약판 블록 id 집합에 `cmp:db`가 없다.
  - `CompareDocument.test.tsx`: 표준판 측정 시트에 `[data-measure="cmp:db:title"]`·`cmp:db:header`·`cmp:db:row:0`이 있고, 배치 뒤 쪽에 제목 "3. 단계별 95% 응답시간 변화"와 "4. 측정 조건 대조"가 보인다. 요약판에는 "단계별 95% 응답시간 변화"가 없다. `cmp:db:legend` 블록의 class에 `p-cmp-b--note`가 있다.
  - `dumbbellTable.test.tsx`: Task 2의 6사례 모델을 그려 — 행 6개, 행 SVG 안에서 `arrow` 행은 `<line>` 1개 + `<path>` 1개 + `<circle>` 2개, `tri` 행은 `<line>` 0개 + `<path>` 1개 + `<circle>` 2개, `merged` 행은 `<circle>` 1개, `single` 행은 `<circle>` 1개·`<path>` 0개. 모든 행의 그림 칸에 `i.p-cmp-db-grid`가 눈금 수(6)만큼. 컨테이너 `innerHTML`에 `"NaN"` 없음. 기준선이 있는 모델은 모든 행에 `i.p-cmp-db-base` 1개 + 머리줄에 "기준 3초", 없는 모델은 0개. `from=2, to=4`면 행 2개이고 `data-measure`는 `measure`일 때만 `cmp:db:row:2`·`cmp:db:row:3`.
- [ ] **Step 2: 실패 확인** — `cd ui && pnpm test compare`.
- [ ] **Step 3: 구현**(위 Interfaces·렌더 값대로).
- [ ] **Step 4: 통과 확인** — `cd ui && pnpm test compare`, `cd ui && pnpm test print`.
- [ ] **Step 5: 커밋** — `feat(ui/print): 비교 보고서에 단계별 95% 응답시간 변화 절`

(orchestrator: 이 커밋 직후 시안 대조 — 「마무리」 1번.)

---

### Task 4: 오류 변화 표 모델 (`errorTable.ts`)

**Files:**
- Create: `ui/src/print/compare/errorTable.ts`
- Modify: `ui/src/print/compare/errorCells.ts`(`remainingStepIds` 추가), `ui/src/print/compare/change.ts`(`valueTexts`에 `export`), `ui/src/i18n/ko.ts`(`ko.print.cmp.err`)
- Test: `ui/src/print/compare/__tests__/errorTable.test.ts`, `ui/src/print/compare/__tests__/errorCells.test.ts`(추가만)

**Interfaces:**
- Consumes: `StepPair`·`stepPairs`·`starFootnote`·`hasStar`(`errorCells.ts`), `classifyChange`·`FLOOR`·`valueTexts`(`change.ts`), `fmtCount`·`fmtPct`, `ko.print.table`(`codeNames`·`none`·`noneSub`·`notSent`·`residual`·`residualSub`).
- Produces:

```ts
// errorCells.ts
/** 「남은 문제」 항목에 걸린 단계 id — remainingIssues와 같은 선택 규칙을 공유한다. */
export function remainingStepIds(after: RunModel, pairs: StepPair[]): Set<string>;

// errorTable.ts
export const ERR_MAX_COLS = 5;
export type ErrCol = {
  key: string;                                   // "c503" | "other" | "none" | "notSent" | "residual"
  kind: "code" | "other" | "none" | "notSent" | "residual";
  label: string; sub: string | null; codes: number[];
};
export type ErrTone = "down" | "up" | "flat" | null; // 별이 붙은 칸은 null
/** null = "–"(양쪽 0이거나 그 단계에서 오류 계열이 아닌 코드) */
export type ErrCell = { before: string; after: string; starBefore: boolean; starAfter: boolean; tone: ErrTone } | null;
export type ErrChange = { cls: "better" | "similar" | "worse" | "reference" | "none"; glyph: "▼" | "=" | "▲" | ""; word: string };
export type ErrRow = {
  stepId: string; label: string; note: string | null;
  rate: { before: string; after: string; starBefore: boolean; starAfter: boolean };
  cells: Record<string, ErrCell>;
  change: ErrChange;
  remaining: boolean;
};
export type ErrorTableModel = { cols: ErrCol[]; rows: ErrRow[]; notes: string[] };
export function buildErrorTable(a: { before: RunModel; after: RunModel; pairs: StepPair[]; incomparable: boolean }): ErrorTableModel;
```

**규칙**
- **보이는 칸**(`StepPair.codes`의 한 항목 `x`): `x.code`가 `"notSent"`·`"residual"`·`0`이면 항상. 숫자 코드는 `x.starBefore || x.starAfter` 이거나 (`x.before > 0`이고 `classBefore`가 `counted`·`uncounted`·`unknown`) 이거나 (`x.after > 0`이고 `classAfter`가 그 셋). 그 밖의 칸(그 단계에서는 정상 응답인 코드)은 `null`("–") — 열이 있어도 정상 응답 건수를 오류 표에 찍지 않는다.
- **열**: 보이는 칸이 하나라도 있는 코드. 고정 열 = "응답 없음"(코드 0)·"보내지 않음"·"응답 받은 뒤 실패" 중 있는 것(접지 않는다). 코드 자리 = `max(ERR_MAX_COLS − 고정 열 수, 1)`. 코드가 자리보다 많으면 양쪽 합(보이는 칸만) 큰 순(동률은 코드 작은 순)으로 `자리 − 1`개를 남기고 나머지를 `other` 한 열로. 순서 = 남은 코드 오름차순 → `other` → 응답 없음 → 보내지 않음 → 응답 받은 뒤 실패. 코드 열의 `sub` = `ko.print.table.codeNames[code] ?? null`. 잔차 열 이름은 새 키 `ko.print.cmp.err.residual` = "응답 받은 뒤 실패"(`ko.print.table.residual`은 "그중: 응답 받은 뒤 실패" — 이 표에는 "그중"이 가리킬 앞 칸이 없다).
- **칸 글자**: `fmtCount`. `other` 칸 = 접힌 코드의 보이는 칸 합(별은 하나라도 있으면). `tone`: 별이 있으면 null, 이후 < 이전 `down`, > `up`, 같음 `flat`.
- **오류율**: 단계 행의 `count === 0 ? 0 : errorCount / count`. 실행되지 않은 쪽은 "–". 글자는 `valueTexts("pct", …)`(분류가 좋아짐/나빠짐인데 글자가 같으면 자릿수를 늘린다). 그 단계에 별 칸이 있는 쪽은 `starBefore`/`starAfter`.
- **변화**: `incomparable`이거나 한쪽이라도 실행되지 않음 → `{ cls: "none", glyph: "", word: "–" }`. 그 단계에 별이 있으면 `{ cls: "reference", glyph: "", word: "참고용" }`. 그 밖 `classifyChange("lower", 이전율, 이후율, FLOOR.error_rate)` → "▼ 좋아짐" / "= 비슷" / "▲ 나빠짐"(낱말은 `ko.print.cmp.change.*` 재사용).
- **`remaining`**: `!incomparable && remainingStepIds(after, pairs).has(stepId)`.
- **`note`**: 덤벨과 같은 "(이후 측정에 없음)"/"(이전 측정에 없음)"(`ko.print.cmp.db.onlyBefore`·`onlyAfter` 재사용).
- **`notes`**: ① `!incomparable && hasStar(pairs)`면 `starFootnote(pairs)` ② `other` 열이 있으면 `ko.print.cmp.err.otherNote(parts)` = "그 밖의 코드: 404 12건 → 0건, 409 3건 → 5건"(코드 오름차순, 보이는 칸 합).

- [ ] **Step 1: 실패하는 테스트 작성.** 기본 픽스처는 시안 2쪽 표(단계 5개: ② 429 360 → 360 · ③ 404 120 → 48 · ④ 이전 검사 없음 502 600건/이후 `assert: [200]` 0건 · ⑤ 503 2,880 → 0, 504 312 → 24).

```ts
it("시안 표", () => {
  const m = table(MOCK);
  expect(m.cols.map((c) => c.key)).toEqual(["c404", "c429", "c502", "c503", "c504"]);
  expect(m.cols[3]).toMatchObject({ label: "503", sub: "서버가 바쁨" });
  const r = (i: number) => m.rows[i]!;
  expect(r(0).cells.c404).toBeNull();
  expect(r(0).change).toEqual({ cls: "similar", glyph: "=", word: "비슷" });
  expect(r(1).cells.c429).toEqual({ before: "360", after: "360", starBefore: false, starAfter: false, tone: "flat" });
  expect(r(1).remaining).toBe(true);
  expect(r(2).cells.c404).toMatchObject({ before: "120", after: "48", tone: "down" });
  expect(r(3).cells.c502).toEqual({ before: "600", after: "0", starBefore: true, starAfter: false, tone: null });
  expect(r(3).rate).toMatchObject({ starBefore: true, starAfter: false });
  expect(r(3).change).toEqual({ cls: "reference", glyph: "", word: "참고용" });
  expect(r(4).cells.c503).toMatchObject({ before: "2,880", after: "0", tone: "down" });
  expect(r(4).change).toEqual({ cls: "better", glyph: "▼", word: "좋아짐" });
  expect(m.notes).toHaveLength(1);
  expect(m.notes[0]).toContain("600");
});
```

그리고 각각 한 `it`:
  - 접기: 코드 8종(401·403·404·409·429·500·502·503, 건수 서로 다름) + 응답 없음 + 보내지 않음 → 열 5개 = 건수 상위 코드 2개(오름차순) · `other` · `none` · `notSent`. `notes`의 마지막 줄이 접힌 코드 6개를 오름차순으로 담는다. 고정 열 3개(응답 받은 뒤 실패 포함) + 코드 3종 → 코드 자리 2 → 코드 1개 + `other`. 코드가 자리와 같으면 `other` 없음.
  - 별이 붙은 2xx: 이전 `assert: [201]`·200 1,000건 / 이후 검사 없음·200 1,000건, 다른 단계는 200 정상 → `c200` 열이 생기고, 그 단계 칸은 양쪽 별, **다른 단계의 `c200` 칸은 `null`**.
  - `expected` ↔ `uncounted`(별 없음) → 별 없는 칸, 변화는 `reference`가 아님.
  - 양쪽 다 오류 없음 → `cols` `[]`, 모든 행 `change.word` "비슷", `notes` `[]`.
  - 오류율 글자가 같은데 분류가 다름: 10,000건 중 오류 105 → 111(기본 글자는 둘 다 "1.1%", 차이 0.06%p ≥ 하한 · 5.7% → 나빠짐) → `rate.before !== rate.after`이고 `change.cls` "worse".
  - 한쪽에만 있는 단계 → `note`, 없는 쪽 오류율 "–", `change.cls` "none", 별 없음. **Review Focus 1**: 단계가 하나도 안 겹치는 짝 → 모든 행 `change.cls === "none"`, `JSON.stringify(m)`에 `"NaN"`·`"undefined"` 없음.
  - `incomparable: true` → 모든 행 `change.cls` "none"·`remaining` false, 별 각주 없음.
  - `errorCells.test.ts` 추가: `remainingStepIds`가 `remainingIssues` 항목이 가리키는 단계와 같다(문제 단계 1 + 줄지 않은 오류 단계 1 + 깨끗한 단계 1 → 크기 2). 기존 `remainingIssues` 테스트는 무수정 통과.

- [ ] **Step 2: 실패 확인** — `cd ui && pnpm test errorTable`.
- [ ] **Step 3: 구현.** `remainingStepIds`는 `remainingIssues` 안의 "문제 단계 + 추가 문장" 수집을 안쪽 함수로 떼어 둘이 같이 쓴다(선택 규칙 사본을 만들지 않는다).
- [ ] **Step 4: 통과 확인** — `cd ui && pnpm test errorTable`, `cd ui && pnpm test errorCells`.
- [ ] **Step 5: 커밋** — `feat(ui/print): 단계별 오류 변화 표 모델`

---

### Task 5: 오류 변화 표 렌더

**Files:**
- Create: `ui/src/print/compare/components/ErrorChangeTable.tsx`
- Modify: `buildCompareDoc.ts`(`CompareDoc.errors: ErrorTableModel`, 블록, `STANDARD_SECTIONS`에 `errors`), `tables.tsx`(`"cmp:err"`), `CompareDocument.tsx`(`cmp:err:notes`), `print.css`, `ko.ts`(`view.titles.errors`·머리 글)
- Test: `buildCompareDoc.test.ts`·`CompareDocument.test.tsx`(추가), `ui/src/print/compare/__tests__/errorChangeTable.test.tsx`(신규)

**Interfaces:**
- Consumes: `buildErrorTable`·`ErrorTableModel`(Task 4), `CMP_TABLES`·`tableIds`·`sectionNo`(Task 3).
- Produces: 블록 — 표준판 `cmp:db:legend` 뒤에 `hasSteps`면 표 `cmp:err`, `doc.errors.notes.length > 0`이면 atomic `cmp:err:notes`. 절 번호는 덤벨 다음.

**렌더**(시안 2쪽 「4. 단계별 오류 변화」)
- `<table className="p-table p-cmp-err">`, 칸 폭: 단계 34mm · 오류율 26mm · 코드 열들 = 남는 103mm 균등 · 변화 17mm. 코드 열이 0개면 묶음 머리 없이 3칸(단계 34mm · 오류율 · 변화 균등).
- 머리줄 2행(측정 id `cmp:err:header`는 `<thead>`): 1행 = 단계(`rowSpan 2`) · 오류율 + `<small>`"이전 → 이후"(`rowSpan 2`) · 묶음 "응답 코드별 건수" + `<small>`"(이전 → 이후)"(`colSpan = 열 수`) · 변화(`rowSpan 2`). 2행 = 열 `label` + `sub`(`<small>`). 머리 칸은 `word-break: keep-all`.
- 칸: `null` → "–"(`p-muted`). 그 밖 = `<span>이전[*] →</span> <b>이후[*]</b>` — 두 조각 각각 `white-space: nowrap`, 조각 사이에서만 줄바꿈. 바탕: `down` `--okbg` · `up` `--badbg` · `flat` `#f4f5f7`(기존 `p-cmp-chg--better`·`--worse`·`--flat` 값과 같다 — 같은 색 변수를 쓰는 `p-cmp-err-cell--*`).
- 오류율 칸 = "27.0% → 0.2%"(별 포함), 한 줄 고정.
- 변화 칸 = `glyph word`(색 `p-cmp-ok`·`p-cmp-same`·`p-cmp-bad`, 참고용·"–"는 `p-cmp-same`) + `remaining`이면 `<small>`"남은 문제".
- 단계 칸 = `label`(2줄 clamp) + `note`.
- `cmp:err:notes` = `<div className="p-cmp-note">` 줄들(시안 `.note` 7.5pt).

- [ ] **Step 1: 실패하는 테스트 작성**
  - **값이 바뀌는 기존 단언(Task 3이 적은 세 곳 + Task 3의 `sectionNo` 기대값)**을 이 task 값으로 고친다: id 목록에 `"cmp:err"`(각주가 있는 픽스처면 `"cmp:err:notes"`도), 제목 "4. 단계별 오류 변화"·"5. 측정 조건 대조"·"6. 남은 문제", `"5. 측정 조건 대조 (이어짐)"`.
  - `buildCompareDoc.test.ts`: 절 번호 `{ steps: true, speed: false }` → 덤벨 "3" · 오류 "4" · 대조 "5" · 남은 문제 "6". 블록 순서 `… cmp:db, cmp:db:legend, cmp:err, (cmp:err:notes), cmp:cond …`; 각주가 없는 짝에는 `cmp:err:notes`가 없다. `cmp:err:notes` 블록 class에 `p-cmp-b--note`.
  - `CompareDocument.test.tsx`: 측정 시트에 `cmp:err:title`·`cmp:err:header`·`cmp:err:row:0`, 쪽에 "4. 단계별 오류 변화".
  - `errorChangeTable.test.tsx`(Task 4의 시안 픽스처 모델): 머리 2행 — 1행에 `colSpan="5"` 칸 1개, 2행 칸 5개("503"과 "서버가 바쁨" 포함). ④ 행 502 칸 글자가 `600* → 0`(공백 정규화 뒤), ① 행 코드 칸은 전부 "–". ⑤ 행 변화 칸 "▼ 좋아짐", ② 행 변화 칸에 "남은 문제". 코드 열 0개 모델 → `<th colSpan>` 묶음 머리가 없고 머리 1행. `from=1, to=3` → 행 2개, `data-measure` = `cmp:err:row:1`·`cmp:err:row:2`(measure일 때만).
- [ ] **Step 2: 실패 확인** — `cd ui && pnpm test compare`.
- [ ] **Step 3: 구현.**
- [ ] **Step 4: 통과 확인** — `cd ui && pnpm test compare`, `cd ui && pnpm test print`.
- [ ] **Step 5: 커밋** — `feat(ui/print): 비교 보고서에 단계별 오류 변화 절`

---

### Task 6: 겹쳐 보기 (모델 + 렌더)

**Files:**
- Create: `ui/src/print/compare/overlay.ts`, `ui/src/print/compare/components/OverlayChart.tsx`
- Modify: `buildCompareDoc.ts`(`CompareDoc.overlay: OverlayModel`, atomic `cmp:overlay`, `STANDARD_SECTIONS`에 `overlay`), `CompareDocument.tsx`, `print.css`, `ko.ts`(`ko.print.cmp.overlay`, `view.titles.overlay`)
- Test: `ui/src/print/compare/__tests__/overlay.test.ts`, `ui/src/print/compare/__tests__/overlayChart.test.tsx`, `buildCompareDoc.test.ts`(추가)

**Interfaces:**
- Consumes: `runT0`·`pickBinSeconds`·`niceTicks`·`timeTicks`·`fmtElapsed`·`markerX`·`CHART_W_MM`·`CHART_H_MM`·`PLOT_X0_MM`·`PLOT_X1_MM`(`chartModel.ts`, 이미 export), `formatDurationKo`(`ui/src/i18n/duration`), `RunModel.report.windows`·`RunModel.meta.started_at`.
- Produces:

```ts
export type OverlayBin = { startSec: number; seconds: number; rps: number; err: number }; // 둘 다 건/초
export type OverlaySide = { durationSec: number; bins: OverlayBin[]; errTotal: number; firstErrSec: number | null };
export type OverlayModel = {
  durationSec: number; binSeconds: number;
  before: OverlaySide; after: OverlaySide;
  hasErrors: boolean;
  rpsTicks: number[]; errTicks: number[]; timeTicks: number[];
  reading: string; durationNote: string | null;
};
export function buildOverlay(before: RunModel, after: RunModel, incomparable: boolean): OverlayModel;
```

**규칙**
- 쪽마다: `t0 = runT0(meta.started_at, windows)`, `durationSec = max(ts_second) − t0 + 1`(windows가 없으면 0, 묶음 `[]`). 전체 `durationSec` = 둘 중 큰 값(둘 다 0이면 0), `binSeconds = pickBinSeconds(전체)`(전체가 0이면 1). 묶음 수 = `ceil(그 쪽 durationSec / binSeconds)`, 마지막 묶음의 `seconds` = `min(binSeconds, durationSec − startSec)`. `rps`·`err` = 그 묶음의 `count`·`error_count` 합 ÷ `seconds`. `firstErrSec` = `err > 0`인 첫 묶음의 `startSec`.
- `hasErrors` = 어느 쪽이든 `errTotal > 0`. `rpsTicks = niceTicks(두 쪽 rps 최댓값, 5)`, `errTicks = hasErrors ? niceTicks(두 쪽 err 최댓값, 5) : []`, `timeTicks = timeTicks(전체)`.
- 읽는 법: **`incomparable`(한쪽이라도 요청 0건 — `buildCompareDoc`이 이미 계산한 값)이면 다른 갈래를 보지 않고** `ko.print.cmp.lines.incomparable`("요청이 실행되지 않은 측정이 있어 비교하지 않았습니다.") — 측정하지 않은 쪽을 "오류가 거의 없다/없었다"고 적지 않는다. 그 밖(spec §9.3 문장 그대로, `<N분>` = `firstErrSec`을 `fmtElapsed`로 — 0초는 `ko.print.chart.zeroSec`): 이전 `errTotal > 0`이고 이후 `errTotal <= 이전 × 0.05` → "이전에는 <N> 지점부터 오류가 쌓였지만, 이후에는 거의 없습니다." / 둘 다 > 0 → "두 측정 모두 오류가 있습니다(이전 <N>부터, 이후 <M>부터)." / 이후만 → "이후 측정에서 <M> 지점부터 오류가 생겼습니다." / 없음 → "두 측정 모두 오류가 없었습니다. 선은 1초에 처리한 요청 수입니다."
- `durationNote`: `|이전 − 이후| > max(binSeconds, 긴 쪽 × 0.05)`일 때 "(측정 시간이 다릅니다: 이전 10분, 이후 5분)"(`formatDurationKo`), 아니면 null.

**렌더**(atomic 블록 `cmp:overlay` = 절 제목 + 시안 `.box` 안에 SVG + 범례 + 읽는 법)
- SVG: `viewBox="0 0 180 55"`(`CHART_W_MM × CHART_H_MM`, 사용자 단위 mm), **`width="100%"`·높이는 비율대로**(고정 `180mm` 금지 — 쪽 본문 폭이 정확히 180mm라 상자의 padding·테두리만큼 넘친다). 세로 기하·글자 크기·눈금 그리기는 `components/ErrorChart.tsx`의 값(그림 위 8 · 아래 47 · 시간 글자 y 51.5 · 글자 2.3)을 같은 숫자로 쓴다(그 파일은 고치지 않는다).
- 처리량 선: 이전 `#9aa1ad` 굵기 0.5 `stroke-dasharray="1.5 1"`, 이후 `#3b4bc8` 굵기 0.5 실선. 점 x = `markerX(startSec + seconds / 2, 전체 durationSec)`. 묶음이 없는 쪽은 선을 그리지 않는다.
- 오류 막대(`hasErrors`일 때만 + 오른쪽 축): 묶음 폭 `w`에서 이전 막대 = `x0 + 0.1w`부터 폭 `0.38w`, 이후 막대 = `x0 + 0.52w`부터 폭 `0.38w`(시안 — 두 막대 사이 `0.04w`). 막대는 계열마다 `<rect>` **하나**이고 class `p-cmp-ov-bar`를 단다: 이전 = `fill="url(#p-cmp-ov-hatch)"`(`<defs>`의 `<pattern>` 안에 `#f0a49b` 바탕 + 45° 줄 `#b42318` 굵기 0.2), 이후 = `fill="#b42318"`. 높이 0인 막대는 그리지 않는다.
- 범례: "┅ 이전 처리량 · ━ 이후 처리량 · ▨ 이전 오류(건/초) · ■ 이후 오류(건/초)"(견본은 선·칸 조각으로), `hasErrors`가 false면 오류 견본 대신 "두 측정 모두 오류 없음". 끝에 `durationNote`.
- `role="img"` + `aria-label` = `ko.print.cmp.overlay.aria`.

- [ ] **Step 1: 실패하는 테스트 작성.** 도우미 `win(sec, count, err)`로 `windows`를 만들고(`step_id: "s1"`, `status_counts: {}`, 백분위 0) `mkReport` 결과에 덮어쓴다.
  - 공통 묶음: 이전 60초 · 이후 1,800초 → `binSeconds` 15(= `pickBinSeconds(1800)`), 이전 묶음 4개 · 이후 120개, `durationNote`에 "1분"과 "30분".
  - 묶음 값: 이전 10초(초마다 100건, 6초째부터 오류 10건) → `binSeconds` 1, `before.bins[5]` `{ startSec: 5, seconds: 1, rps: 100, err: 10 }`, `firstErrSec` 5, `errTotal` 50.
  - 읽는 법 네 갈래를 리터럴 글자로 단언. 경계: 이전 100건 · 이후 5건 → 첫 갈래("거의 없습니다"), 이후 6건 → 둘째 갈래.
  - 기간 차이 경계: 300초 vs 310초(묶음 5초, 5% = 15.5초) → null. 300초 vs 400초 → 글자 있음.
  - **Review Focus 3**: 이후 `windows: []`·`incomparable: true`(이전에는 오류가 있음) → `after.bins` `[]`·`durationSec`는 이전 값·`reading`은 리터럴 "요청이 실행되지 않은 측정이 있어 비교하지 않았습니다."(「거의 없습니다」·「없었습니다」가 들어 있지 않다). 둘 다 `[]`·`incomparable: true` → `durationSec` 0 · `binSeconds` 1 · `rpsTicks` `[0, 1]` · 같은 `reading`. 두 경우 모두 `JSON.stringify(m)`에 `"NaN"` 없음. 위 네 갈래 테스트는 `incomparable: false`.
  - `overlayChart.test.tsx`: 오류 있는 모델 → `<polyline>` 2개(하나는 `stroke-dasharray`), `<pattern>` 1개, `rect.p-cmp-ov-bar` 수 = 높이 > 0인 막대 수, `<svg>`의 `width` 속성이 `"100%"`. 오류 없는 모델 → `rect.p-cmp-ov-bar` 0개, 글자 "두 측정 모두 오류 없음". 둘 다 빈 모델 → `<polyline>` 0개, `innerHTML`에 `"NaN"` 없음.
  - **값이 바뀌는 기존 단언(Task 3이 적은 세 곳 + Task 3·5의 `sectionNo` 기대값)**을 고친다: id 목록에 `"cmp:overlay"`, 제목 "5. 시간에 따른 변화 — 겹쳐 보기"·"6. 측정 조건 대조"·"7. 남은 문제", `"6. 측정 조건 대조 (이어짐)"`. `cmp:overlay` 블록 class에 `p-cmp-b--section`.
  - `buildCompareDoc.test.ts`: 블록에 `cmp:overlay`가 오류 표(·각주) 다음, `cmp:cond` 앞 — 단계가 0개인 문서에도 있다. 절 번호 `{ steps: true, speed: false }` → 겹쳐 보기 "5" · 대조 "6" · 남은 문제 "7". `{ steps: false, … }` → 겹쳐 보기 "3".
- [ ] **Step 2: 실패 확인** — `cd ui && pnpm test overlay`.
- [ ] **Step 3: 구현.**
- [ ] **Step 4: 통과 확인** — `cd ui && pnpm test compare`.
- [ ] **Step 5: 커밋** — `feat(ui/print): 비교 보고서에 시간에 따른 변화 겹쳐 보기 절`

---

### Task 7: 응답 속도 구간 비교 (모델 + 렌더)

**Files:**
- Create: `ui/src/print/compare/speedCompare.ts`, `ui/src/print/compare/components/SpeedCompareTable.tsx`
- Modify: `ui/src/print/speedBands.ts`(`buildOverallBand` 추가), `buildCompareDoc.ts`(`CompareDoc.speed: SpeedCompare | null`, atomic `cmp:speed`, `STANDARD_SECTIONS`에 `speed`), `CompareDocument.tsx`, `print.css`, `ko.ts`(`ko.print.cmp.speed`, `view.titles.speed`)
- Test: `ui/src/print/__tests__/speedOverall.test.ts`(신규), `ui/src/print/compare/__tests__/speedCompare.test.ts`, `ui/src/print/compare/__tests__/speedCompareTable.test.tsx`, `buildCompareDoc.test.ts`(추가)

**Interfaces:**
- Consumes: `speedBands.ts` 안쪽 `barOf`·`rowTotal`·`pctCell`·`dash`·`cell`, `ko.print.speed`(`headFast`·`headIn`·`headWithin`·`headOver`·`headInMixed`·`headWithinMixed`·`headOverMixed`·`withinMerged`·`colBar`·`colFail`·`dash`), `fmtBoundary`·`fmtPct`.
- Produces:

```ts
// speedBands.ts — 판정 표시(빨강·✕·▲·별) 없이 전체 요청 한 줄. buildSpeedModel은 그대로.
export type OverallBand = {
  twoBand: boolean;
  bar: SpeedRow["bar"];          // 요청이 0건이면 null
  fast: SpeedCell | null;        // 두 구간이면 null
  within: SpeedCell; over: SpeedCell;
  fail: SpeedCell;               // errors / count, count 0이면 "–"
};
export function buildOverallBand(
  overall: SpeedBands["overall"],
  summary: Pick<Report["summary"], "count" | "errors">,
): OverallBand;

// compare/speedCompare.ts
export type SpeedCompareRow = { role: string; boundary: string | null; band: OverallBand; merged: boolean; mergedText: string | null };
export type SpeedCompare = {
  same: boolean; threeCols: boolean;
  head: { fast: string | null; within: string; over: string };
  rows: [SpeedCompareRow, SpeedCompareRow];
  legend: Array<{ band: BandName; text: string }>;
  warn: string | null;
};
export function buildSpeedCompare(before: RunModel, after: RunModel): SpeedCompare | null;
```

**규칙**
- `buildSpeedCompare`: 한쪽이라도 `report.speed_bands`가 없으면 `null`.
- `same` = 두 `overall`의 `slow_ms`·`basis`·(`fast === null`)이 모두 같음. `threeCols` = 한쪽이라도 `fast !== null`.
- `head`: `same`이면 측정 보고서와 같은 이름 — 두 구간 `{ fast: null, within: headIn(B), over: headOver(B) }`, 세 구간 `{ fast: headFast, within: headWithin(B), over: headOver(B) }`(`B = fmtBoundary(slow_ms)`). 다르면 `threeCols ? { headFast, headWithinMixed, headOverMixed } : { null, headInMixed, headOverMixed }`.
- 행: `role` = "이전"/"이후". `boundary` = 다를 때만 `ko.print.cmp.speed.boundary(B)` = "3초 기준". `merged` = `threeCols`인데 그 행이 두 구간 → 빠름·기준 안 두 칸을 합쳐 `mergedText = K.withinMerged(B, 비율)`.
- `legend`: `head`의 구간 이름(두 구간이면 fast·over 두 색, 세 구간이면 셋) — 측정 보고서 `buildSpeedModel`의 범례와 같은 색 대응.
- `warn`: 다를 때 "▲ 두 측정의 응답 시간 기준이 달라 구간을 그대로 비교할 수 없습니다."
- 렌더(atomic `cmp:speed` = 절 제목 "응답 속도 구간 비교 (전체 요청)" + 표 + 범례 + `warn`): `<table className="p-table p-speed p-cmp-spd">` — 칸: 측정(20mm — `role` + `boundary` `<small>`) · 막대(62mm, 기존 `p-speed-bar`·`p-speed-seg--*`) · 구간 칸들(균등) · 실패(22mm, `p-speed-fail`). 통과/미달 낱말·안내 상자·`p-bad`·`p-warn`은 없다.

- [ ] **Step 1: 실패하는 테스트 작성**
  - `speedOverall.test.ts`: 세 구간 `{ slow_ms: 3000, basis: "p95", own: false, fast: 580, within: 330, over: 90 }` + `{ count: 1000, errors: 26 }` → `twoBand` false, `bar` 비율 58·33·9, `fast.text` "58.0%", `over.text` "9.0%", `fail.text` "2.6%", 모든 칸 `mark === "none"`·`glyph === ""`·`star === false`(허용 몫 5%를 넘는 9%여도 표시 없음). 두 구간(`fast: null`) → `twoBand` true·`fast` null·막대 조각 2개. 구간 합 0 → `bar` null, 구간 칸 전부 "–". `count: 0` → `fail.text` "–". 기존 `speedBands.test.ts`·`speedBandTable.test.tsx`는 무수정 통과.
  - `speedCompare.test.ts`: 경계 같음(둘 다 3초·p95·세 구간) → `same` true, `warn` null, 두 행 `boundary` null, `head.within`이 `ko.print.speed.headWithin("3초")`와 같고 그 글자에 "3초"가 들어 있다. 경계 다름(3,000 vs 2,000) → `same` false, `boundary` "3초 기준"·"2초 기준", `warn`에 "기준이 달라", `head.over`가 `headOverMixed`. `basis`만 다름(p95 vs p99) → `same` false. 세 구간 vs 두 구간 → `threeCols` true, 두 구간 행 `merged` true·`mergedText`에 경계와 비율. **Review Focus 4**: 한쪽 `speed_bands` 없음 → `null`; 둘 다 없음 → `null`.
  - `speedCompareTable.test.tsx`: 행 2개("이전"·"이후"), 막대 조각 `i.p-speed-seg` 수, `merged` 행에 `colSpan="2"` 칸, 컨테이너에 `.p-bad`·`.p-warn` 0개(경고 줄 제외 — 경고 줄은 `p-cmp-warn`), "통과"·"미달" 글자 없음.
  - 기존 픽스처(`mkReport`)에는 `speed_bands`가 없으므로 Task 6까지의 번호 단언은 그대로다 — 이 task는 `speed_bands`를 가진 픽스처로 새 단언만 더한다. `cmp:speed` 블록 class에 `p-cmp-b--section`.
  - `buildCompareDoc.test.ts`: 양쪽에 `speed_bands`가 있으면 블록에 `cmp:speed`가 `cmp:overlay` 다음·`cmp:cond` 앞, 절 번호 `{ steps: true, speed: true }` → `{ overview: "1", kpi: "2", dumbbell: "3", errors: "4", overlay: "5", speed: "6", cond: "7", issues: "8" }`. 한쪽만 있으면 `cmp:speed` 블록이 없고 `{ steps: true, speed: false }` → 대조 "6" · 남은 문제 "7". `CompareDocument`가 `sectionNo`에 넘기는 `present`가 `{ steps: doc.hasSteps, speed: doc.speed !== null }`인지 — 속도 구간 없는 문서의 쪽에 "6. 측정 조건 대조"가 보인다.
- [ ] **Step 2: 실패 확인** — `cd ui && pnpm test speed`.
- [ ] **Step 3: 구현.**
- [ ] **Step 4: 통과 확인** — `cd ui && pnpm test print`(측정 보고서 테스트 무수정 통과 포함).
- [ ] **Step 5: 커밋** — `feat(ui/print): 비교 보고서에 응답 속도 구간 비교 절`

---

## 마무리 (orchestrator — 하위 에이전트 task가 아니다)

1. **시안 대조**(Task 3 직후, 그리고 5·6·7 뒤 그 절만): 워크트리 UI를 빌드하고(`cd ui && pnpm build`) 컨트롤러를 띄워(`crates/` 0-diff이므로 메인 바이너리 + `--ui-dir <워크트리 절대경로>/ui/dist` 가능 — working-rules §5) 시안 파일과 나란히 스크린샷. 색·점 크기·칸 바탕·글자 굵기가 시안과 다르면 그 task를 다시 연다.
2. **최종 리뷰**: `handicap-reviewer`(whole-branch). 보안: 새 절은 값을 새 sink로 옮기지 않는다(단계 이름·코드·건수는 슬라이스 A·측정 보고서가 이미 찍는다) — 그래도 `finish-slice` §0 grep을 직접 돌리고, 매치하면 `security-reviewer`.
3. **라이브 검증**(`/live-verify`, spec §13 「B」 몫):
   - US2: 실제 run 둘(이전 = 오류·느린 단계, 이후 = 개선)의 표준판에서 덤벨·오류 표·겹쳐 보기·속도 구간 숫자를 리포트 JSON과 대조.
   - US3: 한쪽에만 응답 코드 검사가 있는 짝 → 오류 표 칸의 `*`·변화 「참고용」·각주.
   - 쪽: 쪽마다 내용 bottom ≤ 본문 한계·가로 넘침 없음(rect), 헤드리스 `--print-to-pdf` + `pdfinfo` Pages == `.p-page` 수.
   - 극단값: 단계 30개 이상(덤벨·오류 표가 쪽을 넘기고 머리줄·「(이어짐)」 반복, 한 행만 남는 조각 없음) · 긴 단계 이름 · 응답 코드 8종 이상(접기) · **7자리 건수 칸**("1,234,567 → 2,345,678"이 칸 안에 — 넘치면 `ERR_MAX_COLS`를 4로) · 한쪽에만 있는 단계 · 요청 0건 run · 기간이 크게 다른 짝(1분 vs 30분) · `speed_bands` 경계가 다른 짝 · `letter-spacing: 0.12em`으로 1em 글꼴 흉내(덤벨 글자 칸 50mm · 오류 표 변화 칸 17mm · 속도 표 측정 칸 20mm).
   - **측정 보고서 회귀(Task 1)**: 2절 표·계단 표·3절 표가 쪽을 넘기는 run의 `/runs/:id/print` 표준판을 master 번들과 이 브랜치 번들로 열어 — 달라지는 것은 한 행 조각이 있던 표부터이고(그 표 앞쪽은 글자 단위로 같다), 그 뒤 블록은 밀릴 수 있으며 쪽 수는 최대 1 늘어난다. 한 행 조각이 없던 run은 `.p-doc` `outerHTML`이 같다. 1장에 들어가던 요약판은 그대로 1장. §B77 (0-0)의 대조 표 사례(2쪽에 「판정 기준 개수」 한 행)가 사라졌는지.
4. **기록**(`/finish-slice`): build-log, roadmap §B 새 블록(번호는 `grep -n '^### B' docs/roadmap.md` 마지막 + 1) — 「시안과 다른 곳」 6항과 진행 중 정한 것, spec 머리 상태 줄, §B77 (0-0)·(1) 완료 표시, 현황판, 상태줄.
