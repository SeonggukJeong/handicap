import { parseDocument, Document, isMap, isSeq, Scalar, YAMLMap, YAMLSeq, type Node } from "yaml";
import { ScenarioModel, type Scenario, type Condition } from "./model";

export type BranchSel = { kind: "then" } | { kind: "else" } | { kind: "elif"; index: number };

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
  | { type: "addIfStep"; id: string; name: string; childId: string }
  | { type: "setIfCond"; ifId: string; cond: Condition }
  | { type: "setElifCond"; ifId: string; index: number; cond: Condition }
  | { type: "addStepInBranch"; ifId: string; branch: BranchSel; id: string; name: string }
  | {
      type: "addLoopInBranch";
      ifId: string;
      branch: BranchSel;
      id: string;
      name: string;
      childId: string;
    }
  | { type: "addIfInLoop"; loopId: string; id: string; name: string; childId: string }
  | { type: "addElif"; ifId: string; childId: string }
  | { type: "removeElif"; ifId: string; index: number }
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
      error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
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
    case "addIfStep": {
      ensureSeq(doc, ["steps"]);
      const steps = doc.getIn(["steps"]) as YAMLSeq;
      const node = doc.createNode({
        id: edit.id,
        name: edit.name,
        type: "if",
        cond: { left: "", op: "eq", right: "" },
        then: [
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
    case "setIfCond": {
      const ifPath = findStepPath(doc, edit.ifId);
      if (ifPath === null) return;
      doc.setIn([...ifPath, "cond"], doc.createNode(cleanCond(edit.cond)));
      return;
    }
    case "setElifCond": {
      const ifPath = findStepPath(doc, edit.ifId);
      if (ifPath === null) return;
      doc.setIn([...ifPath, "elif", edit.index, "cond"], doc.createNode(cleanCond(edit.cond)));
      return;
    }
    case "addStepInBranch": {
      const ifPath = findStepPath(doc, edit.ifId);
      if (ifPath === null) return;
      const bp = branchPath(edit.branch);
      ensureSeq(doc, [...ifPath, ...bp]);
      const body = doc.getIn([...ifPath, ...bp]) as YAMLSeq;
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
    case "addLoopInBranch": {
      const ifPath = findStepPath(doc, edit.ifId);
      if (ifPath === null) return;
      const bp = branchPath(edit.branch);
      ensureSeq(doc, [...ifPath, ...bp]);
      const body = doc.getIn([...ifPath, ...bp]) as YAMLSeq;
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
      body.add(node);
      return;
    }
    case "addIfInLoop": {
      const loopPath = findStepPath(doc, edit.loopId);
      if (loopPath === null) return;
      ensureSeq(doc, [...loopPath, "do"]);
      const body = doc.getIn([...loopPath, "do"]) as YAMLSeq;
      const node = doc.createNode({
        id: edit.id,
        name: edit.name,
        type: "if",
        cond: { left: "", op: "eq", right: "" },
        then: [
          {
            id: edit.childId,
            name: "Step 1",
            type: "http",
            request: { method: "GET", url: "/" },
            assert: [{ status: 200 }],
          },
        ],
      });
      body.add(node);
      return;
    }
    case "addElif": {
      const ifPath = findStepPath(doc, edit.ifId);
      if (ifPath === null) return;
      ensureSeq(doc, [...ifPath, "elif"]);
      const elif = doc.getIn([...ifPath, "elif"]) as YAMLSeq;
      const node = doc.createNode({
        cond: { left: "", op: "eq", right: "" },
        then: [
          {
            id: edit.childId,
            name: "Step 1",
            type: "http",
            request: { method: "GET", url: "/" },
            assert: [{ status: 200 }],
          },
        ],
      });
      elif.add(node);
      return;
    }
    case "removeElif": {
      const ifPath = findStepPath(doc, edit.ifId);
      if (ifPath === null) return;
      doc.deleteIn([...ifPath, "elif", edit.index]);
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

/** Doc path (relative to the if step) for a branch body. */
function branchPath(branch: BranchSel): Array<string | number> {
  if (branch.kind === "then") return ["then"];
  if (branch.kind === "else") return ["else"];
  return ["elif", branch.index, "then"];
}

// Build a plain JS condition tree for doc.createNode, omitting `right` for the
// `exists`/`empty` ops (the engine serializes Compare without it for those) and
// keeping `right: ""` visible for the other ops so the field stays editable.
function cleanCond(c: Condition): unknown {
  if ("all" in c) return { all: c.all.map(cleanCond) };
  if ("any" in c) return { any: c.any.map(cleanCond) };
  const out: Record<string, unknown> = { left: c.left, op: c.op };
  if (c.op !== "exists" && c.op !== "empty") out.right = c.right ?? "";
  return out;
}

// Tree-aware step locator: recursively searches top-level steps, loop `do` bodies,
// and if branches (then / elif[].then / else). Returns the full doc path or null.
// Callers no-op on null (stale stepIds can arrive after a step is removed).
function findStepPath(doc: Document, stepId: string): Array<string | number> | null {
  return searchSeq(doc.getIn(["steps"]), ["steps"], stepId);
}

function searchSeq(
  seq: unknown,
  basePath: ReadonlyArray<string | number>,
  stepId: string,
): Array<string | number> | null {
  if (!isSeq(seq)) return null;
  for (let i = 0; i < seq.items.length; i++) {
    const item = seq.items[i] as Node;
    if (!isMap(item)) continue;
    const path = [...basePath, i];
    if (item.get("id") === stepId) return path;
    const inLoop = searchSeq(item.get("do"), [...path, "do"], stepId);
    if (inLoop) return inLoop;
    const inThen = searchSeq(item.get("then"), [...path, "then"], stepId);
    if (inThen) return inThen;
    const inElse = searchSeq(item.get("else"), [...path, "else"], stepId);
    if (inElse) return inElse;
    const elif = item.get("elif");
    if (isSeq(elif)) {
      for (let j = 0; j < elif.items.length; j++) {
        const eb = elif.items[j] as Node;
        if (!isMap(eb)) continue;
        const inElif = searchSeq(eb.get("then"), [...path, "elif", j, "then"], stepId);
        if (inElif) return inElif;
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
  if (src.type === "if") {
    return {
      id: src.id,
      name: src.name,
      type: "if",
      cond: src.cond, // shape already matches ConditionModel — passthrough
      then: Array.isArray(src.then) ? src.then.map(normalizeStep) : [],
      elif: Array.isArray(src.elif) ? src.elif.map(normalizeElif) : [],
      else: Array.isArray(src.else) ? src.else.map(normalizeStep) : [],
    };
  }
  const request =
    typeof src.request === "object" && src.request !== null
      ? normalizeRequest(src.request as Record<string, unknown>)
      : src.request;
  const assert = Array.isArray(src.assert) ? src.assert.map(normalizeAssertion) : [];
  const extract = Array.isArray(src.extract) ? src.extract : [];
  return {
    id: src.id,
    name: src.name,
    type: src.type,
    request,
    assert,
    extract,
    ...(src.timeout_seconds != null ? { timeout_seconds: src.timeout_seconds } : {}),
  };
}

function normalizeElif(e: unknown): unknown {
  if (typeof e !== "object" || e === null) return e;
  const src = e as Record<string, unknown>;
  return {
    cond: src.cond,
    then: Array.isArray(src.then) ? src.then.map(normalizeStep) : [],
  };
}

function normalizeRequest(r: Record<string, unknown>): unknown {
  const body = r.body === undefined || r.body === null ? undefined : normalizeBody(r.body);
  return {
    method: r.method,
    url: r.url,
    headers: r.headers ?? {},
    ...(body === undefined ? {} : { body }),
    ...(r.disabled === undefined || r.disabled === null ? {} : { disabled: r.disabled }),
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
