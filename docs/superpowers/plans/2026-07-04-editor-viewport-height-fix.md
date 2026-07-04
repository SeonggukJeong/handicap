# 에디터 뷰포트 높이 floor + 스크롤바 간격 Implementation Plan

> REQUIRED SUB-SKILL: 소규모 UI-only fix. 단일 task(클래스 계약 test-first → 2 CSS 변경 → green 커밋) + 라이브 검증.

**Goal:** editor-varpanel-viewport-polish #4 후속 폴리시 — 비-wide 에디터 그리드에 `min-h-[520px]` floor(작은 화면 답답 해소·큰 화면 캡 유지) + 변수 리스트 스크롤바 우측 gutter. Spec: `docs/superpowers/specs/2026-07-04-editor-viewport-height-fix-design.md`.

## Global Constraints
- **UI-only·0-diff (R3)**: `crates`/proto/migration/`model.ts`/YAML/store/wire 무접촉. `git diff --name-only` = `ui/**`·`docs/**`만. 기존 #4 클래스(`grid-rows-[minmax(0,1fr)]`·열 `overflow-auto min-h-0`·aside `overflow-visible`·max-h 캡) 전부 보존.
- **TDD test-first (tdd-guard)**: `ui/src/**` non-test 편집 전에 pending test 파일 필요 → 테스트 먼저.
- **커밋 게이트**: pre-commit UI 게이트 `pnpm lint && pnpm test && pnpm build`. 독립 green 커밋. suite-wide 격리 flake(`ScenarioEditPage.dirty` 등) 발생 시 격리 실행으로 판정(ui/CLAUDE.md).
- **#1 correctness는 라이브가 권위**: jsdom은 레이아웃 미관측 → RTL은 클래스 계약까지만, 실제 floor/캡/스크롤바 gap은 라이브 `getBoundingClientRect` 실측([[implementation-rigor-over-spec]]).

---

## Task 1: min-h floor + 스크롤바 gutter (R1·R2·R3·R4)

**Files:**
- Modify: `ui/src/components/scenario/EditorShell.tsx` (비-wide 그리드 className)
- Modify: `ui/src/components/scenario/VariablesPanel.tsx` (스크롤 `<ul>` className)
- Test: `ui/src/components/scenario/__tests__/EditorShell.test.tsx`, `ui/src/components/scenario/__tests__/VariablesPanel.test.tsx`

- [ ] **Step 1: 클래스 계약 실패 테스트 추가** —
  - `EditorShell.test.tsx`의 기존 "bounds the non-wide editor grid..." 테스트(있으면 확장, 없으면 추가)에서 `editor-grid` className이 `min-h-[520px]` **와** `max-h-[calc(100vh-16rem)]` 둘 다 포함하고 `grid-rows-[minmax(0,1fr)]`도 보존됨을 단언.
  - `VariablesPanel.test.tsx`의 기존 "scrolls the variable list..." 테스트(있으면 확장)에서 `getByRole("list")` className이 `pr-1.5`(+기존 `overflow-auto`·`min-h-0`)를 포함함을 단언.
  (정확한 셀렉터/기존 테스트는 파일에서 확인 후 맞춘다.)

- [ ] **Step 2: FAIL 확인** — `cd ui && pnpm test EditorShell VariablesPanel`. Expected: FAIL(min-h-[520px]·pr-1.5 아직 없음).

- [ ] **Step 3: EditorShell 비-wide 그리드에 min-h floor 추가** — 비-wide arm className `` `grid gap-4 max-h-[calc(100vh-16rem)] grid-rows-[minmax(0,1fr)] ${...}` `` → `min-h-[520px]`를 `max-h-...` 앞(또는 뒤)에 추가. wide arm은 무변경. 열 `overflow-auto min-h-0`·aside `overflow-visible` 무변경.

- [ ] **Step 4: VariablesPanel 스크롤 `<ul>`에 gutter 추가** — `<ul className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto">` → `pr-1.5` 추가. 헤더/추가행(shrink-0 siblings)은 무변경(스크롤 밖이라 gutter 불요).

- [ ] **Step 5: GREEN 확인** — `cd ui && pnpm test EditorShell VariablesPanel`. Expected: PASS.

- [ ] **Step 6: 게이트 + 커밋** — `cd ui && pnpm lint && pnpm test && pnpm build`. Expected: PASS.
```bash
git add ui/src/components/scenario/EditorShell.tsx ui/src/components/scenario/VariablesPanel.tsx \
  ui/src/components/scenario/__tests__/EditorShell.test.tsx \
  ui/src/components/scenario/__tests__/VariablesPanel.test.tsx
git commit -m "fix(editor): 뷰포트 그리드 min-h-[520px] floor + 변수 리스트 스크롤바 gutter (#4 후속)"
```

> **⚠ 커밋 후 라이브 검증 필수**(jsdom 미관측): 900px 화면 그리드 ≤ 뷰포트−256(스크롤 없음)·520px 화면 그리드 ≥ 520(페이지 스크롤)·변수 리스트 스크롤 상태서 행 값 입력 우단↔ul 우단 gap > 0.

---

## Task 2: 연기 항목 없음 / 마무리
- 이 fix는 spec §6 비목표(앱 헤더 축소·wide 높이·floor 정밀 튜닝)를 명시 연기 — build-log에 기록. 별도 roadmap 등재 불요(#4의 §B16에 흡수 가능하나 이 fix 자체는 완결).

## Self-Review
- R1→Task1 Step3(min-h floor), R2→Step4(gutter), R3→Global(0-diff grep)+기존 테스트 green, R4→Step3 wide arm 무변경. 전 R 매핑.
- 라이브 검증이 #1 correctness 권위(spec §5).

## Execution Handoff
소규모 UI-only fix. spec-plan-reviewer(Opus) clean APPROVE(2026-07-04, factual claims·CSS `max(min,min(max,content))` 전 quadrant 검증·advisory 4건 spec fold-in). STOP-gate: 커밋→`/clear`→fresh `/start-slice`로 구현 진입.

REVIEW-GATE: APPROVED
