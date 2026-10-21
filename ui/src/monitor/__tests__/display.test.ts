import { describe, it, expect } from "vitest";
import {
  boxContentHeight,
  freeBelowText,
  graphFits,
  panelFont,
  requiredFit,
  splitReason,
} from "../display";

describe("display sizing", () => {
  it("panel_font_scales_and_honours_fit_variable", () => {
    expect(panelFont(10, 1)).toBe("calc(min(10cqw, 16cqh) * var(--fit, 1))");
    expect(panelFont(10, 1.2)).toBe("calc(min(12cqw, 19.2cqh) * var(--fit, 1))");
  });

  it("box_content_height_subtracts_border_and_padding", () => {
    // 2 x 1cqw border + 2.4cqw top + 2cqw bottom padding = 6.4cqw
    expect(boxContentHeight(300, 300)).toBeCloseTo(280.8);
  });

  it("free_below_text_is_panel_height_minus_top_chrome_and_text", () => {
    // 300x300: top border 1cqw + top padding 2.4cqw = 10.2px
    expect(freeBelowText(300, 300, 150)).toBeCloseTo(139.8);
  });

  it("graph_fits_while_free_space_is_at_least_15_percent", () => {
    // 15% of 300 = 45: the axis and margins live inside that space
    expect(graphFits({ w: 300, h: 300, textH: 244 })).toBe(true); // 45.8
    expect(graphFits({ w: 300, h: 300, textH: 245 })).toBe(false); // 44.8
  });

  it("required_fit_targets_text_plus_30_percent_graph", () => {
    // fits with >= 30% (90px) free -> nothing required
    expect(requiredFit({ w: 300, h: 300, textH: 150, fit: 1, widthNeed: Infinity })).toBe(Infinity);
    // text may take 300 - 10.2 - 90 = 199.8px: at fit 1 a 260px block needs 199.8/260 (x0.98)
    expect(requiredFit({ w: 300, h: 300, textH: 260, fit: 1, widthNeed: Infinity })).toBeCloseTo(
      0.7531,
      3,
    );
    // relative to the fit it was measured at
    expect(requiredFit({ w: 300, h: 300, textH: 260, fit: 0.5, widthNeed: Infinity })).toBeCloseTo(
      0.3766,
      3,
    );
    // a one-line value that is too wide can require more
    expect(requiredFit({ w: 300, h: 300, textH: 150, fit: 1, widthNeed: 0.6 })).toBe(0.6);
  });

  it("split_reason_at_first_separator", () => {
    expect(splitReason("HTTP 503 · 회원 인증 · 2단계")).toEqual({
      fixed: "HTTP 503",
      step: "회원 인증 · 2단계",
    });
    expect(splitReason("시간 초과(5초)")).toEqual({ fixed: "시간 초과(5초)", step: null });
  });
});
