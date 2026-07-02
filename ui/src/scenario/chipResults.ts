import type { ScenarioTrace } from "../api/schemas";

// TestRunPanel에서 추출한 branch 라벨 단일 소스 — 문자열 byte-identical(spec R3).
// 키는 엔진 select_branch의 값 그대로: "then" / "elif_{j}"(0-based) / "else" / "none".
export const BRANCH_LABEL: Record<string, string> = {
  none: "(미매치)",
  then: "then",
  else: "else",
};

export function branchText(branch: string): string {
  if (BRANCH_LABEL[branch]) return BRANCH_LABEL[branch];
  const m = /^elif_(\d+)$/.exec(branch);
  return m ? `elif ${m[1]}` : branch;
}

export type ChipResult =
  | { kind: "http"; result: "pass" | "fail" }
  | { kind: "if"; branches: string[] };

/** 마지막 test-run trace에서 스텝별 칩 결과를 파생한다(spec R4).
 *  http: 같은 step_id 행 중 하나라도 error∥status≥400 → fail, 아니면 pass
 *  (statusClass의 fail 판정과 동일 기준 — 3xx 클린 행은 pass).
 *  if: 타진 branch 고유 집합(순서 보존 — loop 안 if는 반복마다 다른 분기 가능).
 *  맵에 없는 step_id = 이번 실행에서 행 없음 = 미실행(○). */
export function deriveChipResults(trace: ScenarioTrace): Map<string, ChipResult> {
  const out = new Map<string, ChipResult>();
  for (const row of trace.steps) {
    if (row.kind === "if") {
      const prev = out.get(row.step_id);
      const branches = prev?.kind === "if" ? prev.branches : [];
      if (row.branch != null && !branches.includes(row.branch)) branches.push(row.branch);
      out.set(row.step_id, { kind: "if", branches });
      continue;
    }
    const failed = row.error != null || (row.response != null && row.response.status >= 400);
    const prev = out.get(row.step_id);
    const wasFail = prev?.kind === "http" && prev.result === "fail";
    out.set(row.step_id, { kind: "http", result: failed || wasFail ? "fail" : "pass" });
  }
  return out;
}
