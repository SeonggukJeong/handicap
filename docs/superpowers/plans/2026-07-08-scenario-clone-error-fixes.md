# 시나리오 복제 에러 처리 정리 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

REVIEW-GATE: APPROVED

**Goal:** `cloneAndGo`의 모든 호출 경로가 실패해도 unhandled promise rejection·가려진 에러 없이 명확히 실패를 보여주고, 하드코딩된 "복제 실패: " 문구를 `ko.ts` 카탈로그로 통합한다.
**Architecture:** `ScenarioEditPage.tsx`의 `cloneAndGo` 단일 함수에 try/catch를 추가(성공/실패 양쪽 `setCloneDialog(null)`) — 세 호출부(`onCloneClick` 즉시경로·"저장 없이 복제"·"저장본으로 복제")와 `saveThenClone`("저장 후 복제") 전부를 한 지점에서 커버. 두 파일의 하드코딩 문자열을 `ko.pages.cloneFailed(msg)` 함수 키(신규, `ko.pages.deleteFailed`와 동형)로 교체.
**Tech Stack:** TypeScript/React, `ui/src/pages/ScenarioEditPage.tsx`, `ui/src/pages/ScenarioListPage.tsx`, `ui/src/i18n/ko.ts`, vitest+RTL.
**Spec:** `docs/superpowers/specs/2026-07-08-scenario-clone-error-fixes-design.md`

---

## Requirement Coverage (R-id → Task)

| R-id | 요구사항 (요약) | 담당 Task | seam? |
|---|---|---|---|
| R1 | `cloneAndGo`가 실패해도 rejection을 전파하지 않는다(3개 void-호출 경로 전부) | Task 1 | |
| R2 | 실패 시 Callout 표시 + 열려 있던 모달은 닫힘(backdrop에 안 가림) | Task 1 | |
| R3 | 하드코딩 "복제 실패: " → `ko.pages.cloneFailed(msg)` 이주(양 파일) | Task 1 | |
| R4 | 표시 문구 byte-identical 불변식 | Task 1 | |
| R5 | "저장 후 복제" 흐름에서 clone만 실패하면 save-failed 모달 없이 확인 모달만 닫힘(R1의 파생 부작용) | Task 1 | |

- 단일 task plan — 이 5개 R이 전부 같은 3파일(`ScenarioEditPage.tsx`/`ScenarioListPage.tsx`/`ko.ts`) 안에서 상호의존적으로 닫히므로 인위적으로 쪼개지 않는다(루트 CLAUDE.md "단일-task plan은 per-task 리뷰와 최종 whole-branch 리뷰가 동일 diff" 패턴).
- `seam ✅` 해당 없음 — 계약 경계(Zod↔serde/proto/migration) 무접촉.

---

## File Structure

| 파일 | 책임 | 변경 |
|---|---|---|
| `ui/src/i18n/ko.ts` | 문구 카탈로그(ADR-0035) | `ko.pages.cloneFailed` 함수 키 추가(L394 `deleteFailed` 다음 줄) |
| `ui/src/pages/ScenarioEditPage.tsx` | 시나리오 편집 페이지 — clone 트리거 3곳 + Callout | `cloneAndGo`(L102-107) try/catch화(성공·실패 양쪽 `setCloneDialog(null)`), L239 문구를 `ko.pages.cloneFailed(...)`로 교체 |
| `ui/src/pages/ScenarioListPage.tsx` | 시나리오 목록 페이지 — clone Callout | L60 문구를 `ko.pages.cloneFailed(...)`로 교체(로직 무변경 — `clone.mutate`는 R1 대상 아님) |
| `ui/src/pages/__tests__/ScenarioEditPage.clone.test.tsx` | 회귀 테스트 | R1(신규 케이스)·R2(모달 닫힘 단언)·R5(save-failed 모달 부재 단언) 추가 |

**무변경(명시)**: 성공 경로(navigate)·"복제" 확인 다이얼로그 문구·"저장 실패" 다이얼로그(update 자체 실패 케이스)의 트리거 조건·엔진/컨트롤러/proto/migration/와이어 전부(spec §5).
**TDD 가드 메모**: `tdd-guard`가 watched `ui/src/**`(non-test) 편집 전 pending test-path 파일을 요구한다 — Step 1(테스트 파일 편집)을 가장 먼저 수행해 이후 `ko.ts`/컴포넌트 편집이 막히지 않게 한다.
**커밋 경계 메모**: 전체 diff가 한 논리적 변경(에러 핸들링+문구 이주)이라 단일 green 커밋으로 fold — 테스트(RED)→구현(GREEN)→게이트 확인까지 한 커밋.

---

## Task 1: cloneAndGo unhandled-rejection 제거 + 복제 실패 문구 ko.ts 이주

**충족 R:** `R1, R2, R3, R4, R5`
**Files:**
- Modify: `ui/src/pages/__tests__/ScenarioEditPage.clone.test.tsx` — R1/R2/R5 신규 케이스·단언
- Modify: `ui/src/i18n/ko.ts` — `cloneFailed` 키 추가
- Modify: `ui/src/pages/ScenarioEditPage.tsx` — `cloneAndGo` try/catch, 문구 교체
- Modify: `ui/src/pages/ScenarioListPage.tsx` — 문구 교체

- [ ] **Step 1: 테스트 먼저 (RED) — `ScenarioEditPage.clone.test.tsx`**

  기존 `describe("ScenarioEditPage clone", ...)` 블록 안에 새 `it`을 추가(기존 4개 케이스 다음, "복제 실패 시 오류 Callout" 케이스 앞 또는 뒤 아무 위치):

  ```tsx
  it("not dirty + 복제 실패: unhandled rejection 없이 Callout만 뜬다 (R1)", async () => {
    const user = userEvent.setup();
    cloneShouldFail = true;
    renderPage();
    await screen.findByRole("button", { name: "복제" });
    await user.click(screen.getByRole("button", { name: "seed" })); // not dirty

    await user.click(screen.getByRole("button", { name: "복제" }));

    const alertBox = await screen.findByRole("alert");
    expect(alertBox).toHaveTextContent("복제 실패: clone failed");
  });
  ```

  기존 "복제 실패 시 오류 Callout(alert, 구체 클래스: rounded-md/bg-red-50)" 케이스(현재 L173-190)의 마지막 3줄(L187-189, 기존 `const alertBox = await screen.findByRole("alert");` + 두 `toHaveClass` 단언)을 **아래로 교체**(기존 `alertBox` 선언을 재사용 — 새 `const alertBox` 중복 선언 금지):

  ```tsx
    const alertBox = await screen.findByRole("alert");
    expect(alertBox).toHaveClass("rounded-md");
    expect(alertBox).toHaveClass("bg-red-50");
    // R2: 열려 있던 확인 모달이 닫혔다(backdrop에 Callout이 안 가림)
    expect(screen.queryByRole("dialog")).toBeNull();
    // R5: "저장 실패" 모달이 아니라(clone 실패를 save 실패로 오분류하지 않음)
    expect(screen.queryByText(/저장에 실패했습니다/)).toBeNull();
  ```

  기존 테스트 상단의 회피 주석(L174-176, "즉시-복제 경로는 void cloneAndGo(...)라 실패 시 미흡수 rejection이 남는다")은 이제 사실이 아니게 되므로 제거(또는 "R1 fix로 즉시경로도 안전해졌다"로 갱신).

  **Acceptance (R1):** `pnpm test ScenarioEditPage.clone`을 fix 전에 실행하면 신규 케이스가 "Unhandled Rejection" 섹션과 함께 비-zero exit(개별 assertion은 green이어도 전체 실행 실패) — RED 확인.
  **Acceptance (R2, R5):** 기존 "복제 실패 시 오류 Callout" 케이스가 fix 전엔 신규 두 단언(`queryByRole("dialog")`/`queryByText`) 중 적어도 하나에서 실패 — RED 확인(현재 코드는 save-failed 모달을 열므로 `/저장에 실패했습니다/`가 present).

- [ ] **Step 2: `ui/src/i18n/ko.ts` — `cloneFailed` 키 추가**

  L394 `deleteFailed` 다음 줄에 추가:

  ```ts
    deleteFailed: (msg: string) => `삭제 실패: ${msg}`,
    cloneFailed: (msg: string) => `복제 실패: ${msg}`,
  ```

  **Acceptance (R3, R4):** `ko.pages.cloneFailed("x")` === `"복제 실패: x"`. `ui/src/i18n/__tests__/ko.test.ts`는 `ko.pages`를 선택적 스모크체크만 하고(`deleteFailed` 등 미열거, "잉여 키 금지" 단언 없음) 변경 불요(no-op) — 이 키를 그 테스트에 추가하지 않아도 안전.

- [ ] **Step 3: `ui/src/pages/ScenarioEditPage.tsx` — `cloneAndGo` try/catch + 문구 교체**

  현재(L102-107):
  ```tsx
  const cloneAndGo = async (sourceYaml: string, sourceName: string) => {
    const existingNames = scenarios?.scenarios.map((s) => s.name) ?? [];
    const created = await clone.mutateAsync({ sourceYaml, sourceName, existingNames });
    setCloneDialog(null);
    navigate(`/scenarios/${created.id}`);
  };
  ```

  변경 후:
  ```tsx
  const cloneAndGo = async (sourceYaml: string, sourceName: string) => {
    const existingNames = scenarios?.scenarios.map((s) => s.name) ?? [];
    try {
      const created = await clone.mutateAsync({ sourceYaml, sourceName, existingNames });
      setCloneDialog(null);
      navigate(`/scenarios/${created.id}`);
    } catch {
      // clone.error(useMutation 내부 상태)가 이미 페이지-레벨 Callout을 구동한다.
      // 열려 있던 모달을 닫아 그 Callout이 backdrop에 가리지 않게 한다(non-dirty
      // 즉시경로는 모달이 없으므로 no-op).
      setCloneDialog(null);
    }
  };
  ```

  L239(현재 `복제 실패: {(clone.error as Error).message}`)를:
  ```tsx
  {ko.pages.cloneFailed((clone.error as Error).message)}
  ```
  로 교체.

  **Acceptance (R1):** Step 1의 신규 RED 테스트가 GREEN으로 전환(개별 assertion 통과 + "Unhandled Rejection" 섹션 없이 exit 0).
  **Acceptance (R2):** 기존 "복제 실패 시 오류 Callout" 테스트의 `queryByRole("dialog")` 단언 GREEN.
  **Acceptance (R5):** 같은 테스트의 `queryByText(/저장에 실패했습니다/)` 단언 GREEN.
  **Acceptance (R3, R4):** 텍스트 단언(`toHaveTextContent("복제 실패: clone failed")`) GREEN — 문구 byte-identical.

- [ ] **Step 4: `ui/src/pages/ScenarioListPage.tsx` — 문구 교체**

  L60(현재 `복제 실패: {(clone.error as Error).message}`)를:
  ```tsx
  {ko.pages.cloneFailed((clone.error as Error).message)}
  ```
  로 교체. `import { ko } from "../i18n/ko";`는 이미 존재(L8) — 추가 import 불필요.

  **Acceptance (R3, R4):** 기존 `ScenarioListPage.clone.test.tsx`의 두 케이스(성공 케이스는 무관, "clears stale error banner" 케이스는 alert 텍스트를 직접 단언하지 않으므로 무변경으로 green 유지) 그대로 통과.

- [ ] **Step 5: 검증**
  ```bash
  pnpm lint > /tmp/scenario-clone-error-fixes-lint.log 2>&1; echo "exit=$?"
  pnpm test > /tmp/scenario-clone-error-fixes-test.log 2>&1; echo "exit=$?"
  pnpm build > /tmp/scenario-clone-error-fixes-build.log 2>&1; echo "exit=$?"
  grep -n '복제 실패' ui/src/pages/ScenarioEditPage.tsx ui/src/pages/ScenarioListPage.tsx
  ```
  세 게이트 모두 exit=0 + 전체 `pnpm test`(인자 없이, targeted 아님)에 "Unhandled Errors" 섹션 없음 + 마지막 grep이 0매치(정의는 `ko.ts`에만 남음)까지 확인.

- [ ] **Step 6: 커밋** — `git add ui/src/i18n/ko.ts ui/src/pages/ScenarioEditPage.tsx ui/src/pages/ScenarioListPage.tsx ui/src/pages/__tests__/ScenarioEditPage.clone.test.tsx`(경로 명시, `-A` 금지). 단일 커밋, 파이프 없이. subagent라면 `run_in_background:false` + timeout 600000ms 단일 foreground 호출(폴링 금지). 직후 `git log -1`로 landed 확인.

---

## 머지 / 마무리

- **라이브 검증 필요 여부**(spec §6): **불요** — run-생성/응답-파싱/엔진 경로 무접촉(순수 UI 에러 핸들링 + 문구 카탈로그 이주). 근거를 build-log에 기록.
- **워크트리 ff-merge**: `git -C /Users/sgj/develop/handicap merge --ff-only worktree-scenario-clone-error-fixes`(사전 `merge-base --is-ancestor master worktree-scenario-clone-error-fixes` + 메인 `status --porcelain -uno` clean 확인) → `ExitWorktree(remove, discard_changes:true)`.
- **잔류 정리**: Playwright 미사용 — 해당 없음.

## Self-Review (작성자 체크)

- **R 커버리지**: R1-R5 전부 Task 1에 매핑, 미매핑 0 ✓.
- **인라인 acceptance**: 각 Step이 acceptance를 인라인으로 보유 ✓.
- **Placeholder scan**: 모든 코드 블록이 실제 코드(의사코드/`...`/TODO 없음) ✓.
- **Type/idiom consistency**: 해당 없음(계약 경계 무접촉).
- **커밋 경계**: 단일 논리 변경 → 단일 green 커밋 ✓.
