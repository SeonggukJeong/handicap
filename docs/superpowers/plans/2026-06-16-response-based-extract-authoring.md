# 응답기반 extract 작성 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** test-run 응답 패널에서 JSON 본문 필드·헤더·쿠키·상태를 클릭해 그 스텝의 `extract`를 생성한다(엔진 4종 그대로, UI-only 브릿지).

**Architecture:** 순수 path/varname 함수(`jsonPath.ts`) + 프레젠테이셔널 트리(`ResponseBodyTree`)·공유 인라인 확인행(`ExtractConfirmRow`) + thin 스토어 액션(`addStepExtract`, 기존 `setStepExtract` edit 재사용) + `TestRunPanel`/`TestRunSection` 배선. 엔진·proto·controller·migration·워커 무변경, extract 미생성 시 시나리오 YAML byte-identical.

**Tech Stack:** TypeScript/React, Zustand store, `yaml` Document API(round-trip), Zod 모델, vitest + @testing-library/react. 엔진 소비자 = `serde_json_path`(RFC 9535).

**Spec:** `docs/superpowers/specs/2026-06-16-response-based-extract-authoring-design.md` (R1–R11). 각 task 제목에 충족 R 표기.

**커밋 경계(UI-only):** cargo 게이트 무관. 각 task 끝에 `cd ui && pnpm lint && pnpm test && pnpm build` 후 green 단일 커밋. pre-commit이 `ui/`(non-`.md`) staged면 UI 게이트 자동 실행.

---

## File Structure

| 파일 | 역할 | Task |
|---|---|---|
| `ui/src/scenario/jsonPath.ts` (신규) | `segmentsToPath`(RFC 9535 path) + `suggestVarName` 순수 함수 | 1 |
| `ui/src/scenario/__tests__/jsonPath.test.ts` (신규) | path/varname 골든 | 1 |
| `ui/src/scenario/store.ts` (수정) | `addStepExtract` 액션 추가(인터페이스+구현+actions shim) | 2 |
| `ui/src/scenario/__tests__/store.addStepExtract.test.ts` (신규) | append·미존재 no-op | 2 |
| `ui/src/components/scenario/ExtractConfirmRow.tsx` (신규) | 공유 인라인 확인행(var 편집, 평범한 JSX — Modal/HelpTip 금지) | 3 |
| `ui/src/components/scenario/ResponseBodyTree.tsx` (신규) | JSON 트리, 스칼라 leaf만 +추출 | 3 |
| `ui/src/components/scenario/__tests__/ResponseBodyTree.test.tsx` (신규) | leaf/컨테이너·확인행·onCreate | 3 |
| `ui/src/components/scenario/TestRunPanel.tsx` (수정) | `onAddExtract` prop·BodyBlock/BodyViewer 트리·헤더/쿠키/상태 버튼 | 4 |
| `ui/src/components/scenario/TestRunSection.tsx` (수정) | `onAddExtract`→`addStepExtract` 배선 + 추가 피드백 | 4 |
| `ui/src/components/scenario/__tests__/TestRunPanel.extract.test.tsx` (신규) | 헤더/쿠키/상태·잘림/비-JSON·store 반영 | 4 |
| `ui/CLAUDE.md` (수정) | stale 노트 정정 + 함정 추가 | 5 |

---

## Task 1: `jsonPath.ts` 순수 코어 (R2, R8)

**Files:**
- Create: `ui/src/scenario/jsonPath.ts`
- Test: `ui/src/scenario/__tests__/jsonPath.test.ts`

- [ ] **Step 1: Write the failing test**

`ui/src/scenario/__tests__/jsonPath.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { segmentsToPath, suggestVarName, type Segment } from "../jsonPath";

const k = (key: string): Segment => ({ kind: "key", key });
const i = (index: number): Segment => ({ kind: "index", index });

describe("segmentsToPath (RFC 9535, lockstep with engine serde_json_path)", () => {
  it("root is $", () => expect(segmentsToPath([])).toBe("$"));
  it("identifier members use dot", () =>
    expect(segmentsToPath([k("data"), k("token")])).toBe("$.data.token"));
  it("array index uses brackets", () =>
    expect(segmentsToPath([k("items"), i(0), k("sku")])).toBe("$.items[0].sku"));
  it("special-char key uses bracket-quote", () =>
    expect(segmentsToPath([k("weird.key")])).toBe("$['weird.key']"));
  it("space key uses bracket-quote", () =>
    expect(segmentsToPath([k("has space")])).toBe("$['has space']"));
  it("escapes single quote", () => expect(segmentsToPath([k("it's")])).toBe("$['it\\'s']"));
  it("escapes backslash", () => expect(segmentsToPath([k("a\\b")])).toBe("$['a\\\\b']"));
  it("escapes control chars as \\uXXXX (tab → \\u0009)", () =>
    expect(segmentsToPath([k("a\tb")])).toBe("$['a\\u0009b']"));
  it("escapes newline as \\u000a", () =>
    expect(segmentsToPath([k("a\nb")])).toBe("$['a\\u000ab']"));
});

describe("suggestVarName", () => {
  it("passes identifiers through", () => expect(suggestVarName("token")).toBe("token"));
  it("replaces non-identifier chars with _", () =>
    expect(suggestVarName("x-request-id")).toBe("x_request_id"));
  it("prefixes a leading digit", () => expect(suggestVarName("1abc")).toBe("_1abc"));
  it("falls back to value when empty after cleaning", () => expect(suggestVarName("")).toBe("value"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && pnpm test jsonPath`
Expected: FAIL — `Cannot find module '../jsonPath'`.

- [ ] **Step 3: Write the implementation**

`ui/src/scenario/jsonPath.ts`:

```ts
/** One step of a JSON path: an object key or an array index. */
export type Segment = { kind: "key"; key: string } | { kind: "index"; index: number };

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Escape a key for an RFC 9535 single-quoted name-selector. serde_json_path 0.7.2
 *  REJECTS raw control chars (< U+0020) inside the quotes ("expected an ending
 *  quote") — they MUST be \uXXXX. Verified against the engine's locked dep. */
function escapeBracketKey(key: string): string {
  let out = "";
  for (const ch of key) {
    const cp = ch.codePointAt(0)!;
    if (ch === "\\") out += "\\\\";
    else if (ch === "'") out += "\\'";
    else if (cp < 0x20) out += "\\u" + cp.toString(16).padStart(4, "0");
    else out += ch;
  }
  return out;
}

/** Build a JSONPath string from path segments, lockstep with the engine's
 *  serde_json_path consumer (crates/engine/src/extract.rs). Identifier keys use
 *  dot notation; everything else uses bracket-quote with RFC 9535 escaping. */
export function segmentsToPath(segments: ReadonlyArray<Segment>): string {
  let out = "$";
  for (const seg of segments) {
    if (seg.kind === "index") out += `[${seg.index}]`;
    else if (IDENT_RE.test(seg.key)) out += `.${seg.key}`;
    else out += `['${escapeBracketKey(seg.key)}']`;
  }
  return out;
}

/** Suggest a flow-variable name from a key/header/cookie name: non-identifier
 *  chars → "_", leading digit → "_"-prefixed, empty → "value". */
export function suggestVarName(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_]/g, "_");
  if (cleaned.length === 0) return "value";
  return /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui && pnpm test jsonPath`
Expected: PASS (13 tests).

- [ ] **Step 5: Lint/build + commit**

```bash
cd ui && pnpm lint && pnpm build && cd ..
git add ui/src/scenario/jsonPath.ts ui/src/scenario/__tests__/jsonPath.test.ts
git commit -m "feat(ui): jsonPath.ts — RFC9535 path + varname 순수 함수 (R2,R8)"
```

**Acceptance (R2, R8):** 골든 통과 특히 제어문자(탭→`	`)·`'`·`\`·배열·루트 `$`·식별자. `suggestVarName` sanitize.

---

## Task 2: `addStepExtract` 스토어 액션 (R4, R7)

**Files:**
- Modify: `ui/src/scenario/store.ts` (인터페이스 ~line 63 뒤, 액션 ~line 235 뒤, actions shim ~line 342 뒤)
- Test: `ui/src/scenario/__tests__/store.addStepExtract.test.ts`

- [ ] **Step 1: Write the failing test**

`ui/src/scenario/__tests__/store.addStepExtract.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { useScenarioEditor } from "../store";
import type { Extract } from "../model";

const YAML = `version: 1
name: "demo"
cookie_jar: auto
variables: {}
steps:
  - id: 01J0000000000000000000000A
    name: login
    type: http
    request:
      method: POST
      url: https://x/login
`;

const ID = "01J0000000000000000000000A";

beforeEach(() => {
  useScenarioEditor.setState(useScenarioEditor.getInitialState());
});

describe("addStepExtract", () => {
  it("appends an extract to the http step and round-trips to YAML", () => {
    useScenarioEditor.getState().loadFromString(YAML);
    const ex: Extract = { var: "token", from: "body", path: "$.data.token" };
    useScenarioEditor.getState().addStepExtract(ID, ex);
    const step = useScenarioEditor.getState().model!.steps[0];
    expect(step.type).toBe("http");
    if (step.type === "http") expect(step.extract).toContainEqual(ex);
    expect(useScenarioEditor.getState().yamlText).toContain("extract:");
    expect(useScenarioEditor.getState().yamlText).toContain("$.data.token");
  });

  it("appends a second extract (duplicate var allowed)", () => {
    useScenarioEditor.getState().loadFromString(YAML);
    useScenarioEditor.getState().addStepExtract(ID, { var: "t", from: "body", path: "$.a" });
    useScenarioEditor.getState().addStepExtract(ID, { var: "t", from: "body", path: "$.b" });
    const step = useScenarioEditor.getState().model!.steps[0];
    if (step.type === "http") expect(step.extract).toHaveLength(2);
  });

  it("no-ops for a missing step id (R7)", () => {
    useScenarioEditor.getState().loadFromString(YAML);
    const before = useScenarioEditor.getState().yamlText;
    useScenarioEditor.getState().addStepExtract("01J0000000000000000000000Z", { var: "x", from: "status" });
    expect(useScenarioEditor.getState().yamlText).toBe(before);
  });

  it("commits a pending YAML buffer before writing (no stale-doc clobber)", () => {
    useScenarioEditor.getState().loadFromString(YAML);
    // Simulate Monaco edit in flight: rename via pending buffer, uncommitted.
    const edited = YAML.replace('name: login', 'name: signin');
    useScenarioEditor.getState().setPendingYamlText(edited);
    useScenarioEditor.getState().addStepExtract(ID, { var: "token", from: "body", path: "$.t" });
    const step = useScenarioEditor.getState().model!.steps[0];
    // pending rename was committed first, then extract appended on top.
    if (step.type === "http") {
      expect(step.name).toBe("signin");
      expect(step.extract).toHaveLength(1);
    }
    expect(useScenarioEditor.getState().pendingYamlText).toBeNull();
  });

  it("no-ops when the pending buffer is unparseable (keeps user edits)", () => {
    useScenarioEditor.getState().loadFromString(YAML);
    useScenarioEditor.getState().setPendingYamlText("version: 1\nsteps: [oops");
    useScenarioEditor.getState().addStepExtract(ID, { var: "x", from: "status" });
    // Buffer preserved, no extract written, model unchanged (still parseable original).
    expect(useScenarioEditor.getState().pendingYamlText).not.toBeNull();
    const step = useScenarioEditor.getState().model!.steps[0];
    if (step.type === "http") expect(step.extract).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && pnpm test store.addStepExtract`
Expected: FAIL — `addStepExtract is not a function`.

- [ ] **Step 3: Add the interface declaration**

In `ui/src/scenario/store.ts`, add to the `ScenarioEditorState` interface immediately after the `setStepExtract(...)` line (currently line 63):

```ts
  /** Append one extract to an http step (response-based extract authoring).
   *  Commits any pending Monaco buffer first; no-ops if the buffer is unparseable
   *  or the target step is missing / non-http (R7). */
  addStepExtract(stepId: string, extract: Extract): void;
```

- [ ] **Step 4: Add the action implementation**

In the same file, add to the store object immediately after the `setStepExtract(...) { ... }` action (currently ends ~line 235):

```ts
  addStepExtract(stepId, extract) {
    // (a) Commit any uncommitted Monaco buffer first — the test-run panel is reachable
    // below the YAML tab during the debounce window, so doc/model can be stale.
    if (get().pendingYamlText !== null) {
      get().commitPendingYaml();
      // Unparseable buffer: commitPendingYaml set yamlError and left doc/model stale.
      // Writing now would clobber the user's uncommitted edits — no-op instead.
      if (get().yamlError !== null) return;
    }
    const model = get().model;
    if (!model) return;
    const step = findStepById(model.steps, stepId);
    if (!step || step.type !== "http") return; // deleted or non-http target → no-op (R7)
    dispatch(set, get, {
      type: "setStepExtract",
      stepId,
      extract: [...step.extract, extract],
    });
  },
```

- [ ] **Step 5: Register the action in the getInitialState shim**

In the `actions` IIFE near the bottom (currently ~line 342), add after `setStepExtract: s.setStepExtract,`:

```ts
    addStepExtract: s.addStepExtract,
```

(`findStepById` and `Extract` are already imported at the top of store.ts — no new import.)

- [ ] **Step 6: Run test to verify it passes**

Run: `cd ui && pnpm test store.addStepExtract`
Expected: PASS (5 tests).

- [ ] **Step 7: Lint/build + commit**

```bash
cd ui && pnpm lint && pnpm build && cd ..
git add ui/src/scenario/store.ts ui/src/scenario/__tests__/store.addStepExtract.test.ts
git commit -m "feat(ui): addStepExtract 스토어 액션 — append + pending-commit + no-op 가드 (R4,R7)"
```

**Acceptance (R4, R7):** http 스텝에 append→YAML round-trip, 중복 var append, 미존재 id no-op, pending 버퍼 선커밋, 파싱불가 버퍼 no-op.

---

## Task 3: `ResponseBodyTree` + `ExtractConfirmRow` (R1, R6, R8, R11)

**Files:**
- Create: `ui/src/components/scenario/ExtractConfirmRow.tsx`
- Create: `ui/src/components/scenario/ResponseBodyTree.tsx`
- Test: `ui/src/components/scenario/__tests__/ResponseBodyTree.test.tsx`

- [ ] **Step 1: Write the failing test**

`ui/src/components/scenario/__tests__/ResponseBodyTree.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ResponseBodyTree } from "../ResponseBodyTree";

describe("ResponseBodyTree", () => {
  it("scalar leaves get +추출, containers do not (R1,R6)", () => {
    render(
      <ResponseBodyTree value={{ data: { token: "abc" }, items: [1, 2] }} onCreate={() => {}} />,
    );
    // scalars: token, items[0]=1, items[1]=2 → 3 buttons (objects/arrays none)
    expect(screen.getAllByRole("button", { name: "+추출" })).toHaveLength(3);
  });

  it("creates a body extract with generated path + edited var (R8)", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(<ResponseBodyTree value={{ data: { token: "abc" } }} onCreate={onCreate} />);
    await user.click(screen.getByRole("button", { name: "+추출" }));
    const input = screen.getByRole("textbox", { name: "extract variable name" });
    expect(input).toHaveValue("token"); // prefilled from leaf key
    await user.clear(input);
    await user.type(input, "authToken");
    await user.click(screen.getByRole("button", { name: "추가" }));
    expect(onCreate).toHaveBeenCalledWith({ var: "authToken", from: "body", path: "$.data.token" });
  });

  it("array element path uses index + nearest object key as var", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(<ResponseBodyTree value={{ items: [{ sku: "A-1" }] }} onCreate={onCreate} />);
    await user.click(screen.getByRole("button", { name: "+추출" }));
    expect(screen.getByRole("textbox", { name: "extract variable name" })).toHaveValue("sku");
    await user.click(screen.getByRole("button", { name: "추가" }));
    expect(onCreate).toHaveBeenCalledWith({ var: "sku", from: "body", path: "$.items[0].sku" });
  });

  it("root scalar uses $ and default var (R6 §3③)", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(<ResponseBodyTree value={"justastring"} onCreate={onCreate} />);
    await user.click(screen.getByRole("button", { name: "+추출" }));
    expect(screen.getByRole("textbox", { name: "extract variable name" })).toHaveValue("value");
    await user.click(screen.getByRole("button", { name: "추가" }));
    expect(onCreate).toHaveBeenCalledWith({ var: "value", from: "body", path: "$" });
  });

  it("cancel closes the confirm row without calling onCreate", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(<ResponseBodyTree value={{ token: "abc" }} onCreate={onCreate} />);
    await user.click(screen.getByRole("button", { name: "+추출" }));
    await user.click(screen.getByRole("button", { name: "취소" }));
    expect(screen.queryByRole("textbox", { name: "extract variable name" })).toBeNull();
    expect(onCreate).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && pnpm test ResponseBodyTree`
Expected: FAIL — `Cannot find module '../ResponseBodyTree'`.

- [ ] **Step 3: Write `ExtractConfirmRow.tsx`**

`ui/src/components/scenario/ExtractConfirmRow.tsx`:

```tsx
import { useState } from "react";
import type { Extract } from "../../scenario/model";

/** Rebuild an Extract with a new var, preserving the discriminant explicitly
 *  (spreading a union + overriding widens the type — tsc -b would reject it). */
function withVar(proposed: Extract, v: string): Extract {
  switch (proposed.from) {
    case "body":
      return { var: v, from: "body", path: proposed.path };
    case "header":
      return { var: v, from: "header", name: proposed.name };
    case "cookie":
      return { var: v, from: "cookie", name: proposed.name };
    case "status":
      return { var: v, from: "status" };
  }
}

/** Inline confirm row for creating an extract. PLAIN inline JSX — NO <Modal> and NO
 *  <HelpTip>: both use capture-phase ESC handling, and this row also renders INSIDE
 *  the BodyViewer <Modal>, so a nested modal's ESC would close the outer one
 *  (ui/CLAUDE.md HelpTip-in-Modal trap, R11). */
export function ExtractConfirmRow({
  proposed,
  preview,
  onConfirm,
  onCancel,
}: {
  proposed: Extract;
  preview?: string;
  onConfirm: (extract: Extract) => void;
  onCancel: () => void;
}) {
  const [varName, setVarName] = useState(proposed.var);
  const detail =
    proposed.from === "body" ? proposed.path : proposed.from === "status" ? "status" : proposed.name;
  const valid = varName.trim().length > 0;
  return (
    <div className="my-1 flex flex-wrap items-center gap-2 rounded bg-indigo-50 px-2 py-1 text-xs">
      <span className="text-slate-500">변수명</span>
      <input
        aria-label="extract variable name"
        value={varName}
        onChange={(e) => setVarName(e.target.value)}
        className="w-32 rounded border border-slate-300 px-1 py-0.5 font-mono"
      />
      <span className="text-slate-400">←</span>
      <span className="rounded bg-slate-200 px-1 py-0.5">{proposed.from}</span>
      <code className="rounded bg-slate-100 px-1 py-0.5 break-all">{detail}</code>
      {preview !== undefined && (
        <span className="max-w-[12rem] truncate text-slate-400">= {preview}</span>
      )}
      <button
        type="button"
        disabled={!valid}
        onClick={() => onConfirm(withVar(proposed, varName.trim()))}
        className="rounded bg-indigo-600 px-2 py-0.5 text-white disabled:opacity-50"
      >
        추가
      </button>
      <button type="button" onClick={onCancel} className="rounded bg-slate-200 px-2 py-0.5">
        취소
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Write `ResponseBodyTree.tsx`**

`ui/src/components/scenario/ResponseBodyTree.tsx`:

```tsx
import { useState } from "react";
import type { Extract } from "../../scenario/model";
import { segmentsToPath, suggestVarName, type Segment } from "../../scenario/jsonPath";
import { ExtractConfirmRow } from "./ExtractConfirmRow";

function isScalar(v: unknown): v is string | number | boolean | null {
  return v === null || typeof v !== "object";
}

function preview(v: unknown): string {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 40 ? `${s.slice(0, 40)}…` : s;
}

/** Nearest object-key ancestor (skip array indices) → var suggestion source. */
function lastKey(segments: ReadonlyArray<Segment>): string {
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i];
    if (seg.kind === "key") return seg.key;
  }
  return "value";
}

/** Renders parsed JSON as a tree; scalar leaves expose "+추출" → inline confirm row
 *  → onCreate(body extract). Object/array containers are shown but not extractable
 *  (R6 — path/value would be ambiguous). */
export function ResponseBodyTree({
  value,
  onCreate,
}: {
  value: unknown;
  onCreate: (extract: Extract) => void;
}) {
  return (
    <div className="overflow-auto rounded bg-slate-900 p-2 font-mono text-xs text-slate-100">
      <TreeNode value={value} segments={[]} onCreate={onCreate} />
    </div>
  );
}

function TreeNode({
  value,
  segments,
  label,
  onCreate,
}: {
  value: unknown;
  segments: ReadonlyArray<Segment>;
  label?: string;
  onCreate: (extract: Extract) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const prefix = label !== undefined ? `${label}: ` : "";

  if (isScalar(value)) {
    const path = segmentsToPath(segments);
    return (
      <div className="pl-3">
        <div className="flex items-center justify-between gap-2">
          <span className="min-w-0 truncate">
            {prefix}
            {typeof value === "string" ? `"${value}"` : String(value)}
          </span>
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="shrink-0 rounded bg-indigo-600 px-1.5 py-0.5 text-[11px] text-white"
          >
            +추출
          </button>
        </div>
        {confirming && (
          <ExtractConfirmRow
            proposed={{ var: suggestVarName(lastKey(segments)), from: "body", path }}
            preview={preview(value)}
            onConfirm={(ex) => {
              onCreate(ex);
              setConfirming(false);
            }}
            onCancel={() => setConfirming(false)}
          />
        )}
      </div>
    );
  }

  const entries: [string | number, unknown][] = Array.isArray(value)
    ? value.map((v, idx) => [idx, v] as [number, unknown])
    : Object.entries(value as Record<string, unknown>);
  return (
    <div className="pl-3">
      <div className="text-slate-400">
        {prefix}
        {Array.isArray(value) ? `[${entries.length}]` : "{…}"}
      </div>
      {entries.map(([key, child]) => (
        <TreeNode
          key={String(key)}
          value={child}
          label={typeof key === "number" ? `[${key}]` : key}
          segments={[
            ...segments,
            typeof key === "number"
              ? { kind: "index", index: key }
              : { kind: "key", key },
          ]}
          onCreate={onCreate}
        />
      ))}
    </div>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd ui && pnpm test ResponseBodyTree`
Expected: PASS (5 tests).

- [ ] **Step 6: Lint/build + commit**

```bash
cd ui && pnpm lint && pnpm build && cd ..
git add ui/src/components/scenario/ExtractConfirmRow.tsx ui/src/components/scenario/ResponseBodyTree.tsx ui/src/components/scenario/__tests__/ResponseBodyTree.test.tsx
git commit -m "feat(ui): ResponseBodyTree + ExtractConfirmRow — 스칼라 leaf +추출 인라인 확인행 (R1,R6,R8,R11)"
```

**Acceptance (R1, R6, R8, R11):** 스칼라 leaf만 +추출, 컨테이너 없음, path 자동(배열 index·중첩)·var prefill·편집, 루트 스칼라 `$`, 취소 동작, 확인행은 Modal 아님.

---

## Task 4: `TestRunPanel`/`TestRunSection` 배선 (R1, R3, R4, R5, R7)

**Files:**
- Modify: `ui/src/components/scenario/TestRunPanel.tsx`
- Modify: `ui/src/components/scenario/TestRunSection.tsx`
- Test: `ui/src/components/scenario/__tests__/TestRunPanel.extract.test.tsx`

> 핵심: `onAddExtract`를 `TestRunPanel → HttpRow`로 내리고, `HttpRow` 안에서 ① 본문(JSON&미잘림)은 `BodyBlock`/`BodyViewer`의 트리로 ② 응답 헤더/Set-Cookie/상태는 버튼으로 흘린다. **요청 측(요청 헤더·요청 본문)은 affordance 없음.** 짧은 본문 트리는 `BodyBlock`이 직접 마운트(현재 `:104-108`에서 `<pre>` early-return하므로 그 분기 앞에 트리 분기를 둔다), 긴 본문은 기존 모달의 `BodyViewer`에 트리 토글 추가.

- [ ] **Step 1: Write the failing test**

`ui/src/components/scenario/__tests__/TestRunPanel.extract.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TestRunPanel } from "../TestRunPanel";
import type { ScenarioTrace, StepTrace } from "../../api/schemas";

function httpStep(over: Partial<StepTrace> = {}): StepTrace {
  return {
    step_id: "01J0000000000000000000000A",
    kind: "http",
    loop_index: null,
    branch: null,
    request: { method: "POST", url: "https://x/login", headers: {}, body: null },
    response: {
      status: 200,
      latency_ms: 5,
      download_ms: null,
      headers: { "x-request-id": "9f2c" },
      set_cookies: ["session=abc123; Path=/; HttpOnly"],
      body: JSON.stringify({ data: { token: "eyJabc" } }),
      body_truncated: false,
    },
    extracted: {},
    unbound_vars: [],
    error: null,
    ...over,
  };
}

function trace(step: StepTrace): ScenarioTrace {
  // final_vars is REQUIRED by ScenarioTraceSchema (z.record(string,string)) — omitting
  // it makes tsc -b reject the whole test file.
  return { ok: true, total_ms: 10, truncated: false, error: null, final_vars: {}, steps: [step] };
}

async function expand(user: ReturnType<typeof userEvent.setup>) {
  // HttpRow header is a toggle button; open it to reveal response detail.
  await user.click(screen.getByRole("button", { name: /login/ }));
}

describe("TestRunPanel extract affordances", () => {
  it("body field +추출 → onAddExtract(step_id, body extract) (R1,R4)", async () => {
    const user = userEvent.setup();
    const onAddExtract = vi.fn();
    render(<TestRunPanel trace={trace(httpStep())} onAddExtract={onAddExtract} />);
    await expand(user);
    await user.click(screen.getByRole("button", { name: "+추출" }));
    await user.click(screen.getByRole("button", { name: "추가" }));
    expect(onAddExtract).toHaveBeenCalledWith("01J0000000000000000000000A", {
      var: "token",
      from: "body",
      path: "$.data.token",
    });
  });

  it("response header 추출 → header extract (R3)", async () => {
    const user = userEvent.setup();
    const onAddExtract = vi.fn();
    render(<TestRunPanel trace={trace(httpStep())} onAddExtract={onAddExtract} />);
    await expand(user);
    // header row has its own 추출 button; click it, then 추가
    const headerExtract = screen.getByRole("button", { name: "x-request-id 추출" });
    await user.click(headerExtract);
    await user.click(screen.getByRole("button", { name: "추가" }));
    expect(onAddExtract).toHaveBeenCalledWith("01J0000000000000000000000A", {
      var: "x_request_id",
      from: "header",
      name: "x-request-id",
    });
  });

  it("Set-Cookie 추출 → cookie extract with parsed name (R3)", async () => {
    const user = userEvent.setup();
    const onAddExtract = vi.fn();
    render(<TestRunPanel trace={trace(httpStep())} onAddExtract={onAddExtract} />);
    await expand(user);
    await user.click(screen.getByRole("button", { name: "session 추출" }));
    await user.click(screen.getByRole("button", { name: "추가" }));
    expect(onAddExtract).toHaveBeenCalledWith("01J0000000000000000000000A", {
      var: "session",
      from: "cookie",
      name: "session",
    });
  });

  it("status 추출 → status extract (R3)", async () => {
    const user = userEvent.setup();
    const onAddExtract = vi.fn();
    render(<TestRunPanel trace={trace(httpStep())} onAddExtract={onAddExtract} />);
    await expand(user);
    await user.click(screen.getByRole("button", { name: "상태 추출" }));
    await user.click(screen.getByRole("button", { name: "추가" }));
    expect(onAddExtract).toHaveBeenCalledWith("01J0000000000000000000000A", {
      var: "status",
      from: "status",
    });
  });

  it("truncated body → no tree, shows manual notice; header still extractable (R5)", async () => {
    const user = userEvent.setup();
    const onAddExtract = vi.fn();
    const step = httpStep({
      response: { ...httpStep().response!, body_truncated: true },
    });
    render(<TestRunPanel trace={trace(step)} onAddExtract={onAddExtract} />);
    await expand(user);
    expect(screen.queryByRole("button", { name: "+추출" })).toBeNull();
    expect(screen.getByText(/추출 불가/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "x-request-id 추출" })).toBeInTheDocument();
  });

  it("non-JSON body → no tree, shows manual notice (R5)", async () => {
    const user = userEvent.setup();
    const step = httpStep({
      response: { ...httpStep().response!, body: "<html>not json</html>" },
    });
    render(<TestRunPanel trace={trace(step)} onAddExtract={vi.fn()} />);
    await expand(user);
    expect(screen.queryByRole("button", { name: "+추출" })).toBeNull();
    expect(screen.getByText(/추출 불가/)).toBeInTheDocument();
  });

  it("no affordances when onAddExtract is absent (back-compat)", async () => {
    const user = userEvent.setup();
    render(<TestRunPanel trace={trace(httpStep())} />);
    await expand(user);
    expect(screen.queryByRole("button", { name: "+추출" })).toBeNull();
    expect(screen.queryByRole("button", { name: "상태 추출" })).toBeNull();
  });
});
```

> NOTE: confirm the `StepTrace`/`ScenarioTrace`/`TracedResponse` field names against `ui/src/api/schemas.ts` before finalizing the fixture (the `request.body`, `response.set_cookies`, `body_truncated` names mirror engine `trace.rs`; adjust the fixture if a name differs). The full-page `ScenarioEditPage` needs no Monaco mock, but this test renders `TestRunPanel` directly so no editor setup is needed.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && pnpm test TestRunPanel.extract`
Expected: FAIL — `onAddExtract` not wired / no +추출 buttons.

- [ ] **Step 3: Add `onAddExtract` to `TestRunPanel` and thread to `HttpRow`**

In `ui/src/components/scenario/TestRunPanel.tsx`:

(a) Add the import near the top:

```tsx
import type { Extract } from "../../scenario/model";
import { ResponseBodyTree } from "./ResponseBodyTree";
import { ExtractConfirmRow } from "./ExtractConfirmRow";
```

(b) Change `TestRunPanel`'s props and the `HttpRow` render to pass `onAddExtract`:

```tsx
export function TestRunPanel({
  trace,
  steps,
  onAddExtract,
}: {
  trace: ScenarioTrace;
  steps?: ReadonlyArray<Step>;
  onAddExtract?: (stepId: string, extract: Extract) => void;
}) {
```

and in the `.map`, pass it to the http branch:

```tsx
            ) : (
              <HttpRow key={`${step.step_id}-${i}`} step={step} onAddExtract={onAddExtract} />
            ),
```

- [ ] **Step 4: Wire `HttpRow` — status button + thread onCreate to body/headers**

Replace the `HttpRow` function so it (i) takes `onAddExtract`, (ii) builds an `onCreate` that calls `onAddExtract?.(step.step_id, …)`, (iii) renders response headers / Set-Cookie / status / body with extract affordances, leaving request side untouched:

```tsx
function HttpRow({
  step,
  onAddExtract,
}: {
  step: StepTrace;
  onAddExtract?: (stepId: string, extract: Extract) => void;
}) {
  const [open, setOpen] = useState(false);
  const [statusConfirm, setStatusConfirm] = useState(false);
  const req = step.request;
  const resp = step.response;
  const extracted = Object.entries(step.extracted);
  const onCreate = onAddExtract
    ? (extract: Extract) => onAddExtract(step.step_id, extract)
    : undefined;
  return (
    <li className="border-b border-slate-100 py-2">
      {/* ... keep the existing toggle <button> header unchanged ... */}
      {open && (
        <div className="mt-2 rounded bg-slate-50 p-3">
          {req && (
            <>
              <HeaderTable title="Request headers" rows={Object.entries(req.headers)} />
              {req.body && <BodyBlock body={req.body} label="요청 본문" />}
            </>
          )}
          {resp && (
            <>
              <HeaderTable
                title="Response headers"
                rows={Object.entries(resp.headers)}
                onExtract={
                  onCreate
                    ? (name) =>
                        onCreate({ var: suggestVarName(name), from: "header", name })
                    : undefined
                }
              />
              {resp.set_cookies.length > 0 && (
                <HeaderTable
                  title="Set-Cookie"
                  rows={resp.set_cookies.map((c, i) => [String(i), c])}
                  onExtract={
                    onCreate
                      ? (rowKey) => {
                          // HeaderTable passes the ROW KEY ("0","1"); resolve the cookie by index.
                          const cookie = resp.set_cookies[Number(rowKey)];
                          const name = cookie.split("=")[0].trim();
                          onCreate({ var: suggestVarName(name), from: "cookie", name });
                        }
                      : undefined
                  }
                  extractLabelFor={(rowKey) => {
                    const cookie = resp.set_cookies[Number(rowKey)];
                    return `${cookie.split("=")[0].trim()} 추출`;
                  }}
                />
              )}
              {onCreate && (
                <div className="mb-2">
                  <button
                    type="button"
                    onClick={() => setStatusConfirm(true)}
                    className="rounded bg-slate-200 px-2 py-0.5 text-xs hover:bg-slate-300"
                  >
                    상태 추출
                  </button>
                  {statusConfirm && (
                    <ExtractConfirmRow
                      proposed={{ var: "status", from: "status" }}
                      preview={String(resp.status)}
                      onConfirm={(ex) => {
                        onCreate(ex);
                        setStatusConfirm(false);
                      }}
                      onCancel={() => setStatusConfirm(false)}
                    />
                  )}
                </div>
              )}
              <BodyBlock
                body={resp.body}
                truncated={resp.body_truncated}
                label="응답 본문"
                onExtract={onCreate}
              />
            </>
          )}
        </div>
      )}
    </li>
  );
}
```

> Keep the existing collapsed-header `<button>` (lines ~188–211: chevron, method, url, status chip, TTFB, `extracted` chips, error, unbound) exactly as-is — do NOT add affordances there (it is itself a `<button>`; nesting interactive elements is invalid). Import `suggestVarName` from `../../scenario/jsonPath`.

- [ ] **Step 5: Add `onExtract`/`extractLabelFor` to `HeaderTable`**

Replace `HeaderTable` so each row optionally gets a "추출" button (response-side only — request usage passes no `onExtract`, so no button):

```tsx
function HeaderTable({
  title,
  rows,
  onExtract,
  extractLabelFor,
}: {
  title: string;
  rows: [string, string][];
  onExtract?: (name: string) => void;
  extractLabelFor?: (rowKey: string) => string;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="mb-2">
      <div className="text-xs font-medium text-slate-500">{title}</div>
      <table className="min-w-full text-xs">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <td className="py-0.5 pr-3 align-top font-mono text-slate-600">{k}</td>
              <td className="py-0.5 font-mono break-all">{v}</td>
              {onExtract && (
                <td className="py-0.5 pl-2 align-top">
                  <button
                    type="button"
                    aria-label={extractLabelFor ? extractLabelFor(k) : `${k} 추출`}
                    onClick={() => onExtract(k)}
                    className="rounded bg-slate-200 px-1.5 py-0.5 text-[11px] hover:bg-slate-300"
                  >
                    추출
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

> `HeaderTable` always calls `onExtract(k)`/`extractLabelFor(k)` with the **row key `k`** (the first table column). For **response headers** `k` IS the header name → `onExtract(k)` builds the header extract and the default label `${k} 추출` is correct (no `extractLabelFor` passed). For **Set-Cookie** the rows are `[String(i), cookieString]`, so `k` is the index string (`"0"`, `"1"`) — therefore BOTH the Set-Cookie `onExtract` and `extractLabelFor` closures must resolve `resp.set_cookies[Number(k)]` and parse the cookie name before `=` (Step 4 already does this). The result: value emits `{from:"cookie", name:"session"}` and the button's accessible name is `"session 추출"` (the test asserts both). Do NOT pass the cookie string as the closure arg — `HeaderTable` only ever passes the row key.

- [ ] **Step 6: Add the tree to `BodyBlock` (inline short + modal long) and the manual-fallback notice**

Replace `BodyBlock` so a **response** body (`onExtract` present) that is valid JSON & not truncated renders the tree; otherwise keep the existing raw rendering, plus a notice when extraction is unavailable:

```tsx
function BodyBlock({
  body,
  truncated = false,
  label,
  onExtract,
}: {
  body: string;
  truncated?: boolean;
  label: string;
  onExtract?: (extract: Extract) => void;
}) {
  const [open, setOpen] = useState(false);
  const parsed = useMemo<{ value: unknown } | undefined>(() => {
    if (!onExtract || truncated) return undefined;
    try {
      return { value: JSON.parse(body) as unknown };
    } catch {
      return undefined;
    }
  }, [body, truncated, onExtract]);
  if (!body) return null;

  // Response body, valid JSON, not truncated → interactive tree (R1).
  if (parsed && onExtract) {
    const isLong = body.length > INLINE_PREVIEW_CHARS;
    if (!isLong) {
      return (
        <div className="mb-2">
          <ResponseBodyTree value={parsed.value} onCreate={onExtract} />
        </div>
      );
    }
    return (
      <div className="mb-2">
        <div className="mb-1 flex items-center gap-2">
          <span className="text-xs text-slate-500">
            {label} · {body.length.toLocaleString()}자
          </span>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="rounded bg-slate-200 px-2 py-0.5 text-xs hover:bg-slate-300"
          >
            전체 보기·추출
          </button>
        </div>
        <Modal open={open} onClose={() => setOpen(false)} title={label}>
          <BodyViewer body={body} truncated={truncated} value={parsed.value} onExtract={onExtract} />
        </Modal>
      </div>
    );
  }

  // Fallback: request body, non-JSON, or truncated → existing raw rendering.
  const isLong = body.length > INLINE_PREVIEW_CHARS || truncated;
  const notice = onExtract ? (
    <div className="mb-1 rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
      {truncated ? "본문이 잘려" : "본문이 JSON이 아니라"} 본문 필드 추출 불가 — Inspector에서 수동
      입력 (헤더·쿠키·상태는 가능)
    </div>
  ) : null;
  if (!isLong) {
    return (
      <div className="mb-2">
        {notice}
        <pre className="whitespace-pre-wrap break-all rounded bg-white p-2 text-xs">{body}</pre>
      </div>
    );
  }
  return (
    <div className="mb-2">
      {notice}
      <div className="mb-1 flex items-center gap-2">
        <span className="text-xs text-slate-500">
          {label} · {body.length.toLocaleString()}자{truncated ? " (잘림)" : ""}
        </span>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded bg-slate-200 px-2 py-0.5 text-xs hover:bg-slate-300"
        >
          전체 보기
        </button>
      </div>
      <pre className="whitespace-pre-wrap break-all rounded bg-white p-2 text-xs">
        {body.slice(0, INLINE_PREVIEW_CHARS)}…
      </pre>
      <Modal open={open} onClose={() => setOpen(false)} title={label}>
        <BodyViewer body={body} truncated={truncated} />
      </Modal>
    </div>
  );
}
```

> `useMemo` is already imported (line 1). Keep `INLINE_PREVIEW_CHARS` and `Modal` as-is.

- [ ] **Step 7: Add an optional tree toggle to `BodyViewer`**

Extend `BodyViewer` to accept an optional pre-parsed `value` + `onExtract`; when present add a "트리" toolbar toggle that swaps the `<pre>` for `<ResponseBodyTree>`:

```tsx
function BodyViewer({
  body,
  truncated,
  value,
  onExtract,
}: {
  body: string;
  truncated: boolean;
  value?: unknown;
  onExtract?: (extract: Extract) => void;
}) {
  const [formatted, setFormatted] = useState(false);
  const [wrap, setWrap] = useState(true);
  const [copied, setCopied] = useState(false);
  const [tree, setTree] = useState(value !== undefined && onExtract !== undefined);
  // ... keep existing pretty/text/copy logic unchanged ...
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {truncated && (
        <div className="rounded bg-amber-100 px-3 py-2 text-xs text-amber-800">
          1 MiB에서 잘림 — 실제 응답은 더 큼
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {/* keep 복사 / JSON 포맷 / 줄바꿈 buttons unchanged */}
        {value !== undefined && onExtract !== undefined && (
          <button
            type="button"
            aria-pressed={tree}
            onClick={() => setTree((t) => !t)}
            className="rounded bg-slate-200 px-2 py-0.5 text-xs hover:bg-slate-300"
          >
            {tree ? "원본" : "트리"}
          </button>
        )}
      </div>
      {tree && value !== undefined && onExtract !== undefined ? (
        <div className="min-h-0 flex-1 overflow-auto">
          <ResponseBodyTree value={value} onCreate={onExtract} />
        </div>
      ) : (
        <pre className={[/* keep existing pre classes */].join(" ")}>{text}</pre>
      )}
    </div>
  );
}
```

> Keep the existing `pretty`/`text`/`copy`/`useEffect(copied)` logic and the 복사/JSON 포맷/줄바꿈 buttons exactly; only add the `tree` state, the 트리 toggle button, and the conditional render. Default `tree` to true when extraction is available (so the modal opens straight into the pickable tree).

- [ ] **Step 8: Wire `onAddExtract` in `TestRunSection` + add feedback**

In `ui/src/components/scenario/TestRunSection.tsx`, pass `onAddExtract` to `<TestRunPanel>` and surface a one-line "추가됨" confirmation. Import the store and a small state:

```tsx
import { useScenarioEditor } from "../../scenario/store";
// ... inside the component:
const [addedNote, setAddedNote] = useState<string | null>(null);
// ... in the JSX where <TestRunPanel ... /> is rendered:
<TestRunPanel
  trace={...}
  steps={...}
  onAddExtract={(stepId, extract) => {
    useScenarioEditor.getState().addStepExtract(stepId, extract);
    setAddedNote(`추출 추가됨 — ${extract.var} (Inspector·YAML에서 확인)`);
  }}
/>
{addedNote && (
  <div role="status" className="mt-1 text-xs text-emerald-700">
    {addedNote}
  </div>
)}
```

> Find the existing `<TestRunPanel ... />` mount in TestRunSection and add the `onAddExtract` prop + the `role="status"` note. `useState` is already imported there (it owns picker state per ui/CLAUDE.md). Keep all existing props (`trace`, `steps`).

- [ ] **Step 9: Run tests to verify they pass**

Run: `cd ui && pnpm test TestRunPanel`
Expected: PASS — both the existing `TestRunPanel.test.tsx` and the new `TestRunPanel.extract.test.tsx` (adjust any existing test that asserted raw inline body text for a JSON response — those bodies now render as a tree only when `onAddExtract` is passed; the existing tests pass no `onAddExtract`, so raw rendering is unchanged and they should still pass).

- [ ] **Step 10: Full suite + lint/build + commit**

```bash
cd ui && pnpm lint && pnpm test && pnpm build && cd ..
git add ui/src/components/scenario/TestRunPanel.tsx ui/src/components/scenario/TestRunSection.tsx ui/src/components/scenario/__tests__/TestRunPanel.extract.test.tsx
git commit -m "feat(ui): test-run 패널 extract affordance 배선 — 본문 트리·헤더/쿠키/상태·store (R1,R3,R4,R5,R7)"
```

**Acceptance (R1, R3, R4, R5, R7):** 본문 필드/헤더/쿠키/상태 클릭→`onAddExtract(step_id, extract)` 정확, 잘림/비-JSON→트리 없음+안내·헤더 가능, `onAddExtract` 없으면 affordance 0(back-compat), 전체 스위트 green.

---

## Task 5: 문서 정정 — `ui/CLAUDE.md` (spec §4.6)

**Files:**
- Modify: `ui/CLAUDE.md`

- [ ] **Step 1: Fix the stale Slice-3 note + add the test-run trap**

In `ui/CLAUDE.md`:
- Find the "YAML 양방향 sync" 섹션의 **"extract 키 보존 (Slice 3)"** 항목. 그 문장이 "TS 모델(ScenarioModel)은 `.strict()`로 extract를 거부 ... normalizeForModel이 ... 떨군다"라고 돼 있다. **정정**: Slice 4가 `extract`를 `HttpStepModel`의 실제 필드로 wired했고(`model.ts:93`), `addStepExtract`(응답기반 작성)가 `setStepExtract` edit을 재사용한다. 한 줄로 갱신:

```
- **`extract` 키는 모델 1급 필드(Slice 4)** (응답기반 extract 작성): `HttpStepModel.extract`(`model.ts:93`)·`ExtractModel`(`from` discriminated)·`setStepExtract` edit(`yamlDoc.ts:413`, 전체 노드 replace=형제 주석만 보존)이 실재. `addStepExtract`(store)는 pending 버퍼 선커밋 후 현재 스텝 extract에 append→`setStepExtract` 재사용(파싱불가 버퍼/미존재 스텝 no-op). (이전 Slice-3 "normalizeForModel이 extract를 떨군다" 노트는 superseded.)
```

- "시나리오 에디터 test-run 패널 (C-2, `TestRunPanel`)" 섹션에 한 줄 추가:

```
- **응답기반 extract 작성은 `onAddExtract` prop 경유** (응답기반 extract 작성): `TestRunPanel`은 프레젠테이셔널 유지 — 부모 `TestRunSection`이 `onAddExtract={(id,ex)=>useScenarioEditor.getState().addStepExtract(id,ex)}`로 store 연결. 본문 트리(`ResponseBodyTree`)는 **응답 본문이 valid JSON && !truncated일 때만**(짧으면 BodyBlock 인라인, 길면 BodyViewer 모달 트리 토글), 스칼라 leaf만 +추출. 헤더/쿠키/상태는 응답 측 HeaderTable/버튼만(요청 측 affordance 없음). 생성 JSONPath는 `jsonPath.ts`(RFC 9535, 제어문자 `\uXXXX` — serde_json_path가 raw 제어문자 거부). 확인행(`ExtractConfirmRow`)은 평범한 인라인 JSX(중첩 Modal/HelpTip 금지 — ESC 함정).
```

- [ ] **Step 2: Commit (docs-only, fast-path)**

```bash
git add ui/CLAUDE.md
git commit -m "docs(ui): extract 모델 필드 노트 정정(Slice4) + 응답기반 작성 함정"
```

**Acceptance:** stale 노트 정정, test-run 함정 1줄 추가.

---

## Task 6: 라이브 검증 (R10) — orchestrator/`/live-verify`

> production diff 0이 아님(엔진 path 수용을 닫아야 함) → **머지 전 필수**. subagent가 아니라 orchestrator가 `/live-verify` 스택으로 직접 수행.

- [ ] **Step 1: 워크트리 자체 바이너리 빌드 + 에코 응답기**

`cd ui && pnpm build`로 `ui/dist` 갱신. `cargo build -p handicap-worker --bin worker && cargo build -p handicap-controller --bin controller`. 50ms 단순 200-responder 대신 **요청 경로/본문을 JSON으로 에코**하거나, 토큰을 본문에 실어 주는 작은 python 응답기(예: `GET /login` → `{"data":{"token":"T-<n>"},"weird.key":"W"}`, `POST /use` → 받은 헤더/`{{token}}`를 본문에 echo). `./target/debug/controller --db /tmp/extract-verify.db --ui-dir ui/dist`.

- [ ] **Step 2: 2스텝 시나리오 test-run → 필드 클릭 → 추출 → 재실행**

Playwright(인라인 `browser_evaluate`/`browser_snapshot`, 저장경로 의존 회피)로: `/scenarios/new`(또는 저장 시나리오) 에디터에서 ① 로그인 스텝 test-run "미리 1회 실행" → ② 응답 트리에서 `token`(그리고 특수문자 키 1건, 예 `weird.key`) +추출 → 변수명 확인 → 추가 → ③ YAML 탭에 `extract:`/`$.data.token`/`$['weird.key']` 반영 확인 → ④ 두 번째 스텝이 `{{token}}`을 쓰도록 두고 재실행 → `extracted` 칩에 token 값, 다음 스텝 본문 echo에 토큰 전달 확인. **콘솔 Zod 0**.

- [ ] **Step 3: 정리**

`rm -rf .playwright-mcp` + 루트 png 정리(머지 전 untracked 잔류 방지), responder/controller 종료, `/tmp/extract-verify.db` 삭제.

**Acceptance (R10):** 생성 JSONPath(`$.data.token` + 특수문자 키)가 엔진에서 수용·해석되어 다음 스텝에 변수 전달. path-format↔serde_json_path parity end-to-end 입증.

---

## Self-Review (writing-plans)

- **Spec coverage**: R1(Task3·4)·R2(Task1)·R3(Task4)·R4(Task2·4)·R5(Task4)·R6(Task3)·R7(Task2·4)·R8(Task1·3)·R9(전 task UI-only)·R10(Task6 라이브)·R11(Task3 ExtractConfirmRow). 전 R 커버.
- **Placeholder scan**: 모든 step에 실제 코드/명령. Task4 Set-Cookie 행은 closure에서 row-key를 인덱스로 resolve(`resp.set_cookies[Number(k)]`)하는 **단일 경로**(테스트가 `session 추출` accname 강제).
- **Type consistency**: `Extract`(model)·`Segment`(jsonPath)·`addStepExtract(stepId,extract)`·`onAddExtract(stepId,extract)`·`onCreate(extract)`·`onExtract(name)` 시그니처 task 간 일치. `withVar`가 discriminant 보존(tsc-b 안전).
- **알려진 위험**: Task4는 기존 `TestRunPanel.test.tsx`를 깰 수 있음 — JSON 응답 본문이 트리로 바뀌는 건 `onAddExtract` 전달 시뿐이라 기존 테스트(prop 미전달)는 raw 유지. Step9에서 확인.

<!-- spec-plan-reviewer: spec 2라운드 + plan 3라운드 → clean APPROVE (R2/R10 serde_json_path 0.7.2 parity empirically verified) -->
REVIEW-GATE: APPROVED
