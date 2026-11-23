import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { StairConfig, StairLive } from "../../../api/schemas";
import { ko } from "../../../i18n/ko";
import { StairLivePanel } from "../StairLivePanel";

const stair: StairConfig = {
  targets: [100, 200],
  hold_seconds: 10,
  ramp_seconds: 1,
  discard_seconds: 1,
  auto_stop: {
    saturation: "two_fails",
    emergency: { error_rate_pct: 5, p99_ms: 2000, consecutive_seconds: 3, min_requests: 20 },
  },
};

function liveWith(over: Partial<StairLive>): StairLive {
  return {
    current_step: 0,
    phase: "measure",
    step_states: ["measuring", "pending"],
    step_reasons: [
      { reasons: [], slot_limited: false, ref_fast: false },
      { reasons: [], slot_limited: false, ref_fast: false },
    ],
    last_ok_step: null,
    next_fail_stops: false,
    emergency_now: null,
    suspended_seconds: 0,
    frozen: false,
    stop: null,
    ...over,
  };
}

describe("StairLivePanel — p99 풀이", () => {
  it("즉시 정지 감시의 p99 옆 도움말이 통과한 요청의 p99라고 말한다", async () => {
    const user = userEvent.setup();
    render(
      <StairLivePanel
        live={liveWith({
          emergency_now: { error_rate: 0.01, p99_us: 40_000, bad_streak: 0, held: false },
        })}
        stair={stair}
      />,
    );
    await user.click(screen.getByRole("button", { name: ko.report.sample.stairP99HelpLabel }));
    expect(screen.getByRole("note")).toHaveTextContent("통과한 요청의 p99입니다.");
  });

  it("감시 줄이 없으면 도움말도 없다", () => {
    render(<StairLivePanel live={liveWith({})} stair={{ ...stair, auto_stop: undefined }} />);
    expect(
      screen.queryByRole("button", { name: ko.report.sample.stairP99HelpLabel }),
    ).not.toBeInTheDocument();
  });
});
