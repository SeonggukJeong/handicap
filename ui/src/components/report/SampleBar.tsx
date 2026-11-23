import { reportSample, type Report } from "../../api/schemas";
import { ko } from "../../i18n/ko";
import { HelpTip } from "../HelpTip";
import { Badge } from "../ui/Badge";

/** 응답 시간을 어느 요청으로 계산했는지 알리는 줄. 전환 단추는 없다. */
export function SampleBar({ report }: { report: Pick<Report, "windows" | "sample"> }) {
  if (report.windows.length === 0) return null;
  const t = ko.report.sample;
  const { split } = reportSample(report);
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
      <span className="text-[13px] font-medium text-slate-600">{t.barLabel}</span>
      <Badge tone={split ? "accent" : "neutral"} weight="medium">
        {split ? t.passed : t.all}
      </Badge>
      {split && <HelpTip label={t.helpLabel}>{t.passedHelp}</HelpTip>}
      <span className="text-xs text-slate-500">{split ? t.passedHint : t.allHint}</span>
    </div>
  );
}
