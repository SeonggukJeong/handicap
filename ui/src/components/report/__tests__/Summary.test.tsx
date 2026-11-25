import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import userEvent from "@testing-library/user-event";
import { Summary } from "../Summary";
import { ko } from "../../../i18n/ko";

const baseSummary = {
  count: 12345,
  errors: 7,
  rps: 123.4,
  duration_seconds: 30,
  mean_ms: 30,
  p50_ms: 10,
  p95_ms: 50,
  p99_ms: 90,
};

describe("Summary", () => {
  it("renders all summary cards with formatted numbers", () => {
    render(<Summary summary={baseSummary} />);
    const region = screen.getByRole("region", { name: /리포트 요약/ });
    expect(region).toHaveTextContent("12,345");
    expect(region).toHaveTextContent("7");
    expect(region).toHaveTextContent("123.4");
    expect(region).toHaveTextContent("30s");
    expect(region).toHaveTextContent("10 ms");
    expect(region).toHaveTextContent("50 ms");
    expect(region).toHaveTextContent("90 ms");
  });

  it("shows open-loop cards when openLoop is provided", () => {
    // count=88, dropped=12 → drop rate = 12/(12+88) = 12.0%
    render(
      <Summary
        summary={{ ...baseSummary, count: 88 }}
        dropped={12}
        openLoop={{ target: 50, curve: false, achieved: 50 }}
      />,
    );
    const region = screen.getByRole("region", { name: /리포트 요약/ });
    expect(region).toHaveTextContent("목표 도착률");
    expect(region).toHaveTextContent("50");
    expect(region).toHaveTextContent("드롭");
    expect(region).toHaveTextContent("12");
    expect(region).toHaveTextContent("12.0%");
  });

  it("does not show open-loop cards in closed-loop mode (no openLoop)", () => {
    render(<Summary summary={baseSummary} />);
    expect(screen.queryByText(/target rps/i)).toBeNull();
    expect(screen.queryByText(/dropped/i)).toBeNull();
  });

  it("shows 0% drop rate when both dropped and count are zero", () => {
    render(
      <Summary
        summary={{ ...baseSummary, count: 0 }}
        dropped={0}
        openLoop={{ target: 100, curve: false, achieved: 100 }}
      />,
    );
    const region = screen.getByRole("region", { name: /리포트 요약/ });
    expect(region).toHaveTextContent("0%");
  });

  it("splits the grid by width: lg:grid-cols-6 for open-loop, xl:grid-cols-8 for closed-loop", () => {
    const { container: openContainer } = render(
      <Summary
        summary={baseSummary}
        dropped={5}
        openLoop={{ target: 100, curve: false, achieved: 95 }}
      />,
    );
    const { container: closedContainer } = render(<Summary summary={baseSummary} />);
    const openGrid = openContainer.querySelector(".lg\\:grid-cols-6");
    const closedGrid = closedContainer.querySelector(".xl\\:grid-cols-8");
    expect(openGrid).not.toBeNull();
    expect(closedGrid).not.toBeNull();
    for (const g of [openGrid, closedGrid]) {
      expect(g).toHaveClass("grid-cols-2", "md:grid-cols-4");
      expect(g).not.toHaveClass("grid-cols-3");
    }
  });

  it("달성 도착률 카드가 achieved 값을 toFixed(1)로 표시한다", () => {
    render(
      <Summary
        summary={baseSummary}
        dropped={0}
        openLoop={{ target: 20, curve: false, achieved: 2.6667 }}
      />,
    );
    const region = screen.getByRole("region", { name: /리포트 요약/ });
    expect(region).toHaveTextContent("2.7");
    expect(screen.getByText(ko.report.cardAchievedRate)).toBeInTheDocument();
  });

  it("곡선(curve:true)이면 라벨이 '목표 도착률(피크)'이고 achieved null이면 '—'를 표시한다", () => {
    render(
      <Summary
        summary={baseSummary}
        dropped={0}
        openLoop={{ target: 30, curve: true, achieved: null }}
      />,
    );
    const region = screen.getByRole("region", { name: /리포트 요약/ });
    expect(screen.getByText(ko.report.cardTargetRatePeak)).toBeInTheDocument();
    expect(region).toHaveTextContent("—");
  });

  it("openLoop 미전달(closed) 시 카드는 8개(평균 카드 포함)", () => {
    render(<Summary summary={baseSummary} />);
    const region = screen.getByRole("region", { name: /리포트 요약/ });
    expect(region.querySelectorAll(":scope > div > div").length).toBe(8);
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

  it("요약 카드의 시간 라벨은 「측정 시간」이다", () => {
    render(<Summary summary={baseSummary} />);
    expect(screen.getByText("측정 시간")).toBeInTheDocument();
  });

  it("도움말이 없는 카드(총 요청·에러·측정 시간)엔 도움말 버튼이 없다", () => {
    render(<Summary summary={baseSummary} />);
    expect(screen.queryByRole("button", { name: "총 요청 설명" })).toBeNull();
    expect(screen.queryByRole("button", { name: "에러 설명" })).toBeNull();
    expect(screen.queryByRole("button", { name: "측정 시간 설명" })).toBeNull();
  });

  it("평균 RPS 카드에 RPS 용어 도움말이 있다", async () => {
    const user = userEvent.setup();
    render(<Summary summary={baseSummary} />);
    await user.click(screen.getByRole("button", { name: "평균 RPS 설명" }));
    expect(screen.getByRole("note")).toHaveTextContent("초당 요청 수");
  });

  it("open-loop 카드(목표 도착률·드롭) 라벨이 한국어이고 드롭에 도움말이 있다", () => {
    render(
      <Summary
        summary={baseSummary}
        dropped={5}
        openLoop={{ target: 100, curve: false, achieved: 95 }}
      />,
    );
    expect(screen.getByText("목표 도착률")).toBeInTheDocument();
    expect(screen.getByText("드롭")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "드롭 설명" })).toBeInTheDocument();
  });

  it("steady_run_reads_as_fixed_everywhere: dropBase가 있으면 버림 비율 분모가 전체 구간 요청 수", () => {
    const { unmount } = render(
      <Summary
        summary={{ ...baseSummary, count: 400 }}
        dropped={100}
        dropBase={{ count: 1000 }}
        openLoop={{ target: 80, curve: false, achieved: 80 }}
      />,
    );
    expect(screen.getByRole("region", { name: /리포트 요약/ })).toHaveTextContent(/100 \(9\.1%\)/);
    unmount();
    render(
      <Summary
        summary={{ ...baseSummary, count: 400 }}
        dropped={100}
        openLoop={{ target: 80, curve: false, achieved: 80 }}
      />,
    );
    expect(screen.getByRole("region", { name: /리포트 요약/ })).toHaveTextContent(/100 \(20\.0%\)/);
  });

  it("nonzero<0.05% 드롭율은 '<0.1%'로 floor, 이중 %% 없음 (R6)", () => {
    // dropped=1, count=3000 → dropRate = 1/(1+3000) ≈ 0.033% (<0.05%)
    render(
      <Summary
        summary={{ ...baseSummary, count: 3000 }}
        dropped={1}
        openLoop={{ target: 100, curve: false, achieved: 100 }}
      />,
    );
    const region = screen.getByRole("region", { name: /리포트 요약/ });
    expect(region).toHaveTextContent(/1 \(<0\.1%\)/);
    expect(region.textContent).not.toMatch(/<0\.1%%/);
  });

  it("섹션·헤딩 캐넌 클래스 lockstep (byte-identical 가드)", () => {
    render(<Summary summary={baseSummary} />);
    expect(screen.getByRole("region", { name: ko.report.summaryLabel }).className).toBe("mb-6");
    expect(screen.getByRole("heading", { level: 3, name: ko.report.summaryTitle }).className).toBe(
      "text-lg font-semibold mb-2",
    );
  });
});

describe("평균 카드·µs (R22·R23)", () => {
  const stats = (o: Record<string, number | boolean> = {}) => ({
    min_us: 0,
    mean_us: 0,
    max_us: 0,
    stdev_us: 0,
    p50_us: 0,
    p90_us: 0,
    p95_us: 0,
    p99_us: 0,
    capped: false,
    ...o,
  });
  const labels = () =>
    Array.from(
      screen.getByRole("region", { name: /리포트 요약/ }).querySelectorAll(".grid > div"),
    ).map((c) => c.children[0].childNodes[0].textContent);
  const cardValue = (label: string) => {
    const cards = Array.from(
      screen.getByRole("region", { name: /리포트 요약/ }).querySelectorAll(".grid > div"),
    );
    const card = cards.find((c) => c.children[0].childNodes[0].textContent === label)!;
    return card.children[1].textContent;
  };

  it("카드 라벨 순서", () => {
    render(<Summary summary={baseSummary} />);
    expect(labels()).toEqual([
      ko.report.cardTotalRequests,
      ko.report.cardErrors,
      ko.report.cardAvgRps,
      ko.report.cardDuration,
      ko.report.cardMean,
      "p50",
      "p95",
      "p99",
    ]);
  });
  it("평균 값", () => {
    const m = { ...baseSummary, mean_ms: 1843 };
    const { unmount } = render(
      <Summary summary={{ ...m, stats: stats({ mean_us: 1_842_613 }) }} />,
    );
    expect(cardValue(ko.report.cardMean)).toBe("1843 ms");
    unmount();
    const r2 = render(
      <Summary summary={{ ...m, stats: stats({ mean_us: 1_842_613, capped: true }) }} />,
    );
    expect(cardValue(ko.report.cardMean)).toBe("≥\u00a01843 ms");
    r2.unmount();
    const r3 = render(
      <Summary
        summary={{ ...m, mean_ms: 60015, stats: stats({ mean_us: 60_000_000, capped: true }) }}
      />,
    );
    expect(cardValue(ko.report.cardMean)).toBe("≥\u00a060,000 ms");
    r3.unmount();
    const r4 = render(<Summary summary={{ ...m, mean_ms: 0, stats: stats({ mean_us: 350 }) }} />);
    expect(cardValue(ko.report.cardMean)).toBe("350 µs");
    r4.unmount();
    const r5 = render(<Summary summary={m} />);
    expect(cardValue(ko.report.cardMean)).toBe("—");
    r5.unmount();
    render(
      <Summary
        summary={{ ...m, stats: stats({ mean_us: 1_842_613 }) }}
        latency={{
          sample: "passed",
          counts: { count: 5, errors: 5, notSent: 0 },
          switched: true,
        }}
      />,
    );
    expect(cardValue(ko.report.cardMean)).toBe("—");
  });
  it("p 카드", () => {
    const r1 = render(
      <Summary summary={{ ...baseSummary, p95_ms: 0, stats: stats({ p95_us: 350 }) }} />,
    );
    expect(cardValue("p95")).toBe("350 µs");
    r1.unmount();
    const r2 = render(
      <Summary summary={{ ...baseSummary, p99_ms: 60030, stats: stats({ p99_us: 60_000_000 }) }} />,
    );
    expect(cardValue("p99")).toBe("≥\u00a060,000 ms");
    r2.unmount();
    render(<Summary summary={{ ...baseSummary, p95_ms: 43 }} />);
    expect(cardValue("p95")).toBe("43 ms");
  });
  it("평균 카드 HelpTip", () => {
    render(<Summary summary={baseSummary} />);
    expect(screen.getByRole("button", { name: "평균 설명" })).toBeInTheDocument();
  });
});
