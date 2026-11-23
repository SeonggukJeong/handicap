import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { Summary } from "../Summary";
import { ReportHeadline } from "../ReportHeadline";
import { StepStatsTable } from "../StepStatsTable";
import { WorkerBreakdownTable } from "../WorkerBreakdownTable";
import { BasisBar } from "../BasisBar";
import { basisOtherLine } from "../basisText";
import { ko } from "../../../i18n/ko";
import type { Profile, ReportBasis, ReportSummary } from "../../../api/schemas";

const failedSummary: ReportSummary = {
  count: 10,
  errors: 10,
  rps: 5,
  duration_seconds: 2,
  mean_ms: 0,
  p50_ms: 0,
  p95_ms: 0,
  p99_ms: 0,
};
const okSummary: ReportSummary = {
  ...failedSummary,
  errors: 1,
  p50_ms: 10,
  p95_ms: 50,
  p99_ms: 90,
};
const PROFILE: Profile = {
  vus: 5,
  ramp_up_seconds: 0,
  duration_seconds: 2,
  loop_breakdown_cap: 256,
  http_timeout_seconds: 30,
  measure_phases: false,
};
const failedLatency = { sample: "passed" as const, counts: { count: 10, errors: 10, notSent: 0 } };

describe("Summary — 통과한 요청이 없으면 「—」", () => {
  it("passed 표본·전부 실패: p50·p95·p99 카드가 「—」이고 0 ms가 없다", () => {
    render(<Summary summary={failedSummary} latency={failedLatency} />);
    const region = screen.getByRole("region", { name: /리포트 요약/ });
    expect(region).not.toHaveTextContent("0 ms");
    expect(region.textContent?.match(/—/g)?.length).toBe(3);
  });
  it("all 표본은 지금 그대로(0 ms)", () => {
    render(
      <Summary
        summary={failedSummary}
        latency={{ sample: "all", counts: { count: 10, errors: 10, notSent: 0 } }}
      />,
    );
    expect(screen.getByRole("region", { name: /리포트 요약/ })).toHaveTextContent("0 ms");
  });
  it("값이 있는 run은 그대로", () => {
    render(
      <Summary
        summary={okSummary}
        latency={{ sample: "passed", counts: { count: 10, errors: 1, notSent: 0 } }}
      />,
    );
    expect(screen.getByRole("region", { name: /리포트 요약/ })).toHaveTextContent("50 ms");
  });
});

describe("ReportHeadline — 통과한 요청 없음", () => {
  it("전부 실패하면 「통과한 요청 없음」이고 「95%가」가 없다", () => {
    render(
      <ReportHeadline
        summary={failedSummary}
        profile={PROFILE}
        verdict={null}
        latency={failedLatency}
      />,
    );
    const region = screen.getByRole("region", { name: "쉬운 요약" });
    expect(region).toHaveTextContent("통과한 요청 없음");
    expect(region).not.toHaveTextContent("95%가");
  });
  it("값이 있으면 지금 문장 그대로", () => {
    render(
      <ReportHeadline
        summary={{ ...okSummary, count: 12345, errors: 37, p95_ms: 210 }}
        profile={PROFILE}
        verdict={null}
        latency={{ sample: "passed", counts: { count: 12345, errors: 37, notSent: 0 } }}
      />,
    );
    expect(screen.getByRole("region", { name: "쉬운 요약" })).toHaveTextContent(
      "2초 동안 동시 사용자 5명이 12,345회 요청 — 95%가 0.21초 안에 응답, 에러 0.3%",
    );
  });
});

describe("StepStatsTable·WorkerBreakdownTable", () => {
  const step = {
    step_id: "s1",
    count: 10,
    error_count: 10,
    status_counts: { "500": 10 },
    p50_ms: 0,
    p95_ms: 0,
    p99_ms: 0,
    loop_breakdown: [],
  };
  it("passed 표본: 전부 실패한 스텝은 「—」 셋, 0이 없다", () => {
    render(<StepStatsTable steps={[step]} meta={new Map()} sample="passed" />);
    const row = screen.getByText("s1").closest("tr")!;
    expect(row.textContent?.match(/—/g)?.length).toBe(3);
  });
  it("all 표본: 보냈으면 0도 값", () => {
    render(<StepStatsTable steps={[step]} meta={new Map()} />);
    const cells = screen.getByText("s1").closest("tr")!.querySelectorAll("td");
    expect(cells[5].textContent).toBe("0");
  });
  it("워커: 통과 0인 워커는 「—」", () => {
    render(
      <WorkerBreakdownTable
        sample="passed"
        breakdown={[
          { worker_id: "a", count: 4, errors: 4, p50_ms: 0, p95_ms: 0, p99_ms: 0 },
          { worker_id: "b", count: 4, errors: 1, p50_ms: 7, p95_ms: 8, p99_ms: 9 },
        ]}
      />,
    );
    const rows = screen.getAllByRole("row");
    expect(rows[1].textContent?.match(/—/g)?.length).toBe(3);
    expect(rows[2]).toHaveTextContent("789");
  });
  it("워커 failed 표본: 오류 0인 워커는 「—」", () => {
    render(
      <WorkerBreakdownTable
        sample="failed"
        breakdown={[
          { worker_id: "a", count: 4, errors: 0, p50_ms: 0, p95_ms: 0, p99_ms: 0 },
          { worker_id: "b", count: 4, errors: 1, p50_ms: 7, p95_ms: 8, p99_ms: 9 },
        ]}
      />,
    );
    expect(screen.getAllByRole("row")[1].textContent?.match(/—/g)?.length).toBe(3);
  });
});

describe("basisOtherLine — 다른 기준의 p95", () => {
  const base = (over: Partial<NonNullable<ReportBasis["other"]>>): ReportBasis => ({
    selected: "steady",
    default: "steady",
    state: "measured",
    config: { ramp_seconds: 0, hold_seconds: 10, discard_seconds: 0 },
    window: { start_ms: 0, end_ms: 10000, measured_seconds: 10 },
    t0_estimated: false,
    dropped_whole_run: false,
    other: {
      rps: 5,
      p50_ms: 0,
      p95_ms: 0,
      p99_ms: 0,
      error_rate: 1,
      count: 10,
      duration_seconds: 10,
      ...over,
    },
  });
  it("passed: 전부 실패하면 「p95 —」", () => {
    expect(basisOtherLine(base({}), "passed")).toBe(
      "전체 구간: 초당 요청 5.0 · p95 — · 오류 100.0%",
    );
  });
  it("passed: 요청 0건도 「p95 —」", () => {
    expect(basisOtherLine(base({ count: 0, error_rate: 0 }), "passed")).toContain("p95 —");
  });
  it("all은 0도 값", () => {
    expect(basisOtherLine(base({}), "all")).toContain("p95 0 ms");
  });
  it("BasisBar에 sample을 넘기면 반영", () => {
    render(<BasisBar basis={base({})} onSelect={() => {}} sample="passed" />);
    expect(screen.getByText(/p95 —/)).toBeInTheDocument();
  });
});

describe("ko — 머리말 응답 시간 조각", () => {
  it("headlineLatency", () => {
    expect(ko.report.headlineLatency("0.21초")).toBe("95%가 0.21초 안에 응답");
    expect(ko.report.headlineLatency(null)).toBe("통과한 요청 없음");
    expect(ko.report.basis.otherLine("a", "1.0", null, "0%")).toContain("p95 —");
  });
});
