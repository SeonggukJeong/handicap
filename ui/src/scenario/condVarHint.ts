import type { Scenario } from "./model";
import { buildVarRows } from "./varRows";

/** 변수 패널에 보이는 이름 전체(선언·추출·parallel 분기 변수) — 조건 칸의 "중괄호 빠뜨림"
 *  안내가 비교하는 집합. 미정의 행은 제외(그 이름은 아직 변수가 아니다). parallel 행은
 *  다운스트림 형태 `b.v`와 분기 안 형태 `v` 둘 다 넣는다. */
export function knownVarNames(model: Scenario | null): Set<string> {
  const out = new Set<string>();
  for (const row of buildVarRows(model)) {
    if (row.kind === "declared" || row.kind === "flat-extract") out.add(row.name);
    else if (row.kind === "parallel-extract") {
      out.add(row.display);
      out.add(row.varName);
    }
  }
  return out;
}

/** 조건 오퍼랜드가 `{{ }}` 없이 변수명과 정확히 같으면 그 이름, 아니면 null. 엔진은 이런
 *  오퍼랜드를 글자 그대로 비교하므로(`flag` exists = 항상 참) 의도와 다르게 동작한다. */
export function bareVarMatch(operand: string, known: ReadonlySet<string>): string | null {
  const name = operand.trim();
  return name !== "" && known.has(name) ? name : null;
}
