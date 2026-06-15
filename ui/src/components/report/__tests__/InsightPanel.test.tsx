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
    const action = screen.getByText(/스텝 표를 내보내 개발팀과 공유하세요/);
    expect(action).toBeInTheDocument();
    expect(screen.getByText(/5xx면 서버 측 문제부터 확인하세요/)).toBeInTheDocument();
    // 화살표는 장식 글리프 — 스크린리더가 "right arrow"를 읽지 않게 aria-hidden (repo 컨벤션: ↳/›)
    expect(action.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });

  it("load_gen_saturated 헤드라인과 다음 행동을 렌더한다", () => {
    const insights: Insight[] = [
      { kind: "load_gen_saturated", severity: "warning", value: 7500, count: 320 },
    ];
    render(<InsightPanel insights={insights} meta={meta} />);
    // 헤드라인: 초당 최대 N건 + 못 보낸 요청 M건 (천단위 구분)
    expect(screen.getByText(/초당 최대 7,500건.*못 보낸 요청이 320건/)).toBeInTheDocument();
    // 다음 행동 줄
    expect(screen.getByText(/대상 서버의 한계, 아니면 테스트 도구/)).toBeInTheDocument();
  });

  it("slo_pass와 미지의 kind엔 행동 줄이 없다", () => {
    const insights: Insight[] = [
      { kind: "slo_pass", severity: "info" },
      { kind: "future_kind", severity: "info" },
    ];
    render(<InsightPanel insights={insights} meta={meta} />);
    expect(screen.queryByText(/→/)).toBeNull();
  });

  it("load_gen_saturated slots — 권장 max_in_flight를 행동 줄에 렌더", () => {
    const insights: Insight[] = [
      {
        kind: "load_gen_saturated",
        severity: "warning",
        value: 7500,
        count: 320,
        cause: "slots",
        recommended: 500,
      },
    ];
    render(<InsightPanel insights={insights} meta={meta} />);
    expect(screen.getByText(/초당 최대 7,500건.*못 보낸 요청이 320건/)).toBeInTheDocument();
    expect(screen.getByText(/최소 ~500\(으\)로 올려/)).toBeInTheDocument();
  });

  it("load_gen_saturated loadgen — worker_count 늘리라는 행동 줄 (추천 수 없음)", () => {
    const insights: Insight[] = [
      { kind: "load_gen_saturated", severity: "warning", value: 9000, count: 12, cause: "loadgen" },
    ];
    render(<InsightPanel insights={insights} meta={meta} />);
    expect(screen.getByText(/worker_count를 늘리면 더 높은 RPS/)).toBeInTheDocument();
  });

  it("load_gen_saturated loadgen — recommended_workers면 worker_count 추천 행동 줄", () => {
    const insights: Insight[] = [
      {
        kind: "load_gen_saturated",
        severity: "warning",
        value: 1000,
        count: 50,
        cause: "loadgen",
        recommended_workers: 3,
      },
    ];
    render(<InsightPanel insights={insights} meta={meta} />);
    // worker_count를 ~3개로 올리라는 추천이 보인다 (Math.round(3)=3 정확 문자열 락인)
    expect(screen.getByText(/worker_count를 ~3개로/)).toBeInTheDocument();
  });

  it("load_gen_saturated sut — 대상 서버 한계 행동 줄 (worker 추천 없음)", () => {
    const insights: Insight[] = [
      { kind: "load_gen_saturated", severity: "warning", value: 800, count: 90, cause: "sut" },
    ];
    render(<InsightPanel insights={insights} meta={meta} />);
    expect(screen.getByText(/대상 서버\(SUT\)가 한계로 보여요/)).toBeInTheDocument();
    expect(screen.getByText(/지속 RPS는 안 올라요/)).toBeInTheDocument();
    expect(screen.queryByText(/worker_count를/)).toBeNull();
  });

  it("load_gen_saturated onset_second면 포화 시점 절을 헤드라인에 렌더", () => {
    const insights: Insight[] = [
      {
        kind: "load_gen_saturated",
        severity: "warning",
        value: 7500,
        count: 320,
        cause: "loadgen",
        onset_second: 12,
      },
    ];
    render(<InsightPanel insights={insights} meta={meta} />);
    expect(screen.getByText(/약 12초 지점부터 포화/)).toBeInTheDocument();
  });
});
