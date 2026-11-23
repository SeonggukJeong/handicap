import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SetupLiveLine } from "../SetupLiveLine";
import type { SetupLiveView } from "../setupLive";

const view = (o: Partial<SetupLiveView> = {}): SetupLiveView => ({
  unit: "vu",
  ok: 37,
  failed: 0,
  total: 50,
  okPct: 74,
  failedPct: 0,
  ...o,
});

const HINT_VU =
  "준비에 실패한 사용자는 본 스텝을 실행하지 않습니다. 끝난 뒤 리포트의 「준비 스텝」에서 원인을 볼 수 있습니다.";
const HINT_SLOT =
  "준비에 실패한 슬롯은 run에서 빠집니다. 끝난 뒤 리포트의 「준비 스텝」에서 원인을 볼 수 있습니다.";

const root = (c: HTMLElement) => c.firstElementChild as HTMLElement;

describe("SetupLiveLine", () => {
  it("정상 — 라벨·숫자 줄·막대, 경고 없음", () => {
    const { container } = render(<SetupLiveLine view={view()} />);
    expect(screen.getByText("준비 스텝")).toBeInTheDocument();
    const num = screen.getByTestId("setup-live-num");
    expect(num.textContent).toBe("37 / 50명 완료");
    expect(num.querySelector("b")?.textContent).toBe("37");
    const bar = screen.getByTestId("setup-live-bar");
    expect(bar).toHaveAttribute("aria-hidden", "true");
    expect(root(container).className).not.toContain("border-amber-300");
    expect(screen.queryByText(HINT_VU)).toBeNull();
  });

  it("실패 있으면 경고색과 설명 줄", () => {
    const { container } = render(<SetupLiveLine view={view({ failed: 2, failedPct: 4 })} />);
    expect(screen.getByText("실패 2명")).toBeInTheDocument();
    expect(root(container).className).toContain("border-amber-300");
    expect(root(container).className).toContain("bg-amber-50");
    expect(screen.getByText(HINT_VU)).toBeInTheDocument();
  });

  it("슬롯 단위", () => {
    const { rerender } = render(
      <SetupLiveLine view={view({ unit: "slot", ok: 180, total: 200 })} />,
    );
    expect(screen.getByTestId("setup-live-num").textContent).toBe("180 / 200 슬롯 완료");
    rerender(<SetupLiveLine view={view({ unit: "slot", ok: 180, total: 200, failed: 3 })} />);
    expect(screen.getByText("실패 3 슬롯")).toBeInTheDocument();
    expect(screen.getByText(HINT_SLOT)).toBeInTheDocument();
  });

  it("분모 null이면 막대 없음", () => {
    render(<SetupLiveLine view={view({ ok: 120, total: null, okPct: 0 })} />);
    expect(screen.getByTestId("setup-live-num").textContent).toBe("120명 완료");
    expect(screen.queryByTestId("setup-live-bar")).toBeNull();
  });

  it("막대 안쪽 폭 — 완료·실패 순서대로 비율", () => {
    render(<SetupLiveLine view={view({ failed: 2, okPct: 74, failedPct: 4 })} />);
    const [okSeg, failedSeg] = Array.from(
      screen.getByTestId("setup-live-bar").children,
    ) as HTMLElement[];
    expect(okSeg.style.width).toBe("74%");
    expect(failedSeg.style.width).toBe("4%");
  });

  it("막대 안쪽 폭 — 넘침이면 100%와 0%(실패 칸은 폭 0으로 남는다)", () => {
    render(
      <SetupLiveLine view={view({ ok: 12, failed: 3, total: 10, okPct: 100, failedPct: 0 })} />,
    );
    const [okSeg, failedSeg] = Array.from(
      screen.getByTestId("setup-live-bar").children,
    ) as HTMLElement[];
    expect(okSeg.style.width).toBe("100%");
    expect(failedSeg.style.width).toBe("0%");
  });

  it("큰 수는 쉼표", () => {
    render(<SetupLiveLine view={view({ ok: 12345, total: 20000 })} />);
    expect(screen.getByTestId("setup-live-num").textContent).toBe("12,345 / 20,000명 완료");
  });

  it("live region이 아니다", () => {
    const { container } = render(<SetupLiveLine view={view({ failed: 1 })} />);
    expect(root(container)).not.toHaveAttribute("role");
    expect(root(container)).not.toHaveAttribute("aria-live");
  });
});
