import type { Condition, LoopStep, NestedLoopStep } from "./model";

export type Tri = true | false | "unknown";

/**
 * 본문 직계 http 스텝이 extract하는 변수 이름 → 못 뽑았을 때 값 (if 분기 안 스텝 제외 — 분기가
 * 안 탄 회차엔 이전 값이 남는다). 값 = 스텝별로 그 이름의 `default`가 있는 마지막 항목의 기본값(없으면 ""), 뒤 스텝이 앞 스텝을 덮어쓴다.
 */
export function directBodyExtractSubst(loop: LoopStep | NestedLoopStep): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of loop.do) {
    if (s.type !== "http") continue;
    // 값은 스텝마다 따로 정하고(그 스텝의 기본값 있는 마지막 항목, 없으면 ""), 뒤 스텝이 앞 스텝을 덮어쓴다.
    const perStep = new Map<string, string>();
    for (const x of s.extract) {
      const d = x.from === "status" ? undefined : x.default;
      if (d !== undefined) perStep.set(x.var, d);
      else if (!perStep.has(x.var)) perStep.set(x.var, "");
    }
    for (const [k, v] of perStep) out.set(k, v);
  }
  return out;
}

const FLOW_TOKEN = /\{\{\s*([^{}]*?)\s*\}\}/g;

/** subst의 {{변수}}를 그 값(못 뽑았을 때 값)으로 치환. 그 밖의 {{…}}·${…}가 남으면 null(알 수 없음). */
function render(s: string, subst: Map<string, string>): string | null {
  let unknown = false;
  const out = s.replace(FLOW_TOKEN, (_m, name: string) => {
    const v = subst.get(name);
    if (v !== undefined) return v;
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
  subst: Map<string, string>,
): Tri {
  const l = render(left, subst);
  if (l === null) return "unknown";
  if (op === "exists") return l !== "";
  if (op === "empty") return l === "";
  const r = render(right ?? "", subst);
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
      if (/\(\?<?[=!]|\\[1-9]|\\k</.test(r)) return "unknown";
      // 이 평가는 렌더 경로에서 사용자 정규식을 돌린다 — 파국적 역추적으로 에디터가 멈추지 않게:
      // 왼쪽이 빈 문자열일 때(재시도 실패 경우)만 돌리고, 긴 패턴·묶음에 반복이 붙은 패턴은 보류.
      if (l !== "" || r.length > 200 || /\)[*+?{]|\|/.test(r)) return "unknown";
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

/** subst에 든 {{변수}}를 못 뽑았을 때 값으로 놓고 조건을 3값 평가. 그 밖의 {{…}}·${…}가 있는 잎은 "unknown". */
export function condWhenBodyVarsEmpty(cond: Condition, subst: Map<string, string>): Tri {
  if ("all" in cond) {
    let unknown = false;
    for (const c of cond.all) {
      const v = condWhenBodyVarsEmpty(c, subst);
      if (v === false) return false;
      if (v === "unknown") unknown = true;
    }
    return unknown ? "unknown" : true;
  }
  if ("any" in cond) {
    let unknown = false;
    for (const c of cond.any) {
      const v = condWhenBodyVarsEmpty(c, subst);
      if (v === true) return true;
      if (v === "unknown") unknown = true;
    }
    return unknown ? "unknown" : false;
  }
  return leafWhenEmpty(cond.left, cond.op, cond.right, subst);
}
