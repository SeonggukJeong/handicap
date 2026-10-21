import { describe, it, expect } from "vitest";
import { barsSpace, boxContentHeight, graphFits, panelFont, splitReason } from "../display";

describe("display sizing", () => {
  it("panel_font_scales_and_honours_fit_variable", () => {
    expect(panelFont(10, 1)).toBe("calc(min(10cqw, 16cqh) * var(--fit, 1))");
    expect(panelFont(10, 1.2)).toBe("calc(min(12cqw, 19.2cqh) * var(--fit, 1))");
  });

  it("box_content_height_subtracts_border_and_padding", () => {
    // 2 x 1cqw border + 2.4cqw top + 2cqw bottom padding = 6.4cqw
    expect(boxContentHeight(300, 300)).toBeCloseTo(280.8);
  });

  it("bars_space_subtracts_text_and_axis_chrome", () => {
    // 300x300: content 280.8; chrome = 2cqw (6) + axis 11.1px x 1.3 = 20.43
    expect(barsSpace({ w: 300, h: 300, textH: 150, fontScale: 1, fit: 1 })).toBeCloseTo(110.37);
  });

  it("graph_fits_needs_15_percent_of_panel_height_for_the_bars", () => {
    const base = { w: 300, h: 300, fontScale: 1, fit: 1 };
    expect(graphFits({ ...base, textH: 215 })).toBe(true); // 45.37 >= 45
    expect(graphFits({ ...base, textH: 216 })).toBe(false); // 44.37 < 45
  });

  it("split_reason_at_first_separator", () => {
    expect(splitReason("HTTP 503 · 회원 인증 · 2단계")).toEqual({
      fixed: "HTTP 503",
      step: "회원 인증 · 2단계",
    });
    expect(splitReason("시간 초과(5초)")).toEqual({ fixed: "시간 초과(5초)", step: null });
  });
});
