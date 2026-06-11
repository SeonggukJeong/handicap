import { HelpTip } from "../HelpTip";
import { ko } from "../../i18n/ko";

/** 변수 표기 3분류(ADR-0014) 치트시트 popover — Variables 패널·스텝 설정 공용 (spec §5.3).
 *  본문은 ko.glossary 단일 소스. HelpTip popover는 <span>이라 블록 *요소* 금지 —
 *  display:block 클래스를 단 span 3줄로 줄바꿈한다. */
export function VarCheatSheet() {
  return (
    <HelpTip label={ko.editor.varCheatSheetLabel}>
      <span className="block">{ko.glossary.varFlow}</span>
      <span className="mt-1 block">{ko.glossary.varEnv}</span>
      <span className="mt-1 block">{ko.glossary.varSys}</span>
    </HelpTip>
  );
}
