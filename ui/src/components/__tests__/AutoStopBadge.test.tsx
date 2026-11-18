import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AutoStopBadge } from "../AutoStopBadge";
import { stopHeadText } from "../report/stair/stairFormat";

type RunArg = Parameters<typeof AutoStopBadge>[0]["run"];

const run = (stop: Record<string, unknown>): RunArg =>
  ({
    status: "completed",
    auto_stop: { stop, suspended_seconds: 0 },
    profile: { stair: { targets: [100, 200, 300] } },
  }) as unknown as RunArg;

describe("AutoStopBadge", () => {
  it("상세 문구가 title뿐 아니라 sr-only 접미로도 접근명에 든다", () => {
    const { container } = render(
      <AutoStopBadge run={run({ kind: "emergency", decided_step: 1, phase: "ramp" })} />,
    );
    const detail = "2계단(200 req/s) 상승 중 즉시 정지";
    const sr = container.querySelector("span span");
    expect(sr).toHaveClass("sr-only");
    expect(sr).toHaveTextContent(detail);
    expect(screen.getByText("자동 정지", { exact: false }).closest("span[title]")).toHaveAttribute(
      "title",
      detail,
    );
  });

  it("포화 정지 상세", () => {
    const { container } = render(
      <AutoStopBadge run={run({ kind: "saturation", decided_step: 0 })} />,
    );
    expect(container.querySelector(".sr-only")).toHaveTextContent(
      "1계단(100 req/s) 판정 뒤 자동 정지",
    );
  });

  it("공용 머리말 helper: 단계 목표가 없으면 목표 표기 없음", () => {
    expect(
      stopHeadText({ kind: "emergency", decided_step: 5, phase: "discard" } as never, [100]),
    ).toBe("6계단 버림 중 즉시 정지");
  });
});
