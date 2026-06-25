import { useState } from "react";
import { CartesianGrid, Legend, Line, LineChart, Tooltip, XAxis, YAxis } from "recharts";
import { ko } from "../../i18n/ko";
import type { ActiveVuSample, WorkerActiveVuSeries } from "../../api/schemas";

type Props = {
  series: ActiveVuSample[];
  byWorker?: WorkerActiveVuSeries[];
  width?: number;
  height?: number;
};

// fan-out N is small (2–4 typical); cycle a fixed palette.
const WORKER_COLORS = ["#2563eb", "#dc2626", "#16a34a", "#9333ea", "#ea580c", "#0891b2"];

export function ActiveVuChart({ series, byWorker = [], width = 720, height = 220 }: Props) {
  const [byWorkerView, setByWorkerView] = useState(false);
  const multiWorker = byWorker.length >= 2;
  const t0 = series.length > 0 ? series[0].ts_second : 0;

  // Merged ("합계") data — unchanged from before.
  const totalData = series.map((s) => ({
    x: s.ts_second - t0,
    desired: s.desired,
    actual: s.actual,
  }));

  // Per-worker ("워커별") data: one row per elapsed second, d{i}/a{i} per worker.
  const perWorkerData = (() => {
    const byX = new Map<number, Record<string, number>>();
    byWorker.forEach((w, i) => {
      for (const s of w.samples) {
        const x = s.ts_second - t0;
        const row = byX.get(x) ?? { x };
        row[`d${i}`] = s.desired;
        row[`a${i}`] = s.actual;
        byX.set(x, row);
      }
    });
    return [...byX.values()].sort((a, b) => a.x - b.x);
  })();

  const showByWorker = multiWorker && byWorkerView;
  const btnBase = "px-2 py-0.5 border text-xs";

  return (
    <section aria-label={ko.report.activeVuTitle} className="mb-6">
      {multiWorker ? (
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-sm font-semibold text-slate-700">{ko.report.activeVuTitle}</h4>
          <div role="group" aria-label={ko.report.activeVuViewToggleLabel}>
            <button
              type="button"
              aria-pressed={!byWorkerView}
              onClick={() => setByWorkerView(false)}
              className={`${btnBase} rounded-l ${!byWorkerView ? "bg-slate-700 text-white" : "bg-white text-slate-700"}`}
            >
              {ko.report.activeVuViewTotal}
            </button>
            <button
              type="button"
              aria-pressed={byWorkerView}
              onClick={() => setByWorkerView(true)}
              className={`${btnBase} rounded-r border-l-0 ${byWorkerView ? "bg-slate-700 text-white" : "bg-white text-slate-700"}`}
            >
              {ko.report.activeVuViewByWorker}
            </button>
          </div>
        </div>
      ) : (
        <h4 className="text-sm font-semibold text-slate-700 mb-2">{ko.report.activeVuTitle}</h4>
      )}
      {multiWorker ? (
        <p className="text-xs text-slate-500 mb-1">{ko.report.activeVuFanout(byWorker.length)}</p>
      ) : null}
      {showByWorker ? (
        <LineChart width={width} height={height} data={perWorkerData}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="x" label={{ value: "seconds", position: "insideBottom", offset: -4 }} />
          <YAxis
            label={{ value: "VU", angle: -90, position: "insideLeft" }}
            allowDecimals={false}
          />
          <Tooltip />
          <Legend />
          {byWorker.flatMap((_w, i) => {
            const color = WORKER_COLORS[i % WORKER_COLORS.length];
            const name = ko.report.activeVuWorkerLabel(i + 1);
            return [
              <Line
                key={`d${i}`}
                type="linear"
                dataKey={`d${i}`}
                name={`${name} ${ko.report.activeVuDesired}`}
                stroke={color}
                strokeDasharray="4 2"
                dot={false}
                isAnimationActive={false}
              />,
              <Line
                key={`a${i}`}
                type="linear"
                dataKey={`a${i}`}
                name={`${name} ${ko.report.activeVuActual}`}
                stroke={color}
                dot={false}
                isAnimationActive={false}
              />,
            ];
          })}
        </LineChart>
      ) : (
        <LineChart width={width} height={height} data={totalData}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="x" label={{ value: "seconds", position: "insideBottom", offset: -4 }} />
          <YAxis
            label={{ value: "VU", angle: -90, position: "insideLeft" }}
            allowDecimals={false}
          />
          <Tooltip />
          <Legend />
          <Line
            type="linear"
            dataKey="desired"
            name={ko.report.activeVuDesired}
            stroke="#94a3b8"
            strokeDasharray="4 2"
            dot={false}
            isAnimationActive={false}
          />
          <Line
            type="linear"
            dataKey="actual"
            name={ko.report.activeVuActual}
            stroke="#2563eb"
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      )}
      {showByWorker ? (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600 mt-1">
          {byWorker.map((w, i) => (
            <li key={w.worker_id} title={w.worker_id} className="flex items-center gap-1">
              <span aria-hidden="true" style={{ color: WORKER_COLORS[i % WORKER_COLORS.length] }}>
                ■
              </span>
              {ko.report.activeVuWorkerLabel(i + 1)}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
