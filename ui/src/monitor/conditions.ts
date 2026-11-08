import type { Condition, ConditionOp, ConditionSource } from "../api/monitors";
import { ko } from "../i18n/ko";

/** Mirrors crates/controller/src/monitor/config.rs `validate_conditions` (minus JSONPath parsing). */
const TEN: readonly ConditionOp[] = [
  "eq",
  "ne",
  "exists",
  "not_empty",
  "contains",
  "gt",
  "lt",
  "gte",
  "lte",
  "one_of",
];

export const OPS_BY_SOURCE: Record<ConditionSource, readonly ConditionOp[]> = {
  body: TEN,
  header: TEN,
  status: ["eq", "ne", "gt", "lt", "gte", "lte", "one_of"],
  body_text: ["contains", "not_empty"],
};

export const needsValue = (op: ConditionOp): boolean =>
  op === "eq" ||
  op === "ne" ||
  op === "contains" ||
  op === "gt" ||
  op === "lt" ||
  op === "gte" ||
  op === "lte" ||
  op === "one_of";
export const hasFlags = (op: ConditionOp): boolean =>
  op === "eq" || op === "ne" || op === "contains" || op === "one_of";

/** Mirrors the server: split(',') -> trim -> drop empty. */
export function oneOfCandidates(value: string): string[] {
  return value
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x !== "");
}

const MAX_JSON_UNWRAP = 3;

/** Unwrap one JSON-in-string up to 3 layers; an object/array by then -> it, else null.
 *  Mirrors Rust `unwrap_json_str` (only `{`/`[`/`"` after JSON whitespace are tried). */
function unwrapJsonString(s: string): { value: object; layers: number } | null {
  if (!/^[ \t\n\r]*["[{]/.test(s)) return null;
  let cur: unknown = s;
  for (let i = 1; i <= MAX_JSON_UNWRAP; i++) {
    if (typeof cur !== "string") return null;
    try {
      cur = JSON.parse(cur);
    } catch {
      return null;
    }
    if (typeof cur === "object" && cur !== null) return { value: cur, layers: i };
  }
  return null;
}

/** In place: string fields that are JSON-in-string objects/arrays become that value
 *  (each field up to 3 layers). Iterative — the body may be too deep to recurse.
 *  Returns the number of layers unwrapped. */
function unwrapNestedInPlace(root: unknown): number {
  let count = 0;
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const v = stack.pop();
    if (v === null || typeof v !== "object") continue;
    const rec = v as Record<string, unknown>;
    for (const key of Object.keys(rec)) {
      const child = rec[key];
      if (typeof child === "string") {
        const u = unwrapJsonString(child);
        if (u === null) continue;
        // `key` is an own property (JSON.parse), so even `"__proto__"` is updated in place.
        rec[key] = u.value;
        count += u.layers;
        stack.push(u.value);
      } else {
        stack.push(child);
      }
    }
  }
  return count;
}

/** Body JSON for the response tree: JSON-in-string unwrapped up to 3 layers at the root
 *  (mirrors Rust `parse_body_json`; not an object/array by then -> the first parsed value),
 *  then string fields holding JSON-in-string objects/arrays are unwrapped too. The server
 *  looks a path up in the root-only value first and in the nested-unwrapped one only when
 *  missing (Rust `BodyJson::path_first`), so every path in this tree resolves there.
 *  `unwrapped` = total layers unwrapped. Not JSON -> null. */
export function parseBodyJson(body: string): { value: unknown; unwrapped: number } | null {
  let first: unknown;
  try {
    first = JSON.parse(body);
  } catch {
    return null;
  }
  const root = typeof first === "string" ? unwrapJsonString(first) : null;
  const value = root !== null ? root.value : first;
  const nested = unwrapNestedInPlace(value);
  return { value, unwrapped: (root?.layers ?? 0) + nested };
}

const NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
/** Same answer as Rust `parse_finite` (JS `Number("")===0`, `Number("0x10")===16` are excluded). */
export function isFiniteNumberText(s: string): boolean {
  const t = s.trim();
  return NUMBER_RE.test(t) && Number.isFinite(Number(t));
}

const len = (s: string): number => [...s].length;

export function normalizeCondition(c: Condition): Condition {
  const n = { ...c };
  if (n.source === "header") n.path = n.path.trim();
  else if (n.source !== "body") n.path = "";
  if (!needsValue(n.op)) n.value = "";
  if (!hasFlags(n.op)) {
    n.ignore_case = false;
    n.trim = false;
  }
  return n;
}

/** Validation of an (already normalized) condition; null = OK. */
export function conditionError(c: Condition): string | null {
  const k = ko.monitor;
  if (c.source === "body") {
    if (len(c.path) < 1 || len(c.path) > 500 || !c.path.startsWith("$")) return k.condErrPath;
  } else if (c.source === "header") {
    const p = c.path.trim();
    if (len(p) < 1 || len(p) > 200) return k.condErrPath;
  }
  if (len(c.value) > 200) return k.condErrTooLong;
  if (c.op === "contains" && c.value === "") return k.condErrValue;
  if (
    (c.op === "gt" || c.op === "lt" || c.op === "gte" || c.op === "lte") &&
    !isFiniteNumberText(c.value)
  )
    return k.condErrNumber;
  if (c.op === "one_of" && oneOfCandidates(c.value).length === 0) return k.condErrOneOf;
  return null;
}

export function targetLabel(c: Pick<Condition, "source" | "path">): string {
  const k = ko.monitor;
  switch (c.source) {
    case "body": {
      if (c.path === "$") return k.condTargetBodyRoot;
      const rest = c.path.startsWith("$.")
        ? c.path.slice(2)
        : c.path.startsWith("$")
          ? c.path.slice(1)
          : c.path;
      return k.condTargetBody(rest);
    }
    case "header":
      return k.condTargetHeader(c.path);
    case "status":
      return k.condTargetStatus;
    case "body_text":
      return k.condTargetBodyText;
  }
}

export function conditionSummary(c: Condition, stepName: string | undefined): string {
  let s = `${targetLabel(c)} ${ko.monitor.condOpLabel[c.op]}`;
  if (c.op === "one_of") s += ` {${oneOfCandidates(c.value).join(", ")}}`;
  else if (needsValue(c.op)) s += c.value === "" ? ` ""` : ` ${c.value}`;
  s += ` · ${stepName ?? c.step_id}`;
  if (c.ignore_case) s += ` · ${ko.monitor.condIgnoreCase}`;
  if (c.trim) s += ` · ${ko.monitor.condTrim}`;
  return s;
}

export type ConditionClick =
  | { kind: "body"; path: string; value: string | number | boolean | null }
  | { kind: "header"; name: string; value: string }
  | { kind: "status"; status: number }
  | { kind: "body_text" };

const VOLATILE_LEN = 40;

export function defaultCondition(
  stepId: string,
  click: ConditionClick,
): { condition: Condition; volatileHint: boolean } {
  const mk = (source: ConditionSource, path: string, op: ConditionOp, value: string) => ({
    step_id: stepId,
    source,
    path,
    op,
    value,
    ignore_case: false,
    trim: false,
  });
  const str = (source: ConditionSource, path: string, v: string) =>
    len(v) <= VOLATILE_LEN
      ? { condition: mk(source, path, "eq", v), volatileHint: false }
      : { condition: mk(source, path, "not_empty", ""), volatileHint: true };
  switch (click.kind) {
    case "body": {
      const v = click.value;
      if (v === null)
        return { condition: mk("body", click.path, "exists", ""), volatileHint: false };
      if (typeof v === "string") return str("body", click.path, v);
      return { condition: mk("body", click.path, "eq", String(v)), volatileHint: false };
    }
    case "header":
      return str("header", click.name, click.value);
    case "status":
      return {
        condition: mk("status", "", "eq", String(click.status)),
        volatileHint: false,
      };
    case "body_text":
      return { condition: mk("body_text", "", "contains", ""), volatileHint: false };
  }
}
