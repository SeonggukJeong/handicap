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
  return { at_ms: at, verdict: "ok", latency_ms: latency, reason: null, detail: null };
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
    // the dashed stroke is centred on its height (labels are centred there too)
    expect(lines[0].style.transform).toBe("translateY(50%)");
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
    renderBars([
      ok(100),
      { at_ms: 2, verdict: "fail", latency_ms: null, reason: "HTTP 503", detail: null },
    ]);
    const fail = slots()[1];
    expect(fail).toHaveAttribute("data-verdict", "fail");
    expect(fail.style.height).toBe("100%");
    expect(fail.textContent).toContain("✖");
  });

  it("config_error_bar_gray_full", () => {
    renderBars([
      {
        at_ms: 2,
        verdict: "config_error",
        latency_ms: null,
        reason: "시나리오 오류",
        detail: null,
      },
    ]);
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

  /** Render, then deliver one measurement: bars area `areaH`, labels 20px tall. */
  function renderMeasured(ms: number[], areaH: number) {
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
      renderBars([ok(100)], { thresholds: ms.map((v) => ({ ms: v, color: "#fb923c" })) });
      act(() => {
        for (const o of observers) {
          o.cb(o.els.map((el) => ({ target: el, contentRect: { height: areaH } })));
        }
      });
    } finally {
      rect.mockRestore();
      vi.unstubAllGlobals();
    }
  }
  /** [number text, centre offset] for every label actually rendered. */
  const shownLabels = () =>
    within(screen.getByTestId("threshold-labels"))
      .queryAllByTestId("threshold-label")
      .map((el) => [
        el.querySelector("span")?.textContent,
        el.querySelector<HTMLElement>('[data-testid="threshold-label-offset"]')?.style.height,
      ]);

  it("labels_unmeasured_render_all_at_line_percent", () => {
    renderBars([ok(100)], {
      thresholds: [
        { ms: 700, color: "#facc15" },
        { ms: 800, color: "#fb923c" },
      ],
    });
    expect(shownLabels()).toEqual([
      ["700", "35%"],
      ["800", "40%"],
    ]);
  });

  it("labels_apart_keep_their_line_height", () => {
    renderMeasured([700, 1200], 100);
    expect(shownLabels()).toEqual([
      ["700", "35px"],
      ["1,200", "60px"],
    ]);
    expect(screen.getAllByText(ko.monitor.axisUnit)).toHaveLength(1);
  });

  it("overlapping_labels_drop_lower_keep_higher_lines_stay", () => {
    renderMeasured([700, 800], 100);
    // 35px vs 40px with 20px-tall numbers would overlap -> the lower is dropped
    expect(shownLabels()).toEqual([["800", "40px"]]);
    expect(screen.getAllByTestId("threshold-line")).toHaveLength(2);
  });

  it("crowded_labels_keep_non_overlapping_highest_first", () => {
    renderMeasured([1000, 1600, 1700, 1800, 1900, 2000], 100);
    // 2,000 clamped to 100 - 20/2 = 90; 1,900..1,600 (95..80) collide with it;
    // 1,000 at 50 is clear of 90 by >= 20 -> kept
    expect(shownLabels()).toEqual([
      ["1,000", "50px"],
      ["2,000", "90px"],
    ]);
    expect(screen.getAllByTestId("threshold-line")).toHaveLength(6);
  });

  it("label_kept_clear_of_unit_row", () => {
    // 100 ms of 2000 -> line at 5px; the number's lower half would reach the
    // (ms) row below the column, so its centre is held at 20/2
    renderMeasured([100], 100);
    expect(shownLabels()).toEqual([["100", "10px"]]);
  });

  it("no_label_fits_tiny_column_hides_numbers_and_unit", () => {
    renderMeasured([700, 1200], 15);
    expect(shownLabels()).toEqual([]);
    expect(screen.queryByText(ko.monitor.axisUnit)).toBeNull();
    expect(screen.getAllByTestId("threshold-line")).toHaveLength(2);
  });

  it("label_column_baseline_matches_bars_area_border", () => {
    renderBars([ok(100)]);
    // the lines' bottom:% is measured inside the bars area's bottom border; the
    // label column carries the same (transparent) border so both share a baseline
    const area = screen.getByTestId("bars-area");
    const labels = screen.getByTestId("threshold-labels");
    // (jsdom drops `cqw` widths, so the shared width constant is verified live by
    // measuring label centre vs line centre in Chromium — see task-9 report.)
    expect(area.style.borderBottomStyle).toBe("solid");
    expect(labels.style.borderBottomStyle).toBe("solid");
    expect(labels.style.borderBottomColor).toBe("transparent");
  });

  it("fail_glyph_clipped_to_bars_area", () => {
    renderBars([{ at_ms: 2, verdict: "fail", latency_ms: null, reason: "HTTP 503", detail: null }]);
    // the slots container clips: a ✖ never draws over the axis text below
    const container = slots()[0].parentElement as HTMLElement;
    expect(container.style.overflow).toBe("hidden");
  });

  it("graph_text_is_not_shrunk_by_the_board_scale", () => {
    // the board-wide --fit shrinks panel text only; axis and threshold numbers
    // keep their configured size so they stay legible on crowded boards
    renderBars([ok(100)]);
    const root = screen.getByTestId("bars-area").parentElement as HTMLElement;
    expect(root.style.getPropertyValue("--fit")).toBe("1");
  });

  it("axis_labels", () => {
    renderBars([], { barCount: 60 });
    expect(screen.getByText(ko.monitor.axisAgo("10분"))).toBeInTheDocument();
    expect(screen.getByText(ko.monitor.axisNow)).toBeInTheDocument();
  });
});
