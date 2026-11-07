import type { SVGProps } from "react";

type Stage = { target: number; duration_seconds: number };

/** footer 부하-모양 시그니처 — *장식*(데이터 차트 아님)이라 accent 색 OK.
 *  flat=수평 일정선, curve=stages 비례 polyline. StageCurvePreview와 달리
 *  (0,0) 시작을 강제하지 않는다(고정 부하가 대각 ramp로 안 보이게). */
export function LoadShapePreview({
  kind,
  stages,
  width,
  height,
  className, // 분리해서 머지 — `...rest`에 두면 하드코딩 text-accent-600을 덮어 색 소실(R2)
  ...rest
}: {
  kind: "flat" | "curve";
  stages?: Stage[];
  width: number;
  height: number;
} & Pick<SVGProps<SVGSVGElement>, "role" | "aria-label" | "aria-hidden" | "className">) {
  const pad = 2;
  const w = width - pad * 2;
  const h = height - pad * 2;
  let points: string;
  if (kind === "curve" && stages && stages.length > 0) {
    // 누적 시간(x) × target(y) 제어점. y는 0..maxTarget를 height에 매핑(위가 큰 값).
    const maxT = Math.max(...stages.map((s) => s.target), 1);
    const totalD = stages.reduce((a, s) => a + s.duration_seconds, 0) || 1;
    const pts: [number, number][] = [[0, 0]];
    let acc = 0;
    for (const s of stages) {
      acc += s.duration_seconds;
      pts.push([acc / totalD, s.target / maxT]);
    }
    points = pts.map(([fx, fy]) => `${pad + fx * w},${pad + (1 - fy) * h}`).join(" ");
  } else {
    // flat: 일정 레벨(중간 높이). 두 점 = 수평선.
    const y = pad + h * 0.4;
    points = `${pad},${y} ${pad + w},${y}`;
  }
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={`text-accent-600 ${className ?? ""}`}
      {...rest}
    >
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth={2} />
    </svg>
  );
}
