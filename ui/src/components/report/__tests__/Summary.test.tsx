import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import userEvent from "@testing-library/user-event";
import { Summary } from "../Summary";

const baseSummary = {
  count: 12345,
  errors: 7,
  rps: 123.4,
  duration_seconds: 30,
  p50_ms: 10,
  p95_ms: 50,
  p99_ms: 90,
};

describe("Summary", () => {
  it("renders all summary cards with formatted numbers", () => {
    render(<Summary summary={baseSummary} />);
    const region = screen.getByRole("region", { name: /Report summary/i });
    expect(region).toHaveTextContent("12,345");
    expect(region).toHaveTextContent("7");
    expect(region).toHaveTextContent("123.4");
    expect(region).toHaveTextContent("30s");
    expect(region).toHaveTextContent("10 ms");
    expect(region).toHaveTextContent("50 ms");
    expect(region).toHaveTextContent("90 ms");
  });

  it("shows open-loop cards when targetRps is provided", () => {
    // count=88, dropped=12 → drop rate = 12/(12+88) = 12.0%
    render(<Summary summary={{ ...baseSummary, count: 88 }} dropped={12} targetRps={50} />);
    const region = screen.getByRole("region", { name: /Report summary/i });
    expect(region).toHaveTextContent("Target RPS");
    expect(region).toHaveTextContent("50");
    expect(region).toHaveTextContent("Dropped");
    expect(region).toHaveTextContent("12");
    expect(region).toHaveTextContent("12.0%");
  });

  it("does not show open-loop cards in closed-loop mode (no targetRps)", () => {
    render(<Summary summary={baseSummary} />);
    expect(screen.queryByText(/target rps/i)).toBeNull();
    expect(screen.queryByText(/dropped/i)).toBeNull();
  });

  it("shows 0% drop rate when both dropped and count are zero", () => {
    render(<Summary summary={{ ...baseSummary, count: 0 }} dropped={0} targetRps={100} />);
    const region = screen.getByRole("region", { name: /Report summary/i });
    expect(region).toHaveTextContent("0%");
  });

  it("uses md:grid-cols-9 class for open-loop and md:grid-cols-7 for closed-loop", () => {
    const { container: openContainer } = render(
      <Summary summary={baseSummary} dropped={5} targetRps={100} />,
    );
    const { container: closedContainer } = render(<Summary summary={baseSummary} />);
    const openGrid = openContainer.querySelector(".md\\:grid-cols-9");
    const closedGrid = closedContainer.querySelector(".md\\:grid-cols-7");
    expect(openGrid).not.toBeNull();
    expect(closedGrid).not.toBeNull();
  });

  it("p50/p95/p99 카드에 도움말 버튼이 있고 클릭하면 용어 설명이 열린다", async () => {
    const user = userEvent.setup();
    render(<Summary summary={baseSummary} />);
    expect(screen.getByRole("button", { name: "p50 설명" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "p99 설명" })).toBeInTheDocument();
    expect(screen.queryByRole("note")).toBeNull();
    await user.click(screen.getByRole("button", { name: "p95 설명" }));
    expect(screen.getByRole("note")).toHaveTextContent("95%");
  });

  it("도움말이 없는 카드(Total requests 등)엔 도움말 버튼이 없다", () => {
    render(<Summary summary={baseSummary} />);
    expect(screen.queryByRole("button", { name: "Total requests 설명" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Errors 설명" })).toBeNull();
  });
});
