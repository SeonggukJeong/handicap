import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { ReportHeadline } from "../ReportHeadline";
import type { Profile, ReportSummary } from "../../../api/schemas";
import { ko } from "../../../i18n/ko";
import { readFileSync } from "node:fs";
import nodePath from "node:path";
import { StairReportSchema } from "../../../api/schemas";

const STAIR = StairReportSchema.parse(
  JSON.parse(
    readFileSync(
      nodePath.resolve(__dirname, "../../../../../testdata/stair_report_golden.json"),
      "utf8",
    ),
  ),
);
const STAIR_PROFILE = (p: Profile): Profile => ({
  ...p,
  vus: 0,
  stages: [{ target: 100, duration_seconds: 1 }],
});

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
  it("계단 run: 전체 평균 문장 대신 계단 판정 문장 + 전체 요청 수·에러 줄 (stair-feedback §B101)", () => {
    render(
      <ReportHeadline
        summary={SUMMARY}
        profile={STAIR_PROFILE(CLOSED)}
        verdict={null}
        stair={STAIR}
      />,
    );
    const region = screen.getByRole("region", { name: "쉬운 요약" });
    expect(region).toHaveTextContent(
      "목표 600 iter/s 계단부터 포화했고, 마지막 정상 계단은 500 iter/s입니다(처리량 500 req/s · 95% 응답 시간 8 ms).",
    );
    expect(region).toHaveTextContent("전체 1분 동안 12,345회 요청 · 에러 0.3%");
    expect(region).not.toHaveTextContent("도착률 곡선");
    expect(region).not.toHaveTextContent("0.21초");
  });

  it("계단 run이라도 판정할 계단이 없거나(no_data) 요청 0건이면 기존 문장", () => {
    const noData = { ...STAIR, headline: { ...STAIR.headline, kind: "no_data" as const } };
    const { unmount } = render(
      <ReportHeadline
        summary={SUMMARY}
        profile={STAIR_PROFILE(CLOSED)}
        verdict={null}
        stair={noData}
      />,
    );
    expect(screen.getByRole("region", { name: "쉬운 요약" })).toHaveTextContent("도착률 곡선");
    unmount();
    render(
      <ReportHeadline
        summary={{ ...SUMMARY, count: 0, errors: 0 }}
        profile={STAIR_PROFILE(CLOSED)}
        verdict={null}
        stair={STAIR}
      />,
    );
    expect(screen.getByRole("region", { name: "쉬운 요약" })).not.toHaveTextContent("포화했고");
  });

  it("기준은 있는데 판정이 없으면(요청 0건) 설정 안내 대신 판정하지 않은 이유를 말한다", () => {
    render(
      <ReportHeadline
        summary={{ ...SUMMARY, count: 0, errors: 0 }}
        profile={{ ...CLOSED, criteria: { max_p95_ms: 1000 } }}
        verdict={null}
      />,
    );
    const region = screen.getByRole("region", { name: "쉬운 요약" });
    expect(region).toHaveTextContent("판정하지 않음 — 요청이 없어 판정할 값이 없습니다");
    expect(region).not.toHaveTextContent("합격 기준(SLO)을 설정하면");
  });

  it("평균 기준뿐이고 판정이 없으면 설정 안내가 아니라 평가 불가를 말한다", () => {
    render(
      <ReportHeadline
        summary={SUMMARY}
        profile={{ ...CLOSED, criteria: { max_mean_ms: 3000 } }}
        verdict={null}
      />,
    );
    const region = screen.getByRole("region", { name: "쉬운 요약" });
    expect(region).toHaveTextContent(ko.report.headlineNotEvaluable);
    expect(region).not.toHaveTextContent(ko.report.sloHint);
  });

  it("중단된 run은 요청이 있어도 '요청이 없어'라 말하지 않고 중단 때문이라 말한다", () => {
    render(
      <ReportHeadline
        summary={SUMMARY}
        profile={{ ...CLOSED, criteria: { max_p95_ms: 1000 } }}
        verdict={null}
        status="aborted"
      />,
    );
    const region = screen.getByRole("region", { name: "쉬운 요약" });
    expect(region).toHaveTextContent("판정하지 않음 — 측정이 중단되어 기준 판정은 하지 않았습니다");
    expect(region).not.toHaveTextContent("요청이 없어");
    expect(region).not.toHaveTextContent("합격 기준(SLO)을 설정하면");
  });

  it("실패한 run은 실패 때문이라 말한다", () => {
    render(
      <ReportHeadline
        summary={SUMMARY}
        profile={{ ...CLOSED, criteria: { max_p95_ms: 1000 } }}
        verdict={null}
        status="failed"
      />,
    );
    expect(screen.getByRole("region", { name: "쉬운 요약" })).toHaveTextContent(
      "판정하지 않음 — 측정이 실패해 기준 판정은 하지 않았습니다",
    );
  });

  it("완료됐는데 판정이 없으면(요청 있음) 평가할 데이터 부족이라 말한다", () => {
    render(
      <ReportHeadline
        summary={SUMMARY}
        profile={{ ...CLOSED, criteria: { max_p95_ms: 1000 } }}
        verdict={null}
        status="completed"
      />,
    );
    const region = screen.getByRole("region", { name: "쉬운 요약" });
    expect(region).toHaveTextContent(
      "판정하지 않음 — 기준은 있었지만 평가할 데이터가 부족했습니다",
    );
    expect(region).not.toHaveTextContent("요청이 없어");
  });

  it("판정이 있으면 요청 0건이어도 판정이 우선", () => {
    render(
      <ReportHeadline
        summary={{ ...SUMMARY, count: 0, errors: 0 }}
        profile={{ ...CLOSED, criteria: { max_error_rate: 1 } }}
        verdict={{ passed: true, criteria: [] }}
        status="completed"
      />,
    );
    const region = screen.getByRole("region", { name: "쉬운 요약" });
    expect(region).toHaveTextContent("합격");
    expect(region).not.toHaveTextContent("판정하지 않음");
  });

  it("기준이 없으면 설정 안내 그대로", () => {
    render(
      <ReportHeadline
        summary={{ ...SUMMARY, count: 0, errors: 0 }}
        profile={CLOSED}
        verdict={null}
      />,
    );
    const region = screen.getByRole("region", { name: "쉬운 요약" });
    expect(region).toHaveTextContent("합격 기준(SLO)을 설정하면");
    expect(region).not.toHaveTextContent("판정하지 않음");
  });

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

  it("steady_run_reads_as_fixed_everywhere: 도착률 고정 + 상승은 고정 문장", () => {
    render(
      <ReportHeadline
        summary={SUMMARY}
        profile={{
          ...CLOSED,
          vus: 0,
          duration_seconds: 0,
          stages: [
            { target: 80, duration_seconds: 30 },
            { target: 80, duration_seconds: 270 },
          ],
          steady: { target: 80, ramp_seconds: 30, hold_seconds: 270, discard_seconds: 5 },
        }}
        verdict={null}
      />,
    );
    const region = screen.getByRole("region", { name: "쉬운 요약" });
    expect(region).toHaveTextContent("목표 도착률 초당 80회로 12,345회 요청");
    expect(region).not.toHaveTextContent("곡선");
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

  it("준비 스텝만 있는 시나리오의 0건 run은 준비만 실행했다고 말한다", () => {
    render(
      <ReportHeadline
        summary={{ ...SUMMARY, count: 0, errors: 0 }}
        profile={CLOSED}
        verdict={null}
        setupOnly
      />,
    );
    expect(screen.getByText("본 스텝이 없어서 준비 스텝만 실행했습니다.")).toBeInTheDocument();
    expect(screen.queryByText(ko.report.headlineNoRequests)).not.toBeInTheDocument();
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

  describe("응답 시간 문장의 단위", () => {
    const counts = { count: 100, errors: 10, notSent: 0 };
    const head = () => screen.getByRole("region", { name: ko.report.headlineAria });

    it("바꿔 본 실패 표본: 1ms는 「1ms 안에 실패」", () => {
      render(
        <ReportHeadline
          summary={{ ...SUMMARY, p95_ms: 1 }}
          profile={CLOSED}
          verdict={null}
          latency={{ sample: "failed", counts, switched: true }}
        />,
      );
      expect(head()).toHaveTextContent("1ms 안에 실패");
      expect(head()).not.toHaveTextContent("0.00초");
    });

    it("바꿔 본 모든 요청 표본: 44ms는 「44ms 안에 끝남」", () => {
      render(
        <ReportHeadline
          summary={{ ...SUMMARY, p95_ms: 44 }}
          profile={CLOSED}
          verdict={null}
          latency={{ sample: "all", counts, switched: true }}
        />,
      );
      expect(head()).toHaveTextContent("44ms 안에 끝남");
    });

    it("바꾸지 않았으면 옛 표기 그대로 — 3ms는 「0.00초 안에 응답」", () => {
      render(
        <ReportHeadline
          summary={{ ...SUMMARY, p95_ms: 3 }}
          profile={CLOSED}
          verdict={null}
          latency={{ sample: "passed", counts, switched: false }}
        />,
      );
      expect(head()).toHaveTextContent("0.00초 안에 응답");
    });
  });

  describe("1ms 미만·60초 칸 문장", () => {
    const st = (p95: number) => ({
      min_us: 0,
      mean_us: 0,
      max_us: 0,
      stdev_us: 0,
      p50_us: 0,
      p90_us: 0,
      p95_us: p95,
      p99_us: 0,
      capped: false,
    });
    const counts = { count: 12, errors: 2, notSent: 0 };
    const run = (
      summary: ReportSummary,
      latency?: { sample: "passed" | "failed" | "all"; switched?: boolean },
    ) => {
      render(
        <ReportHeadline
          summary={summary}
          profile={CLOSED}
          verdict={null}
          latency={latency ? { ...latency, counts } : undefined}
        />,
      );
      return screen.getByRole("region", { name: "쉬운 요약" });
    };
    it("1ms 미만은 µs", () => {
      const r = run({ ...SUMMARY, p95_ms: 0, stats: st(350) });
      expect(r).toHaveTextContent("95%가 350 µs 안에 응답");
    });
    it("전환 all은 µs", () => {
      const r = run({ ...SUMMARY, p95_ms: 0, stats: st(350) }, { sample: "all", switched: true });
      expect(r).toHaveTextContent("모든 요청의 95%가 350 µs 안에 끝남");
    });
    it("60초 칸", () => {
      const r = run({ ...SUMMARY, p95_ms: 60030, stats: st(60_000_000) });
      expect(r).toHaveTextContent("5% 이상이 60초를 넘겨 응답");
      expect(r).not.toHaveTextContent("60030");
      expect(r).not.toHaveTextContent("60초 이상 안에");
    });
    it("전환 failed 60초 칸", () => {
      const r = run(
        { ...SUMMARY, p95_ms: 60030, stats: st(60_000_000) },
        { sample: "failed", switched: true },
      );
      expect(r).toHaveTextContent("실패한 요청의 5% 이상이 60초를 넘겨 실패");
    });
    it("전환 all 60초 칸", () => {
      const r = run(
        { ...SUMMARY, p95_ms: 60030, stats: st(60_000_000) },
        { sample: "all", switched: true },
      );
      expect(r).toHaveTextContent("모든 요청의 5% 이상이 60초를 넘김");
    });
    it("1ms 이상은 지금 글자", () => {
      const r = run({ ...SUMMARY, p95_ms: 1234, stats: st(1_234_567) });
      expect(r).toHaveTextContent("95%가 1.2초 안에 응답");
    });
    it("stats 없음·p95 0은 지금 글자", () => {
      const r = run({ ...SUMMARY, p95_ms: 0 });
      expect(r).toHaveTextContent("95%가 0.00초 안에 응답");
    });
  });
});
