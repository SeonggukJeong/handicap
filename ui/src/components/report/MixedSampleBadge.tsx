import { ko } from "../../i18n/ko";
import { HelpTip } from "../HelpTip";
import { Badge } from "../ui/Badge";

/** 응답 시간 표본을 나눈 run에서, 아직 나누지 않은 구획(실패한 요청도 들어 있는 값) 옆에 단다. 제목·라벨의 형제로 둔다. */
export function MixedSampleBadge({ className }: { className?: string }) {
  const t = ko.report.sample;
  return (
    <span className={`inline-flex items-center ${className ?? ""}`}>
      <Badge tone="neutral">{t.mixedBadge}</Badge>
      <HelpTip label={t.mixedHelpLabel}>{t.mixedTitle}</HelpTip>
    </span>
  );
}
