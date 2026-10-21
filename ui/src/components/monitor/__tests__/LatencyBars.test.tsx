import { describe, it, expect, vi } from "vitest";
import { render, screen, within, act } from "@testing-library/react";
import { LatencyBars } from "../LatencyBars";
import type { CheckResult, Threshold } from "../../../api/monitors";
import { ko } from "../../../i18n/ko";

const TH: Threshold[] = [
  { ms: 700, color: "#facc15" },
  { ms: 1200, color: "#fb923c" },
];
const GREEN = "rgb(34, 197, 94)";
const YELLOW = "rgb(250, 204, 21)";
const ORANGE = "rgb(251, 146, 60)";

function ok(latency: number, at = 1): CheckResult {
  return { at_ms: at, verdict: "ok", latency_ms: latency, reason: null };
}

function renderBars(
  results: CheckResult[],
  over: Partial<{ barCount: number; graphMaxMs: number; thresholds: Threshold[] }> = {},
) {
  return render(
    <LatencyBars
      results={results}
      barCount={over.barCount ?? 10}
      graphMaxMs={over.graphMaxMs ?? 2000}
      thresholds={over.thresholds ?? TH}
      intervalSec={10}
    />,
  );
}

const slots = () => screen.getAllByTestId("bar-slot");

describe("LatencyBars", () => {
  it("slot_count_equals_bar_count_left_filled", () => {
    renderBars([ok(100), ok(200), ok(300)], { barCount: 10 });
    const s = slots();
    expect(s).toHaveLength(10);
    s.slice(0, 3).forEach((el) => expect(el).not.toHaveAttribute("data-empty"));
    s.slice(3).forEach((el) => expect(el).toHaveAttribute("data-empty"));
    // oldest on the left, newest right after it
    expect(s[0].style.height).toBe("5%");
    expect(s[2].style.height).toBe("15%");
  });

  it("slot_count_capped_and_oldest_evicted_when_over", () => {
    const results = Array.from({ length: 12 }, (_, i) => ok((i + 1) * 100, i));
    renderBars(results, { barCount: 10 });
    const s = slots();
    expect(s).toHaveLength(10);
    expect(s[0].style.height).toBe("15%"); // 3rd result (300 ms) is now leftmost
    expect(s[9].style.height).toBe("60%"); // newest (1200 ms) at the right end
  });

  it("threshold_labels_outside_bars_area", () => {
    renderBars([ok(100)]);
    const bars = screen.getByTestId("bars-area");
    const labels = screen.getByTestId("threshold-labels");
    expect(bars.contains(labels)).toBe(false);
    expect(labels.contains(bars)).toBe(false);
    const big = within(labels).getByText("1,200");
    expect(big.textContent).toBe("1,200");
    expect(bars.contains(big)).toBe(false);
    expect(within(labels).getByText("700")).toBeInTheDocument();
    expect(within(bars).queryByText("1,200")).toBeNull();
    expect(within(bars).queryByText("700")).toBeNull();
    expect(screen.queryByText(/1,200\s*ms/)).toBeNull();
    expect(screen.getAllByText(ko.monitor.axisUnit)).toHaveLength(1);
  });

  it("threshold_lines_drawn_inside_bars_area", () => {
    renderBars([ok(100)]);
    const lines = within(screen.getByTestId("bars-area")).getAllByTestId("threshold-line");
    expect(lines).toHaveLength(2);
    expect(lines[0].style.bottom).toBe("35%");
    expect(lines[1].style.bottom).toBe("60%");
  });

  it("bar_color_from_current_thresholds", () => {
    renderBars([ok(500), ok(700), ok(800), ok(1300)]);
    const s = slots();
    expect(s[0].style.backgroundColor).toBe(GREEN);
    expect(s[1].style.backgroundColor).toBe(YELLOW);
    expect(s[2].style.backgroundColor).toBe(YELLOW);
    expect(s[3].style.backgroundColor).toBe(ORANGE);
  });

  it("bar_color_follows_current_thresholds_not_history", () => {
    // same results, thresholds changed -> colors recomputed
    renderBars([ok(800)], { thresholds: [{ ms: 500, color: "#fb923c" }] });
    expect(slots()[0].style.backgroundColor).toBe(ORANGE);
  });

  it("fail_bar_full_height", () => {
    renderBars([ok(100), { at_ms: 2, verdict: "fail", latency_ms: null, reason: "HTTP 503" }]);
    const fail = slots()[1];
    expect(fail).toHaveAttribute("data-verdict", "fail");
    expect(fail.style.height).toBe("100%");
    expect(fail.textContent).toContain("✖");
  });

  it("config_error_bar_gray_full", () => {
    renderBars([{ at_ms: 2, verdict: "config_error", latency_ms: null, reason: "시나리오 오류" }]);
    const bar = slots()[0];
    expect(bar).toHaveAttribute("data-verdict", "config_error");
    expect(bar.style.height).toBe("100%");
    expect(bar.textContent).not.toContain("✖");
    expect(bar.style.backgroundColor).toBe("rgb(51, 65, 85)");
  });

  it("overflow_clamped_to_100", () => {
    renderBars([ok(5000), ok(1000)], { graphMaxMs: 2000 });
    expect(slots()[0].style.height).toBe("100%");
    expect(slots()[1].style.height).toBe("50%");
  });

  it("close_threshold_labels_pushed_apart_when_measured", () => {
    type Entry = { target: Element; contentRect: { height: number } };
    const observers: { cb: (e: Entry[]) => void; els: Element[] }[] = [];
    class MockRO {
      els: Element[] = [];
      constructor(cb: (e: Entry[]) => void) {
        observers.push({ cb, els: this.els });
      }
      observe(el: Element) {
        this.els.push(el);
      }
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", MockRO);
    const rect = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue({ height: 20 } as DOMRect);
    try {
      renderBars([ok(100)], {
        thresholds: [
          { ms: 700, color: "#facc15" },
          { ms: 800, color: "#fb923c" },
        ],
      });
      const offsets = () =>
        screen.getAllByTestId("threshold-label-offset").map((el) => el.style.height);
      // unmeasured: plain percentages
      expect(offsets()).toEqual(["35%", "40%"]);
      act(() => {
        for (const o of observers) {
          o.cb(o.els.map((el) => ({ target: el, contentRect: { height: 100 } })));
        }
      });
      // 35px / 40px would overlap 20px-tall labels -> second pushed to 35 + 20
      expect(offsets()).toEqual(["35px", "55px"]);
    } finally {
      rect.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("axis_labels", () => {
    renderBars([], { barCount: 60 });
    expect(screen.getByText(ko.monitor.axisAgo("10분"))).toBeInTheDocument();
    expect(screen.getByText(ko.monitor.axisNow)).toBeInTheDocument();
  });
});
