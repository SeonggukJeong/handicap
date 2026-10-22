import { describe, it, expect } from "vitest";
import {
  barsAreaHeight,
  cardNeed,
  boxContentHeight,
  contrastText,
  fillBackground,
  FILL,
  GRAPH_CHROME,
  freeBelowText,
  graphFits,
  MIN_FIT,
  nextSearch,
  panelFont,
  reasonParts,
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
    // a narrow panel (100x300, chrome is small): the 15% rule decides
    // 15% of 300 = 45; free = 300 - 3.4 - textH
    expect(graphFits({ w: 100, h: 300, textH: 251, fontScale: 1 })).toBe(true); // 45.6
    expect(graphFits({ w: 100, h: 300, textH: 252, fontScale: 1 })).toBe(false); // 44.6
  });

  it("graph_hidden_when_bars_area_under_8_percent", () => {
    // 300x300: bars = free - bottom pad/border (9) - graph margins (6)
    //   - axis line (11.1px x 1.3 = 14.43) = free - 29.43; 8% of 300 = 24
    // textH 240: free 49.8 passes 15% (45) but bars 20.4 < 24 -> hidden
    expect(graphFits({ w: 300, h: 300, textH: 236, fontScale: 1 })).toBe(true); // bars 24.37
    expect(graphFits({ w: 300, h: 300, textH: 237, fontScale: 1 })).toBe(false); // bars 23.37
    expect(graphFits({ w: 300, h: 300, textH: 240, fontScale: 1 })).toBe(false);
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

  it("scale_search_finds_largest_fitting_scale", () => {
    // feasibility is non-linear in practice (wrapping); here: fits iff s <= 0.93
    const fits = (s: number) => s <= 0.93;
    let st = nextSearch({ lo: MIN_FIT, hi: 1, cand: 1, done: false }, fits(1));
    let rounds = 0;
    while (!st.done && rounds < 20) {
      st = nextSearch(st, fits(st.cand));
      rounds += 1;
    }
    expect(st.done).toBe(true);
    expect(st.lo).toBeGreaterThan(0.92);
    expect(st.lo).toBeLessThanOrEqual(0.93);
    expect(rounds).toBeLessThan(10);
  });

  it("scale_search_stops_at_1_when_settings_fit", () => {
    expect(nextSearch({ lo: MIN_FIT, hi: 1, cand: 1, done: false }, true)).toEqual({
      lo: 1,
      hi: 1,
      cand: 1,
      done: true,
    });
  });

  it("split_reason_at_first_separator", () => {
    expect(splitReason("HTTP 503 · 회원 인증 · 2단계")).toEqual({
      fixed: "HTTP 503",
      step: "회원 인증 · 2단계",
    });
    expect(splitReason("시간 초과(5초)")).toEqual({ fixed: "시간 초과(5초)", step: null });
  });
});

describe("reasonParts", () => {
  it("reason_parts_without_detail_splits_as_before", () => {
    expect(reasonParts("HTTP 503 · 인증", null)).toEqual({
      kind: "split",
      fixed: "HTTP 503",
      step: "인증",
    });
  });
  it("reason_parts_detail_never_splits", () => {
    expect(reasonParts("a · b", "x · 같음 y")).toEqual({
      kind: "detail",
      big: "a · b",
      small: "x · 같음 y",
    });
  });
  it("reason_parts_not_contained_three_conditions", () => {
    expect(reasonParts('"OK" 포함 안 됨', "본문 전체 · 포함 OK")).toEqual({
      kind: "not_contained",
      needle: "OK",
      small: "본문 전체 · 포함 OK",
    });
    expect(reasonParts("비어 있음", "본문 전체 · 비어 있지 않음").kind).toBe("detail");
    expect(reasonParts("응답 본문이 너무 큼", "본문 전체 · 포함 OK").kind).toBe("detail");
    expect(reasonParts('"OK" 포함 안 됨', "본문 · 포함 OK").kind).toBe("detail");
    expect(reasonParts('"OK', "본문 전체 · 포함 OK").kind).toBe("detail");
  });
});

describe("A (fill) display helpers", () => {
  it("contrast_text_picks_readable", () => {
    expect(contrastText("#facc15")).toBe("#0b0f14");
    expect(contrastText("#f59e0b")).toBe("#0b0f14");
    expect(contrastText("#15803d")).toBe("#ffffff");
    expect(contrastText("#b91c1c")).toBe("#ffffff");
    expect(contrastText("#475569")).toBe("#ffffff");
  });

  it("fill_background_by_state", () => {
    const th = [
      { ms: 1000, color: "#facc15" },
      { ms: 3000, color: "#ef4444" },
    ];
    expect(fillBackground("ok", 400, th)).toBe(FILL.ok);
    expect(fillBackground("slow", 1500, th)).toBe("#facc15");
    expect(fillBackground("fail", null, th)).toBe(FILL.fail);
    expect(fillBackground("config_error", null, th)).toBe(FILL.gray);
    expect(fillBackground("stale", null, th)).toBe(FILL.gray);
    expect(fillBackground("stale_off", null, th)).toBe(FILL.gray);
    expect(fillBackground("pending", null, th)).toBeNull();
  });

  it("bars_area_height_subtracts_inset_only_when_inset", () => {
    const w = 400;
    const base = barsAreaHeight(w, 300, 80, 1);
    expect(barsAreaHeight(w, 300, 80, 1, false)).toBe(base);
    const inset = barsAreaHeight(w, 300, 80, 1, true);
    expect(base - inset).toBeCloseTo(2 * GRAPH_CHROME.insetPad * (w / 100), 9);
  });
});

describe("cardNeed", () => {
  it("card_need_cases", () => {
    // everything fits
    expect(cardNeed({ fit: 1, contentH: 100, textH: 80, lineClientW: 300, lineScrollW: 300 })).toBe(
      Infinity,
    );
    // jsdom-like unmeasured widths (0) count as fitting
    expect(cardNeed({ fit: 1, contentH: 100, textH: 80, lineClientW: 0, lineScrollW: 0 })).toBe(
      Infinity,
    );
    // twice too tall -> about half (x0.98) of the measured fit
    expect(
      cardNeed({ fit: 0.8, contentH: 100, textH: 200, lineClientW: 300, lineScrollW: 300 }),
    ).toBeCloseTo(0.8 * 0.5 * 0.98, 6);
    // status line wider than the card
    expect(
      cardNeed({ fit: 1, contentH: 100, textH: 80, lineClientW: 300, lineScrollW: 400 }),
    ).toBeCloseTo(0.75 * 0.98, 6);
    // both: the smaller wins
    expect(
      cardNeed({ fit: 1, contentH: 100, textH: 200, lineClientW: 300, lineScrollW: 400 }),
    ).toBeCloseTo(0.5 * 0.98, 6);
    // no content room at all
    expect(cardNeed({ fit: 1, contentH: 0, textH: 50, lineClientW: 300, lineScrollW: 300 })).toBe(
      0,
    );
  });
});
