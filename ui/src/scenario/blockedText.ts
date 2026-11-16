import type { StepTrace } from "../api/schemas";
import { ko } from "../i18n/ko";

/** step.error를 보여 줄 문자열 — blocked면 한국어 문구(변수 이름·스텝 이름만, 값 없음), 아니면 error 그대로. */
export function traceErrorText(
  step: Pick<StepTrace, "error" | "blocked">,
  stepName: (id: string) => string | undefined,
): string | null {
  if (!step.error) return null;
  if (step.blocked) {
    const { vars, by_step } = step.blocked;
    return ko.common.blockedByBlank(stepName(by_step) ?? by_step, vars.join(", "));
  }
  return step.error;
}
