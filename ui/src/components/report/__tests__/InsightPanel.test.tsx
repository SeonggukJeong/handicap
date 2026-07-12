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

  it("load_gen_saturated cause 없음 — 헤드라인 + 폴백 행동 줄 (워커 CPU 언급 없음, ADR-0046)", () => {
    const insights: Insight[] = [
      { kind: "load_gen_saturated", severity: "warning", value: 7500, count: 320 },
    ];
    render(<InsightPanel insights={insights} meta={meta} />);
    // 헤드라인: 초당 최대 N건 + 못 보낸 요청 M건 (천단위 구분)
    expect(screen.getByText(/초당 최대 7,500건.*못 보낸 요청이 320건/)).toBeInTheDocument();
    // 폴백 행동 줄 (R13 2-way: cause=slots|sut|없음 뿐, 워커 CPU 언급 없음)
    expect(
      screen.getByText(/동시 실행 수\(max_in_flight\)를 늘려 다시 실행하세요/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/워커 CPU/)).toBeNull();
  });

  it("slo_pass와 미지의 kind엔 행동 줄이 없다", () => {
    const insights: Insight[] = [
      { kind: "slo_pass", severity: "info" },
      { kind: "future_kind", severity: "info" },
    ];
    render(<InsightPanel insights={insights} meta={meta} />);
    expect(screen.queryByText(/→/)).toBeNull();
  });

  it("load_gen_saturated slots — 목표/달성 도착률·유실·권장 슬롯 수치를 행동 줄에 렌더 (R12)", () => {
    const insights: Insight[] = [
      {
        kind: "load_gen_saturated",
        severity: "warning",
        value: 3,
        count: 260,
        cause: "slots",
        recommended: 23,
        target_per_sec: 20,
        achieved_per_sec: 2.7,
      },
    ];
    render(<InsightPanel insights={insights} meta={meta} />);
    expect(screen.getByText(/초당 20회/)).toBeInTheDocument();
    expect(screen.getByText(/2\.7회/)).toBeInTheDocument();
    // Math.max(0, 20-2.7)=17.3 → toFixed(1)="17.3", "~17"은 그 부분문자열
    expect(screen.getByText(/~17/)).toBeInTheDocument();
    expect(screen.getByText(/최소 ~23\(으\)로 올려/)).toBeInTheDocument();
    // 상한(10,000) 미도달이면 slotsAtCap 문구는 없다
    expect(screen.queryByText(/슬롯 상한/)).toBeNull();
  });

  it("load_gen_saturated slots — recommended가 슬롯 상한(10,000) 이상이면 상한 문구를 덧붙인다 (R13)", () => {
    const insights: Insight[] = [
      {
        kind: "load_gen_saturated",
        severity: "warning",
        value: 50,
        count: 9000,
        cause: "slots",
        recommended: 10_000,
        target_per_sec: 100,
        achieved_per_sec: 0.5,
      },
    ];
    render(<InsightPanel insights={insights} meta={meta} />);
    expect(screen.getByText(/최소 ~10,000\(으\)로 올려/)).toBeInTheDocument();
    expect(screen.getByText(/슬롯 상한\(10,000\)에 도달했어요/)).toBeInTheDocument();
  });

  it("load_gen_saturated slots — target_per_sec/achieved_per_sec/recommended 중 하나라도 없으면 폴백 (구식 리포트 방어)", () => {
    const insights: Insight[] = [
      { kind: "load_gen_saturated", severity: "warning", value: 9000, count: 12, cause: "slots" },
    ];
    render(<InsightPanel insights={insights} meta={meta} />);
    expect(
      screen.getByText(/동시 실행 수\(max_in_flight\)를 늘려 다시 실행하세요/),
    ).toBeInTheDocument();
  });

  it("load_gen_saturated sut — 서버 응답 열화 신호 + 슬롯·부하 증설을 보류하라는 행동 줄", () => {
    const insights: Insight[] = [
      { kind: "load_gen_saturated", severity: "warning", value: 800, count: 90, cause: "sut" },
    ];
    render(<InsightPanel insights={insights} meta={meta} />);
    expect(screen.getByText(/대상 서버\(SUT\)가 응답 열화 신호를 보여요/)).toBeInTheDocument();
    expect(screen.getByText(/지금 슬롯·부하를 늘리면 서버만 더 힘들어져요/)).toBeInTheDocument();
    expect(screen.queryByText(/worker_count를/)).toBeNull();
  });

  it("nonzero<0.05% pct는 '<0.1%'로 floor (R5)", () => {
    const insights: Insight[] = [
      { kind: "status_class", severity: "critical", status_class: "5xx", pct: 0.0003, count: 1 },
    ];
    render(<InsightPanel insights={insights} meta={meta} />);
    expect(screen.getByText(/<0\.1%/)).toBeInTheDocument();
  });

  it("load_gen_saturated onset_second면 포화 시점 절을 헤드라인에 렌더", () => {
    const insights: Insight[] = [
      {
        kind: "load_gen_saturated",
        severity: "warning",
        value: 7500,
        count: 320,
        onset_second: 12,
      },
    ];
    render(<InsightPanel insights={insights} meta={meta} />);
    expect(screen.getByText(/약 12초 지점부터 포화/)).toBeInTheDocument();
  });
});
