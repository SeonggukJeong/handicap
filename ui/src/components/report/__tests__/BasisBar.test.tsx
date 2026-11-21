import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BasisBar } from "../BasisBar";
import type { ReportBasis } from "../../../api/schemas";

const START = new Date(2026, 0, 1, 10, 0, 30).getTime();
const END = new Date(2026, 0, 1, 10, 4, 55).getTime();

const B: ReportBasis = {
  selected: "steady",
  default: "steady",
  state: "measured",
  config: { ramp_seconds: 30, hold_seconds: 270, discard_seconds: 5 },
  window: { start_ms: START, end_ms: END, measured_seconds: 265 },
  t0_estimated: false,
  dropped_whole_run: false,
  other: {
    rps: 71.24,
    p50_ms: 20,
    p95_ms: 48,
    p99_ms: 90,
    error_rate: 0.003,
    count: 21372,
    duration_seconds: 300,
  },
};

describe("BasisBar", () => {
  it("전환은 radiogroup이고 지금 기준이 선택돼 있다", () => {
    render(<BasisBar basis={B} onSelect={() => {}} />);
    expect(screen.getByRole("radiogroup", { name: "집계 기준" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "유지 구간" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("다른 기준을 누르면 onSelect", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<BasisBar basis={B} onSelect={onSelect} />);
    await user.click(screen.getByRole("radio", { name: "전체 구간" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("whole");
  });

  it("유지 구간 기준 줄", () => {
    render(<BasisBar basis={B} onSelect={() => {}} />);
    expect(
      screen.getByText("유지 구간 · 10:00:30–10:04:55 (265초) · 상승 30초·버림 5초 제외"),
    ).toBeInTheDocument();
  });

  it("전체 구간 기준 줄", () => {
    render(<BasisBar basis={{ ...B, selected: "whole" }} onSelect={() => {}} />);
    expect(screen.getByText("전체 구간 · 상승 30초 포함")).toBeInTheDocument();
  });

  it("전체 구간 기준 줄 — 상승 0이면 낱말만", () => {
    render(
      <BasisBar
        basis={{
          ...B,
          selected: "whole",
          config: { ramp_seconds: 0, hold_seconds: 270, discard_seconds: 5 },
        }}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText("전체 구간", { selector: "p" })).toBeInTheDocument();
    expect(screen.queryByText(/포함/)).not.toBeInTheDocument();
  });

  it("참고 줄", () => {
    render(<BasisBar basis={B} onSelect={() => {}} />);
    expect(
      screen.getByText("전체 구간: 초당 요청 71.2 · p95 48 ms · 오류 0.3%"),
    ).toBeInTheDocument();
  });

  it("참고 줄 — 전체 구간을 보면 유지 구간이 참고", () => {
    render(<BasisBar basis={{ ...B, selected: "whole" }} onSelect={() => {}} />);
    expect(
      screen.getByText("유지 구간: 초당 요청 71.2 · p95 48 ms · 오류 0.3%"),
    ).toBeInTheDocument();
  });

  it("other가 null이면 참고 줄이 없다", () => {
    render(<BasisBar basis={{ ...B, other: null }} onSelect={() => {}} />);
    expect(screen.queryByText(/초당 요청/)).not.toBeInTheDocument();
  });

  it("partial", () => {
    render(
      <BasisBar
        basis={{ ...B, state: "partial", window: { ...B.window!, measured_seconds: 120 } }}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText(/일찍 끝남 — 계획 265초 중 120초/)).toBeInTheDocument();
  });

  it("추정", () => {
    render(<BasisBar basis={{ ...B, t0_estimated: true }} onSelect={() => {}} />);
    expect(screen.getByText(/시작 시각 추정/)).toBeInTheDocument();
  });

  it("not_reached", () => {
    render(
      <BasisBar
        basis={{ ...B, selected: "whole", state: "not_reached", window: null }}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByRole("radio", { name: "유지 구간" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("유지 구간에 닿기 전에 끝나");
  });

  it("no_common_window", () => {
    render(
      <BasisBar
        basis={{ ...B, selected: "whole", state: "no_common_window", window: null }}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByRole("radio", { name: "유지 구간" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("워커 시작 시각 차이가 커서");
  });

  it("measured일 때는 안내 줄(status)이 없다", () => {
    render(<BasisBar basis={B} onSelect={() => {}} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("버림만 있는 설정", () => {
    render(
      <BasisBar
        basis={{ ...B, config: { ramp_seconds: 0, hold_seconds: 270, discard_seconds: 5 } }}
        onSelect={() => {}}
      />,
    );
    const line = screen.getByText(/버림 5초 제외/);
    expect(line.textContent).not.toContain("상승");
  });

  it("기준 줄·참고 줄은 줄바꿈을 허용한다", () => {
    render(<BasisBar basis={B} onSelect={() => {}} />);
    const line = screen.getByText(/상승 30초·버림 5초 제외/);
    expect(line.className).not.toContain("truncate");
    expect(screen.getByText(/초당 요청 71.2/).className).not.toContain("truncate");
  });
});
