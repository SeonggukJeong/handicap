import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { StairConfig, StairLive } from "../../../api/schemas";
import { ko } from "../../../i18n/ko";
import { StairLivePanel } from "../StairLivePanel";

function stairOf(n: number, withAuto: boolean): StairConfig {
  return {
    targets: Array.from({ length: n }, (_, i) => (i + 1) * 100),
    hold_seconds: 10,
    ramp_seconds: 1,
    discard_seconds: 1,
    ...(withAuto
      ? {
          auto_stop: {
            saturation: "two_fails" as const,
            emergency: {
              error_rate_pct: 5,
              p99_ms: 2000,
              consecutive_seconds: 3,
              min_requests: 20,
            },
          },
        }
      : {}),
  };
}

function live(over: Partial<StairLive> = {}): StairLive {
  const base: StairLive = {
    current_step: null,
    phase: null,
    step_states: [],
    step_reasons: [],
    last_ok_step: null,
    next_fail_stops: false,
    emergency_now: null,
    suspended_seconds: 0,
    frozen: false,
    stop: null,
    ...over,
  };
  if (over.step_reasons === undefined) {
    base.step_reasons = base.step_states.map(() => ({
      reasons: [],
      slot_limited: false,
      ref_fast: false,
    }));
  }
  return base;
}

describe("StairLivePanel", () => {
  it("renders_head_chips_forecast", () => {
    const states: StairLive["step_states"] = [
      "ok",
      "ok",
      "ok",
      "ok",
      "unconfirmed",
      "measuring",
      "pending",
      "pending",
      "pending",
      "pending",
    ];
    render(
      <StairLivePanel
        live={live({
          current_step: 5,
          phase: "measure",
          step_states: states,
          next_fail_stops: true,
        })}
        stair={stairOf(10, true)}
      />,
    );
    expect(
      screen.getByText(
        "계단 6/10 (600 iter/s) 측정 중 · 1–4 정상 · 5 실패(다음 계단 확인 중) → 6계단이 실패하면 자동 정지",
      ),
    ).toBeInTheDocument();
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(10);
    expect(items[4]).toHaveAttribute("aria-label", "5계단 실패(다음 계단 확인 중)");
  });

  it("chip_labels_carry_reasons", () => {
    const empty = { reasons: [], slot_limited: false, ref_fast: false };
    const R = (kind: "errors" | "p99_relative", value: number) => ({
      ...empty,
      reasons: [{ kind, value }],
    });
    render(
      <StairLivePanel
        live={live({
          current_step: 5,
          phase: "measure",
          step_states: ["ok", "spike", "ok", "saturated", "after", "measuring"],
          step_reasons: [
            empty,
            R("errors", 0.046),
            empty,
            R("p99_relative", 3.94),
            R("p99_relative", 3.14),
            empty,
          ],
        })}
        stair={stairOf(6, true)}
      />,
    );
    const expected = [
      "1계단 정상",
      "2계단 튄 계단(오류 4.6%)",
      "3계단 정상",
      "4계단 포화(p99 3.9×)",
      "5계단 포화 이후(p99 3.1×)",
      "6계단 측정 중",
    ];
    for (const label of expected) {
      const chip = screen.getByRole("listitem", { name: label });
      expect(chip).toHaveAttribute("title", label);
      expect(chip).toHaveAttribute("aria-label", label);
    }
  });

  it("summary_line_wraps", () => {
    const empty = { reasons: [], slot_limited: false, ref_fast: false };
    render(
      <StairLivePanel
        live={live({
          current_step: 1,
          phase: "measure",
          step_states: ["saturated", "measuring"],
          step_reasons: [
            {
              ...empty,
              reasons: [
                { kind: "achieved", value: 0.5 },
                { kind: "dropped", value: 1e9 },
                { kind: "errors", value: 0.046 },
                { kind: "p99_relative", value: 12345.6 },
              ],
            },
            empty,
          ],
        })}
        stair={stairOf(2, true)}
      />,
    );
    const p = screen.getByText(
      /1 포화\(달성 50\.0%, dropped 1,000,000,000, 오류 4\.6%, p99 12345\.6×\)/,
    );
    expect(p.tagName).toBe("P");
    expect(p).toHaveClass("break-words");
  });

  it("auto_stop_off_shows_chips_only", () => {
    const { container } = render(
      <StairLivePanel
        live={live({
          current_step: 0,
          phase: "measure",
          step_states: ["measuring", "pending", "pending"],
        })}
        stair={stairOf(3, false)}
      />,
    );
    expect(screen.queryByText(/즉시 정지 감시/)).toBeNull();
    expect(screen.queryByText(/→/)).toBeNull();
    expect(container.querySelector('[data-tone="auto-stop"]')).toBeNull();
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });

  it("stop_line_first_and_no_running_phrase", () => {
    const { container } = render(
      <StairLivePanel
        live={live({
          current_step: 3,
          phase: "measure",
          step_states: ["ok", "ok", "saturated", "saturated", "partial"],
          last_ok_step: 1,
          stop: {
            kind: "saturation",
            mode: "two_fails",
            failed_steps: [2, 3],
            decided_step: 3,
            judged_through: 3,
            phase: null,
            decided_at_ms: 1_700_000_000_000,
            stopped_at_ms: 1_700_000_003_000,
            emergency: null,
            slot_limited: false,
          },
        })}
        stair={stairOf(5, true)}
      />,
    );
    const stopEl = container.querySelector('[data-tone="auto-stop"]');
    const ol = container.querySelector("ol");
    expect(stopEl).not.toBeNull();
    expect(stopEl!.compareDocumentPosition(ol!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(stopEl).toHaveTextContent("4계단(400 iter/s) 판정 뒤 자동 정지");
    expect(stopEl).toHaveTextContent("3·4계단 연속 실패");
    expect(screen.queryByText(/측정 중/)).toBeNull();
    expect(screen.queryByText(/즉시 정지 감시/)).toBeNull();
  });

  it("frozen_line", () => {
    render(
      <StairLivePanel
        live={live({
          frozen: true,
          current_step: 1,
          phase: "measure",
          step_states: ["ok", "frozen", "frozen"],
        })}
        stair={stairOf(3, true)}
      />,
    );
    expect(screen.getByText("판정 중단 — 부하기 데이터 소진")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")[1].getAttribute("aria-label")).toContain("판정 중단");
  });

  it("fifty_steps_wrap", () => {
    render(
      <StairLivePanel
        live={live({
          current_step: 0,
          phase: "measure",
          step_states: Array.from({ length: 50 }, (_, i) =>
            i === 0 ? ("measuring" as const) : ("pending" as const),
          ),
        })}
        stair={stairOf(50, true)}
      />,
    );
    expect(screen.getByRole("list", { name: ko.runDetail.stairLive.chipsLabel })).toHaveClass(
      "flex-wrap",
    );
    expect(screen.getAllByRole("listitem")).toHaveLength(50);
  });

  it("suspended_line", () => {
    render(
      <StairLivePanel
        live={live({
          suspended_seconds: 4,
          current_step: 0,
          phase: "measure",
          step_states: ["measuring"],
        })}
        stair={stairOf(1, true)}
      />,
    );
    expect(screen.getByText(ko.report.stair.stopSuspendedLine(4))).toBeInTheDocument();
    expect(screen.getByText(/4초 보류됐습니다/)).toBeInTheDocument();
  });
});

function channel(v: number): number {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function contrastOnWhite(rgb: string): number {
  const m = /rgb\((\d+), (\d+), (\d+)\)/.exec(rgb);
  if (!m) throw new Error(`not an rgb colour: ${rgb}`);
  const lum = 0.2126 * channel(+m[1]) + 0.7152 * channel(+m[2]) + 0.0722 * channel(+m[3]);
  return 1.05 / (lum + 0.05);
}

describe("StairLivePanel chip colours", () => {
  const coloured: StairLive["step_states"] = [
    "ok",
    "spike",
    "saturated",
    "unconfirmed",
    "after",
    "not_measured",
    "partial",
    "skipped",
    "emergency_stopped",
    "frozen",
  ];

  it.each(coloured.map((s, i) => [s, i] as const))(
    "%s chip border and symbol reach 3:1 on white",
    (_state, i) => {
      render(
        <StairLivePanel
          live={live({ step_states: coloured })}
          stair={stairOf(coloured.length, false)}
        />,
      );
      const chip = screen.getAllByRole("listitem")[i];
      expect(contrastOnWhite(chip.style.borderColor)).toBeGreaterThanOrEqual(3);
      const symbol = chip.querySelector<HTMLElement>("span[aria-hidden]");
      if (symbol) expect(contrastOnWhite(symbol.style.color)).toBeGreaterThanOrEqual(3);
    },
  );
});
