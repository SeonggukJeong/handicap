import type { StairReport } from "../../../api/schemas";
import { clockText, stopLineText, suspendedLineText } from "./stairFormat";

/** 정지 줄(노랑) 또는 보류만 있을 때 회색 줄 — 정적 텍스트. 기록이 없으면 아무것도 그리지 않는다. */
export function StairStopLine({ stair }: { stair: StairReport }) {
  const stop = stair.auto_stop?.stop;
  if (stop) {
    const text = stopLineText(stair, clockText(stop.stopped_at_ms));
    return (
      <p
        data-tone="auto-stop"
        className="mb-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm font-medium break-words text-amber-900"
      >
        {text}
      </p>
    );
  }
  const suspended = suspendedLineText(stair);
  if (!suspended) return null;
  return (
    <p
      data-tone="auto-stop-suspended"
      className="mb-3 rounded-md border border-slate-300 bg-slate-50 p-3 text-sm break-words text-slate-700"
    >
      {suspended}
    </p>
  );
}
