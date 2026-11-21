import type { ReportBasis } from "../../api/schemas";

// x는 그림의 가로축 값(첫 메트릭 초부터 센 초)
export type SteadyMarks = {
  bands: Array<{ kind: "ramp" | "discard"; x1: number; x2: number }>;
  lines: Array<{ kind: "start" | "end"; x: number }>;
};

export function steadyMarks(
  basis: ReportBasis | undefined,
  firstTs: number | null,
): SteadyMarks | null {
  if (!basis || !basis.window || firstTs === null) return null;
  const lo = basis.window.start_ms / 1000;
  const hi = basis.window.end_ms / 1000;
  const { ramp_seconds, discard_seconds } = basis.config;
  const bands: SteadyMarks["bands"] = [];
  const pushBand = (kind: "ramp" | "discard", from: number, to: number) => {
    const x1 = Math.max(0, from - firstTs);
    const x2 = to - firstTs;
    if (x2 - x1 > 0) bands.push({ kind, x1, x2 });
  };
  pushBand("ramp", lo - discard_seconds - ramp_seconds, lo - discard_seconds);
  pushBand("discard", lo - discard_seconds, lo);
  return {
    bands,
    lines: [
      { kind: "start", x: lo - firstTs },
      { kind: "end", x: hi - 1 - firstTs },
    ],
  };
}
