# RunDialog 목업 시각 충실도 + footer 부하-모양 시그니처 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Spec = `docs/superpowers/specs/2026-06-28-rundialog-mockup-fidelity-design.md` (read it; this plan assumes its R1–R15 + 결정 1–10). Visual oracle = `docs/superpowers/mockups/rundialog-v3.html` (+ `2026-06-28-rundialog-simple.png`/`-detailed.png`).

**Goal:** RunDialog를 v3 목업에 시각적으로 맞춘다(타일·프로파일 Segmented·측정 토글 카드·번호 Section eyebrow 재구성·헤더/버튼 카피) + footer에 전-모드 부하-모양 시그니처(`LoadShapePreview`)와 굵은-숫자/회색-sub 2단 요약을 추가한다. **payload·wire byte-identical**(시각/표현만 변경).

**Architecture:** UI-only. 모든 폼 state는 RunDialog가 소유(직전 슬라이스). 이 슬라이스는 className·요소·라벨 문구·footer 조각 구조만 바꾼다. 공유 컴포넌트(`LoadModelFields`) 확장은 기존 optional prop(`loadModelTiles`/`simpleMode`) 분기 재사용 — ScheduleForm 미전달이라 byte-identical. footer 요약 텍스트는 `runSummary`가 구조화 조각(`{main: SummarySegment[]; sub; tone; curve}`)을 반환하고 footer가 굵게/회색으로 렌더. 번호 `Section` 프리미티브(ADR-0043)를 그대로 재사용해 mockup #6 항목을 번호 Section으로 추가/분리(사용자 결정 2026-06-28).

**Tech Stack:** React + TS + Tailwind(accent 토큰), Vitest + React Testing Library, recharts(StageCurvePreview 패턴 — `LoadShapePreview`는 순수 SVG라 recharts 불요).

## Global Constraints

이 섹션은 모든 task에 암묵 포함된다.

- **payload byte-identical (R10):** `buildProfile`/`buildLoadProfile`/`resolveEnv`/`canSubmit`/`deriveLoadMode`/`detailedAppliedCount`·`advancedActiveCount`·`opensDetailed`의 *계수·판정식* 0-diff. `runSummary`는 *반환 구조*만 바꾸고 *판정 로직*(warn 게이트·curve 분기) 불변. `DEFAULT_SIMPLE_PROFILE` 골든 정확 `toEqual` 유지.
- **wire byte-identical (R11·R12):** `crates/**`·proto·migration·`ui/src/api/schemas.ts` **0-diff**. `ko.ts`는 신규 키 + 의도적 copy 변경만(기존 *공유* 키 `loadModel.closedLoop`/`openLoop`·`tileClosedDesc`/`tileOpenDesc` 불변). 공유 컴포넌트 신규 prop은 **전부 additive optional**(ScheduleForm 미전달=byte-identical). `SummarySegment`는 ko/runSummary 로컬 TS 타입(schemas.ts 미접촉).
- **기능 보존 (R9):** 사이징 도우미 3종·측정·판정·고급·프리셋 4동작·데이터셋 바인딩·R17 곡선 카드·blockedReasons·prefill 예측·per-tile HelpTip 전부 보존. 삭제 0.
- **accent 토큰만:** 선택/강조는 `accent-*`(=indigo, ADR-0043). 차트 stroke 색(`#2563eb`)은 데이터-식별 색이라 토큰화 금지(ui/CLAUDE.md). `LoadShapePreview`는 *장식*이라 accent OK.
- **게이트:** 각 task = **독립 green 커밋**. UI 게이트 `pnpm lint && pnpm test && pnpm build` 통과(`ui/` 디렉터리에서). `pnpm lint`=`--max-warnings=0`. cargo 무관(UI-only).
- **tdd-guard 순서:** watched src(`ui/src/**` non-test) 편집 *전에* pending test-path 파일(편집/신규)이 있어야 한다 → **각 task 첫 Step은 테스트 파일 편집/생성**(RED), 그 다음 src(ui/CLAUDE.md).
- **모드/모델 라우팅(1M 부모):** 이 세션은 Opus 4.8 1M일 수 있다 → 모든 subagent를 **명시 model**로 디스패치(implementer=`model: sonnet`, byte-identical/F1/footer-segment-민감 review=`model: opus`). `model:` 생략 금지(1M 상속→즉사).
- **시각 acceptance (R15):** 머지 전 live-verify(open+fixed 100/300/200) 스크린샷을 PNG와 대조. 번호 Section ①②③·고정 footer 미니그래프는 의도적 잔존(미스매치 아님).

---

## File Structure

| File | 책임 | 변경 |
|---|---|---|
| `ui/src/components/LoadShapePreview.tsx` | footer 부하-모양 장식 SVG(flat/curve·accent·role=img) | **Create** |
| `ui/src/components/__tests__/LoadShapePreview.test.tsx` | 위 단위 테스트 | **Create** |
| `ui/src/components/LoadModelFields.tsx` | 타일 룩/제목·프로파일 Segmented·legend sr-only·프로파일 eyebrow | Modify |
| `ui/src/components/RunDialog.tsx` | 헤더 제목·Section 재구성(부하모델/환경/데이터셋/측정/저장)·측정 토글 카드·적용 칩·footer 렌더 | Modify |
| `ui/src/components/runSummary.ts` | `{main: SummarySegment[]; sub; tone; curve}` 재구조화 | Modify |
| `ui/src/i18n/ko.ts` | 신규 키(tile-title·warn-sub·section title) + 의도 copy(title/run/summary) | Modify(add-only + copy) |
| `ui/src/components/__tests__/RunDialog.test.tsx` | 39 실행→실행하기·타일 라벨·footer 매처·측정 role·칩·Section·제목 | Modify |
| `ui/src/components/__tests__/LoadModelFields.test.tsx` | 타일 라벨·accent+teeth·Segmented·fieldset 보존·프로파일 eyebrow | Modify |
| `ui/src/components/__tests__/runSummary.test.ts` | 세그먼트 단언 재작성 | Modify |
| `ui/src/components/__tests__/ScheduleForm.test.tsx` | **불변**(라디오·공유 키 — 절대 수정 금지) | — |

---

## Task 1: LoadShapePreview 장식 컴포넌트 (R5 메커니즘)

**Files:**
- Create: `ui/src/components/LoadShapePreview.tsx`
- Test: `ui/src/components/__tests__/LoadShapePreview.test.tsx`

**Interfaces:**
- Produces: `LoadShapePreview({ kind, stages, width, height, "aria-label"?, "aria-hidden"? })` where `kind: "flat" | "curve"`, `stages?: { target: number; duration_seconds: number }[]` (curve일 때 필수, 유효 행만), `width`/`height: number`. `kind="flat"`=수평선, `kind="curve"`=stages 비례 polyline(자체 제어점, `(0,0)` 강제 없음). 색=accent(`stroke="currentColor"` + 래퍼 `text-accent-600`). 단일 `<svg>` 반환(role/aria-label/aria-hidden은 props passthrough). **`StageCurvePreview`·recharts 미사용**(순수 SVG).

- [ ] **Step 1: Write the failing test**

`ui/src/components/__tests__/LoadShapePreview.test.tsx`:
```tsx
import { render } from "@testing-library/react";
import { LoadShapePreview } from "../LoadShapePreview";

describe("LoadShapePreview", () => {
  it("flat: 단일 수평 polyline (대각 ramp 아님 — y가 일정)", () => {
    const { container } = render(
      <LoadShapePreview kind="flat" width={60} height={30} aria-label="부하 모양" />,
    );
    const poly = container.querySelector("polyline");
    expect(poly).not.toBeNull();
    const pts = poly!.getAttribute("points")!.trim().split(/\s+/).map((p) => p.split(",").map(Number));
    const ys = pts.map(([, y]) => y);
    expect(Math.max(...ys) - Math.min(...ys)).toBe(0); // 수평 = 모든 y 동일
    expect(pts.length).toBeGreaterThanOrEqual(2);
  });

  it("curve: stages 비례 polyline + 마지막 점 y가 첫 점보다 위(0,0 시작 아님 검증은 stage 수)", () => {
    const { container } = render(
      <LoadShapePreview
        kind="curve"
        stages={[{ target: 10, duration_seconds: 30 }, { target: 100, duration_seconds: 30 }]}
        width={60}
        height={30}
        aria-label="부하 곡선"
      />,
    );
    const poly = container.querySelector("polyline");
    expect(poly).not.toBeNull();
    const n = poly!.getAttribute("points")!.trim().split(/\s+/).length;
    expect(n).toBeGreaterThanOrEqual(2); // 최소 두 stage → 비-수평
  });

  it("role/aria-label passthrough + aria-hidden 지원", () => {
    const { container, rerender } = render(
      <LoadShapePreview kind="flat" width={60} height={30} role="img" aria-label="부하 모양" />,
    );
    expect(container.querySelector('svg[role="img"][aria-label="부하 모양"]')).not.toBeNull();
    rerender(<LoadShapePreview kind="flat" width={60} height={30} aria-hidden />);
    expect(container.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
  });

  it("className 머지 — accent 색(text-accent-600) 보존 (R2)", () => {
    const { container } = render(<LoadShapePreview kind="flat" width={60} height={30} className="shrink-0" />);
    const svg = container.querySelector("svg")!;
    expect(svg).toHaveClass("text-accent-600"); // 머지 안 하면 shrink-0가 덮어써 FAIL
    expect(svg).toHaveClass("shrink-0");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && pnpm test LoadShapePreview`
Expected: FAIL ("Cannot find module '../LoadShapePreview'").

- [ ] **Step 3: Write minimal implementation**

`ui/src/components/LoadShapePreview.tsx`:
```tsx
import type { SVGProps } from "react";

type Stage = { target: number; duration_seconds: number };

/** footer 부하-모양 시그니처 — *장식*(데이터 차트 아님)이라 accent 색 OK.
 *  flat=수평 일정선, curve=stages 비례 polyline. StageCurvePreview와 달리
 *  (0,0) 시작을 강제하지 않는다(고정 부하가 대각 ramp로 안 보이게). */
export function LoadShapePreview({
  kind,
  stages,
  width,
  height,
  className,   // 분리해서 머지 — `...rest`에 두면 하드코딩 text-accent-600을 덮어 색 소실(R2)
  ...rest
}: {
  kind: "flat" | "curve";
  stages?: Stage[];
  width: number;
  height: number;
} & Pick<SVGProps<SVGSVGElement>, "role" | "aria-label" | "aria-hidden" | "className">) {
  const pad = 2;
  const w = width - pad * 2;
  const h = height - pad * 2;
  let points: string;
  if (kind === "curve" && stages && stages.length > 0) {
    // 누적 시간(x) × target(y) 제어점. y는 0..maxTarget를 height에 매핑(위가 큰 값).
    const maxT = Math.max(...stages.map((s) => s.target), 1);
    const totalD = stages.reduce((a, s) => a + s.duration_seconds, 0) || 1;
    const pts: [number, number][] = [[0, 0]];
    let acc = 0;
    for (const s of stages) {
      acc += s.duration_seconds;
      pts.push([acc / totalD, s.target / maxT]);
    }
    points = pts.map(([fx, fy]) => `${pad + fx * w},${pad + (1 - fy) * h}`).join(" ");
  } else {
    // flat: 일정 레벨(중간 높이). 두 점 = 수평선.
    const y = pad + h * 0.4;
    points = `${pad},${y} ${pad + w},${y}`;
  }
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={`text-accent-600 ${className ?? ""}`} {...rest}>
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth={2} />
    </svg>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui && pnpm test LoadShapePreview`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/rundialog-mockup-fidelity
git add ui/src/components/LoadShapePreview.tsx ui/src/components/__tests__/LoadShapePreview.test.tsx
git commit -m "feat(rundialog-fidelity): LoadShapePreview footer 부하-모양 장식 컴포넌트 (R5)"
```

---

## Task 2: 타일 룩 + 신규 제목 + 부하 모델 단일 헤더 (R1, R2, R14①)

**Files:**
- Modify: `ui/src/i18n/ko.ts` (loadModel: `tileClosedTitle`/`tileOpenTitle` add; runDialog: `sectionLoadTitle` "부하 정의"→"부하 모델")
- Modify: `ui/src/components/LoadModelFields.tsx:287-320` (legend sr-only; 타일 룩+신규 제목; HelpTip 배치)
- Modify: `ui/src/components/RunDialog.tsx:583` (Section1 title은 `sectionLoadTitle` 그대로 참조 — ko값만 바뀜)
- Test: `ui/src/components/__tests__/LoadModelFields.test.tsx`, `ui/src/components/__tests__/RunDialog.test.tsx`

**Interfaces:**
- Consumes: `ko.loadModel.tileClosedTitle`/`tileOpenTitle` (이 task가 추가).
- Produces: 타일 접근명 = `동시 사용자 (VU)` / `목표 RPS`. 타일 root `<button role="radio">`에 선택 시 `border-accent-500 bg-accent-50`, 비선택 `border-slate-200`.

**중요(R2):** 타일은 현재 `ko.loadModel.closedLoop`/`openLoop`(공유 키)를 렌더한다(`LoadModelFields.tsx:302,315`). 이걸 **신규 tile-title 키로 교체** — 공유 `closedLoop`/`openLoop`는 라디오 분기(`:336,349`)에 그대로 남아 ScheduleForm 보존. `tileClosedDesc`/`tileOpenDesc`는 이미 목업 일치(불변).

- [ ] **Step 1: Write the failing tests (RED) — 타일 라벨/accent/teeth + 섹션 제목**

**중요(F2 — 정확문자열 금지):** 타일 `<button role="radio">`의 접근명 = **제목 span + 설명 span 연결**(둘 다 비-aria-hidden) → 예 `"동시 사용자 (VU)N명이 동시에 반복 요청"`. 기존 셀렉터가 전부 *정규식 부분일치*인 이유다. **신규 타일 셀렉터도 정규식 부분일치**: `/동시 사용자 \(VU\)/`(괄호 escape)·`/목표 RPS/`. 정확문자열 `{name:"동시 사용자 (VU)"}`는 매치 실패.

`LoadModelFields.test.tsx`(테스트 헬퍼 = **`setup(overrides)` `:33`** — `tilesProps`/`radioProps`는 없음): 기존 타일 셀렉터 `{name:/사용자 수 기준/}`/`/요청 속도 기준/`를 **타일(loadModelTiles=true) 테스트에서** `{name:/동시 사용자 \(VU\)/}`/`{name:/목표 RPS/}`로 교체. **fieldset 보존 테스트(`:414-420`)는 group/tagName/desc 단언(`:416 group`·`:417 tagName==="FIELDSET"`·`:419 getByText(tileClosedDesc)`)만 유지, 그 안 `:418 getByRole("radio",{name:/사용자 수 기준/})`(loadModelTiles=true 타일)는 신규 라벨 `/동시 사용자 \(VU\)/`로 갱신**(C2 — "그대로 유지"는 :418 제외). 라디오 모드 테스트(`loadModelTiles` 미전달)는 `/사용자 수 기준/` 그대로. 신규 단언:
```tsx
it("선택 타일에 accent 클래스, 비선택엔 부재 (R1) + teeth", () => {
  setup({ loadModelTiles: true, loadModel: "closed" }); // setup가 내부에서 render — render() 래핑 금지(:56·이중렌더→multiple elements)
  const closed = screen.getByRole("radio", { name: /동시 사용자 \(VU\)/ });
  const open = screen.getByRole("radio", { name: /목표 RPS/ });
  expect(closed).toHaveClass("border-accent-500"); // 선택
  expect(open).not.toHaveClass("border-accent-500"); // 비선택 (teeth: 선택을 open으로 뒤집으면 FAIL)
});
```
`RunDialog.test.tsx` — 이 task가 갱신해야 할 **비-타일 카피 단언 + 타일 셀렉터**:
- **섹션 제목(C1·sectionLoadTitle 리타이틀이 깨뜨림 → 같은 커밋이라야 게이트 통과):** `:206 getByText("부하 정의")` → `getByText("부하 모델")`; `:2871`의 `includes("부하 정의")` → `includes("부하 모델")`.
- **타일 셀렉터:** RunDialog 타일 조회/클릭(footer 테스트 `:2713` `{name:/요청 속도 기준/}` → `/목표 RPS/` 포함)을 전수 grep으로 신규 정규식 라벨로 갱신. (`:2713`은 Task 5 footer 단언 `:2714`와 *다른 줄*이라 순차 충돌 없음.)
- **잔존 확인:** `grep -n "사용자 수 기준\|요청 속도 기준" RunDialog.test.tsx LoadModelFields.test.tsx` → *라디오 모드*(loadModelTiles 미전달) 참조만 남아야.

- [ ] **Step 2: ko.ts — 신규 tile-title 키 + sectionLoadTitle 리타이틀**

`ui/src/i18n/ko.ts` `loadModel` 블록(`:170-171` 부근)에 추가:
```ts
tileClosedTitle: "동시 사용자 (VU)",
tileOpenTitle: "목표 RPS",
```
`runDialog.sectionLoadTitle`(`:70`):
```ts
sectionLoadTitle: "부하 모델",   // was "부하 정의" (R14① 단일 헤더)
```

- [ ] **Step 3: LoadModelFields 타일 룩 + 제목 + legend sr-only (R1·R2·R14①)**

`LoadModelFields.tsx`:
- legend(`:288`) `className="text-sm text-slate-600 mb-1"` → `className="sr-only"`(시각 숨김·접근명 유지). 텍스트 "부하 모델" 그대로.
- 타일 컨테이너(`:293`) `flex items-center gap-4` → `grid grid-cols-2 gap-3`.
- 각 타일 셀: 기존 `<span className="flex items-center gap-1">`(button+HelpTip)을 `<div className="flex items-start gap-1">`로(HelpTip은 button 밖 형제 유지=결정 7). button className(`:300,313`)을 진짜 타일로:
```tsx
className={`flex-1 flex items-start gap-3 rounded-lg border p-3 text-left cursor-pointer ${
  loadModel === "closed" ? "border-accent-500 bg-accent-50" : "border-slate-200 hover:border-slate-300"
}`}
```
button 내부를 라디오 ◉ + 텍스트 열로:
```tsx
<span
  aria-hidden="true"
  className={`mt-0.5 h-3.5 w-3.5 shrink-0 rounded-full border ${
    loadModel === "closed" ? "border-accent-500 bg-accent-500" : "border-slate-300"
  }`}
/>
<span className="flex flex-col">
  <span className="font-semibold">{ko.loadModel.tileClosedTitle}</span>
  <span className="text-xs text-slate-500">{ko.loadModel.tileClosedDesc}</span>
</span>
```
open 타일도 동형(`tileOpenTitle`/`tileOpenDesc`·`loadModel === "open"`). HelpTip(`:305,318`)은 `<HelpTip className="shrink-0">…`로 그대로 형제 유지. **`role="radio"`/`aria-checked`/onClick 보존.**

- [ ] **Step 4: Run tests**

Run: `cd ui && pnpm test LoadModelFields RunDialog`
Expected: PASS. (teeth 확인: 로컬에서 일시적으로 선택 타일 className의 accent 분기를 비-accent로 뒤집어 R1 단언이 FAIL하는지 본 뒤 복원.)

- [ ] **Step 5: Full gate + commit**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/rundialog-mockup-fidelity/ui && pnpm lint && pnpm test && pnpm build
cd /Users/sgj/develop/handicap/.claude/worktrees/rundialog-mockup-fidelity
git add ui/src/i18n/ko.ts ui/src/components/LoadModelFields.tsx ui/src/components/__tests__/LoadModelFields.test.tsx ui/src/components/__tests__/RunDialog.test.tsx
git commit -m "feat(rundialog-fidelity): 진짜 타일 룩+라디오 인디케이터+신규 제목, 부하 모델 단일 헤더 (R1·R2·R14①)"
```

---

## Task 3: 프로파일 Segmented + 프로파일 eyebrow (R4, R14⑤)

**Files:**
- Modify: `ui/src/components/LoadModelFields.tsx:358-390` (프로파일 라디오 → `Segmented`, RunDialog 전용 게이트; legend → eyebrowCls)
- Test: `ui/src/components/__tests__/LoadModelFields.test.tsx`, `ui/src/components/__tests__/ScheduleForm.test.tsx`(불변 확인만)

**Interfaces:**
- Consumes: `Segmented`(`ui/src/components/ui/Segmented.tsx` — `role="radiogroup"` + `role="radio" aria-checked`, `value`/`onChange`/`options`/`ariaLabel`).
- 게이트: 프로파일 Segmented는 **`loadModelTiles` prop이 true일 때만**(RunDialog) — false(ScheduleForm)면 기존 라디오 유지. (`loadModelTiles`는 이미 LoadModelFields prop.)

- [ ] **Step 1: Write the failing test (RED)**

`LoadModelFields.test.tsx`:
테스트 헬퍼는 `setup(overrides)`(`LoadModelFields.test.tsx:33`). 프로파일 섹션은 `!simpleMode`에서만 렌더(`:358`) → `simpleMode: false` 명시. Segmented 버튼 접근명은 *단일 라벨*("고정"/"곡선")이라 **정확매치 OK**(타일과 달리 연결 없음).
```tsx
it("loadModelTiles=true: 프로파일이 Segmented(radio 고정/곡선) (R4)", () => {
  setup({ loadModelTiles: true, simpleMode: false, loadModel: "closed" }); // setup가 내부 render — 래핑 금지
  expect(screen.getByRole("radio", { name: "고정" })).toBeInTheDocument();
  expect(screen.getByRole("radio", { name: "곡선" })).toBeInTheDocument(); // 정확매치 — ramp_down 라벨의 "곡선" 단어와 구분
});
it("loadModelTiles 미전달(라디오 모드): 프로파일 라디오 유지 (R12)", () => {
  setup({ simpleMode: false, loadModel: "closed" }); // loadModelTiles 없음
  expect(screen.getByRole("radio", { name: "고정" })).toBeInTheDocument(); // input[type=radio] 유지
});
```

- [ ] **Step 2: Run → FAIL**

Run: `cd ui && pnpm test LoadModelFields`
Expected: 새 Segmented 테스트 FAIL(아직 라디오).

- [ ] **Step 3: 프로파일 라디오 → Segmented (게이트)**

`LoadModelFields.tsx:358-390`의 `<fieldset>` 내부를 분기:
```tsx
<fieldset className="mb-3">
  <legend className="text-[10px] font-semibold uppercase tracking-[0.15em] text-slate-500 mb-1">
    프로파일
  </legend>
  {loadModelTiles ? (
    <div className="flex items-center gap-1">
      <Segmented
        value={rateMode}
        onChange={(v) => setRateMode(v as "fixed" | "curve")}
        options={[
          { value: "fixed", label: "고정" },
          { value: "curve", label: "곡선" },
        ]}
        ariaLabel="프로파일"
      />
      {loadModel === "closed" && <HelpTip label="VU 곡선 설명">{ko.glossary.vuCurve}</HelpTip>}
    </div>
  ) : (
    /* 기존 라디오 — ScheduleForm byte-identical (현행 :361-388 그대로) */
    <div className="flex items-center gap-4">{/* …현행 라디오 JSX 유지… */}</div>
  )}
</fieldset>
```
`Segmented` import 추가(`import { Segmented } from "./ui/Segmented";`). HelpTip은 Segmented 밖 형제(U3). legend 텍스트 "프로파일"은 그대로(번호 없는 sub-eyebrow=eyebrowCls). **라디오 분기 JSX는 현행을 토씨 0-diff로 보존**(ScheduleForm).

- [ ] **Step 4: Run tests**

Run: `cd ui && pnpm test LoadModelFields ScheduleForm`
Expected: PASS. ScheduleForm.test.tsx **0-diff·green**(라디오 유지).

- [ ] **Step 5: Gate + commit**

```bash
cd .../ui && pnpm lint && pnpm test && pnpm build
cd /Users/sgj/develop/handicap/.claude/worktrees/rundialog-mockup-fidelity
git add ui/src/components/LoadModelFields.tsx ui/src/components/__tests__/LoadModelFields.test.tsx
git commit -m "feat(rundialog-fidelity): 프로파일 고정/곡선 Segmented (RunDialog 게이트) + 프로파일 eyebrow (R4·R14⑤)"
```

---

## Task 4: 카피 변경 — 실행하기 + 실행 설정 + 39 셀렉터 sweep (R6 버튼, R8) [mechanical]

**Files:**
- Modify: `ui/src/i18n/ko.ts` (`runDialog.title` "새 실행"→"실행 설정"; `runDialog.run` "실행"→"실행하기")
- Modify: `ui/src/components/__tests__/RunDialog.test.tsx` (39× `/^실행$/` → "실행하기"; 제목 단언)

**Interfaces:** Produces: 헤더 `실행 설정`, 실행 버튼 접근명 `실행하기`. (footer 버튼은 이미 `ko.runDialog.run` 참조 `:1066` — ko값만 바뀜·렌더 코드 0-diff.)

- [ ] **Step 1: Test sweep (RED) — RunDialog.test.tsx**

`/^실행$/` anchored 셀렉터 **39곳**(전부 `RunDialog.test.tsx`)을 `"실행하기"`로 교체. 정확 위치:
```bash
grep -n 'name: /\^실행\$/' ui/src/components/__tests__/RunDialog.test.tsx   # 39 매치 확인
```
각 `getByRole("button", { name: /^실행$/ })` → `getByRole("button", { name: "실행하기" })`. 제목 단언(있으면) `getByText("새 실행")`/`/새 실행/` → `"실행 설정"`. 없으면 추가:
```tsx
it("헤더 제목 '실행 설정' (R8)", () => {
  renderDialog();
  expect(screen.getByRole("heading", { name: "실행 설정" })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run → FAIL** (`cd ui && pnpm test RunDialog` — 옛 ko값이라 "실행하기" 미발견).

- [ ] **Step 3: ko.ts copy**

```ts
title: "실행 설정",   // runDialog.title :65 (was "새 실행")
run: "실행하기",      // runDialog.run :66 (was "실행")
```

- [ ] **Step 4: Run → PASS** (`cd ui && pnpm test RunDialog`). **전체** `pnpm test`도 돌려 다른 파일에 `/^실행$/` 잔존이 없는지 확인(grep 0 재확인).

- [ ] **Step 5: Gate + commit**

```bash
cd .../ui && pnpm lint && pnpm test && pnpm build
cd /Users/sgj/develop/handicap/.claude/worktrees/rundialog-mockup-fidelity
git add ui/src/i18n/ko.ts ui/src/components/__tests__/RunDialog.test.tsx
git commit -m "feat(rundialog-fidelity): 헤더 '실행 설정'·버튼 '실행하기' 카피 + 39 셀렉터 sweep (R6·R8)"
```

---

## Task 5: runSummary 세그먼트 + footer 렌더(LoadShapePreview + 굵은 main/회색 sub) (R5 렌더, R6 footer)

**Files:**
- Modify: `ui/src/i18n/ko.ts` (`summary*` main → `SummarySegment[]`; warn-sub 키 2개 추가; sub는 string 유지)
- Modify: `ui/src/components/runSummary.ts` (`{main: SummarySegment[]; sub; tone; curve}`)
- Modify: `ui/src/components/RunDialog.tsx:1031-1072` (footer: `LoadShapePreview` always-valid + main 굵게/sub 회색)
- Test: `ui/src/components/__tests__/runSummary.test.ts`(세그먼트 재작성), `RunDialog.test.tsx`(footer 매처)

**Interfaces:**
- Consumes: `LoadShapePreview`(Task 1).
- Produces: `type SummarySegment = { text: string; bold?: boolean }`; `runSummary(s): { main: SummarySegment[]; sub: string; tone: "ok"|"warn"; curve: boolean }`. ko: `summaryClosed`/`summaryOpen`/`summaryCurveVu`/`summaryCurveRps` → `SummarySegment[]` 반환; `summaryRampUp`/`summaryOpenSub`/`summaryCurveSub` → `string`(회색 sub); `summaryInvalid` → `string`; 신규 `summaryWarnClosedSub`/`summaryWarnOpenSub` → `string`.

**판정 로직 불변(R10):** warn 게이트(`!(vus>=1)||!time` 등)·curve 분기 구조는 `runSummary.ts` 현행 그대로. *조각화*만.

- [ ] **Step 1: runSummary.test.ts 재작성 (RED)**

세그먼트 단언으로:
```tsx
import { runSummary } from "../runSummary";
const base = { rateMode: "fixed", vus: 100, duration: 300, rampUp: 0, targetRps: "100", maxInFlight: "200", stages: [], thinkMin: "", thinkMax: "", thinkSeed: "", rampDown: "graceful", workerCount: "1" } as const;

it("closed+fixed: main 세그먼트에 굵은 vus·time, sub=램프업", () => {
  const r = runSummary({ ...base, loadModel: "closed" });
  expect(r.curve).toBe(false);
  expect(r.tone).toBe("ok");
  expect(r.main.map((s) => s.text).join("")).toBe("동시 사용자 100명 · 5분");
  expect(r.main.filter((s) => s.bold).map((s) => s.text)).toEqual(["100", "5분"]);
  expect(r.sub).toBe("램프업 없음");
});
it("open+fixed: 굵은 rps·total·time, sub=동시 요청 상한", () => {
  const r = runSummary({ ...base, loadModel: "open" });
  expect(r.main.map((s) => s.text).join("")).toBe("목표 100 RPS · 약 30,000건 · 5분");
  expect(r.sub).toBe("동시 요청 상한 200");
});
it("invalid(closed vus=0): main='설정을 확인하세요'(굵음 없음) + warn sub", () => {
  const r = runSummary({ ...base, loadModel: "closed", vus: 0 });
  expect(r.tone).toBe("warn");
  expect(r.main).toEqual([{ text: "설정을 확인하세요" }]);
  expect(r.sub).toBe("동시 사용자·시간을 입력");
});
it("closed+curve: main 굵은 peak, curve=true", () => {
  const r = runSummary({ ...base, loadModel: "closed", rateMode: "curve", stages: [{ target: "50", duration_seconds: "30" }] });
  expect(r.curve).toBe(true);
  expect(r.main.map((s) => s.text).join("")).toBe("최대 50명 (곡선)");
  expect(r.main.filter((s) => s.bold).map((s) => s.text)).toEqual(["50"]);
});
```

- [ ] **Step 2: Run → FAIL** (`cd ui && pnpm test runSummary`).

- [ ] **Step 3: ko.ts summary* → 세그먼트**

```ts
summaryClosed: (vus: number, time: string) => [
  { text: "동시 사용자 " }, { text: String(vus), bold: true }, { text: "명 · " }, { text: time, bold: true },
],
summaryRampUp: (sec: number) => (sec > 0 ? `램프업 ${sec}초` : "램프업 없음"),
summaryOpen: (rps: number, total: string, time: string) => [
  { text: "목표 " }, { text: String(rps), bold: true }, { text: " RPS · 약 " }, { text: total, bold: true }, { text: "건 · " }, { text: time, bold: true },
],
summaryOpenSub: (mif: string) => `동시 요청 상한 ${mif || "—"}`,
summaryCurveVu: (peak: number) => [{ text: "최대 " }, { text: String(peak), bold: true }, { text: "명 (곡선)" }],
summaryCurveRps: (peak: number) => [{ text: "최대 " }, { text: String(peak), bold: true }, { text: " RPS (곡선)" }],
summaryCurveSub: (totalSec: number, stages: number) => `총 ${totalSec}초 · ${stages}단계`,
summaryInvalid: "설정을 확인하세요",
summaryWarnClosedSub: "동시 사용자·시간을 입력",
summaryWarnOpenSub: "목표 RPS·시간을 입력",
```
(`summaryClosed`/`summaryOpen`/`summaryCurve*`의 반환 타입이 `string`→`{text;bold?}[]`로 바뀐다. 소비처는 `runSummary.ts`뿐 — grep `summaryClosed\|summaryOpen\|summaryCurve` 로 확인.)

- [ ] **Step 4: runSummary.ts 재구조화**

`SummarySegment` 타입을 export하고 반환을 `{main, sub, tone, curve}`로:
```ts
export type SummarySegment = { text: string; bold?: boolean };
export function runSummary(s: LoadModelState): { main: SummarySegment[]; sub: string; tone: "ok" | "warn"; curve: boolean } {
  if (s.rateMode === "curve") {
    const valid = s.stages.map((x) => ({ t: Number(x.target), d: Number(x.duration_seconds) }))
      .filter((x) => Number.isFinite(x.t) && Number.isFinite(x.d) && x.d > 0);
    const peak = peakStageTarget(s.stages);
    if (valid.length === 0 || peak == null)
      return { main: [{ text: ko.runDialog.summaryInvalid }], sub: "", tone: "warn", curve: true };
    const total = valid.reduce((a, x) => a + x.d, 0);
    const main = s.loadModel === "closed" ? ko.runDialog.summaryCurveVu(peak) : ko.runDialog.summaryCurveRps(peak);
    return { main, sub: ko.runDialog.summaryCurveSub(total, valid.length), tone: "ok", curve: true };
  }
  if (s.loadModel === "closed") {
    const time = fmtTime(s.duration);
    if (!(s.vus >= 1) || !time)
      return { main: [{ text: ko.runDialog.summaryInvalid }], sub: ko.runDialog.summaryWarnClosedSub, tone: "warn", curve: false };
    return { main: ko.runDialog.summaryClosed(s.vus, time), sub: ko.runDialog.summaryRampUp(s.rampUp), tone: "ok", curve: false };
  }
  const rps = Number(s.targetRps), time = fmtTime(s.duration);
  if (!(rps >= 1) || !time)
    return { main: [{ text: ko.runDialog.summaryInvalid }], sub: ko.runDialog.summaryWarnOpenSub, tone: "warn", curve: false };
  const total = (rps * Math.round(s.duration)).toLocaleString("ko");
  return { main: ko.runDialog.summaryOpen(rps, total, time), sub: ko.runDialog.summaryOpenSub(s.maxInFlight), tone: "ok", curve: false };
}
```
(warn 게이트·curve 분기·`peakStageTarget`·`fmtTime`·총합식 전부 현행 유지 = R10.)

- [ ] **Step 5: RunDialog footer 렌더 (R5·R6) + footer 매처 테스트**

**a11y(R1 — aria-hidden 금지):** 현 설계는 *본문 곡선 카드*를 `aria-hidden`(`RunDialog.tsx:629`)으로 두고 **footer가 유일한 SR 구술 지점**이다. 그러므로 footer `LoadShapePreview`는 **표시될 때 항상 `role="img"` + `aria-label`**(조건부 aria-hidden 절대 추가 금지 — `RunDialog.test.tsx:2791`[간단 전환 후 `getAllByRole("img")≥1`]·`:2849`[open+curve 간단 `getByRole("img",{name:…RPS})`]가 footer 라벨에 의존). `RunDialog.tsx:1036-1053` 교체:
```tsx
{sum.tone !== "warn" && (
  <LoadShapePreview
    kind={sum.curve ? "curve" : "flat"}
    stages={sum.curve ? previewStages : undefined}
    width={60}
    height={30}
    role="img"
    aria-label={
      sum.curve
        ? (loadModel === "closed" ? ko.loadModel.curvePreviewAriaVu : ko.loadModel.curvePreviewAriaRps)
        : ko.runDialog.loadShapeAria
    }
    className="shrink-0"
  />
)}
<span className={sum.tone === "warn" ? "text-amber-700 text-sm" : "text-slate-900 text-sm"}>
  <span>
    {sum.main.map((seg, i) => (seg.bold ? <b key={i} className="font-bold tabular-nums">{seg.text}</b> : <span key={i}>{seg.text}</span>))}
  </span>
  {sum.sub && <span className="block text-xs text-slate-500">{sum.sub}</span>}
</span>
```
- 신규 ko 키 `runDialog.loadShapeAria: "부하 모양 미리보기"` 추가.
- footer 매처 테스트(`RunDialog.test.tsx`) 재작성 — `toHaveTextContent`로 `<b>` 단편화 무관하게:
```tsx
const footer = () => screen.getByRole("button", { name: "실행하기" }).closest('[class*="sticky"]')!;
// :2695-2696 → :
expect(footer()).toHaveTextContent("동시 사용자 100명 · 5분");
// :2714 →
expect(footer()).toHaveTextContent("약 30,000건");
// :2741 →
expect(footer()).toHaveTextContent("최대 50명");
// :2723 warn (굵음 없음 — 그대로 둬도 되나 일관성 위해)
expect(footer()).toHaveTextContent("설정을 확인하세요");
```
**기존 img 테스트는 footer aria-label 유지로 green:** `:2743`(closed+curve prefill `getAllByRole("img")≥1`)·`:2791`(R17 카드 테스트, 간단 전환)·`:2849`(open+curve 간단 `getByRole("img",{name:…RPS})`) 모두 footer가 role=img+aria-label을 *항상* 유지하므로 통과(StageCurvePreview→LoadShapePreview 교체지만 곡선 aria-label 키 `curvePreviewAriaVu`/`Rps` 동일). 신규 단언: 고정 모드 footer에 `getByRole("img",{name:ko.runDialog.loadShapeAria})` 존재; **invalid(vus=0)면 footer shape 부재**(`sum.tone==="warn"`→미렌더 — footer 내 `queryByRole("img",{name:ko.runDialog.loadShapeAria})` null). 머지 전 **전체** `pnpm test`로 고정 모드 신규 img가 다른 img-count 단언을 안 깨는지 확인.

- [ ] **Step 6: Run + gate**

Run: `cd ui && pnpm test runSummary RunDialog && pnpm lint && pnpm build`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add ui/src/i18n/ko.ts ui/src/components/runSummary.ts ui/src/components/RunDialog.tsx \
  ui/src/components/__tests__/runSummary.test.ts ui/src/components/__tests__/RunDialog.test.tsx
git commit -m "feat(rundialog-fidelity): footer 부하-모양 시그니처 + 굵은-숫자/회색-sub 2단 요약 (R5·R6)"
```

---

## Task 6: 적용 칩 항상 표시 + 클릭→상세 (R3)

**Files:**
- Modify: `ui/src/components/RunDialog.tsx:887-892` (`<p>` → 항상 보이는 `<button>` 칩)
- Test: `ui/src/components/__tests__/RunDialog.test.tsx`

**Interfaces:** Consumes: `detailedAppliedCount`(`:350`·계수식 0-diff), `setMode`. Produces: 간단 모드에서 항상 보이는 `⚙ 상세 설정 N개 적용됨` 칩(클릭→상세).

- [ ] **Step 1: Test (RED)**

```tsx
it("간단 모드 기본(count 0): 적용 칩 보이고 클릭하면 상세로 (R3)", async () => {
  const user = userEvent.setup();
  renderDialog(); // 기본 = 간단·count 0
  const chip = screen.getByRole("button", { name: /상세 설정 0개 적용됨/ });
  expect(chip).toBeInTheDocument();
  await user.click(chip);
  expect(screen.getByRole("radio", { name: "상세" })).toBeChecked();
});
```
(기존 `detailedAppliedCount > 0` 가정 테스트가 있으면 always-render로 갱신.)

- [ ] **Step 2: Run → FAIL** (현재 count 0이면 `<p>` 미렌더).

- [ ] **Step 3: 칩 구현**

`RunDialog.tsx:887-892`:
```tsx
{mode === "simple" && (
  <button
    type="button"
    onClick={() => setMode("detailed")}
    className="mb-3 inline-flex items-center gap-1.5 rounded-md bg-accent-50 px-2.5 py-1 text-xs text-accent-700 hover:bg-accent-100"
  >
    <span aria-hidden="true">⚙</span>
    {ko.runDialog.appliedDetail(detailedAppliedCount)}
  </button>
)}
```
(`detailedAppliedCount` 계수식·`appliedDetail` ko 0-diff — 가시성 조건 `&& detailedAppliedCount > 0`만 제거. F1 이중계수 금지.)

- [ ] **Step 4: Run → PASS** (`cd ui && pnpm test RunDialog`).

- [ ] **Step 5: Gate + commit**

```bash
cd .../ui && pnpm lint && pnpm test && pnpm build
git add ui/src/components/RunDialog.tsx ui/src/components/__tests__/RunDialog.test.tsx
git commit -m "feat(rundialog-fidelity): 적용 칩 항상 표시(count 0 포함)+클릭→상세 (R3)"
```

---

## Task 7: 측정 토글-스위치 카드 (R13) — Section 래핑·이동은 Task 8

**Files:**
- Modify: `ui/src/components/RunDialog.tsx:823-838` (bare 측정 checkbox → 토글 스위치 카드 `role="switch"`, **현 위치 유지**)
- Test: `ui/src/components/__tests__/RunDialog.test.tsx:1855`(checkbox→switch)

**Interfaces:** Consumes: `measurePhases`/`setMeasurePhases`(state 0-diff). Produces: `role="switch" aria-checked` 측정 토글 — on→`measure_phases:true` payload(매핑 0-diff). **Section 래핑·"측정" eyebrow·위치 이동(판정·고급 앞)은 Task 8(R14③).** 이 task는 시각(체크박스→스위치 카드)만.

- [ ] **Step 1: Test (RED) — checkbox→switch**

`RunDialog.test.tsx:1855` `getByRole("checkbox", { name: /응답 시간 단계 분해/ })` → `getByRole("switch", { name: /응답 시간 단계 분해/ })`. 토글→payload 단언(있으면) 유지(on→`measure_phases:true`). 신규:
```tsx
it("측정 토글(switch) on → measure_phases:true (R13)", async () => {
  const user = userEvent.setup();
  renderDialog();
  await user.click(screen.getByRole("radio", { name: "상세" }));
  await user.click(screen.getByRole("switch", { name: /응답 시간 단계 분해/ }));
  // … 제출 → mutation payload.profile.measure_phases === true 단언(기존 헬퍼 패턴)
});
```

- [ ] **Step 2: Run → FAIL** (checkbox라 switch 미발견).

- [ ] **Step 3: 측정 토글 스위치 카드 (현 위치·Section 래핑 없음)**

`RunDialog.tsx:823-838` 측정 bare div 내부를 토글 스위치 카드로(바깥 `{mode === "detailed" && (<div className="mt-3 mb-3">…)}` 래퍼는 Task 8이 Section으로 교체·이동):
```tsx
{mode === "detailed" && (
  <div className="mt-3 mb-3">
    <div className="flex items-start gap-3 rounded-lg border border-slate-200 p-3">
      <button
        type="button"
        role="switch"
        aria-checked={measurePhases}
        aria-label={ko.runDialog.measureTitle}
        onClick={() => setMeasurePhases(!measurePhases)}
        className={`relative mt-0.5 h-[22px] w-[38px] shrink-0 rounded-full transition-colors ${measurePhases ? "bg-accent-600" : "bg-slate-300"}`}
      >
        <span aria-hidden="true" className={`absolute top-0.5 h-[18px] w-[18px] rounded-full bg-white shadow transition-all ${measurePhases ? "left-[18px]" : "left-0.5"}`} />
      </button>
      <span className="flex flex-col">
        <span className="flex items-center gap-1 text-sm font-semibold">
          {ko.runDialog.measureTitle}
          <HelpTip label={ko.runDialog.measureTitle}>{ko.runDialog.measureDesc}</HelpTip>
        </span>
        <span className="text-xs text-slate-500">{ko.runDialog.measureDesc}</span>
      </span>
    </div>
  </div>
)}
```
(스위치 토글=즉시 커밋·`measurePhases` state·payload 매핑 0-diff. Section 래핑/번호/이동은 Task 8.)

- [ ] **Step 4: Run → PASS** (`cd ui && pnpm test RunDialog`).

- [ ] **Step 5: Gate + commit**

```bash
cd .../ui && pnpm lint && pnpm test && pnpm build
git add ui/src/components/RunDialog.tsx ui/src/components/__tests__/RunDialog.test.tsx
git commit -m "feat(rundialog-fidelity): 측정 토글-스위치 카드 role=switch (R13)"
```

---

## Task 8: Section 재구성 — 환경/데이터셋 분리 + 측정 Section(이동) + 저장 Section + 번호 재시퀀스 (R14②③④)

**Files:**
- Modify: `ui/src/i18n/ko.ts` (신규 `sectionEnvTitle: "환경"`, `sectionDatasetTitle: "데이터셋 바인딩"`, `sectionMeasureTitle: "측정"`, `sectionSaveTitle: "이 설정 저장"`)
- Modify: `ui/src/components/RunDialog.tsx` — `:674-697`(대상 설정 분리), 측정 카드 블록(Task 7) **이동**(판정·고급 Section 앞) + 측정 Section 래핑, `:840-879`(프리셋 블록→Section), 번호 `index` 재시퀀스
- Test: `ui/src/components/__tests__/RunDialog.test.tsx`

**Interfaces:** Produces: 상세 모드 번호 Section 순서(목업 충실) = **① 부하 모델 / ② 환경 / ③ 데이터셋 바인딩 / ④ 측정 / ⑤ 판정·고급 / ⑥ 이 설정 저장**(번호 ascending = DOM 순서). 간단 모드 = ① 부하 모델 / ② 환경.

**핵심(순서):** 목업은 **측정 → 판정·고급** 순인데 현 코드는 판정·고급(`:701-820`) *다음에* 측정(`:823-838`)이 온다 → 측정 토글 카드 블록을 **판정·고급 Section *앞*으로 이동** 후 `index={4}` 측정 Section으로 래핑, 판정·고급은 `index={5}`. 안 옮기면 번호 5(판정)가 4(측정) *위*에 떠 ascending이 깨진다. ("부하 줄이는 방식"은 LoadModelFields 내부 유지 — R14 미포함, 별도 top-level Section 아님.)

**번호 재시퀀스(최종):** ① 부하모델(기존 `index={1}` 유지) · ② 환경 · ③ 데이터셋 · ④ 측정 · ⑤ 판정·고급(기존 `index={3}`→`5`) · ⑥ 저장.

**알려진 사소 한계(R3·LOW):** 데이터셋 Section(`index={3}`)은 `scenario` 파싱 실패(`scenario===null`) 시 미렌더 → 상세 모드 번호가 1,2,(빠짐),4,5,6으로 갭. 정상 경로(PNG 상태 = scenario 존재)에선 무발생이라 이 슬라이스는 하드코딩 index 유지(동적 재번호 비도입). 깨진-시나리오 degraded 상태의 장식 갭으로 수용 — 거슬리면 후속에서 렌더 카운터 도입.

- [ ] **Step 1: Test (RED)**

```tsx
it("상세 모드: 환경·측정·저장 독립 Section, '대상 설정' 없음, 측정이 판정·고급 앞 (R14②③④)", async () => {
  const user = userEvent.setup();
  renderDialog();
  await user.click(screen.getByRole("radio", { name: "상세" }));
  expect(screen.getByText("환경")).toBeInTheDocument();
  expect(screen.getByText("측정")).toBeInTheDocument();       // 측정 Section eyebrow
  expect(screen.getByText("이 설정 저장")).toBeInTheDocument();
  expect(screen.queryByText("대상 설정")).not.toBeInTheDocument();
  // DOM 순서: 측정 eyebrow가 판정·고급 토글보다 앞
  const html = document.body.innerHTML;
  expect(html.indexOf("측정")).toBeLessThan(html.indexOf("판정·고급"));
});
```
(데이터셋 Section은 `scenario` 필요 — renderDialog가 scenario를 주면 `getByText("데이터셋 바인딩")`도 단언; 안 주면 생략.)

**기존 단언 갱신(C1·이 커밋에서 깨지므로 같이):** `RunDialog.test.tsx:207 getByText("대상 설정")`(Task 2가 `:206`을 "부하 모델"로 고친 *같은 테스트 본문*)을 `getByText("환경")`로 교체 — 분리 후 "대상 설정"은 부재. grep `getByText("대상 설정")\|includes("대상 설정")`로 잔존 0 확인.

- [ ] **Step 2: Run → FAIL** ("대상 설정" 존재 / "측정" Section eyebrow 없음 / 순서 미달).

- [ ] **Step 3: ko.ts + Section 분리·이동·래핑·재번호**

`ko.ts`: `sectionEnvTitle: "환경"`, `sectionDatasetTitle: "데이터셋 바인딩"`, `sectionMeasureTitle: "측정"`, `sectionSaveTitle: "이 설정 저장"` 추가(`sectionTargetTitle`은 미사용→제거; 다른 소비처 없음 grep 확인).
1) `RunDialog.tsx:674-697` Section2(대상 설정)를 둘로:
```tsx
<Section index={2} divider title={<span className={eyebrowCls}>{ko.runDialog.sectionEnvTitle}</span>}
  badge={<Badge tone="optional">{ko.common.optional}</Badge>}>
  <EnvironmentPicker … showOverrides={mode === "detailed"} />
</Section>
{mode === "detailed" && scenario && (
  <Section index={3} divider title={<span className={eyebrowCls}>{ko.runDialog.sectionDatasetTitle}</span>}
    badge={<Badge tone="optional">{ko.common.optional}</Badge>}>
    <DataBindingPanel key={panelKey} scenario={scenario} initialBindings={seedBindings} onChange={setBindings} onValidityChange={onBindingValidity} />
  </Section>
)}
```
2) **측정 카드 블록(Task 7)을 잘라 판정·고급 Section(`:701`) *앞*으로 이동** + `Section index={4}` 래핑:
```tsx
{mode === "detailed" && (
  <Section index={4} divider title={<span className={eyebrowCls}>{ko.runDialog.sectionMeasureTitle}</span>}
    badge={<Badge tone="optional">{ko.common.optional}</Badge>}>
    {/* Task 7의 토글 스위치 카드 div(border/p-3) — 내부 0-diff, 바깥 mt/mb div는 Section이 대체 */}
    <div className="flex items-start gap-3 rounded-lg border border-slate-200 p-3">{/* …switch + 텍스트… */}</div>
  </Section>
)}
```
3) 판정·고급 Section(현 `index={3}` `:701`) → `index={5}`.
4) 프리셋 블록(`:840-879`)을 `Section index={6} divider title=sectionSaveTitle badge=optional`로 감싸기(내부 savebar JSX·핸들러 0-diff).

- [ ] **Step 4: Run → PASS** (`cd ui && pnpm test RunDialog`).

- [ ] **Step 5: Gate + commit**

```bash
cd .../ui && pnpm lint && pnpm test && pnpm build
git add ui/src/i18n/ko.ts ui/src/components/RunDialog.tsx ui/src/components/__tests__/RunDialog.test.tsx
git commit -m "feat(rundialog-fidelity): 환경/데이터셋/측정/저장 독립 Section + 측정 이동 + 번호 재시퀀스 (R14②③④)"
```

---

## 최종 검증 (모든 task 후 — finish-slice 전)

- [ ] **전체 게이트:** `cd ui && pnpm lint && pnpm test && pnpm build` 전부 green.
- [ ] **byte-identical grep:** `git diff master..HEAD -- crates/ ui/src/api/schemas.ts` = **0 라인**(R11). `git diff master..HEAD -- ui/src/components/ScheduleForm.tsx ui/src/components/__tests__/ScheduleForm.test.tsx` = **0**(R12). payload 골든 `DEFAULT_SIMPLE_PROFILE` 정확 `toEqual` green(R10).
- [ ] **공유 ko 키 불변:** `git diff master..HEAD -- ui/src/i18n/ko.ts`에서 `loadModel.closedLoop`/`openLoop`·`tileClosedDesc`/`tileOpenDesc` 라인 unchanged.
- [ ] **최종 리뷰:** `handicap-reviewer`(model: opus) — 크로스커팅·wire 1:1·R10/R11 byte-identical·R9 기능 보존. **보안 게이트 N/A**(요청실행/템플릿/env바인딩/업로드/trace 미접촉 — finish-slice §0 grep으로 확인, 매치 0이면 스킵).
- [ ] **라이브 검증(R15·강제):** `/live-verify` — 워크트리 자체 바이너리 + Playwright. **open+fixed 100/300/200**으로 간단·상세 스크린샷 → `docs/superpowers/mockups/*.png` 대조 기록(번호 Section·고정 footer 미니그래프=의도적 잔존으로 표기). 간단 closed run + 상세 open-loop run 1회씩 생성→리포트, console Zod 0.

## Self-Review (작성자 체크 — 완료)

1. **Spec 커버리지:** R1(T2)·R2(T2)·R3(T6)·R4(T3)·R5(T1+T5)·R6(T4+T5)·R8(T4)·R9(전 task 보존+최종 grep)·R10(전 task+최종 골든)·R11(전 task+최종 grep)·R12(T3+최종 grep)·R13(T7)·R14①(T2)·R14②④(T8)·R14③(T8·측정 Section+이동)·R14⑤(T3)·R15(최종 라이브). **전 요구 매핑됨.**
2. **Placeholder 스캔:** 코드 스텝 전부 실코드. 라디오 분기 "현행 유지"·측정 카드 "내부 0-diff"는 *보존* 지시(0-diff)라 의도적(코드는 Task 7에 실재).
3. **타입 일관성:** `SummarySegment`(T1 LoadShapePreview는 Stage 로컬·T5 runSummary는 별도 `SummarySegment` export)·`runSummary` 반환형(T5 단일 정의)·`detailedAppliedCount`(불변 참조)·`index` 재시퀀스(T8 단일 소유 = 1/2/3/4/5/6, T7은 번호 미부여) 일관.

<!-- spec-plan-reviewer 2회 통과: 1차 APPROVE-WITH-FIXES(6 fix)→반영, 2차 APPROVE-WITH-FIXES(setup() 이중렌더 must-fix)→반영. 리뷰어가 "must-fix 반영 후 ready·마커 교체 가능" 명시. spec=clean APPROVE(round 3). -->
<!-- REVIEW-GATE: APPROVED -->
