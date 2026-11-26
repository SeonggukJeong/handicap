import { sparkPath } from "../../report/sparkPath";
import { stepMeanText } from "../../report/stepLatencySeries";
import type { StepLatencyViewProps } from "./stepLatencyViews";

const W = 300;
const H = 80;
/** 혼자 남은 점(둥근 끝)이 가장자리에서 반쯤 잘리지 않게 위아래처럼 좌우도 2 들인다. 띠도 같은 상자. */
const X0 = 2;
const X1 = W - 2;

export function StepLatencyGrid({ series, yMax, xMax, marks }: StepLatencyViewProps) {
  const scale = (x: number) => X0 + (x / Math.max(xMax, 1)) * (X1 - X0);
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mt-3">
      {series.map((s) => (
        <div key={s.stepId} className="rounded-md border border-slate-200 px-2 pt-1.5 pb-1 min-w-0">
          <div title={s.name} className="truncate text-[13px] font-medium">
            {s.name}
          </div>
          <div className="text-[11px] text-slate-500">{stepMeanText(s.stats)}</div>
          <svg
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            width="100%"
            height={H}
            aria-hidden="true"
          >
            {marks?.bands.map((b) => (
              <rect
                key={b.kind}
                x={scale(b.x1)}
                y={0}
                width={Math.max(scale(b.x2) - scale(b.x1), 0)}
                height={H}
                fill={b.kind === "ramp" ? "#94a3b8" : "#f59e0b"}
                fillOpacity={b.kind === "ramp" ? 0.22 : 0.16}
              />
            ))}
            <path
              data-testid="spark-line"
              d={sparkPath(
                s.points.map((p) => ({ x: p.x, y: p.meanMs })),
                {
                  xMax,
                  yMax,
                  x0: X0,
                  x1: X1,
                  yTop: 2,
                  yBottom: H - 2,
                },
              )}
              fill="none"
              stroke="#2563eb"
              strokeWidth={1.6}
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        </div>
      ))}
    </div>
  );
}
