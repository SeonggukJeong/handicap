# 실행 전 시나리오 신뢰도 preflight (A11 2차) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 에디터와 실행 다이얼로그에서 **부하를 걸기 전에** 시나리오 신뢰도 등급과 고칠 곳을 제시해, "요청은 다 나가는데 아무것도 검증하지 않는 시험"을 실행 전에 잡는다.

**Architecture:** 클라이언트 순수 함수 `evaluateTrust(scenario)`가 판정의 단일 소스이고, 세 표면(에디터 칩·모달·RunDialog 한 줄)은 렌더만 한다. B·C는 `VariablesPanel`이 이미 렌더 중인 정보라 재나열하지 않고 개수 + 패널 링크로 위임하며, 그러기 위해 패널의 행 빌더를 공유 모듈로 추출해 **판정 규칙을 한 벌로** 만든다. D(시험 실행 미검증)는 브라우저-로컬 인식 상태라 **등급에 관여하지 않고** 시그니처에서부터 분리한다.

**Tech Stack:** TypeScript · React · Zustand(`ui/src/scenario/store.ts`) · Zod 모델(`ui/src/scenario/model.ts`) · vitest + React Testing Library · `localStorage`(fail-soft)

**Spec:** `docs/superpowers/specs/2026-07-25-scenario-preflight-design.md`

**카피 정본:** `docs/dev/scenario-preflight-copy.md` — **byte-exact**. 이 plan의 어떤 task도 문구를 즉석에서 짓지 않는다. (`docs/superpowers/plans/`가 아니라 `docs/dev/`에 있는 이유는 그 파일 머리말 참조 — 가드가 `plans/`의 모든 `.md`에 승인 마커를 요구한다.)

---

## Global Constraints

모든 task의 요구사항에 암묵적으로 포함된다.

1. **UI-only.** `crates/**`·`proto/**`·`deploy/**`·migration을 **한 줄도** 건드리지 않는다. 서버 응답 스키마(`ui/src/api/schemas.ts`)도 변경 없음 — 읽기만 한다.
2. **soft only.** run 생성·제출을 **막지 않는다**. `disabled` 속성이나 제출 게이트를 새로 추가하지 않는다.
3. **D는 등급에 관여하지 않는다.** `evaluateTrust`는 test-run 상태를 **인자로 받지 않고** `TrustReport`에 담지도 않는다. 이 불변식은 타입으로 강제된다 — 시그니처에 `TestRunState`를 넣으려는 충동이 들면 spec §2 D19를 읽을 것.
4. **문구는 카피 정본에서 byte-exact로 옮긴다.** 새 문구를 추가했다면 그 값으로 `grep -c "<값>" ui/src/i18n/ko.ts` 대조를 돌리고 자기 정의 횟수만 잡히는지 확인한다.
5. **밀도 제약**: 상시 배너 +0, 상시 칩 +1 이내, 리포트 표면 0-diff, RunDialog는 `level !== "good"`일 때만 렌더.
6. **게이트**: 각 task 커밋 전 `pnpm lint` → `pnpm test` → `pnpm build`. **`| tail`/`| head` 파이프 금지** — 파이프 종료코드가 실패를 마스킹한다. 판정은 `; echo exit=$?`로 종료코드를 명시 캡처한다.
7. **tdd-guard**: `ui/src/**/*.{ts,tsx}` 편집은 작업트리에 수정/미추적 **테스트 파일이 있어야** 허용된다(`.claude/hooks/tdd-guard.sh:28`이 `ui/src/.+\.(ts|tsx|js|jsx)$`를 production으로 본다 — **`i18n/ko.ts`도 포함**). 직전 task 커밋 직후 트리는 clean이므로 **모든 task의 첫 스텝은 테스트 파일 작성**이다. 이 plan은 그렇게 배열돼 있다 — 순서를 바꾸지 말 것.
8. **테스트 픽스처 규약** (아래 두 가지를 어기면 `pnpm build`의 `tsc -b`가 깨진다):
   - 빌더의 입력 타입은 **`Record<string, unknown>`**. `Partial<Scenario>`를 쓰면 헬퍼가 만든 객체의 `type`이 `string`으로 넓어져 `TS2322 Type 'string' is not assignable to type '"http"'`가 난다.
   - **`Step` 유니온을 사후 변형하지 않는다.** `sc().steps[0].request = …`는 `TS2339 Property 'request' does not exist on type '{ type: "loop"; … }'`다. 변형 대신 **빌더에 다른 인자를 줘서 새 시나리오를 만든다**.
9. **커밋 메시지**에 파이프 금지, `--no-verify` 금지.

---

## File Structure

| 파일 | 책임 | Task |
|---|---|---|
| `ui/src/scenario/varRows.ts` | **신규** — 변수 행 빌더 + `VarRow` 타입. `VariablesPanel`과 `trust.ts`의 공통 소스 | 1 |
| `ui/src/components/scenario/VariablesPanel.tsx` | 빌더·타입을 import로 교체(렌더 byte-identical) | 1 |
| `ui/src/scenario/trust.ts` | **신규** — `evaluateTrust`/`isTrustApplicable` 순수 판정 + `TestRunState` 타입 선언 | 2 |
| `ui/src/scenario/trustPrefs.ts` | **신규** — `executionFingerprint` + 시나리오별 해시 버킷 + `adoptDraftBucket` | 3 |
| `ui/src/scenario/store.ts` | `testRunEpoch` + `bumpTestRunEpoch` (**5개 지점**) | 4 |
| `ui/src/components/scenario/TestRunSection.tsx` | `fire()` 시점 지문 스냅샷 → 성공 시 기록 + epoch 증가 | 4 |
| `ui/src/pages/ScenarioNewPage.tsx` | 저장 성공 시 `adoptDraftBucket` | 4 |
| `ui/src/components/scenario/TrustBoard.tsx` | **신규** — 모달 | 5 |
| `ui/src/i18n/ko.ts` | `trust` 네임스페이스 | 5 |
| `ui/src/components/scenario/EditorShell.tsx` | 칩 +1, 모달 마운트, 패널 링크 배선 | 5 |
| `ui/src/components/RunDialog.tsx` | 조건부 한 줄 + B fail 분기 | 6 |

ADR-0049는 task가 아니라 `/finish-slice` 산출물이다.

---

## Task 1: 변수 행 빌더 공유 모듈 추출

`VariablesPanel`의 행 빌더를 순수 모듈로 옮긴다. **동작 변경 0** — Task 2의 C 점검이 패널과 같은 규칙을 쓰게 하려는 준비다. 규칙이 두 벌이면 같은 변수가 패널엔 `미사용`, 모달엔 `사용됨`으로 갈린다.

**Files:**
- Create: `ui/src/scenario/varRows.ts`
- Create: `ui/src/scenario/__tests__/varRows.test.ts`
- Modify: `ui/src/components/scenario/VariablesPanel.tsx`

**Interfaces:**
- Consumes: `scanVars`의 `collectProducedVars`·`parallelExtractNames`·`buildVarRefIndex`·`undefinedVarRefs`·`parallelVarIdentities`·`flatExtractNames`·`collectNamespacedProducers` · `genVars`의 `VarDeclValue`
- Produces: `buildVarRows(model: Scenario | null): VarRow[]` · `type VarRow`

- [ ] **Step 1: 실패하는 테스트 작성** — `ui/src/scenario/__tests__/varRows.test.ts`

`tdd-guard`가 production 편집을 허용하려면 이 파일이 먼저 존재해야 한다(Global Constraint 7).

```ts
import { describe, expect, it } from "vitest";
import { buildVarRows } from "../varRows";
import { ScenarioModel, type Scenario } from "../model";

const A = "01HZZZZZZZZZZZZZZZZZZZZZZA";
const B = "01HZZZZZZZZZZZZZZZZZZZZZZB";

/** Global Constraint 8: 입력은 Record<string, unknown> — Partial<Scenario>는 type을 넓힌다. */
function sc(over: Record<string, unknown> = {}): Scenario {
  return ScenarioModel.parse({
    version: 1,
    name: "t",
    cookie_jar: "auto",
    variables: {},
    steps: [],
    ...over,
  });
}

function step(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: `s-${id.slice(-1)}`,
    type: "http",
    request: { method: "GET", url: "https://e.test/a", headers: {} },
    assert: [],
    extract: [],
    ...over,
  };
}

describe("buildVarRows", () => {
  it("model이 null이면 빈 배열", () => {
    expect(buildVarRows(null)).toEqual([]);
  });

  it("선언 변수는 declared 행 — 참조 스텝이 refIds에 담긴다", () => {
    const rows = buildVarRows(
      sc({
        variables: { host: "e.test" },
        steps: [
          step(A, { request: { method: "GET", url: "https://{{host}}/a", headers: {} } }),
        ],
      }),
    );
    expect(rows.find((r) => r.kind === "declared")).toMatchObject({
      name: "host",
      refIds: [A],
    });
  });

  it("추출했지만 아무도 안 쓰면 flat-extract 행의 refIds가 빈다", () => {
    const rows = buildVarRows(
      sc({ steps: [step(A, { extract: [{ var: "tok", from: "body", path: "$.t" }] })] }),
    );
    expect(rows.find((r) => r.kind === "flat-extract")).toMatchObject({
      name: "tok",
      refIds: [],
    });
  });

  it("추출 변수를 뒤 스텝이 쓰면 refIds가 채워진다", () => {
    const rows = buildVarRows(
      sc({
        steps: [
          step(A, { extract: [{ var: "tok", from: "body", path: "$.t" }] }),
          step(B, {
            request: {
              method: "GET",
              url: "https://e.test/b",
              headers: { Authorization: "{{tok}}" },
            },
          }),
        ],
      }),
    );
    expect(rows.find((r) => r.kind === "flat-extract")).toMatchObject({
      name: "tok",
      refIds: [B],
    });
  });

  it("어디서도 만들지 않는 변수를 참조하면 undefined 행", () => {
    const rows = buildVarRows(
      sc({
        steps: [
          step(A, { request: { method: "GET", url: "https://e.test/{{nope}}", headers: {} } }),
        ],
      }),
    );
    expect(rows.find((r) => r.kind === "undefined")).toMatchObject({ name: "nope" });
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/scenario-preflight/ui && pnpm test varRows ; echo "exit=$?"
```

Expected: FAIL — `Failed to resolve import "../varRows"`.

- [ ] **Step 3: `varRows.ts` 생성 — `VariablesPanel`에서 순수 이동**

아래는 `VariablesPanel.tsx`의 `:27-51`(`VarRow` 유니온, `:51`의 `};`가 닫는 줄)과 `:123-172`(빌더 본문)를 **내용 변경 없이** 옮긴 것이다. `useMemo` 껍데기만 함수 시그니처로 바뀐다. **로직을 "개선"하지 말 것** — 이 task의 acceptance는 렌더 동일성이다.

```ts
import type { Scenario } from "./model";
import {
  collectProducedVars,
  parallelExtractNames,
  buildVarRefIndex,
  undefinedVarRefs,
  parallelVarIdentities,
  flatExtractNames,
  collectNamespacedProducers,
} from "./scanVars";
import type { VarDeclValue } from "./genVars";

export type VarRow =
  | {
      kind: "declared";
      name: string;
      value: VarDeclValue;
      renamable: boolean;
      overwritten: boolean;
      refIds: string[];
    }
  | { kind: "flat-extract"; name: string; refIds: string[] }
  | {
      kind: "parallel-extract";
      branchName: string;
      varName: string;
      display: string;
      isShadow: boolean;
      refIds: string[];
    }
  | {
      kind: "undefined";
      name: string;
      refIds: string[];
      candidates: string[];
      refKind: "downstream" | "sibling";
    };

/** VariablesPanel의 행 빌더 — `trust.ts`의 C 판정과 **같은 소스**여야 하므로 추출됐다
 *  (spec D15). 규칙은 이동 전 코드가 정본이다: 바꾸지 말 것. */
export function buildVarRows(model: Scenario | null): VarRow[] {
  if (!model) return [];
  const declaredKeys = new Set(Object.keys(model.variables));
  const produced = collectProducedVars(model);
  const parallelNames = parallelExtractNames(model);
  const refIndex = buildVarRefIndex(model);
  const undef = undefinedVarRefs(model);
  const flatEx = flatExtractNames(model);
  const namespaced = collectNamespacedProducers(model);
  const out: VarRow[] = [];
  // 선언(연필은 flat non-shadow일 때만)
  for (const [name, value] of Object.entries(model.variables))
    out.push({
      kind: "declared",
      name,
      value,
      renamable: !parallelNames.has(name),
      overwritten: flatEx.has(name) || namespaced.has(name),
      refIds: refIndex.get(name) ?? [],
    });
  // flat-extract = produced − 선언 − parallel(shadow) — 비-parallel 스텝에서만 추출된 이름
  for (const name of produced)
    if (!declaredKeys.has(name) && !parallelNames.has(name))
      out.push({ kind: "flat-extract", name, refIds: refIndex.get(name) ?? [] });
  // parallel-extract(구조적 identity — non-shadow는 분기-내부∪다운스트림 refIds)
  for (const id of parallelVarIdentities(model)) {
    const refIds = id.isShadow
      ? id.namespacedRefIds
      : [...new Set([...id.branchRefIds, ...id.namespacedRefIds])];
    out.push({
      kind: "parallel-extract",
      branchName: id.branchName,
      varName: id.varName,
      display: id.display,
      isShadow: id.isShadow,
      refIds,
    });
  }
  // 미정의(위치 인식 — refIds는 UndefinedRef.stepIds만, refIndex 전체가 아니다.
  // 정당한 분기 내부 참조를 usage 팝오버가 안 가리키게).
  for (const [name, ref] of undef)
    out.push({
      kind: "undefined",
      name,
      refIds: ref.stepIds,
      candidates: ref.candidates,
      refKind: ref.kind,
    });
  return out;
}
```

- [ ] **Step 4: `VariablesPanel.tsx`를 호출로 교체**

① `:27-51`의 `type VarRow = …` 블록을 **삭제**한다(`:51`의 `};`까지 — `:53`의 `type EditKey`는 남긴다).
② `:123-172`의 `const rows = useMemo<VarRow[]>(() => { … }, [model]);` 전체를 한 줄로 교체:

```ts
  const rows = useMemo<VarRow[]>(() => buildVarRows(model), [model]);
```

③ import 교체. **`VarRow` 타입은 이 파일에 계속 필요하다**(`:269` 부근 `matchesRow`가 쓴다) — 반드시 `import type`으로 되살릴 것:

```ts
import { buildVarRows, type VarRow } from "../../scenario/varRows";
```

④ `scanVars` import 7개(`collectProducedVars`·`parallelExtractNames`·`buildVarRefIndex`·`undefinedVarRefs`·`parallelVarIdentities`·`flatExtractNames`·`collectNamespacedProducers`)는 이 파일에서 **전부 미사용이 된다** — import 문 통째로 제거. `genVars` import는 `VarDeclValue`만 빠지고 나머지(`declSearchText`·`genParamsSummary`·`genTypeLabel`·`isGenSpec`·`GenSpec`)는 남는다. `pnpm lint`가 미사용 import를 잡아 준다.

- [ ] **Step 5: 테스트 통과 + 기존 패널 테스트 무수정 통과 확인**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/scenario-preflight/ui && pnpm test varRows VariablesPanel ; echo "exit=$?"
```

Expected: PASS. **`VariablesPanel` 기존 테스트를 단 한 줄도 고치지 않고 통과하는 것이 이 이동이 순수했다는 증거다.** 하나라도 고쳐야 한다면 이동이 아니라 변경을 한 것이니 되돌릴 것.

- [ ] **Step 6: 전체 게이트**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/scenario-preflight/ui && pnpm lint ; echo "lint=$?"
cd /Users/sgj/develop/handicap/.claude/worktrees/scenario-preflight/ui && pnpm test ; echo "test=$?"
cd /Users/sgj/develop/handicap/.claude/worktrees/scenario-preflight/ui && pnpm build ; echo "build=$?"
```

Expected: 셋 다 `=0`.

- [ ] **Step 7: 커밋**

```bash
git add ui/src/scenario/varRows.ts ui/src/scenario/__tests__/varRows.test.ts ui/src/components/scenario/VariablesPanel.tsx
git commit -m "refactor(ui): 변수 행 빌더를 varRows.ts로 추출 — 패널·신뢰도 판정 단일 소스 (preflight T1)"
```

---

## Task 2: 신뢰도 판정 순수 함수

**Files:**
- Create: `ui/src/scenario/trust.ts`
- Create: `ui/src/scenario/__tests__/trust.test.ts`

**Interfaces:**
- Consumes: `buildVarRows`(Task 1) · `flattenHttpSteps`(`ui/src/scenario/model.ts:264`) · `undefinedVarRefs`(`ui/src/scenario/scanVars.ts:295`)
- Produces:
  - `evaluateTrust(scenario: Scenario): TrustReport` — **test-run 인자 없음**(Global Constraint 3)
  - `isTrustApplicable(scenario: Scenario): boolean`
  - `type TrustReport = { level: TrustLevel; checks: TrustCheck[]; passed: number; applicable: number; failed: number; noValidationAtAll: boolean }`
  - `type TrustCheck = { id: TrustCheckId; status: "pass" | "fail" | "na"; steps: Array<{ id: string; name: string }>; count: number }`
  - `type TrustCheckId = "response_validation" | "undefined_vars" | "broken_extract_chain"`
  - `type TrustLevel = "good" | "caution" | "weak"`
  - `type TestRunState = "verified" | "stale" | "never"` (선언만 — Task 3이 import)

> **`steps`가 id가 아니라 `{id, name}`인 이유**: spec §7.2 목업의 칩이 `[로그인] [주문 조회]`이고 US2가 "영향받는 스텝을 보고"를 요구한다. 26자 ULID 칩은 그 목적을 무너뜨린다. 이름을 여기 실으면 `TrustBoard`가 id→이름 조회 prop을 따로 받을 필요도 없다.

- [ ] **Step 1: 실패하는 테스트 작성 — 진리표 전수 7행**

`ui/src/scenario/__tests__/trust.test.ts`. **행 2와 행 4가 이 테스트의 심장**이다: 둘 다 `C fail`이고 A의 전무/부분만 다른데 등급이 갈린다.

```ts
import { describe, expect, it } from "vitest";
import { evaluateTrust, isTrustApplicable } from "../trust";
import { ScenarioModel, type Scenario } from "../model";

const A = "01HZZZZZZZZZZZZZZZZZZZZZZA";
const B = "01HZZZZZZZZZZZZZZZZZZZZZZB";

function sc(over: Record<string, unknown> = {}): Scenario {
  return ScenarioModel.parse({
    version: 1,
    name: "t",
    cookie_jar: "auto",
    variables: {},
    steps: [],
    ...over,
  });
}

function step(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: `s-${id.slice(-1)}`,
    type: "http",
    request: { method: "GET", url: "https://e.test/a", headers: {} },
    assert: [],
    extract: [],
    ...over,
  };
}

const OK = [{ kind: "status", code: 200 }];
/** 추출만 하고 아무도 안 씀 → C 실패 */
const DANGLING = { extract: [{ var: "tok", from: "body", path: "$.t" }] };
/** 어디서도 안 만드는 변수 참조 → B 실패 */
const UNDEF = { request: { method: "GET", url: "https://e.test/{{nope}}", headers: {} } };

describe("evaluateTrust — 진리표 (spec §5)", () => {
  it("행 1: B 실패면 A·C와 무관하게 weak", () => {
    expect(evaluateTrust(sc({ steps: [step(A, { ...UNDEF, assert: OK })] })).level).toBe("weak");
  });

  it("행 2: 검증 전무 + C 실패 = weak", () => {
    const r = evaluateTrust(sc({ steps: [step(A, DANGLING)] }));
    expect(r.noValidationAtAll).toBe(true);
    expect(r.level).toBe("weak");
  });

  it("행 3: 검증 전무 + C 통과/na = caution", () => {
    const r = evaluateTrust(sc({ steps: [step(A)] }));
    expect(r.noValidationAtAll).toBe(true);
    expect(r.level).toBe("caution");
  });

  it("행 4: 검증 부분 + C 실패 = caution (행 2와의 차이는 A의 전무/부분뿐)", () => {
    const r = evaluateTrust(
      sc({ steps: [step(A, { assert: OK }), step(B, DANGLING)] }),
    );
    expect(r.noValidationAtAll).toBe(false);
    expect(r.level).toBe("caution");
  });

  it("행 5: 검증 부분 + C 통과/na = caution", () => {
    expect(evaluateTrust(sc({ steps: [step(A, { assert: OK }), step(B)] })).level).toBe("caution");
  });

  it("행 6: A 통과 + C 실패 = caution", () => {
    expect(
      evaluateTrust(sc({ steps: [step(A, { ...DANGLING, assert: OK })] })).level,
    ).toBe("caution");
  });

  it("행 7: 전부 통과 = good", () => {
    const r = evaluateTrust(sc({ steps: [step(A, { assert: OK })] }));
    expect(r.level).toBe("good");
    expect(r.failed).toBe(0);
  });
});

describe("evaluateTrust — 점검 상세", () => {
  it("A는 검증 없는 스텝의 id와 이름을 문서순으로 싣는다 (중첩 컨테이너 포함)", () => {
    const r = evaluateTrust(
      sc({
        steps: [
          {
            id: A,
            name: "p",
            type: "parallel",
            branches: [{ name: "b1", steps: [step(B)] }],
          },
        ],
      }),
    );
    const a = r.checks.find((c) => c.id === "response_validation");
    expect(a?.status).toBe("fail");
    expect(a?.steps).toEqual([{ id: B, name: "s-B" }]);
  });

  it("C는 na일 때 분모에서 빠진다 — extract가 없으면 applicable=2", () => {
    const r = evaluateTrust(sc({ steps: [step(A, { assert: OK })] }));
    expect(r.checks.find((c) => c.id === "broken_extract_chain")?.status).toBe("na");
    expect(r.applicable).toBe(2);
    expect(r.passed).toBe(2);
  });

  it("B·C는 스텝 칩 대신 개수만 싣는다 (spec D14)", () => {
    const r = evaluateTrust(sc({ steps: [step(A, { ...UNDEF, ...DANGLING })] }));
    const b = r.checks.find((c) => c.id === "undefined_vars");
    const c = r.checks.find((x) => x.id === "broken_extract_chain");
    expect(b?.count).toBe(1);
    expect(b?.steps).toEqual([]);
    expect(c?.count).toBe(1);
    expect(c?.steps).toEqual([]);
  });

  it("checks는 항상 3개, 고정 순서 A→B→C", () => {
    expect(evaluateTrust(sc({ steps: [step(A)] })).checks.map((c) => c.id)).toEqual([
      "response_validation",
      "undefined_vars",
      "broken_extract_chain",
    ]);
  });
});

describe("isTrustApplicable", () => {
  it("http 스텝이 없으면 false", () => {
    expect(isTrustApplicable(sc({ steps: [] }))).toBe(false);
  });
  it("http 스텝이 있으면 true", () => {
    expect(isTrustApplicable(sc({ steps: [step(A)] }))).toBe(true);
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/scenario-preflight/ui && pnpm test trust ; echo "exit=$?"
```

Expected: FAIL — `Failed to resolve import "../trust"`.

- [ ] **Step 3: `trust.ts` 구현**

```ts
import { flattenHttpSteps, type Scenario } from "./model";
import { undefinedVarRefs } from "./scanVars";
import { buildVarRows } from "./varRows";

export type TrustCheckId =
  | "response_validation"
  | "undefined_vars"
  | "broken_extract_chain";

export type TrustCheckStatus = "pass" | "fail" | "na";
export type TrustLevel = "good" | "caution" | "weak";

/** D(시험 실행 미검증)는 등급과 무관한 별개 상태다(spec D19). 타입은 여기서 선언·export하고
 *  `trustPrefs.ts`가 import한다(의존은 trustPrefs → trust 단방향). */
export type TestRunState = "verified" | "stale" | "never";

export interface TrustCheck {
  id: TrustCheckId;
  status: TrustCheckStatus;
  /** A 전용: 검증이 없는 http 스텝(문서순). B·C는 항상 빈 배열(spec D14). */
  steps: Array<{ id: string; name: string }>;
  /** B·C 전용: 걸린 변수 개수. A는 0. */
  count: number;
}

export interface TrustReport {
  level: TrustLevel;
  /** 항상 3개, 고정 순서 A→B→C. */
  checks: TrustCheck[];
  passed: number;
  applicable: number;
  /** 칩 숫자 = RunDialog 건수 (최대 3). */
  failed: number;
  noValidationAtAll: boolean;
}

/** http 스텝이 0개면 신뢰도를 평가하지 않는다(spec D12) — 호출부가 이걸로 칩을 숨긴다. */
export function isTrustApplicable(scenario: Scenario): boolean {
  return flattenHttpSteps(scenario.steps).length > 0;
}

/**
 * 시나리오 정적 신뢰도(spec §4~§5). **test-run 상태를 받지 않는다** — D를 등급에 섞으면
 * 등급이 사람마다 달라진다(spec D19/FR1). 순수 함수: localStorage·시간·난수 미사용.
 */
export function evaluateTrust(scenario: Scenario): TrustReport {
  const https = flattenHttpSteps(scenario.steps);

  // A — 모든 http 스텝이 status assert를 가져야 통과(전칭). 1차 서버 판정은 존재 한정이다.
  const missing = https.filter((s) => !s.assert.some((x) => x.kind === "status"));
  const withAssertCount = https.length - missing.length;
  const a: TrustCheck =
    https.length === 0
      ? { id: "response_validation", status: "na", steps: [], count: 0 }
      : {
          id: "response_validation",
          status: missing.length > 0 ? "fail" : "pass",
          steps: missing.map((s) => ({ id: s.id, name: s.name })),
          count: 0,
        };

  // B — 위치 인식 판정은 undefinedVarRefs에 위임(재구현 금지).
  const undef = undefinedVarRefs(scenario);
  const b: TrustCheck = {
    id: "undefined_vars",
    status: undef.size > 0 ? "fail" : "pass",
    steps: [],
    count: undef.size,
  };

  // C — VariablesPanel이 `미사용` 배지를 붙이는 조건과 **동일**(refIds가 빔).
  const extractRows = buildVarRows(scenario).filter(
    (r) => r.kind === "flat-extract" || r.kind === "parallel-extract",
  );
  const unused = extractRows.filter((r) => r.refIds.length === 0);
  const c: TrustCheck =
    extractRows.length === 0
      ? { id: "broken_extract_chain", status: "na", steps: [], count: 0 }
      : {
          id: "broken_extract_chain",
          status: unused.length > 0 ? "fail" : "pass",
          steps: [],
          count: unused.length,
        };

  const checks = [a, b, c];
  const failed = checks.filter((x) => x.status === "fail").length;
  const passed = checks.filter((x) => x.status === "pass").length;
  const applicable = checks.filter((x) => x.status !== "na").length;

  // 증폭 조건은 "검증 **전무**"다 — 부분 검증(9/10)은 그 9개에서 시끄럽게 실패하므로
  // 증폭기가 아니다. `A fail`로 바꾸면 진리표 행 4가 깨진다.
  const noValidationAtAll = https.length > 0 && withAssertCount === 0;

  const level: TrustLevel =
    b.status === "fail" || (noValidationAtAll && c.status === "fail")
      ? "weak"
      : failed > 0
        ? "caution"
        : "good";

  return { level, checks, passed, applicable, failed, noValidationAtAll };
}
```

- [ ] **Step 4: 테스트 통과 확인**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/scenario-preflight/ui && pnpm test trust ; echo "exit=$?"
```

Expected: PASS.

- [ ] **Step 5: 이빨 실증 — 행 2 vs 행 4**

증폭 조건을 일부러 되돌려 **행 4만** RED가 나는지 확인한다. 이 절차 없이 "가드 있음"을 보고하지 말 것.

① `trust.ts`의 `level` 계산에서 `noValidationAtAll`을 `a.status === "fail"`로 바꾼다:

```ts
    b.status === "fail" || (a.status === "fail" && c.status === "fail")   // ← 임시 회귀
```

② 실행:

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/scenario-preflight/ui && pnpm test trust ; echo "exit=$?"
```

Expected: **행 4("검증 부분 + C 실패 = caution")만 FAIL.** 행 1·2·3·5·6·7은 통과해야 한다 — 함께 실패하면 진리표가 이 회귀를 구별하지 못하는 것이니 테스트를 고칠 것.

③ **원복**하고 GREEN 확인.

- [ ] **Step 6: 전체 게이트 + 커밋**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/scenario-preflight/ui && pnpm lint ; echo "lint=$?"
cd /Users/sgj/develop/handicap/.claude/worktrees/scenario-preflight/ui && pnpm test ; echo "test=$?"
cd /Users/sgj/develop/handicap/.claude/worktrees/scenario-preflight/ui && pnpm build ; echo "build=$?"
git add ui/src/scenario/trust.ts ui/src/scenario/__tests__/trust.test.ts
git commit -m "feat(ui): 시나리오 신뢰도 판정 순수 함수 — 2축 증폭 등급 (preflight T2)"
```

---

## Task 3: 실행 지문 + 시나리오별 검증 버킷

**Files:**
- Create: `ui/src/scenario/trustPrefs.ts`
- Create: `ui/src/scenario/__tests__/trustPrefs.test.ts`

**Interfaces:**
- Consumes: `TestRunState`(Task 2) · `hashSeed`(`ui/src/scenario/genVars.ts:79`) · `Scenario`·`Step`
- Produces: `executionFingerprint(scenario: Scenario): string` · `fingerprintHash(scenario: Scenario): number` · `recordVerified(scenarioKey: string, hash: number): void` · `testRunStateFor(scenarioKey: string, scenario: Scenario): TestRunState` · `adoptDraftBucket(newScenarioId: string): void` · `DRAFT_KEY = "__draft__"`

**지문 원칙**: *test-run이 실제로 행사하는 실행 표면만* 담는다. 실행에 영향 없는 것으로 무효화되면 사용자가 이 점검을 무시하게 된다.

- [ ] **Step 1: 실패하는 테스트 작성**

`ui/src/scenario/__tests__/trustPrefs.test.ts`. **Global Constraint 8을 지킨다** — 유니온 사후 변형 없이 빌더 인자만 바꿔 변형을 만든다.

```ts
import { beforeEach, describe, expect, it } from "vitest";
import {
  DRAFT_KEY,
  adoptDraftBucket,
  executionFingerprint,
  fingerprintHash,
  recordVerified,
  testRunStateFor,
} from "../trustPrefs";
import { ScenarioModel, type Scenario } from "../model";

const A = "01HZZZZZZZZZZZZZZZZZZZZZZA";
const B = "01HZZZZZZZZZZZZZZZZZZZZZZB";
const C = "01HZZZZZZZZZZZZZZZZZZZZZZC";

function sc(over: Record<string, unknown> = {}): Scenario {
  return ScenarioModel.parse({
    version: 1,
    name: "t",
    cookie_jar: "auto",
    variables: {},
    steps: [],
    ...over,
  });
}

function step(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: `s-${id.slice(-1)}`,
    type: "http",
    request: { method: "GET", url: "https://e.test/a", headers: { X: "1", A: "2" } },
    assert: [],
    extract: [],
    ...over,
  };
}

/** 기준 시나리오 — 모든 비교의 baseline. */
const base = () => sc({ steps: [step(A)] });

beforeEach(() => {
  window.localStorage.clear();
});

describe("executionFingerprint — 무효화하지 않아야 하는 변경", () => {
  it("시나리오 이름", () => {
    expect(executionFingerprint(sc({ name: "other", steps: [step(A)] }))).toBe(
      executionFingerprint(base()),
    );
  });
  it("공유 메모(notes)", () => {
    expect(executionFingerprint(sc({ notes: "hello", steps: [step(A)] }))).toBe(
      executionFingerprint(base()),
    );
  });
  it("스텝 이름", () => {
    expect(executionFingerprint(sc({ steps: [step(A, { name: "renamed" })] }))).toBe(
      executionFingerprint(base()),
    );
  });
  it("스텝 id", () => {
    expect(executionFingerprint(sc({ steps: [step(B)] }))).toBe(executionFingerprint(base()));
  });
  it("헤더 키 순서 (엔진은 BTreeMap이라 순서 무영향)", () => {
    const swapped = sc({
      steps: [
        step(A, { request: { method: "GET", url: "https://e.test/a", headers: { A: "2", X: "1" } } }),
      ],
    });
    expect(executionFingerprint(swapped)).toBe(executionFingerprint(base()));
  });
  it("중첩 JSON 바디 객체의 키 순서 (정렬은 재귀여야 한다)", () => {
    const mk = (body: unknown) =>
      executionFingerprint(
        sc({
          steps: [
            step(A, {
              request: {
                method: "POST",
                url: "https://e.test/a",
                headers: {},
                body: { kind: "json", value: body },
              },
            }),
          ],
        }),
      );
    expect(mk({ outer: { p: 1, q: 2 } })).toBe(mk({ outer: { q: 2, p: 1 } }));
  });
  it("think time (test-run이 기본으로 행사하지 않는다)", () => {
    expect(
      executionFingerprint(sc({ steps: [step(A, { think_time: { min_ms: 100, max_ms: 200 } })] })),
    ).toBe(executionFingerprint(base()));
  });
  it("disabled (엔진이 절대 읽지 않는다)", () => {
    const d = sc({
      steps: [
        step(A, {
          request: {
            method: "GET",
            url: "https://e.test/a",
            headers: { X: "1", A: "2" },
            disabled: { headers: { Z: "off" } },
          },
        }),
      ],
    });
    expect(executionFingerprint(d)).toBe(executionFingerprint(base()));
  });
});

describe("executionFingerprint — 무효화해야 하는 변경", () => {
  it("URL", () => {
    const u = sc({
      steps: [step(A, { request: { method: "GET", url: "https://e.test/CHANGED", headers: {} } })],
    });
    expect(executionFingerprint(u)).not.toBe(executionFingerprint(base()));
  });
  it("assert 추가", () => {
    expect(
      executionFingerprint(sc({ steps: [step(A, { assert: [{ kind: "status", code: 200 }] })] })),
    ).not.toBe(executionFingerprint(base()));
  });
  it("스텝 순서", () => {
    const ab = sc({ steps: [step(A), step(B, { request: { method: "GET", url: "https://e.test/b", headers: {} } })] });
    const ba = sc({ steps: [step(B, { request: { method: "GET", url: "https://e.test/b", headers: {} } }), step(A)] });
    expect(executionFingerprint(ab)).not.toBe(executionFingerprint(ba));
  });

  /** if 분기 정체성 — **then은 min(1)이라 비울 수 없다**(model.ts:199).
   *  그래서 두 스텝을 준비해 배치만 바꾼다: then=[X,Y]/else=[] vs then=[X]/else=[Y]. */
  const ifScenario = (bothInThen: boolean) => {
    const X = step(B, { request: { method: "GET", url: "https://e.test/x", headers: {} } });
    const Y = step(C, { request: { method: "GET", url: "https://e.test/y", headers: {} } });
    return executionFingerprint(
      sc({
        variables: { v: "1" },
        steps: [
          {
            id: A,
            name: "i",
            type: "if",
            cond: { left: "{{v}}", op: "eq", right: "1" },
            then: bothInThen ? [X, Y] : [X],
            elif: [],
            else: bothInThen ? [] : [Y],
          },
        ],
      }),
    );
  };

  it("if 분기 정체성 — 같은 스텝이 then에 있는지 else에 있는지로 달라진다", () => {
    expect(ifScenario(true)).not.toBe(ifScenario(false));
  });

  it("elif 순서", () => {
    const mk = (swap: boolean) => {
      const e1 = {
        cond: { left: "{{v}}", op: "eq", right: "1" },
        then: [step(B, { request: { method: "GET", url: "https://e.test/x", headers: {} } })],
      };
      const e2 = {
        cond: { left: "{{v}}", op: "eq", right: "2" },
        then: [step(C, { request: { method: "GET", url: "https://e.test/y", headers: {} } })],
      };
      return executionFingerprint(
        sc({
          variables: { v: "1" },
          steps: [
            {
              id: A,
              name: "i",
              type: "if",
              cond: { left: "{{v}}", op: "eq", right: "0" },
              then: [step(B, { request: { method: "GET", url: "https://e.test/t", headers: {} } })],
              elif: swap ? [e2, e1] : [e1, e2],
              else: [],
            },
          ],
        }),
      );
    };
    expect(mk(true)).not.toBe(mk(false));
  });

  it("parallel 분기 이름 (네임스페이스 의미 변경)", () => {
    const mk = (branch: string) =>
      executionFingerprint(
        sc({
          steps: [{ id: A, name: "p", type: "parallel", branches: [{ name: branch, steps: [step(B)] }] }],
        }),
      );
    expect(mk("b1")).not.toBe(mk("b2"));
  });
});

describe("버킷 3상태 + 이관", () => {
  const changed = () =>
    sc({ steps: [step(A, { request: { method: "GET", url: "https://e.test/CHANGED", headers: {} } })] });

  it("기록이 없으면 never", () => {
    expect(testRunStateFor("SC1", base())).toBe("never");
  });

  it("다른 시나리오를 기록해도 이 시나리오는 여전히 never (US4 회귀 가드)", () => {
    recordVerified("SC_OTHER", fingerprintHash(base()));
    expect(testRunStateFor("SC1", base())).toBe("never");
  });

  it("현재 지문이 버킷에 있으면 verified", () => {
    recordVerified("SC1", fingerprintHash(base()));
    expect(testRunStateFor("SC1", base())).toBe("verified");
  });

  it("기록 후 실행 표면이 바뀌면 stale", () => {
    recordVerified("SC1", fingerprintHash(base()));
    expect(testRunStateFor("SC1", changed())).toBe("stale");
  });

  it("스텝 이름만 바꾸면 verified 유지 (US4)", () => {
    recordVerified("SC1", fingerprintHash(base()));
    expect(testRunStateFor("SC1", sc({ steps: [step(A, { name: "renamed" })] }))).toBe("verified");
  });

  it("adoptDraftBucket — 드래프트 기록이 새 id로 이관된다", () => {
    recordVerified(DRAFT_KEY, fingerprintHash(base()));
    adoptDraftBucket("SC_NEW");
    expect(testRunStateFor("SC_NEW", base())).toBe("verified");
    expect(testRunStateFor(DRAFT_KEY, base())).toBe("never");
  });

  it("localStorage가 깨져 있어도 never로 fail-soft", () => {
    window.localStorage.setItem("handicap:trust-testrun:v1", "{not json");
    expect(testRunStateFor("SC1", base())).toBe("never");
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/scenario-preflight/ui && pnpm test trustPrefs ; echo "exit=$?"
```

Expected: FAIL — `Failed to resolve import "../trustPrefs"`.

- [ ] **Step 3: `trustPrefs.ts` 구현**

```ts
import { hashSeed } from "./genVars";
import type { Scenario, Step } from "./model";
import type { TestRunState } from "./trust";

const KEY = "handicap:trust-testrun:v1";
/** 저장 안 된 새 시나리오의 버킷 — 저장 시 `adoptDraftBucket`이 새 id로 옮긴다. */
export const DRAFT_KEY = "__draft__";
const PER_SCENARIO_CAP = 5;
const BUCKET_CAP = 50;

type Buckets = Record<string, number[]>;

// ── 실행 지문 ─────────────────────────────────────────────────────────────
// 원칙: test-run이 실제로 행사하는 실행 표면만 담는다. 레코드/객체형은 키를 정렬한다
// (엔진 headers·serde_json Value::Object 둘 다 BTreeMap이라 키 순서는 실행 무영향).
// 배열형(assert·extract·elif·steps)은 순서가 의미를 가지므로 정렬하지 않는다.

/** 객체 키를 **모든 깊이에서** 정렬한다 — 최상위만 정렬하면 중첩 객체 키 순서 변경이
 *  거짓 `stale`을 만든다. */
function canonJson(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return `[${v.map(canonJson).join(",")}]`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

function canonRecord(rec: Record<string, string> | undefined): string {
  if (!rec) return "{}";
  return `{${Object.keys(rec)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${JSON.stringify(rec[k])}`)
    .join(",")}}`;
}

function canonSteps(steps: ReadonlyArray<Step>): string {
  return `[${steps.map(canonStep).join(",")}]`;
}

function canonStep(s: Step): string {
  if (s.type === "http") {
    const r = s.request;
    const body =
      r.body === undefined
        ? "none"
        : r.body.kind === "form"
          ? `form:${canonRecord(r.body.value)}`
          : r.body.kind === "raw"
            ? `raw:${JSON.stringify(r.body.value)}`
            : `json:${canonJson(r.body.value)}`;
    // 스텝 name·id·think_time·timeout_seconds·request.disabled는 제외(실행 표면 아님).
    return `http(${r.method}|${JSON.stringify(r.url)}|${canonRecord(r.headers)}|${body}|${canonJson(
      s.assert,
    )}|${canonJson(s.extract)})`;
  }
  if (s.type === "loop") return `loop(${s.repeat}|do:${canonSteps(s.do)})`;
  if (s.type === "parallel")
    // 분기 name은 {{분기.변수}} 네임스페이스의 일부라 실행 의미를 바꾼다(ADR-0033).
    return `par(${s.branches
      .map((b) => `${JSON.stringify(b.name)}:${canonSteps(b.steps)}`)
      .join(",")})`;
  // if — then / elif[i].then / else를 **구분해** 직렬화한다. 라벨 없이 자식 목록만
  // 이어 붙이면 then↔else 이동이 지문에 안 잡혀 거짓 verified가 된다.
  return `if(cond:${canonJson(s.cond)}|then:${canonSteps(s.then)}|elif:[${s.elif
    .map((e) => `(cond:${canonJson(e.cond)}|then:${canonSteps(e.then)})`)
    .join(",")}]|else:${canonSteps(s.else)})`;
}

export function executionFingerprint(scenario: Scenario): string {
  // 시나리오 name·notes·default_think_time은 제외(실행 표면 아님 / test-run 미행사).
  return [
    `v${scenario.version}`,
    `jar:${scenario.cookie_jar}`,
    `vars:${canonJson(scenario.variables)}`,
    `steps:${canonSteps(scenario.steps)}`,
  ].join("|");
}

export function fingerprintHash(scenario: Scenario): number {
  return hashSeed(executionFingerprint(scenario));
}

// ── 버킷 (localStorage, fail-soft) ────────────────────────────────────────

function load(): Buckets {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const out: Buckets = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(v)) out[k] = v.filter((n): n is number => typeof n === "number");
    }
    return out;
  } catch {
    return {};
  }
}

function save(b: Buckets): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(b));
  } catch {
    // 프라이빗 모드 등 — 조용히 무시. 기능 저하는 "항상 never"뿐.
  }
}

/** 성공한 test-run의 지문 해시를 기록. LRU 갱신은 **쓰기 시에만**(읽기는 순서 불변). */
export function recordVerified(scenarioKey: string, hash: number): void {
  const b = load();
  const list = (b[scenarioKey] ?? []).filter((h) => h !== hash);
  list.push(hash);
  b[scenarioKey] = list.slice(-PER_SCENARIO_CAP);
  const keys = Object.keys(b);
  if (keys.length > BUCKET_CAP) {
    for (const k of keys.slice(0, keys.length - BUCKET_CAP)) delete b[k];
  }
  save(b);
}

export function testRunStateFor(scenarioKey: string, scenario: Scenario): TestRunState {
  const list = load()[scenarioKey] ?? [];
  if (list.length === 0) return "never";
  return list.includes(fingerprintHash(scenario)) ? "verified" : "stale";
}

/**
 * 저장 성공 시 드래프트 버킷을 새 시나리오 id로 이관한다. 이게 없으면 표준 흐름
 * (작성 → test-run → 저장)에서 내용이 하나도 안 바뀌었는데 `never`로 뒤집힌다.
 * fail-soft: 복사와 삭제를 **한 번의 write로** 수행하고, 실패하면 아무것도 바꾸지 않는다.
 */
export function adoptDraftBucket(newScenarioId: string): void {
  const b = load();
  const draft = b[DRAFT_KEY];
  if (!draft || draft.length === 0) return;
  b[newScenarioId] = draft.slice(-PER_SCENARIO_CAP);
  delete b[DRAFT_KEY];
  save(b);
}
```

- [ ] **Step 4: 테스트 통과 확인**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/scenario-preflight/ui && pnpm test trustPrefs ; echo "exit=$?"
```

Expected: PASS.

- [ ] **Step 5: 이빨 실증 3건**

각각 **회귀 주입 → RED 확인 → 원복 → GREEN 확인**. 하나라도 RED가 안 나면 그 테스트는 공허하니 보고할 것.

① **`disabled` 제외** — `canonStep`의 http 분기 반환 문자열 끝에 `|${canonJson(r.disabled)}`를 끼워 넣는다 → `"disabled (엔진이 절대 읽지 않는다)"`가 FAIL 해야 한다.

② **중첩 JSON 재귀 정렬** — `canonJson`의 객체 분기에서 `.sort()`만 제거한다(헤더는 `canonRecord`가 따로 정렬하므로 헤더 테스트는 통과한 채 남는다) → `"중첩 JSON 바디 객체의 키 순서"`가 FAIL 해야 한다.

③ **if 분기 정체성** — `canonStep`의 if 분기를 **대괄호 없는 평탄 연결**로 되돌린다:

```ts
  return `if(${s.then.map(canonStep).join("")}${s.elif
    .map((e) => e.then.map(canonStep).join(""))
    .join("")}${s.else.map(canonStep).join("")})`;
```

→ `"같은 스텝이 then에 있는지 else에 있는지로 달라진다"`가 FAIL 해야 한다.

> **주의**: `canonSteps(...)`를 그대로 쓰면서 라벨만 지우면 `[X,Y][]`와 `[X][Y]`가 **여전히 달라서 RED가 안 난다**. 반드시 위처럼 `canonSteps`를 **거치지 않는** 평탄 연결이어야 두 경우가 `XY`로 같아진다. (이 실증이 GREEN이면 테스트가 공허한 게 아니라 **변이를 잘못 적용한 것**이다.)

- [ ] **Step 6: 전체 게이트 + 커밋**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/scenario-preflight/ui && pnpm lint ; echo "lint=$?"
cd /Users/sgj/develop/handicap/.claude/worktrees/scenario-preflight/ui && pnpm test ; echo "test=$?"
cd /Users/sgj/develop/handicap/.claude/worktrees/scenario-preflight/ui && pnpm build ; echo "build=$?"
git add ui/src/scenario/trustPrefs.ts ui/src/scenario/__tests__/trustPrefs.test.ts
git commit -m "feat(ui): 실행 지문 + 시나리오별 test-run 검증 버킷 (preflight T3)"
```

---

## Task 4: test-run 성공 기록 + 반응성 에폭 + 드래프트 이관

**Files:**
- Create: `ui/src/components/scenario/__tests__/TestRunSection.trust.test.tsx`
- Modify: `ui/src/scenario/store.ts` (**5개 지점** — 아래 Step 3)
- Modify: `ui/src/components/scenario/TestRunSection.tsx`
- Modify: `ui/src/pages/ScenarioNewPage.tsx`

**Interfaces:**
- Consumes: `recordVerified`·`fingerprintHash`·`adoptDraftBucket`·`DRAFT_KEY`(Task 3)
- Produces: store `testRunEpoch: number` + `bumpTestRunEpoch(): void` (Task 5의 칩이 구독)

**핵심 2가지**:
1. **성공 판정은 HTTP 200이 아니라 trace 내용으로** — `ok === true && truncated === false`. 전 스텝이 connection-refused로 죽은 test-run을 "확인했습니다"로 기록하면 이 에픽이 싸우는 거짓말을 우리가 만든다.
2. **지문은 `fire()` 시점에 스냅샷** — `onSuccess`에서 그때 모델을 해시하면 사용자가 사이에 편집한 *다른 내용*이 `verified`로 기록된다.

- [ ] **Step 1: 실패하는 테스트 작성**

`ui/src/components/scenario/__tests__/TestRunSection.trust.test.tsx`.

**목킹은 기존 `TestRunSection.test.tsx:16-26`의 형태를 그대로 따른다** — 모듈 **전체 교체**(`importOriginal` 금지)이고, 훅 4개를 전부 스텁하며 `reset: vi.fn()`이 **필수**다(`TestRunSection.tsx:59,66`이 `reset()`을 부른다). `useEnvironments`를 빼면 `EnvironmentPicker.tsx:30`이 실제 `useQuery`를 호출해 `QueryClientProvider` 없이 throw한다.

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TestRunSection } from "../TestRunSection";
import { ScenarioModel, type Scenario } from "../../../scenario/model";
import { DRAFT_KEY, testRunStateFor } from "../../../scenario/trustPrefs";
import { useScenarioEditor } from "../../../scenario/store";

const mutate = vi.fn();
vi.mock("../../../api/hooks", () => ({
  useTestRun: () => ({ mutate, isPending: false, error: null, data: undefined, reset: vi.fn() }),
  useTestRunSequential: () => ({
    mutate: vi.fn(),
    isPending: false,
    error: null,
    data: undefined,
    reset: vi.fn(),
  }),
  useEnvironment: () => ({ data: undefined }),
  useEnvironments: () => ({ data: [] }),
}));

const A = "01HZZZZZZZZZZZZZZZZZZZZZZA";

const YAML = `version: 1
name: t
steps:
  - id: ${A}
    name: s-A
    type: http
    request:
      method: GET
      url: https://e.test/a
`;

/** YAML과 동일한 시나리오 — 버킷 조회용 오라클. */
function parsedScenario(): Scenario {
  return ScenarioModel.parse({
    version: 1,
    name: "t",
    cookie_jar: "auto",
    variables: {},
    steps: [
      {
        id: A,
        name: "s-A",
        type: "http",
        request: { method: "GET", url: "https://e.test/a", headers: {} },
        assert: [],
        extract: [],
      },
    ],
  });
}

/** fire() 후 단발 mutate에 넘어간 onSuccess를 꺼낸다. */
async function fireAndGetOnSuccess() {
  // 셀렉터는 기존 TestRunSection.test.tsx:80 과 동일하다.
  await userEvent.click(screen.getByRole("button", { name: /미리 실행/i }));
  const opts = mutate.mock.calls[0][1] as { onSuccess: (t: unknown) => void };
  return opts.onSuccess;
}

beforeEach(() => {
  window.localStorage.clear();
  mutate.mockReset();
});

describe("TestRunSection — 신뢰도 검증 기록", () => {
  it("ok=true·truncated=false면 verified로 기록되고 epoch가 오른다", async () => {
    const before = useScenarioEditor.getState().testRunEpoch;
    render(<TestRunSection yamlText={YAML} />);
    (await fireAndGetOnSuccess())({ ok: true, truncated: false, steps: [] });
    expect(testRunStateFor(DRAFT_KEY, parsedScenario())).toBe("verified");
    expect(useScenarioEditor.getState().testRunEpoch).toBe(before + 1);
  });

  it("ok=false면 기록하지 않는다 (전 스텝이 죽은 test-run)", async () => {
    render(<TestRunSection yamlText={YAML} />);
    (await fireAndGetOnSuccess())({ ok: false, truncated: false, steps: [] });
    expect(testRunStateFor(DRAFT_KEY, parsedScenario())).toBe("never");
  });

  it("truncated=true면 기록하지 않는다", async () => {
    render(<TestRunSection yamlText={YAML} />);
    (await fireAndGetOnSuccess())({ ok: true, truncated: true, steps: [] });
    expect(testRunStateFor(DRAFT_KEY, parsedScenario())).toBe("never");
  });
});
```

> **오라클 전제**: `parsedScenario()`의 지문이 `parseScenarioDoc(YAML).model`의 지문과 **같아야** 이 테스트가 성립한다(다르면 항상 `never`를 본다). 지문은 스텝 `name`·`id`를 제외하고 `headers` 기본값 `{}`를 정렬 직렬화하므로 두 경로가 일치해야 정상이다 — Step 6에서 첫 테스트가 `never`를 보면 여기부터 의심할 것.

- [ ] **Step 2: 테스트가 실패하는지 확인**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/scenario-preflight/ui && pnpm test TestRunSection.trust ; echo "exit=$?"
```

Expected: FAIL — `mutate.mock.calls[0][1]`이 `undefined`(단발 `mutate`에 옵션 인자가 아직 없다) 또는 `testRunEpoch` 미존재.

- [ ] **Step 3: store에 `testRunEpoch` 추가 — 5개 지점**

`renameEpoch`가 나오는 **모든** 자리를 따라간다. **`:116-127`의 `INITIAL`은 "리셋 제외" 목록이 아니라 `Pick<ScenarioEditorState, …>`의 *포함* 목록**이고, `getInitialState()`(`:517-518`)가 이걸 스프레드해 테스트가 리셋에 쓴다. `Pick<>` 유니온에 키를 안 넣고 리터럴에만 넣으면 **TS2353**이다.

① 상태 타입 선언(`:46` `renameEpoch: number;` 옆):

```ts
  testRunEpoch: number;
```

② 액션 타입 선언(다른 액션 시그니처들 옆):

```ts
  bumpTestRunEpoch: () => void;
```

③ `INITIAL`의 `Pick<>` 유니온(`:118`)에 `| "testRunEpoch"` 추가:

```ts
const INITIAL: Pick<
  ScenarioEditorState,
  | "doc" | "model" | "yamlText" | "yamlError" | "selectedStepId" | "pendingYamlText"
  | "renameEpoch" | "testRunEpoch"
> = {
```

④ `INITIAL` 리터럴(`:126` `renameEpoch: 0,` 옆):

```ts
  testRunEpoch: 0,
```

⑤ 스토어 구현부에 액션 추가 + **`actions` 시shim(`:470-515`)에도 등록**한다. 이걸 빠뜨리면 `getInitialState`의 `{ ...INITIAL, ...actions }`가 `ScenarioEditorState`를 만족하지 못해 **TS2741**이다.

```ts
  // 스토어 구현부
  bumpTestRunEpoch: () => set({ testRunEpoch: get().testRunEpoch + 1 }),
```

```ts
  // actions shim (:470-515) 안
    bumpTestRunEpoch: s.bumpTestRunEpoch,
```

- [ ] **Step 4: `TestRunSection`에 기록 배선**

① import 추가:

```tsx
import { useParams } from "react-router-dom";
import { DRAFT_KEY, fingerprintHash, recordVerified } from "../../scenario/trustPrefs";
import { parseScenarioDoc } from "../../scenario/yamlDoc";
```

② 컴포넌트 안(라우터가 없어도 `useParams`는 `{}`를 준다 — `ScenarioNotesCallout.test.tsx:135-138`이 그 안전성을 이미 고정하고 있다):

```tsx
  const { id } = useParams<{ id: string }>();
  const scenarioKey = id ?? DRAFT_KEY;
  const bumpTestRunEpoch = useScenarioEditor((s) => s.bumpTestRunEpoch);
```

③ `fire()` 안, `mutate` 호출 **이전에** 지문을 스냅샷한다:

```tsx
    // 지문은 지금 보내는 내용 기준으로 고정한다 — onSuccess 시점에 다시 계산하면
    // 그 사이 편집한 다른 내용이 verified로 기록된다.
    const snap = parseScenarioDoc(yamlText);
    const snapHash = "model" in snap ? fingerprintHash(snap.model) : null;

    const markVerified = (ok: boolean, truncated: boolean) => {
      // 클라 파싱 실패(snapHash===null)면 기록을 건너뛴다 — 무기록이 거짓 verified보다 안전.
      if (snapHash === null || !ok || truncated) return;
      recordVerified(scenarioKey, snapHash);
      bumpTestRunEpoch();
    };
```

④ 단발 경로 — 현재는 페이로드 객체를 **인라인**해 넘기므로 `const body = { … };`로 먼저 추출한 뒤 **두 번째 인자를 새로 만든다**(현재 옵션 인자가 아예 없다):

```tsx
      testRun.mutate(body, {
        onSuccess: (t) => markVerified(t.ok, t.truncated),
      });
```

⑤ 순차 경로 — **이미 있는 `onSuccess`에 한 줄 추가**한다(기존 `setExpandedRow` 동작을 지우지 말 것):

```tsx
        {
          onSuccess: (s) => {
            setExpandedRow(defaultExpandedRow(s));
            markVerified(s.ok, s.truncated);
          },
        },
```

- [ ] **Step 5: `ScenarioNewPage`에 드래프트 이관 배선**

`:126`의 `navigate(\`/scenarios/${created.id}\`)` **직전에** 이관한다:

```tsx
                onSuccess: (created) => {
                  adoptDraftBucket(created.id);   // ← navigate 이전
                  bypassNext();
                  navigate(`/scenarios/${created.id}`);
                },
```

import: `import { adoptDraftBucket } from "../scenario/trustPrefs";`

- [ ] **Step 6: 테스트 통과 확인 + 오라클 정합 확인**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/scenario-preflight/ui && pnpm test TestRunSection ; echo "exit=$?"
```

Expected: PASS — 신규 3건 + **기존 `TestRunSection` 테스트 전부**. 첫 테스트가 `never`를 본다면 Step 1의 오라클 주의사항②(YAML 파싱 결과와 손으로 만든 시나리오의 지문 불일치)를 확인할 것.

- [ ] **Step 7: 이빨 실증** — `markVerified`의 `!ok || truncated` 가드를 임시로 제거 → `"ok=false면 기록하지 않는다"`와 `"truncated=true면 기록하지 않는다"` 두 건이 FAIL 해야 한다. 원복 후 GREEN 확인.

> `adoptDraftBucket` 호출 자체의 회귀 가드는 **여기서 만들지 않는다**(spec §9.5 #6). 단위 테스트(Task 3)는 함수를 직접 부르므로 호출부 제거를 못 잡고, `ScenarioNewPage` 전체를 띄우는 테스트는 이 슬라이스에 비해 비싸다. **라이브 검증 FR2 행이 이 가드다** — 아래 라이브 표에서 반드시 확인할 것.

- [ ] **Step 8: 전체 게이트 + 커밋**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/scenario-preflight/ui && pnpm lint ; echo "lint=$?"
cd /Users/sgj/develop/handicap/.claude/worktrees/scenario-preflight/ui && pnpm test ; echo "test=$?"
cd /Users/sgj/develop/handicap/.claude/worktrees/scenario-preflight/ui && pnpm build ; echo "build=$?"
git add ui/src/scenario/store.ts ui/src/components/scenario/TestRunSection.tsx ui/src/pages/ScenarioNewPage.tsx ui/src/components/scenario/__tests__/TestRunSection.trust.test.tsx
git commit -m "feat(ui): test-run 성공 시 검증 기록 + 드래프트 버킷 이관 (preflight T4)"
```

---

## Task 5: 모달 + ko 카피 + 에디터 칩

**Files:**
- Create: `ui/src/components/scenario/__tests__/TrustBoard.test.tsx`
- Create: `ui/src/components/scenario/TrustBoard.tsx`
- Create: `ui/src/components/scenario/__tests__/EditorShell.trust.test.tsx`
- Modify: `ui/src/i18n/ko.ts`
- Modify: `ui/src/components/scenario/EditorShell.tsx`

**Interfaces:**
- Consumes: `evaluateTrust`·`isTrustApplicable`·`TrustReport`·`TestRunState`(Task 2) · `testRunStateFor`·`DRAFT_KEY`(Task 3) · store `testRunEpoch`(Task 4)
- Produces: `TrustBoard` prop 계약 — `{ open: boolean; onClose: () => void; report: TrustReport | null; testRun: TestRunState; onSelectStep: (id: string) => void; onOpenVars: () => void }`

> **Step 1이 테스트 파일인 이유**: `ui/src/i18n/ko.ts`도 `tdd-guard`가 보는 production 경로다(`ui/src/.+\.(ts|tsx)$`). Task 4 커밋 직후 트리가 clean이므로 ko를 먼저 건드리면 `exit 2`로 차단된다. 테스트가 아직 없는 `ko.trust.*`를 참조하는 건 문제없다 — `Write`는 타입 체크를 하지 않고, import 단계 RED가 의도된 상태다.

- [ ] **Step 1: 실패하는 모달 테스트 작성**

`ui/src/components/scenario/__tests__/TrustBoard.test.tsx`

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TrustBoard } from "../TrustBoard";
import { ko } from "../../../i18n/ko";
import type { TrustReport } from "../../../scenario/trust";

const GOOD: TrustReport = {
  level: "good",
  checks: [
    { id: "response_validation", status: "pass", steps: [], count: 0 },
    { id: "undefined_vars", status: "pass", steps: [], count: 0 },
    { id: "broken_extract_chain", status: "na", steps: [], count: 0 },
  ],
  passed: 2,
  applicable: 2,
  failed: 0,
  noValidationAtAll: false,
};

const CAUTION: TrustReport = {
  level: "caution",
  checks: [
    { id: "response_validation", status: "fail", steps: [{ id: "S1", name: "로그인" }], count: 0 },
    { id: "undefined_vars", status: "pass", steps: [], count: 0 },
    { id: "broken_extract_chain", status: "fail", steps: [], count: 2 },
  ],
  passed: 1,
  applicable: 3,
  failed: 2,
  noValidationAtAll: false,
};

const noop = () => {};
function board(props: Partial<Parameters<typeof TrustBoard>[0]> = {}) {
  return render(
    <TrustBoard
      open
      report={GOOD}
      testRun="verified"
      onClose={noop}
      onSelectStep={noop}
      onOpenVars={noop}
      {...props}
    />,
  );
}

describe("TrustBoard", () => {
  it("good일 때만 성능 오독 방어 문구가 뜬다", () => {
    const { unmount } = board();
    expect(screen.getByText(ko.trust.boardGoodNote)).toBeInTheDocument();
    unmount();
    board({ report: CAUTION });
    expect(screen.queryByText(ko.trust.boardGoodNote)).not.toBeInTheDocument();
  });

  it("상시 부제는 등급과 무관하게 뜬다", () => {
    board({ report: CAUTION });
    expect(screen.getByText(ko.trust.boardSubtitle)).toBeInTheDocument();
  });

  it("A 실패는 스텝 **이름** 칩을 내고 클릭하면 그 스텝을 선택하며 닫힌다", async () => {
    const onSelectStep = vi.fn();
    const onClose = vi.fn();
    board({ report: CAUTION, onSelectStep, onClose });
    await userEvent.click(screen.getByRole("button", { name: "로그인" }));
    expect(onSelectStep).toHaveBeenCalledWith("S1");
    expect(onClose).toHaveBeenCalled();
  });

  it("C 실패는 스텝 칩 대신 변수 패널 링크를 낸다", () => {
    board({ report: CAUTION });
    expect(screen.getByText(ko.trust.checkCFailTitle(2))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: ko.trust.varsPanelLink })).toBeInTheDocument();
  });

  it("통과 항목은 기본 접힘이고 na를 통과로 세지 않는다", () => {
    board();
    // GOOD은 pass 2 + na 1. 접힘 라벨은 **passed(2)** 여야 한다 (D7).
    expect(screen.getByText(ko.trust.boardPassedFold(2))).toBeInTheDocument();
    expect(screen.queryByText(ko.trust.checkAPass)).not.toBeInTheDocument();
  });

  it("펼치면 통과 항목과 na 항목이 구분돼 보인다", async () => {
    board();
    await userEvent.click(screen.getByText(ko.trust.boardPassedFold(2)));
    expect(screen.getByText(ko.trust.checkAPass)).toBeInTheDocument();
    expect(screen.getByText(ko.trust.naLabel)).toBeInTheDocument();
  });

  it("D 줄은 접힘 없이 상시 렌더되고 세 상태를 구분한다", () => {
    const { unmount } = board({ testRun: "never" });
    expect(screen.getByText(ko.trust.testRunNever)).toBeInTheDocument();
    unmount();
    board({ testRun: "stale" });
    expect(screen.getByText(ko.trust.testRunStale)).toBeInTheDocument();
  });

  it("report=null(보류)이면 등급·점검·D를 렌더하지 않는다", () => {
    board({ report: null });
    expect(screen.getByText(ko.trust.boardGateBlocked)).toBeInTheDocument();
    expect(screen.queryByText(ko.trust.boardSubtitle)).not.toBeInTheDocument();
    expect(screen.queryByText(ko.trust.testRunNever)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: ko `trust` 네임스페이스 추가**

`docs/dev/scenario-preflight-copy.md`의 블록을 `ui/src/i18n/ko.ts`에 **byte-exact로** 붙여 넣는다. 기존 `validity` 네임스페이스는 **손대지 않는다**.

- [ ] **Step 3: 테스트 실패 확인**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/scenario-preflight/ui && pnpm test TrustBoard ; echo "exit=$?"
```

Expected: FAIL — `Failed to resolve import "../TrustBoard"`.

- [ ] **Step 4: `TrustBoard.tsx` 구현**

`ThinkTimeBoard`(`ui/src/components/scenario/ThinkTimeBoard.tsx:151`)와 같은 `Modal` 사용 패턴을 따른다.

```tsx
import { useState } from "react";
import { Modal } from "../Modal";
import { ko } from "../../i18n/ko";
import type { TestRunState, TrustCheck, TrustReport } from "../../scenario/trust";

const FAIL_TITLE: Record<TrustCheck["id"], (n: number) => string> = {
  response_validation: () => ko.trust.checkAFailTitle,
  undefined_vars: () => ko.trust.checkBFailTitle,
  broken_extract_chain: (n) => ko.trust.checkCFailTitle(n),
};
const FAIL_WHY: Record<TrustCheck["id"], string> = {
  response_validation: ko.trust.checkAFailWhy,
  undefined_vars: ko.trust.checkBFailWhy,
  broken_extract_chain: ko.trust.checkCFailWhy,
};
const PASS_TEXT: Record<TrustCheck["id"], string> = {
  response_validation: ko.trust.checkAPass,
  undefined_vars: ko.trust.checkBPass,
  broken_extract_chain: ko.trust.checkCPass,
};
const TEST_RUN_TEXT: Record<TestRunState, string> = {
  never: ko.trust.testRunNever,
  stale: ko.trust.testRunStale,
  verified: ko.trust.testRunVerified,
};

export function TrustBoard({
  open,
  onClose,
  report,
  testRun,
  onSelectStep,
  onOpenVars,
}: {
  open: boolean;
  onClose: () => void;
  /** null = YAML 게이트 보류(spec §7.4) — 등급을 렌더하지 않는다. */
  report: TrustReport | null;
  testRun: TestRunState;
  onSelectStep: (stepId: string) => void;
  onOpenVars: () => void;
}) {
  const [passedOpen, setPassedOpen] = useState(false);

  if (report === null) {
    return (
      <Modal open={open} onClose={onClose} title={ko.trust.boardTitle}>
        <p className="text-sm text-slate-700">{ko.trust.boardGateBlocked}</p>
      </Modal>
    );
  }

  const failed = report.checks.filter((c) => c.status === "fail");
  const rest = report.checks.filter((c) => c.status !== "fail");

  return (
    <Modal open={open} onClose={onClose} title={ko.trust.boardTitle}>
      <div className="flex flex-col gap-3 text-sm">
        <div>
          <p className="font-medium">
            {ko.trust.level[report.level]} ·{" "}
            {ko.trust.boardCount(report.passed, report.applicable)}
          </p>
          <p className="mt-1 text-slate-600">{ko.trust.boardSubtitle}</p>
          {report.level === "good" && (
            <p className="mt-1 text-slate-600">{ko.trust.boardGoodNote}</p>
          )}
        </div>

        <ul className="flex flex-col gap-2">
          {failed.map((c) => (
            <li key={c.id}>
              <p className="font-medium">
                <span aria-hidden="true">✗</span> {FAIL_TITLE[c.id](c.count)}
              </p>
              <p className="text-slate-600">{FAIL_WHY[c.id]}</p>
              {c.id === "response_validation" ? (
                <div className="mt-1 flex flex-wrap gap-1">
                  {c.steps.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      className="rounded border border-slate-300 px-2 py-0.5 text-xs hover:bg-slate-100"
                      onClick={() => {
                        onSelectStep(s.id);
                        onClose();
                      }}
                    >
                      {s.name}
                    </button>
                  ))}
                </div>
              ) : (
                <button
                  type="button"
                  className="mt-1 underline hover:text-slate-900"
                  onClick={() => {
                    onOpenVars();
                    onClose();
                  }}
                >
                  {ko.trust.varsPanelLink}
                </button>
              )}
            </li>
          ))}
        </ul>

        {rest.length > 0 && (
          <div>
            {/* 접힘 라벨은 passed 기준 — na를 "통과"로 세지 않는다(spec D7). */}
            <button
              type="button"
              aria-expanded={passedOpen}
              className="text-left text-slate-600 hover:text-slate-900"
              onClick={() => setPassedOpen((v) => !v)}
            >
              <span aria-hidden="true">{passedOpen ? "▾" : "▸"}</span>{" "}
              {ko.trust.boardPassedFold(report.passed)}
            </button>
            {passedOpen && (
              <ul className="mt-1 flex flex-col gap-1 text-slate-600">
                {rest.map((c) => (
                  <li key={c.id}>{c.status === "na" ? ko.trust.naLabel : PASS_TEXT[c.id]}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* D — 등급 미반영(spec D19). 접지 않는다(D13). */}
        <div className="border-t border-slate-200 pt-2 text-slate-600">
          <p>
            <span aria-hidden="true">○</span> {TEST_RUN_TEXT[testRun]}
          </p>
          <p className="text-xs">{ko.trust.testRunScope}</p>
        </div>
      </div>
    </Modal>
  );
}
```

- [ ] **Step 5: 모달 테스트 통과 확인**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/scenario-preflight/ui && pnpm test TrustBoard ; echo "exit=$?"
```

Expected: PASS.

- [ ] **Step 6: `EditorShell` 칩 테스트 작성**

`ui/src/components/scenario/__tests__/EditorShell.trust.test.tsx`. **렌더 헬퍼는 기존 `EditorShell` 테스트 파일의 것을 그대로 재사용**한다(Provider 유무를 임의로 바꾸지 말 것).

칩 조회는 **`getByRole("button", { name: … })`** 로 한다 — `queryByText(ko.trust.chipLabel)`은 칩이 렌더돼 있어도 `null`을 준다(RTL의 `getNodeText`가 **직계** 텍스트 노드만 잇는데, 칩 안에 `<span>`이 섞여 있다). 접미 확인은 `textContent`로 한다(정규식 escaping 불필요).

```tsx
import { beforeEach, describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { EditorShell } from "../EditorShell";
import { ko } from "../../../i18n/ko";
import { useScenarioEditor } from "../../../scenario/store";
import { DRAFT_KEY, fingerprintHash, recordVerified } from "../../../scenario/trustPrefs";

const A = "01HZZZZZZZZZZZZZZZZZZZZZZA";

const GOOD_YAML = `version: 1
name: t
steps:
  - id: ${A}
    name: s-A
    type: http
    request:
      method: GET
      url: https://e.test/a
    assert:
      - kind: status
        code: 200
`;

const EMPTY_YAML = `version: 1
name: t
steps: []
`;

const chip = () => screen.getByRole("button", { name: /시나리오 신뢰도/ });
const chipOrNull = () => screen.queryByRole("button", { name: /시나리오 신뢰도/ });

beforeEach(() => {
  // 하네스 정본 = ScenarioNotesCallout.test.tsx:36-39 (스토어 리셋 + localStorage.clear).
  // 여기서는 resetEmpty()(STARTER_YAML 로드, steps:[])를 쓴다 — http 스텝 0개라 칩 상태가
  // 새지 않고, 각 테스트의 render가 자기 YAML을 act 안에서 로드한다.
  useScenarioEditor.getState().resetEmpty();
  window.localStorage.clear();
});

describe("EditorShell — 신뢰도 칩", () => {
  it("전 점검 통과 시 양호를 보여 준다", () => {
    render(<EditorShell initialYaml={GOOD_YAML} />);
    expect(chip().textContent).toContain(ko.trust.level.good);
  });

  it("http 스텝이 없으면 칩을 렌더하지 않는다", () => {
    render(<EditorShell initialYaml={EMPTY_YAML} />);
    expect(chipOrNull()).toBeNull();
  });

  it("미검증이면 (미확인) 접미가 붙고, 기록 후 epoch가 오르면 사라진다 — 등급은 그대로", () => {
    render(<EditorShell initialYaml={GOOD_YAML} />);
    expect(chip().textContent).toContain(ko.trust.chipUnverifiedSuffix);
    expect(chip().textContent).toContain(ko.trust.level.good);

    const model = useScenarioEditor.getState().model!;
    act(() => {
      recordVerified(DRAFT_KEY, fingerprintHash(model));
      useScenarioEditor.getState().bumpTestRunEpoch();
    });

    expect(chip().textContent).not.toContain(ko.trust.chipUnverifiedSuffix);
    // D는 등급 미반영 — 접미가 사라져도 등급 문구는 불변이어야 한다.
    expect(chip().textContent).toContain(ko.trust.level.good);
  });
});
```

- [ ] **Step 7: `EditorShell`에 칩·모달 배선**

① import — **`useMemo`가 현재 import 목록(`useEffect, useRef, useState`)에 없다. 추가할 것.**

```tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { TrustBoard } from "./TrustBoard";
import { evaluateTrust, isTrustApplicable } from "../../scenario/trust";
import { DRAFT_KEY, testRunStateFor } from "../../scenario/trustPrefs";
```

② 상태·파생값. **`EditorShell`은 현재 `model`을 selector로 갖고 있지 않다**(`:30`에서 `s.model?.steps`만 뽑는다) — 추가할 것. 단 **`select`는 `:32`에 이미 있다 — 재선언하면 `TS2451 Cannot redeclare block-scoped variable`이다**(아래 블록에 일부러 넣지 않았다):

```tsx
  const [trustOpen, setTrustOpen] = useState(false);
  const { id } = useParams<{ id: string }>();
  const scenarioKey = id ?? DRAFT_KEY;
  const model = useScenarioEditor((s) => s.model);
  const yamlError = useScenarioEditor((s) => s.yamlError);
  const testRunEpoch = useScenarioEditor((s) => s.testRunEpoch);

  // 검사 우선순위(spec §7.4): ① yamlError → 보류 ② model null → 미렌더
  // ③ !isTrustApplicable → 미렌더 ④ 평가. isTrustApplicable을 null 모델에 부르지 않는다.
  const trustPending = yamlError !== null;
  const trustReport = useMemo(
    () => (!trustPending && model && isTrustApplicable(model) ? evaluateTrust(model) : null),
    [trustPending, model],
  );
  const trustTestRun = useMemo(
    () => (model ? testRunStateFor(scenarioKey, model) : "never"),
    // testRunEpoch는 localStorage 재조회 트리거다(값 자체는 안 쓴다).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [model, scenarioKey, testRunEpoch],
  );
  const showTrustChip = trustPending || trustReport !== null;
```

③ 칩 — `⏱ 페이싱` 버튼(`EditorShell.tsx:128-135`) **바로 뒤**에 같은 클래스로 추가:

```tsx
        {showTrustChip &&
          (trustPending ? (
            <button
              type="button"
              aria-label={ko.trust.chipAriaPending}
              onClick={() => setTrustOpen(true)}
              className="rounded border border-slate-300 px-2 py-1 text-sm hover:bg-slate-100"
            >
              <span aria-hidden="true">◈</span> {ko.trust.chipLabel} · {ko.trust.chipPending}
            </button>
          ) : (
            <button
              type="button"
              aria-label={
                trustReport!.level === "good"
                  ? ko.trust.chipAriaGood
                  : ko.trust.chipAria(ko.trust.level[trustReport!.level], trustReport!.failed)
              }
              onClick={() => setTrustOpen(true)}
              className="rounded border border-slate-300 px-2 py-1 text-sm hover:bg-slate-100"
            >
              <span aria-hidden="true">◈</span> {ko.trust.chipLabel} ·{" "}
              <span
                className={
                  trustReport!.level === "weak"
                    ? "text-red-700"
                    : trustReport!.level === "caution"
                      ? "text-amber-700"
                      : undefined
                }
              >
                {ko.trust.level[trustReport!.level]}
                {trustReport!.failed > 0 ? ` ${trustReport!.failed}` : ""}
              </span>
              {/* 보류 상태에서는 접미를 붙이지 않는다(spec §7.4) — 위 분기가 그걸 보장한다. */}
              {trustTestRun !== "verified" && ` ${ko.trust.chipUnverifiedSuffix}`}
            </button>
          ))}
```

④ 모달 마운트 — `<ThinkTimeBoard … />`(`:200`) 옆:

```tsx
      <TrustBoard
        open={trustOpen}
        onClose={() => setTrustOpen(false)}
        report={trustReport}
        testRun={trustTestRun}
        onSelectStep={(sid) => select(sid)}
        onOpenVars={() => setVarsOpen(true)}
      />
```

- [ ] **Step 8: 테스트 통과 확인**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/scenario-preflight/ui && pnpm test EditorShell TrustBoard ; echo "exit=$?"
```

Expected: PASS — 신규 + **기존 `EditorShell` 테스트 전부**(라우터 없이 렌더되는 기존 테스트가 `useParams` 때문에 깨지지 않아야 한다).

- [ ] **Step 9: 이빨 실증 3건**

① **양호 전용 문구** — `TrustBoard`의 `report.level === "good" &&` 가드를 제거해 상시 렌더로 → `"good일 때만 …"`이 FAIL.
② **반응성** — `trustTestRun` `useMemo`의 deps에서 `testRunEpoch` 제거 → `"기록 후 epoch가 오르면 사라진다"`가 FAIL.
③ **na 계수** — `boardPassedFold(report.passed)`를 `boardPassedFold(rest.length)`로 되돌림 → `"통과 항목은 기본 접힘이고 na를 통과로 세지 않는다"`가 FAIL. **이 변이는 2건을 RED로 만든다** — `"펼치면 통과 항목과 na 항목이 구분돼 보인다"`도 같이 실패한다(그 테스트가 fold 버튼을 `boardPassedFold(2)` 텍스트로 찾기 때문). **둘 다 같은 속성의 정당한 가드이므로 정상이다** — ①·②처럼 "1건만 RED"를 기대하지 말 것.
각각 원복 후 GREEN 확인.

- [ ] **Step 10: ko 충돌 대조 + 전체 게이트 + 커밋**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/scenario-preflight
for s in "양호" "보완 필요" "취약" "해당 항목 없음" "미확인" "에디터에서 보기" "변수 패널에서 보기"; do printf '%-18s %s\n' "$s" "$(grep -c "$s" ui/src/i18n/ko.ts)"; done
```

각 값이 **자기 정의 횟수만큼만** 잡혀야 한다(다른 문구에 부분문자열로 섞이지 않음). 그 다음 게이트와 커밋:

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/scenario-preflight/ui && pnpm lint ; echo "lint=$?"
cd /Users/sgj/develop/handicap/.claude/worktrees/scenario-preflight/ui && pnpm test ; echo "test=$?"
cd /Users/sgj/develop/handicap/.claude/worktrees/scenario-preflight/ui && pnpm build ; echo "build=$?"
git add ui/src/i18n/ko.ts ui/src/components/scenario/TrustBoard.tsx ui/src/components/scenario/EditorShell.tsx ui/src/components/scenario/__tests__/TrustBoard.test.tsx ui/src/components/scenario/__tests__/EditorShell.trust.test.tsx
git commit -m "feat(ui): 에디터 신뢰도 칩 + 종합 모달 (preflight T5)"
```

---

## Task 6: RunDialog 한 줄

**Files:**
- Create: `ui/src/components/__tests__/RunDialog.trust.test.tsx`
- Modify: `ui/src/components/RunDialog.tsx`

**Interfaces:**
- Consumes: `evaluateTrust`·`isTrustApplicable`(Task 2) · `ko.trust`(Task 5)
- Produces: 없음(최종 표면)

> **라우터를 쓰지 않는다.** 기존 `ui/src/components/__tests__/RunDialog.test.tsx`의 `renderDialog`(`:51`)는 `QueryClientProvider`만 감싸고 **Router가 없다**(96개 호출 지점). `<Link>`를 넣으면 신뢰도 Callout이 렌더되는 순간 `useHref() may be used only in the context of a <Router>`로 터진다. 그래서 **평범한 `<a href>`** 를 쓴다 — 모달에서 다른 페이지로 나가는 동작이라 전체 내비게이션도 정상이고, 96개 호출 지점을 건드리지 않는다. **후속 리뷰가 이걸 `<Link>`로 "고치지" 말 것.**

- [ ] **Step 1: 실패하는 테스트 작성**

`ui/src/components/__tests__/RunDialog.trust.test.tsx`. 렌더 헬퍼는 기존 파일의 `renderDialog(hasLoop, scenario)` **위치 인자** 형태를 그대로 복제한다.

```tsx
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { RunDialog } from "../RunDialog";
import { ko } from "../../i18n/ko";
import { ScenarioModel, type Scenario } from "../../scenario/model";
import { DRAFT_KEY, fingerprintHash, recordVerified } from "../../scenario/trustPrefs";

const A = "01HZZZZZZZZZZZZZZZZZZZZZZA";

function sc(over: Record<string, unknown> = {}): Scenario {
  return ScenarioModel.parse({
    version: 1,
    name: "t",
    cookie_jar: "auto",
    variables: {},
    steps: [],
    ...over,
  });
}
function step(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: A,
    name: "s-A",
    type: "http",
    request: { method: "GET", url: "https://e.test/a", headers: {} },
    assert: [{ kind: "status", code: 200 }],
    extract: [],
    ...over,
  };
}

function renderDialog(scenario: Scenario | null) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <RunDialog
        scenarioId="S1"
        hasLoop={false}
        scenario={scenario}
        onCreated={vi.fn()}
        onCancel={vi.fn()}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("RunDialog — 신뢰도 한 줄", () => {
  it("양호면 아무것도 렌더하지 않는다", () => {
    renderDialog(sc({ steps: [step()] }));
    expect(screen.queryByText(/시나리오 신뢰도/)).not.toBeInTheDocument();
  });

  it("검증 기록이 있든 없든 렌더 여부가 같다 (FR1 회귀 가드)", () => {
    const good = sc({ steps: [step()] });
    // ① 버킷을 채운 채
    recordVerified(DRAFT_KEY, fingerprintHash(good));
    recordVerified("S1", fingerprintHash(good));
    const { unmount } = renderDialog(good);
    expect(screen.queryByText(/시나리오 신뢰도/)).not.toBeInTheDocument();
    unmount();
    // ② 비운 채
    window.localStorage.clear();
    renderDialog(good);
    expect(screen.queryByText(/시나리오 신뢰도/)).not.toBeInTheDocument();
  });

  it("검증 없는 스텝이 있으면 한 줄 + 에디터 링크", () => {
    renderDialog(sc({ steps: [step({ assert: [] })] }));
    expect(
      screen.getByText(ko.trust.runDialogLine(ko.trust.level.caution, 1)),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: ko.trust.runDialogLink })).toBeInTheDocument();
  });

  it("미정의 변수가 있으면 등급 단어 대신 전멸 예고 문구를 낸다", () => {
    renderDialog(
      sc({
        steps: [step({ request: { method: "GET", url: "https://e.test/{{nope}}", headers: {} } })],
      }),
    );
    expect(screen.getByText(ko.trust.runDialogBFail)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/scenario-preflight/ui && pnpm test RunDialog.trust ; echo "exit=$?"
```

Expected: FAIL — 문구가 없다.

- [ ] **Step 3: `RunDialog`에 한 줄 추가**

① import: `import { evaluateTrust, isTrustApplicable } from "../scenario/trust";` (`useMemo`가 이미 import돼 있는지 확인 — 없으면 추가)

② 파생값(컴포넌트 상단):

```tsx
  // D(test-run 검증)는 여기 관여하지 않는다 — evaluateTrust가 그 상태를 받지 않으므로
  // 지문·localStorage 경로가 이 화면에 아예 없다(spec D19/FR1).
  const trust = useMemo(
    () => (scenario && isTrustApplicable(scenario) ? evaluateTrust(scenario) : null),
    [scenario],
  );
```

③ **삽입 위치**: `blockedReasons` Callout은 IIFE의 반환값이고 그 IIFE는 **`RunDialog.tsx:1035`의 `})()}`** 에서 닫힌다. 신뢰도 줄은 **그 `})()}` 다음 줄**에 넣는다(IIFE 안이 아니다). `blockedReasons`가 먼저 보여야 한다 — 그건 제출을 막는 설정 오류이고 이건 막지 않는 시나리오 품질이다.

```tsx
      {trust && trust.level !== "good" && (
        <Callout variant="warn" role="status" className="mb-3">
          <div className="flex items-center justify-between gap-2">
            <span>
              <span aria-hidden="true">◈</span>{" "}
              {trust.checks.find((c) => c.id === "undefined_vars")?.status === "fail"
                ? ko.trust.runDialogBFail
                : ko.trust.runDialogLine(ko.trust.level[trust.level], trust.failed)}
            </span>
            {/* Router 비의존 — 기존 RunDialog 테스트 96곳에 Router가 없다. <Link> 금지. */}
            <a
              href={`/scenarios/${scenarioId}`}
              className="shrink-0 underline hover:text-amber-900"
            >
              {ko.trust.runDialogLink}
            </a>
          </div>
        </Callout>
      )}
```

- [ ] **Step 4: 테스트 통과 확인**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/scenario-preflight/ui && pnpm test RunDialog ; echo "exit=$?"
```

Expected: PASS — 신규 4건 + **기존 `RunDialog` 테스트 전부**.

- [ ] **Step 5: D 경로 미사용 구조 확인**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/scenario-preflight
grep -n "trustPrefs\|testRunStateFor\|fingerprintHash\|localStorage" ui/src/components/RunDialog.tsx ; echo "exit=$?"
```

Expected: **0매치**(`exit=1`). 하나라도 잡히면 FR1 경로가 되살아난 것이다.

- [ ] **Step 6: 전체 게이트 + 커밋**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/scenario-preflight/ui && pnpm lint ; echo "lint=$?"
cd /Users/sgj/develop/handicap/.claude/worktrees/scenario-preflight/ui && pnpm test ; echo "test=$?"
cd /Users/sgj/develop/handicap/.claude/worktrees/scenario-preflight/ui && pnpm build ; echo "build=$?"
git add ui/src/components/RunDialog.tsx ui/src/components/__tests__/RunDialog.trust.test.tsx
git commit -m "feat(ui): 실행 다이얼로그 신뢰도 한 줄 — B 실패 시 전멸 예고 (preflight T6)"
```

---

## 라이브 검증 (구현 완료 후, `/finish-slice` 이전)

`/live-verify` 스택으로 확인한다. **포트 8080은 피한다** — 다른 프로세스가 점유 중일 수 있으므로 죽이기 전 `ps`로 확인하고, 필요하면 `--rest 127.0.0.1:8099 --grpc 127.0.0.1:8098`로 옮긴다.

**에디터와 RunDialog 두 진입 화면 모두**에서 본다 — `/scenarios/new`만 보면 `/scenarios/{id}`에서만 나는 결함을 놓친다(`editor-wide-view-overflow` 선례).

| # | 확인 |
|---|---|
| US1 | `/scenarios/{id}`·`/scenarios/new` 양쪽 칩 등급 → assert 추가 → 등급 즉시 상승 |
| US2 | 모달 A 스텝 **이름** 칩 클릭 → 해당 스텝 선택(Inspector로 확인) · C 링크 → 변수 패널 열림 |
| US3 | `caution` 시나리오로 RunDialog → 한 줄 / `good` → **미노출** / `blockedReasons`가 **위**에 오는 순서 |
| **FR1 회귀** | **test-run을 한 번도 안 한 `good` 시나리오**에서 RunDialog가 **아무것도 안 띄움** |
| US4 | 새 시나리오 `(미확인)` + 모달을 열어 `never` 확인 → test-run 성공 → **새로고침 없이** 접미 사라짐 → 스텝 **이름만** 변경 → 여전히 `verified` → URL 변경 → 접미 재등장 + **모달을 열어** `stale` 확인 (칩만 보면 `never`/`stale`이 둘 다 `(미확인)`이라 모달을 열어야 구분이 증명된다) |
| **FR2** ⚠ | **이것이 `adoptDraftBucket`의 유일한 회귀 가드다**(단위 테스트로 못 잡음 — Task 4 Step 7 주석). 드래프트에서 test-run → **저장** → 새 id 화면에서 `verified` 유지(접미 없음)를 반드시 확인할 것 |
| US5 | 양호 시나리오에서 모달의 오독 방어 문구 + 칩 `aria-label` 경계 문장 |
| D16 | **존재하지 않는 포트**를 향한 시나리오로 test-run → `verified`로 **기록되지 않음** |
| §7.4 | YAML 모달에서 일부러 문법을 깨서 커밋 → 칩이 `—`(보류)로 바뀌고 `(미확인)` 접미도 안 붙으며, 열면 `YAML 오류를 먼저 해결하세요` |

---

## Self-Review (작성자 체크)

**스펙 커버리지**: §3 데이터 모델→T2 · §4.1~4.3 점검→T2 · §4.4 공유 빌더→T1 · §4.5 D→T3 · §5 등급→T2 · §6.1 지문→T3 · §6.2 버킷·이관→T3+T4 · §6.3 기록 시점·`ok`/`truncated`→T4 · §6.4 반응성→T4+T5 · §7.1 칩→T5 · §7.2 모달·prop 계약→T5 · §7.3 RunDialog→T6 · §7.4 보류→T5 · §8 문구→카피 정본+T5 · §9 테스트→각 task · §10 라이브→위 표.

**타입 일관성**: `TrustReport`/`TrustCheck`(`steps: {id,name}[]`)/`TrustLevel`/`TestRunState`는 T2가 정의하고 T3·T5·T6이 그대로 쓴다. `buildVarRows`/`VarRow`는 T1 정의 → T2 사용. `recordVerified`/`fingerprintHash`/`adoptDraftBucket`/`DRAFT_KEY`/`testRunStateFor`는 T3 정의 → T4·T5·T6(테스트만) 사용. `bumpTestRunEpoch`/`testRunEpoch`는 T4 정의 → T5 사용.

**재량 없음**: 이전 판이 "구현자 재량"으로 남겼던 두 지점을 확정했다 — ① 스텝 칩은 **이름**을 보인다(spec §7.2 목업·US2가 요구, `TrustCheck.steps`가 `{id,name}`을 실어 별도 prop 불필요) ② store 리셋 목록은 **타입이 강제**한다(`INITIAL`이 `Pick<>` 포함 목록이라 `Pick` 유니온과 `actions` shim 둘 다 갱신 필수).

**남은 실행 시 확인 2건**(구현 중 첫 실행에서 즉시 드러남, 재량 아님): T4 Step 1의 실행 버튼 셀렉터(기존 테스트에서 복사)와 YAML-파싱 시나리오 ↔ 손으로 만든 시나리오의 지문 일치(Step 6에서 확인 지시).

<!-- REVIEW-GATE: APPROVED -->
