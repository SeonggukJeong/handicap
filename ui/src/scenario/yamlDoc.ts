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
      const idx = findStepIndex(doc, edit.stepId);
      if (idx === -1) return;
      const arr = edit.asserts.map((a) => ({ status: a.code }));
      doc.setIn(["steps", idx, "assert"], doc.createNode(arr));
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

// Returns -1 if no step matches; callers no-op on -1 because stale stepIds can
// arrive after a step has been removed (e.g., via the YAML pane). The store
// re-derives the model after each edit, so a stale click resolves to no change.
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
  const assert = Array.isArray(src.assert)
    ? src.assert.map(normalizeAssertion)
    : [];
  return {
    id: src.id,
    name: src.name,
    type: src.type,
    request,
    assert,
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
