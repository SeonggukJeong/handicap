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
    // 호출부가 평범한 객체로 조회하면 `constructor`·`__proto__` 같은 id에 문자열이 아닌 값이 온다.
    const name: unknown = stepName(by_step);
    const label = typeof name === "string" && name.trim() !== "" ? name : by_step;
    return ko.common.blockedByBlank(label, vars.join(", "));
  }
  return step.error;
}

/** 기본값이 들어간 추출 이름 한 줄 — 없거나 비면 null (값은 싣지 않는다). */
export function defaultedText(step: Pick<StepTrace, "defaulted">): string | null {
  const names = step.defaulted ?? [];
  return names.length > 0 ? ko.common.defaultedNames(names.join(", ")) : null;
}
