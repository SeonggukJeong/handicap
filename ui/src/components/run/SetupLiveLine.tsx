import { ko } from "../../i18n/ko";
import type { SetupLiveView } from "./setupLive";

const fmt = (n: number) => n.toLocaleString("en-US");

export function SetupLiveLine({ view }: { view: SetupLiveView }) {
  const t = ko.runDetail.setupLive;
  const slot = view.unit === "slot";
  const warn = view.failed > 0;
  return (
    <div
      className={`flex flex-wrap items-center gap-3 rounded-md border px-3 py-2 text-sm mb-6 ${
        warn ? "border-amber-300 bg-amber-50" : "border-slate-200 bg-white"
      }`}
    >
      <span className="font-semibold text-slate-700 shrink-0">{t.label}</span>
      <span className="tabular-nums shrink-0" data-testid="setup-live-num">
        <b className="font-semibold">{fmt(view.ok)}</b>
        {view.total === null ? t.doneSuffix(slot) : t.ofTotal(fmt(view.total), slot)}
      </span>
      {warn && (
        <span className="font-semibold text-amber-800 shrink-0">
          {t.failed(fmt(view.failed), slot)}
        </span>
      )}
      {view.total !== null && (
        <span
          data-testid="setup-live-bar"
          aria-hidden="true"
          className="flex h-1.5 min-w-[80px] flex-1 basis-[120px] overflow-hidden rounded-full bg-slate-100"
        >
          <i className="block h-full bg-accent-500" style={{ width: `${view.okPct}%` }} />
          <i className="block h-full bg-amber-500" style={{ width: `${view.failedPct}%` }} />
        </span>
      )}
      {warn && (
        <span className="basis-full text-xs text-amber-800">{slot ? t.hintSlot : t.hintVu}</span>
      )}
    </div>
  );
}
