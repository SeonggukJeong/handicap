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
  return {
    current_step: null,
    phase: null,
    step_states: [],
    last_ok_step: null,
    next_fail_stops: false,
    emergency_now: null,
    suspended_seconds: 0,
    frozen: false,
    stop: null,
    ...over,
  };
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
        "계단 6/10 (600 req/s) 측정 중 · 1–4 정상 · 5 실패(다음 계단 확인 중) → 6계단이 실패하면 자동 정지",
      ),
    ).toBeInTheDocument();
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(10);
    expect(items[4]).toHaveAttribute("aria-label", "5계단 실패(다음 계단 확인 중)");
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
    expect(stopEl).toHaveTextContent("4계단(400 req/s) 판정 뒤 자동 정지");
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
