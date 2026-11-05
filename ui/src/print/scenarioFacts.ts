import { parse } from "yaml";

export type StepFacts = {
  id: string;
  name: string;
  method: string;
  url: string;
  statusCodes: number[];
  fallibleExtract: boolean;
};

export type ScenarioFacts = { ok: true; name: string | null; steps: StepFacts[] } | { ok: false };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

function statusCodeOf(v: unknown): number | null {
  const okType = typeof v === "number" || (typeof v === "string" && v.trim() !== "");
  if (!okType) return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

function factsOf(s: Obj, request: Obj): StepFacts {
  const statusCodes: number[] = [];
  if (Array.isArray(s.assert)) {
    for (const a of s.assert) {
      if (!isObj(a)) continue;
      let raw: unknown;
      if ("status" in a) raw = a.status;
      else if (a.kind === "status") raw = a.code;
      else continue;
      const n = statusCodeOf(raw);
      if (n !== null) statusCodes.push(n);
    }
  }
  const fallibleExtract =
    Array.isArray(s.extract) &&
    s.extract.some(
      (e) => isObj(e) && (e.from === "body" || e.from === "header" || e.from === "cookie"),
    );
  return {
    id: str(s.id),
    name: str(s.name),
    method: typeof request.method === "string" ? request.method : "",
    url: typeof request.url === "string" ? request.url : "",
    statusCodes,
    fallibleExtract,
  };
}

function walk(arr: unknown, out: StepFacts[]): void {
  if (!Array.isArray(arr)) return;
  for (const s of arr) {
    if (!isObj(s)) continue;
    if (s.type === "loop") {
      walk(s.do, out);
    } else if (s.type === "if") {
      walk(s.then, out);
      if (Array.isArray(s.elif)) {
        for (const e of s.elif) if (isObj(e)) walk(e.then, out);
      }
      walk(s.else, out);
    } else if (s.type === "parallel") {
      if (Array.isArray(s.branches)) {
        for (const b of s.branches) if (isObj(b)) walk(b.steps, out);
      }
    } else if (isObj(s.request)) {
      out.push(factsOf(s, s.request));
    }
  }
}

/** Zod를 거치지 않고 YAML을 직접 읽는다 — 모델 검증에 실패하는 시나리오도 보고서는 낼 수 있어야 한다. */
export function readScenarioFacts(yamlText: string): ScenarioFacts {
  let root: unknown;
  try {
    root = parse(yamlText);
  } catch {
    return { ok: false };
  }
  if (!isObj(root)) return { ok: true, name: null, steps: [] };
  const steps: StepFacts[] = [];
  walk(root.steps, steps);
  return {
    ok: true,
    name: typeof root.name === "string" ? root.name : null,
    steps,
  };
}
