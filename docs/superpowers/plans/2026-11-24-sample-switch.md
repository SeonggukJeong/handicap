# 응답 시간 표본 전환 단추 (sample-switch) Implementation Plan

REVIEW-GATE: APPROVED

> spec `spec-plan-reviewer` 3차 clean APPROVE · plan 3차 clean APPROVE (2026-11-24).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** run 상세 리포트에서 응답 시간 표본(통과한 요청·실패한 요청·모든 요청)을 단추로 바꿔 보고, 표본마다 「언제 고르고 무엇을 보는지」를 툴팁과 (?)로 읽을 수 있게 한다.

**Architecture:** 화면(`ui/`)만 바꾼다. run 상세가 주소 `?sample=`을 읽어 리포트를 그 표본으로 다시 받는다(`?basis=`와 같은 방식 — 배관 `useRunReport(id, terminal, basis, sample)`은 이미 있다). 표본에 따라 바뀌는 문구·표지는 한 조건 「바꿔 봄」(`split && selected !== default`)에만 걸어 옛 run 화면을 그대로 둔다.

**Tech Stack:** React + TypeScript, React Query, react-router `useSearchParams`, vitest + Testing Library, Tailwind.

<!-- plan 1차 검토(2026-11-24) 지적 17건 반영: 공허한 되돌려 확인 둘·ReportView 배선 테스트·자식 목록 명령·픽스처·가짜 타이머·(?) 주어·숨은 설명 hidden -->

**Spec:** `docs/superpowers/specs/2026-11-24-sample-switch-design.md` (R-id·문구 정본 §5·라이브 표 §6). 목업: `docs/superpowers/specs/2026-11-24-sample-switch-mockups/screens.html`(툴팁·(?)·구획 표지 — **시각 기준**), `docs/superpowers/specs/2026-11-23-passed-latency-mockups/screens.html` 2(노란 안내 상자).

## Global Constraints

- 서버·엔진·proto·DB 변경 없음. `crates/` 0-diff.
- 「바꿔 봄」 = `split && selected !== default`. 나눌 수 없는 run(`split: false`)은 `selected`가 `all`이어도 「바꿔 봄」이 아니다 — 그 run의 화면은 이 슬라이스 전과 글자 하나 다르지 않아야 한다(R14).
- 문구는 전부 `ui/src/i18n/ko.ts` `ko.report.sample` 경유, spec §5의 글자 그대로(byte-exact). 표본 이름에 「전체」를 쓰지 않는다.
- 숨은 설명·툴팁·표지는 제목(`<h3>`/`<h4>`)·단추의 **형제**로 둔다(접근 이름에 섞이지 않게 — `ui/CLAUDE.md`의 heading-accname 함정).
- `Segmented`를 쓰는 곳 셋(`BasisBar`·`run/RunDialog`·`run/LoadModelFields`)의 기존 테스트는 무수정 통과해야 한다. `description`을 안 넘긴 선택지의 DOM은 바뀌지 않는다.
- 매 task 끝: `pnpm --dir ui lint`, `pnpm --dir ui test`, `pnpm --dir ui build` 통과 후 커밋(pre-commit이 같은 게이트를 다시 돈다 — 커밋은 단일 FOREGROUND 호출, `| tail` 금지, `--no-verify` 금지). 커밋 메시지는 `-F <파일>`.
- tdd-guard: `ui/src`의 운영 코드를 고치기 전에 그 task의 실패하는 테스트를 먼저 쓴다(매 task Step 1).
- 줄번호를 쓰지 않는다 — 고칠 자리는 기호 이름으로 `grep -n`해서 찾는다.

## Review Focus

1. **옛 run을 `?sample=failed`·`?sample=all` 주소로 연다** → 화면이 `?sample` 없이 연 것과 같아야 한다(단추·상자·표지·머리말). Task 3·4·5의 「나눌 수 없는 run」 테스트.
2. **불러오는 동안 화살표 키를 연달아 누른다 / 기본 표본으로 돌아오는 중** → 눌린 단추가 요청한 표본을 따라가고 이전 표본에 머물지 않는다. Task 2·3.
3. **오류가 전부 「보내지 않음」인 run에서 「실패한 요청」** → 「실패한 요청 없음」이 아니라 「실패한 요청은 모두 보내기 전에 실패해 잰 시간이 없음」, 0ms 없음. Task 4·5.
4. **단추에서 툴팁으로 마우스를 옮긴다 / Esc** → 툴팁이 닫히지 않는다 / 닫히고 다시 초점이 올 때까지 안 뜬다. 열린 모달(`RunDialog`) 안의 `Segmented`는 `description`이 없으므로 Esc 리스너를 달지 않는다(모달의 Esc 처리를 가로채지 않는다). Task 1.
5. **단계 분해를 켠 run의 기본 보기(「막대」)** → 표본 표지를 달지 않고 안내 한 줄만. 「칩」으로 바꾸면 표지. Task 5.

## 파일 구조

| 파일 | 일 |
|---|---|
| `ui/src/components/ui/Segmented.tsx` (고침) | 화살표 키가 초점을 옮긴다 · 선택지 `description` → 숨은 설명 + 툴팁 |
| `ui/src/components/ui/OptionTip.tsx` (새로) | 툴팁 판(portal, `computeTipPos`) — 그리기만 |
| `ui/src/report/sampleView.ts` (새로) | 「바꿔 봄」·표본 이름·「없음」 낱말의 단일 소스 |
| `ui/src/i18n/ko.ts` (고침) | `ko.report.sample` 새 열쇠 + 머리말·다른 기준 줄 문구 |
| `ui/src/components/report/SampleBar.tsx` (고침) | 단추 셋 + (?) + 설명 + 안내 상자 |
| `ui/src/components/report/SampleTag.tsx` (새로) | 구획 표지(`Badge` accent) |
| `ui/src/pages/RunDetailPage.tsx`, `ui/src/components/report/ReportView.tsx` (고침) | 주소 ↔ 표본 배관 |
| `ReportHeadline`·`Summary`·`basisText`·`BasisBar` (고침) | 표본을 따르는 문장·「—」 |
| `TimeSeriesChart`·`StepStatsTable`·`StepPhaseBreakdown`·`WorkerBreakdownTable` (고침) | 구획 표지·「막대」 보기 안내·분포 구획 껍데기 |

---

### Task 1: `Segmented` — 화살표 키 초점 이동 + 선택지 설명 툴팁 (R5·R17·R18의 부품 쪽)

**Files:**
- Modify: `ui/src/components/ui/Segmented.tsx`
- Create: `ui/src/components/ui/OptionTip.tsx`
- Test: `ui/src/components/ui/__tests__/Segmented.test.tsx` (기존 파일에 더한다)

**Interfaces:**
- Produces: `Segmented`의 선택지 타입 `{ value: T; label: string; disabled?: boolean; description?: ReactNode }`. 나머지 props는 그대로(`className`은 지금처럼 묶음 `div`의 클래스 끝에 붙는다 — Task 2가 `"max-w-full flex-wrap"`을 넘긴다).
- Produces: `OptionTip({ anchor, children, onPointerEnter, onPointerLeave }: { anchor: HTMLElement; children: ReactNode; onPointerEnter: () => void; onPointerLeave: () => void })` — `document.body`(또는 가장 가까운 `[role="dialog"][aria-modal="true"]`)에 portal, `position: fixed`, 폭 `TIP_WIDTH_PX`, `computeTipPos`로 자리(열 때 높이 0으로 한 번, `useLayoutEffect`에서 실측 높이로 한 번 — `HelpTip`과 같은 방식), `role="tooltip"`, `aria-hidden="true"`, 클래스는 `HelpTip` 판과 같다(`block whitespace-normal rounded-md border border-slate-200 bg-white p-2 text-left text-xs font-normal text-slate-700 shadow-lg`, `zIndex: 60`).

동작 규칙(spec R5 — 이것이 결정이다):
- 숨은 설명: `description`이 있는 선택지마다 `<span id={`${baseId}-${value}-desc`} hidden>{description}</span>`을 **단추의 형제**로 늘 그리고, 그 단추에 `aria-describedby`를 건다(`hidden`이어도 `aria-describedby`로는 읽힌다 — 둘러보기 읽기에서 떠도는 글자로 읽히지 않게 `sr-only` 대신 `hidden`). `baseId`는 `useId()`.
- 열림: ① `pointerenter`(단추) ② 키보드 초점 — `focus` 이벤트에서 `e.currentTarget.matches(":focus-visible")`일 때만.
- 닫힘: ① 마우스가 단추와 툴팁 둘 다에서 떠난 뒤 **120ms**(그 안에 툴팁이나 단추에 다시 들어가면 취소) ② `blur` ③ Esc — 닫고, 그 단추에 다시 `pointerenter`나 `focus`가 올 때까지 닫힌 채(Esc 리스너는 툴팁이 열려 있을 때만 `window`에 capture로 달고 `stopPropagation`) ④ `scroll`(capture)·`resize`.
- 한 번에 하나: 상태는 `openValue: T | null` 하나.
- 화살표 키: `step()`이 `onChange(next.value)`를 부른 뒤 그 선택지의 단추에 `focus()`(단추 ref를 `Map<T, HTMLButtonElement>`로 들고 있는다). 초점이 옮겨 가면 위 규칙 ②로 그 단추의 툴팁이 뜬다.
- `description`이 하나도 없으면 리스너·숨은 설명·`aria-describedby`가 없다(지금 DOM 그대로).
- 테스트 방식: `vi.useFakeTimers()` + `fireEvent.pointerEnter/pointerLeave` + `act(() => vi.advanceTimersByTime(120))`. user-event는 가짜 타이머와 함께 쓰지 않는다(이 저장소에 `advanceTimers` 선례가 없다 — 키보드 테스트는 진짜 타이머로 `userEvent`). jsdom은 초점이 있으면 `:focus-visible`로 보므로 `user.click`도 툴팁을 연다 — 글자 질의는 `within(...)`으로 범위를 좁힌다.

- [ ] **Step 1: 실패하는 테스트를 쓴다** — `Segmented.test.tsx`에 `describe("Segmented — 초점 이동과 설명 툴팁")`:

```tsx
const OPTS = [
  { value: "a", label: "가", description: "가 설명" },
  { value: "b", label: "나", description: "나 설명" },
  { value: "c", label: "다", description: "다 설명" },
] as const;

it("화살표 키로 고르면 초점이 고른 단추로 간다", async () => {
  // value를 상태로 든 래퍼로 렌더. radio "가"에 focus → ArrowRight
  // expect(document.activeElement).toBe(screen.getByRole("radio", { name: "나" }));
});
it("단추의 접근 이름에 설명이 섞이지 않고 aria-describedby가 설명을 가리킨다(닫혀 있어도)", () => {
  // getByRole("radio", { name: "나" }) 가 정확히 하나 · toHaveAccessibleDescription("나 설명")
});
it("마우스를 올리면 그 선택지의 툴팁이 뜨고, 툴팁 위로 옮겨도 열려 있다", async () => {
  // fake timers. pointerEnter(나) → getByRole("tooltip", {hidden:true}) 글자 "나 설명"
  // pointerLeave(나) → pointerEnter(tooltip) → 120ms 진행 → 아직 있다
  // pointerLeave(tooltip) → 120ms 진행 → 없다
});
it("Esc로 닫히고, 다시 초점이 오면 열린다", async () => {
  // user.tab() → tooltip 있음 → keyboard("{Escape}") → 없음
  // 같은 단추에 머문 채로는 다시 뜨지 않는다(추가 이벤트 없이 queryByRole("tooltip",{hidden:true}) === null)
  // user.tab({shift:true}) → user.tab() (다시 초점) → tooltip 있음
});
it("키보드 초점으로 뜨고 blur로 닫힌다", async () => { /* user.tab() → tooltip "가 설명"(선택값 a) */ });
it("한 번에 하나만 뜬다", async () => { /* 가 → 나로 옮기면 tooltip 하나, 글자 "나 설명" */ });
it("description이 없으면 숨은 설명·aria-describedby·툴팁이 없다", async () => {
  // 기존 OPTS(설명 없음)로 렌더 → container.querySelector("[hidden]") === null, radio에 aria-describedby 없음,
  // pointerEnter 뒤에도 queryByRole("tooltip", {hidden:true}) === null
});
```

- [ ] **Step 2: 실패 확인** — `pnpm --dir ui exec vitest run src/components/ui/__tests__/Segmented.test.tsx` → 새 테스트 FAIL, 기존 테스트 PASS.
- [ ] **Step 3: `OptionTip.tsx`를 만들고 `Segmented.tsx`를 위 규칙대로 고친다.**
- [ ] **Step 4: 통과 확인** — 같은 명령 PASS. 이어서 소비처: `pnpm --dir ui exec vitest run src/components/report/__tests__/BasisBar.test.tsx src/components/run` → 무수정 PASS.
- [ ] **Step 5: 되돌려 확인** — `step()`의 `focus()` 한 줄을 지우고 「초점이 고른 단추로 간다」가 FAIL하는지 본 뒤 되돌린다.
- [ ] **Step 6: 게이트 + 커밋** — `feat(ui): Segmented — 화살표 키 초점 이동 + 선택지 설명 툴팁`

---

### Task 2: 문구 + `sampleView` + `SampleBar` 단추 (R3·R6·R7·R8·R16·R18)

**Files:**
- Modify: `ui/src/i18n/ko.ts` (`ko.report.sample`), `ui/src/components/report/SampleBar.tsx`
- Create: `ui/src/report/sampleView.ts`
- Test: `ui/src/report/__tests__/sampleView.test.ts`(새로), `ui/src/components/report/__tests__/SampleBar.test.tsx`

**Interfaces:**
- Consumes: Task 1의 선택지 `description`.
- Produces (`sampleView.ts`):

```ts
export type SampleView = {
  selected: ReportSampleName;   // 실제로 받은 표본
  default: ReportSampleName;
  split: boolean;
  switched: boolean;            // split && selected !== default
  tag: string | null;           // switched면 표본 이름(「실패한 요청」·「모든 요청」·「통과한 요청」), 아니면 null
};
export function sampleView(report: Pick<Report, "sample">): SampleView;
export function sampleName(s: ReportSampleName): string;   // passed → ko.report.sample.passed, failed → .failed, all → .allShort
/** 그 표본에 값이 없을 때의 낱말. failed: 오류 0건 → noFailed, 그 밖 → noFailedMeasured. all → noMeasured. passed → noSample. */
export function noLatencyWord(s: ReportSampleName, errors: number): string;
```

- Produces (`SampleBar` props): `{ report: Pick<Report, "windows" | "sample">; requested?: ReportSampleName; pending?: boolean; onSelect?: (s: ReportSampleName) => void }`.
- Produces (`ko.report.sample` 새 열쇠 — 글자는 spec §5 표 그대로 — `waterfallNote`·`passedHelpLead`만 여기 적은 글자): `failed`, `allShort`, `switchAria`, `whenPassed`, `lookPassed`, `whenFailed`, `lookFailed`, `whenAll`, `lookAll`, `failedHint`, `allSelectedHint`, `switchedNote: (name: string) => string`, `waterfallNote: (chipsLabel: string) => string`(「이 보기의 값은 표본을 따르지 않습니다. 표본별 응답 시간은 「{chipsLabel}」 보기에서 봅니다.」), `noFailed`, `noFailedMeasured`, `noMeasured`, `passedHelpLead`(「「통과」는 」 — (?) 마지막 줄의 주어). `helpLabel`의 값을 「응답 시간 표본 설명」으로 바꾼다. 기존 열쇠(`passed`·`all`·`passedHint`·`allHint`·`passedHelp`·`noSample`·`mixed*`·`stairP99*`)는 그대로.

`SampleBar` 모양:
- `windows.length === 0` → `null`(그대로). `split`이 아니면 지금 그대로(표지 + `allHint`).
- `split`이면: 이름표 → `<Segmented<ReportSampleName> value={requested ?? view.default} onChange={(s) => onSelect?.(s)} ariaLabel={t.switchAria} busy={pending} className="max-w-full flex-wrap" options=[passed, failed, all] />` — 각 선택지의 `description`은 `<><span className="block">{when}</span><span className="mt-1.5 block">{look}</span></>`(목업 1의 두 줄, 6px 틈) → `HelpTip`(이름표 `t.helpLabel`): 세 줄 `<span className="block"><b>{이름}</b> — {when} {look}</span>` + 마지막 줄 `<span className="block">{t.passedHelpLead}{t.passedHelp}</span>`(목업 2의 「「통과」는 오류로 세지 않은 요청입니다…」 — 새 열쇠 `passedHelpLead: "「통과」는 "`) → 설명 한 줄: 받은 표본 기준 `passed → passedHint`, `failed → failedHint`, `all → allSelectedHint`.
- `view.switched`면 줄 아래에 `<Callout variant="warn" role="note" className="mb-4">{t.switchedNote(sampleName(view.selected))}</Callout>`(목업 2의 노란 상자 = `warn`). 줄의 `mb-4`는 상자가 있을 때 `mb-2`.

- [ ] **Step 1: 실패하는 테스트를 쓴다.**
  - `sampleView.test.ts`: 표 — `{selected:"failed",default:"passed",split:true}` → `switched: true, tag: "실패한 요청"` · `{all, passed, true}` → `tag: "모든 요청"` · `{passed, passed, true}` → `switched: false, tag: null` · `{all, all, false}` → `switched: false, tag: null` · `sample` 없음 → `all/all/false/false/null`. `noLatencyWord("failed", 0)` = 「실패한 요청 없음」, `("failed", 5)` = 「실패한 요청은 모두 보내기 전에 실패해 잰 시간이 없음」, `("all", 0)` = 「요청이 모두 보내기 전에 실패해 잰 시간이 없음」, `("passed", 0)` = 「통과한 요청 없음」.
  - `SampleBar.test.tsx`: 기존 첫 테스트 「…전환 단추는 없다」를 「나뉜 run: 단추 셋, 요청한 표본이 눌려 있다」로 고친다(이 슬라이스가 뒤집는 단언). 새 테스트:
    - split + `requested` 없음 → `radio` 셋, 「통과한 요청」 `aria-checked="true"`, 설명 `passedHint`, `note` 없음.
    - split + 리포트 `selected: "failed"` + `requested: "failed"` → 설명 = `failedHint`, `getByRole("note")` 글자 = 「응답 시간 숫자만 실패한 요청 기준으로 바꿔 보여 줍니다. 판정·인사이트·계단 표는 바뀌지 않습니다. 인쇄·CSV·XLSX는 통과한 요청 기준입니다.」
    - 불러오는 중(두 방향): 리포트 `selected: "passed"` + `requested: "failed"` → 「실패한 요청」이 눌림, 설명은 `passedHint` / 리포트 `selected: "failed"` + `requested` 없음 → 「통과한 요청」이 눌림, 설명은 `failedHint`, 상자 있음.
    - `pending` → `radiogroup`에 `aria-busy="true"`.
    - 단추를 누르면 `onSelect("all")`.
    - (?)를 누르면 판 안에 세 표본 이름과 `whenFailed`·`lookAll`·`passedHelp` 글자.
    - radio마다 `toHaveAccessibleDescription`: 「통과한 요청」은 `whenPassed`를, 「실패한 요청」은 `whenFailed`를, 「모든 요청」은 `whenAll`을 포함한다.
    - not split + `requested: "failed"` → `radio` 없음, 표지 `t.all`, `note` 없음(R14).
- [ ] **Step 2: 실패 확인** — `pnpm --dir ui exec vitest run src/report/__tests__/sampleView.test.ts src/components/report/__tests__/SampleBar.test.tsx`.
- [ ] **Step 3: `ko.ts` 열쇠, `sampleView.ts`, `SampleBar.tsx`를 쓴다.**
- [ ] **Step 4: 통과 확인** + R16: `grep -n "전체" ui/src/i18n/ko.ts`의 결과 가운데 `sample: {` 블록 안의 줄이 없음을 확인(블록 범위는 `grep -n "    sample: {" ui/src/i18n/ko.ts`와 그다음 `^    },` — 줄 머리 고정).
- [ ] **Step 5: 게이트 + 커밋** — `feat(ui): 표본 줄에 전환 단추·설명·안내 상자`

---

### Task 3: 주소 `?sample=` 배관 (R1·R2·R4·R13·R14·R15)

**Files:**
- Modify: `ui/src/pages/RunDetailPage.tsx`, `ui/src/components/report/ReportView.tsx`
- Test: `ui/src/pages/__tests__/RunDetailPage.sample.test.tsx`(새로 — `RunDetailPage.basis.test.tsx`의 픽스처·라우터 틀을 본뜬다), `ui/src/components/report/__tests__/ReportView.test.tsx`

**Interfaces:**
- Consumes: Task 2의 `SampleBar` props.
- Produces (`ReportView` props 추가): `requestedSample?: ReportSampleName`, `onSelectSample?: (s: ReportSampleName) => void`. `pending`은 기존 것을 `SampleBar`에도 넘긴다.
- `RunDetailPage`:
  - `const sampleParam = searchParams.get("sample"); const sample = sampleParam === "passed" || sampleParam === "failed" || sampleParam === "all" ? sampleParam : undefined;`
  - `useRunReport(id, terminal, basis, sample)`.
  - `selectSample(s)`: `next = new URLSearchParams(searchParams)`; `s === report.data?.sample?.default`(없으면 `"all"`과 비교 — `reportSample()` 사용)이면 `next.delete("sample")`, 아니면 `next.set("sample", s)`; `setSearchParams(next, { replace: true })`.
  - `<ReportView … requestedSample={sample} onSelectSample={selectSample} />`. `selectBasis`는 그대로(`sample`을 건드리지 않는다 — `URLSearchParams`를 복사해 `basis`만 고치므로 이미 그렇다. 테스트로 고정).
- `ReportView`: `<SampleBar report={report} requested={requestedSample} pending={pending} onSelect={onSelectSample} />`. 인쇄 링크·내려받기 주소·JSON 이름은 건드리지 않는다.

- [ ] **Step 1: 실패하는 테스트를 쓴다** — `RunDetailPage.sample.test.tsx`. basis 테스트의 틀을 본뜨되 그대로 베끼면 안 되는 곳 셋: ① 그 픽스처는 `windows: []`라 `SampleBar`가 안 그려진다 — 창을 하나 이상 넣는다 ② `sample: { selected, default: "passed", split: true }` 블록을 넣는다(받은 표본은 요청 URL의 `sample=`에서 읽어 채운다) ③ 그 모의는 `url.endsWith("?basis=whole")`로 가른다 — 여기서는 `new URL(url, "http://x").searchParams`로 `basis`·`sample`을 읽어 가르고, 리포트 요청 URL을 배열에 모은다. 테스트:
  - `/runs/R?sample=failed` → 리포트 요청 URL에 `sample=failed`.
  - `/runs/R?sample=xyz` → 리포트 요청 URL에 `sample` 없음(R1 — 되돌려 확인 대상).
  - `/runs/R?basis=whole&sample=all` → URL에 `basis=whole`과 `sample=all`.
  - split 리포트에서 「실패한 요청」 radio 누름 → 주소 `search`에 `sample=failed` · 다시 「통과한 요청」 → `sample` 없음.
  - `?sample=failed` 상태에서 기준 단추를 누름 → 주소에 `basis=…`와 `sample=failed`가 함께(US8).
  - 나눌 수 없는 run(`sample: {selected:"all", default:"all", split:false}`)을 `/runs/R?sample=failed`로 → `radio` 중 표본 단추 없음, `note` 없음, 표지 「모든 요청 (실패한 요청 포함)」(R14).
  - `ReportView.test.tsx`: `switched` 리포트에서도 인쇄 링크 `href`에 `sample` 없음, CSV·XLSX 주소(모의 `downloadFile`의 첫 인자)에 `sample` 없음(R13).
- [ ] **Step 2: 실패 확인** — 구현 전에도 통과하는 것이 정상인 테스트: 「`?sample=xyz`」(이는 Step 5의 되돌려 확인이 이빨이다)·R13(인쇄·내보내기 주소)·R14(나눌 수 없는 run). 나머지는 FAIL.
- [ ] **Step 3: 구현.**
- [ ] **Step 4: 통과 확인** — 새 파일 + `RunDetailPage.basis.test.tsx`·`RunDetailPage.test.tsx`·`src/components/run`(사이징 도우미, R15) 무수정 PASS.
- [ ] **Step 5: 되돌려 확인** — `sample` 검증을 `sampleParam ?? undefined`로 바꿔 「`xyz`」 테스트가 FAIL하는지 본 뒤 되돌린다.
- [ ] **Step 6: 게이트 + 커밋** — `feat(ui): run 상세가 주소의 표본으로 리포트를 받는다`

---

### Task 4: 표본을 따르는 문장과 「—」 (R10·R11·R12)

**Files:**
- Modify: `ui/src/components/report/ReportHeadline.tsx`, `ui/src/components/report/Summary.tsx`, `ui/src/components/report/basisText.ts`, `ui/src/components/report/BasisBar.tsx`, `ui/src/components/report/ReportView.tsx`, `ui/src/i18n/ko.ts`
- Test: `ui/src/components/report/__tests__/latencyDash.test.tsx`(지금 `basisOtherLine`·`Summary`·`ReportHeadline`의 응답 시간 「—」 테스트가 모여 있는 파일 — 새 경우를 여기에 더한다), `ReportView.test.tsx`

**Interfaces:**
- Consumes: `sampleView`, `sampleName`, `noLatencyWord`(Task 2).
- `ReportHeadline`·`Summary`의 `latency` prop에 칸 하나: `{ sample; counts; switched?: boolean }`. `ReportView`가 `switched: view.switched`를 넣는다.
- 값 없음 판정(두 부품 같은 식): `latency != null && (latency.switched || latency.sample !== "all") && !hasLatency(latency.counts, latency.sample)`. — 나눌 수 없는 run(`all`, `switched` 거짓)은 지금처럼 늘 값.
- `ko.report` 문구 추가: `headlineLatencyFailed: (p95: string) => \`실패한 요청의 95%가 ${p95} 안에 실패\``, `headlineLatencyAll: (p95: string) => \`모든 요청의 95%가 ${p95} 안에 끝남\``. 기존 `headlineLatency`는 그대로.
- `ReportHeadline`의 `common.latency`:
  - `switched`가 아니면 지금 식 그대로.
  - `switched`이고 값 없음 → `noLatencyWord(latency.sample, summary.errors)`.
  - `switched`이고 값 있음 → `failed`: `headlineLatencyFailed(formatSecondsKo(summary.p95_ms))`, `all`: `headlineLatencyAll(…)`.
- `basisOtherLine(basis, sample, switched = false)`:
  - 이름표: `switched`면 `` `${기준 이름} (${sampleName(sample)})` ``, 아니면 지금 그대로.
  - 값 없음: `switched`가 아니면 지금 식(`sample === "passed" && (count === 0 || error_rate >= 1)`). `switched`면 `failed → count === 0 || error_rate === 0`, `all → count === 0`.
- `BasisBar`에 `switched?: boolean` prop → `basisOtherLine`에 넘긴다. `ReportView`가 넣는다.

- [ ] **Step 1: 실패하는 테스트를 쓴다.**
  - `ReportHeadline`(`latencyDash.test.tsx`에 — 문장 전체가 아니라 문장 안의 구절을 `toHaveTextContent`로):
    - `{sample:"failed", switched:true}`, 값 있음(p95 3ms) → 「실패한 요청의 95%가」와 「안에 실패」 · 「안에 응답」 없음.
    - `failed`, `errors: 0` → 「실패한 요청 없음」.
    - `failed`, `errors: 5, notSent: 5` → 「실패한 요청은 모두 보내기 전에 실패해 잰 시간이 없음」 · 「실패한 요청 없음, 」 꼴이 아님(정확히 그 낱말).
    - `{sample:"all", switched:true}` 값 있음 → 「모든 요청의 95%가」와 「안에 끝남」 · 값 없음(`count: 4, notSent: 4`) → 「요청이 모두 보내기 전에 실패해 잰 시간이 없음」.
    - `{sample:"all"}`(`switched` 없음 — 나눌 수 없는 run), `count: 10, errors: 0, notSent: 0`, p95 값 있음 → 「안에 응답」이 있고 「모든 요청의」가 없다(R14 — 되돌려 확인 대상).
    - `{sample:"passed"}` 값 없음 → 「통과한 요청 없음」(그대로).
  - `Summary`(`latencyDash.test.tsx`에): `failed`+`switched`+실패 0 → p50·p95·p99 「—」 · `all`+`switched`+전부 보내지 않음 → 「—」 · `all`, `switched` 없음, 전부 보내지 않음 → 지금처럼 `0 ms`.
  - `basisOtherLine`: `switched` + `failed` → 글자에 「전체 구간 (실패한 요청):」 · `other.error_rate === 0` → 「p95 —」 · `switched` + `all` + `other.count === 0` → 「p95 —」 · `switched` 없음 → 지금 글자와 같다(기존 테스트 무수정).
  - `ReportView.test.tsx`(배선 — 부품 테스트는 `switched`를 직접 넘기므로 `ReportView`가 넘기는지는 여기서만 잡힌다): `sample: {selected:"failed", default:"passed", split:true}`, `summary.errors: 0`, `basis.other`가 있는 리포트 → 머리말 구획(`region` 이름 `ko.report.headlineAria`)에 「실패한 요청 없음」이 있고 「통과한 요청 없음」이 없다 · 요약 구획(`/리포트 요약/`) 안의 「—」가 셋(`latencyDash.test.tsx`의 기존 세는 방식) · 「다른 기준」 줄에 「(실패한 요청)」. 픽스처: `basis.selected: "steady"`, `dropped_whole_run: false`, `basis.other` 있음(`ReportView.test.tsx`에 `basis.other`를 넣은 선례가 있다). 이 테스트의 이빨은 머리말과 「다른 기준」 줄이다(「—」 셋은 배선 없이도 나온다).
- [ ] **Step 2: 실패 확인.**
- [ ] **Step 3: 구현.**
- [ ] **Step 4: 통과 확인** — 위 파일들 + `ReportHeadline.test.tsx`·`Summary.test.tsx`·`BasisBar.test.tsx`·`verdictNoSample.test.tsx` 무수정 PASS(`latencyDash.test.tsx`의 기존 경우도 무수정).
- [ ] **Step 5: 되돌려 확인 둘** — ① `ReportHeadline`의 `common.latency` 갈래에서 `latency.switched`를 `latency.sample !== "passed"`로 바꾼다 → 「나눌 수 없는 run」 테스트가 FAIL(「모든 요청의」가 나온다) → 되돌린다. ② `ReportView`에서 `switched: view.switched`를 지운다 → `ReportView.test.tsx`의 배선 테스트가 FAIL → 되돌린다.
- [ ] **Step 6: 게이트 + 커밋** — `feat(ui): 머리말·요약·다른 기준 줄이 고른 표본을 말한다`

---

### Task 5: 구획 표지 · 「막대」 보기 안내 · 분포 구획 껍데기 (R9·R9-1·R11-1)

**Files:**
- Create: `ui/src/components/report/SampleTag.tsx`
- Modify: `ui/src/components/report/Summary.tsx`, `TimeSeriesChart.tsx`, `StepStatsTable.tsx`, `StepPhaseBreakdown.tsx`, `WorkerBreakdownTable.tsx`, `ReportView.tsx`
- Test: `ui/src/components/report/__tests__/sampleTag.test.tsx`(새로 — 구획별 표지 유무를 한 파일에), `StepPhaseBreakdown.test.tsx`, `ReportView.test.tsx`

**Interfaces:**
- Consumes: `SampleView.tag`(Task 2), `noLatencyWord`.
- Produces: `SampleTag({ name, className }: { name: string; className?: string })` = `<Badge tone="accent" weight="medium" className={className}>{name}</Badge>`(목업 3의 표지).
- 각 부품에 선택 prop `sampleTag?: string | null`(없거나 `null`이면 지금 DOM 그대로):
  - `Summary`: p50 카드(라벨 `"p50"`)의 이름 곁에만 — `WholeRunBadge`를 다는 자리와 같은 곳에 `<SampleTag name={sampleTag} className="ml-1" />`.
  - `TimeSeriesChart`: `PageSection`의 `titleAside`로. `ReportView`는 p95 그래프에만 넘긴다(요청 수·오류 그래프에는 넘기지 않는다).
  - `StepStatsTable`: `PageSection`의 `titleAside`로(지금은 `titleAside`를 쓰지 않는다).
  - `StepPhaseBreakdown`: `sampleTag`를 받아 ① 단계 분해 없는 run과 「칩」 보기 → `StepStatsTable`에 그대로 넘긴다 ② 「막대」 보기 → 표지 없이, 막대 목록 위에 `<p className="mb-2 text-xs text-slate-500">{ko.report.sample.waterfallNote(ko.report.phaseViewChips)}</p>`.
  - `WorkerBreakdownTable`: `titleAside`로.
  - `ReportView`의 분포 구획: `report.latency`가 있으면 지금 구획에 `titleAside={tag && <SampleTag name={tag} />}`. `report.latency`가 없고 `view.switched`면 같은 `PageSection`(같은 `ariaLabel`·`title`·`titleAside`)에 `<p className="text-sm text-slate-500">{noLatencyWord(view.selected, report.summary.errors)}</p>`. 둘 다 아니면 지금처럼 구획이 없다.
- `ReportView`: Task 4에서 만든 `view`(`sampleView(report)`)를 다시 쓴다. 위 다섯 곳에 `sampleTag={view.tag}`.

`ReportView` 자식의 「표본을 따른다 / 안 따른다」(spec R9의 전수 표 — plan 작성 때 `f4228735`의 `ReportView.tsx` JSX와 대조했고 검토에서 부품 이름 30개를 다시 확인했다. 구현자가 기계 대조를 다시 할 필요는 없다 — 이 표에 없는 **화면 부품**이 `ReportView`에 보이면(다른 작업이 끼어든 경우) 표지를 달지 말고 보고한다):

| 자식 | 표본을 따르나 | 표지 |
|---|---|---|
| `BasisBar`(다른 기준 줄) | 따른다 | 줄 안의 이름(Task 4) |
| `SampleBar` | — | 단추 자체 |
| `ReportHeadline` | 따른다(문장) | 문장 안의 이름(Task 4) |
| `ValidityBanner`·`LoopRetryNotice`·`StairResultSection`·`VerdictPanel`·`InsightPanel`·`AppliedTimeouts` | 안 따른다 | 없음 |
| `Summary` | p50·p95·p99만 | p50 카드 |
| `TimeSeriesChart` 요청 수·오류 | 안 따른다 | 없음 |
| `TimeSeriesChart` p95 | 따른다 | 제목 곁 |
| `ActiveVuChart` | 안 따른다 | 없음 |
| `WorkerBreakdownTable` | 따른다 | 제목 곁 |
| 분포(`PercentileCurveChart`·`LatencyHistogramChart`) | 따른다 | 제목 곁 |
| `StatusDistribution`·`ErrorKindTable`·`ConnectionCostCard` | 안 따른다 | 없음 |
| `StepPhaseBreakdown` → `StepStatsTable` | p50·p95·p99 열 | 표 제목 곁(「막대」 보기는 안내 줄) |
| `SetupSection`·`LoopExitSummary`·`BranchStatsTable`·`LoopExitPanel`·`GroupLatencyTable` | 안 따른다(「실패 포함」) | 없음 |
| `ScenarioSnapshot` | 안 따른다 | 없음 |
| `Link`(인쇄)·`DownloadMenu`·`HelpTip`(내려받기 도움말)·`Callout`(내려받기 오류)·`PageSection`(분포 구획의 틀) | 안 따른다 | 없음 |

- [ ] **Step 1: 실패하는 테스트를 쓴다.**
  - `sampleTag.test.tsx`: 부품마다 `sampleTag="실패한 요청"`이면 그 글자가 있고(그리고 `heading`의 접근 이름에는 없다 — `getByRole("heading", { name: 원래 제목 })`가 그대로 잡힌다), `sampleTag` 없음·`null`이면 없다: `Summary`(p50 카드 안에만 — p95·p99 카드에는 없다), `TimeSeriesChart`, `StepStatsTable`, `WorkerBreakdownTable`(워커 2개 픽스처).
  - `StepPhaseBreakdown.test.tsx`: 단계 분해 픽스처 + `sampleTag` → 기본 보기에 `waterfallNote` 글자(「…「칩」 보기에서 봅니다.」)가 있고 표지 없음 · 「칩」 단추를 누르면 표지 있고 안내 줄 없음 · `sampleTag` 없음 → 둘 다 없음.
  - `ReportView.test.tsx`:
    - `switched`(failed) 리포트 → 「실패한 요청」 표지가 요약·p95 그래프·분포·스텝 표에 하나씩(워커 2개 픽스처면 다섯) · 요청 수 그래프 구획 안에는 없다.
    - `switched` + `latency` 없음 + `errors: 0` → 분포 구획(`region` 이름 `ko.report.latencyTitle`)이 있고 「실패한 요청 없음」.
    - 기본 표본(passed) → 표지를 다는 구획 넷(요약·p95 그래프·분포·스텝 표 — 각각 `within(getByRole("region", { name: … }))`) 안에 표본 이름 셋(`ko.report.sample.passed`·`failed`·`allShort`) 가운데 어느 것도 없다(R9 — 되돌려 확인 대상. 범위를 좁히지 않으면 표본 줄의 단추 글자가 잡힌다) · `latency` 없음이면 분포 구획 없음.
    - 나눌 수 없는 run(`all/all/false`) → 같은 네 구획 안에 표본 이름 셋이 없다, 분포 구획은 `latency` 유무대로(R14).
- [ ] **Step 2: 실패 확인.**
- [ ] **Step 3: 구현.**
- [ ] **Step 4: 통과 확인** — `pnpm --dir ui exec vitest run src/components/report` 전부 PASS.
- [ ] **Step 5: 되돌려 확인** — `ReportView`에서 `sampleTag={view.tag}`를 `sampleTag={sampleName(view.selected)}`로 바꿔 「기본 표본 → 표지 0개」가 FAIL하는지 본 뒤 되돌린다.
- [ ] **Step 6: 게이트 + 커밋** — `feat(ui): 표본을 바꿔 보는 동안 구획마다 표본 표지`

---

## 구현 뒤 (orchestrator — task 아님)

1. **목업 대조(task 사이 — 미루지 않는다)**: Task 3이 머지된 직후(표본 줄이 처음 실제 화면에 뜨는 때) 화면을 띄워 목업 CSS와 대조한다 — 표본 줄·단추 묶음·툴팁 판·(?) 판·노란 상자. Task 5 직후 한 번 더 — 구획 표지·「막대」 보기 안내·분포 구획. 다르면 다음 task로 넘어가기 전에 고친다.
2. **최종 리뷰**: `handicap-reviewer`(whole-branch, BASE = 이 plan 커밋). `finish-slice` §0 보안 grep을 돌린다(매치 0 예상 — grep이 지배).
3. **라이브 검증**(`/live-verify`): spec §6 표의 run 가–마 + 옛 DB 사본 + 실행 창 화살표 키. 극단값(360px, 긴 스텝 이름·스텝 수십 개, 화면 끝의 툴팁)은 rect 실측.
4. **마무리**(`/finish-slice`): build-log·roadmap §B(다음 번호는 `grep -n '^### B' docs/roadmap.md`의 마지막 + 1)에 spec §7 연기 표를 옮긴다 · 현황판 · 상태줄.
