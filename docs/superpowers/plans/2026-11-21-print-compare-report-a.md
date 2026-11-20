# 비교 보고서 슬라이스 A (틀 분리 · 1쪽 · 요약판) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** run 둘의 이전·이후 비교 보고서를 A4로 미리 보고 인쇄한다 — 표준판(종합 · 핵심 지표 비교 · 측정 조건 대조 · 남은 문제)과 요약판(1장).

**Architecture:** 측정 보고서의 "높이 재기 → 쪽 배치 → 쪽 그리기" 틀을 `PagedDocument`로 떼어 두 보고서가 같이 쓴다. 비교 내용은 run마다 기존 순수 함수로 측정 모델(`RunModel`)을 만들고, `(before, after)` 한 쌍만 받는 새 순수 함수들(`ui/src/print/compare/`)이 변화 판정·공정 비교·남은 문제를 낸다. 컨트롤러·엔진 무변경.

**Tech Stack:** TypeScript · React 18 · react-router · React Query · vitest(jsdom) · 인라인 SVG/CSS(`ui/src/print/print.css`).

**Spec:** `docs/superpowers/specs/2026-11-21-print-compare-report-design.md` — 이 계획은 그 문서의 **슬라이스 A**만 다룬다(§9.1·§9.3·§9.4와 §9.2의 표는 슬라이스 B, 별도 계획).

REVIEW-GATE: APPROVED

(spec: spec-plan-reviewer 4라운드 뒤 APPROVE · plan: 3라운드 뒤 APPROVE, 2026-11-21)

**시안(시각 기준):** `docs/superpowers/specs/assets/2026-11-05-a4-print-report/compare-report-v2.html` — 색·굵기·칸 폭·상자 모양은 이 파일의 CSS 값을 그대로 옮긴다(working-rules §4). 화면을 그리는 task(6·7)의 brief에 이 경로를 **시각 기준**으로 넘긴다.

## Global Constraints

- `crates/` 0-diff. `ui/src/compare/`·`ui/src/components/compare/` 0-diff. `ui/src/print/scenarioFacts.ts`·`speedBands.ts`·`buildPrintDoc.ts` 0-diff. `paginate.ts`의 `paginate`·`PAGE_BODY_MM` 무변경.
- 측정 보고서의 기존 테스트 파일은 **한 글자도 고치지 않고** green(`ui/src/print/__tests__/*`, `ui/src/pages/__tests__/RunPrintPage*.tsx`). `PrintDocument` 모듈 경로·export 이름, `.p-doc`·`data-layout-ready`·`aria-hidden` `.p-sheet` 마크업 유지.
- 낱말은 "이전/이후". 순서는 측정 시각 키 `(started_at ?? created_at, created_at, id)` 오름차순.
- "비슷" 규칙: 값 같음 → 비슷 · 차이 < 하한(오류율 `0.0005`, 응답시간 `5`ms, 처리량·건수 `0`) → 비슷 · `before > 0`이고 `|after − before| / before ≤ 0.05` → 비슷.
- 환경 변수 **값**·데이터셋 값·헤더·본문은 어떤 출력 문자열에도 넣지 않는다. 찍는 것은 환경 변수 **키 이름**뿐.
- 렌더·`useMemo` 경로에서 throw 금지: `ProfileSchema.safeParse`만(`normalizeProfile` 금지).
- 사용자에게 보이는 모든 글(aria-label 포함)은 `ui/src/i18n/ko.ts`의 `ko.print.cmp.*`. 보고서 문체(구어체 질문형 금지), 조사는 `(으)로`·`(이)가` 병기형.
- 테스트는 `ui/src/**/__tests__/`에만(vitest include). 단일 파일 실행은 `cd ui && pnpm test <이름>`(`--` 붙이지 않음). 커밋 전 `pnpm lint && pnpm test && pnpm build`(pre-commit이 돌린다) — 커밋은 단일 foreground 호출, `| tail` 금지, `--no-verify` 금지.
- ES2022까지만(`findLast` 등 금지). 판별 union은 인라인 판별 또는 타입가드 술어.
- 결함을 변호하는 주석 금지(working-rules §7). 회귀 가드 테스트는 되돌려 확인(teeth check) 1회.
- 색만으로 뜻을 전하지 않는다: 분류는 기호 + 낱말.

## Review Focus

1. **두 run 모두 `started_at`이 null**(대기 중 중단) — 순서는 `created_at`으로 정해지고 측정 일시는 "–", 문서는 그려진다. → Task 3 테스트.
2. **한쪽 `profile`이 `ProfileSchema`를 통과하지 못함** — 부하 조건 카드가 "▲ 설정을 읽을 수 없음", 나머지 절은 정상, throw 없음. → Task 5 테스트.
3. **한쪽 `scenario_yaml`이 깨짐** — 시나리오 카드 "▲ 시나리오를 읽지 못해 확인하지 못함", `*` 판정·남은 문제는 사실 없음(`null`)으로 계산, throw 없음. → Task 4·5 테스트.
4. **주소가 이상함** — `runs`에 같은 id 반복, `pair=a,a`, `pair`의 id가 `runs`에 없음, `runs`가 1개 → 중복 제거 뒤 기본 짝으로 되돌아가거나 "2개 이상 고르세요". → Task 3 테스트.
5. **두 run이 완전히 같은 값**(같은 리포트 둘, 요청 0건 둘) — 전부 "비슷"/"비교 불가", `NaN`·`Infinity`·"∞%"가 어디에도 없다. → Task 2·6 테스트.

---

## File Structure

| 파일 | 책임 |
|---|---|
| `ui/src/print/PagedDocument.tsx` (신규) | 문서 종류와 무관한 틀: 숨은 시트 렌더 → 높이 수집 → 배치 → 쪽 렌더 |
| `ui/src/print/PrintDocument.tsx` (수정) | 측정 보고서가 틀에 블록·시트·쪽 항목을 넘김(출력 불변) |
| `ui/src/print/paginate.ts` (수정) | `chooseSummaryLevel` 마지막 칸 번호 선택 인자 |
| `ui/src/print/compare/change.ts` | 지표 한 개의 변화 분류·글자, 핵심 지표 6행 |
| `ui/src/print/compare/pair.ts` | 주소 파라미터 + run 목록 → 짝과 순서 |
| `ui/src/print/compare/runModel.ts` | run 하나의 측정 모델(기존 함수 조립) |
| `ui/src/print/compare/errorCells.ts` | `*` 판정, 각주, 남은 문제 |
| `ui/src/print/compare/fairness.ts` | 공정 비교 카드 4장, 측정 조건 대조 행 |
| `ui/src/print/compare/headline.ts` | 종합 답, 요약 문장 |
| `ui/src/print/compare/buildCompareDoc.ts` | 위를 모아 `CompareDoc` + 블록 목록(표준·요약) |
| `ui/src/print/compare/CompareDocument.tsx` + `components/*.tsx` | 블록 렌더, 틀에 연결 |
| `ui/src/pages/ScenarioComparePrintPage.tsx` | 화면: 데이터·검사·도구 줄 |
| `ui/src/routes.tsx`, `ui/src/pages/ScenarioComparePage.tsx` (수정) | 경로 1개, 링크 1개 |
| `ui/src/print/print.css` (수정) | `p-cmp-` 접두 규칙 추가 |
| `ui/src/i18n/ko.ts` (수정) | `ko.print.cmp` |

테스트는 각 파일 옆 `__tests__/`(`ui/src/print/compare/__tests__/`, `ui/src/pages/__tests__/`).

**orchestrator 메모(디스패치 전)**: ① spec의 `## 사용자 스토리 (US)` 블록을 한 번 추출해 매 brief에 첨부 ② 화면 task(6·7·8) brief에 시안 경로를 "시각 기준"으로 ③ 매 prompt 첫 줄 `cd /Users/sgj/develop/handicap/.claude/worktrees/print-compare-report` ④ 모델: 기본 sonnet, Task 1(대형 리팩터)·Task 4·5(판정·env 값 취급) code-quality 리뷰는 opus.

---

### Task 1: 공용 틀 `PagedDocument` 분리 (출력 불변)

**Files:**
- Create: `ui/src/print/PagedDocument.tsx`
- Modify: `ui/src/print/PrintDocument.tsx`, `ui/src/print/paginate.ts`
- Test: `ui/src/print/__tests__/pagedShell.test.tsx` (신규), `ui/src/print/__tests__/paginateLevels.test.ts` (신규)

**Interfaces:**
- Produces:
  ```ts
  // paginate.ts — 제네릭 + 세 번째 인자(기본 8). 기존 호출·테스트((l: LadderLevel) => …, 인자 2개)는 그대로 컴파일된다.
  // (level: number) 시그니처로 바꾸면 strict 함수 인자 검사 때문에 기존 paginate.test.ts가 TS2345로 깨진다.
  export function chooseSummaryLevel<L extends number = LadderLevel>(
    blocksAt: (level: L) => Block[],
    bodyMm: number,
    lastLevel?: number,   // 기본 8
  ): { level: L; pages: PageItem[][]; fits: boolean; oversized: string[] };

  // PagedDocument.tsx
  export type Heights = Map<string, number>;
  export type PagedProps = {
    /** 이 값의 identity가 바뀌면 다시 잰다. */
    layoutKey: object;
    /** 숨은 측정 시트 안에 그릴 내용 — 높이를 잴 요소에 data-measure="<id>". */
    sheet: ReactNode;
    place: (h: Heights) => { pages: PageItem[][]; level: number };
    /** `.p-page` 안쪽 전부(꼬리말 포함)를 돌려준다. */
    renderPage: (items: PageItem[], ctx: { n: number; total: number; level: number }) => ReactNode;
    onLevel?: (level: number) => void;
  };
  export function PagedDocument(props: PagedProps): JSX.Element;
  ```
  `LadderLevel` 타입 export는 그대로 둔다(측정 보고서가 쓴다). `Heights`는 `buildPrintDoc.ts`가 이미 export하므로 `PagedDocument.tsx`는 그것을 다시 export한다(정의 한 곳).
  **effect 규칙**: `place`·`renderPage`·`onLevel`은 호출하는 쪽에서 렌더마다 새 함수다. 측정 effect의 의존값은 `[layoutKey]`뿐이고, `place`·`onLevel`은 최신 값 ref(`ui/src/components/ui/Modal.tsx`의 `onCloseRef` 방식)로 읽는다 — 의존값에 넣으면 `setLayout` → 새 `place` → effect 재실행이 끝없이 돌고, 빼기만 하면 `react-hooks/exhaustive-deps` 경고로 `pnpm lint`(`--max-warnings=0`)가 실패한다. `PrintDocument`는 `onLadder`를 감싸지 말고 그대로 `onLevel`에 넘긴다(타입은 `(level: number) => void`로 받을 수 있게 캐스트 한 번).

- [ ] **Step 1: 기준선 고정 테스트를 먼저 쓴다(리팩터 전 코드에서 green)** — `pagedShell.test.tsx`: `PrintDocument.test.tsx`의 픽스처 만드는 법을 따라(그 파일은 수정하지 않는다 — 필요한 최소 픽스처를 새 파일에 따로 만든다) 단계 3개짜리 run 하나로 `PrintDocument`를 `kind="standard"`와 `kind="summary"`로 각각 렌더하고, `data-layout-ready="true"`를 기다린 뒤 `container.querySelector(".p-doc")!.outerHTML`을 `await expect(html).toMatchFileSnapshot("./__snapshots__/paged-standard.html")`·`("./__snapshots__/paged-summary.html")`로 고정한다(`toMatchFileSnapshot`은 비동기 — `await` 필수). 측정 중 상태(`data-layout-ready="false"`)의 `.p-sheet`가 `aria-hidden="true"`인지도 단언. **시간대 무관하게**: `fmtDate`·`fmtTime`은 로컬 시각이고 CI는 UTC, 맥은 KST다 → 픽스처의 `started_at`·`ended_at`은 `null`, `now`는 `Date.UTC(2026, 10, 5, 12, 0, 0)`(어느 시간대에서도 같은 날짜), 창 구간(`windows`)의 시각은 화면에 날짜로 찍히지 않는 값만 쓴다. 스냅샷 글자에 시각(`HH:MM`)이 들어 있지 않은지 테스트에서 정규식으로 단언한다.
- [ ] **Step 2: `paginateLevels.test.ts`** — `chooseSummaryLevel`에 세 번째 인자를 준 새 동작만 검사:
  ```ts
  // 칸마다 높이가 10씩 줄어드는 블록: level L → 높이 300 - 10*L
  const at = (l: number): Block[] => [{ kind: "atomic", id: `b${l}`, heightMm: 300 - 10 * l }];
  expect(chooseSummaryLevel(at, 259, 5)).toMatchObject({ level: 5, fits: true });   // 250 ≤ 259
  expect(chooseSummaryLevel(at, 259, 3)).toMatchObject({ level: 3, fits: false });  // 270 > 259, 마지막 칸에서 멈춤
  expect(chooseSummaryLevel(at, 259).level).toBe(5);                                // 인자 2개 = 기본 8, 5에서 맞음
  ```
- [ ] **Step 3: 실행** — `cd ui && pnpm test pagedShell` → PASS(스냅샷 파일 생성), `pnpm test paginateLevels` → FAIL(세 번째 인자 무시: 둘째 단언이 level 5).
- [ ] **Step 4: 구현** — `chooseSummaryLevel`에 `lastLevel = 8` 추가. `PagedDocument`를 만들고 `PrintDocument`를 그 위로 옮긴다: `PrintDocument`는 `sheet`(지금의 `MeasureSheet`), `place`(지금의 `place`), `renderPage`(지금의 `PageView` 안쪽), `onLevel`(= `onLadder`를 감싸지 않고 캐스트 한 번으로 그대로)를 넘긴다. `layoutKey`는 `useMemo(() => ({ doc, kind }), [doc, kind])`. 틀이 내는 마크업은 지금과 글자 단위로 같아야 한다(`.p-doc`, `data-layout-ready`, `.p-sheet` + `SHEET_STYLE`, `.p-page`/`.p-page p-page--last`).
- [ ] **Step 5: 실행** — `pnpm test pagedShell paginateLevels` PASS(스냅샷 무변경 — 스냅샷을 `-u`로 갱신하지 않는다), 이어 `pnpm test`(전체) PASS, `pnpm build` PASS.
- [ ] **Step 6: 되돌려 확인** — `PagedDocument`의 쪽 클래스를 `p-page`에서 다른 글자로 잠깐 바꿔 `pagedShell`이 FAIL하는지 보고 원복.
- [ ] **Step 7: Commit** — 스냅샷 파일 두 개(`ui/src/print/__tests__/__snapshots__/paged-*.html`)를 반드시 함께 `git add`한다(CI는 없는 스냅샷을 새로 쓰지 않고 실패한다). `refactor(ui/print): 쪽 나누기 틀을 PagedDocument로 분리`

**orchestrator 준비(Task 1 디스패치 전)**: `cd ui && pnpm build` 뒤 `ui/dist`를 스크래치패드로 복사해 "이전" 번들로 보관한다(워크트리에서는 checkout으로 옛 커밋을 꺼낼 수 없다).

**orchestrator 게이트(이 task 리뷰 통과 직후, 다음 task 전에)**: 실제 배치에서도 같은지 라이브 대조 — 보관해 둔 **이전** `ui/dist`와 Task 1 **이후** 커밋에서 새로 빌드한 `ui/dist`로 같은 run의 `/runs/:id/print`(표준·요약)을 열어 `document.querySelector(".p-doc").outerHTML`을 뽑아 `diff`(차이 0줄) + 헤드리스 PDF 쪽 수 동일. run은 단계 12개 이상·오류 섞인 것 1개(`/live-verify` 스택). 결과를 build-log 초안에 적는다.

---

### Task 2: 변화 분류와 핵심 지표 6행

**Files:**
- Create: `ui/src/print/compare/change.ts`
- Modify: `ui/src/i18n/ko.ts` (`ko.print.cmp.metric`, `ko.print.cmp.change`), `ui/src/print/format.ts`(`pctText`·`rpsText`에 `export`만 추가)
- Test: `ui/src/print/compare/__tests__/change.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Direction = "lower" | "higher" | "neutral";
  export type BaseClass = "better" | "worse" | "similar" | "up" | "down";
  export const FLOOR = { error_rate: 0.0005, ms: 5, rps: 0, count: 0 } as const;
  export function classifyChange(dir: Direction, before: number, after: number, floor: number): BaseClass;

  export type MetricKey = "error_rate" | "p99_ms" | "p95_ms" | "mean_ms" | "rps" | "count";
  export type RowClass = BaseClass | "reference" | "none";   // reference = 참고용, none = 비교 불가
  export type MetricRow = {
    key: MetricKey;
    name: string;            // "오류율"
    hint: string;            // "전체 요청 중 실패한 비율" ("" 가능)
    before: number;
    after: number;
    beforeText: string;
    afterText: string;
    cls: RowClass;
    major: boolean;          // count만 false
    isNew: boolean;          // before === 0 && after > 0
    pct: number | null;      // |after-before|/before, before 0이면 null
    arrow: "▼" | "▲" | "=" | "–";   // 값이 내려감 ▼ / 올라감 ▲ / 비슷 = / 비교 불가·참고용 –
    changeText: string;      // "88% 감소" · "새로 생김" · "1% 미만 증가" · 비슷: 값 같음 또는 5% 이내면 "±5% 이내", 하한 때문에만 비슷이면 "차이 작음" · 참고용/비교 불가: ""
    wordText: string;        // "좋아짐" · "나빠짐" · "비슷" · "늘어남" · "줄어듦" · "참고용" · "–"
    barBefore: number;       // 0..1, 두 값 중 큰 쪽이 1
    barAfter: number;
  };
  export function metricRows(
    before: Report["summary"],
    after: Report["summary"],
    opts: { errorRateReference: boolean; incomparable: boolean },
  ): MetricRow[];            // 순서: error_rate, p99_ms, p95_ms, mean_ms, rps, count
  ```
  오류율 값 = `count === 0 ? 0 : errors / count`. 방향: 오류율·세 응답시간 `lower`, 처리량 `higher`, 건수 `neutral`. 변화 낱말: 응답시간 "단축/증가", 오류율·건수 "감소/증가", 처리량 "증가/감소".

- [ ] **Step 1: 테스트** (값은 그대로 쓴다)
  ```ts
  // classifyChange
  expect(classifyChange("lower", 0.026, 0.003, 0.0005)).toBe("better");
  expect(classifyChange("lower", 0.0001, 0.0002, 0.0005)).toBe("similar");  // +100%지만 하한 아래
  expect(classifyChange("lower", 1000, 1050, 5)).toBe("similar");           // 정확히 5%
  expect(classifyChange("lower", 1000, 1051, 5)).toBe("worse");
  expect(classifyChange("lower", 3, 7, 5)).toBe("similar");                 // 차이 4ms < 5ms
  expect(classifyChange("lower", 0, 12, 5)).toBe("worse");                  // before 0
  expect(classifyChange("lower", 0, 0, 5)).toBe("similar");
  expect(classifyChange("higher", 240, 253, 0)).toBe("better");
  expect(classifyChange("higher", 240, 200, 0)).toBe("worse");
  expect(classifyChange("neutral", 144000, 180000, 0)).toBe("up");
  expect(classifyChange("neutral", 144000, 100000, 0)).toBe("down");
  expect(classifyChange("neutral", 144000, 144900, 0)).toBe("similar");
  ```
  `metricRows` — 시안 숫자(이전 `{count:144000, errors:3744, rps:240, duration_seconds:600, mean_ms:840, p50_ms:500, p95_ms:2400, p99_ms:12400}`, 이후 `{count:144900, errors:435, rps:253, duration_seconds:600, mean_ms:620, p50_ms:400, p95_ms:1600, p99_ms:3100}`):
  - 키 순서가 위 6개, `major`는 count만 false.
  - 오류율 행: `cls "better"`, `arrow "▼"`, `changeText`에 "88%"와 "감소", `wordText "좋아짐"`, `beforeText "2.6%"`, `afterText "0.3%"`.
  - p99 행: `changeText`에 "75%"와 "단축". rps 행: `arrow "▲"`, `wordText "좋아짐"`. count 행: `cls "similar"`.
  - `opts.errorRateReference = true` → 오류율 행 `cls "reference"`, `wordText "참고용"`, `arrow "–"`.
  - `opts.incomparable = true` → 모든 행 `cls "none"`, `wordText "–"`, 값 글자는 그대로.
  - 비슷의 글자: 이전 `p95_ms: 3`, 이후 `7`(하한 때문에만 비슷) → `changeText "차이 작음"`("±5% 이내"가 아니다 — +133%다). 이전 `1000`, 이후 `1050` → "±5% 이내".
  - 같은 글자 방지: 이전 `p95_ms: 1060`, 이후 `1140` → 분류 worse, `beforeText "1,060ms"`, `afterText "1,140ms"`(둘 다 "1.1초"가 아님). 이전 `p95_ms: 1060`, 이후 `1090`(비슷) → 둘 다 "1.1초" 그대로.
  - 새로 생김: 이전 `errors: 0`, 이후 `errors: 725`(count 144900) → `isNew true`, `pct null`, `changeText "새로 생김"`, 글자 어디에도 "∞"·"NaN"·"Infinity" 없음.
  - 1% 미만: 이전 `rps: 1000`, 이후 `rps: 1004`는 비슷이라 해당 없음 — 대신 `classifyChange`가 worse인데 반올림 0%인 경우가 구성상 없음을 확인하는 단언은 넣지 않는다(±5% 규칙상 도달 불가).
  - 두 요약이 완전히 같음(Review Focus 5) → 6행 모두 `similar`, `barBefore === barAfter === 1`(값 0이면 둘 다 0), `NaN` 없음.
- [ ] **Step 2: 실행** — `pnpm test change` → FAIL(모듈 없음).
- [ ] **Step 3: 구현** — 값 글자는 `ui/src/print/format.ts`의 `fmtMs`·`fmtPct`·`fmtRps`·`fmtCount`. 같은 글자 방지 규칙: 분류가 better/worse인데 두 글자가 같으면 — 응답시간은 `fmtMsExact`, 오류율·처리량은 소수 자릿수를 하나씩 늘려(최대 6) 두 글자가 달라지는 첫 자릿수. 자릿수를 받는 글자 함수는 `format.ts` 안의 비공개 `pctText`·`rpsText`를 `export`해서 쓴다(추가만 — 기존 함수의 출력은 그대로, `fmt*Pair`는 쓰지 않는다). 6자리에서도 같은 글자면 6자리 글자를 그대로 둔다. spec §6.2의 "0%로 반올림되는데 비슷이 아니면 1% 미만"은 `pct`를 반올림한 값이 0일 때 "1% 미만 <낱말>".
- [ ] **Step 4: 실행** — `pnpm test change` PASS.
- [ ] **Step 5: Commit** — `feat(ui/print): 비교 보고서 변화 분류와 핵심 지표 행`

---

### Task 3: 짝과 순서 정하기

**Files:**
- Create: `ui/src/print/compare/pair.ts`
- Test: `ui/src/print/compare/__tests__/pair.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type RunMeta = Pick<Run, "id" | "status" | "started_at" | "ended_at" | "created_at"> & {
    label: string | null;
    message: string | null;
  };
  export const toRunMeta = (r: Run): RunMeta;   // label/message의 undefined → null
  export type PairResult =
    | { kind: "ok"; before: RunMeta; after: RunMeta; candidates: RunMeta[] }  // candidates = runs 순서 그대로(중복 제거)
    | { kind: "tooFew" }
    | { kind: "foreign" }       // runs의 id가 scenarioRuns에 없음
    | { kind: "notTerminal" };  // 정해진 짝 중 하나가 completed/failed/aborted가 아님
  export function resolvePair(a: {
    runIds: string[];
    pairParam: string | null;     // "idA,idB"
    baseline: string | null;
    scenarioRuns: RunMeta[];
  }): PairResult;
  export function orderByMeasured(x: RunMeta, y: RunMeta): [RunMeta, RunMeta];  // [이전, 이후]
  ```
  판정 순서: 중복 제거 → 2개 미만이면 `tooFew` → 하나라도 목록에 없으면 `foreign` → 짝 선택(spec §5: `pairParam`이 서로 다른 두 id이고 둘 다 `runIds`에 있으면 그 둘, 아니면 2개면 그 둘, 3개 이상이면 `baseline`[없거나 `runIds`에 없으면 측정 시각이 가장 이른 run] + 나머지 중 측정 시각이 가장 늦은 것) → 둘 중 terminal 아닌 것이 있으면 `notTerminal` → `ok`.

- [ ] **Step 1: 테스트** — 픽스처 `m(id, started, created, status="completed")`:
  - 2개, 나중 run을 먼저 적음(`runIds: ["late","early"]`) → `before.id "early"`, `after.id "late"`.
  - 3개 `["a","b","c"]`(시각 a<b<c), `baseline "b"` → 짝 = b와 c(나머지 중 가장 늦음), before b.
  - 3개, `baseline null` → 짝 = a(가장 이른 run)와 c.
  - 3개, `baseline "c"`(가장 늦음) → 짝 = c와 b(나머지 중 가장 늦음), before b, after c.
  - `pairParam "a,c"` → a, c. `pairParam "a,a"`·`"a,zzz"`·`"a"`·`""` → 기본 짝으로 되돌아감.
  - `runIds ["a","a","b"]` → 중복 제거 뒤 2개, `candidates.length 2`. `runIds ["a","a"]` → `tooFew`.
  - `runIds ["a","x"]`(x는 목록에 없음) → `foreign`.
  - 짝 중 하나 `status "running"` → `notTerminal`. 3개 중 짝이 아닌 run이 running이면 `ok`.
  - `started_at` 둘 다 null(Review Focus 1) → `created_at` 순. `started_at`·`created_at` 모두 같음 → id 오름차순.
  - 한쪽만 `started_at` null → 그 run은 `created_at`을 키로 쓴다(값으로 비교).
- [ ] **Step 2: 실행** — `pnpm test pair` → FAIL.
- [ ] **Step 3: 구현.**
- [ ] **Step 4: 실행** — PASS.
- [ ] **Step 5: Commit** — `feat(ui/print): 비교 보고서 짝·순서 정하기`

---

### Task 4: run 측정 모델 · `*` 판정 · 남은 문제

**Files:**
- Create: `ui/src/print/compare/runModel.ts`, `ui/src/print/compare/errorCells.ts`
- Modify: `ui/src/i18n/ko.ts` (`ko.print.cmp.star`, `ko.print.cmp.issues`)
- Test: `ui/src/print/compare/__tests__/errorCells.test.ts`, `ui/src/print/compare/__tests__/fixtures.ts`(공용 픽스처 — 이후 task가 쓴다)

**Interfaces:**
- Consumes: `RunMeta`(Task 3). 기존 `readScenarioFacts`·`buildStepTable`·`classifyCell`·`stepStatus`·`verdictBox`·`matchVerdict`·`expandCriteria`·`envValueToRecord`.
- Produces:
  ```ts
  // runModel.ts
  export type RunModel = {
    meta: RunMeta;
    report: Report;
    facts: ScenarioFacts;
    yamlObj: unknown | null;          // yaml.parse 결과, 실패 시 null
    profile: Profile | null;          // safeParse 실패 시 null
    criteria: Criteria | null;
    env: Record<string, string>;
    table: StepTableModel;
    ranked: RankedRow[];
    box: BoxState;
    evaluated: number;                // verdict?.criteria.length ?? 0
    workers: number;                  // 슬라이스 1 §5.4 규칙(없으면 0)
    errorRate: number;
  };
  export function buildRunModel(meta: RunMeta, report: Report): RunModel;

  // errorCells.ts
  export type Counts = "yes" | "no" | "maybe";
  export function countsAsError(cls: CellClass): Counts;   // counted→yes, plain/expected/uncounted→no, unknown→maybe
  export type CodeKey = number | "notSent" | "residual";    // 0 = 응답 없음
  export type StepPair = {
    stepId: string;
    label: string;                    // "④ 첨부 업로드" (이후 run 번호; 이전에만 있으면 번호 없이 이름)
    presence: "both" | "beforeOnly" | "afterOnly";
    codes: Array<{ code: CodeKey; before: number; after: number; starBefore: boolean; starAfter: boolean;
                   countsBefore: Counts | null; countsAfter: Counts | null }>;
  };
  export function stepPairs(before: RunModel, after: RunModel): StepPair[];   // 순서: 이후 시나리오 순, 그 뒤 이전에만 있는 단계
  export function hasStar(pairs: StepPair[]): boolean;
  export function starFootnote(pairs: StepPair[]): string | null;             // 건수 큰 순 2개 + "외 N곳"
  export function remainingIssues(before: RunModel, after: RunModel, pairs: StepPair[]): string[]; // 전체, 순서대로
  export function biggestCodeChange(pairs: StepPair[]): { label: string; code: CodeKey; before: number; after: number } | null;
  ```
  `codes`에는 어느 한쪽이라도 건수 > 0인 것만. 실제 코드는 `report.steps[].status_counts`에서, `notSent`·`residual`은 `table.rows`의 같은 이름 필드에서. `*`는 `presence === "both"`인 단계의 실제 코드(숫자)에만: 양쪽 각각 `classifyCell(code, 그 run의 그 단계 사실 | null)` → `countsAsError`가 다르면 건수 > 0인 쪽에 별(spec §9.2). `notSent`·`residual`·코드 0은 별 없음(항상 오류로 센다).
  남은 문제(spec §9.5) 대상 코드 = 양쪽 중 한쪽이라도 칸 분류가 `counted`·`uncounted`·`unknown`인 실제 코드(오류로 세지 않은 `uncounted`도 대상이다 — `plain`·`expected`만 빠진다) + 코드 0 + `notSent`.

- [ ] **Step 1: 공용 픽스처** — `fixtures.ts`에 `scenarioYaml(steps)`(엔진 저장 형태: `assert: [{status: 200}]`, extract는 `from` 태그), `mkReport({ steps, summary?, profile?, env?, status?, label? })`, `mkMeta(id, over?)`를 만든다. 값 모양은 `ui/src/print/__tests__/PrintDocument.test.tsx`의 픽스처 만드는 부분을 본뜬다(그 파일은 고치지 않는다). 리포트는 `ReportSchema.parse`를 통과해야 한다 — 그 단언은 `errorCells.test.ts`에 둔다(`fixtures.ts`는 테스트 파일 이름이 아니라 실행되지 않는다).
- [ ] **Step 2: 테스트**
  - `countsAsError`: 다섯 분류 전부.
  - **"600\* → 0"**: 이전 = 단계 s4 검사 없음·extract 없음·`status_counts {"200": 9400, "502": 600}`, 이후 = s4에 `{status: 200}` 검사·`{"200": 10000}` → s4의 502: `before 600, after 0, starBefore true, starAfter false`. `hasStar` true. `starFootnote`에 단계 이름·"502"·"600"·"이전"이 들어 있고 "포함되지 않았습니다".
  - **201 검사 제거**: 이전 = s1에 `{status: 201}`·`{"200": 500}`(오류 500), 이후 = 검사 없음·`{"200": 500}` → 코드 200에 `starBefore true, starAfter true`. 각주는 "안 센다" 쪽(이후) 문장 하나.
  - **`expected` ↔ `uncounted`**: 이전 = `{status: 404}`·`{"404": 30}`, 이후 = 검사 없음·`{"404": 30}` → 별 없음, `hasStar` false.
  - **센다 ↔ 알 수 없음**: 이전 = `{status: 200}`·`{"503": 10}`, 이후 = 검사 없음 + body extract·`{"503": 10}` → 양쪽 별, 각주는 "확정할 수 없습니다".
  - 한쪽에만 있는 단계 → `presence`, 별 없음. 깨진 YAML 한쪽(Review Focus 3) → throw 없음, 사실 `null`로 분류.
  - `remainingIssues`:
    - 이후에 ✕/▲ 단계 → 첫 항목들(상태 낱말 포함).
    - 줄지 않은 오류(검사 없는 단계라 칸 분류가 `uncounted`인 429 — 대상에 들어가야 한다): 429가 360 → 360 → "그대로". 360 → 400 → "400건으로 늘었습니다". 360 → 340(5.6% 감소) → 항목 없음. 360 → 345(4.2% 감소, ≥ 0.95배) → "그대로".
    - 대상 아님: 검사 `{status: 200}`이 있는 단계의 200이 9000 → 9000(`expected`) → 항목 없음.
    - 새로 생긴 오류: 0 → 48 → "새로 생겼습니다".
    - 같은 단계가 1번(문제 단계)과 2번에 다 걸리면 항목 **하나**(문장 이어 붙임).
    - 아무것도 없으면 `[]`.
  - `biggestCodeChange`: 503이 2880 → 0, 504가 312 → 24 → 503 반환.
  - 자기참조 방지: `ko.*` 함수로 만든 기대값만 쓰지 말고 숫자·코드 글자를 `toContain`으로 병기.
- [ ] **Step 3: 실행** — `pnpm test errorCells` → FAIL.
- [ ] **Step 4: 구현.** 단계 상태 낱말은 기존 `ko.print`의 상태 문구 재사용(`stepStatus` 태그 → 낱말, 기존 `StepCodeTable`이 쓰는 매핑을 찾아 같은 키 사용).
- [ ] **Step 5: 실행** — PASS. 되돌려 확인: `stepPairs`가 건수 0인 쪽 분류를 `perCode`에서 읽도록 잠깐 바꿔 "600\* → 0" 테스트가 FAIL하는지 보고 원복.
- [ ] **Step 6: Commit** — `feat(ui/print): 비교 보고서 run 모델·세는 방식 차이(*)·남은 문제`

---

### Task 5: 공정 비교와 측정 조건 대조

**Files:**
- Create: `ui/src/print/compare/fairness.ts`
- Modify: `ui/src/i18n/ko.ts` (`ko.print.cmp.fair`, `ko.print.cmp.cond`)
- Test: `ui/src/print/compare/__tests__/fairness.test.ts`

**Interfaces:**
- Consumes: `RunModel`(Task 4), 픽스처(Task 4).
- Produces:
  ```ts
  export type FairKey = "load" | "env" | "scenario" | "criteria";
  export type FairCard = { key: FairKey; title: string; same: boolean; line: string };
  export type CondRow = { label: string; before: string; after: string; differs: boolean };
  export type Fairness = {
    cards: FairCard[];            // 순서 load, env, scenario, criteria
    statusLines: string[];        // "▲ 이후 측정은 도중에 중단되었습니다(…)" 등
    anyDiff: boolean;             // 카드 ▲ 또는 statusLines 있음
    diffNames: string[];          // ▲ 카드 제목 + (상태 줄 있으면) "측정 상태"
    criteriaSame: boolean;
    oneLine: string;              // 사다리 4칸용 한 줄
    condRows: CondRow[];
  };
  export function buildFairness(before: RunModel, after: RunModel): Fairness;
  export function deepEqualLoose(a: unknown, b: unknown): boolean;   // null·undefined·키 없음을 같게, 객체 키 순서 무시, 배열 순서 유지
  export function stripScenarioNames(yamlObj: unknown): unknown;      // 최상위와 단계 객체의 name·notes만 제거
  ```
  규칙은 spec §7 그대로. 부하 조건: `profile`에서 `criteria`·`think_seed`·`data_binding`·`data_bindings`를 빼고 `seedBindingsFrom` 결과를 `bindings`로 넣어 `deepEqualLoose`, + `workers`. 이름 붙은 항목 11개와 "그 밖의 설정". **크기 항목의 이름**(카드 `line`과 대조 표 라벨 공통): 두 run 모두 closed-loop면 "동시 사용자", 둘 다 open-loop면 "초당 목표", 부하 모델이 서로 다르면 "크기". 중단 줄의 "(4분 12초까지 측정)" = `ended_at − started_at`(둘 중 하나라도 null이면 괄호 없이). 한쪽 `profile`을 읽지 못하면 부하 조건 카드와 **판정 기준 카드 둘 다** "설정을 읽을 수 없음"(`same false`, `criteriaSame false`) — 기준이 있는지조차 알 수 없으므로 "한쪽만 기준 있음"이라고 쓰지 않는다. 대조 표 값 문구는 기존 `conditionsBox`의 행을 라벨로 맞춰 쓰고, 없는 항목(연결 제한 시간 · 동시 요청 상한 · 데이터 연결 내용 · 계단 설정)은 이 파일에서 한 줄 문구를 만든다.

- [ ] **Step 1: 테스트**
  - 같은 리포트 둘 → 카드 4장 모두 `same true`, `anyDiff false`, `condRows`의 `differs` 전부 false.
  - VU 200 vs 300, 기간 600 vs 300 → load 카드 `same false`, `line`에 "동시 사용자"와 "기간", `condRows`에서 그 두 행 `differs true`.
  - `max_in_flight`만 다름 → load ▲, `line`에 "동시 요청 상한". `think_seed`만 다름 → 같음. `measure_phases`만 다름 → ▲ "그 밖의 설정".
  - 옛 `data_binding` 하나 vs `data_bindings` 한 원소(내용 같음) → 같음.
  - env: `{BASE_URL:"https://a", TOKEN:"s3cret-A"}` vs `{BASE_URL:"https://b", TOKEN:"s3cret-A", EXTRA:"x"}` → env ▲, `line`에 "2개"와 `BASE_URL`·`EXTRA`. **`JSON.stringify(buildFairness(...))`에 `"https://a"`·`"https://b"`·`"s3cret-A"`·`"x"`(따옴표 포함 값 글자)가 없다.** 키 5개가 다르면 앞 2개 + "외 3개".
  - 시나리오: 한 단계에 `{status: 200}` 추가 → ▲ "응답 코드 검사 추가됨"과 단계 번호. 단계 이름만 바뀜·`notes`만 바뀜 → 같음. 요청 본문 JSON의 `name` 필드 값 바뀜 → ▲ "그 밖의 설정 다름". 시나리오 `default_think_time` 바뀜 → ▲ "그 밖의 설정 다름". 병렬 분기 `name` 바뀜 → ▲. 단계 삭제 → ▲ "삭제".
  - 한쪽 YAML 깨짐(Review Focus 3) → 시나리오 카드 `same false`, `line` "시나리오를 읽지 못해 확인하지 못함".
  - 기준: `{max_p95_ms: 3000}` vs `{max_p95_ms: 2000}` → ▲ "기준 1개 다름", `criteriaSame false`. `step_criteria` 순서만 다름 → 같음. 한쪽만 기준 → "한쪽만 기준 있음". 둘 다 없음 → 같음.
  - 한쪽 `profile` 파싱 실패(Review Focus 2: `profile: {vus: "x"}`) → load 카드 `same false`, `line` "설정을 읽을 수 없음", 판정 기준 카드도 같은 글, `criteriaSame false`, throw 없음.
  - 크기 이름: closed 200 vs open `target_rps 50` → `line`에 "부하 모델"과 "크기". open 50 vs open 80 → "초당 목표".
  - 중단 줄 시간: `started_at 0`, `ended_at 252000` → "4분 12초까지 측정". `started_at null` → 괄호 없음.
  - 이후 `status "aborted"` → `statusLines` 1개("이후 측정은 도중에 중단"), `anyDiff true`, `diffNames`에 "측정 상태". 이전 `failed` → "이전 측정은 실패로 끝났습니다".
  - `oneLine`: load·env 같고 scenario·criteria 다름 → "부하 조건·환경 변수 같음"과 "시나리오 내용·판정 기준 다름"을 포함.
- [ ] **Step 2: 실행** — `pnpm test fairness` → FAIL.
- [ ] **Step 3: 구현.** 시나리오 차이 설명은 `StepFacts`(id로 맞춤)로: 추가/삭제/순서 바뀜/요청(방식·주소) 바뀜/검사 추가·제거·바뀜/값 꺼내기 추가·제거. 그런 차이가 0인데 `deepEqualLoose(stripScenarioNames(a), stripScenarioNames(b))`가 false면 "그 밖의 설정 다름".
- [ ] **Step 4: 실행** — PASS. 되돌려 확인: env 카드 `line`에 값을 잠깐 넣어 값-없음 단언이 FAIL하는지 보고 원복.
- [ ] **Step 5: Commit** — `feat(ui/print): 비교 보고서 공정 비교 점검·측정 조건 대조`

---

### Task 6: 종합 답 · 요약 문장 · 문서 모델과 블록

**Files:**
- Create: `ui/src/print/compare/headline.ts`, `ui/src/print/compare/buildCompareDoc.ts`
- Modify: `ui/src/i18n/ko.ts` (`ko.print.cmp.headline`, `ko.print.cmp.lines`, `ko.print.cmp.doc`)
- Test: `ui/src/print/compare/__tests__/headline.test.ts`, `ui/src/print/compare/__tests__/buildCompareDoc.test.ts`

**Interfaces:**
- Consumes: `metricRows`·`MetricRow`(Task 2), `RunModel`·`stepPairs`·`hasStar`·`starFootnote`·`remainingIssues`·`biggestCodeChange`(Task 4), `buildFairness`·`Fairness`(Task 5), `Block`·`Heights`(기존).
- Produces:
  ```ts
  // headline.ts
  export type Answer = "improved" | "worsened" | "mixed" | "similar" | "incomparable";
  export type Headline = {
    answer: Answer;
    glyph: "▼" | "▲" | "◆" | "=" | "–";     // 개선 ▼ · 악화 ▲ · 엇갈림 ◆ · 비슷 = · 비교 불가 –
    word: string;                            // "개선" …
    countsLine: string;                      // "주요 지표 5개 중 4개 좋아짐 · 1개 비슷 · 0개 나빠짐 · 판정 ✕ → ●"
    reference: boolean;                      // true면 회색 + "조건이 달라 참고용"
    verdictSignal: "good" | "bad" | null;
  };
  export function buildHeadline(a: {
    rows: MetricRow[];
    beforeBox: BoxState;
    afterBox: BoxState;
    criteriaSame: boolean;
    anyDiff: boolean;
    incomparable: boolean;
  }): Headline;
  export function summaryLines(a: {
    headline: Headline;
    rows: MetricRow[];
    before: RunModel;
    after: RunModel;
    fairness: Fairness;
    codeChange: ReturnType<typeof biggestCodeChange>;
  }): Array<{ id: 1 | 2 | 3 | 4; text: string }>;

  // buildCompareDoc.ts
  export type SideHead = { role: string; label: string | null; shortId: string; window: string; verdictText: string };
  export type CompareDoc = {
    title: string; footerLeft: string; createdDate: string;
    before: SideHead; after: SideHead;
    headline: Headline;
    lines: Array<{ id: 1 | 2 | 3 | 4; text: string }>;
    fairness: Fairness;
    rows: MetricRow[];
    starNote: string | null;
    issues: string[];            // 전체
    incomparable: boolean;
  };
  export function buildCompareDoc(a: {
    before: RunModel; after: RunModel; fallbackScenarioName: string | null; now: number;
  }): CompareDoc;
  export const CMP_LAST_LEVEL = 5;
  export const CMP_IDS: { condTitle: string; condHeader: string; condRowId: (i: number) => string };
  export function compareStandardBlocks(doc: CompareDoc, h: Heights): Block[];
  export function compareSummaryBlocks(doc: CompareDoc, h: Heights, level: number): Block[];
  export function issuesShown(doc: CompareDoc, max: number): { shown: string[]; more: number };
  /** 절 번호 — 그 판에 있는 절만 차례로. 슬라이스 B가 절을 끼우면 이 함수만 고친다. */
  export function sectionNo(kind: "standard" | "summary"): { overview: string; kpi: string; cond: string | null; issues: string };
  // standard → { overview:"1", kpi:"2", cond:"3", issues:"4" } · summary → { overview:"1", kpi:"2", cond:null, issues:"3" }
  /** 측정 시트에 그릴 블록. "standard" = 표준 블록 그대로, "summary" = 칸 0..CMP_LAST_LEVEL에서 나오는 블록의 합집합(id 중복 제거). */
  export function compareSheetBlocks(doc: CompareDoc, kind: "standard" | "summary"): Block[];
  ```
  블록 id(이름 고정 — Task 7이 이 id로 그린다): `cmp:header` · `cmp:headline` · `cmp:lines:full` / `cmp:lines:short`(1·4번 줄만) · `cmp:cards` / `cmp:cards:line` · `cmp:kpi:bars` / `cmp:kpi:plain` · `cmp:kpi:note` · 표 블록 `cmp:cond`(행 분할) · `cmp:issues:8` / `:5` / `:3` / `:1` · `signature`.
  - 표준판 순서: header, headline, lines:full, cards, kpi:bars, kpi:note, cond(표), issues:8, signature.
  - 요약판 칸(0–5): 0 = header, headline, lines:full, cards, kpi:bars, kpi:note, issues:5 → 1 = `kpi:plain` → 2 = `issues:3` → 3 = `lines:short` → 4 = `cards:line` → 5 = `issues:1`. 앞 칸의 변경은 누적.
  - `incomparable` = 둘 중 하나라도 `summary.count === 0`.

- [ ] **Step 1: `headline.test.ts`** — spec §6.3 표 전 행:
  - 좋음 4·비슷 1·나쁨 0 → `improved`, `▼`, `countsLine`에 "5개 중", "4개 좋아짐", "1개 비슷", "0개 나빠짐".
  - 나쁨만 → `worsened`. 좋음 1 + 나쁨 1 → `mixed`, `◆`. 모두 비슷 → `similar`.
  - 판정 신호: 지표 모두 비슷 + 이전 `fail` → 이후 `pass` + `criteriaSame true` → `improved`, `countsLine` 끝에 "판정 ✕ → ●". 같은데 `criteriaSame false` → `similar`, `verdictSignal null`, `countsLine`에 "판정" 없음.
  - 이전 `pass` → 이후 `fail`(기준 같음) + 지표 좋음 2 → `mixed`.
  - 한쪽 `noCriteria` → 신호 없음.
  - 오류율 행이 `reference` → "4개 중", 그 행은 어느 개수에도 안 들어감(N + M + K = 4).
  - `anyDiff true` → `reference true`(답 낱말은 그대로). `incomparable true` → `incomparable`, `–`.
- [ ] **Step 2: `summaryLines` 테스트** — spec §6.4:
  - 판정 바뀜 → 1번 줄에 "✕ 부적합"·"● 적합"·"바뀌었습니다", 이후 적합이면 "기준 3개를 모두 지켰습니다"(숫자 3 단언).
  - 2번 줄: 개선 + 오류율이 최고 순위 → "오류율"·"2.6%"·"0.3%"·"88%", `codeChange` 있으면 "2,880건이 0건이 되었습니다". 줄었음(312 → 24) → "24건으로 줄었습니다". 순위: `isNew` 행이 변화율 큰 행보다 앞.
  - 오류율이 `reference`면 2번 줄 후보에서 빠진다(다음 순위 지표가 나온다).
  - 답이 비슷 → 2번 줄 없음. 개선이 판정 변화뿐 → 2번 줄 없음.
  - 3번 줄: 엇갈림일 때만, 나빠짐 지표 1개 "반면". 나쁨이 판정 변화뿐이면 없음.
  - 4번 줄: `fairness.anyDiff` → "참고용"과 `diffNames` 앞 2개(+ "외 N개").
  - 비교 불가 → 1번 줄 자리에 "요청이 실행되지 않은 측정이 있어 비교하지 않았습니다" + 그 run `meta.message`가 있으면 사유 글자 포함.
- [ ] **Step 3: `buildCompareDoc.test.ts`**
  - 시안 상황(Task 4 픽스처로 이전 = 오류 많음, 이후 = 개선) → `title`에 시나리오 이름과 "이전·이후 비교", `before.role "이전"`, `footerLeft`에 두 `#끝6자`와 "→".
  - 제목 이름 폴백 순서: 이후 YAML 이름 → 이전 YAML 이름 → `fallbackScenarioName` → 폴백 문구.
  - `hasStar`인 짝 → 오류율 행 `cls "reference"`, `starNote` 비어 있지 않음, `headline.countsLine`에 "4개 중".
  - 표준 블록 id 순서가 위 목록과 같음. `fairness.condRows`가 30행이면 `cmp:cond` 표 블록 `rowsMm.length 30`.
  - 요약 블록: 칸 0..5 각각의 id 목록이 **앞 칸과 다르고**, 칸 5에 `cmp:headline`·`cmp:kpi:plain`·`cmp:cards:line`·`cmp:issues:1`이 모두 있다(생략 금지 항목).
  - `compareSheetBlocks(doc, "summary")`의 id 집합이 칸 0..5 블록 id의 합집합과 같다(`cmp:kpi:plain`·`cmp:issues:3`·`cmp:issues:1`·`cmp:lines:short`·`cmp:cards:line` 포함). `sectionNo` 두 판의 값.
  - `issuesShown(doc, 5)`: 남은 문제 20개 → `shown.length 5`, `more 15`. 0개 → `shown []`, `more 0`.
  - 두 run이 같은 리포트(Review Focus 5) → `headline.answer "similar"`, `JSON.stringify(doc)`에 "NaN"·"Infinity"·"∞" 없음. 둘 다 요청 0건 → `incomparable`.
- [ ] **Step 4: 실행** — FAIL 확인 → 구현 → PASS. 판정 낱말은 기존 `ko.print.verdict`(`fail`·`pass`·`notJudged`·`notEvaluable`·`noCriteria`), 측정 일시는 `measuredWindow`, `#끝6자`는 `runShortLabel`, 작성일은 `fmtDate`.
- [ ] **Step 5: Commit** — `feat(ui/print): 비교 보고서 종합 답·요약 문장·문서 모델`

---

### Task 7: 문서 렌더(`CompareDocument`)와 인쇄 CSS

**Files:**
- Create: `ui/src/print/compare/CompareDocument.tsx`, `ui/src/print/compare/components/CompareHeader.tsx`, `HeadlineBox.tsx`, `FairCards.tsx`, `KpiCompareTable.tsx`, `CondTable.tsx`, `IssuesBox.tsx`, `CompareFooter.tsx`
- Modify: `ui/src/print/print.css` (`p-cmp-` 규칙), `ui/src/i18n/ko.ts` (`ko.print.cmp.section`, 표 머리 글)
- Test: `ui/src/print/compare/__tests__/CompareDocument.test.tsx`

**Interfaces:**
- Consumes: `PagedDocument`(Task 1), `chooseSummaryLevel(…, CMP_LAST_LEVEL)`(Task 1), `CompareDoc`·블록 함수·`CMP_IDS`·`issuesShown`·`sectionNo`·`compareSheetBlocks`(Task 6), `SignatureBlock`(기존).
- Produces:
  ```ts
  export function CompareDocument(props: {
    doc: CompareDoc;
    kind: "standard" | "summary";
    onLadder?: (level: number) => void;
  }): JSX.Element;
  ```
  절 제목: "N. 종합"(`cmp:headline` 블록 머리) · "N. 핵심 지표 비교"(`cmp:kpi:*` 블록 머리) · "N. 측정 조건 대조"(`cmp:cond` 표 제목) · "N. 남은 문제"(`cmp:issues:*` 상자 제목). N은 `sectionNo(kind)`(Task 6)에서 — 표준판 1·2·3·4, 요약판 1·2·3(조건 대조 없음).
  **측정 시트**: 요약판은 사다리 어느 칸에서든 쓰일 수 있는 블록을 전부 시트에 그려야 한다(`compareSheetBlocks`). 빠진 블록은 높이 0으로 읽혀 사다리가 "들어간다"고 잘못 판단하고 1장을 넘긴다.

- [ ] **Step 1: 테스트(jsdom — 배치는 높이 0이라 한 쪽)** — Task 4 픽스처 문서로:
  - 표준판: `data-layout-ready="true"` 뒤 `.p-page` 1개 이상. 짝 상자에 "이전"·"이후"·두 `#끝6자`·라벨. 비교 결과 상자에 `headline.word`와 `countsLine`. 핵심 지표 표에 6행(`within(table).getAllByRole("row")` = 머리 1 + 6), 오류율 행에 "2.6%"·"0.3%"·"좋아짐". 공정 비교 카드 4장(제목 4개). 측정 조건 대조 표 머리 "항목"·"이전"·"이후". 남은 문제 상자. 서명란.
  - 분류 낱말은 글자로 있다(색 클래스만으로 구분하지 않음): 좋아짐 행에 "좋아짐" 텍스트, 기호 `▼`.
  - `headline.reference` 문서 → "조건이 달라 참고용" 텍스트, 상자에 회색 변형 클래스(`p-cmp-vbox--ref`).
  - `starNote` 문서 → 핵심 지표 표 아래 각주 텍스트, 오류율 행 "참고용".
  - 남은 문제 0개 → "남은 문제 없음".
  - 요약판: 서명란 없음, 측정 조건 대조 표 없음, 남은 문제 최대 5개 + "외 N개".
  - 한눈에 보기 막대: `kind="standard"`에서 막대 요소(`.p-cmp-bar`)가 행마다 2개, 폭 스타일이 `barBefore`·`barAfter` 비율.
  - 꼬리말에 `footerLeft`와 "1 / N".
  - **시트 합집합**: `kind="summary"`로 렌더한 직후(배치 전, `data-layout-ready="false"`) `.p-sheet` 안에 칸 0..5의 모든 블록 id마다 `[data-measure="<id>"]` 요소가 있다(`ui/src/print/__tests__/PrintDocument.test.tsx`의 같은 종류 단언을 본뜬다). 표 블록 `cmp:cond`는 표준판 시트에서 제목·머리·행마다 `data-measure`.
  - 절 번호: 표준판 "3. 측정 조건 대조"·"4. 남은 문제", 요약판 "3. 남은 문제".
- [ ] **Step 2: 실행** — `pnpm test CompareDocument` → FAIL.
- [ ] **Step 3: 구현.** 시안 `compare-report-v2.html`의 `<style>`에서 `.pair`·`.run`·`.arrow`·`.verdict`·`.vbox`·`.summary`·`.fair`·`.ok`·`.bars`·`.cellchg`·`.down`·`.box`·`.note`를 `p-cmp-` 접두로 `print.css`에 옮긴다 — **값(색·굵기·padding·border·radius·글자 크기)은 시안 그대로**. 쪽·머리·꼬리말·표 기본 규칙은 기존 `p-` 규칙을 쓴다. 요약판에서 줄 수를 자르는 곳(spec §10): run `message` 사유 1줄, 남은 문제 항목 2줄, 공정 비교 한 줄 1줄, run 라벨 1줄, `*` 각주 1줄 — `-webkit-line-clamp` + `overflow: hidden`. 좁은 칸 낱말에는 `word-break: keep-all`. `place`: 표준판 = `paginate(compareStandardBlocks(doc, h), PAGE_BODY_MM)`, 요약판 = `chooseSummaryLevel((l) => compareSummaryBlocks(doc, h, l), PAGE_BODY_MM, CMP_LAST_LEVEL)`; 넘치면 `console.warn`(기존 문구 형식).
- [ ] **Step 4: 실행** — PASS, `pnpm test`(전체)·`pnpm build` PASS.
- [ ] **Step 5: Commit** — `feat(ui/print): 비교 보고서 문서 렌더·인쇄 CSS`

**orchestrator 게이트(이 task 직후 — working-rules §4 시안 대조)**: Task 8이 끝나야 화면이 열리므로, Task 8 직후 컨트롤러를 띄워 표준판 1쪽과 시안 1쪽을 나란히 스크린샷으로 대조한다(상자 모양·색·굵기·간격). 차이는 fresh implementer에게 수정 task로.

---

### Task 8: 인쇄 화면 · 경로 · 진입 링크

**Files:**
- Create: `ui/src/pages/ScenarioComparePrintPage.tsx`
- Modify: `ui/src/routes.tsx`, `ui/src/pages/ScenarioComparePage.tsx`, `ui/src/pages/RunPrintPage.tsx`(`PAGE_RULE`에 `export`만 추가), `ui/src/i18n/ko.ts` (`ko.print.cmp.page`)
- Test: `ui/src/pages/__tests__/ScenarioComparePrintPage.test.tsx`, `ui/src/pages/__tests__/ScenarioComparePage.test.tsx`(기존 파일에 케이스 1개 추가)

**Interfaces:**
- Consumes: `resolvePair`·`toRunMeta`(Task 3), `buildRunModel`(Task 4), `buildCompareDoc`(Task 6), `CompareDocument`(Task 7), 기존 `useScenarioRuns`·`useReports`·`useScenario`.
- Produces: 경로 `/scenarios/:id/compare/print`(`routes.tsx`의 `/runs/:id/print` 옆, `Layout` 밖). 비교 화면 링크 글자 `ko.print.cmp.page.openPrint` = "비교 보고서 인쇄".

- [ ] **Step 1: 테스트** (`fetch` 모킹은 `RunPrintPage.test.tsx`의 방식을 따른다 — URL로 갈라 응답)
  - 정상: `?runs=late,early` → 문서가 그려지고 "이전" 상자에 early의 `#끝6자`. 리포트 요청은 두 run의 `/report`만(URL 필터로 호출 수 2).
  - `runs` 1개 → "비교하려면 측정을 2개 이상 고르세요", `/report` 호출 0.
  - `runs`에 목록에 없는 id → "이 시나리오의 측정이 아니거나 없는 측정이 있어 비교 보고서를 만들 수 없습니다", `/report` 호출 **0**.
  - 짝 중 하나 `running` → "측정이 끝난 뒤 출력할 수 있습니다", `/report` 호출 **0**.
  - run 목록 fetch 실패 → `role="alert"`. 로딩 중 → `role="status"`.
  - `runs` 3개 → 「비교할 측정」 선택 칸 2개(`getAllByRole("combobox")` 길이 2, 접근 이름 "비교할 측정 1"·"비교할 측정 2" — 이전/이후라고 부르지 않는다: 순서는 시각이 정하므로 고른 값이 다른 칸으로 옮겨 보이면 안 된다), 각 옵션에 라벨 또는 `#끝6자`와 측정 일시. 칸에 보이는 값은 주소 `pair`가 유효하면 그 적힌 순서, 아니면 [이전, 이후]. 한 칸을 바꾸면 주소 `pair`가 갱신되고 문서가 다시 그려진다. 다른 칸에서 이미 고른 run은 그 칸의 옵션에서 `disabled`.
  - 요약판 축소 안내: `CompareDocument`를 모킹해 `onLadder(2)`를 부르면 도구 줄에 "1장에 맞추려고 일부를 줄였습니다" 글이 보이고, 표준판에서는 안 보인다.
  - 시나리오 이름을 아직 읽는 중이면 문서 대신 `role="status"`(이름이 늦게 와서 배치를 두 번 하지 않게 — `RunPrintPage`와 같은 게이트).
  - `runs` 2개 → 선택 칸 없음.
  - [표준판 | 요약판] 버튼 `aria-pressed`, 누르면 `kind` 파라미터만 바뀌고 `runs`·`pair`·`baseline`은 남는다.
  - [돌아가기] 링크 `href` = `/scenarios/:id/compare?runs=…&baseline=…`(받은 값 그대로).
  - 깜박임 방지: 주소 `runs`에는 끝난 run 2개만 두고, 그 시나리오의 run 목록에는 **주소에 없는 실행 중 run 하나**가 더 있다(선택 화면은 끝난 run만 고르게 하므로 이것이 실제 상황이다 — 실행 중 run을 `runs`에 넣으면 기본 짝에 뽑혀 "측정이 끝난 뒤…" 안내만 뜬다). run 목록을 다시 읽게 하고(`queryClient.invalidateQueries`), 두 번째 응답은 **그 실행 중 run의 `last_metric_ts`만** 바꾼다(실제 5초 재조회에서 일어나는 변화 — 내용이 같은 응답은 React Query가 같은 객체를 돌려줘서 결함이 있어도 통과한다). `CompareDocument`를 모킹해 받은 `doc`를 모아, 재조회 뒤 받은 `doc`가 처음 것과 `===`인지 단언.
  - `ScenarioComparePage.test.tsx`: 머리에 "비교 보고서 인쇄" 링크, `href`가 `/scenarios/<id>/compare/print?runs=<ids>&baseline=<id>` — `baseline`은 화면이 계산해 쓰는 값(주소에 없으면 `runIds[0]`)을 넘긴다.
- [ ] **Step 2: 실행** — FAIL.
- [ ] **Step 3: 구현.** 순서: `useScenarioRuns(id)` → `resolvePair` → `ok`일 때만 `useReports([before.id, after.id])`(그 밖에는 빈 배열로 호출해 요청 0) → 두 리포트가 오면 `useMemo`로 `buildCompareDoc`. `useMemo` 의존값은 두 리포트 객체 + 짝 두 run의 원시값(`id`·`status`·`label`·`message`·`started_at`·`ended_at`·`created_at`) + 시나리오 이름 + `now`(`useState(() => Date.now())`) — `runs.data`·`RunMeta` 객체를 직접 넣지 않는다. 도구 줄은 `RunPrintPage`의 구성·클래스(`p-root`·`p-noprint`·`PAGE_RULE`·주소 복사 규칙·요약판 축소 안내)를 따른다. `PAGE_RULE`은 `RunPrintPage.tsx`에서 `export`해 가져다 쓴다(같은 값을 두 번 적지 않는다). 시나리오 조회가 로딩 중이면 문서를 그리지 않는다.
- [ ] **Step 4: 실행** — PASS, `pnpm test`·`pnpm lint`·`pnpm build` PASS. 되돌려 확인: `useMemo` 의존값에 `runs.data`를 잠깐 넣어 깜박임 테스트가 FAIL하는지 보고 원복.
- [ ] **Step 5: Commit** — `feat(ui): 비교 보고서 인쇄 화면·경로·진입 링크`

---

## 마무리 (task가 아니라 orchestrator 절차)

1. **시안 대조** — Task 8 직후(위 게이트).
2. **최종 리뷰** — `handicap-reviewer`(전체 diff, BASE = Task 1 직전 커밋). 초점: 측정 보고서 출력 불변, `crates/`·`ui/src/compare/` 0-diff, `ko.ts` 경유, 렌더 경로 throw.
3. **보안** — `security-reviewer`(spec §13: env 값 비교가 값에 손댄다). 초점: env 값·데이터셋 값·헤더·본문이 `CompareDoc`·DOM·PDF 텍스트 어디에도 없는지, run `message` sink.
4. **라이브 검증(`/live-verify`, spec §13 「슬라이스별 몫」 A)** — US1·US3·US4 + 틀 분리 회귀 + 극단값(긴 이름·200자 라벨[`RUN_LABEL_MAX_CHARS`]·남은 문제 20개 이상·요청 0건 run·중단 run·환경 변수 키 64자·`letter-spacing: 0.12em` 주입). 쪽별 rect, `--print-to-pdf` + `pdfinfo` Pages == `.p-page` 수, `pdftotext`에 env 값 없음. 요약판은 극단에서도 1장.
5. **`/finish-slice`** — build-log · roadmap §B(다음 번호는 `grep -n '^### B' docs/roadmap.md`로) · 상태줄 · 현황판. §B에 남길 것: spec §15 연기 목록, spec §12 사용자 고지 목록, **슬라이스 B가 남았다**는 것과 그 계획을 쓸 차례라는 것.

## Self-Review 메모

- spec 슬라이스 A 범위 대조: §5 → Task 3·8 · §6.1–6.2 → Task 2 · §6.3–6.4 → Task 6 · §7 → Task 5 · §8.1(1·2·7·8절)·§8.2 → Task 6·7 · §9.2의 `*` → Task 4 · §9.5 → Task 4 · §10 → Task 1·6·7 · §11 → Global Constraints · §13 A → 각 task + 마무리.
- 슬라이스 B로 넘긴 것: §9.1 · §9.2의 표 · §9.3 · §9.4 — 이 계획에 task 없음(의도).
