# 변수 패널 추출 변수 이름 가시성 (적응형 줄바꿈) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

<!-- REVIEW-GATE: PENDING — spec-plan-reviewer가 spec과 이 plan에 clean APPROVE를 내면, 이 줄을 정확히 `REVIEW-GATE: APPROVED`(또는 `<!-- REVIEW-GATE: APPROVED -->`)로 바꾼다. -->

**Goal:** 변수 패널의 단일 줄 행 3종(flat-extract·parallel-extract·undefined)에서 210px 열일 때 변수 이름이 27px로 눌려 안 보이는 문제를 `flex-wrap` + 이름 `min-w-[72px]`로 수리한다 — 좁은 열에선 사용처 버튼이 둘째 줄로, 넓은 varsWide 열에선 단일 줄 유지.

**Architecture:** `VariablesPanel.tsx` 단일 파일의 순수 className 변경(li 3곳 wrap 허용 + 이름 span 4곳/rename 래퍼 2곳 최소폭). 모델/스토어/Zod/ko.ts/wire 0-diff. jsdom은 레이아웃이 없으므로 RTL은 클래스-토큰 계약만 락인하고, 실제 줄바꿈은 머지 전 라이브 Playwright rect 실측이 권위.

**Tech Stack:** React + Tailwind(`ui/src/components/scenario/VariablesPanel.tsx`), vitest/RTL(`__tests__/VariablesPanel.test.tsx`), 라이브 검증 vite dev + Playwright MCP.

**Spec:** `docs/superpowers/specs/2026-07-07-extract-var-name-visibility-design.md`

## Global Constraints

- UI-only 슬라이스: `crates/`·proto·migration·`ko.ts`·`model.ts`·`store.ts` 0-diff (spec R5/§5).
- UI 커밋 전 게이트: `pnpm lint && pnpm test && pnpm build` 전부 green (`pnpm lint`는 `--max-warnings=0`).
- 클래스 단언은 정확-토큰 방식(`className.split(/\s+/)` + `toContain`) — raw substring `toContain` 금지(ui/CLAUDE.md `max-h-`⊃`h-` 함정).
- tdd-guard: src 편집 전에 test 파일 편집이 먼저(pending test 필요) — Task 1은 Step 1(테스트)부터 순서 고정.
- full `pnpm test`의 알려진 suite-wide 격리 flake(ui/CLAUDE.md): 실패 파일을 격리 실행해 green이면 flake 확정, 재시도.

---

## Requirement Coverage (R-id → Task)

| R-id | 요구사항 (요약) | 담당 Task | seam? |
|---|---|---|---|
| R1 | 행 li 3종 `flex-wrap` + `gap-x-2 gap-y-1` | Task 1 | |
| R2 | 이름 span 4곳 + rename 래퍼 2곳 `min-w-[72px]`(`<Input>` 자신 `min-w-0` 유지) | Task 1 | |
| R3 | 210px 열에서 이름 실폭 ≥72px + 사용처 버튼 둘째 줄 | Task 2 (라이브, orchestrator 직접) | |
| R4 | varsWide(`1fr`)에서 단일 줄 유지 | Task 2 (라이브) | |
| R5 | 선언 행 구조/문구/팝오버/wire 무변경(공유 nameCell 클래스 변경만 허용) | Task 1 (기존 테스트 green + diff 범위) | |
| R6 | 줄바꿈 시 이름+✎+배지가 첫 줄 우선 | Task 2 (라이브) | |

---

## File Structure

| 파일 | 책임 | 변경 |
|---|---|---|
| `ui/src/components/scenario/__tests__/VariablesPanel.test.tsx` | 클래스-토큰 계약 락인 | describe 블록 1개 추가(테스트 3개) |
| `ui/src/components/scenario/VariablesPanel.tsx` | 행 레이아웃 | className만 9곳 수정(li 3 + span 4 + 래퍼 2) |

**무변경(명시)**: 위 2개 파일 외 전부. 특히 `VariablesPanel.tsx` 안에서도 declared 행 내부 div(`:222`), declared non-renamable 이름 span(`:227`), 하단 add-row 래퍼(`:357`)는 같은 클래스 문자열이지만 **건드리지 않는다**(spec §4.1/§5).
**TDD 가드 메모**: Step 1이 test-path 파일 편집이라 항상 허용 → pending test가 생겨 Step 3의 src 편집이 unblock된다.
**커밋 경계 메모**: UI-only라 cargo 게이트 skip. 테스트+구현을 하나의 green 커밋으로 fold(단일 커밋).

---

## Task 1: 클래스 계약 테스트 + VariablesPanel className 변경

**충족 R:** R1, R2, R5
**Files:**
- Modify: `ui/src/components/scenario/__tests__/VariablesPanel.test.tsx` — 파일 끝에 describe 블록 추가
- Modify: `ui/src/components/scenario/VariablesPanel.tsx` — className 9곳

**Interfaces:**
- Consumes: 기존 `MIXED` fixture(테스트 파일 `:242`, declared `token`·flat-extract `flatVar`·parallel non-shadow `alpha.s`·undefined `missing` 4행 전부 포함), `reset()` 헬퍼(`:8`), `ko.editor.*` aria 키.
- Produces: 없음(후속 task가 소비하는 심볼 없음 — Task 2는 라이브 관찰만).

- [ ] **Step 1: 실패하는 클래스 계약 테스트 작성** — `VariablesPanel.test.tsx` 파일 끝에 append:

```tsx
describe("VariablesPanel — 추출/미정의 행 적응형 줄바꿈 (extract-var-name-visibility)", () => {
  beforeEach(() => useScenarioEditor.setState(useScenarioEditor.getInitialState()));

  const tokens = (el: Element) => (el.getAttribute("class") ?? "").split(/\s+/);

  // 선언 s를 alpha 분기가 다시 추출 → declared non-renamable + parallel shadow 행
  const SHADOW = `version: 1
name: t
cookie_jar: auto
variables:
  s: seed
steps:
  - id: 01HX0000000000000000000060
    name: par
    type: parallel
    branches:
      - name: alpha
        steps:
          - id: 01HX0000000000000000000061
            name: leaf
            type: http
            request: { method: GET, url: "/y", headers: {} }
            extract:
              - from: body
                path: $.t
                var: s
`;

  it("R1: flat-extract·parallel-extract·undefined 행 li는 flex-wrap + gap-x-2/gap-y-1 (gap-2 부재)", () => {
    useScenarioEditor.getState().loadFromString(MIXED);
    render(<VariablesPanel />);
    const lis = [
      screen.getByTitle("flatVar").closest("li")!,
      screen.getByTitle("alpha.s").closest("li")!,
      screen.getByTitle(ko.editor.variableUndefinedAria("missing")).closest("li")!,
    ];
    for (const li of lis) {
      const t = tokens(li);
      expect(t).toContain("flex-wrap");
      expect(t).toContain("gap-x-2");
      expect(t).toContain("gap-y-1");
      expect(t).not.toContain("gap-2");
    }
  });

  it("R2: 이름 span은 min-w-[72px] (min-w-0 부재), rename 래퍼도 동일하되 <Input> 자신은 min-w-0 유지", () => {
    useScenarioEditor.getState().loadFromString(MIXED);
    render(<VariablesPanel />);
    // 이름 span 3/4곳: nameCell(flat-extract) · parallel non-shadow · undefined
    for (const title of ["flatVar", "alpha.s", ko.editor.variableUndefinedAria("missing")]) {
      const t = tokens(screen.getByTitle(title));
      expect(t).toContain("min-w-[72px]");
      expect(t).not.toContain("min-w-0");
    }
    // flat rename 래퍼: ✎ 클릭 → input.parentElement 가 래퍼 div (Input.tsx는 bare <input>)
    fireEvent.click(screen.getByRole("button", { name: ko.editor.renameVariableAria("flatVar") }));
    const input = screen.getByRole("textbox", {
      name: ko.editor.variableRenameInputAria("flatVar"),
    });
    const wrapper = input.parentElement!;
    expect(tokens(wrapper)).toContain("min-w-[72px]");
    expect(tokens(wrapper)).not.toContain("min-w-0");
    expect(tokens(input)).toContain("min-w-0"); // <Input> 자신은 유지 — w-full이 줄어든 래퍼를 채우는 데 필요(spec R2 단서)
  });

  it("R2/R5: parallel rename 래퍼·shadow 이름 span은 min-w-[72px], declared non-renamable span은 min-w-0 유지", () => {
    // (a) non-shadow parallel rename 래퍼 — MIXED
    useScenarioEditor.getState().loadFromString(MIXED);
    const { unmount } = render(<VariablesPanel />);
    fireEvent.click(screen.getByRole("button", { name: ko.editor.renameVariableAria("alpha.s") }));
    const pInput = screen.getByRole("textbox", {
      name: ko.editor.variableRenameInputAria("alpha.s"),
    });
    expect(tokens(pInput.parentElement!)).toContain("min-w-[72px]");
    expect(tokens(pInput.parentElement!)).not.toContain("min-w-0");
    unmount();
    // (b) shadow span + declared non-renamable span — SHADOW
    useScenarioEditor.getState().loadFromString(SHADOW);
    render(<VariablesPanel />);
    const shadow = screen.getByTitle("alpha.s"); // shadow 행 이름 span (title=display)
    expect(tokens(shadow)).toContain("min-w-[72px]");
    expect(tokens(shadow)).not.toContain("min-w-0");
    const declared = screen.getByTitle("s"); // declared non-renamable span — 의도적으로 무변경(spec §4.1)
    expect(tokens(declared)).toContain("min-w-0");
    expect(tokens(declared)).not.toContain("min-w-[72px]");
  });
});
```

- [ ] **Step 2: RED 확인**

Run: `cd ui && pnpm test VariablesPanel > /tmp/extract-var-name-visibility-test.log 2>&1; tail -30 /tmp/extract-var-name-visibility-test.log`
Expected: 새 테스트 3개 FAIL(`flex-wrap`/`min-w-[72px]` 토큰 부재), 기존 테스트는 green. (`pnpm test -- VariablesPanel`처럼 `--`를 넣으면 전체 스위트가 도니 금지 — ui/CLAUDE.md.)

- [ ] **Step 3: `VariablesPanel.tsx` className 9곳 변경** — 아래 9곳만, 같은 문자열의 다른 3곳(`:222` declared 내부 div, `:227` declared non-renamable span, `:357` add-row 래퍼)은 **무변경**:

(1) flat-extract li(`:254`) / (2) parallel li(`:269`) / (3) undefined li(`:333`) — 각각:
```tsx
// before
<li key={`f:${row.name}`} className="flex items-center gap-2">
<li key={`p:${row.display}`} className="flex items-center gap-2">
<li key={`u:${row.name}`} className="flex items-center gap-2">
// after
<li key={`f:${row.name}`} className="flex flex-wrap items-center gap-x-2 gap-y-1">
<li key={`p:${row.display}`} className="flex flex-wrap items-center gap-x-2 gap-y-1">
<li key={`u:${row.name}`} className="flex flex-wrap items-center gap-x-2 gap-y-1">
```

(4) nameCell 비편집 span(`:175`, `nameCell` 함수 안 — `title={name}`) / (5) parallel shadow span(`:273`, `row.isShadow ?` 분기) / (6) parallel non-shadow span(`:301`, isEditing else 분기) / (7) undefined span(`:335`) — 각각 클래스 문자열에서 `min-w-0` → `min-w-[72px]`:
```tsx
// before (4곳 공통)
className="min-w-0 flex-1 truncate font-mono text-xs text-slate-600"
// after
className="min-w-[72px] flex-1 truncate font-mono text-xs text-slate-600"
```

(8) nameCell 편집 래퍼(`:154`, `nameCell` 함수 안 editing 분기) / (9) parallel 편집 래퍼(`:279`, parallel isEditing 분기):
```tsx
// before (2곳 공통)
<div className="flex-1 min-w-0">
// after
<div className="flex-1 min-w-[72px]">
```

- [ ] **Step 4: GREEN 확인**

Run: `cd ui && pnpm test VariablesPanel > /tmp/extract-var-name-visibility-test.log 2>&1; tail -15 /tmp/extract-var-name-visibility-test.log`
Expected: 파일 전체 PASS(새 3개 + 기존 전부 — 기존 green이 R5의 절반).

- [ ] **Step 5: 전체 게이트**

Run: `cd ui && pnpm lint && pnpm test && pnpm build` (각각 `> /tmp/extract-var-name-visibility-<gate>.log` 리다이렉트 후 exit code 확인 — 워크트리-스코프 로그명, 고정 `/tmp/x.log` 재사용 금지)
Expected: 전부 exit 0. full test에서 무관 파일 1개가 간헐 red면 격리 실행(`pnpm test <file>`)으로 flake 판정 후 재시도(ui/CLAUDE.md suite-wide flake).
추가 확인(R5): `git diff --stat` 이 위 2개 파일만 나열.

- [ ] **Step 6: 커밋** — 명시 경로만 add, 파이프 없는 단일 foreground 호출(`run_in_background:false`, timeout 600000ms, 폴링 금지):

```bash
git add ui/src/components/scenario/VariablesPanel.tsx ui/src/components/scenario/__tests__/VariablesPanel.test.tsx
git commit -m "fix(ui): 변수 패널 추출/미정의 행 적응형 줄바꿈 — 좁은 열에서 이름 가시성 확보 (R1/R2)"
```
직후 `git log -1`로 landed 확인.

---

## Task 2: 라이브 Playwright rect 실측 (R3/R4/R6) — orchestrator 직접 수행

**충족 R:** R3, R4, R6
**Files:** 없음(관찰 전용). 산출물: after 스크린샷(대조용 before=`vars-panel-before.png`, 2026-07-06 실측 name.width=27px).

- [ ] **Step 1: 스택** — 워크트리 `ui/`에서 `pnpm dev`(background). vite는 IPv6 `[::1]` 바인드 → Playwright는 `localhost`로 navigate(ui/CLAUDE.md). 백엔드 불필요(`/scenarios/new`는 클라이언트-only).

- [ ] **Step 2: 측정(기본 210px 열)** — 뷰포트 **1280×800** 고정 → `http://localhost:5173/scenarios/new` → "로그인 흐름" 템플릿 클릭(extract `token` + 사용 1곳) → 단일 evaluate로:

```js
const section = document.querySelector('section[aria-label="변수"]');
const name = section.querySelector('span[title="token"]');
const badge = [...section.querySelectorAll('span')].find((e) => e.textContent === "추출됨");
const usage = [...section.querySelectorAll('button')].find((b) => b.textContent.includes("스텝에서 사용"));
const n = name.getBoundingClientRect(), b = badge.getBoundingClientRect(), u = usage.getBoundingClientRect();
return { nameW: n.width, nameTop: n.top, badgeTop: b.top, usageTop: u.top };
```

**Acceptance (R3):** `nameW >= 72 && usageTop > nameTop + 1` (사용처 버튼이 둘째 줄).
**Acceptance (R6):** `Math.abs(badgeTop - nameTop) < 1` ("추출됨" 배지는 이름과 같은 첫 줄).

- [ ] **Step 3: 측정(varsWide)** — ◧ 토글(`getByRole("button", { name: "변수 넓게 보기 전환" })` = `ko.editor.varsWideToggleAria`) 클릭 후 같은 evaluate 재실행.

**Acceptance (R4):** `Math.abs(nameTop - usageTop) < 1` (단일 줄 복귀).

- [ ] **Step 4: 스크린샷** — 변수 섹션 after 스크린샷을 찍어 before(27px, `to…`)와 대조·기록. 완료 후 `.playwright-mcp/`·루트 `vars-panel-before.png` 등 잔류물은 머지 전 삭제(tracked 파일 아님 확인 후 `rm`).

---

## 머지 / 마무리

- **라이브 검증 필요 여부**(spec §6): Task 2가 그 자체(rect 실측). run-생성/응답-파싱/엔진 경로 0-diff → `/live-verify` 풀스택·라이브 run 불요.
- **워크트리 ff-merge**(루트 CLAUDE.md): 메인 클린 확인 → `git -C /Users/sgj/develop/handicap merge --ff-only worktree-extract-var-name-visibility` → `/finish-slice`(build-log·상태줄·메모리) → `ExitWorktree(remove, discard_changes:true)`.
- **잔류 정리**: `.playwright-mcp/` + 루트 `vars-panel-before.png` 삭제(Task 2 Step 4).

## Self-Review (작성자 체크)

- **R 커버리지**: R1–R6 전부 담당 task 있음(미매핑 0). seam ✅ 없음(wire 무접촉).
- **인라인 acceptance**: Task 1은 RTL 토큰 단언 코드 자체가 acceptance, Task 2는 R3/R4/R6 부등식 인라인.
- **Placeholder scan**: 모든 코드 블록 실제 코드(의사코드/`...` 없음).
- **Type/idiom consistency**: 기존 `MIXED`/`reset()`/`getByTitle`/`fireEvent` 이디엄 재사용, `tokens()` 정확-토큰 방식.
- **커밋 경계**: 테스트+구현 단일 green 커밋(UI-only, cargo 게이트 skip).
