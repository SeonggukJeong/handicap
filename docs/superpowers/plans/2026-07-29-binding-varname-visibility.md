# 데이터셋 바인딩 변수명 가시성 — 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 데이터셋 바인딩 화면에서 병렬 분기 변수의 접두사를 그룹 헤더로 들어내 변수명 본체가 잘리지 않게 하고, 그 변수가 "매핑되지 않음"으로 오판돼 [실행]이 막히던 선재 결함을 함께 없앤다.

**Architecture:** 순수 함수 2개(`namespacedProducerIndex` 판별 소스, `partitionBindingRows` 표시용 분할)를 먼저 세우고, `DataBindingPanel`은 그 결과로 렌더만 분기한다. `rows` 상태와 emit 경로는 손대지 않아 제출 payload가 byte-identical로 유지된다. 폭 확대와 uncovered union은 각각 독립 커밋.

**Tech Stack:** TypeScript + React 18 + Tailwind v3 + Zustand/Zod(기존) + vitest/RTL.

**Spec:** `docs/superpowers/specs/2026-07-29-binding-varname-visibility-design.md` (spec-plan-reviewer 3라운드 clean APPROVE). 이 plan은 spec의 §3~§9를 task로 옮긴 것이며, 충돌 시 **spec이 정본**이다.

## Global Constraints

- **UI-only.** `crates/**`·`proto/**`·migration·`ui/src/scenario/store.ts`·`ui/src/api/schemas.ts` **0-diff**. 서버 와이어 변경 없음.
- **제출 payload byte-identical.** `rows` 배열의 순서·내용과 emit effect(`DataBindingPanel.tsx:377-383`)의 `mappings` 생성 루프를 바꾸지 않는다. 그룹핑은 **표시용 재배치**일 뿐이다. (spec §3.3 규칙 6a/6b)
- **`split(".")` 금지.** 분기/변수 분해는 반드시 `namespacedProducerIndex`의 구조적 결과를 쓴다. 접미사 매칭·점 분해는 spec §3.2·`parallel-var-scope` 슬라이스가 금지한다.
- **모든 사용자 노출 문구는 `ko.ts` 경유** (ADR-0035). `aria-label`도 포함.
- **`aria ⊇ visible`** (WCAG 2.5.3): 그룹 접근명은 가시 텍스트를 **재사용해 조립**한다 — 독립 문자열 2개 금지. (spec §5·D8)
- **폭 상수 (spec §3.5, 변경 금지)**: 변수명 배지 `w-48` · manual 입력 `w-48` · 오류 힌트 `ml-[200px]` · B화면 변수명 입력 ~~`w-56`~~ → **`w-64`** (머지 전 라이브 실측에서 `w-56`이 US3를 3px 차이로 실패시켜 사용자 재가로 정정 — spec §3.5 rev2 참조. "변경 금지"는 임의 조정을 막으려는 것이지 실측 반증을 이기지는 않는다).
- **`tdd-guard` 제약**: `ui/src/**`의 non-test 파일을 편집하려면 **작업트리에 수정/미추적 테스트 파일이 먼저 있어야 한다.** 그래서 모든 task의 **Step 1은 테스트 파일 편집**이다. 순서를 바꾸지 말 것(직전 task 커밋 직후 트리는 clean이라 첫 production 편집이 무조건 차단된다).
- **게이트**: 각 task 커밋 전 `cd ui && pnpm lint && pnpm test && pnpm build`. `pnpm lint`는 `--max-warnings=0`이라 경고도 실패. 게이트 판정은 **파이프 없이** `; echo exit=$?`로 종료코드를 명시 캡처할 것(`| tail`은 실패를 마스킹한다).
- **이빨 실증 의무**: 회귀 가드를 표방하는 단언은 **고의 회귀 → RED → 원복 → GREEN**을 실제로 실행해 증명한다. 각 task에 해당 스텝이 명시돼 있다.

## File Structure

| 파일 | 책임 | Task |
|---|---|---|
| `ui/src/scenario/scanVars.ts` | `namespacedProducerIndex` 신규 + `collectNamespacedProducers` 재정의 (순회 정의 1개) | 1 |
| `ui/src/scenario/bindingGroups.ts` | **신규** — `partitionBindingRows` 표시용 분할 순수 함수 | 2 |
| `ui/src/i18n/ko.ts` | `binding.branchGroupLead` / `binding.branchGroupAriaTail` | 3 |
| `ui/src/components/DataBindingPanel.tsx` | 그룹 렌더(3) · 폭·정렬(4) · uncovered union(5) | 3·4·5 |
| `ui/src/components/scenario/TestRunDatasetSection.tsx` | 변수명 입력 폭 | 4 |
| `ui/src/scenario/__tests__/scanVars.test.ts` | Task 1 회귀 | 1 |
| `ui/src/scenario/__tests__/bindingGroups.test.ts` | **신규** — T1/T2/T3 | 2 |
| `ui/src/components/__tests__/DataBindingPanel.test.tsx` | T4~T9 + 공유 parallel 픽스처 | 3·4·5 |

---

### Task 1: `namespacedProducerIndex` — 구조적 분기/변수 판별 소스

**Files:**
- Modify: `ui/src/scenario/scanVars.ts:160-169` (`collectNamespacedProducers`)
- Test: `ui/src/scenario/__tests__/scanVars.test.ts`

**Interfaces:**
- Produces: `namespacedProducerIndex(scenario: Scenario): Map<string, { branchName: string; varName: string }>` — 키는 `` `${branchName}.${varName}` ``. Task 2·3·5가 소비한다.
- Produces (불변): `collectNamespacedProducers(scenario: Scenario): Set<string>` — 시그니처·반환 키 집합 **불변**. 기존 소비처 4곳(`varRows.ts:53`·`store.ts:217`·`store.ts:246`·**`scanVars.ts:300` `undefinedVarRefs` 내부**)이 그대로 동작해야 한다.

- [ ] **Step 1: 실패하는 테스트 작성** (tdd-guard 언블록 — 반드시 이 스텝이 먼저)

`ui/src/scenario/__tests__/scanVars.test.ts`의 `describe("collectNamespacedProducers (R3)", …)` 블록 **뒤에** 추가. `parallelScen`은 그 파일에 이미 있는 픽스처를 재사용한다(파일 상단에서 이름을 확인할 것 — 없으면 `collectNamespacedProducers` 테스트가 쓰는 픽스처와 동일한 것을 쓴다).

import는 새 줄을 만들지 말고 **파일 상단의 기존 `from "../scanVars"` 목록에 `namespacedProducerIndex`를 추가**한다(관례. 중간 삽입도 동작하지만 diff가 지저분하다).

```ts
describe("namespacedProducerIndex", () => {
  it("maps display key to structural branch/var without string splitting", () => {
    const idx = namespacedProducerIndex(parallelScen);
    for (const [display, { branchName, varName }] of idx) {
      expect(display).toBe(`${branchName}.${varName}`);
    }
    expect(idx.size).toBeGreaterThan(0);
  });

  it("keeps a branch name that itself contains a dot intact", () => {
    const scen = {
      ...parallelScen,
      steps: [
        {
          id: "01HWAAAAAAAAAAAAAAAAAAAAAG",
          name: "Fanout",
          type: "parallel" as const,
          branches: [
            {
              name: "a.b",
              steps: [
                {
                  id: "01HWAAAAAAAAAAAAAAAAAAAAAH",
                  name: "S",
                  type: "http" as const,
                  request: { method: "GET" as const, url: "http://x/", headers: {} },
                  assert: [],
                  extract: [{ var: "c", from: "body" as const, path: "$.c" }],
                },
              ],
            },
          ],
        },
      ],
    };
    // 첫 점으로 쪼갰다면 branchName="a", varName="b.c"가 됐을 것이다.
    expect(namespacedProducerIndex(scen).get("a.b.c")).toEqual({
      branchName: "a.b",
      varName: "c",
    });
  });

  it("collectNamespacedProducers stays equal to the index key set", () => {
    expect(collectNamespacedProducers(parallelScen)).toEqual(
      new Set(namespacedProducerIndex(parallelScen).keys()),
    );
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd ui && pnpm test scanVars`
Expected: FAIL — `namespacedProducerIndex is not a function` (또는 import 해결 실패)

- [ ] **Step 3: 구현**

`ui/src/scenario/scanVars.ts`의 `collectNamespacedProducers`(현재 `:160-169`)를 **아래 두 함수로 교체**한다. docstring의 R3/R4·ADR-0033 참조는 보존한다.

```ts
/** parallel 분기 B의 http extract var마다 `${B.name}.${var}` → 구조적 분해(R3/R4).
 *  parallel은 top-level-only(ADR-0033)이라 최상위 스텝만 훑는다.
 *  **문자열 분해 금지의 단일 소스** — 분기명에 점이 있어도 안전하다. */
export function namespacedProducerIndex(
  scenario: Scenario,
): Map<string, { branchName: string; varName: string }> {
  const out = new Map<string, { branchName: string; varName: string }>();
  for (const s of scenario.steps) {
    if (s.type !== "parallel") continue;
    for (const b of s.branches)
      for (const step of flattenHttpSteps(b.steps))
        for (const e of step.extract) {
          const display = `${b.name}.${e.var}`;
          if (!out.has(display)) out.set(display, { branchName: b.name, varName: e.var });
        }
  }
  return out;
}

/** 위 index의 키 집합. 순회 정의를 하나로 유지한다(거동 불변). */
export function collectNamespacedProducers(scenario: Scenario): Set<string> {
  return new Set(namespacedProducerIndex(scenario).keys());
}
```

- [ ] **Step 4: 통과 + 기존 소비처 회귀 확인**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/binding-varname-width/ui
pnpm test scanVars ; echo "scanVars exit=$?"
pnpm test varRows ; echo "varRows exit=$?"
pnpm test store ; echo "store exit=$?"
```
Expected: 전부 PASS. `undefinedVarRefs` 테스트가 `scanVars.test.ts` 안에 있으므로 첫 명령이 그것도 덮는다.

- [ ] **Step 5: 게이트 + 커밋**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/binding-varname-width/ui
pnpm lint ; echo "lint exit=$?"
pnpm test ; echo "test exit=$?"
pnpm build ; echo "build exit=$?"
cd .. && git add ui/src/scenario/scanVars.ts ui/src/scenario/__tests__/scanVars.test.ts
git commit -m "refactor(ui): namespacedProducerIndex로 분기 변수 구조적 판별 (binding-varname T1)"
```

---

### Task 2: `partitionBindingRows` — 표시용 분할 순수 함수

**Files:**
- Create: `ui/src/scenario/bindingGroups.ts`
- Test: `ui/src/scenario/__tests__/bindingGroups.test.ts` (신규)

**Interfaces:**
- Consumes: Task 1의 index 타입 `Map<string, { branchName: string; varName: string }>`.
- Produces: `partitionBindingRows<T extends RowRef>(rows: readonly T[], index): BindingGroups<T>` — Task 3이 소비한다. `idx`는 **원본 `rows` 배열 인덱스**다.

- [ ] **Step 1: 실패하는 테스트 작성** (신규 파일 — tdd-guard 언블록)

`ui/src/scenario/__tests__/bindingGroups.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { partitionBindingRows } from "../bindingGroups";

type Row = { varName: string; manual: boolean };
const r = (varName: string, manual = false): Row => ({ varName, manual });

const IDX = new Map([
  ["checkout_branch.session_token", { branchName: "checkout_branch", varName: "session_token" }],
  ["checkout_branch.order_id", { branchName: "checkout_branch", varName: "order_id" }],
]);

describe("partitionBindingRows", () => {
  // T1
  it("splits rows, keeps original indices, and preserves order within each part", () => {
    const rows = [
      r("username"),                          // 0 ungrouped
      r("checkout_branch.session_token"),     // 1 grouped
      r("checkout_branch.order_id"),          // 2 grouped
      r("late_var"),                          // 3 ungrouped
    ];
    const out = partitionBindingRows(rows, IDX);

    expect(out.ungrouped.map((u) => [u.row.varName, u.idx])).toEqual([
      ["username", 0],
      ["late_var", 3],
    ]);
    expect(out.groups).toHaveLength(1);
    expect(out.groups[0].branchName).toBe("checkout_branch");
    expect(out.groups[0].items.map((i) => [i.varName, i.idx])).toEqual([
      ["session_token", 1],
      ["order_id", 2],
    ]);
  });

  // T2 — 오타는 분기가 아니다
  it("leaves a dotted name that no branch produces in ungrouped", () => {
    const out = partitionBindingRows([r("ghost.token")], IDX);
    expect(out.groups).toHaveLength(0);
    expect(out.ungrouped.map((u) => u.row.varName)).toEqual(["ghost.token"]);
  });

  // T3 — manual 행은 절대 그룹핑하지 않는다(타이핑 중 점프 방지)
  it("never groups a manual row even when its name is a namespaced producer", () => {
    const out = partitionBindingRows([r("checkout_branch.session_token", true)], IDX);
    expect(out.groups).toHaveLength(0);
    expect(out.ungrouped).toHaveLength(1);
  });

  it("orders groups by first appearance", () => {
    const idx = new Map([
      ["b2.x", { branchName: "b2", varName: "x" }],
      ["b1.y", { branchName: "b1", varName: "y" }],
    ]);
    const out = partitionBindingRows([r("b2.x"), r("b1.y")], idx);
    expect(out.groups.map((g) => g.branchName)).toEqual(["b2", "b1"]);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd ui && pnpm test bindingGroups`
Expected: FAIL — `Cannot find module '../bindingGroups'`

- [ ] **Step 3: 구현**

`ui/src/scenario/bindingGroups.ts`:

```ts
/** 데이터 바인딩 패널의 매핑 행을 "비분기 행 + 분기별 그룹"으로 나누는 **표시용** 분할.
 *
 *  `rows` 자체는 변형·재정렬하지 않는다(규칙 6a) — `rows` 순서가 곧 제출 `mappings`
 *  순서이고 `profile_json` 바이트이기 때문이다. 각 항목이 **원본 인덱스 `idx`** 를
 *  들고 다니므로 소비처는 `updateRow(idx)`/`removeRow(idx)`를 안전하게 호출할 수 있다.
 */
export type RowRef = { varName: string; manual: boolean };

export type GroupedItem<T> = { row: T; idx: number; varName: string };

export type BindingGroups<T> = {
  ungrouped: { row: T; idx: number }[];
  groups: { branchName: string; items: GroupedItem<T>[] }[];
};

export function partitionBindingRows<T extends RowRef>(
  rows: readonly T[],
  index: Map<string, { branchName: string; varName: string }>,
): BindingGroups<T> {
  const ungrouped: { row: T; idx: number }[] = [];
  const groups: { branchName: string; items: GroupedItem<T>[] }[] = [];
  const byBranch = new Map<string, GroupedItem<T>[]>();

  rows.forEach((row, idx) => {
    // manual 행은 자유 입력칸이라 절대 그룹핑하지 않는다 — 타이핑 도중 행이
    // 다른 그룹으로 점프하면 포커스·커서가 깨진다.
    const hit = row.manual ? undefined : index.get(row.varName);
    if (!hit) {
      ungrouped.push({ row, idx });
      return;
    }
    let items = byBranch.get(hit.branchName);
    if (!items) {
      items = [];
      byBranch.set(hit.branchName, items);
      groups.push({ branchName: hit.branchName, items }); // 첫 등장 순
    }
    items.push({ row, idx, varName: hit.varName });
  });

  return { ungrouped, groups };
}
```

- [ ] **Step 4: 통과 확인**

Run: `cd ui && pnpm test bindingGroups`
Expected: PASS (4 tests)

- [ ] **Step 5: T2/T3 이빨 실증**

```
① bindingGroups.ts에서 `row.manual ? undefined :` 를 제거 → `pnpm test bindingGroups`
   → T3("never groups a manual row")가 FAIL 해야 한다. 확인 후 원복.
② `index.get(row.varName)`를 `index.get(row.varName) ?? { branchName: row.varName.split(".")[0], varName: row.varName }`
   로 바꿔 점-분해 폴백을 넣는다 → T2("ghost.token")가 FAIL 해야 한다. 확인 후 원복.
③ 원복 후 `pnpm test bindingGroups` GREEN + `git diff ui/src/scenario/bindingGroups.ts`가
   원복 전과 동일한지 확인.
```

- [ ] **Step 6: 게이트 + 커밋**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/binding-varname-width/ui
pnpm lint ; echo "lint exit=$?"
pnpm test ; echo "test exit=$?"
pnpm build ; echo "build exit=$?"
cd .. && git add ui/src/scenario/bindingGroups.ts ui/src/scenario/__tests__/bindingGroups.test.ts
git commit -m "feat(ui): partitionBindingRows 표시용 분할 순수 함수 (binding-varname T2)"
```

---

### Task 3: 분기별 그룹 헤더 렌더 (US1·US4)

**Files:**
- Modify: `ui/src/i18n/ko.ts:180` (`binding` 네임스페이스 끝, `removeMappingAria` 다음 줄)
- Modify: `ui/src/components/DataBindingPanel.tsx:5` (import), `:527-662` (`rows.length > 0 &&` 블록)
- Test: `ui/src/components/__tests__/DataBindingPanel.test.tsx`

**Interfaces:**
- Consumes: Task 1 `namespacedProducerIndex`, Task 2 `partitionBindingRows`.
- Produces: 공유 픽스처 `makeScenarioWithParallel()`(Task 5가 재사용) · ko 키 2개.

- [ ] **Step 1: 픽스처 + 실패하는 테스트 작성** (tdd-guard 언블록 — 반드시 먼저)

`DataBindingPanel.test.tsx`의 기존 픽스처 함수들 **뒤에** 추가. **스캔 순서가 `username → 분기 2개 → late_var`로 섞이는 것이 핵심**이다 — 그래야 `partition 순서 ≠ rows 순서`가 되어 T4(원본 idx)와 Task 5의 T9(6b)가 이빨을 갖는다. ULID는 I/L/O/U를 쓰지 않는다.

```ts
/** 스캔 순서가 [username, checkout_branch.session_token, checkout_branch.order_id, late_var]가
 *  되도록 parallel 노드를 가운데 두고 뒤 스텝이 late_var를 참조한다.
 *  → partition 순서(ungrouped 먼저)와 rows 순서가 달라져 idx/순서 회귀에 이빨이 생긴다. */
function makeScenarioWithParallel(): Scenario {
  return {
    version: 1 as const,
    name: "Parallel",
    cookie_jar: "auto" as const,
    variables: {},
    steps: [
      {
        id: "01HWAAAAAAAAAAAAAAAAAAAAAC",
        name: "Login",
        type: "http" as const,
        request: { method: "POST" as const, url: "http://example.com/login/{{username}}", headers: {} },
        assert: [],
        extract: [],
      },
      {
        id: "01HWAAAAAAAAAAAAAAAAAAAAAD",
        name: "Fanout",
        type: "parallel" as const,
        branches: [
          {
            name: "checkout_branch",
            steps: [
              {
                id: "01HWAAAAAAAAAAAAAAAAAAAAAE",
                name: "Session",
                type: "http" as const,
                request: { method: "GET" as const, url: "http://example.com/session", headers: {} },
                assert: [],
                extract: [
                  { var: "session_token", from: "body" as const, path: "$.token" },
                  { var: "order_id", from: "body" as const, path: "$.oid" },
                ],
              },
            ],
          },
        ],
      },
      {
        id: "01HWAAAAAAAAAAAAAAAAAAAAAF",
        name: "Use",
        type: "http" as const,
        request: {
          method: "GET" as const,
          url: "http://example.com/o/{{checkout_branch.session_token}}/{{checkout_branch.order_id}}/{{late_var}}",
          headers: {},
        },
        assert: [],
        extract: [],
      },
    ],
  };
}

/** 가시 텍스트를 DOM에서 뽑는다(공백 정규화) — 카피가 바뀌어도 살아남는 비교용. */
function visibleTextOf(el: Element): string {
  const clone = el.cloneNode(true) as Element;
  clone.querySelectorAll("[aria-hidden='true']").forEach((n) => n.remove());
  return (clone.textContent ?? "").replace(/\s+/g, " ").trim();
}
```

이어서 새 `describe` 블록:

> **이 파일의 관용구를 그대로 쓴다(발명 금지)**: 렌더는 `renderPanel(scenario, onChange?, onValidityChange?)` 헬퍼(`:125-142`)를 쓴다 — raw `render(<DataBindingPanel …/>)`는 `QueryClientProvider`가 없어 깨진다. `renderPanel`은 `onChange`를 **단일 바인딩**으로 어댑트하고(`bindings[0] ?? null`), `onValidityChange`는 **`(ok, reasons)` 2인자**다. 데이터셋 모킹은 모듈 레벨 `fetchMock`+`jsonResponse`(`:12`·`:19`).
>
> **`ko` import 추가 필요** — 이 파일 상단(`:1-7`)에 `ko`가 없다. `import { ko } from "../../i18n/ko";`를 추가할 것(경로 깊이 주의: `__tests__/`라 `../../`다 — 잘못된 깊이는 `pnpm test`를 통과하고 `tsc -b`만 잡는다).

```ts
const GROUP_ARIA = `${ko.binding.branchGroupLead} checkout_branch ${ko.binding.branchGroupAriaTail}`;

describe("branch variable grouping", () => {
  // T5 (US1)
  it("shows branch vars by their bare name under one branch header", async () => {
    renderPanel(makeScenarioWithParallel());

    const groupList = await screen.findByRole("list", {
      name: `${ko.binding.branchGroupLead} checkout_branch ${ko.binding.branchGroupAriaTail}`,
    });
    const badges = within(groupList).getAllByTitle(/^checkout_branch\./);
    expect(badges).toHaveLength(2);
    expect(badges[0]).toHaveTextContent(/^session_token$/);
    expect(badges[1]).toHaveTextContent(/^order_id$/);
    // 접두사가 행에서 사라졌다 (헤더로 올라갔다)
    expect(badges[0].textContent).not.toContain("checkout_branch");
    // title은 전체 display를 유지한다 (복사·검색 가능성)
    expect(badges[0]).toHaveAttribute("title", "checkout_branch.session_token");
  });

  // T7 — aria ⊇ visible (조립형이라 구조적으로 참, 드리프트 가드)
  it("group list accessible name starts with the visible header text", async () => {
    renderPanel(makeScenarioWithParallel());
    const header = await screen.findByTestId("branch-group-header");
    const groupList = screen.getByRole("list", { name: GROUP_ARIA });
    const aria = (groupList.getAttribute("aria-label") ?? "").replace(/\s+/g, " ");
    expect(aria.startsWith(visibleTextOf(header))).toBe(true);
  });

  // T6 (US4) — 분기 없는 시나리오엔 새 구조가 안 생긴다
  it("adds no extra list and no named list when the scenario has no parallel branch", async () => {
    renderPanel(makeScenario());
    await screen.findByText("변수 매핑");
    expect(screen.getAllByRole("list")).toHaveLength(1);
    expect(screen.queryAllByRole("list", { name: /.+/ })).toHaveLength(0);
    expect(screen.queryByTestId("branch-group-header")).toBeNull();
  });

  // T4 — 그룹 행 조작이 원본 인덱스를 쓴다
  it("removing a grouped row removes only that row (original index, not local)", async () => {
    const user = userEvent.setup();
    renderPanel(makeScenarioWithParallel());
    const groupList = await screen.findByRole("list", { name: GROUP_ARIA });
    await user.click(
      within(groupList).getByRole("button", {
        name: ko.binding.removeMappingAria("checkout_branch.session_token"),
      }),
    );
    // username(원본 0)은 살아 있고, 지워진 건 session_token(원본 1)뿐이다.
    expect(screen.getByTitle("username")).toBeInTheDocument();
    expect(screen.queryByTitle("checkout_branch.session_token")).toBeNull();
    expect(screen.getByTitle("checkout_branch.order_id")).toBeInTheDocument();
    expect(screen.getByTitle("late_var")).toBeInTheDocument();
  });
});
```

> **주의(구현 시 실측할 것)**: T6의 `getAllByRole("list")).toHaveLength(1)`은 "카드 하나가 렌더하는 리스트가 매핑 `<ul>` 하나뿐"이라는 현재 baseline에 기댄다. 구현 전 `render(<DataBindingPanel scenario={makeScenario()} …/>)` 상태에서 실제 개수를 확인하고, 1이 아니면 **기대값을 실측치로 맞추되 "그룹 추가 후에도 그 수가 그대로"** 라는 의미가 유지되게 쓸 것. 숫자를 맞추려고 단언을 지우지 말 것.

- [ ] **Step 2: 실패 확인**

Run: `cd ui && pnpm test DataBindingPanel`
Expected: FAIL — `ko.binding.branchGroupLead`가 undefined이고 그룹 `<ul>`이 없어 `findByRole("list", {name})` 타임아웃.

- [ ] **Step 3: ko 키 추가**

`ui/src/i18n/ko.ts`의 `removeMappingAria` 줄(`:180`) 다음, `binding` 블록 닫는 `},` 앞에 추가:

```ts
    // 분기 변수 그룹 헤더. 가시 텍스트 = `${branchGroupLead} ${분기명}`,
    // 접근명 = 가시 텍스트 + ` ${branchGroupAriaTail}` (aria ⊇ visible, WCAG 2.5.3).
    branchGroupLead: "분기",
    branchGroupAriaTail: "변수 매핑",
```

- [ ] **Step 4: import 추가**

`ui/src/components/DataBindingPanel.tsx:5`를 교체:

```ts
import { scanFlowVars, collectProducedVars, namespacedProducerIndex } from "../scenario/scanVars";
import { partitionBindingRows } from "../scenario/bindingGroups";
```

- [ ] **Step 5: 분할 계산 추가**

`BindingCard` 안, `availableElsewhere`(`:308`) 근처에 추가:

```ts
  // 분기 변수 그룹핑 — 표시용 재배치일 뿐이다(rows/emit 경로 불변).
  const nsIndex = useMemo(() => namespacedProducerIndex(scenario), [scenario]);
  const { ungrouped, groups } = useMemo(() => partitionBindingRows(rows, nsIndex), [rows, nsIndex]);
```

- [ ] **Step 6: 렌더 재구성**

`:527-662`의 `{rows.length > 0 && ( … )}` 블록에서, 현재 `rows.map((row, idx) => { … })`의 **콜백 본문을 그대로** 지역 함수로 추출한다. 시그니처만 바꾸고 **내부 로직은 한 줄도 바꾸지 않는다**(폭은 Task 4, uncovered는 Task 5).

```tsx
  // 기존 rows.map 콜백 본문을 그대로 옮긴 것. displayName만 새 인자다.
  const renderRow = (row: MappingRow, idx: number, displayName: string) => {
    /* …기존 본문 그대로… 단 배지의 자식 텍스트만 {row.varName} → {displayName} …*/
  };
```

**`displayName`으로 바꾸는 곳은 배지의 자식 텍스트(`:561`) 딱 하나다.** 아래 `row.varName` 사용처는 **전부 전체 `display`(`분기.변수`)를 유지**한다 — spec §3.1(복사·검색 가능성)·§5(접근명에서 다른 분기의 동명 변수와 구별)의 요구다. "displayName으로 통일하는 게 깔끔하다"는 오판을 하지 말 것:

| 줄 | 용도 | 유지 이유 |
|---|---|---|
| `:537` | `conflictingVars.has(row.varName)` | 교차-카드 중복 판정 키 |
| `:550` | manual 입력 `updateRow({varName})` | 실제 모델 값 |
| `:559` | 배지 `title` | 잘렸을 때의 복구 수단 |
| `:564` | `autoMatchedVars.has(row.varName)` | auto-match 키 |
| `:573` | `sourceForAria(row.varName)` | 접근명 — 동명 변수 구별 |
| `:588-591` | `setAutoMatchedVars` delete 키 | 〃 |
| `:622` | `literalForAria(row.varName)` | 접근명 (**어떤 테스트도 안 잡는다** — 특히 주의) |
| `:634` | `removeMappingAria(row.varName \|\| idx)` | 접근명 (T4가 이 라벨로 버튼을 찾는다) |

그리고 리스트를 다음 형태로 바꾼다:

```tsx
{/* 모든 변수가 분기 변수인 시나리오에서 빈 <ul>이 DOM에 남지 않게 게이트한다
    (스크린리더가 빈 목록을 읽는다). US4 케이스에는 영향 없다. */}
{ungrouped.length > 0 && (
  <ul className="flex flex-col gap-2">
    {ungrouped.map(({ row, idx }) => renderRow(row, idx, row.varName))}
  </ul>
)}
{groups.map((g) => {
  // 가시 텍스트를 한 번만 만들고 접근명이 그걸 재사용한다 → 드리프트 구조적 불가.
  const visible = `${ko.binding.branchGroupLead} ${g.branchName}`;
  return (
    <div key={g.branchName} className="mt-3">
      <div
        data-testid="branch-group-header"
        className="mb-1 flex items-center gap-1 text-xs text-slate-500"
      >
        <span className="shrink-0">{ko.binding.branchGroupLead}</span>
        <span className="truncate font-mono text-slate-600" title={g.branchName}>
          {g.branchName}
        </span>
      </div>
      <ul
        aria-label={`${visible} ${ko.binding.branchGroupAriaTail}`}
        className="flex flex-col gap-2 border-l-2 border-slate-200 pl-2"
      >
        {g.items.map(({ row, idx, varName }) => renderRow(row, idx, varName))}
      </ul>
    </div>
  );
})}
```

**필수 확인**: `renderRow`에 넘기는 `idx`가 **분할 결과의 원본 인덱스**여야 한다. `g.items.map((item, i) => …)`의 `i`를 쓰면 안 된다 — spec §3.4의 idx 소비 8지점(`:541 key`·`:550`·`:594`·`:596`·`:598`·`:626`·`:633`·`:634 접근명`)이 전부 오염된다.

- [ ] **Step 7: 통과 확인**

Run: `cd ui && pnpm test DataBindingPanel`
Expected: PASS — 신규 4건 + **기존 케이스 전부**. 기존이 깨지면 그 자리에서 셀렉터를 고친다(spec §7 실측상 안 깨질 것으로 예상).

- [ ] **Step 8: T4/T6 이빨 실증**

```
① renderRow 호출을 `g.items.map((item, i) => renderRow(item.row, i, item.varName))`로 바꾼다
   (지역 인덱스) → T4가 FAIL 해야 한다(username 또는 다른 행이 지워짐). 확인 후 원복.
② groups 렌더를 무조건 렌더로 바꾼다 — 예: `groups` 대신 `[{branchName:"x", items:[]}]`를
   렌더 → T6이 FAIL 해야 한다. 확인 후 원복.
③ 원복 후 `pnpm test DataBindingPanel` GREEN + `git diff` 확인.
```

- [ ] **Step 9: 게이트 + 커밋**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/binding-varname-width/ui
pnpm lint ; echo "lint exit=$?"
pnpm test ; echo "test exit=$?"
pnpm build ; echo "build exit=$?"
cd .. && git add ui/src/components/DataBindingPanel.tsx ui/src/i18n/ko.ts ui/src/components/__tests__/DataBindingPanel.test.tsx
git commit -m "feat(ui): 데이터 바인딩 분기 변수 그룹 헤더 (binding-varname T3, US1/US4)"
```

---

### Task 4: 변수명 열 폭 확대 + 오류 힌트 정렬 정정 (US2·US3)

**Files:**
- Modify: `ui/src/components/DataBindingPanel.tsx:547` · `:554` · `:643` · `:648` · `:653`
- Modify: `ui/src/components/scenario/TestRunDatasetSection.tsx:406` 영역의 변수명 `Input` 래퍼
- Test: `ui/src/components/__tests__/DataBindingPanel.test.tsx`

**Interfaces:** 없음(스타일만).

- [ ] **Step 1: 실패하는 테스트 작성** (tdd-guard 언블록)

`DataBindingPanel.test.tsx`의 `describe("branch variable grouping", …)` 뒤에 추가. **토큰 분리 비교** 필수 — raw `toContain("w-48")`은 `max-w-48` 류에 false-green이다.

```ts
describe("var name column width (US2)", () => {
  const tokens = (el: Element) => (el.getAttribute("class") ?? "").split(/\s+/);

  it("locks the badge width", async () => {
    renderPanel(makeScenarioWithMissing());
    const badge = await screen.findByTitle("missing");
    expect(tokens(badge)).toContain("w-48");
    expect(tokens(badge)).not.toContain("w-28");
  });

  it("keeps the error-hint indent in step with the badge width", async () => {
    // 힌트는 데이터셋이 선택돼야 렌더된다(`:641` "Error hints (only when dataset is selected)").
    fetchMock
      .mockResolvedValueOnce(jsonResponse(DATASET_LIST))
      .mockResolvedValueOnce(jsonResponse(DATASET_DETAIL));
    const user = userEvent.setup();
    renderPanel(makeScenarioWithMissing());

    const datasetSelect = await screen.findByLabelText(/데이터셋/i);
    await screen.findByRole("option", { name: /users\.csv/i });
    await user.selectOptions(datasetSelect, "DS1");

    const hint = (await screen.findByText(/매핑되지 않음/)).closest("p");
    expect(hint).not.toBeNull();
    expect(tokens(hint as Element)).toContain("ml-[200px]");
    expect(tokens(hint as Element)).not.toContain("ml-32");
  });
});
```

> `DATASET_LIST`/`DATASET_DETAIL`(`:99-120`)의 열은 `["username","email"]`이라 `makeScenarioWithMissing()`의 `{{missing}}`이 uncovered로 남아 힌트가 렌더된다 — 새 픽스처를 만들 필요가 없다.

- [ ] **Step 2: 실패 확인**

Run: `cd ui && pnpm test DataBindingPanel`
Expected: FAIL — `w-28`이 아직 남아 있어 `toContain("w-48")` 실패.

- [ ] **Step 3: A 화면 폭·정렬 교체**

`ui/src/components/DataBindingPanel.tsx`에서 정확히 4종을 바꾼다(다른 `w-28`/`ml-32`가 없는지 `grep -n "w-28\|ml-32" ui/src/components/DataBindingPanel.tsx`로 먼저 확인):

- `:547` manual 입력: `w-28 min-w-0 …` → `w-48 min-w-0 …`
- `:554` 배지: `w-28 shrink-0 truncate …` → `w-48 shrink-0 truncate …`
- `:643`·`:648`·`:653` 힌트: `ml-32` → `ml-[200px]` (배지 192px + `gap-2` 8px. 기존 `ml-32`=128px는 112+8=120px과 8px 어긋나 있던 선재 오차다.)

- [ ] **Step 4: B 화면 폭 교체**

`ui/src/components/scenario/TestRunDatasetSection.tsx` — 변수명 `Input`을 감싼 `<div className="w-32">`(열 `Select`를 감싼 `w-32`가 **아니라** 그 다음 것, `ko.editor.dsMappingVarAria`를 쓰는 쪽)를 `<div className="w-56">`으로 바꾼다.

- [ ] **Step 5: 통과 + 이빨 실증**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/binding-varname-width/ui
pnpm test DataBindingPanel ; echo "exit=$?"     # PASS 기대
pnpm test TestRunSection ; echo "exit=$?"       # 기존 회귀 없음 확인
```
이빨: `:554`를 `w-28`로 되돌린다 → 폭 테스트 FAIL 확인 → 원복. 힌트도 `ml-32`로 되돌려 FAIL 확인 → 원복.

- [ ] **Step 6: 게이트 + 커밋**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/binding-varname-width/ui
pnpm lint ; echo "lint exit=$?"
pnpm test ; echo "test exit=$?"
pnpm build ; echo "build exit=$?"
cd .. && git add ui/src/components/DataBindingPanel.tsx ui/src/components/scenario/TestRunDatasetSection.tsx ui/src/components/__tests__/DataBindingPanel.test.tsx
git commit -m "fix(ui): 바인딩 변수명 열 폭 확대·힌트 정렬 정정 (binding-varname T4, US2/US3)"
```

---

### Task 5: 네임스페이스 변수 uncovered false-alarm 제거 (US5)

> 이 task는 **표시가 아니라 실행 게이팅**을 바꾼다. 리뷰어 권고대로 **독립 커밋**으로 두어 회귀 시 revert 단위가 깨끗하게 한다.

**Files:**
- Modify: `ui/src/components/DataBindingPanel.tsx:5` (import), `:308` (`availableElsewhere`)
- Test: `ui/src/components/__tests__/DataBindingPanel.test.tsx`

**Interfaces:** Task 1의 `collectNamespacedProducers`(재정의된 것) 소비.

- [ ] **Step 1: 실패하는 테스트 작성** (tdd-guard 언블록)

**픽스처 조건 2개를 반드시 지킬 것** — 어기면 단언이 조용히 공허해진다:

- **조건 ①** — `reasons = uncovered ∪ (datasetGone | staleCols)`(`DataBindingPanel.tsx:401-408`)이므로 **비분기 변수(`username`·`late_var`)가 covered여야** "빈 배열"이 성립한다. 데이터셋 열 이름을 변수명과 **동일하게**(`username`, `late_var`) 지어 auto-match(`:346-365`는 `columnSet.has(r.varName)` = 이름 동일 요구)가 걸리게 한다. 안 그러면 union과 **무관한** 사유가 남아 RED가 되고, 단언을 `not.toContain(...)`으로 후퇴시키고 싶어진다 — 그 유혹이 이 조건을 두는 이유다.
- **조건 ②** — 6b(`mappings` 순서) 단언이 이빨을 가지려면 `partition 순서 ≠ rows 순서`여야 한다: **분기 행 1개 이상이 매핑**되고 **스캔 순서상 그 뒤 비분기 행(`late_var`)도 매핑**돼야 한다. 그래서 데이터셋에 `token` 열을 두고 `checkout_branch.session_token`을 거기에 매핑한다.

데이터셋 열 = `["username", "late_var", "token"]`이므로 기존 `DATASET_LIST`/`DATASET_DETAIL`(열이 `username`/`email`)을 못 쓴다. 같은 모양으로 **NS 전용 상수 2개**를 픽스처 옆에 추가한다:

```ts
const DATASET_LIST_NS = {
  datasets: [
    {
      id: "DS2",
      name: "ns.csv",
      columns: ["username", "late_var", "token"],
      row_count: 10,
      byte_size: 256,
      created_at: 1000,
    },
  ],
};

const DATASET_DETAIL_NS = {
  id: "DS2",
  name: "ns.csv",
  columns: ["username", "late_var", "token"],
  row_count: 10,
  byte_size: 256,
  created_at: 1000,
  sample: [{ username: "alice", late_var: "L1", token: "T1" }],
};

/** NS 데이터셋을 모킹하고 고른다 — 두 케이스가 공유. */
async function selectNsDataset(user: ReturnType<typeof userEvent.setup>) {
  const datasetSelect = await screen.findByLabelText(/데이터셋/i);
  await screen.findByRole("option", { name: /ns\.csv/i });
  await user.selectOptions(datasetSelect, "DS2");
}
```

```ts
describe("namespaced vars are not false-flagged as uncovered (US5)", () => {
  it("emits no validity reason and keeps mappings in rows order", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(DATASET_LIST_NS))
      .mockResolvedValueOnce(jsonResponse(DATASET_DETAIL_NS));
    const user = userEvent.setup();
    const onChange = vi.fn();
    const onValidity = vi.fn();
    renderPanel(makeScenarioWithParallel(), onChange, onValidity);

    await selectNsDataset(user);
    // username·late_var는 이름이 열과 같아 auto-match된다(조건 ①).
    // session_token은 token 열로 수동 매핑 — 조건 ②(partition 순서 ≠ rows 순서).
    await user.selectOptions(
      await screen.findByLabelText(ko.binding.sourceForAria("checkout_branch.session_token")),
      "token",
    );

    // onValidityChange는 (ok, reasons) 2인자다.
    await waitFor(() => expect(onValidity.mock.lastCall?.[1]).toEqual([]));

    // 6b: emit된 mappings 순서 = rows 순서 (partition 순서가 아니다).
    // renderPanel이 onChange를 단일 바인딩으로 어댑트한다(bindings[0] ?? null).
    const mappings = onChange.mock.lastCall?.[0]?.mappings ?? [];
    expect(mappings.map((m: { var: string }) => m.var)).toEqual([
      "username",
      "checkout_branch.session_token",
      "late_var",
    ]);
  });

  it("still flags a dotted name that no branch produces", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(DATASET_LIST_NS))
      .mockResolvedValueOnce(jsonResponse(DATASET_DETAIL_NS));
    const user = userEvent.setup();
    const onValidity = vi.fn();
    const scen = makeScenarioWithParallel();
    // 3번째 스텝(Use)의 url을 오타 참조로 교체 — 어떤 분기도 ghost를 생산하지 않는다.
    const use = scen.steps[2];
    if (use.type !== "http") throw new Error("fixture drift: steps[2] must be the http 'Use' step");
    use.request.url = "http://example.com/o/{{ghost.token}}";

    renderPanel(scen, vi.fn(), onValidity);
    await selectNsDataset(user);

    await waitFor(() =>
      expect((onValidity.mock.lastCall?.[1] as string[]).join(" ")).toContain("ghost.token"),
    );
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd ui && pnpm test DataBindingPanel`
Expected: 첫 케이스 FAIL — `reasons`가 `[]`가 아니다. **잔존 사유는 `{{checkout_branch.order_id}}` 하나뿐**이다(`session_token`은 이 테스트가 `token` 열에 수동 매핑하므로 `mappedVars`에 들어가 uncovered에서 빠진다 — `:388`·`:392-394`). "2개일 것"이라 기대하고 헤매지 말 것.

- [ ] **Step 3: 구현**

`:5` import에 `collectNamespacedProducers`를 추가하고, `:308`을 교체:

```ts
  // 네임스페이스 변수(`{{분기.변수}}`)는 엔진이 join_all 후 병합해 공급한다(ADR-0033,
  // runner.rs:690) — 데이터셋에서 매핑할 대상이 아니다. collectProducedVars는 bare
  // 이름만 담으므로(scanVars.ts:151) union 하지 않으면 항상 uncovered로 오판되어
  // [실행]이 막힌다. 생산자 집합에 없는 dotted 이름(오타)은 여전히 잡힌다.
  const availableElsewhere = useMemo<Set<string>>(
    () => new Set([...collectProducedVars(scenario), ...collectNamespacedProducers(scenario)]),
    [scenario],
  );
```

- [ ] **Step 4: 통과 확인**

Run: `cd ui && pnpm test DataBindingPanel`
Expected: PASS 전부.

- [ ] **Step 5: 이빨 실증 (3종)**

```
① union을 제거(`new Set(collectProducedVars(scenario))`) → US5 첫 케이스 FAIL 확인 → 원복.
② emit effect(:377-383)의 mappings 루프를 partition 출력 순회로 바꾼다
   (ungrouped 먼저 → groups) → 6b 순서 단언이 FAIL 해야 한다 → 원복.
   ※ FAIL이 안 나면 픽스처가 조건 ②를 못 지킨 것이다 — 매핑을 다시 확인할 것.
③ union에 오타까지 포함시키는 개악(예: dotted면 무조건 통과) → 두 번째 케이스
   ("ghost.token")가 FAIL 해야 한다 → 원복.
④ 원복 후 GREEN + `git diff` 확인.
```

- [ ] **Step 6: 게이트 + 커밋**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/binding-varname-width/ui
pnpm lint ; echo "lint exit=$?"
pnpm test ; echo "test exit=$?"
pnpm build ; echo "build exit=$?"
cd .. && git add ui/src/components/DataBindingPanel.tsx ui/src/components/__tests__/DataBindingPanel.test.tsx
git commit -m "fix(ui): 분기 변수 uncovered 오판으로 실행이 막히던 문제 (binding-varname T5, US5)"
```

---

## 라이브 검증 (전 task 완료 후, 머지 전 — spec §8)

**마운트 4곳 전부** 확인한다(A: `RunDialog.tsx:782`·`ScheduleForm.tsx:420` / B: `ScenarioEditPage.tsx:277`·`ScenarioNewPage.tsx:146`). 메모리 `live-verify-all-mount-paths`.

**픽스처**: parallel(`checkout_branch` → `session_token`·`order_id`) + 다운스트림 참조 + 비분기 `username`·`order_number_reference`를 가진 시나리오 YAML, 그리고 **`user_name`·`oid`·`token` 3열** CSV.

| US | 절차 | 통과 신호 |
|---|---|---|
| US1 | `/scenarios/{id}/runs` → [실행하기] → 데이터 바인딩 | 분기 두 행이 `session_token`/`order_id`로 구분됨 + 헤더 1회 |
| US1' | 스케줄 편집 → 같은 패널 | 동일 |
| US2 | 같은 패널 | `order_number_reference` 배지의 `scrollWidth <= clientWidth` |
| US3 | `/scenarios/{id}` → 미리 실행 → 데이터셋 매핑 | `input.scrollWidth <= input.clientWidth` |
| US3' | `/scenarios/new` → 같은 섹션 | 동일 |
| US4 | 분기 없는 시나리오 | 그룹 헤더·세로선 부재 + 행 수 동일 |
| US5 | US1 화면에서 데이터셋 선택 → **비분기 2행에 열을 먼저 매핑** | "매핑되지 않음" 미표시 + **[실행] 활성** |

- **US5의 매핑 선행은 생략 불가**: auto-match는 이름 동일을 요구하는데 CSV 열이 `user_name`/`oid`라 안 걸린다 → 매핑 없이는 [실행]이 §3.6과 무관하게 비활성이라 false-FAIL이 난다.
- 오타 `{{ghost.token}}` 가드 확인은 **라이브에서 생략**한다(T9 두 번째 케이스가 커버, 에디터 왕복 2스텝 회피).
- 셀렉터 주의: `분기`는 `ko.trust.runDialogBFailCond`("…의도한 분기를 타지 않습니다") 등과 substring 충돌한다. Playwright는 `exact: true` 또는 role+정확 접근명으로.
- `getBoundingClientRect`/`scrollWidth` **실측**이 권위다 — DOM 텍스트 존재만으로 PASS 금지.

## 최종 리뷰 (머지 전)

- `handicap-reviewer` APPROVE (크로스커팅·repo 함정·와이어 1:1).
- **보안 게이트**: `finish-slice §0`의 grep을 **직접 실행**해 판정한다. UI-only·요청실행/템플릿/캐스트 미접촉이라 무매치 예상이나, **예측을 신뢰해 스킵하지 말 것**(think-time-defaults 선례). 매치가 있으면 `security-reviewer`도 APPROVE 필수.
  - 추가 판단(기계 grep이 N/A여도): Task 5가 **실행 게이트를 여는** 변경이다. grep이 무매치여도 "가드를 약화시켰나"를 도메인 관점에서 한 번 더 본다 — 메모리 `security-gate-judgment-override`. 판단 근거는 spec §3.6 "방어 근거 3종"(서버 대응 게이트 부재·낙관성 동치·확립된 정책 정렬).

---

<!-- spec-plan-reviewer: spec 3라운드 clean APPROVE(7c35060) · plan 1라운드 clean APPROVE.
     비차단 findings 5건은 이 문서에 fold-in 완료(Task5 Step2 문구·renderRow 유지 표·
     ungrouped 게이트·앵커 범위 3건·Task1 import 관례). -->
REVIEW-GATE: APPROVED
