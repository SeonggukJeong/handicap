import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StageCurvePreview, toControlPoints } from "../StageCurvePreview";

describe("toControlPoints", () => {
  it("builds cumulative (t, rate) points starting at (0,0)", () => {
    expect(
      toControlPoints([
        { target: 200, duration_seconds: 30 },
        { target: 0, duration_seconds: 30 },
      ]),
    ).toEqual([
      { t: 0, rate: 0 },
      { t: 30, rate: 200 },
      { t: 60, rate: 0 },
    ]);
  });
  it("returns just the origin for empty stages", () => {
    expect(toControlPoints([])).toEqual([{ t: 0, rate: 0 }]);
  });
});

describe("StageCurvePreview", () => {
  it("renders an SVG line chart with explicit size", () => {
    const { container } = render(
      <StageCurvePreview
        stages={[
          { target: 200, duration_seconds: 30 },
          { target: 0, duration_seconds: 30 },
        ]}
        width={300}
        height={120}
      />,
    );
    expect(container.querySelector("svg")).toBeInTheDocument();
  });
});
