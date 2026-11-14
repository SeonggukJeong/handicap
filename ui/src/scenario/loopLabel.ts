import type { Condition } from "./model";
import { ko } from "../i18n/ko";

// 아웃라인 행·테스트 칩·인스펙터 자식 버튼이 공유하는 loop 횟수 라벨.
// while 없음 → 지금 글자(`× N`) 그대로 (R0).
export function loopCountLabel(step: { repeat?: number; while?: Condition }): string {
  if (step.while === undefined) return `× ${step.repeat ?? 1}`;
  return step.repeat === undefined
    ? ko.editor.loopCondLabelUnlimited
    : ko.editor.loopCondLabelMax(step.repeat);
}
