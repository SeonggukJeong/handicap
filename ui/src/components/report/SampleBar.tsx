import type { ReportSampleName, Report } from "../../api/schemas";
import { ko } from "../../i18n/ko";
import { sampleName, sampleView } from "../../report/sampleView";
import { HelpTip } from "../HelpTip";
import { Badge } from "../ui/Badge";
import { Callout } from "../ui/Callout";
import { Segmented } from "../ui/Segmented";

const ORDER: ReportSampleName[] = ["passed", "failed", "all"];

/**
 * 응답 시간을 어느 요청으로 계산했는지 알리고 표본을 고르는 줄.
 * 단추는 `requested`(없으면 기본 표본)를 따르고, 설명·안내 상자는 실제로 받은 표본을 따른다.
 */
export function SampleBar({
  report,
  requested,
  pending,
  onSelect,
}: {
  report: Pick<Report, "windows" | "sample">;
  requested?: ReportSampleName;
  pending?: boolean;
  onSelect?: (s: ReportSampleName) => void;
}) {
  if (report.windows.length === 0) return null;
  const t = ko.report.sample;
  const view = sampleView(report);
  if (!view.split) {
    return (
      <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
        <span className="text-[13px] font-medium text-slate-600">{t.barLabel}</span>
        <Badge tone="neutral" weight="medium">
          {t.all}
        </Badge>
        <span className="text-xs text-slate-500">{t.allHint}</span>
      </div>
    );
  }
  const copy = {
    passed: { when: t.whenPassed, look: t.lookPassed },
    failed: { when: t.whenFailed, look: t.lookFailed },
    all: { when: t.whenAll, look: t.lookAll },
  } as const;
  const hint =
    view.selected === "passed"
      ? t.passedHint
      : view.selected === "failed"
        ? t.failedHint
        : t.allSelectedHint;
  return (
    <>
      <div
        className={`${view.switched ? "mb-2" : "mb-4"} flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-slate-200 bg-slate-50 px-3 py-2`}
      >
        <span className="text-[13px] font-medium text-slate-600">{t.barLabel}</span>
        <Segmented<ReportSampleName>
          value={requested ?? view.default}
          onChange={(s) => onSelect?.(s)}
          ariaLabel={t.switchAria}
          busy={pending}
          className="max-w-full flex-wrap"
          options={ORDER.map((s) => ({
            value: s,
            label: sampleName(s),
            description: (
              <>
                <span className="block">{copy[s].when}</span>
                <span className="mt-1.5 block">{copy[s].look}</span>
              </>
            ),
          }))}
        />
        <HelpTip label={t.helpLabel}>
          {ORDER.map((s, i) => (
            <span key={s} className={i === 0 ? "block" : "mt-1.5 block"}>
              <b className="text-slate-900">{sampleName(s)}</b> — {copy[s].when} {copy[s].look}
            </span>
          ))}
          <span className="mt-1.5 block">
            {t.passedHelpLead}
            {t.passedHelp}
          </span>
        </HelpTip>
        <span className="text-xs text-slate-500">{hint}</span>
      </div>
      {view.switched && (
        <Callout variant="warn" role="note" className="mb-4">
          {t.switchedNote(sampleName(view.selected))}
        </Callout>
      )}
    </>
  );
}
