import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { OverlayLatencyChart } from "../components/OverlayLatencyChart";
import { buildOverlay } from "../overlay";
import { buildOverlayLatency } from "../overlayLatency";
import { L, run, secs } from "./latencyRuns";

describe("OverlayLatencyChart", () => {
  it("두 쪽 모두 값이 있으면 선 2개(이전만 점선) · 제목 · 범례 2개 · 캡션", () => {
    const b = run("b", secs(10, 5), [L(0, 1, 5_000), L(1, 1, 7_000)]);
    const a = run("a", secs(10, 5), [L(0, 1, 3_000), L(1, 1, 4_000)]);
    const { container } = render(
      <OverlayLatencyChart model={buildOverlayLatency(b, a, buildOverlay(b, a, false))!} />,
    );
    const lines = container.querySelectorAll("path[data-ovlat-line]");
    expect(lines).toHaveLength(2);
    expect(
      container.querySelector('path[data-ovlat-line="before"]')?.getAttribute("stroke-dasharray"),
    ).toBe("1.5 1");
    expect(
      container.querySelector('path[data-ovlat-line="after"]')?.hasAttribute("stroke-dasharray"),
    ).toBe(false);
    // 세로 기하 고정: yTicks = niceTicks(7, 5) = [0,2,4,6,8] → yMax 8, durationSec 10.
    // x = 12 + (0.5/10)·156 = 19.8, 12 + (1.5/10)·156 = 35.4 · y = 47 − (5/8)·39 = 22.625 → 22.63, 47 − (7/8)·39 = 12.875 → 12.88
    expect(container.querySelector('path[data-ovlat-line="before"]')?.getAttribute("d")).toBe(
      "M19.8,22.63 L35.4,12.88",
    );
    const svg = container.querySelector("svg.p-cmp-ovlat")!;
    expect(svg.getAttribute("viewBox")).toBe("0 0 180 55");
    expect(svg.getAttribute("aria-label")).toBe(
      "이전·이후 평균 응답 시간을 시간 순서로 겹쳐 그린 그래프",
    );
    expect(container.textContent).toContain("평균 응답 시간 (ms)");
    expect(container.textContent).toContain("이전 평균 응답 시간");
    expect(container.textContent).toContain("이후 평균 응답 시간");
    expect(container.textContent).toContain(
      "모든 단계의 요청을 합친 값입니다. 한 칸 = 1초, 그 칸 안 요청 전체의 평균입니다.",
    );
    expect(container.textContent).not.toContain("60초를 넘긴 응답이 있어");
    expect(container.innerHTML).not.toContain("NaN");
    // 60초 칸이 있으면 캡션에 안내
    const c = run("c", secs(10, 5), [L(0, 2, 60_000_000, true)]);
    const capped = render(
      <OverlayLatencyChart model={buildOverlayLatency(c, a, buildOverlay(c, a, false))!} />,
    );
    expect(capped.container.textContent).toContain(
      "60초를 넘긴 응답이 있어 그 구간의 값은 실제보다 작게 그려졌습니다.",
    );
  });

  it("한쪽에 값이 없으면 그 쪽 선·범례 이름이 없고 글이 붙는다", () => {
    const b = run("b", secs(10, 5), []);
    const a = run("a", secs(10, 5), [L(0, 1, 3_000)]);
    const { container } = render(
      <OverlayLatencyChart model={buildOverlayLatency(b, a, buildOverlay(b, a, false))!} />,
    );
    expect(container.querySelectorAll("path[data-ovlat-line]")).toHaveLength(1);
    expect(container.querySelector('path[data-ovlat-line="before"]')).toBeNull();
    expect(container.textContent).not.toContain("이전 평균 응답 시간");
    expect(container.textContent).toContain("이전 측정에는 응답 시간 값이 없습니다.");
  });

  it("홀로 남은 묶음은 묶음 폭만큼의 가로 선분", () => {
    const b = run("b", secs(10, 5), [L(0, 1, 5_000)]);
    const a = run("a", secs(10, 5), [L(0, 1, 3_000), L(1, 1, 4_000)]);
    const { container } = render(
      <OverlayLatencyChart model={buildOverlayLatency(b, a, buildOverlay(b, a, false))!} />,
    );
    expect(container.querySelector('path[data-ovlat-line="before"]')?.getAttribute("d")).toBe(
      "M12,14.5 L27.6,14.5",
    );
    expect(container.querySelector('path[data-ovlat-line="after"]')?.getAttribute("d")).toBe(
      "M19.8,27.5 L35.4,21",
    );
  });

  it("통과 표본이 없던 묶음에서 선이 끊기고, 초가 없던 묶음은 건너뛴다", () => {
    const b = run("b", secs(10, 5), [L(0, 1, 5_000), L(1, 1, 7_000), L(2, 0), L(3, 1, 5_000)]);
    const a = run("a", secs(10, 5), [L(0, 1, 3_000)]);
    const { container } = render(
      <OverlayLatencyChart model={buildOverlayLatency(b, a, buildOverlay(b, a, false))!} />,
    );
    expect(container.querySelector('path[data-ovlat-line="before"]')?.getAttribute("d")).toBe(
      "M19.8,22.63 L35.4,12.88 M58.8,22.63 L74.4,22.63",
    );
    expect(container.querySelector('path[data-ovlat-line="after"]')?.getAttribute("d")).toBe(
      "M12,32.38 L27.6,32.38",
    );
  });

  it("초가 없던 묶음을 건너뛰고 이웃한 두 묶음을 이어 긋는다", () => {
    const b = run("b", secs(10, 5), [L(0, 1, 5_000), L(2, 1, 7_000)]);
    const a = run("a", secs(10, 5), [L(0, 1, 3_000)]);
    const { container } = render(
      <OverlayLatencyChart model={buildOverlayLatency(b, a, buildOverlay(b, a, false))!} />,
    );
    // yTicks = niceTicks(7, 5) = [0,2,4,6,8] → yMax 8 · x = 12 + (0.5/10)·156 = 19.8, 12 + (2.5/10)·156 = 51
    expect(container.querySelector('path[data-ovlat-line="before"]')?.getAttribute("d")).toBe(
      "M19.8,22.63 L51,12.88",
    );
  });

  it("묶음이 하나뿐이면 그림 폭 전체의 가로 선분", () => {
    const b = run("b", secs(1, 5), [L(0, 1, 5_000)]);
    const a = run("a", secs(1, 5), [L(0, 1, 3_000)]);
    const { container } = render(
      <OverlayLatencyChart model={buildOverlayLatency(b, a, buildOverlay(b, a, false))!} />,
    );
    expect(container.querySelectorAll("path[data-ovlat-line]")).toHaveLength(2);
    expect(container.querySelector('path[data-ovlat-line="before"]')?.getAttribute("d")).toBe(
      "M12,14.5 L168,14.5",
    );
    expect(container.querySelector('path[data-ovlat-line="after"]')?.getAttribute("d")).toBe(
      "M12,27.5 L168,27.5",
    );
    expect(container.innerHTML).not.toContain("NaN");
    expect(container.innerHTML).not.toContain("Infinity");
  });
});
