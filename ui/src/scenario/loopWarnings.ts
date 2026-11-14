import { condWhenBodyVarsEmpty, directBodyExtractVars } from "./condEmptyEval";
import { flattenHttpSteps, type LoopStep, type NestedLoopStep, type ThinkTime } from "./model";
import { classifyThink } from "./thinkTime";

export interface LoopWarnings {
  noThink: boolean;
  thinkNotKept: boolean;
  retryOnFailure: boolean;
  unlimited: boolean;
}

const NONE: LoopWarnings = {
  noThink: false,
  thinkNotKept: false,
  retryOnFailure: false,
  unlimited: false,
};

/** 조건 반복(while 있음) loop의 에디터 경고 판정. while 없는 loop은 전부 false. */
export function loopWarnings(
  loop: LoopStep | NestedLoopStep,
  scenarioDefaultThink: ThinkTime | undefined,
): LoopWarnings {
  if (loop.while === undefined) return NONE;
  const leaves = flattenHttpSteps(loop.do);
  const anyThink = leaves.some(
    (h) => classifyThink(h, scenarioDefaultThink, false).effective !== undefined,
  );
  const noThink = !anyThink;
  return {
    noThink,
    thinkNotKept: !noThink && loop.keep_think === false,
    retryOnFailure: condWhenBodyVarsEmpty(loop.while, directBodyExtractVars(loop)) === true,
    unlimited: loop.repeat === undefined,
  };
}
