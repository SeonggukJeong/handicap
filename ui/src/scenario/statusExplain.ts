// 엔진 기본 규칙(검사 없는 스텝의 400 이상) 오류 글에서 상태 코드를 꺼낸다.
// 계약: crates/engine/src/status_rule.rs `status_error_text`가 같은 글을 만든다(②a).
const DEFAULT_RULE_ERROR = /^status (\d{3}) \(>= 400\)$/;

export function defaultRuleCode(error: string | null | undefined): number | null {
  if (!error) return null;
  const m = DEFAULT_RULE_ERROR.exec(error);
  return m ? Number(m[1]) : null;
}
