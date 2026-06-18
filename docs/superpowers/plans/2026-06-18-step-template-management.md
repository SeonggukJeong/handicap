# 스텝 템플릿 관리 페이지 + 삽입 시 변수 파라미터화 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 스텝 템플릿용 `/templates` 관리 페이지(목록/이름·설명 편집/미리보기/삭제) + 삽입 시 `{{var}}`·`${ENV}` 토큰을 토큰별로 유지/재바인딩/리터럴 치환하는 다이얼로그를 추가한다.

**Architecture:** **UI-only**. 백엔드 CRUD·REST·`stepTemplates.ts` 클라·`useStepTemplates/Create/Update/Delete` 훅은 v1에서 이미 완비 — 이 슬라이스는 (A) 순수 함수 모듈 + 그 소비처(에디터 삽입 흐름), (B) `EnvironmentsPage` 미러 페이지를 가산만 한다. 엔진·워커·proto·controller·migration 무변경. spec: `docs/superpowers/specs/2026-06-18-step-template-management-design.md` (요구사항 R1–R15).

**Tech Stack:** React + TypeScript + Zustand + React Query + `yaml`(Document API, `visit`) + Zod + vitest/RTL + Tailwind. i18n는 `ko.ts` 카탈로그.

## Global Constraints

- **UI-only, 가산.** 엔진·워커·proto·controller·migration·백엔드 라우트·`StepTemplateBody`/`stepTemplates.ts`·기존 훅 **무변경**. 머지 diff = `ui/`(+docs)만.
- **byte-identical 불변식**: 무토큰 템플릿 삽입(R10)·전부-유지(identity) 파라미터화(R12)는 현재 v1 삽입과 동일 fragment.
- **예약 시스템 변수**(`vu_id`/`iter_id`/`loop_index`)는 env 토큰 스캔/파라미터화에서 **제외**(엔진 `template.rs` 시스템 값, `EnvironmentsPage.RESERVED` 의미론).
- **신규 사용자노출 문구는 전부 `ko.ts` 경유**(ADR-0035), 변수 든 문구는 `(으)로`/`(은)는` 병기형. 새 페이지 키는 **`stepTemplates` 접두**(`ko.nav.stepTemplates`/`ko.pages.stepTemplates*`/`ko.empty.stepTemplates*`) — 기존 `ko.templates`(시나리오 시작 갤러리)와 혼동 금지.
- **`/templates`는 top-level peer라 breadcrumb 없음**(Environments/Datasets/Schedules/Settings 동일). `Breadcrumb.tsx`는 시나리오 하위페이지 전용.
- **중첩 Modal 금지**(ESC 레이어링 함정, `ui/CLAUDE.md`) — 파라미터화는 `InsertTemplateModal`의 2-phase(내용 교체).
- **게이트**: 각 task 끝 `pnpm test <file>` green + 머지 전 전체 `pnpm lint && pnpm test && pnpm build`(부분 필터 green ≠ 전체 green; `tsc -b`만 잡는 타입 누출 클래스).
- **테스트 위치**: `ui/src/**/__tests__/**/*.test.{ts,tsx}`만 vitest가 수집. `import type`의 상대경로 깊이는 형제 테스트 기준(`__tests__/`는 production보다 한 단계 깊음).

---

## File Structure

| 파일 | 책임 | task |
|---|---|---|
| `ui/src/scenario/templateParams.ts` (신규) | 순수: `scanTemplateTokens`(Document visit) + `applyTokenSubstitutions`(Document scalar 치환) + 타입 | 1 |
| `ui/src/scenario/__tests__/templateParams.test.ts` (신규) | 위 단위테스트(identity·rename·literal·env-default·예약제외·비-ULID·주석보존) | 1 |
| `ui/src/scenario/scanVars.ts` (수정) | `scanEnvVars(scenario)` 가산(datalist 힌트 — flow 미러, env 정규식, 예약 제외) | 2 |
| `ui/src/components/scenario/InsertTemplateModal.tsx` (수정) | 2-phase: 목록 → (토큰 있으면) 파라미터 폼 → 치환 후 삽입 | 2 |
| `ui/src/i18n/ko.ts` (수정) | `ko.stepTemplates`에 파라미터화 문구 + 페이지(nav/pages/empty) 문구 가산 | 2,3 |
| `ui/src/pages/TemplatesPage.tsx` (신규) | `EnvironmentsPage` 미러: 목록/편집(이름·설명)/미리보기/삭제, **생성 없음** | 3 |
| `ui/src/api/hooks.ts` (수정) | `queryKeys.stepTemplate(id)` 싱글톤 추가(imperative edit fetch용) | 3 |
| `ui/src/routes.tsx` · `ui/src/components/Layout.tsx` (수정) | `/templates` 라우트 + 네비 링크 | 3 |
| `ui/src/pages/__tests__/TemplatesPage.test.tsx`, `ui/src/components/scenario/__tests__/InsertTemplateModal.test.tsx`(수정) | RTL | 2,3 |

---

## Task 1: 순수 `templateParams.ts` — 토큰 스캔 + 치환 (R8, R11, R12)

**Files:**
- Create: `ui/src/scenario/templateParams.ts`
- Test: `ui/src/scenario/__tests__/templateParams.test.ts`

**Interfaces:**
- Consumes: `yaml` 패키지(`parseDocument`, `visit`, `isScalar`), `Document` 타입.
- Produces (Task 2가 사용):
  - `type Substitution = { kind: "keep" } | { kind: "rename"; to: string } | { kind: "literal"; value: string }`
  - `interface SubMap { flow: Record<string, Substitution>; env: Record<string, Substitution> }`
  - `function scanTemplateTokens(stepsYaml: string): { flow: string[]; env: string[] }`
  - `function applyTokenSubstitutions(stepsYaml: string, subs: SubMap): string`

- [ ] **Step 1: Write the failing tests**

Create `ui/src/scenario/__tests__/templateParams.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  scanTemplateTokens,
  applyTokenSubstitutions,
  type SubMap,
} from "../templateParams";

// http step fragment with flow + env tokens, incl. an env default and a reserved system var.
const FRAG = [
  "- id: 01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "  name: login",
  "  type: http",
  "  request:",
  "    method: POST",
  '    url: "${BASE_URL}/login?u={{user}}&trace=${vu_id}"',
  "    headers:",
  '      Authorization: "Bearer {{token}}"',
  '      X-Host: "${API_HOST:-https://fallback}"',
  "",
].join("\n");

const keepAll = (): SubMap => ({ flow: {}, env: {} });

describe("scanTemplateTokens", () => {
  it("collects flow and env tokens, dedups, drops reserved system vars", () => {
    const { flow, env } = scanTemplateTokens(FRAG);
    expect(flow).toEqual(["user", "token"]);
    // ${vu_id} excluded (reserved); ${API_HOST:-...} captures name only.
    expect(env).toEqual(["BASE_URL", "API_HOST"]);
  });

  it("scans templates whose step id is NOT a valid ULID (backend doesn't validate)", () => {
    const wild = '- id: not-a-ulid\n  name: x\n  type: http\n  request:\n    method: GET\n    url: "{{q}}"\n';
    expect(scanTemplateTokens(wild).flow).toEqual(["q"]);
  });

  it("returns empty for a fragment with no tokens", () => {
    const plain = "- id: A\n  name: x\n  type: http\n  request:\n    method: GET\n    url: /x\n";
    expect(scanTemplateTokens(plain)).toEqual({ flow: [], env: [] });
  });
});

describe("applyTokenSubstitutions", () => {
  it("identity (all keep) returns the input string byte-identical", () => {
    expect(applyTokenSubstitutions(FRAG, keepAll())).toBe(FRAG);
  });

  it("renames a flow token, preserving the {{ }} wrapper", () => {
    const out = applyTokenSubstitutions(FRAG, {
      flow: { token: { kind: "rename", to: "authToken" } },
      env: {},
    });
    expect(out).toContain("{{authToken}}");
    expect(out).not.toContain("{{token}}");
    expect(out).toContain("{{user}}"); // untouched
  });

  it("substitutes a flow token with a literal (drops the braces)", () => {
    const out = applyTokenSubstitutions(FRAG, {
      flow: { user: { kind: "literal", value: "alice" } },
      env: {},
    });
    expect(out).toContain("u=alice");
    expect(out).not.toContain("{{user}}");
  });

  it("renames an env token and preserves its :- default", () => {
    const out = applyTokenSubstitutions(FRAG, {
      flow: {},
      env: { API_HOST: { kind: "rename", to: "HOST2" } },
    });
    expect(out).toContain("${HOST2:-https://fallback}");
  });

  it("preserves comments on sibling lines", () => {
    const withComment = "# leading\n- id: A # trailing\n  name: x\n  type: http\n  request:\n    method: GET\n    url: \"{{q}}\"\n";
    const out = applyTokenSubstitutions(withComment, {
      flow: { q: { kind: "rename", to: "qq" } },
      env: {},
    });
    expect(out).toContain("# trailing");
    expect(out).toContain("{{qq}}");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ui && pnpm test templateParams`
Expected: FAIL — "Cannot find module '../templateParams'".

- [ ] **Step 3: Write the implementation**

Create `ui/src/scenario/templateParams.ts`:

```ts
/**
 * 스텝 템플릿 삽입 시 토큰 파라미터화 — 순수 함수.
 * scanTemplateTokens: 템플릿 fragment의 {{flow}}·${ENV} 토큰을 두 네임스페이스로 스캔.
 * applyTokenSubstitutions: 토큰별 치환(유지/이름변경/리터럴)을 YAML Document 스칼라에 적용.
 *
 * 왜 Document visit인가(spec R8): parseStepsFragment는 StepModel.id의 ULID regex를
 * 강제하지만 백엔드는 step-id ULID를 검증 안 함(api/step_templates.rs) → 비-ULID id
 * 템플릿도 스캔/치환 가능해야 한다. Document 스칼라만 방문하면 Zod 게이트를 우회하고
 * 주석/구조도 보존한다(reissueStepIdsInFragment와 동형).
 */
import { parseDocument, visit, isScalar } from "yaml";

export type Substitution =
  | { kind: "keep" }
  | { kind: "rename"; to: string }
  | { kind: "literal"; value: string };

export interface SubMap {
  flow: Record<string, Substitution>;
  env: Record<string, Substitution>;
}

// {{ name }} — scanVars.ts FLOW_VAR_RE와 동일.
const FLOW_RE = /\{\{\s*([^}]+?)\s*\}\}/g;
// ${ NAME } 또는 ${ NAME:-default } — group1=이름, group2=":-default"(옵션).
// 이름은 ':' 금지(엔진 :-default 구분자 보수 가드, template.rs). `${a:b}`(bare colon)는
// 매칭 안 함 → 스캔 누락 = identity 유지(안전 방향, spec §4.1 의도적 엣지).
const ENV_RE = /\$\{\s*([^}:]+?)\s*(:-[^}]*)?\}/g;

// 엔진이 런타임 시스템 값으로 해석 — 파라미터화 대상 아님(EnvironmentsPage.RESERVED 동일).
const RESERVED = new Set(["vu_id", "iter_id", "loop_index"]);

export function scanTemplateTokens(stepsYaml: string): { flow: string[]; env: string[] } {
  const flow: string[] = [];
  const env: string[] = [];
  const flowSeen = new Set<string>();
  const envSeen = new Set<string>();
  let doc;
  try {
    doc = parseDocument(stepsYaml);
  } catch {
    return { flow, env };
  }
  if (doc.errors.length > 0) return { flow, env };
  visit(doc, {
    Scalar(_key, node) {
      if (typeof node.value !== "string") return;
      const s = node.value;
      for (const m of s.matchAll(FLOW_RE)) {
        const name = m[1];
        if (!flowSeen.has(name)) {
          flowSeen.add(name);
          flow.push(name);
        }
      }
      for (const m of s.matchAll(ENV_RE)) {
        const name = m[1];
        if (RESERVED.has(name) || envSeen.has(name)) continue;
        envSeen.add(name);
        env.push(name);
      }
    },
  });
  return { flow, env };
}

function isIdentity(subs: SubMap): boolean {
  const all = [...Object.values(subs.flow), ...Object.values(subs.env)];
  return all.every((s) => s.kind === "keep");
}

function rewrite(s: string, subs: SubMap): string {
  let out = s.replace(FLOW_RE, (full, name: string) => {
    const sub = subs.flow[name];
    if (!sub || sub.kind === "keep") return full;
    if (sub.kind === "rename") return `{{${sub.to}}}`;
    return sub.value; // literal — braces dropped
  });
  out = out.replace(ENV_RE, (full, name: string, def?: string) => {
    const sub = subs.env[name];
    if (!sub || sub.kind === "keep") return full;
    if (sub.kind === "rename") return `\${${sub.to}${def ?? ""}}`; // :- default preserved
    return sub.value; // literal — whole ${...} replaced
  });
  return out;
}

export function applyTokenSubstitutions(stepsYaml: string, subs: SubMap): string {
  // R12: identity = no-op, return input byte-identical (skip parse/reserialize so we
  // never normalize quoting/indentation when nothing changed).
  if (isIdentity(subs)) return stepsYaml;
  let doc;
  try {
    doc = parseDocument(stepsYaml);
  } catch {
    return stepsYaml;
  }
  if (doc.errors.length > 0) return stepsYaml;
  visit(doc, {
    Scalar(_key, node) {
      if (isScalar(node) && typeof node.value === "string") {
        node.value = rewrite(node.value, subs);
      }
    },
  });
  return String(doc);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ui && pnpm test templateParams`
Expected: PASS (all describe blocks green). If the comment-preservation test fails because `String(doc)` re-quotes, that is acceptable only if `# trailing` survives — adjust the assertion to the actual emitted form, but the token rewrite assertions MUST pass.

- [ ] **Step 5: Commit**

```bash
git add ui/src/scenario/templateParams.ts ui/src/scenario/__tests__/templateParams.test.ts
git commit -m "feat(ui): pure template-token scan + substitution helpers (R8,R11,R12)"
```

---

## Task 2: `InsertTemplateModal` 2-phase 파라미터화 + `scanEnvVars` + ko 문구 (R9, R10, R13, R14, R15)

**Files:**
- Modify: `ui/src/scenario/scanVars.ts` (add `scanEnvVars`)
- Modify: `ui/src/components/scenario/InsertTemplateModal.tsx`
- Modify: `ui/src/i18n/ko.ts` (add `ko.stepTemplates` parameterization keys)
- Modify/Test: `ui/src/components/scenario/__tests__/InsertTemplateModal.test.tsx`
- Test: `ui/src/scenario/__tests__/scanVars.test.ts` (add `scanEnvVars` cases — create if absent)

**Interfaces:**
- Consumes: `scanTemplateTokens`/`applyTokenSubstitutions`/`SubMap`/`Substitution` (Task 1); existing `getStepTemplate`, `prepareTemplateInsertion`, `newStepId`, `useScenarioEditor` (`insertTemplateSteps`, `select`, `model`).
- Produces: `scanEnvVars(scenario: Scenario): Set<string>` from `scanVars.ts`.

- [ ] **Step 1: Write the failing test for `scanEnvVars`**

**The file `ui/src/scenario/__tests__/scanVars.test.ts` already exists** (it imports `describe/it/expect` from `vitest` and `ScenarioModel` from `../model`). **Do NOT paste the imports below** — add `scanEnvVars` to the existing `import { ... } from "../scanVars"` line and **append only the new `describe("scanEnvVars", …)` block**. (The `import` lines shown here are context only — they are already present.)

```ts
// (already present at top of file — context only, do not duplicate)
import { describe, it, expect } from "vitest";
import { scanEnvVars } from "../scanVars"; // add scanEnvVars to the existing import
import { ScenarioModel } from "../model";

const scen = ScenarioModel.parse({
  version: 1,
  name: "t",
  steps: [
    {
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      name: "s",
      type: "http",
      request: { method: "GET", url: "${BASE_URL}/x?t=${vu_id}", headers: { H: "${API_HOST}" } },
    },
  ],
});

describe("scanEnvVars", () => {
  it("collects ${ENV} names from http request fields, excluding reserved system vars", () => {
    expect([...scanEnvVars(scen)].sort()).toEqual(["API_HOST", "BASE_URL"]);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd ui && pnpm test scanVars`
Expected: FAIL — `scanEnvVars` not exported.

- [ ] **Step 3: Implement `scanEnvVars`**

Add to `ui/src/scenario/scanVars.ts` (mirrors `scanFlowVars` traversal; env regex + reserved exclusion — same pattern as `templateParams.ENV_RE`):

```ts
// ${ NAME } / ${ NAME:-default } — name only (mirrors templateParams.ENV_RE, datalist 힌트용).
const ENV_VAR_RE = /\$\{\s*([^}:]+?)\s*(?::-[^}]*)?\}/g;
const ENV_RESERVED = new Set(["vu_id", "iter_id", "loop_index"]);

function collectEnvFromString(s: string, out: Set<string>): void {
  for (const m of s.matchAll(ENV_VAR_RE)) {
    if (!ENV_RESERVED.has(m[1])) out.add(m[1]);
  }
}

function collectEnvFromJson(value: unknown, out: Set<string>): void {
  if (typeof value === "string") collectEnvFromString(value, out);
  else if (Array.isArray(value)) for (const v of value) collectEnvFromJson(v, out);
  else if (value && typeof value === "object")
    for (const v of Object.values(value)) collectEnvFromJson(v, out);
}

/** 시나리오가 참조하는 `${ENV}` 변수명(예약 시스템 변수 제외) — InsertTemplateModal
 *  파라미터화 datalist 힌트용. scanFlowVars의 env 대응(같은 http-leaf request 필드 스캔). */
export function scanEnvVars(scenario: Scenario): Set<string> {
  const out = new Set<string>();
  for (const step of flattenHttpSteps(scenario.steps)) {
    collectEnvFromString(step.request.url, out);
    for (const v of Object.values(step.request.headers)) collectEnvFromString(v, out);
    const body = step.request.body;
    if (body?.kind === "raw") collectEnvFromString(body.value, out);
    else if (body?.kind === "form") for (const v of Object.values(body.value)) collectEnvFromString(v, out);
    else if (body?.kind === "json") collectEnvFromJson(body.value, out);
  }
  return out;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd ui && pnpm test scanVars`
Expected: PASS.

- [ ] **Step 5: Add parameterization strings to `ko.ts`**

In `ui/src/i18n/ko.ts`, extend the existing `ko.stepTemplates` object (after the insert-modal block, ~line 269) with:

```ts
    // ── 삽입 시 파라미터화 ──
    paramTitle: "변수 조정 후 삽입",
    paramIntro: "이 템플릿의 변수를 대상 시나리오에 맞게 조정할 수 있습니다. 기본값은 모두 그대로 유지입니다.",
    flowSection: "흐름 변수 {{ }}",
    envSection: "환경 변수 ${ }",
    optKeep: "그대로 유지",
    optRename: "다른 이름으로",
    optLiteral: "값으로 교체",
    renamePlaceholder: "새 변수명",
    literalPlaceholder: "리터럴 값",
    renameHintLabel: "대상 시나리오의 기존 변수",
    badRename: "변수명에 공백/중괄호/콜론을 쓸 수 없습니다",
    confirmInsert: "삽입",
    back: "뒤로",
```

- [ ] **Step 6: Write the failing RTL tests for the modal**

In `ui/src/components/scenario/__tests__/InsertTemplateModal.test.tsx` add (keep existing tests; they cover no-token list/delete which must still pass = R10 regression):

```tsx
// Helper: render the modal with a QueryClient and a seeded scenario in the store.
// Mock the network: useStepTemplates list + getStepTemplate detail.
// (Follow the existing test file's setup for QueryClientProvider + store reset.)

it("opens the parameterization form when the chosen template has tokens (R9/R14)", async () => {
  // Arrange: list returns a template; getStepTemplate returns steps_yaml with {{token}} + ${BASE_URL}.
  // Act: click that template's 삽입 button.
  // Assert: single modal swaps to params phase — flowSection + envSection headings present,
  //         a row for "token" and "BASE_URL", each defaulting to the 그대로 유지 radio (checked),
  //         no row for any reserved var. insertTemplateSteps NOT yet called.
});

it("inserts directly with no params form when the template has no tokens (R10)", async () => {
  // template steps_yaml has no {{}}/${} → clicking 삽입 calls insertTemplateSteps immediately,
  // params headings never appear.
});

it("disables 삽입 when a rename target is invalid (R13)", async () => {
  // In params phase, pick 다른 이름으로 for a flow token, type "bad name" (space) →
  // confirm button disabled + badRename warning shown.
});

it("applies a literal substitution into the inserted steps (R9/R11)", async () => {
  // pick 값으로 교체 for {{token}}, type "XYZ", confirm → insertTemplateSteps called with
  // preparedYaml containing "XYZ" and not "{{token}}".
});
```

Fill each test body following the existing file's render/mariner patterns (QueryClientProvider, `vi.mock("../../api/stepTemplates")` for `getStepTemplate`, `useScenarioEditor.setState(getInitialState())` reset, `userEvent.setup()` per test). Assert on `insertTemplateSteps` via a `vi.spyOn(useScenarioEditor.getState(), ...)` or by mocking the store action — mirror how existing InsertTemplateModal tests observe insertion.

- [ ] **Step 7: Run to verify fail**

Run: `cd ui && pnpm test InsertTemplateModal`
Expected: FAIL — params phase / direct-insert behavior not implemented.

- [ ] **Step 8: Rewrite `InsertTemplateModal.tsx` with the 2-phase flow**

Replace the component with the version below (keeps list+delete; adds `phase` state + params form; **single `<Modal>`**, content swaps — no nested Modal, R14):

```tsx
/**
 * InsertTemplateModal — 저장된 스텝 템플릿 목록에서 선택해 현재 시나리오에 삽입.
 * 2-phase 단일 Modal: 목록 → (토큰 있으면) 파라미터화 폼 → 치환 후 삽입.
 * 부모가 `{open && <InsertTemplateModal onClose={...} />}` 로 조건부 마운트.
 */
import { useMemo, useState } from "react";
import { useDeleteStepTemplate, useStepTemplates } from "../../api/hooks";
import { getStepTemplate } from "../../api/stepTemplates";
import { Button } from "../Button";
import { Modal } from "../Modal";
import { ko } from "../../i18n/ko";
import { useScenarioEditor } from "../../scenario/store";
import { newStepId } from "../../scenario/ulid";
import { prepareTemplateInsertion } from "../../scenario/yamlDoc";
import { scanFlowVars, scanEnvVars } from "../../scenario/scanVars";
import {
  scanTemplateTokens,
  applyTokenSubstitutions,
  type Substitution,
  type SubMap,
} from "../../scenario/templateParams";

interface Props {
  onClose: () => void;
}

type Pending = { id: string; stepsYaml: string; flow: string[]; env: string[] };

// flow: 공백/중괄호 금지; env: 추가로 콜론 금지(${} 안전).
function badRename(ns: "flow" | "env", to: string): boolean {
  if (to.trim() === "") return true;
  if (/[{}\s]/.test(to)) return true;
  if (ns === "env" && to.includes(":")) return true;
  return false;
}

export function InsertTemplateModal({ onClose }: Props) {
  const list = useStepTemplates();
  const del = useDeleteStepTemplate();
  const insertTemplateSteps = useScenarioEditor((s) => s.insertTemplateSteps);
  const select = useScenarioEditor((s) => s.select);
  const model = useScenarioEditor((s) => s.model);

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  // per-token form state, keyed by `${ns}:${name}`.
  const [subs, setSubs] = useState<Record<string, Substitution>>({});

  const templates = list.data ?? [];

  // datalist 힌트: 대상 시나리오의 기존 변수명(best-effort, model null이면 빈 목록).
  const flowHints = useMemo(() => (model ? [...scanFlowVars(model), ...Object.keys(model.variables)] : []), [model]);
  const envHints = useMemo(() => (model ? [...scanEnvVars(model)] : []), [model]);

  const doInsert = (stepsYaml: string) => {
    const prep = prepareTemplateInsertion(stepsYaml, newStepId);
    if (!prep.ok) {
      setError(`${ko.stepTemplates.incompatible}: ${prep.error}`);
      return false;
    }
    const firstId = insertTemplateSteps({ preparedYaml: prep.preparedYaml, firstId: prep.firstId });
    select(firstId);
    return true;
  };

  const handleInsert = async (id: string) => {
    setError(null);
    setBusy(true);
    try {
      const tpl = await getStepTemplate(id);
      const { flow, env } = scanTemplateTokens(tpl.steps_yaml);
      if (flow.length === 0 && env.length === 0) {
        if (doInsert(tpl.steps_yaml)) onClose(); // R10: no-token → direct insert
        return;
      }
      setSubs({});
      setPending({ id, stepsYaml: tpl.steps_yaml, flow, env });
    } catch (e) {
      setError((e as Error).message);
      void list.refetch();
    } finally {
      setBusy(false);
    }
  };

  const key = (ns: "flow" | "env", name: string) => `${ns}:${name}`;
  const subOf = (ns: "flow" | "env", name: string): Substitution => subs[key(ns, name)] ?? { kind: "keep" };
  const setSub = (ns: "flow" | "env", name: string, s: Substitution) =>
    setSubs((prev) => ({ ...prev, [key(ns, name)]: s }));

  const hasBadRename =
    pending !== null &&
    (["flow", "env"] as const).some((ns) =>
      (ns === "flow" ? pending.flow : pending.env).some((name) => {
        const s = subOf(ns, name);
        return s.kind === "rename" && badRename(ns, s.to);
      }),
    );

  const buildSubMap = (): SubMap => {
    const out: SubMap = { flow: {}, env: {} };
    for (const [k, s] of Object.entries(subs)) {
      const [ns, ...rest] = k.split(":");
      const name = rest.join(":");
      if (ns === "flow") out.flow[name] = s;
      else if (ns === "env") out.env[name] = s;
    }
    return out;
  };

  const handleConfirmParams = () => {
    if (!pending || hasBadRename) return;
    setError(null);
    const substituted = applyTokenSubstitutions(pending.stepsYaml, buildSubMap());
    if (doInsert(substituted)) onClose();
  };

  const handleDelete = (id: string, name: string) => {
    if (!window.confirm(ko.stepTemplates.deleteConfirm(name))) return;
    del.mutate(id);
  };

  return (
    <Modal open title={pending ? ko.stepTemplates.paramTitle : ko.stepTemplates.insertTitle} onClose={onClose}>
      <div className="flex flex-col gap-4">
        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}

        {pending ? (
          <ParamForm
            pending={pending}
            subOf={subOf}
            setSub={setSub}
            flowHints={flowHints}
            envHints={envHints}
            badRename={badRename}
          />
        ) : (
          <TemplateList
            list={list}
            templates={templates}
            del={del}
            busy={busy}
            onInsert={handleInsert}
            onDelete={handleDelete}
          />
        )}

        <div className="flex justify-end gap-2">
          {pending ? (
            <>
              <Button variant="secondary" onClick={() => setPending(null)}>
                {ko.stepTemplates.back}
              </Button>
              <Button onClick={handleConfirmParams} disabled={hasBadRename}>
                {ko.stepTemplates.confirmInsert}
              </Button>
            </>
          ) : (
            <Button variant="secondary" onClick={onClose}>
              {ko.stepTemplates.cancel}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
```

Then add the two presentational sub-components **in the same file** (below the export). `TemplateList` is the current list/delete JSX moved verbatim out of the old body (lines ~62–117 of the original, minus the outer Modal/cancel). `ParamForm`:

```tsx
function ParamForm({
  pending,
  subOf,
  setSub,
  flowHints,
  envHints,
  badRename,
}: {
  pending: Pending;
  subOf: (ns: "flow" | "env", name: string) => Substitution;
  setSub: (ns: "flow" | "env", name: string, s: Substitution) => void;
  flowHints: string[];
  envHints: string[];
  badRename: (ns: "flow" | "env", to: string) => boolean;
}) {
  const section = (ns: "flow" | "env", names: string[], title: string, hints: string[]) =>
    names.length === 0 ? null : (
      <fieldset className="min-w-0">
        <legend className="mb-2 text-sm font-medium">{title}</legend>
        <ul className="flex flex-col gap-3">
          {names.map((name) => {
            const s = subOf(ns, name);
            const listId = `tplvar-${ns}-${name}`;
            return (
              <li key={`${ns}:${name}`} className="flex flex-col gap-1">
                <code className="text-sm">{ns === "flow" ? `{{${name}}}` : `\${${name}}`}</code>
                <div className="flex flex-wrap items-center gap-3 text-sm">
                  <label className="flex items-center gap-1">
                    <input type="radio" checked={s.kind === "keep"} onChange={() => setSub(ns, name, { kind: "keep" })} />
                    {ko.stepTemplates.optKeep}
                  </label>
                  <label className="flex items-center gap-1">
                    <input
                      type="radio"
                      checked={s.kind === "rename"}
                      onChange={() => setSub(ns, name, { kind: "rename", to: "" })}
                    />
                    {ko.stepTemplates.optRename}
                  </label>
                  <label className="flex items-center gap-1">
                    <input
                      type="radio"
                      checked={s.kind === "literal"}
                      onChange={() => setSub(ns, name, { kind: "literal", value: "" })}
                    />
                    {ko.stepTemplates.optLiteral}
                  </label>
                </div>
                {s.kind === "rename" && (
                  <>
                    <input
                      aria-label={`rename ${name}`}
                      list={listId}
                      className="w-56 rounded border border-slate-300 px-2 py-1 text-sm font-mono"
                      placeholder={ko.stepTemplates.renamePlaceholder}
                      value={s.to}
                      onChange={(e) => setSub(ns, name, { kind: "rename", to: e.target.value })}
                    />
                    <datalist id={listId}>
                      {hints.map((h) => (
                        <option key={h} value={h} />
                      ))}
                    </datalist>
                    {badRename(ns, s.to) && (
                      <p role="alert" className="text-xs text-red-600">
                        {ko.stepTemplates.badRename}
                      </p>
                    )}
                  </>
                )}
                {s.kind === "literal" && (
                  <input
                    aria-label={`literal ${name}`}
                    className="w-56 rounded border border-slate-300 px-2 py-1 text-sm"
                    placeholder={ko.stepTemplates.literalPlaceholder}
                    value={s.value}
                    onChange={(e) => setSub(ns, name, { kind: "literal", value: e.target.value })}
                  />
                )}
              </li>
            );
          })}
        </ul>
      </fieldset>
    );

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-slate-600">{ko.stepTemplates.paramIntro}</p>
      {section("flow", pending.flow, ko.stepTemplates.flowSection, flowHints)}
      {section("env", pending.env, ko.stepTemplates.envSection, envHints)}
    </div>
  );
}
```

> Note: the `${` inside JSX `code`/template strings must be escaped as `\${` so TS doesn't read it as interpolation.

- [ ] **Step 9: Run to verify pass + full UI gate**

Run: `cd ui && pnpm test InsertTemplateModal scanVars templateParams`
Expected: PASS (including the retained no-token list/delete tests = R10 regression).
Then: `cd ui && pnpm lint && pnpm test && pnpm build`
Expected: all green (lint 0 warnings, `tsc -b` clean).

- [ ] **Step 10: Commit**

```bash
git add ui/src/scenario/scanVars.ts ui/src/components/scenario/InsertTemplateModal.tsx ui/src/i18n/ko.ts ui/src/scenario/__tests__/scanVars.test.ts ui/src/components/scenario/__tests__/InsertTemplateModal.test.tsx
git commit -m "feat(ui): insertion-time template variable parameterization dialog (R9,R10,R13,R14,R15)"
```

---

## Task 3: `/templates` 관리 페이지 + 라우트/네비 + ko 문구 (R1–R7, R15)

**Files:**
- Create: `ui/src/pages/TemplatesPage.tsx`
- Create: `ui/src/pages/__tests__/TemplatesPage.test.tsx`
- Modify: `ui/src/api/hooks.ts` (add `queryKeys.stepTemplate(id)`)
- Modify: `ui/src/routes.tsx`, `ui/src/components/Layout.tsx`
- Modify: `ui/src/i18n/ko.ts` (nav/pages/empty + management strings)

**Interfaces:**
- Consumes: `useStepTemplates`, `useUpdateStepTemplate`, `useDeleteStepTemplate` (existing hooks); `getStepTemplate`, `StepTemplateConflictError` (existing client); `parseStepsFragment` (`yamlDoc.ts`); `ko.stepTemplates.typeLabel`/`deleteConfirm`; `EmptyState`, `Button`.
- Produces: route `/templates`; `queryKeys.stepTemplate(id)`.

- [ ] **Step 1: Add `queryKeys.stepTemplate(id)`**

In `ui/src/api/hooks.ts`, next to `stepTemplates: () => ["step-templates"] as const` (line ~51) add:

```ts
  stepTemplate: (id: string) => ["step-templates", id] as const,
```

- [ ] **Step 2: Add management + nav/page/empty strings to `ko.ts`**

`ko.nav` (add): `stepTemplates: "스텝 템플릿",`
`ko.pages` (add): `editStepTemplate: "스텝 템플릿 편집",`
`ko.empty` (add): `stepTemplates: '저장된 스텝 템플릿이 없습니다. 에디터 헤더의 "템플릿으로 저장"으로 만드세요.',`
`ko.stepTemplates` (add management keys): 
```ts
    // ── 관리 페이지 ──
    colName: "이름",
    colSteps: "스텝 수",
    colDescription: "설명",
    colUpdated: "수정",
    colActions: "",
    editAction: "편집",
    previewLegend: "스텝 미리보기",
    save: "저장",
    saveProgress: "저장 중…",
    loadFailed: (msg: string) => `불러오기 실패: ${msg}`,
    deleteFailed: (msg: string) => `삭제 실패: ${msg}`,
```

- [ ] **Step 3: Write the failing RTL test**

Create `ui/src/pages/__tests__/TemplatesPage.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TemplatesPage } from "../TemplatesPage";
import * as api from "../../api/stepTemplates";

// Factory form (NOT bare `vi.mock(path)`): a bare auto-mock replaces the
// StepTemplateConflictError constructor body, nulling `.message` → the R6
// banner assertion (`/이미 있습니다/`) would fail. Spread the real module so the
// error class keeps its constructor; mock only the network functions.
// Mirrors ui/src/components/scenario/__tests__/InsertTemplateModal.test.tsx.
vi.mock("../../api/stepTemplates", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../api/stepTemplates")>();
  return {
    ...mod,
    listStepTemplates: vi.fn(),
    getStepTemplate: vi.fn(),
    updateStepTemplate: vi.fn(),
    deleteStepTemplate: vi.fn(),
  };
});

const STEPS = "- id: 01ARZ3NDEKTSV4RRFFQ69G5FAV\n  name: login\n  type: http\n  request:\n    method: POST\n    url: /login\n";

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TemplatesPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.resetAllMocks());

it("lists templates (R1)", async () => {
  vi.mocked(api.listStepTemplates).mockResolvedValue([
    { id: "t1", name: "login-flow", description: "로그인", step_count: 1, created_at: 1765500000000, updated_at: 1765500000000 },
  ]);
  wrap();
  expect(await screen.findByText("login-flow")).toBeInTheDocument();
});

it("shows empty state when there are no templates (R7)", async () => {
  vi.mocked(api.listStepTemplates).mockResolvedValue([]);
  wrap();
  expect(await screen.findByText(/저장된 스텝 템플릿이 없습니다/)).toBeInTheDocument();
});

it("edits name/description and resends the original steps_yaml (R2)", async () => {
  const user = userEvent.setup();
  vi.mocked(api.listStepTemplates).mockResolvedValue([
    { id: "t1", name: "login-flow", description: "", step_count: 1, created_at: 1765500000000, updated_at: 1765500000000 },
  ]);
  vi.mocked(api.getStepTemplate).mockResolvedValue({
    id: "t1", name: "login-flow", description: "", steps_yaml: STEPS, step_count: 1, created_at: 1765500000000, updated_at: 1765500000000,
  });
  vi.mocked(api.updateStepTemplate).mockResolvedValue({
    id: "t1", name: "login-v2", description: "", steps_yaml: STEPS, step_count: 1, created_at: 1765500000000, updated_at: 1765600000000,
  });
  wrap();
  await user.click(await screen.findByRole("button", { name: "편집" }));
  const nameInput = await screen.findByLabelText(/이름/);
  await user.clear(nameInput);
  await user.type(nameInput, "login-v2");
  await user.click(screen.getByRole("button", { name: "저장" }));
  await waitFor(() =>
    expect(api.updateStepTemplate).toHaveBeenCalledWith("t1", {
      name: "login-v2",
      description: "",
      steps_yaml: STEPS, // R2: body resent unchanged
    }),
  );
});

it("renders a read-only step preview (R3)", async () => {
  const user = userEvent.setup();
  vi.mocked(api.listStepTemplates).mockResolvedValue([
    { id: "t1", name: "x", description: "", step_count: 1, created_at: 1, updated_at: 1 },
  ]);
  vi.mocked(api.getStepTemplate).mockResolvedValue({
    id: "t1", name: "x", description: "", steps_yaml: STEPS, step_count: 1, created_at: 1, updated_at: 1,
  });
  wrap();
  await user.click(await screen.findByRole("button", { name: "편집" }));
  expect(await screen.findByText(/login/)).toBeInTheDocument();
  expect(screen.getByText(/POST/)).toBeInTheDocument();
});

it("surfaces a 409 rename conflict as an error banner (R6)", async () => {
  const user = userEvent.setup();
  vi.mocked(api.listStepTemplates).mockResolvedValue([
    { id: "t1", name: "x", description: "", step_count: 1, created_at: 1, updated_at: 1 },
  ]);
  vi.mocked(api.getStepTemplate).mockResolvedValue({
    id: "t1", name: "x", description: "", steps_yaml: STEPS, step_count: 1, created_at: 1, updated_at: 1,
  });
  vi.mocked(api.updateStepTemplate).mockRejectedValue(
    new api.StepTemplateConflictError("t2", "같은 이름의 템플릿이 이미 있습니다"),
  );
  wrap();
  await user.click(await screen.findByRole("button", { name: "편집" }));
  await user.click(screen.getByRole("button", { name: "저장" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/이미 있습니다/);
});

it("deletes with confirm (R4)", async () => {
  const user = userEvent.setup();
  vi.spyOn(window, "confirm").mockReturnValue(true);
  vi.mocked(api.listStepTemplates).mockResolvedValue([
    { id: "t1", name: "x", description: "", step_count: 1, created_at: 1, updated_at: 1 },
  ]);
  vi.mocked(api.deleteStepTemplate).mockResolvedValue(undefined);
  wrap();
  await user.click(await screen.findByRole("button", { name: "삭제" }));
  await waitFor(() => expect(api.deleteStepTemplate).toHaveBeenCalledWith("t1"));
});
```

- [ ] **Step 4: Run to verify fail**

Run: `cd ui && pnpm test TemplatesPage`
Expected: FAIL — "Cannot find module '../TemplatesPage'".

- [ ] **Step 5: Implement `TemplatesPage.tsx`**

Create `ui/src/pages/TemplatesPage.tsx` — mirror `EnvironmentsPage.tsx` structure (header `<h2>` + **no breadcrumb**, list table, edit form with imperative `qc.fetchQuery`, delete banner, EmptyState), with these concrete differences:

```tsx
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys, useStepTemplates, useUpdateStepTemplate, useDeleteStepTemplate } from "../api/hooks";
import { getStepTemplate, StepTemplateConflictError } from "../api/stepTemplates";
import { parseStepsFragment } from "../scenario/yamlDoc";
import type { Step } from "../scenario/model";
import { Button } from "../components/Button";
import { EmptyState } from "../components/EmptyState";
import { ko } from "../i18n/ko";

function stepSummary(s: Step): string {
  const label = ko.stepTemplates.typeLabel[s.type] ?? s.type;
  if (s.type === "http") return `${s.name} (${label}) · ${s.request.method} ${s.request.url}`;
  return `${s.name} (${label})`;
}

function Preview({ stepsYaml }: { stepsYaml: string }) {
  const parsed = parseStepsFragment(stepsYaml);
  if ("error" in parsed) {
    return <pre className="text-xs bg-slate-50 p-2 rounded overflow-auto">{stepsYaml}</pre>;
  }
  return (
    <ul className="flex flex-col gap-1 text-sm">
      {parsed.steps.map((s) => (
        <li key={s.id} className="font-mono text-xs">
          {stepSummary(s)}
        </li>
      ))}
    </ul>
  );
}

export function TemplatesPage() {
  const { data, isLoading, error } = useStepTemplates();
  const updateTpl = useUpdateStepTemplate();
  const deleteTpl = useDeleteStepTemplate();
  const qc = useQueryClient();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [stepsYaml, setStepsYaml] = useState(""); // R2: held to resend unchanged
  const [formError, setFormError] = useState<string | null>(null);
  const [delError, setDelError] = useState<string | null>(null);

  async function startEdit(id: string) {
    setFormError(null);
    try {
      const tpl = await qc.fetchQuery({
        queryKey: queryKeys.stepTemplate(id),
        queryFn: () => getStepTemplate(id),
      });
      setEditingId(id);
      setName(tpl.name);
      setDescription(tpl.description);
      setStepsYaml(tpl.steps_yaml);
    } catch (e) {
      setFormError((e as Error).message);
    }
  }

  function save() {
    if (!editingId) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setFormError("이름을 입력하세요");
      return;
    }
    setFormError(null);
    updateTpl.mutate(
      { id: editingId, input: { name: trimmed, description: description.trim(), steps_yaml: stepsYaml } },
      {
        onSuccess: () => setEditingId(null),
        onError: (e: Error) =>
          setFormError(e instanceof StepTemplateConflictError ? e.message : e.message),
      },
    );
  }

  function handleDelete(id: string, tplName: string) {
    setDelError(null);
    if (!window.confirm(ko.stepTemplates.deleteConfirm(tplName))) return;
    deleteTpl.mutate(id, { onError: (e) => setDelError((e as Error).message) });
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-lg font-semibold">{ko.nav.stepTemplates}</h2>
      </div>

      {editingId && (
        <section aria-label="template form" className="mb-8 border border-slate-200 rounded-md p-4 bg-white">
          <h3 className="text-md font-semibold mb-3">{ko.pages.editStepTemplate}</h3>
          <label className="block text-sm mb-3">
            <span className="text-slate-600">{ko.stepTemplates.colName}</span>
            <input
              aria-label={ko.stepTemplates.colName}
              className="mt-1 block w-64 rounded border border-slate-300 px-2 py-1"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="block text-sm mb-3">
            <span className="text-slate-600">{ko.stepTemplates.colDescription}</span>
            <input
              aria-label={ko.stepTemplates.colDescription}
              className="mt-1 block w-full rounded border border-slate-300 px-2 py-1"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <fieldset className="min-w-0 mb-3">
            <legend className="text-sm font-medium mb-1">{ko.stepTemplates.previewLegend}</legend>
            <Preview stepsYaml={stepsYaml} />
          </fieldset>
          {formError && (
            <p role="alert" className="mt-2 text-sm text-red-600">
              {formError}
            </p>
          )}
          <div className="flex gap-2 mt-4">
            <Button onClick={save} disabled={updateTpl.isPending}>
              {updateTpl.isPending ? ko.stepTemplates.saveProgress : ko.stepTemplates.save}
            </Button>
            <Button variant="secondary" onClick={() => setEditingId(null)}>
              {ko.stepTemplates.cancel}
            </Button>
          </div>
        </section>
      )}

      {delError && (
        <p role="alert" className="mb-4 text-sm text-red-600">
          {ko.stepTemplates.deleteFailed(delError)}
        </p>
      )}

      <section aria-label="template list">
        {isLoading && <p className="text-slate-500">{/* keep consistent with peers */}Loading…</p>}
        {error && <p className="text-red-600">{ko.stepTemplates.loadFailed((error as Error).message)}</p>}
        {data && data.length === 0 && !editingId && <EmptyState body={ko.empty.stepTemplates} />}
        {data && data.length > 0 && (
          <table className="min-w-full text-sm">
            <thead className="border-b border-slate-200 text-left text-slate-600">
              <tr>
                <th className="py-2 pr-4">{ko.stepTemplates.colName}</th>
                <th className="py-2 pr-4">{ko.stepTemplates.colSteps}</th>
                <th className="py-2 pr-4">{ko.stepTemplates.colDescription}</th>
                <th className="py-2 pr-4">{ko.stepTemplates.colUpdated}</th>
                <th className="py-2 pr-4"></th>
              </tr>
            </thead>
            <tbody>
              {data.map((t) => (
                <tr key={t.id} className="border-b border-slate-100">
                  <td className="py-2 pr-4 font-medium">{t.name}</td>
                  <td className="py-2 pr-4">{t.step_count}</td>
                  <td className="py-2 pr-4">{t.description}</td>
                  <td className="py-2 pr-4">{new Date(t.updated_at).toLocaleString()}</td>
                  <td className="py-2 pr-4 flex gap-2">
                    <Button variant="secondary" onClick={() => void startEdit(t.id)}>
                      {ko.stepTemplates.editAction}
                    </Button>
                    <Button variant="danger" onClick={() => handleDelete(t.id, t.name)} disabled={deleteTpl.isPending}>
                      {ko.stepTemplates.deleteAction}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
```

> `EmptyState` prop shape: confirm against `ui/src/components/EmptyState.tsx` — pass `body` (and optionally `action`). If it requires a different prop name, match it (EnvironmentsPage passes `body`/`action`).

- [ ] **Step 6: Wire route + nav**

In `ui/src/routes.tsx` add the import `import { TemplatesPage } from "./pages/TemplatesPage";` and a child route after `environments`:

```tsx
      { path: "templates", element: <TemplatesPage /> },
```

In `ui/src/components/Layout.tsx`, add a nav link next to `/environments` (no breadcrumb):

```tsx
            <Link to="/templates" className="hover:text-slate-900">
              {ko.nav.stepTemplates}
            </Link>
```

- [ ] **Step 7: Run to verify pass + full UI gate**

Run: `cd ui && pnpm test TemplatesPage`
Expected: PASS (R1–R7).
Then full gate: `cd ui && pnpm lint && pnpm test && pnpm build`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add ui/src/pages/TemplatesPage.tsx ui/src/pages/__tests__/TemplatesPage.test.tsx ui/src/api/hooks.ts ui/src/routes.tsx ui/src/components/Layout.tsx ui/src/i18n/ko.ts
git commit -m "feat(ui): /templates step-template management page (R1-R7,R15)"
```

---

## Final verification (before final review / merge)

- [ ] `cd ui && pnpm lint && pnpm test && pnpm build` — all green (full suite, not filtered).
- [ ] Confirm R10/R12 byte-identical: a no-token template insert and an all-keep parameterized insert both produce the same fragment as the pre-slice path (covered by Task 1 identity test + Task 2 no-token test).
- [ ] Final `handicap-reviewer` pass (UI Zod ↔ engine YAML round-trip of substituted output; deferral check; gate re-run). Security-reviewer is **N/A expected** (no engine/request/env-binding diff) — let `finish-slice §0` grep decide.
- [ ] Live verification **waived** (spec §6): no run-create/report-parse/engine path touched; load-bearing transform covered by pure-function unit + RTL. Record rationale in build-log.

---

## Self-Review (plan vs spec)

- **R1** ← Task 3 (route/nav/list, no breadcrumb). **R2** ← Task 3 (edit resends `steps_yaml`). **R3** ← Task 3 (`Preview` via `parseStepsFragment` + raw fallback). **R4** ← Task 3 (confirm+delete+banner, reuses `deleteConfirm`). **R5** ← Task 3 (no create affordance — TemplatesPage has no `startNew`). **R6** ← Task 3 (409 banner). **R7** ← Task 3 (EmptyState).
- **R8** ← Task 1 (`scanTemplateTokens`, Document visit, reserved-excluded). **R9** ← Task 2 (per-token form, keep default). **R10** ← Task 2 (no-token direct insert). **R11** ← Task 1 (`applyTokenSubstitutions`). **R12** ← Task 1 (identity no-op test) + Task 2 (no-token regression). **R13** ← Task 2 (`badRename` + datalist via `scanFlowVars`/`scanEnvVars`, `model===null` guard). **R14** ← Task 2 (2-phase single Modal). **R15** ← Task 2+3 (`ko.ts`, `stepTemplates`-prefixed keys).
- No placeholders: pure-function and modal/page code is complete; RTL test bodies for Task 2 are described against the existing file's mocking patterns (the existing InsertTemplateModal test file is the template) — the implementer fills them following those patterns.
- Type consistency: `Substitution`/`SubMap` defined in Task 1, consumed verbatim in Task 2; `queryKeys.stepTemplate(id)` defined Task 3 Step 1, used Step 5; `prepareTemplateInsertion`/`insertTemplateSteps` signatures match `yamlDoc.ts`/`store.ts`.

<!-- REVIEW-GATE: APPROVED -->
