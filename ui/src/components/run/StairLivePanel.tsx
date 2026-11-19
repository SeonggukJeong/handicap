import { memo, useMemo } from "react";
import type { StairConfig, StairLive } from "../../api/schemas";
import { ko } from "../../i18n/ko";
import { STAIR_STATE_COLOR } from "../report/stair/stairColors";
import {
  liveEmergencyText,
  liveForecastText,
  liveHeadText,
  liveStateLabel,
  liveStopText,
  liveSummaryText,
  type LiveStepState,
} from "./stairLive";

const t = ko.runDetail.stairLive;

interface ChipLook {
  symbol: string;
  color?: string;
  className?: string;
}

function chipLook(s: LiveStepState): ChipLook {
  switch (s) {
    case "ok":
      return { symbol: "✓", color: STAIR_STATE_COLOR.ok };
    case "saturated":
    case "unconfirmed":
      return { symbol: "✗", color: STAIR_STATE_COLOR[s] };
    case "spike":
      return { symbol: "!", color: STAIR_STATE_COLOR.spike };
    case "after":
    case "not_measured":
    case "partial":
    case "skipped":
      return { symbol: "", color: STAIR_STATE_COLOR[s] };
    case "emergency_stopped":
      return { symbol: "■", color: STAIR_STATE_COLOR.emergency_stopped };
    case "measuring":
      return { symbol: "…", className: "border-accent-500 text-accent-700" };
    case "pending":
      return { symbol: "", className: "border-slate-200" };
    case "frozen":
      return { symbol: "–", color: STAIR_STATE_COLOR.not_measured };
  }
}

function StairLivePanelImpl({ live, stair }: { live: StairLive; stair: StairConfig }) {
  const texts = useMemo(() => {
    const head = [liveHeadText(live, stair.targets), liveSummaryText(live)]
      .filter((x): x is string => x != null)
      .join(" · ");
    const forecast = liveForecastText(live);
    return {
      stop: liveStopText(live, stair.targets),
      head: forecast ? `${head} ${forecast}` : head,
      emergency: liveEmergencyText(live, stair.auto_stop?.emergency),
      labels: live.step_states.map((s) => liveStateLabel(s, live)),
    };
  }, [live, stair]);

  return (
    <div className="space-y-2">
      {texts.stop && (
        <p
          data-tone="auto-stop"
          className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm font-medium break-words text-amber-900"
        >
          {texts.stop}
        </p>
      )}
      {texts.head && <p className="text-sm text-slate-800 break-words">{texts.head}</p>}
      {live.frozen && <p className="text-sm text-slate-500">{t.frozenLine}</p>}
      <ol aria-label={t.chipsLabel} className="flex flex-wrap gap-1">
        {live.step_states.map((s, i) => {
          const look = chipLook(s);
          const label = `${i + 1}계단 ${texts.labels[i]}`;
          return (
            <li
              key={i}
              aria-label={label}
              title={label}
              style={look.color ? { borderColor: look.color } : undefined}
              className={`flex min-w-8 items-center justify-center gap-0.5 rounded border-2 bg-white px-1.5 py-0.5 text-xs ${look.className ?? ""}`}
            >
              <span className={s === "pending" ? "text-slate-400" : "text-slate-800"}>{i + 1}</span>
              {look.symbol && (
                <span aria-hidden="true" style={look.color ? { color: look.color } : undefined}>
                  {look.symbol}
                </span>
              )}
            </li>
          );
        })}
      </ol>
      {texts.emergency && <p className="text-sm text-slate-700">{texts.emergency}</p>}
      {live.suspended_seconds > 0 && (
        <p className="text-sm text-slate-500">
          {ko.report.stair.stopSuspendedLine(live.suspended_seconds)}
        </p>
      )}
    </div>
  );
}

export const StairLivePanel = memo(StairLivePanelImpl);
