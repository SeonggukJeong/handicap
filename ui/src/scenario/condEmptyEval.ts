import type { Condition, LoopStep, NestedLoopStep } from "./model";

export type Tri = true | false | "unknown";

/** 본문 직계 http 스텝이 extract하는 변수 이름 (if 분기 안 스텝 제외 — 분기가 안 탄 회차엔 이전 값이 남는다) */
export function directBodyExtractVars(loop: LoopStep | NestedLoopStep): Set<string> {
  const out = new Set<string>();
  for (const s of loop.do) {
    if (s.type === "http") for (const x of s.extract) out.add(x.var);
  }
  return out;
}

const FLOW_TOKEN = /\{\{\s*([^{}]*?)\s*\}\}/g;

/** bodyVars의 {{변수}}를 ""로 치환. 그 밖의 {{…}}·${…}가 남으면 null(알 수 없음). */
function render(s: string, bodyVars: Set<string>): string | null {
  let unknown = false;
  const out = s.replace(FLOW_TOKEN, (_m, name: string) => {
    if (bodyVars.has(name)) return "";
    unknown = true;
    return "";
  });
  // 깨진 토큰({{a}b}}·{{{code}}})은 엔진이 다르게 렌더하므로 판단 보류.
  if (unknown || out.includes("${") || out.includes("{{") || out.includes("}}")) return null;
  if (s.includes("{{{") || s.includes("}}}")) return null;
  return out;
}

/** 엔진은 `"".parse::<f64>()`이 실패하므로 빈·공백 문자열은 숫자가 아니다(`Number("")`는 0). */
function numeric(s: string): number | null {
  if (s.trim() === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function leafWhenEmpty(
  left: string,
  op: string,
  right: string | undefined,
  bodyVars: Set<string>,
): Tri {
  const l = render(left, bodyVars);
  if (l === null) return "unknown";
  if (op === "exists") return l !== "";
  if (op === "empty") return l === "";
  const r = render(right ?? "", bodyVars);
  if (r === null) return "unknown";
  switch (op) {
    case "eq":
      return l === r;
    case "ne":
      return l !== r;
    case "contains":
      return l.includes(r);
    case "matches":
      // Rust regex는 lookaround·역참조를 못 연다 — JS가 열어도 엔진 결과(조건 거짓)와 달라질 수 있다.
      if (/\(\?<?[=!]|\\[1-9]/.test(r)) return "unknown";
      try {
        return new RegExp(r).test(l);
      } catch {
        return "unknown";
      }
    case "lt":
    case "gt":
    case "lte":
    case "gte": {
      const a = numeric(l);
      const b = numeric(r);
      if (a === null || b === null) return false;
      if (op === "lt") return a < b;
      if (op === "gt") return a > b;
      if (op === "lte") return a <= b;
      return a >= b;
    }
    default:
      return "unknown";
  }
}

/** bodyVars에 든 {{변수}}를 ""로 놓고 조건을 3값 평가. 그 밖의 {{…}}·${…}가 있는 잎은 "unknown". */
export function condWhenBodyVarsEmpty(cond: Condition, bodyVars: Set<string>): Tri {
  if ("all" in cond) {
    let unknown = false;
    for (const c of cond.all) {
      const v = condWhenBodyVarsEmpty(c, bodyVars);
      if (v === false) return false;
      if (v === "unknown") unknown = true;
    }
    return unknown ? "unknown" : true;
  }
  if ("any" in cond) {
    let unknown = false;
    for (const c of cond.any) {
      const v = condWhenBodyVarsEmpty(c, bodyVars);
      if (v === true) return true;
      if (v === "unknown") unknown = true;
    }
    return unknown ? "unknown" : false;
  }
  return leafWhenEmpty(cond.left, cond.op, cond.right, bodyVars);
}
