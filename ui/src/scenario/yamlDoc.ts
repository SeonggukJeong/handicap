import {
  parseDocument,
  Document,
  isMap,
  isSeq,
  Scalar,
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
  | { type: "addLoopStep"; id: string; name: string; childId: string }
  | { type: "addStepInLoop"; loopId: string; id: string; name: string }
  | { type: "setLoopRepeat"; loopId: string; repeat: number }
  | { type: "removeStep"; stepId: string }
  | { type: "moveStep"; stepId: string; toIndex: number }
  | {
      type: "setStepField";
      stepId: string;
      path: ReadonlyArray<string>;
      value: unknown;
    }
  | {
      type: "setStepAssert";
      stepId: string;
      asserts: ReadonlyArray<{ kind: "status"; code: number }>;
    }
  | {
      type: "setStepExtract";
      stepId: string;
      extract: ReadonlyArray<
        | { var: string; from: "body"; path: string }
        | { var: string; from: "header"; name: string }
        | { var: string; from: "cookie"; name: string }
        | { var: string; from: "status" }
      >;
    };

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
    return {
      error: parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; "),
    };
  }
  return { doc, model: parsed.data };
}

export function serializeDoc(doc: Document): string {
  return String(doc);
}

export function applyEdit(doc: Document, edit: Edit): void {
  switch (edit.type) {
    case "setName":
      doc.setIn(["name"], plainScalar(edit.value));
      return;
    case "setCookieJar":
      doc.setIn(["cookie_jar"], plainScalar(edit.value));
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
    case "addLoopStep": {
      ensureSeq(doc, ["steps"]);
      const steps = doc.getIn(["steps"]) as YAMLSeq;
      const node = doc.createNode({
        id: edit.id,
        name: edit.name,
        type: "loop",
        repeat: 1,
        do: [
          {
            id: edit.childId,
            name: "Step 1",
            type: "http",
            request: { method: "GET", url: "/" },
            assert: [{ status: 200 }],
          },
        ],
      });
      steps.add(node);
      return;
    }
    case "addStepInLoop": {
      const loopPath = findStepPath(doc, edit.loopId);
      if (loopPath === null) return;
      ensureSeq(doc, [...loopPath, "do"]);
      const body = doc.getIn([...loopPath, "do"]) as YAMLSeq;
      const node = doc.createNode({
        id: edit.id,
        name: edit.name,
        type: "http",
        request: { method: "GET", url: "/" },
        assert: [{ status: 200 }],
      });
      body.add(node);
      return;
    }
    case "setLoopRepeat": {
      const loopPath = findStepPath(doc, edit.loopId);
      if (loopPath === null) return;
      doc.setIn([...loopPath, "repeat"], edit.repeat);
      return;
    }
    case "removeStep": {
      const path = findStepPath(doc, edit.stepId);
      if (path === null) return;
      doc.deleteIn(path);
      return;
    }
    case "moveStep": {
      const path = findStepPath(doc, edit.stepId);
      if (path === null) return;
      // Reorder within the step's own parent sequence (top-level or a loop body).
      const parentPath = path.slice(0, -1);
      const fromIdx = path[path.length - 1] as number;
      const parent = doc.getIn(parentPath) as YAMLSeq;
      const node = parent.items[fromIdx];
      parent.items.splice(fromIdx, 1);
      parent.items.splice(edit.toIndex, 0, node);
      return;
    }
    case "setStepField": {
      const path = findStepPath(doc, edit.stepId);
      if (path === null) return;
      const fullPath: Array<string | number> = [...path, ...edit.path];
      if (edit.value === undefined) {
        doc.deleteIn(fullPath);
        return;
      }
      // Objects/arrays must be wrapped in a Node so the AST stays well-formed.
      // Primitives fall through and yaml's setIn handles them natively.
      const node =
        typeof edit.value === "object" && edit.value !== null
          ? doc.createNode(edit.value)
          : edit.value;
      doc.setIn(fullPath, node);
      return;
    }
    case "setStepAssert": {
      const path = findStepPath(doc, edit.stepId);
      if (path === null) return;
      const arr = edit.asserts.map((a) => ({ status: a.code }));
      doc.setIn([...path, "assert"], doc.createNode(arr));
      return;
    }
    case "setStepExtract": {
      const path = findStepPath(doc, edit.stepId);
      if (path === null) return;
      if (edit.extract.length === 0) {
        doc.deleteIn([...path, "extract"]);
        return;
      }
      doc.setIn([...path, "extract"], doc.createNode(edit.extract));
      return;
    }
  }
}

/** Create a PLAIN (unquoted) scalar to avoid inheriting the original node's quote style. */
function plainScalar(value: string): Scalar {
  const s = new Scalar(value);
  s.type = Scalar.PLAIN;
  return s;
}

// Tree-aware step locator: searches top-level steps and one level of loop `do`
// bodies (single-level nesting for Slice 7). Returns the full doc path, or null
// if no step matches. Callers no-op on null because stale stepIds can arrive
// after a step has been removed (e.g., via the YAML pane); the store re-derives
// the model after each edit, so a stale click resolves to no change.
function findStepPath(
  doc: Document,
  stepId: string,
): Array<string | number> | null {
  const steps = doc.getIn(["steps"]);
  if (!isSeq(steps)) return null;
  for (let i = 0; i < steps.items.length; i++) {
    const item = steps.items[i] as Node;
    if (!isMap(item)) continue;
    if (item.get("id") === stepId) return ["steps", i];
    const body = item.get("do");
    if (isSeq(body)) {
      for (let j = 0; j < body.items.length; j++) {
        const inner = body.items[j] as Node;
        if (isMap(inner) && inner.get("id") === stepId)
          return ["steps", i, "do", j];
      }
    }
  }
  return null;
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
//   - pass `extract` through (Slice 4 — wired in normalizeStep)
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
  if (src.type === "loop") {
    return {
      id: src.id,
      name: src.name,
      type: "loop",
      repeat: src.repeat,
      do: Array.isArray(src.do) ? src.do.map(normalizeStep) : [],
    };
  }
  const request =
    typeof src.request === "object" && src.request !== null
      ? normalizeRequest(src.request as Record<string, unknown>)
      : src.request;
  const assert = Array.isArray(src.assert)
    ? src.assert.map(normalizeAssertion)
    : [];
  const extract = Array.isArray(src.extract) ? src.extract : [];
  return {
    id: src.id,
    name: src.name,
    type: src.type,
    request,
    assert,
    extract,
  };
}

function normalizeRequest(r: Record<string, unknown>): unknown {
  const body =
    r.body === undefined || r.body === null
      ? undefined
      : normalizeBody(r.body);
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
