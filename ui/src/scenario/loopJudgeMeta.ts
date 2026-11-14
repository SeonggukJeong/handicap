import type { Step } from "./model";

export type LoopJudgeMeta = Record<string, { name: string; maxPasses: number | undefined }>;

/** 조건 반복(while 있는 loop) id → 이름·최대 횟수. trace의 loop 판정 행(step_id = loop id)을
 *  사람이 읽는 이름으로 바꾸는 데 쓴다. 최상위·if 분기·parallel 분기 안까지 훑는다. */
export function loopJudgeMeta(scenario: { steps: ReadonlyArray<Step> }): LoopJudgeMeta {
  const out: LoopJudgeMeta = {};
  const walk = (steps: ReadonlyArray<Step>) => {
    for (const s of steps) {
      if (s.type === "loop") {
        if (s.while !== undefined) out[s.id] = { name: s.name, maxPasses: s.repeat };
        walk(s.do);
      } else if (s.type === "if") {
        walk(s.then);
        for (const e of s.elif) walk(e.then);
        walk(s.else);
      } else if (s.type === "parallel") {
        for (const b of s.branches) walk(b.steps);
      }
    }
  };
  walk(scenario.steps);
  return out;
}
