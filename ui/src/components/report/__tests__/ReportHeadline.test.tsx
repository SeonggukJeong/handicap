import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { ReportHeadline } from "../ReportHeadline";
import type { Profile, ReportSummary } from "../../../api/schemas";
import { ko } from "../../../i18n/ko";

const SUMMARY: ReportSummary = {
  count: 12345,
  errors: 37,
  rps: 205.7,
  duration_seconds: 60,
  mean_ms: 150,
  p50_ms: 80,
  p95_ms: 210,
  p99_ms: 450,
};

const CLOSED: Profile = {
  vus: 50,
  ramp_up_seconds: 0,
  duration_seconds: 60,
  loop_breakdown_cap: 256,
  http_timeout_seconds: 30,
  measure_phases: false,
};

describe("ReportHeadline", () => {
  it("closed-loop 문장: 시간·VU·요청수·p95·에러율", () => {
    render(<ReportHeadline summary={SUMMARY} profile={CLOSED} verdict={null} />);
    const region = screen.getByRole("region", { name: "쉬운 요약" });
    expect(region).toHaveTextContent(
      "1분 동안 동시 사용자 50명이 12,345회 요청 — 95%가 0.21초 안에 응답, 에러 0.3%",
    );
  });

  it("open-loop(고정 rate) 문장은 목표 도착률 변형", () => {
    render(
      <ReportHeadline summary={SUMMARY} profile={{ ...CLOSED, target_rps: 100 }} verdict={null} />,
    );
    expect(screen.getByRole("region", { name: "쉬운 요약" })).toHaveTextContent(
      "목표 도착률 초당 100회로 12,345회 요청",
    );
  });

  it("open-loop(stages 곡선) 문장은 곡선 변형", () => {
    render(
      <ReportHeadline
        summary={SUMMARY}
        profile={{ ...CLOSED, stages: [{ target: 50, duration_seconds: 30 }] }}
        verdict={null}
      />,
    );
    expect(screen.getByRole("region", { name: "쉬운 요약" })).toHaveTextContent(
      "단계별 도착률 곡선으로 12,345회 요청",
    );
  });

  it("verdict 있으면 합격/불합격을 크게 표시", () => {
    render(
      <ReportHeadline
        summary={SUMMARY}
        profile={CLOSED}
        verdict={{ passed: true, criteria: [] }}
      />,
    );
    expect(screen.getByText(ko.report.verdictPass)).toBeInTheDocument();
    expect(screen.queryByText(ko.report.sloHint)).toBeNull();
  });

  it("verdict 불합격", () => {
    render(
      <ReportHeadline
        summary={SUMMARY}
        profile={CLOSED}
        verdict={{ passed: false, criteria: [] }}
      />,
    );
    expect(screen.getByText(ko.report.verdictFail)).toBeInTheDocument();
  });

  it("verdict 없으면 SLO 발견성 한 줄", () => {
    render(<ReportHeadline summary={SUMMARY} profile={CLOSED} verdict={null} />);
    expect(screen.getByText(ko.report.sloHint)).toBeInTheDocument();
  });

  it("요청 0건이면 별도 문구", () => {
    render(
      <ReportHeadline
        summary={{ ...SUMMARY, count: 0, errors: 0 }}
        profile={CLOSED}
        verdict={null}
      />,
    );
    expect(screen.getByText(ko.report.headlineNoRequests)).toBeInTheDocument();
  });

  it("closed+curve(vu_stages): 단계별 VU 곡선 문구 + VU 수 문구 없음 (Task 8)", () => {
    render(
      <ReportHeadline
        summary={SUMMARY}
        profile={{ ...CLOSED, vu_stages: [{ target: 50, duration_seconds: 30 }] }}
        verdict={null}
      />,
    );
    const region = screen.getByRole("region", { name: "쉬운 요약" });
    expect(region).toHaveTextContent("단계별 VU 곡선으로");
    expect(region).toHaveTextContent("12,345회 요청");
    // closed-loop VU 수 표현이 없어야 함
    expect(region).not.toHaveTextContent("동시 사용자 50명");
  });

  it("nonzero<0.05% 에러율은 '0.0%'가 아니라 '<0.1%'로 floor (R5)", () => {
    render(
      <ReportHeadline
        summary={{ ...SUMMARY, count: 3000, errors: 1 }}
        profile={CLOSED}
        verdict={null}
      />,
    );
    const region = screen.getByRole("region", { name: "쉬운 요약" });
    expect(region).toHaveTextContent(/<0\.1%/);
  });

  // A11: SLO 수치 통과라도 시험 유효성이 limited/suspect면 emerald 강조 금지 (H4)
  it("verdict.passed && validity.suspect → not emerald + headlineSloPassSuspect (both teeth)", () => {
    render(
      <ReportHeadline
        summary={SUMMARY}
        profile={CLOSED}
        verdict={{ passed: true, criteria: [] }}
        validity={{ level: "suspect", reasons: [] }}
      />,
    );
    const passNode = screen.getByText(ko.report.headlineSloPassSuspect);
    expect(passNode).not.toHaveClass("text-emerald-700");
    expect(passNode).toHaveTextContent(ko.report.headlineSloPassSuspect);
    // 기존 "합격" 단독 emerald 카피 없음
    expect(screen.queryByText(ko.report.verdictPass)).toBeNull();
  });

  it("verdict.passed && validity.limited → not emerald + headlineSloPassLimited", () => {
    render(
      <ReportHeadline
        summary={SUMMARY}
        profile={CLOSED}
        verdict={{ passed: true, criteria: [] }}
        validity={{ level: "limited", reasons: [] }}
      />,
    );
    const passNode = screen.getByText(ko.report.headlineSloPassLimited);
    expect(passNode).not.toHaveClass("text-emerald-700");
  });

  it("verdict.passed && validity.ok → keeps emerald 합격", () => {
    render(
      <ReportHeadline
        summary={SUMMARY}
        profile={CLOSED}
        verdict={{ passed: true, criteria: [] }}
        validity={{ level: "ok", reasons: [] }}
      />,
    );
    const passNode = screen.getByText(ko.report.verdictPass);
    expect(passNode).toHaveClass("text-emerald-700");
    expect(screen.queryByText(ko.report.headlineSloPassSuspect)).toBeNull();
  });

  it("verdict.passed && validity absent → keeps emerald 합격 (old reports)", () => {
    render(
      <ReportHeadline
        summary={SUMMARY}
        profile={CLOSED}
        verdict={{ passed: true, criteria: [] }}
      />,
    );
    expect(screen.getByText(ko.report.verdictPass)).toHaveClass("text-emerald-700");
  });
});
