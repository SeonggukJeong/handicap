import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { InsightPanel } from "../InsightPanel";
import type { Insight } from "../../../api/schemas";

const meta = new Map([["s1", { id: "s1", name: "checkout", method: "GET", url: "/c" }]]);

describe("InsightPanel", () => {
  it("renders nothing when empty", () => {
    const { container } = render(<InsightPanel insights={[]} meta={new Map()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders a message per kind, resolving step name from meta", () => {
    const insights: Insight[] = [
      { kind: "slo_failure", severity: "critical", count: 2 },
      { kind: "status_class", severity: "critical", status_class: "5xx", pct: 0.12, count: 1203 },
      { kind: "slowest_step", severity: "info", step_id: "s1", metric: "p95_ms", value: 1240 },
    ];
    render(<InsightPanel insights={insights} meta={meta} />);
    expect(screen.getByText(/SLO 실패: 2개 기준 미달/)).toBeInTheDocument();
    expect(screen.getByText(/5xx가 응답의 12\.0% \(1,203건\)/)).toBeInTheDocument();
    expect(screen.getByText(/checkout.*p95 1,240ms로 가장 느림/)).toBeInTheDocument();
  });

  it("preserves backend order", () => {
    const insights: Insight[] = [
      { kind: "slo_failure", severity: "critical", count: 1 },
      { kind: "slowest_step", severity: "info", step_id: "s1", value: 10 },
    ];
    render(<InsightPanel insights={insights} meta={meta} />);
    const items = screen.getAllByTestId("insight").map((e) => e.textContent);
    expect(items[0]).toMatch(/SLO 실패/);
    expect(items[1]).toMatch(/가장 느림/);
  });

  it("kind별 '다음 행동' 줄이 렌더된다", () => {
    const insights: Insight[] = [
      { kind: "slowest_step", severity: "info", step_id: "s1", metric: "p95_ms", value: 1240 },
      { kind: "status_class", severity: "critical", status_class: "5xx", pct: 0.12, count: 3 },
    ];
    render(<InsightPanel insights={insights} meta={meta} />);
    expect(screen.getByText(/스텝 표를 내보내 개발팀과 공유하세요/)).toBeInTheDocument();
    expect(screen.getByText(/5xx면 서버 측 문제부터 확인하세요/)).toBeInTheDocument();
  });

  it("slo_pass와 미지의 kind엔 행동 줄이 없다", () => {
    const insights: Insight[] = [
      { kind: "slo_pass", severity: "info" },
      { kind: "future_kind", severity: "info" },
    ];
    render(<InsightPanel insights={insights} meta={meta} />);
    expect(screen.queryByText(/→/)).toBeNull();
  });
});
