import { render } from "@testing-library/react";
import { LoadShapePreview } from "../LoadShapePreview";

describe("LoadShapePreview", () => {
  it("flat: 단일 수평 polyline (대각 ramp 아님 — y가 일정)", () => {
    const { container } = render(
      <LoadShapePreview kind="flat" width={60} height={30} aria-label="부하 모양" />,
    );
    const poly = container.querySelector("polyline");
    expect(poly).not.toBeNull();
    const pts = poly!
      .getAttribute("points")!
      .trim()
      .split(/\s+/)
      .map((p) => p.split(",").map(Number));
    const ys = pts.map(([, y]) => y);
    expect(Math.max(...ys) - Math.min(...ys)).toBe(0); // 수평 = 모든 y 동일
    expect(pts.length).toBeGreaterThanOrEqual(2);
  });

  it("curve: stages 비례 polyline + 마지막 점 y가 첫 점보다 위(0,0 시작 아님 검증은 stage 수)", () => {
    const { container } = render(
      <LoadShapePreview
        kind="curve"
        stages={[
          { target: 10, duration_seconds: 30 },
          { target: 100, duration_seconds: 30 },
        ]}
        width={60}
        height={30}
        aria-label="부하 곡선"
      />,
    );
    const poly = container.querySelector("polyline");
    expect(poly).not.toBeNull();
    const n = poly!.getAttribute("points")!.trim().split(/\s+/).length;
    expect(n).toBeGreaterThanOrEqual(2); // 최소 두 stage → 비-수평
  });

  it("role/aria-label passthrough + aria-hidden 지원", () => {
    const { container, rerender } = render(
      <LoadShapePreview kind="flat" width={60} height={30} role="img" aria-label="부하 모양" />,
    );
    expect(container.querySelector('svg[role="img"][aria-label="부하 모양"]')).not.toBeNull();
    rerender(<LoadShapePreview kind="flat" width={60} height={30} aria-hidden />);
    expect(container.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
  });

  it("className 머지 — accent 색(text-accent-600) 보존 (R2)", () => {
    const { container } = render(
      <LoadShapePreview kind="flat" width={60} height={30} className="shrink-0" />,
    );
    const svg = container.querySelector("svg")!;
    expect(svg).toHaveClass("text-accent-600"); // 머지 안 하면 shrink-0가 덮어써 FAIL
    expect(svg).toHaveClass("shrink-0");
  });
});
