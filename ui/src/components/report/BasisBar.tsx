import type { ReportBasis, ReportSampleName } from "../../api/schemas";
import { ko } from "../../i18n/ko";
import { HelpTip } from "../HelpTip";
import { Segmented } from "../ui/Segmented";
import { basisLine, basisOtherLine } from "./basisText";

type Basis = "steady" | "whole";

export function BasisBar({
  basis,
  onSelect,
  pending,
  sample = "all",
  switched = false,
}: {
  basis: ReportBasis;
  onSelect: (b: Basis) => void;
  pending?: boolean;
  sample?: ReportSampleName;
  switched?: boolean;
}) {
  const t = ko.report.basis;
  const steadyOff = basis.state === "not_reached" || basis.state === "no_common_window";
  const otherText = basisOtherLine(basis, sample, switched, true);
  return (
    <div className="mb-4">
      <Segmented<Basis>
        value={basis.selected}
        onChange={onSelect}
        ariaLabel={t.switchAria}
        busy={pending}
        options={[
          { value: "steady", label: t.steady, disabled: steadyOff },
          { value: "whole", label: t.whole },
        ]}
      />
      {steadyOff && (
        <p role="status" className="mt-2 text-sm text-slate-600">
          {basis.state === "not_reached" ? t.notReached : t.noCommonWindow}
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
        <p className="text-sm text-slate-700">
          {basisLine(basis)}
          <HelpTip label={t.helpLabel}>{t.latencyNote}</HelpTip>
        </p>
        {otherText !== null && <p className="text-sm text-slate-500">{otherText}</p>}
      </div>
    </div>
  );
}
