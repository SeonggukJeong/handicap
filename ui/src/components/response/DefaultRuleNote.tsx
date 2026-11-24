import { ko } from "../../i18n/ko";
import { defaultRuleCode } from "../../scenario/statusExplain";

/** 검사 없는 스텝의 400 이상 오류에 이유를 덧붙인다 — 원래 오류 글 바로 위에 둔다. */
export function DefaultRuleNote({ error }: { error: string | null | undefined }) {
  const code = defaultRuleCode(error);
  if (code == null) return null;
  return (
    <p className="my-1 rounded-md border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-800">
      {ko.common.defaultRuleExplain(code)}
    </p>
  );
}
