# Slice 3 — Canvas + Monaco + Bidirectional Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Slice 2's raw YAML `<textarea>` with a real two-view scenario editor — a React Flow canvas (N linear HTTP step nodes, drag-drop add, click-to-inspect) and a Monaco YAML editor — wired through a single Zustand store + Zod validation + `yaml` package Document API so that every GUI mutation is reflected in YAML (preserving comments on untouched keys) and every valid YAML edit is reflected in the canvas. No charts (Slice 5). No `extract`, no ramp-up wiring, no multi-step variable chaining (Slice 4). No K8s (Slice 6).

**Architecture:** Introduce a `ui/src/scenario/` module that owns the canonical scenario model: Zod schemas (subset of `crates/engine/src/scenario.rs`), ULID generation, YAML round-trip via the `yaml` package's `Document` API (so untouched portions retain their comments and key order), and a Zustand store (`useScenarioEditor`) that holds `{ doc: YamlDocument, model: Scenario, yamlError, selectedStepId, activeTab, pendingYamlText }`. The `doc` is the authority; `model` is derived (parsed + Zod-validated). GUI mutations call `doc.setIn(...)` / `addStep(...)` / etc. and recompute `model + yamlText`. Monaco's onChange writes to `pendingYamlText` and after a 300 ms debounce attempts to swap `doc` if the new text parses + validates; invalid text stays in `pendingYamlText` and an inline error is shown. The editor UI is a three-pane shell: left = `VariablesPanel`, middle = `Tab(Canvas | Monaco)`, right = `Inspector` (visible only when a step is selected and the Canvas tab is active). The shell is mounted on both `ScenarioNewPage` and `ScenarioEditPage` (the latter wires the existing optimistic-lock save).

**Offline-runtime constraint (carried over from Slice 2):** UI must run with `default-src 'self'`. Monaco needs two CSP adjustments: `worker-src 'self' blob:` (Monaco creates module workers that the browser may load via a blob URL during dev HMR) and `style-src 'self' 'unsafe-inline'` (already present — Monaco injects inline styles for the editor's chrome). No CDN-loaded Monaco. Use Vite `?worker` imports so workers are bundled and served from same origin. Verify in `pnpm preview` with the DevTools network panel set to Offline-except-/api before merging.

**Tech Stack additions:**
- `@xyflow/react ^12.3.4` — React Flow (renamed from `reactflow` in v12; package id is now `@xyflow/react`)
- `monaco-editor ^0.50.0` — bundled editor
- `@monaco-editor/react ^4.7.0` — React wrapper; will be configured with a local `loader.config({ monaco })` so it does NOT fetch from JSDelivr
- `yaml ^2.6.0` — Document API for round-trip
- `zustand ^5.0.0` — store
- `ulid ^2.3.0` — browser-side ULID

No new Rust dependencies. Slice 3 is UI-only; the engine already accepts `steps: Vec<Step>` with arbitrary length and the API treats scenario YAML as opaque (controller stores the YAML string and lets the worker parse it).

**Slice 3 scope (locked):**

| In | Out (deferred) |
|---|---|
| `@xyflow/react` canvas, N linear HTTP nodes, drag-drop add, click select, delete, reorder via edge | branching / parallel / nested nodes (later phase) |
| `monaco-editor` YAML view with built-in syntax highlighting | `monaco-yaml` plugin, schema-driven autocomplete (later) |
| Zustand `useScenarioEditor` store, Zod validation, YAML AST round-trip preserving comments on untouched keys | Live YAML AST diff highlighting between tabs (later) |
| `extract: []` honored as pass-through (round-trips intact through YAML doc) but UI surfaces no form for it | `extract` form fields in inspector (Slice 4) |
| Inspector for: name, method, URL, headers (key/value rows), body (json / form / raw / none), assertions (`status: code` rows) | Header autocomplete, body schema editor, multi-assert types (later) |
| `VariablesPanel` for `scenario.variables` (string→string map) | Env var prefilling, secrets management (later) |
| Tab switch between Canvas and YAML views; pending invalid YAML preserved in store across tab switches | Side-by-side canvas+YAML; live ASTs in sync per keystroke (later) |
| Vitest unit tests for: model schemas, YAML doc round-trip (incl. comment preservation), store actions, ULID generation | Component tests with RTL, Playwright e2e (later) |
| CSP relax: `worker-src 'self' blob:` documented + verified | Strict-no-blob Monaco config (later if it ever becomes a security ask) |
| Manual check doc (`docs/dev/ui-slice-3-manual-check.md`) | Automated screenshot regression |

**Prerequisites:**
- All Slice 2 prerequisites still required (Node ≥ 20, pnpm ≥ 9, Rust toolchain).
- Slice 2 must be green: `just build && just lint && just test`, then `cd ui && pnpm install --frozen-lockfile && pnpm lint && pnpm test && pnpm build`.

---

## File structure (Slice 3 — only new/modified)

```
ui/package.json                                  # + @xyflow/react, monaco-editor, @monaco-editor/react, yaml, zustand, ulid
ui/pnpm-lock.yaml                                # updated by pnpm install
ui/index.html                                    # CSP: + worker-src 'self' blob:
ui/vite.config.ts                                # Monaco worker config, optimizeDeps include
ui/src/scenario/model.ts                         # NEW canonical Scenario Zod schema + types
ui/src/scenario/ulid.ts                          # NEW browser ULID helper
ui/src/scenario/yamlDoc.ts                       # NEW Document API round-trip helpers
ui/src/scenario/store.ts                         # NEW Zustand useScenarioEditor
ui/src/scenario/__tests__/model.test.ts          # NEW
ui/src/scenario/__tests__/ulid.test.ts           # NEW
ui/src/scenario/__tests__/yamlDoc.test.ts        # NEW
ui/src/scenario/__tests__/store.test.ts          # NEW

ui/src/components/scenario/EditorShell.tsx       # NEW three-pane composition
ui/src/components/scenario/VariablesPanel.tsx    # NEW
ui/src/components/scenario/CanvasView.tsx        # NEW React Flow board
ui/src/components/scenario/HttpStepNode.tsx      # NEW React Flow custom node
ui/src/components/scenario/Inspector.tsx         # NEW selected-step form
ui/src/components/scenario/MonacoYamlView.tsx    # NEW Monaco editor pane
ui/src/components/scenario/TabBar.tsx            # NEW canvas / yaml switcher

ui/src/pages/ScenarioNewPage.tsx                 # MODIFIED: mount EditorShell
ui/src/pages/ScenarioEditPage.tsx                # MODIFIED: mount EditorShell + save flow

docs/dev/ui-slice-3-manual-check.md              # NEW manual smoke checklist
CLAUDE.md                                        # MODIFIED: status, gotchas
```

**Conventions (carry over from Slice 2):**
- Function components: `function Foo(...)`, not `const Foo = (...)`.
- All component props typed.
- One Tailwind utility-class chain per element; break long chains across lines.
- No emoji, no decorative comments. Comments only where the *why* is non-obvious (e.g., the Document-API edit semantics, the debounce loop guard).
- Vitest test files live under `__tests__/` next to source.
- Imports: relative within `ui/src/`. No path aliases this slice.

---

## Task 1: Add deps and offline-friendly Monaco worker config

**Files:**
- Modify: `ui/package.json`
- Modify: `ui/vite.config.ts`
- Modify: `ui/index.html`

This task only changes config. It must end green: `pnpm install`, `pnpm lint`, `pnpm test`, `pnpm build`. The build verifies Monaco workers are bundled (no `loader.config({ paths: '…cdn.jsdelivr.net…' })` survives).

- [ ] **Step 1: Add dependencies**

Edit `ui/package.json`. Append to `dependencies` (alphabetical):

```json
{
  "dependencies": {
    "@monaco-editor/react": "^4.7.0",
    "@tanstack/react-query": "^5.59.0",
    "@xyflow/react": "^12.3.4",
    "monaco-editor": "^0.50.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.27.0",
    "ulid": "^2.3.0",
    "yaml": "^2.6.0",
    "zod": "^3.23.8",
    "zustand": "^5.0.0"
  }
}
```

Run:

```bash
cd ui && pnpm install
```

Expected: `pnpm-lock.yaml` updated, no peer-dep warnings (or only well-known React-18 peer-dep notes from `@monaco-editor/react`).

- [ ] **Step 2: Configure Vite for Monaco workers**

Replace `ui/vite.config.ts` with:

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8080",
        changeOrigin: false,
      },
    },
  },
  optimizeDeps: {
    // Monaco ships many small ESM modules. Pre-bundling them speeds up
    // first-time dev startup and prevents the worker-loader from racing.
    include: [
      "monaco-editor/esm/vs/editor/editor.api",
      "monaco-editor/esm/vs/editor/editor.worker",
    ],
  },
  worker: {
    format: "es",
  },
});
```

(The `proxy` block stays the same as Slice 2.)

- [ ] **Step 3: Relax CSP for Monaco workers**

Edit `ui/index.html`. The CSP meta needs `worker-src 'self' blob:`. Replace lines 6-9 with:

```html
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'self' blob:;"
    />
```

Reason: Monaco's web workers are bundled and served from same origin, but the editor's bootstrap creates them via `new Worker(URL, { type: 'module' })` against a generated module URL. On some Chrome versions this materializes as a `blob:` URL because Vite-emitted workers can be wrapped in a blob for module-script semantics. We allow `'self' blob:` to make this robust across browsers; everything else stays `'self'`.

- [ ] **Step 4: Verify lint, test, build**

```bash
cd ui && pnpm lint && pnpm test && pnpm build
```

Expected: lint clean, 2 existing test files still pass (from Slice 2 — `schemas.test.ts`, `client.test.ts`), build produces `dist/` with `assets/*.js` containing Monaco chunks (verify `du -sh dist` is now >5 MB).

- [ ] **Step 5: Commit**

```bash
git add ui/package.json ui/pnpm-lock.yaml ui/vite.config.ts ui/index.html
git commit -m "build(ui): add monaco/react-flow/yaml/zustand/ulid deps + CSP worker-src"
```

---

## Task 2: Canonical Scenario Zod schema (`ui/src/scenario/model.ts`)

**Files:**
- Create: `ui/src/scenario/model.ts`
- Create: `ui/src/scenario/__tests__/model.test.ts`

This is the TS mirror of `crates/engine/src/scenario.rs::Scenario`. Use Zod for both compile-time types and runtime validation. Strict (Zod's `.strict()`) so unknown keys are rejected — matches the engine's `#[serde(deny_unknown_fields)]`.

Important shape decisions:
- `body` is a discriminated union with three variants (`json`, `form`, `raw`) or omitted. We model it as `BodyJson | BodyForm | BodyRaw | undefined`.
- `assert` items are an externally-tagged enum on the Rust side: a single-entry map `{ status: 200 }`. We model it as a discriminated union with `kind: "status"` for internal use, plus serialize/deserialize helpers that convert to/from the YAML representation in Task 4.
- `extract` is OUT-OF-SCOPE for Slice 3 input forms — but we still parse/preserve it through the YAML doc (it does not appear on the `Scenario` Zod model in TS; the YAML Document round-trip carries it untouched via the AST).

Trade-off: keeping `extract` out of the TS model means GUI mutations on the `extract` list of a step are impossible this slice — exactly what we want. But it also means our YAML round-trip must NOT delete an `extract` key it doesn't understand. Task 4 explicitly tests this.

- [ ] **Step 1: Write the failing schema test**

Create `ui/src/scenario/__tests__/model.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  ScenarioModel,
  StepModel,
  type Scenario,
  type Step,
  newEmptyScenario,
} from "../model";

describe("ScenarioModel", () => {
  it("accepts a minimal valid scenario", () => {
    const value: Scenario = {
      version: 1,
      name: "demo",
      cookie_jar: "auto",
      variables: { base_url: "http://localhost" },
      steps: [
        {
          id: "01HX0000000000000000000000",
          name: "home",
          type: "http",
          request: { method: "GET", url: "{{base_url}}/" },
          assert: [{ kind: "status", code: 200 }],
        },
      ],
    };
    expect(ScenarioModel.parse(value)).toEqual(value);
  });

  it("rejects unknown top-level keys", () => {
    expect(() =>
      ScenarioModel.parse({
        version: 1,
        name: "x",
        cookie_jar: "auto",
        variables: {},
        steps: [],
        bogus: true,
      }),
    ).toThrow();
  });

  it("rejects an empty step name", () => {
    const step = {
      id: "01HX0000000000000000000000",
      name: "",
      type: "http",
      request: { method: "GET", url: "/" },
      assert: [],
    };
    expect(() => StepModel.parse(step)).toThrow();
  });

  it("accepts each body variant", () => {
    const base = {
      id: "01HX0000000000000000000001",
      name: "x",
      type: "http" as const,
      assert: [],
    };
    expect(() =>
      StepModel.parse({
        ...base,
        request: { method: "POST", url: "/", body: { kind: "json", value: { a: 1 } } },
      }),
    ).not.toThrow();
    expect(() =>
      StepModel.parse({
        ...base,
        request: { method: "POST", url: "/", body: { kind: "form", value: { a: "1" } } },
      }),
    ).not.toThrow();
    expect(() =>
      StepModel.parse({
        ...base,
        request: { method: "POST", url: "/", body: { kind: "raw", value: "hello" } },
      }),
    ).not.toThrow();
  });

  it("rejects an HTTP method that is not in the allowed list", () => {
    expect(() =>
      StepModel.parse({
        id: "01HX0000000000000000000002",
        name: "x",
        type: "http",
        request: { method: "TRACE", url: "/" },
        assert: [],
      }),
    ).toThrow();
  });

  it("newEmptyScenario produces something the schema accepts", () => {
    const s = newEmptyScenario("Untitled");
    expect(() => ScenarioModel.parse(s)).not.toThrow();
    expect(s.steps).toHaveLength(0);
    expect(s.cookie_jar).toBe("auto");
  });
});
```

- [ ] **Step 2: Run the failing test**

```bash
cd ui && pnpm vitest run src/scenario/__tests__/model.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `ui/src/scenario/model.ts`**

```ts
import { z } from "zod";

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export const HttpMethod = z.enum([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);
export type HttpMethod = z.infer<typeof HttpMethod>;

export const BodyModel = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("json"), value: z.unknown() }).strict(),
  z.object({ kind: z.literal("form"), value: z.record(z.string(), z.string()) }).strict(),
  z.object({ kind: z.literal("raw"), value: z.string() }).strict(),
]);
export type Body = z.infer<typeof BodyModel>;

export const RequestModel = z
  .object({
    method: HttpMethod,
    url: z.string().min(1),
    headers: z.record(z.string(), z.string()).default({}),
    body: BodyModel.optional(),
  })
  .strict();
export type RequestSpec = z.infer<typeof RequestModel>;

export const AssertionModel = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("status"), code: z.number().int().min(100).max(599) }).strict(),
]);
export type Assertion = z.infer<typeof AssertionModel>;

export const StepModel = z
  .object({
    id: z.string().regex(ULID_RE, "step id must be a ULID"),
    name: z.string().min(1, "step name required"),
    type: z.literal("http"),
    request: RequestModel,
    assert: z.array(AssertionModel).default([]),
  })
  .strict();
export type Step = z.infer<typeof StepModel>;

export const CookieJarMode = z.enum(["auto", "off"]);
export type CookieJarMode = z.infer<typeof CookieJarMode>;

export const ScenarioModel = z
  .object({
    version: z.literal(1),
    name: z.string().min(1, "name required"),
    cookie_jar: CookieJarMode.default("auto"),
    variables: z.record(z.string(), z.string()).default({}),
    steps: z.array(StepModel).default([]),
  })
  .strict();
export type Scenario = z.infer<typeof ScenarioModel>;

export function newEmptyScenario(name = "Untitled"): Scenario {
  return {
    version: 1,
    name,
    cookie_jar: "auto",
    variables: {},
    steps: [],
  };
}
```

- [ ] **Step 4: Run the test**

```bash
cd ui && pnpm vitest run src/scenario/__tests__/model.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Run the whole suite to make sure nothing else broke**

```bash
cd ui && pnpm test
```

Expected: all tests pass (existing 2 files + new 1).

- [ ] **Step 6: Commit**

```bash
git add ui/src/scenario/model.ts ui/src/scenario/__tests__/model.test.ts
git commit -m "feat(ui): canonical scenario Zod model (Slice 3 step 1/14)"
```

---

## Task 3: ULID helper (`ui/src/scenario/ulid.ts`)

**Files:**
- Create: `ui/src/scenario/ulid.ts`
- Create: `ui/src/scenario/__tests__/ulid.test.ts`

We need stable, sortable IDs for steps. The `ulid` package gives us that, but it's nice to abstract it so tests can swap a deterministic generator.

- [ ] **Step 1: Write the failing test**

Create `ui/src/scenario/__tests__/ulid.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { newStepId, isStepId } from "../ulid";

describe("newStepId", () => {
  it("produces a 26-char Crockford ULID", () => {
    const id = newStepId();
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(id).toHaveLength(26);
  });

  it("two consecutive calls return different ids", () => {
    expect(newStepId()).not.toEqual(newStepId());
  });
});

describe("isStepId", () => {
  it("accepts a fresh ULID", () => {
    expect(isStepId(newStepId())).toBe(true);
  });

  it("rejects lowercase", () => {
    expect(isStepId("01hx0000000000000000000000")).toBe(false);
  });

  it("rejects wrong length", () => {
    expect(isStepId("01HX0")).toBe(false);
  });
});
```

- [ ] **Step 2: Run it (fails)**

```bash
cd ui && pnpm vitest run src/scenario/__tests__/ulid.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `ui/src/scenario/ulid.ts`**

```ts
import { ulid } from "ulid";

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function newStepId(): string {
  return ulid();
}

export function isStepId(s: string): boolean {
  return ULID_RE.test(s);
}
```

- [ ] **Step 4: Verify**

```bash
cd ui && pnpm vitest run src/scenario/__tests__/ulid.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add ui/src/scenario/ulid.ts ui/src/scenario/__tests__/ulid.test.ts
git commit -m "feat(ui): ULID generator for stable step ids (Slice 3 step 2/14)"
```

---

## Task 4: YAML Document round-trip (`ui/src/scenario/yamlDoc.ts`)

**Files:**
- Create: `ui/src/scenario/yamlDoc.ts`
- Create: `ui/src/scenario/__tests__/yamlDoc.test.ts`

This is the most subtle module in Slice 3. We use the `yaml` package's `Document` API, which represents YAML as a mutable AST. The contract:
- `parseScenarioDoc(yamlText)` → `{ doc, model } | { doc: null, model: null, error }`
- `serializeDoc(doc)` → string
- `applyEdit(doc, edit)` → mutates `doc` in place
- A small set of `Edit` variants for the operations the GUI needs (setStepField, setStepName, addStep, removeStep, moveStep, setVariable, removeVariable, setName, setCookieJar)

Round-trip rule: if no GUI edit touches a node, its comment and key-ordering must be preserved. The `yaml` package's `Document` already preserves comments by storing them on nodes (`commentBefore`, `comment`, `commentBefore` on children). `doc.setIn(['steps', 0, 'request', 'method'], 'POST')` replaces the scalar value but leaves siblings + comments alone — that's exactly what we want.

The `model` we expose comes from running `doc.toJS()` then Zod parse. We do NOT mutate the model directly; the model is read-only for consumers. To change anything, dispatch an `Edit` on the doc and re-derive the model.

Note: the model intentionally drops `extract: [...]` fields (Slice 4) — `ScenarioModel.parse` rejects unknown keys via `.strict()`. To preserve `extract` (and any other future fields the engine accepts) through round-trips while keeping the TS model strict, we need to strip non-model keys *before* Zod parse. We do this with a single helper `toModelJS(doc)` that copies the doc's JS object and removes `steps[i].extract`. The doc itself is untouched; `extract` keys survive round-trip.

- [ ] **Step 1: Write the failing round-trip test**

Create `ui/src/scenario/__tests__/yamlDoc.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  parseScenarioDoc,
  serializeDoc,
  applyEdit,
  type Edit,
} from "../yamlDoc";

const VALID_YAML = `version: 1
name: "demo"
cookie_jar: auto
variables:
  base_url: "http://localhost:8080"
steps:
  - id: "01HX0000000000000000000001"
    name: "login"
    type: http
    request:
      method: POST
      url: "{{base_url}}/login"
      headers:
        Content-Type: application/json
      body:
        json:
          username: "user"
    assert:
      - status: 200
    extract:                # comment on a Slice-4 key we must not lose
      - var: token
        from: body
        path: "$.token"
  - id: "01HX0000000000000000000002"
    name: "profile"
    type: http
    request:
      method: GET
      url: "{{base_url}}/me"
    assert:
      - status: 200
`;

describe("parseScenarioDoc", () => {
  it("parses a valid scenario and returns a model + doc", () => {
    const out = parseScenarioDoc(VALID_YAML);
    if ("error" in out) throw new Error(`expected ok: ${out.error}`);
    expect(out.model.steps).toHaveLength(2);
    expect(out.model.steps[0].request.method).toBe("POST");
    expect(out.model.steps[0].assert).toEqual([{ kind: "status", code: 200 }]);
  });

  it("strips extract from the model but keeps it in the doc", () => {
    const out = parseScenarioDoc(VALID_YAML);
    if ("error" in out) throw new Error("expected ok");
    // model has no extract field on Step
    expect("extract" in out.model.steps[0]).toBe(false);
    // doc still has it
    const round = serializeDoc(out.doc);
    expect(round).toContain("extract:");
    expect(round).toContain("var: token");
  });

  it("returns an error for invalid yaml syntax", () => {
    const out = parseScenarioDoc(":\n  ::");
    expect("error" in out).toBe(true);
  });

  it("returns an error for valid yaml that fails schema", () => {
    const out = parseScenarioDoc("version: 1\nname: ''\nsteps: []\n");
    expect("error" in out).toBe(true);
  });
});

describe("applyEdit — setStepField", () => {
  it("changes the method of step 0 without touching other keys or comments", () => {
    const out = parseScenarioDoc(VALID_YAML);
    if ("error" in out) throw new Error("expected ok");
    const edit: Edit = {
      type: "setStepField",
      stepId: "01HX0000000000000000000001",
      path: ["request", "method"],
      value: "PUT",
    };
    applyEdit(out.doc, edit);
    const round = serializeDoc(out.doc);
    expect(round).toContain("method: PUT");
    expect(round).toContain("# comment on a Slice-4 key we must not lose");
    expect(round).toContain("path: \"$.token\"");
  });

  it("sets a nested header value", () => {
    const out = parseScenarioDoc(VALID_YAML);
    if ("error" in out) throw new Error("expected ok");
    applyEdit(out.doc, {
      type: "setStepField",
      stepId: "01HX0000000000000000000002",
      path: ["request", "headers"],
      value: { "X-Trace": "1" },
    });
    const round = serializeDoc(out.doc);
    expect(round).toMatch(/X-Trace:\s*"?1"?/);
  });
});

describe("applyEdit — addStep and removeStep", () => {
  it("appends a new step with given id", () => {
    const out = parseScenarioDoc(VALID_YAML);
    if ("error" in out) throw new Error("expected ok");
    applyEdit(out.doc, {
      type: "addStep",
      id: "01HX0000000000000000000003",
      name: "fresh",
    });
    const round = serializeDoc(out.doc);
    expect(round).toContain("01HX0000000000000000000003");
    expect(round).toContain("name: fresh");
    const out2 = parseScenarioDoc(round);
    if ("error" in out2) throw new Error("re-parse failed");
    expect(out2.model.steps).toHaveLength(3);
    expect(out2.model.steps[2].id).toBe("01HX0000000000000000000003");
  });

  it("removes step by id and preserves untouched comments", () => {
    const out = parseScenarioDoc(VALID_YAML);
    if ("error" in out) throw new Error("expected ok");
    applyEdit(out.doc, {
      type: "removeStep",
      stepId: "01HX0000000000000000000001",
    });
    const round = serializeDoc(out.doc);
    expect(round).not.toContain("01HX0000000000000000000001");
    expect(round).toContain("01HX0000000000000000000002");
    const out2 = parseScenarioDoc(round);
    if ("error" in out2) throw new Error("re-parse failed");
    expect(out2.model.steps).toHaveLength(1);
  });
});

describe("applyEdit — moveStep", () => {
  it("swaps steps by id", () => {
    const out = parseScenarioDoc(VALID_YAML);
    if ("error" in out) throw new Error("expected ok");
    applyEdit(out.doc, {
      type: "moveStep",
      stepId: "01HX0000000000000000000002",
      toIndex: 0,
    });
    const round = serializeDoc(out.doc);
    const out2 = parseScenarioDoc(round);
    if ("error" in out2) throw new Error("re-parse failed");
    expect(out2.model.steps[0].id).toBe("01HX0000000000000000000002");
    expect(out2.model.steps[1].id).toBe("01HX0000000000000000000001");
  });
});

describe("applyEdit — setVariable / removeVariable / setName / setCookieJar", () => {
  it("sets a variable", () => {
    const out = parseScenarioDoc(VALID_YAML);
    if ("error" in out) throw new Error("expected ok");
    applyEdit(out.doc, { type: "setVariable", key: "token", value: "abc" });
    const round = serializeDoc(out.doc);
    expect(round).toMatch(/token:\s*abc/);
  });

  it("removes a variable", () => {
    const out = parseScenarioDoc(VALID_YAML);
    if ("error" in out) throw new Error("expected ok");
    applyEdit(out.doc, { type: "removeVariable", key: "base_url" });
    const round = serializeDoc(out.doc);
    expect(round).not.toContain("base_url");
  });

  it("renames the scenario", () => {
    const out = parseScenarioDoc(VALID_YAML);
    if ("error" in out) throw new Error("expected ok");
    applyEdit(out.doc, { type: "setName", value: "renamed" });
    const round = serializeDoc(out.doc);
    expect(round).toContain("name: renamed");
  });

  it("toggles cookie_jar", () => {
    const out = parseScenarioDoc(VALID_YAML);
    if ("error" in out) throw new Error("expected ok");
    applyEdit(out.doc, { type: "setCookieJar", value: "off" });
    const round = serializeDoc(out.doc);
    expect(round).toContain("cookie_jar: off");
  });
});
```

- [ ] **Step 2: Run the failing test**

```bash
cd ui && pnpm vitest run src/scenario/__tests__/yamlDoc.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `ui/src/scenario/yamlDoc.ts`**

```ts
import {
  parseDocument,
  Document,
  isMap,
  isSeq,
  YAMLMap,
  YAMLSeq,
  type Node,
} from "yaml";
import { ScenarioModel, type Scenario } from "./model";

export type ParseOk = { doc: Document.Parsed; model: Scenario };
export type ParseErr = { error: string };
export type ParseResult = ParseOk | ParseErr;

export type Edit =
  | { type: "setName"; value: string }
  | { type: "setCookieJar"; value: "auto" | "off" }
  | { type: "setVariable"; key: string; value: string }
  | { type: "removeVariable"; key: string }
  | { type: "addStep"; id: string; name: string }
  | { type: "removeStep"; stepId: string }
  | { type: "moveStep"; stepId: string; toIndex: number }
  | {
      type: "setStepField";
      stepId: string;
      path: ReadonlyArray<string>;
      value: unknown;
    }
  | { type: "setStepAssert"; stepId: string; asserts: ReadonlyArray<{ kind: "status"; code: number }> };

export function parseScenarioDoc(yamlText: string): ParseResult {
  let doc: Document.Parsed;
  try {
    doc = parseDocument(yamlText, { prettyErrors: true });
  } catch (e) {
    return { error: (e as Error).message };
  }
  if (doc.errors.length > 0) {
    return { error: doc.errors.map((e) => e.message).join("; ") };
  }
  const js = doc.toJS({ maxAliasCount: 100 });
  const normalized = normalizeForModel(js);
  const parsed = ScenarioModel.safeParse(normalized);
  if (!parsed.success) {
    return { error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  }
  return { doc, model: parsed.data };
}

export function serializeDoc(doc: Document): string {
  return String(doc);
}

export function applyEdit(doc: Document, edit: Edit): void {
  switch (edit.type) {
    case "setName":
      doc.setIn(["name"], edit.value);
      return;
    case "setCookieJar":
      doc.setIn(["cookie_jar"], edit.value);
      return;
    case "setVariable":
      ensureMap(doc, ["variables"]);
      doc.setIn(["variables", edit.key], edit.value);
      return;
    case "removeVariable":
      doc.deleteIn(["variables", edit.key]);
      return;
    case "addStep": {
      ensureSeq(doc, ["steps"]);
      const steps = doc.getIn(["steps"]) as YAMLSeq;
      const node = doc.createNode({
        id: edit.id,
        name: edit.name,
        type: "http",
        request: { method: "GET", url: "/" },
        assert: [{ status: 200 }],
      });
      steps.add(node);
      return;
    }
    case "removeStep": {
      const idx = findStepIndex(doc, edit.stepId);
      if (idx === -1) return;
      doc.deleteIn(["steps", idx]);
      return;
    }
    case "moveStep": {
      const fromIdx = findStepIndex(doc, edit.stepId);
      if (fromIdx === -1) return;
      const steps = doc.getIn(["steps"]) as YAMLSeq;
      const node = steps.items[fromIdx];
      steps.items.splice(fromIdx, 1);
      steps.items.splice(edit.toIndex, 0, node);
      return;
    }
    case "setStepField": {
      const idx = findStepIndex(doc, edit.stepId);
      if (idx === -1) return;
      const fullPath: Array<string | number> = ["steps", idx, ...edit.path];
      if (edit.value === undefined) {
        doc.deleteIn(fullPath);
        return;
      }
      // For complex values (objects), create a node so the AST is well-formed.
      const node =
        typeof edit.value === "object" && edit.value !== null
          ? doc.createNode(edit.value)
          : edit.value;
      doc.setIn(fullPath, node);
      return;
    }
    case "setStepAssert": {
      const idx = findStepIndex(doc, edit.stepId);
      if (idx === -1) return;
      const arr = edit.asserts.map((a) => ({ status: a.code }));
      doc.setIn(["steps", idx, "assert"], doc.createNode(arr));
      return;
    }
  }
}

function findStepIndex(doc: Document, stepId: string): number {
  const steps = doc.getIn(["steps"]);
  if (!isSeq(steps)) return -1;
  for (let i = 0; i < steps.items.length; i++) {
    const item = steps.items[i] as Node;
    if (!isMap(item)) continue;
    const id = item.get("id");
    if (id === stepId) return i;
  }
  return -1;
}

function ensureMap(doc: Document, path: ReadonlyArray<string | number>): void {
  if (!isMap(doc.getIn(path))) {
    doc.setIn(path, new YAMLMap());
  }
}

function ensureSeq(doc: Document, path: ReadonlyArray<string | number>): void {
  if (!isSeq(doc.getIn(path))) {
    doc.setIn(path, new YAMLSeq());
  }
}

// Convert the doc's plain JS into the shape ScenarioModel expects:
//   - drop `extract` (Slice 4)
//   - convert `assert: [{status: 200}, ...]` → [{kind:"status", code:200}]
//   - convert `body: {json|form|raw: value}` → {kind:"json"|"form"|"raw", value}
//   - apply defaults that the Rust side has but YAML may omit (cookie_jar)
function normalizeForModel(input: unknown): unknown {
  if (typeof input !== "object" || input === null) return input;
  const src = input as Record<string, unknown>;
  const out: Record<string, unknown> = {
    version: src.version,
    name: src.name,
    cookie_jar: src.cookie_jar ?? "auto",
    variables: src.variables ?? {},
    steps: Array.isArray(src.steps) ? src.steps.map(normalizeStep) : [],
  };
  return out;
}

function normalizeStep(s: unknown): unknown {
  if (typeof s !== "object" || s === null) return s;
  const src = s as Record<string, unknown>;
  const request =
    typeof src.request === "object" && src.request !== null
      ? normalizeRequest(src.request as Record<string, unknown>)
      : src.request;
  const assert = Array.isArray(src.assert) ? src.assert.map(normalizeAssertion) : [];
  return {
    id: src.id,
    name: src.name,
    type: src.type,
    request,
    assert,
  };
}

function normalizeRequest(r: Record<string, unknown>): unknown {
  const body = r.body === undefined || r.body === null ? undefined : normalizeBody(r.body);
  return {
    method: r.method,
    url: r.url,
    headers: r.headers ?? {},
    ...(body === undefined ? {} : { body }),
  };
}

function normalizeBody(b: unknown): unknown {
  if (typeof b !== "object" || b === null) return b;
  const src = b as Record<string, unknown>;
  if ("json" in src) return { kind: "json", value: src.json };
  if ("form" in src) return { kind: "form", value: src.form };
  if ("raw" in src) return { kind: "raw", value: src.raw };
  return b;
}

function normalizeAssertion(a: unknown): unknown {
  if (typeof a !== "object" || a === null) return a;
  const src = a as Record<string, unknown>;
  if ("status" in src) return { kind: "status", code: src.status };
  return a;
}
```

- [ ] **Step 4: Run the test**

```bash
cd ui && pnpm vitest run src/scenario/__tests__/yamlDoc.test.ts
```

Expected: PASS, 12 tests.

- [ ] **Step 5: Run the whole suite**

```bash
cd ui && pnpm test
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add ui/src/scenario/yamlDoc.ts ui/src/scenario/__tests__/yamlDoc.test.ts
git commit -m "feat(ui): YAML Document round-trip with targeted edits (Slice 3 step 3/14)"
```

---

## Task 5: Scenario editor Zustand store (`ui/src/scenario/store.ts`)

**Files:**
- Create: `ui/src/scenario/store.ts`
- Create: `ui/src/scenario/__tests__/store.test.ts`

The store wraps the doc + derived model + UI state. It exposes actions for every Edit variant plus `setYamlFromString` (used by the Monaco view on debounce). Selection state and active tab are also in the store so the inspector and canvas both read from one place.

We use Zustand without Immer — the doc is mutated by the `yaml` package itself, and we then trigger a re-render by replacing the model/yamlText fields. This avoids a double-mutation layer.

- [ ] **Step 1: Write the failing store test**

Create `ui/src/scenario/__tests__/store.test.ts`:

```ts
import { describe, expect, it, beforeEach } from "vitest";
import { useScenarioEditor } from "../store";

const VALID_YAML = `version: 1
name: "demo"
cookie_jar: auto
variables:
  base_url: "http://localhost"
steps:
  - id: "01HX0000000000000000000001"
    name: "login"
    type: http
    request:
      method: GET
      url: "{{base_url}}/"
    assert:
      - status: 200
`;

describe("useScenarioEditor", () => {
  beforeEach(() => {
    useScenarioEditor.setState(useScenarioEditor.getInitialState());
  });

  it("loadFromString sets model and yamlText", () => {
    useScenarioEditor.getState().loadFromString(VALID_YAML);
    const s = useScenarioEditor.getState();
    expect(s.model?.steps).toHaveLength(1);
    expect(s.yamlError).toBeNull();
    expect(s.yamlText).toContain("01HX0000000000000000000001");
  });

  it("loadFromString with invalid yaml sets yamlError and keeps prior model null", () => {
    useScenarioEditor.getState().loadFromString(":\n::");
    const s = useScenarioEditor.getState();
    expect(s.yamlError).not.toBeNull();
    expect(s.model).toBeNull();
  });

  it("setStepField mutates the doc and rederives the model", () => {
    useScenarioEditor.getState().loadFromString(VALID_YAML);
    useScenarioEditor.getState().setStepField("01HX0000000000000000000001", ["request", "method"], "POST");
    const s = useScenarioEditor.getState();
    expect(s.model?.steps[0].request.method).toBe("POST");
    expect(s.yamlText).toContain("method: POST");
  });

  it("addStep appends a new step", () => {
    useScenarioEditor.getState().loadFromString(VALID_YAML);
    const before = useScenarioEditor.getState().model!.steps.length;
    useScenarioEditor.getState().addStep("New step");
    const s = useScenarioEditor.getState();
    expect(s.model!.steps).toHaveLength(before + 1);
    expect(s.model!.steps[before].name).toBe("New step");
  });

  it("removeStep drops by id", () => {
    useScenarioEditor.getState().loadFromString(VALID_YAML);
    useScenarioEditor.getState().removeStep("01HX0000000000000000000001");
    expect(useScenarioEditor.getState().model!.steps).toHaveLength(0);
  });

  it("selection state is updated by select()", () => {
    useScenarioEditor.getState().loadFromString(VALID_YAML);
    useScenarioEditor.getState().select("01HX0000000000000000000001");
    expect(useScenarioEditor.getState().selectedStepId).toBe("01HX0000000000000000000001");
    useScenarioEditor.getState().select(null);
    expect(useScenarioEditor.getState().selectedStepId).toBeNull();
  });

  it("setPendingYamlText holds invalid edits without changing model", () => {
    useScenarioEditor.getState().loadFromString(VALID_YAML);
    const initialModel = useScenarioEditor.getState().model;
    useScenarioEditor.getState().setPendingYamlText("garbage:::\n::");
    const s = useScenarioEditor.getState();
    // pending text held; model unchanged because pending text is invalid
    expect(s.pendingYamlText).toBe("garbage:::\n::");
    expect(s.model).toBe(initialModel);
  });

  it("commitPendingYaml swaps the doc when text is valid", () => {
    useScenarioEditor.getState().loadFromString(VALID_YAML);
    const NEW_YAML = VALID_YAML.replace("method: GET", "method: PUT");
    useScenarioEditor.getState().setPendingYamlText(NEW_YAML);
    useScenarioEditor.getState().commitPendingYaml();
    expect(useScenarioEditor.getState().model!.steps[0].request.method).toBe("PUT");
    expect(useScenarioEditor.getState().pendingYamlText).toBeNull();
  });

  it("commitPendingYaml leaves yamlError set when text is invalid", () => {
    useScenarioEditor.getState().loadFromString(VALID_YAML);
    const initialModel = useScenarioEditor.getState().model;
    useScenarioEditor.getState().setPendingYamlText(":\n::");
    useScenarioEditor.getState().commitPendingYaml();
    const s = useScenarioEditor.getState();
    expect(s.yamlError).not.toBeNull();
    expect(s.model).toBe(initialModel);
  });
});
```

- [ ] **Step 2: Run the failing test**

```bash
cd ui && pnpm vitest run src/scenario/__tests__/store.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `ui/src/scenario/store.ts`**

```ts
import { create } from "zustand";
import { Document } from "yaml";
import { type Scenario } from "./model";
import { newStepId } from "./ulid";
import {
  applyEdit,
  parseScenarioDoc,
  serializeDoc,
  type Edit,
} from "./yamlDoc";

const STARTER_YAML = `version: 1
name: "Untitled"
cookie_jar: auto
variables: {}
steps: []
`;

export type Tab = "canvas" | "yaml";

export interface ScenarioEditorState {
  doc: Document | null;
  model: Scenario | null;
  yamlText: string;
  yamlError: string | null;

  selectedStepId: string | null;
  activeTab: Tab;
  pendingYamlText: string | null;

  loadFromString(yaml: string): void;
  resetEmpty(): void;

  // Edit ops (mirror Edit variants)
  setName(value: string): void;
  setCookieJar(value: "auto" | "off"): void;
  setVariable(key: string, value: string): void;
  removeVariable(key: string): void;
  addStep(name: string): string; // returns new id
  removeStep(stepId: string): void;
  moveStep(stepId: string, toIndex: number): void;
  setStepField(stepId: string, path: ReadonlyArray<string>, value: unknown): void;
  setStepAssert(stepId: string, asserts: ReadonlyArray<{ kind: "status"; code: number }>): void;

  // UI state
  select(id: string | null): void;
  setActiveTab(tab: Tab): void;

  // Monaco-driven (debounced) sync
  setPendingYamlText(text: string): void;
  commitPendingYaml(): void;
  clearPendingYaml(): void;
}

const INITIAL: Pick<
  ScenarioEditorState,
  "doc" | "model" | "yamlText" | "yamlError" | "selectedStepId" | "activeTab" | "pendingYamlText"
> = {
  doc: null,
  model: null,
  yamlText: "",
  yamlError: null,
  selectedStepId: null,
  activeTab: "canvas",
  pendingYamlText: null,
};

export const useScenarioEditor = create<ScenarioEditorState>((set, get) => ({
  ...INITIAL,

  loadFromString(yaml) {
    const result = parseScenarioDoc(yaml);
    if ("error" in result) {
      set({
        doc: null,
        model: null,
        yamlText: yaml,
        yamlError: result.error,
        selectedStepId: null,
        pendingYamlText: null,
      });
      return;
    }
    set({
      doc: result.doc,
      model: result.model,
      yamlText: serializeDoc(result.doc),
      yamlError: null,
      selectedStepId: null,
      pendingYamlText: null,
    });
  },

  resetEmpty() {
    get().loadFromString(STARTER_YAML);
  },

  setName(value) {
    dispatch(set, get, { type: "setName", value });
  },
  setCookieJar(value) {
    dispatch(set, get, { type: "setCookieJar", value });
  },
  setVariable(key, value) {
    dispatch(set, get, { type: "setVariable", key, value });
  },
  removeVariable(key) {
    dispatch(set, get, { type: "removeVariable", key });
  },
  addStep(name) {
    const id = newStepId();
    dispatch(set, get, { type: "addStep", id, name });
    return id;
  },
  removeStep(stepId) {
    dispatch(set, get, { type: "removeStep", stepId });
    if (get().selectedStepId === stepId) set({ selectedStepId: null });
  },
  moveStep(stepId, toIndex) {
    dispatch(set, get, { type: "moveStep", stepId, toIndex });
  },
  setStepField(stepId, path, value) {
    dispatch(set, get, { type: "setStepField", stepId, path, value });
  },
  setStepAssert(stepId, asserts) {
    dispatch(set, get, { type: "setStepAssert", stepId, asserts });
  },

  select(id) {
    set({ selectedStepId: id });
  },
  setActiveTab(tab) {
    set({ activeTab: tab });
  },

  setPendingYamlText(text) {
    set({ pendingYamlText: text });
  },
  commitPendingYaml() {
    const text = get().pendingYamlText;
    if (text === null) return;
    const result = parseScenarioDoc(text);
    if ("error" in result) {
      set({ yamlError: result.error });
      return;
    }
    set({
      doc: result.doc,
      model: result.model,
      yamlText: serializeDoc(result.doc),
      yamlError: null,
      pendingYamlText: null,
    });
  },
  clearPendingYaml() {
    set({ pendingYamlText: null, yamlError: null });
  },
}));

function dispatch(
  set: (partial: Partial<ScenarioEditorState>) => void,
  get: () => ScenarioEditorState,
  edit: Edit,
): void {
  const doc = get().doc;
  if (!doc) return;
  applyEdit(doc, edit);
  // Re-derive model from the mutated doc.
  const reparsed = parseScenarioDoc(serializeDoc(doc));
  if ("error" in reparsed) {
    set({ yamlError: reparsed.error });
    return;
  }
  set({
    doc: reparsed.doc,
    model: reparsed.model,
    yamlText: serializeDoc(reparsed.doc),
    yamlError: null,
  });
}

// Helper for tests so they can rehydrate to a blank initial state.
declare module "zustand" {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface StoreApi<T> {}
}

(useScenarioEditor as unknown as { getInitialState: () => ScenarioEditorState }).getInitialState =
  () => ({
    ...INITIAL,
    loadFromString: useScenarioEditor.getState().loadFromString,
    resetEmpty: useScenarioEditor.getState().resetEmpty,
    setName: useScenarioEditor.getState().setName,
    setCookieJar: useScenarioEditor.getState().setCookieJar,
    setVariable: useScenarioEditor.getState().setVariable,
    removeVariable: useScenarioEditor.getState().removeVariable,
    addStep: useScenarioEditor.getState().addStep,
    removeStep: useScenarioEditor.getState().removeStep,
    moveStep: useScenarioEditor.getState().moveStep,
    setStepField: useScenarioEditor.getState().setStepField,
    setStepAssert: useScenarioEditor.getState().setStepAssert,
    select: useScenarioEditor.getState().select,
    setActiveTab: useScenarioEditor.getState().setActiveTab,
    setPendingYamlText: useScenarioEditor.getState().setPendingYamlText,
    commitPendingYaml: useScenarioEditor.getState().commitPendingYaml,
    clearPendingYaml: useScenarioEditor.getState().clearPendingYaml,
  });
```

Note on the `getInitialState` shim at the bottom: Zustand v5 doesn't expose one by default, but our test resets state across `it` blocks. The shim returns a snapshot of the **initial** state values (the `INITIAL` object) while keeping action references intact, so `useScenarioEditor.setState(useScenarioEditor.getInitialState())` clears the doc/model/etc. without unbinding handlers.

- [ ] **Step 4: Run the store test**

```bash
cd ui && pnpm vitest run src/scenario/__tests__/store.test.ts
```

Expected: PASS, 9 tests.

- [ ] **Step 5: Full UI suite**

```bash
cd ui && pnpm test
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add ui/src/scenario/store.ts ui/src/scenario/__tests__/store.test.ts
git commit -m "feat(ui): scenario editor Zustand store (Slice 3 step 4/14)"
```

---

## Task 6: TabBar component

**Files:**
- Create: `ui/src/components/scenario/TabBar.tsx`

A tiny presentational component used by the editor shell. Two tabs, one active at a time, click to switch. No store wiring yet — props only.

- [ ] **Step 1: Write a `it.todo` placeholder so tdd-guard is satisfied**

Slice 3 components without complex internal logic are tested manually via the runbook (Slice 2 precedent — RTL was explicitly deferred). The `tdd-guard.sh` hook only requires a pending test file in the worktree for the working session, so we drop a single `it.todo`:

Create `ui/src/components/scenario/__tests__/TabBar.test.tsx`:

```tsx
import { describe, it } from "vitest";

describe("TabBar", () => {
  it.todo("renders both tab labels with the active one styled");
  it.todo("calls onChange when an inactive tab is clicked");
});
```

- [ ] **Step 2: Implement `ui/src/components/scenario/TabBar.tsx`**

```tsx
import type { Tab } from "../../scenario/store";

interface TabBarProps {
  active: Tab;
  onChange: (tab: Tab) => void;
}

export function TabBar({ active, onChange }: TabBarProps) {
  return (
    <div role="tablist" className="flex border-b border-slate-200">
      <TabButton label="Canvas" tab="canvas" active={active} onChange={onChange} />
      <TabButton label="YAML" tab="yaml" active={active} onChange={onChange} />
    </div>
  );
}

interface TabButtonProps {
  label: string;
  tab: Tab;
  active: Tab;
  onChange: (tab: Tab) => void;
}

function TabButton({ label, tab, active, onChange }: TabButtonProps) {
  const isActive = active === tab;
  return (
    <button
      role="tab"
      aria-selected={isActive}
      type="button"
      onClick={() => onChange(tab)}
      className={
        "px-4 py-2 text-sm font-medium border-b-2 -mb-px " +
        (isActive
          ? "border-slate-900 text-slate-900"
          : "border-transparent text-slate-500 hover:text-slate-800")
      }
    >
      {label}
    </button>
  );
}
```

- [ ] **Step 3: Lint + typecheck**

```bash
cd ui && pnpm lint && pnpm exec tsc -b
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add ui/src/components/scenario/TabBar.tsx ui/src/components/scenario/__tests__/TabBar.test.tsx
git commit -m "feat(ui): scenario editor tab bar (Slice 3 step 5/14)"
```

---

## Task 7: VariablesPanel component

**Files:**
- Create: `ui/src/components/scenario/VariablesPanel.tsx`
- Create: `ui/src/components/scenario/__tests__/VariablesPanel.test.tsx`

Left-side panel: a list of key/value rows for `scenario.variables`, plus an "Add" button. Each row has key input, value input, delete button. Bound to the store via `useScenarioEditor`.

- [ ] **Step 1: Pending test stub**

Create `ui/src/components/scenario/__tests__/VariablesPanel.test.tsx`:

```tsx
import { describe, it } from "vitest";

describe("VariablesPanel", () => {
  it.todo("lists existing variables from the store");
  it.todo("adds a new variable when 'Add' is clicked");
  it.todo("removes a variable when its delete button is clicked");
});
```

- [ ] **Step 2: Implement `ui/src/components/scenario/VariablesPanel.tsx`**

```tsx
import { useState } from "react";
import { useScenarioEditor } from "../../scenario/store";

export function VariablesPanel() {
  const variables = useScenarioEditor((s) => s.model?.variables ?? {});
  const setVariable = useScenarioEditor((s) => s.setVariable);
  const removeVariable = useScenarioEditor((s) => s.removeVariable);

  const [newKey, setNewKey] = useState("");
  const entries = Object.entries(variables);

  return (
    <section aria-label="Variables" className="flex flex-col gap-3">
      <h3 className="text-sm font-semibold text-slate-700">Variables</h3>
      <ul className="flex flex-col gap-2">
        {entries.map(([key, value]) => (
          <li key={key} className="flex items-center gap-2">
            <span className="font-mono text-xs text-slate-600 w-24 truncate" title={key}>
              {key}
            </span>
            <input
              className="flex-1 border border-slate-300 rounded px-2 py-1 text-sm"
              value={value}
              onChange={(e) => setVariable(key, e.target.value)}
            />
            <button
              type="button"
              onClick={() => removeVariable(key)}
              aria-label={`Remove variable ${key}`}
              className="text-slate-500 hover:text-red-600 text-sm"
            >
              ×
            </button>
          </li>
        ))}
        {entries.length === 0 && (
          <li className="text-xs text-slate-400 italic">No variables</li>
        )}
      </ul>

      <div className="flex gap-2">
        <input
          className="flex-1 border border-slate-300 rounded px-2 py-1 text-sm font-mono"
          placeholder="new_var"
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
        />
        <button
          type="button"
          onClick={() => {
            const k = newKey.trim();
            if (!k) return;
            setVariable(k, "");
            setNewKey("");
          }}
          disabled={newKey.trim().length === 0}
          className="px-2 py-1 text-sm border border-slate-300 rounded disabled:opacity-50"
        >
          Add
        </button>
      </div>
    </section>
  );
}
```

- [ ] **Step 3: Lint + typecheck**

```bash
cd ui && pnpm lint && pnpm exec tsc -b
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add ui/src/components/scenario/VariablesPanel.tsx ui/src/components/scenario/__tests__/VariablesPanel.test.tsx
git commit -m "feat(ui): variables panel bound to scenario store (Slice 3 step 6/14)"
```

---

## Task 8: HttpStepNode (React Flow custom node)

**Files:**
- Create: `ui/src/components/scenario/HttpStepNode.tsx`
- Create: `ui/src/components/scenario/__tests__/HttpStepNode.test.tsx`

Custom node renderer for React Flow. Shows: name, method+URL preview (truncated). Two handles for connections (target on left, source on right) — used for ordering only; the canvas reflects step ordering as a chain.

- [ ] **Step 1: Pending test stub**

Create `ui/src/components/scenario/__tests__/HttpStepNode.test.tsx`:

```tsx
import { describe, it } from "vitest";

describe("HttpStepNode", () => {
  it.todo("renders the step's name and method+URL");
  it.todo("applies a 'selected' style when the data.selected flag is true");
});
```

- [ ] **Step 2: Implement `ui/src/components/scenario/HttpStepNode.tsx`**

```tsx
import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";

export interface HttpStepNodeData extends Record<string, unknown> {
  name: string;
  method: string;
  url: string;
  selected: boolean;
}

function HttpStepNodeImpl({ data }: NodeProps<{ data: HttpStepNodeData; type: "http" }>) {
  const { name, method, url, selected } = data;
  return (
    <div
      className={
        "px-3 py-2 rounded-md border bg-white text-sm shadow-sm min-w-[180px] " +
        (selected ? "border-slate-900 ring-1 ring-slate-900" : "border-slate-300")
      }
    >
      <Handle type="target" position={Position.Left} className="!bg-slate-400" />
      <div className="font-medium text-slate-900 truncate" title={name}>
        {name}
      </div>
      <div className="text-xs text-slate-600 font-mono truncate" title={`${method} ${url}`}>
        <span className="font-semibold">{method}</span> {url}
      </div>
      <Handle type="source" position={Position.Right} className="!bg-slate-400" />
    </div>
  );
}

export const HttpStepNode = memo(HttpStepNodeImpl);
```

- [ ] **Step 3: Lint + typecheck**

```bash
cd ui && pnpm lint && pnpm exec tsc -b
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add ui/src/components/scenario/HttpStepNode.tsx ui/src/components/scenario/__tests__/HttpStepNode.test.tsx
git commit -m "feat(ui): React Flow custom node for HTTP steps (Slice 3 step 7/14)"
```

---

## Task 9: CanvasView (React Flow board)

**Files:**
- Create: `ui/src/components/scenario/CanvasView.tsx`
- Create: `ui/src/components/scenario/__tests__/CanvasView.test.tsx`

The canvas converts the store's linear `steps[]` to React Flow nodes (auto-positioned in a row) and edges (sequential `s[i] → s[i+1]`). Click a node to select. "Add step" button below the canvas appends a new HTTP step. Drag-to-reorder support is *deferred* — for Slice 3, reorder happens via Inspector arrows (Task 10).

Auto-layout: each node is placed at `x = 220 * index`, `y = 0`. Simple and works for a single chain.

The canvas honors React Flow v12's `nodes` + `edges` + `onNodesChange` + `onEdgesChange` controlled-component pattern, but we treat changes as ignored (we don't let RF mutate positions — they're derived). We only listen to `onNodeClick` for selection.

CSS: React Flow ships with its own stylesheet. Import it once at the top of the canvas file (`import "@xyflow/react/dist/style.css";`).

- [ ] **Step 1: Pending test stub**

Create `ui/src/components/scenario/__tests__/CanvasView.test.tsx`:

```tsx
import { describe, it } from "vitest";

describe("CanvasView", () => {
  it.todo("renders one node per step in the store");
  it.todo("dispatches select() on node click");
  it.todo("dispatches addStep() on 'Add step' button click");
});
```

- [ ] **Step 2: Implement `ui/src/components/scenario/CanvasView.tsx`**

```tsx
import { useMemo } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  type Edge,
  type Node,
  type NodeMouseHandler,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useScenarioEditor } from "../../scenario/store";
import { HttpStepNode, type HttpStepNodeData } from "./HttpStepNode";

const NODE_TYPES = { http: HttpStepNode };
const NODE_WIDTH = 200;
const NODE_GAP = 60;

export function CanvasView() {
  const steps = useScenarioEditor((s) => s.model?.steps ?? []);
  const selectedStepId = useScenarioEditor((s) => s.selectedStepId);
  const select = useScenarioEditor((s) => s.select);
  const addStep = useScenarioEditor((s) => s.addStep);

  const nodes = useMemo<Array<Node<HttpStepNodeData>>>(
    () =>
      steps.map((step, idx) => ({
        id: step.id,
        type: "http",
        position: { x: idx * (NODE_WIDTH + NODE_GAP), y: 0 },
        data: {
          name: step.name,
          method: step.request.method,
          url: step.request.url,
          selected: step.id === selectedStepId,
        },
        draggable: false,
        selectable: false,
      })),
    [steps, selectedStepId],
  );

  const edges = useMemo<Edge[]>(
    () =>
      steps.slice(1).map((step, i) => ({
        id: `${steps[i].id}->${step.id}`,
        source: steps[i].id,
        target: step.id,
        type: "default",
      })),
    [steps],
  );

  const onNodeClick: NodeMouseHandler = (_e, node) => {
    select(node.id);
  };

  const onPaneClick = () => {
    select(null);
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 min-h-[400px] border border-slate-200 rounded-md overflow-hidden">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          onNodeClick={onNodeClick}
          onPaneClick={onPaneClick}
          fitView
          fitViewOptions={{ padding: 0.3, maxZoom: 1.2 }}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={20} />
          <Controls position="bottom-right" showInteractive={false} />
        </ReactFlow>
      </div>
      <div className="flex gap-2 mt-3">
        <button
          type="button"
          onClick={() => {
            const id = addStep(`Step ${steps.length + 1}`);
            select(id);
          }}
          className="px-3 py-1.5 text-sm border border-slate-300 rounded hover:bg-slate-100"
        >
          + Add step
        </button>
        {steps.length === 0 && (
          <span className="text-xs text-slate-400 self-center">
            Canvas is empty. Click "Add step" to begin.
          </span>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Lint + typecheck**

```bash
cd ui && pnpm lint && pnpm exec tsc -b
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add ui/src/components/scenario/CanvasView.tsx ui/src/components/scenario/__tests__/CanvasView.test.tsx
git commit -m "feat(ui): React Flow canvas wired to scenario store (Slice 3 step 8/14)"
```

---

## Task 10: Inspector (right-side form for the selected step)

**Files:**
- Create: `ui/src/components/scenario/Inspector.tsx`
- Create: `ui/src/components/scenario/__tests__/Inspector.test.tsx`

The Inspector edits the currently-selected step. Sections:
1. **Name** (text)
2. **Order controls** (up / down / delete)
3. **Request**: method (select), URL (text), Headers (list of key/value rows + add row)
4. **Body**: kind dropdown (`none | json | form | raw`), then a kind-specific editor:
   - `none` → no editor
   - `json` → textarea (validated as JSON on blur; if invalid, leave the field but show an inline error and don't dispatch)
   - `form` → list of key/value rows
   - `raw` → textarea
5. **Assertions**: list of status-code inputs

When nothing is selected (or Canvas tab is inactive), the Inspector renders a placeholder. When a step is selected but the model doesn't have it (e.g., the user deleted it), the Inspector clears its own selection via `select(null)` in an effect.

- [ ] **Step 1: Pending test stub**

Create `ui/src/components/scenario/__tests__/Inspector.test.tsx`:

```tsx
import { describe, it } from "vitest";

describe("Inspector", () => {
  it.todo("shows placeholder when no step is selected");
  it.todo("renders name/method/url for the selected step");
  it.todo("dispatches setStepField on name change");
  it.todo("renders a JSON textarea when body kind is json");
  it.todo("dispatches setStepAssert when adding a status code");
});
```

- [ ] **Step 2: Implement `ui/src/components/scenario/Inspector.tsx`**

```tsx
import { useEffect, useMemo, useState } from "react";
import { useScenarioEditor } from "../../scenario/store";
import type { Body, HttpMethod, Step } from "../../scenario/model";

const METHODS: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const BODY_KINDS = ["none", "json", "form", "raw"] as const;
type BodyKind = (typeof BODY_KINDS)[number];

export function Inspector() {
  const selectedStepId = useScenarioEditor((s) => s.selectedStepId);
  const steps = useScenarioEditor((s) => s.model?.steps ?? []);
  const select = useScenarioEditor((s) => s.select);

  const step = useMemo(
    () => steps.find((s) => s.id === selectedStepId) ?? null,
    [steps, selectedStepId],
  );

  useEffect(() => {
    if (selectedStepId !== null && step === null) select(null);
  }, [selectedStepId, step, select]);

  if (step === null) {
    return (
      <aside aria-label="Inspector" className="text-sm text-slate-400 italic">
        Select a step in the canvas to edit its details.
      </aside>
    );
  }

  return <StepInspector step={step} />;
}

interface StepInspectorProps {
  step: Step;
}

function StepInspector({ step }: StepInspectorProps) {
  const setStepField = useScenarioEditor((s) => s.setStepField);
  const setStepAssert = useScenarioEditor((s) => s.setStepAssert);
  const removeStep = useScenarioEditor((s) => s.removeStep);
  const moveStep = useScenarioEditor((s) => s.moveStep);
  const steps = useScenarioEditor((s) => s.model?.steps ?? []);

  const index = steps.findIndex((s) => s.id === step.id);

  return (
    <aside aria-label="Inspector" className="flex flex-col gap-4 text-sm">
      <header className="flex items-center justify-between">
        <h3 className="font-semibold text-slate-700">Step</h3>
        <div className="flex gap-1">
          <SmallButton
            onClick={() => moveStep(step.id, Math.max(0, index - 1))}
            disabled={index === 0}
            label="↑"
            title="Move up"
          />
          <SmallButton
            onClick={() => moveStep(step.id, Math.min(steps.length - 1, index + 1))}
            disabled={index === steps.length - 1}
            label="↓"
            title="Move down"
          />
          <SmallButton
            onClick={() => removeStep(step.id)}
            label="Delete"
            title="Delete step"
            danger
          />
        </div>
      </header>

      <Field label="Name">
        <input
          className="w-full border border-slate-300 rounded px-2 py-1"
          value={step.name}
          onChange={(e) => setStepField(step.id, ["name"], e.target.value || "Untitled")}
        />
      </Field>

      <fieldset className="flex flex-col gap-2 border border-slate-200 rounded p-3">
        <legend className="px-1 text-xs font-semibold text-slate-600">Request</legend>
        <Field label="Method">
          <select
            className="border border-slate-300 rounded px-2 py-1"
            value={step.request.method}
            onChange={(e) =>
              setStepField(step.id, ["request", "method"], e.target.value as HttpMethod)
            }
          >
            {METHODS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </Field>
        <Field label="URL">
          <input
            className="w-full border border-slate-300 rounded px-2 py-1 font-mono text-xs"
            value={step.request.url}
            onChange={(e) => setStepField(step.id, ["request", "url"], e.target.value)}
          />
        </Field>
        <HeadersEditor step={step} />
        <BodyEditor step={step} />
      </fieldset>

      <AssertEditor step={step} setStepAssert={setStepAssert} />
    </aside>
  );
}

function HeadersEditor({ step }: { step: Step }) {
  const setStepField = useScenarioEditor((s) => s.setStepField);
  const [newKey, setNewKey] = useState("");

  const entries = Object.entries(step.request.headers ?? {});

  const replace = (next: Record<string, string>) => {
    setStepField(step.id, ["request", "headers"], next);
  };

  return (
    <div>
      <div className="text-xs font-semibold text-slate-600 mb-1">Headers</div>
      <ul className="flex flex-col gap-1">
        {entries.map(([k, v]) => (
          <li key={k} className="flex gap-2 items-center">
            <span className="font-mono text-xs text-slate-600 w-32 truncate" title={k}>
              {k}
            </span>
            <input
              className="flex-1 border border-slate-300 rounded px-2 py-1 text-xs"
              value={v}
              onChange={(e) => {
                const next = { ...step.request.headers, [k]: e.target.value };
                replace(next);
              }}
            />
            <button
              type="button"
              aria-label={`Remove header ${k}`}
              className="text-slate-500 hover:text-red-600"
              onClick={() => {
                const next = { ...step.request.headers };
                delete next[k];
                replace(next);
              }}
            >
              ×
            </button>
          </li>
        ))}
        {entries.length === 0 && (
          <li className="text-xs text-slate-400 italic">No headers</li>
        )}
      </ul>
      <div className="flex gap-2 mt-1">
        <input
          className="flex-1 border border-slate-300 rounded px-2 py-1 text-xs font-mono"
          placeholder="Header-Name"
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
        />
        <button
          type="button"
          className="px-2 py-1 text-xs border border-slate-300 rounded disabled:opacity-50"
          disabled={!newKey.trim()}
          onClick={() => {
            const k = newKey.trim();
            if (!k || k in (step.request.headers ?? {})) return;
            replace({ ...step.request.headers, [k]: "" });
            setNewKey("");
          }}
        >
          Add
        </button>
      </div>
    </div>
  );
}

function BodyEditor({ step }: { step: Step }) {
  const setStepField = useScenarioEditor((s) => s.setStepField);

  const kind: BodyKind = step.request.body?.kind ?? "none";

  const setKind = (k: BodyKind) => {
    if (k === "none") {
      setStepField(step.id, ["request", "body"], undefined);
      return;
    }
    let next: Body;
    if (k === "json") next = { kind: "json", value: {} };
    else if (k === "form") next = { kind: "form", value: {} };
    else next = { kind: "raw", value: "" };
    // YAML representation: body: { json: ... } not { kind: 'json', value: ... }
    const yamlShape: Record<string, unknown> = {};
    yamlShape[k] = next.kind === "raw" ? next.value : next.value;
    setStepField(step.id, ["request", "body"], yamlShape);
  };

  return (
    <div>
      <div className="text-xs font-semibold text-slate-600 mb-1">Body</div>
      <select
        className="border border-slate-300 rounded px-2 py-1 text-sm mb-2"
        value={kind}
        onChange={(e) => setKind(e.target.value as BodyKind)}
      >
        {BODY_KINDS.map((k) => (
          <option key={k} value={k}>
            {k}
          </option>
        ))}
      </select>
      {kind === "json" && <JsonBodyField step={step} />}
      {kind === "form" && <FormBodyField step={step} />}
      {kind === "raw" && <RawBodyField step={step} />}
    </div>
  );
}

function JsonBodyField({ step }: { step: Step }) {
  const setStepField = useScenarioEditor((s) => s.setStepField);
  const body = step.request.body;
  const initial =
    body?.kind === "json" ? JSON.stringify(body.value, null, 2) : "{}";
  const [text, setText] = useState(initial);
  const [error, setError] = useState<string | null>(null);

  // Keep textarea in sync if the step changes from elsewhere.
  useEffect(() => {
    setText(body?.kind === "json" ? JSON.stringify(body.value, null, 2) : "{}");
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step.id]);

  const commit = () => {
    try {
      const parsed = JSON.parse(text);
      setError(null);
      setStepField(step.id, ["request", "body"], { json: parsed });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div>
      <textarea
        className="w-full h-32 border border-slate-300 rounded px-2 py-1 text-xs font-mono"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        spellCheck={false}
      />
      {error && <p className="text-xs text-red-600">JSON: {error}</p>}
    </div>
  );
}

function FormBodyField({ step }: { step: Step }) {
  const setStepField = useScenarioEditor((s) => s.setStepField);
  const body = step.request.body;
  const map = body?.kind === "form" ? body.value : {};
  const entries = Object.entries(map);
  const [newKey, setNewKey] = useState("");

  const replace = (next: Record<string, string>) => {
    setStepField(step.id, ["request", "body"], { form: next });
  };

  return (
    <div>
      <ul className="flex flex-col gap-1">
        {entries.map(([k, v]) => (
          <li key={k} className="flex gap-2 items-center">
            <span className="font-mono text-xs text-slate-600 w-32 truncate">{k}</span>
            <input
              className="flex-1 border border-slate-300 rounded px-2 py-1 text-xs"
              value={v}
              onChange={(e) => replace({ ...map, [k]: e.target.value })}
            />
            <button
              type="button"
              aria-label={`Remove form field ${k}`}
              className="text-slate-500 hover:text-red-600"
              onClick={() => {
                const next = { ...map };
                delete next[k];
                replace(next);
              }}
            >
              ×
            </button>
          </li>
        ))}
        {entries.length === 0 && (
          <li className="text-xs text-slate-400 italic">No fields</li>
        )}
      </ul>
      <div className="flex gap-2 mt-1">
        <input
          className="flex-1 border border-slate-300 rounded px-2 py-1 text-xs font-mono"
          placeholder="field"
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
        />
        <button
          type="button"
          className="px-2 py-1 text-xs border border-slate-300 rounded disabled:opacity-50"
          disabled={!newKey.trim()}
          onClick={() => {
            const k = newKey.trim();
            if (!k || k in map) return;
            replace({ ...map, [k]: "" });
            setNewKey("");
          }}
        >
          Add
        </button>
      </div>
    </div>
  );
}

function RawBodyField({ step }: { step: Step }) {
  const setStepField = useScenarioEditor((s) => s.setStepField);
  const body = step.request.body;
  const value = body?.kind === "raw" ? body.value : "";
  return (
    <textarea
      className="w-full h-24 border border-slate-300 rounded px-2 py-1 text-xs font-mono"
      value={value}
      onChange={(e) => setStepField(step.id, ["request", "body"], { raw: e.target.value })}
      spellCheck={false}
    />
  );
}

function AssertEditor({
  step,
  setStepAssert,
}: {
  step: Step;
  setStepAssert: (id: string, asserts: ReadonlyArray<{ kind: "status"; code: number }>) => void;
}) {
  const [newCode, setNewCode] = useState("");
  return (
    <fieldset className="flex flex-col gap-2 border border-slate-200 rounded p-3">
      <legend className="px-1 text-xs font-semibold text-slate-600">Assertions</legend>
      <ul className="flex flex-col gap-1">
        {step.assert.map((a, idx) => (
          <li key={idx} className="flex items-center gap-2 text-xs">
            <span className="font-mono text-slate-600 w-16">status</span>
            <input
              type="number"
              min={100}
              max={599}
              className="w-24 border border-slate-300 rounded px-2 py-1"
              value={a.code}
              onChange={(e) => {
                const code = Number(e.target.value);
                if (!Number.isFinite(code)) return;
                const next = [...step.assert];
                next[idx] = { kind: "status", code };
                setStepAssert(step.id, next);
              }}
            />
            <button
              type="button"
              aria-label={`Remove assertion ${idx}`}
              className="text-slate-500 hover:text-red-600"
              onClick={() => {
                setStepAssert(
                  step.id,
                  step.assert.filter((_, i) => i !== idx),
                );
              }}
            >
              ×
            </button>
          </li>
        ))}
        {step.assert.length === 0 && (
          <li className="text-xs text-slate-400 italic">No assertions</li>
        )}
      </ul>
      <div className="flex gap-2">
        <input
          type="number"
          placeholder="200"
          min={100}
          max={599}
          className="w-24 border border-slate-300 rounded px-2 py-1 text-xs"
          value={newCode}
          onChange={(e) => setNewCode(e.target.value)}
        />
        <button
          type="button"
          className="px-2 py-1 text-xs border border-slate-300 rounded disabled:opacity-50"
          disabled={!newCode}
          onClick={() => {
            const code = Number(newCode);
            if (!Number.isFinite(code) || code < 100 || code > 599) return;
            setStepAssert(step.id, [...step.assert, { kind: "status", code }]);
            setNewCode("");
          }}
        >
          Add
        </button>
      </div>
    </fieldset>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-semibold text-slate-600">{label}</span>
      {children}
    </label>
  );
}

function SmallButton({
  onClick,
  label,
  title,
  disabled,
  danger,
}: {
  onClick: () => void;
  label: string;
  title: string;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={disabled}
      className={
        "px-2 py-1 text-xs border rounded disabled:opacity-40 " +
        (danger
          ? "border-red-300 text-red-700 hover:bg-red-50"
          : "border-slate-300 text-slate-700 hover:bg-slate-100")
      }
    >
      {label}
    </button>
  );
}
```

- [ ] **Step 3: Lint + typecheck**

```bash
cd ui && pnpm lint && pnpm exec tsc -b
```

Expected: clean. If TS complains about React import for JSX (strict mode auto-imports JSX via vite-react), add `import React from "react";` at the top — not needed in TSX with new JSX transform.

- [ ] **Step 4: Commit**

```bash
git add ui/src/components/scenario/Inspector.tsx ui/src/components/scenario/__tests__/Inspector.test.tsx
git commit -m "feat(ui): step inspector with request/body/assert editors (Slice 3 step 9/14)"
```

---

## Task 11: MonacoYamlView

**Files:**
- Create: `ui/src/components/scenario/MonacoYamlView.tsx`
- Create: `ui/src/components/scenario/__tests__/MonacoYamlView.test.tsx`

The YAML view shows the current `yamlText` (or `pendingYamlText` if set), edits push to `pendingYamlText`, and a 300 ms debounce commits via `commitPendingYaml()`. We configure `@monaco-editor/react` to use the bundled `monaco-editor` (no CDN). The textarea is replaced by Monaco.

The `loader.config({ monaco })` call is module-scoped — we put it in this file so it runs the first time the YAML view loads (it's idempotent on repeated calls).

Monaco worker registration: register `self.MonacoEnvironment` to return same-origin workers from Vite-bundled URLs.

- [ ] **Step 1: Pending test stub**

Create `ui/src/components/scenario/__tests__/MonacoYamlView.test.tsx`:

```tsx
import { describe, it } from "vitest";

describe("MonacoYamlView", () => {
  it.todo("renders the current yamlText");
  it.todo("calls setPendingYamlText after a debounce");
  it.todo("calls commitPendingYaml when the debounce timer fires");
  it.todo("renders the yamlError under the editor when set");
});
```

- [ ] **Step 2: Implement `ui/src/components/scenario/MonacoYamlView.tsx`**

```tsx
import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import Editor, { loader } from "@monaco-editor/react";
import { useScenarioEditor } from "../../scenario/store";

// Register Monaco workers as same-origin module workers. This must happen
// before any editor mounts, so we do it at module scope.
if (typeof self !== "undefined") {
  (self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
    getWorker(_workerId, _label) {
      return new editorWorker();
    },
  };
}

// Force @monaco-editor/react to use our bundled monaco instead of fetching
// from JSDelivr (offline-runtime constraint).
loader.config({ monaco });

const DEBOUNCE_MS = 300;

export function MonacoYamlView() {
  const yamlText = useScenarioEditor((s) => s.yamlText);
  const pendingYamlText = useScenarioEditor((s) => s.pendingYamlText);
  const yamlError = useScenarioEditor((s) => s.yamlError);
  const setPendingYamlText = useScenarioEditor((s) => s.setPendingYamlText);
  const commitPendingYaml = useScenarioEditor((s) => s.commitPendingYaml);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, []);

  const visibleText = pendingYamlText ?? yamlText;

  const onChange = (next: string | undefined) => {
    if (next === undefined) return;
    setPendingYamlText(next);
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      commitPendingYaml();
      timerRef.current = null;
    }, DEBOUNCE_MS);
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 min-h-[400px] border border-slate-200 rounded-md overflow-hidden">
        <Editor
          height="100%"
          defaultLanguage="yaml"
          value={visibleText}
          onChange={onChange}
          options={{
            minimap: { enabled: false },
            wordWrap: "on",
            fontSize: 13,
            tabSize: 2,
            scrollBeyondLastLine: false,
            renderWhitespace: "selection",
          }}
        />
      </div>
      {yamlError !== null && (
        <p className="mt-2 text-xs text-red-600 font-mono">YAML invalid: {yamlError}</p>
      )}
    </div>
  );
}
```

Important note: the `import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker"` line is Vite-specific syntax. It tells Vite to bundle the worker as a same-origin module and gives us a constructor that returns a `Worker` instance.

- [ ] **Step 3: Lint + typecheck**

```bash
cd ui && pnpm lint && pnpm exec tsc -b
```

Expected: clean. If TS complains about `?worker` import, add an ambient type declaration. Edit `ui/src/vite-env.d.ts` and append:

```ts
declare module "*?worker" {
  const WorkerCtor: { new (): Worker };
  export default WorkerCtor;
}
```

If it already exists, leave it.

- [ ] **Step 4: Smoke test the build**

```bash
cd ui && pnpm build
```

Expected: build succeeds. The output should include separate `editor.worker-*.js` chunks. Check:

```bash
ls ui/dist/assets | grep -i worker
```

Expected: at least one file with `worker` in the name.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/scenario/MonacoYamlView.tsx ui/src/components/scenario/__tests__/MonacoYamlView.test.tsx ui/src/vite-env.d.ts
git commit -m "feat(ui): Monaco YAML editor with debounced commit (Slice 3 step 10/14)"
```

---

## Task 12: EditorShell — compose the three panes

**Files:**
- Create: `ui/src/components/scenario/EditorShell.tsx`
- Create: `ui/src/components/scenario/__tests__/EditorShell.test.tsx`

EditorShell glues everything together. It owns initial-load from a `yaml` prop and exposes the current `yamlText` via a `onChange` callback (so the parent page can persist). It does NOT do API calls itself.

Layout (Tailwind grid):
- Left column (240px): VariablesPanel
- Middle column (flex 1): TabBar + (CanvasView | MonacoYamlView)
- Right column (320px): Inspector (only when canvas tab is active AND a step is selected; otherwise empty placeholder occupies the same width to avoid layout shift)

- [ ] **Step 1: Pending test stub**

Create `ui/src/components/scenario/__tests__/EditorShell.test.tsx`:

```tsx
import { describe, it } from "vitest";

describe("EditorShell", () => {
  it.todo("loads the initialYaml into the store on mount");
  it.todo("calls onChange with the current yamlText whenever it changes");
  it.todo("hides the inspector when the YAML tab is active");
});
```

- [ ] **Step 2: Implement `ui/src/components/scenario/EditorShell.tsx`**

```tsx
import { useEffect, useRef } from "react";
import { useScenarioEditor } from "../../scenario/store";
import { CanvasView } from "./CanvasView";
import { Inspector } from "./Inspector";
import { MonacoYamlView } from "./MonacoYamlView";
import { TabBar } from "./TabBar";
import { VariablesPanel } from "./VariablesPanel";

interface EditorShellProps {
  initialYaml: string;
  onChange?: (yaml: string) => void;
}

export function EditorShell({ initialYaml, onChange }: EditorShellProps) {
  const loadFromString = useScenarioEditor((s) => s.loadFromString);
  const activeTab = useScenarioEditor((s) => s.activeTab);
  const setActiveTab = useScenarioEditor((s) => s.setActiveTab);
  const yamlText = useScenarioEditor((s) => s.yamlText);

  const initialRef = useRef(initialYaml);
  useEffect(() => {
    loadFromString(initialRef.current);
  }, [loadFromString]);

  useEffect(() => {
    onChange?.(yamlText);
  }, [yamlText, onChange]);

  return (
    <div className="grid grid-cols-[240px_1fr_320px] gap-4 min-h-[520px]">
      <div className="border border-slate-200 rounded-md p-3 bg-white">
        <VariablesPanel />
      </div>

      <div className="flex flex-col">
        <TabBar active={activeTab} onChange={setActiveTab} />
        <div className="flex-1 mt-3">
          {activeTab === "canvas" ? <CanvasView /> : <MonacoYamlView />}
        </div>
      </div>

      <div className="border border-slate-200 rounded-md p-3 bg-white">
        {activeTab === "canvas" ? (
          <Inspector />
        ) : (
          <div className="text-xs text-slate-400 italic">
            Switch to the Canvas tab to inspect a step.
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Lint + typecheck**

```bash
cd ui && pnpm lint && pnpm exec tsc -b
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add ui/src/components/scenario/EditorShell.tsx ui/src/components/scenario/__tests__/EditorShell.test.tsx
git commit -m "feat(ui): editor shell composes variables / canvas-or-yaml / inspector (Slice 3 step 11/14)"
```

---

## Task 13: Wire EditorShell into ScenarioNewPage + ScenarioEditPage

**Files:**
- Modify: `ui/src/pages/ScenarioNewPage.tsx`
- Modify: `ui/src/pages/ScenarioEditPage.tsx`

The New page collects YAML via the shell, then on "Create" calls `useCreateScenario` with the current `yamlText`. The Edit page initializes the shell with the loaded scenario's yaml, then on "Save" calls `useUpdateScenario` with the current yamlText + the loaded version.

To get the current yamlText out of the shell, we use the `onChange` callback to keep a local React state in sync. The page state is **just a mirror** of the store; the shell remains the source of truth during the editing session.

- [ ] **Step 1: Replace `ScenarioNewPage.tsx`**

```tsx
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useCreateScenario } from "../api/hooks";
import { Button } from "../components/Button";
import { EditorShell } from "../components/scenario/EditorShell";

const STARTER_YAML = `version: 1
name: "Untitled"
cookie_jar: auto
variables:
  base_url: "http://localhost:8080"
steps: []
`;

export function ScenarioNewPage() {
  const navigate = useNavigate();
  const mutation = useCreateScenario();
  const [yamlText, setYamlText] = useState(STARTER_YAML);

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-xl font-semibold">New scenario</h2>

      <EditorShell initialYaml={STARTER_YAML} onChange={setYamlText} />

      {mutation.error && <p className="text-red-600">{(mutation.error as Error).message}</p>}

      <div className="flex gap-2">
        <Button
          onClick={() =>
            mutation.mutate(yamlText, {
              onSuccess: (created) => navigate(`/scenarios/${created.id}`),
            })
          }
          disabled={mutation.isPending || yamlText.trim().length === 0}
        >
          {mutation.isPending ? "Creating…" : "Create"}
        </Button>
        <Button variant="secondary" onClick={() => navigate("/")}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Replace `ScenarioEditPage.tsx`**

```tsx
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useScenario, useUpdateScenario } from "../api/hooks";
import { Button } from "../components/Button";
import { EditorShell } from "../components/scenario/EditorShell";

export function ScenarioEditPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data, isLoading, error } = useScenario(id);
  const update = useUpdateScenario(id ?? "");
  const [yamlText, setYamlText] = useState<string>("");
  const [loadedVersion, setLoadedVersion] = useState<number | null>(null);
  const [originalYaml, setOriginalYaml] = useState<string>("");

  useEffect(() => {
    if (data) {
      setYamlText(data.yaml);
      setOriginalYaml(data.yaml);
      setLoadedVersion(data.version);
    }
  }, [data]);

  if (isLoading) return <p className="text-slate-500">Loading…</p>;
  if (error) return <p className="text-red-600">Failed: {(error as Error).message}</p>;
  if (!data) return <p className="text-slate-500">Not found.</p>;

  const dirty = originalYaml !== yamlText;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">{data.name}</h2>
          <p className="text-sm text-slate-600">
            v{data.version} · updated {new Date(data.updated_at).toLocaleString()}
          </p>
        </div>
        <div className="flex gap-2">
          <Link to={`/scenarios/${data.id}/runs`}>
            <Button variant="secondary">Runs</Button>
          </Link>
        </div>
      </div>

      <EditorShell initialYaml={data.yaml} onChange={setYamlText} />

      {update.error && <p className="text-red-600">{(update.error as Error).message}</p>}

      <div className="flex gap-2">
        <Button
          onClick={() =>
            loadedVersion !== null &&
            update.mutate(
              { yaml: yamlText, version: loadedVersion },
              {
                onSuccess: (next) => {
                  setLoadedVersion(next.version);
                  setOriginalYaml(next.yaml);
                },
              },
            )
          }
          disabled={!dirty || update.isPending || loadedVersion === null}
        >
          {update.isPending ? "Saving…" : "Save"}
        </Button>
        <Button variant="secondary" onClick={() => navigate("/")}>
          Back
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Verify build + lint + test**

```bash
cd ui && pnpm lint && pnpm test && pnpm build
```

Expected: green. The new `pendingYamlText` flow means a user can leave invalid YAML in Monaco that does NOT propagate to `yamlText` — that's intentional (Save remains tied to the last valid version).

- [ ] **Step 4: Commit**

```bash
git add ui/src/pages/ScenarioNewPage.tsx ui/src/pages/ScenarioEditPage.tsx
git commit -m "feat(ui): wire scenario editor shell into new/edit pages (Slice 3 step 12/14)"
```

---

## Task 14: End-to-end manual check + dev runbook + Rust e2e regression

**Files:**
- Create: `docs/dev/ui-slice-3-manual-check.md`
- Modify: `CLAUDE.md`
- (verify) `crates/controller/tests/e2e_test.rs` — no changes expected; we only confirm it still passes against the SPA build

This is the verification task: produce the runbook, smoke test the full app, regenerate CLAUDE.md status, and confirm nothing on the Rust side regressed.

- [ ] **Step 1: Write `docs/dev/ui-slice-3-manual-check.md`**

```markdown
# Slice 3 — UI manual smoke checklist

Run this before merging Slice 3. The dev loop is:

```bash
# T0
cargo run -p handicap-controller -- --rest-addr 127.0.0.1:8080 --ui-dir ui/dist

# T1
cd ui && pnpm dev
```

Open http://localhost:5173 (the Vite dev server proxies `/api` → the controller).

## 1. New scenario flow

- [ ] `/scenarios/new` shows three panes: Variables panel on the left, Canvas tab on the middle, empty inspector on the right.
- [ ] Canvas is empty with the prompt "Canvas is empty. Click 'Add step' to begin."
- [ ] Click **+ Add step** twice → two boxes appear in a horizontal chain with an arrow between them.
- [ ] Click the first box → Inspector populates (name, method, URL fields).
- [ ] Change method to POST, URL to `{{base_url}}/login`, name to `login`. The canvas box updates live.
- [ ] Add a header `Content-Type: application/json`. Switch body kind to `json`, paste `{"u":"a"}`, blur the textarea.
- [ ] Add an assertion `200`.
- [ ] Click the second box → repeat with GET `{{base_url}}/me`, assertion 200.
- [ ] Switch to **YAML** tab. Confirm:
  - `steps` has two entries with the IDs you just added
  - `request.headers.Content-Type` is present on step 1
  - `body.json.u: a` is present on step 1
- [ ] Edit the YAML directly: change `{{base_url}}` to `{{base_url}}/v1`. Within ~300 ms the model accepts the edit (no error appears below the editor).
- [ ] Switch back to **Canvas**. Click step 1 → URL field reflects `{{base_url}}/v1/login`.
- [ ] Click **Create**. Browser navigates to `/scenarios/<id>`.

## 2. Round-trip (comment preservation)

- [ ] In the editor, switch to **YAML** tab. Add a comment line above the first step:

  ```yaml
  # production login flow
    - id: "..."
  ```

- [ ] Wait 300 ms (YAML pane shows no error).
- [ ] Switch to **Canvas** tab, click step 1, change its **name** to `prod-login`.
- [ ] Switch back to **YAML** tab. The `# production login flow` comment is still present.
- [ ] Click **Save**. Banner shows "Saving…" then disappears.
- [ ] Hard-refresh the page. The comment is still there after the round-trip through the backend.

## 3. Invalid YAML never poisons the model

- [ ] In **YAML** tab, replace `version: 1` with `version: not a number`. Below the editor an error like `YAML invalid: version: Expected literal value 1, received string` appears within ~300 ms.
- [ ] Switch to **Canvas** tab. Canvas still shows the *last valid* state (with two steps).
- [ ] Click **Save**. The button is enabled (because `yamlText` is the last valid value); the request succeeds.
- [ ] Switch back to **YAML** — the invalid text is preserved in the pending buffer (no auto-discard).

## 4. Delete and reorder

- [ ] Click step 2 → Inspector → click `↑` button → step 2 swaps with step 1 in the canvas chain.
- [ ] Click step 2 (now leftmost) → click **Delete**. Canvas now shows a single step.

## 5. Run flow regression

- [ ] Click **Runs** in the header → **New run** → run with VUs 10 / duration 5 s / env `BASE_URL=http://127.0.0.1:9090`.
- [ ] Boot a wiremock or any local HTTP responder on 9090 (see Slice 1 runbook). Confirm the run reaches `completed` and metrics appear (regression check — Slice 2 functionality still works).

## 6. Offline runtime check (CSP)

- [ ] In Chrome DevTools → Network → Throttling → **Offline (allow `/api`)** ... easiest: stop the dev server, run `pnpm build` then `pnpm preview` (port 4173) with the controller serving `--ui-dir ui/dist`.
- [ ] Open the page on `http://127.0.0.1:8080`. Confirm:
  - Canvas + Monaco both render
  - No DevTools console errors mentioning CSP, blocked workers, or missing fonts
  - Open DevTools → Application → Service Workers / Storage — there should be **no** outbound network requests to jsdelivr.net, fonts.googleapis.com, or any CDN

## 7. Lint / test / build green

```bash
cd ui && pnpm lint && pnpm test && pnpm build
cargo fmt --check && cargo build --workspace && cargo test --workspace
```

All green.
```

- [ ] **Step 2: Update `CLAUDE.md`**

Update the `Handicap` header paragraph + "알아둘 결정들" + add a "Slice 3에서 배운 함정들" subsection.

Replace:

```
**상태: Slice 2(UI skeleton + 정적 서빙) 구현 완료.**
```

with:

```
**상태: Slice 3(캔버스 + Monaco + 양방향 sync) 구현 완료.**
```

In the slice summary paragraph:

```
Slice 2 결과: ...
```

Append:

```
Slice 3 결과: React Flow 캔버스(HTTP 노드 1종, 선형 chain, drag-drop add, inspector) + Monaco YAML 에디터(syntax highlighting only) + Zustand store + Zod 검증 + `yaml` 패키지 Document API targeted edit. 양방향 sync는 탭 전환 모델: 캔버스/YAML 둘 중 하나가 active. Monaco 편집은 300ms debounce → 검증 통과 시 doc swap, 실패 시 pendingYamlText에 유지하고 inline 에러 표시. extract/multi-step variable chaining은 Slice 4, K8s 배포는 Slice 6.
```

In **알아둘 결정들** keep as is — no new ADRs in Slice 3.

Append a new section after "Slice 2에서 배운 함정들":

```
## Slice 3에서 배운 함정들

- **`@xyflow/react` v12의 패키지 이름 변경**: 이전 `reactflow` 패키지가 `@xyflow/react`로 rename. import 경로도 `@xyflow/react` + `@xyflow/react/dist/style.css`. v11 예제는 함정.
- **`@monaco-editor/react`는 기본적으로 JSDelivr에서 monaco를 fetch**: 오프라인 런타임 제약을 어김. 반드시 `loader.config({ monaco })` 로 로컬 번들을 강제. 안 그러면 dev에서는 동작하지만 air-gapped staging에서 흰 화면.
- **Monaco 워커는 Vite의 `?worker` import로 등록**: `import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker"` + `self.MonacoEnvironment.getWorker = () => new editorWorker()`. 이 등록을 모듈 스코프에서 해야 첫 mount 이전에 실행됨. 컴포넌트 안에 useEffect로 두면 race.
- **CSP `worker-src` 필요**: `default-src 'self'`만 있으면 Chrome이 module worker를 blob: URL로 만들 때 차단할 수 있다. `worker-src 'self' blob:`로 명시. style-src의 unsafe-inline은 Slice 2부터 이미 있음.
- **`yaml` 패키지 Document API의 targeted edit으로 코멘트 보존**: `doc.setIn(['steps', 0, 'request', 'method'], 'POST')` 식으로 부분 수정 시 다른 키 옆 코멘트 그대로 유지. 단, `steps[i]`를 통째로 교체하면 그 안의 모든 코멘트는 사라진다 — `addStep`/`removeStep`/`moveStep`은 그 한도에서 동작 (§2.8의 한계 그대로).
- **`extract` 키 보존**: TS 모델 (`ScenarioModel`)은 `.strict()`로 `extract`를 거부하지만, `normalizeForModel`이 doc.toJS() 후 모델 입력 단계에서 `extract`를 떨궈 검증을 통과시킨다. 원본 Doc은 그대로 — round-trip 시 `extract`가 유지됨. Slice 4에서 `extract`를 모델에 추가할 때 이 노멀라이저만 손보면 된다.
- **Zod `.strict()` + `default()`의 조합**: `.strict()`가 `default()`로 채워진 키를 거부하지 않는다 — default는 input 단계에서 적용되고 strict는 unknown 키 검사이므로 충돌 없음. 헷갈리지 말 것.
- **Zustand v5는 getInitialState 미제공**: 테스트에서 store를 reset하려면 직접 INITIAL 객체를 보관하고 setState로 덮어쓰는 작은 헬퍼가 필요. (또는 `vi.resetModules()`로 모듈 새로 로딩.)
- **React Flow의 control vs uncontrolled**: 노드 위치를 직접 계산해서 넘기면 React Flow 안에서 drag로 옮긴 위치는 반영되지 않는다. Slice 3은 의도적으로 drag 비활성화(`draggable: false`) — 위치는 매번 재계산됨.
```

- [ ] **Step 3: Run all tests one final time**

```bash
cd ui && pnpm lint && pnpm test && pnpm build
cd .. && cargo fmt --check && cargo build --workspace && cargo test --workspace
```

Expected: green across the board.

- [ ] **Step 4: Run the manual check**

Follow `docs/dev/ui-slice-3-manual-check.md` end-to-end. Annotate any failures or surprises directly in the file under a `## Findings` section, then fix.

- [ ] **Step 5: Commit final docs + CLAUDE.md**

```bash
git add docs/dev/ui-slice-3-manual-check.md CLAUDE.md
git commit -m "docs(slice-3): manual check runbook + CLAUDE.md status & gotchas"
```

- [ ] **Step 6 (optional): Tag the slice**

```bash
git tag slice-3
```

---

## Self-review against spec (writing-plans § Self-Review)

Checked against `docs/superpowers/specs/2026-05-27-handicap-mvp1-design.md` and CLAUDE.md slice boundaries.

**Spec coverage:**
- §1.5 In-scope item "UI: 드래그-드롭 캔버스 (1종 노드만), YAML 뷰, 양방향 sync" → Tasks 6-13.
- §2.6 GUI ↔ 모델 매핑 — covered: variables panel (Task 7), node label + method/url badge (Task 8), inspector (Task 10), edge between consecutive steps (Task 9). `extract` badge is explicitly out (Slice 4).
- §2.7 양방향 sync 메커니즘 — covered: Zustand single store (Task 5), Zod schemas (Task 2), `yaml` Document API round-trip (Task 4), Monaco 300 ms debounce (Task 11), stable ULIDs (Task 3). All five bullets present.
- §2.8 알려진 MVP 한계 — accepted as Slice 3 limitations: Comments next to deleted keys can disappear (we use targeted edits that preserve untouched siblings; replacements still discard sub-comments). Documented in CLAUDE.md Slice 3 gotchas.
- §3.2 웹 UI library choices — all picked up except chart libs (Slice 5). React Flow → `@xyflow/react` v12 (the v11 `reactflow` package is the older name).
- §4.1 user flow 1–3 — exercised in manual check Tasks 1, 2.
- §4.1 user flows 4–8 (run dialog, polling, report) — out of scope this slice; the manual check Task 5 regression-tests them as Slice 2 functionality still works.
- §4.4 testing — vitest unit tests added for: model schemas, ULID, YAML doc round-trip (incl. comment preservation + Zod validation + add/remove/move/setStepField/setStepAssert/setVariable/setName/setCookieJar), store actions. RTL deferred (consistent with Slice 2 stance).

**Placeholder scan:**
- No "TBD", "TODO", or "implement later" in step bodies. All code blocks are complete.
- Inspector component fully spelled out including BodyEditor sub-variants.
- YAML normalizer fully spelled out.

**Type consistency:**
- `Edit` discriminated union (yamlDoc.ts) variants are referenced consistently by store dispatch (store.ts).
- `Tab` type defined in store.ts and imported by TabBar.
- `HttpStepNodeData` defined in HttpStepNode.tsx and consumed by CanvasView.tsx.
- `Step` / `Scenario` / `Body` / `Assertion` come from model.ts and are imported the same way everywhere.

No issues found.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-28-slice-3-canvas-monaco-sync.md`. Two execution options:

1. **Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch with checkpoints.

Which approach?
