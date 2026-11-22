import { useMemo } from "react";
import { useDatasets } from "../../api/hooks";
import { ko } from "../../i18n/ko";
import { Callout } from "../ui/Callout";
import { setupNotices, type SetupNotice, type SetupNoticeInput } from "./setupNoticeRules";

const T = ko.runDialog.setupNotice;

function noticeText(n: SetupNotice): string {
  switch (n.kind) {
    case "burst":
      return T.burst;
    case "per_slot":
      return T.perSlot(n.slots);
    case "shared_rows":
      return T.sharedRows(n.rows, n.units, n.unit);
    case "not_per_vu":
      return T.notPerVu(n.vars);
  }
}

export function SetupNotices(props: Omit<SetupNoticeInput, "rowCounts">) {
  const datasets = useDatasets();
  const rowCounts = useMemo(
    () => Object.fromEntries((datasets.data?.datasets ?? []).map((d) => [d.id, d.row_count])),
    [datasets.data],
  );
  const notices = setupNotices({ ...props, rowCounts });
  if (notices.length === 0) return null;
  return (
    <Callout variant="info" role="status" title={T.title} className="mb-3">
      <ul className="list-disc pl-5">
        {notices.map((n, i) => (
          <li key={`${i}-${n.kind}`} className="mt-1 first:mt-0">
            {noticeText(n)}
          </li>
        ))}
      </ul>
    </Callout>
  );
}
