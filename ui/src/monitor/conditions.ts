import type { Condition, ConditionOp, ConditionSource } from "../api/monitors";
import { ko } from "../i18n/ko";

/** Mirrors crates/controller/src/monitor/config.rs `validate_conditions` (minus JSONPath parsing). */
const SEVEN: readonly ConditionOp[] = ["eq", "ne", "exists", "not_empty", "contains", "gt", "lt"];

export const OPS_BY_SOURCE: Record<ConditionSource, readonly ConditionOp[]> = {
  body: SEVEN,
  header: SEVEN,
  status: ["eq", "ne", "gt", "lt"],
  body_text: ["contains", "not_empty"],
};

export const needsValue = (op: ConditionOp): boolean =>
  op === "eq" || op === "ne" || op === "contains" || op === "gt" || op === "lt";
export const hasFlags = (op: ConditionOp): boolean =>
  op === "eq" || op === "ne" || op === "contains";

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
  if ((c.op === "gt" || c.op === "lt") && !isFiniteNumberText(c.value)) return k.condErrNumber;
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
  let s = `${stepName ?? c.step_id} · ${targetLabel(c)} ${ko.monitor.condOpLabel[c.op]}`;
  if (needsValue(c.op)) s += c.value === "" ? ` ""` : ` ${c.value}`;
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
