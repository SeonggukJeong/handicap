import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import nodePath from "node:path";
import { MemoryRouter } from "react-router-dom";
import { StairReportSchema, type StairReport, type StairStep } from "../../../../api/schemas";
import { StairResultSection } from "../StairResultSection";
import { formatMs, headlineText, stateLabel, floorPct1 } from "../stairFormat";
import { ReportView } from "../../ReportView";
import { ko } from "../../../../i18n/ko";

const golden = StairReportSchema.parse(
  JSON.parse(
    readFileSync(
      nodePath.resolve(__dirname, "../../../../../../testdata/stair_report_golden.json"),
      "utf8",
    ),
  ),
);

function mk(over: Partial<StairReport> = {}): StairReport {
  return structuredClone({ ...golden, ...over });
}
function withStep(st: StairReport, i: number, over: Partial<StairStep>): StairReport {
  st.steps[i] = { ...st.steps[i], ...over };
  return st;
}
function rowsOf() {
  return within(screen.getByRole("table", { name: "계단 표" })).getAllByRole("row");
}

describe("formatMs", () => {
  it("1 ms 미만은 소수 둘째, 이상은 정수", () => {
    expect(formatMs(500)).toBe("0.50");
    expect(formatMs(999)).toBe("1.00");
    expect(formatMs(1000)).toBe("1");
    expect(formatMs(4001)).toBe("4");
    expect(formatMs(100031)).toBe("100");
  });
});

describe("floorPct1", () => {
  it("내림 소수 첫째 — 94.96%가 95%로 보이지 않는다", () => {
    expect(floorPct1(0.9496)).toBe("94.9%");
    expect(floorPct1(0.25)).toBe("25.0%");
    expect(floorPct1(0.95)).toBe("95.0%");
  });
});

describe("headlineText", () => {
  it("saturated + last", () => {
    expect(headlineText(mk())[0]).toBe("포화 계단 600 req/s · 마지막 정상 500 req/s");
  });
  it("saturated + last 없음 + 힌트", () => {
    const st = mk();
    st.headline = {
      kind: "saturated",
      saturated_target: 100,
      last_ok_target: null,
      through_target: null,
      first_fail_hint: true,
    };
    const lines = headlineText(st);
    expect(lines[0]).toBe("포화 계단 100 req/s · 정상 계단 없음 — 첫 계단부터 실패");
    expect(lines).toContain(ko.report.stair.firstFailHint);
  });
  it("unconfirmed + last", () => {
    const st = mk();
    st.headline = {
      kind: "unconfirmed",
      saturated_target: 500,
      last_ok_target: 400,
      through_target: null,
      first_fail_hint: false,
    };
    expect(headlineText(st)[0]).toBe(
      "포화 의심 500 req/s — 확인할 다음 계단 전에 run이 끝남 · 마지막 정상 400 req/s",
    );
  });
  it("unconfirmed + last 없음은 「정상 계단 없음」 (undefined 출력 금지)", () => {
    const st = mk();
    st.headline = {
      kind: "unconfirmed",
      saturated_target: 100,
      last_ok_target: undefined,
      through_target: null,
      first_fail_hint: false,
    };
    const first = headlineText(st)[0];
    expect(first).toBe("포화 의심 100 req/s — 확인할 다음 계단 전에 run이 끝남 · 정상 계단 없음");
    expect(first).not.toMatch(/undefined|null/);
  });
  it("all_ok / ok_then_unmeasured / no_data", () => {
    const st = mk();
    st.headline = {
      kind: "all_ok",
      saturated_target: null,
      last_ok_target: 600,
      through_target: 600,
      first_fail_hint: false,
    };
    expect(headlineText(st)[0]).toBe("600 req/s까지 정상 (포화 못 찾음 — 더 높은 목표로 다시)");
    st.headline = { ...st.headline, kind: "ok_then_unmeasured", last_ok_target: 400 };
    expect(headlineText(st)[0]).toBe("400 req/s까지 정상 · 이후 계단은 측정 안 됨");
    st.headline = { ...st.headline, kind: "no_data" };
    expect(headlineText(st)[0]).toBe("판정할 수 없음 — 측정이 끝난 계단이 없습니다");
  });
  it("둘째 줄: knee · 튄 계단 · dropped_explained", () => {
    const lines = headlineText(mk());
    expect(lines).toContain(
      "지연 상승 시작 ≈ 300 req/s (p99가 아래 계단의 2.5배 — 판정 기준 안이지만 참고)",
    );
    expect(lines).toContain("튄 계단 1개(400 req/s) 넘김");
    expect(lines.some((l) => l.includes("부하기가 못 보낸 요청 8,500개는 모두"))).toBe(true);
  });
  it("slot_limited 줄은 max_in_flight를 넣는다", () => {
    const st = mk({ dropped_explained: false, slot_limited_targets: [500] });
    const lines = headlineText(st);
    expect(lines.some((l) => l.includes("max_in_flight = 50") && l.includes("500 req/s"))).toBe(
      true,
    );
    expect(lines.some((l) => l.includes("부하기가 못 보낸"))).toBe(false);
  });
});

describe("stateLabel", () => {
  it("6종", () => {
    expect(stateLabel("ok")).toBe("정상");
    expect(stateLabel("spike")).toBe("튄 계단");
    expect(stateLabel("saturated")).toBe("포화");
    expect(stateLabel("unconfirmed")).toBe("확인 못 한 실패");
    expect(stateLabel("after")).toBe("포화 이후");
    expect(stateLabel("not_measured")).toBe("측정 안 됨");
  });
});

describe("StairResultSection", () => {
  it("머리말·표 머리글·행 수", () => {
    render(<StairResultSection stair={mk()} />);
    const sec = screen.getByRole("region", { name: "계단 결과" });
    expect(
      within(sec).getByText("포화 계단 600 req/s · 마지막 정상 500 req/s"),
    ).toBeInTheDocument();
    const table = within(sec).getByRole("table", { name: "계단 표" });
    for (const h of [
      "#",
      "목표(반복/초)",
      "달성(반복/초)",
      "처리량(요청/초)",
      "측정 구간",
      "판정",
    ]) {
      expect(within(table).getByRole("columnheader", { name: h })).toBeInTheDocument();
    }
    expect(within(table).getAllByRole("row")).toHaveLength(1 + 7);
  });

  it("상태 pill 6종과 사유 요약", () => {
    const st = mk();
    withStep(st, 1, { state: "after", reasons: [{ kind: "errors", value: 0.05 }] });
    withStep(st, 2, { state: "unconfirmed" });
    withStep(st, 4, { state: "not_measured", measured_seconds: 0 });
    render(<StairResultSection stair={st} />);
    const table = screen.getByRole("table", { name: "계단 표" });
    for (const l of ["정상", "튄 계단", "포화", "확인 못 한 실패", "포화 이후", "측정 안 됨"]) {
      expect(within(table).getAllByText(l).length).toBeGreaterThanOrEqual(1);
    }
    const rows = rowsOf();
    expect(rows[2]).toHaveTextContent("오류 5.0%");
    expect(rows[4]).toHaveTextContent("p99 4.0×");
    expect(rows[6]).toHaveTextContent("달성 25.0%");
    expect(rows[6]).toHaveTextContent("dropped 8,500");
  });

  it("null은 「—」, 미측정 행 숫자도 「—」", () => {
    const st = mk();
    withStep(st, 5, { achieved: null, dropped: null });
    withStep(st, 4, { state: "not_measured", measured_seconds: 0 });
    render(<StairResultSection stair={st} />);
    const rows = rowsOf();
    const last = within(rows[6]).getAllByRole("cell");
    expect(last[2]).toHaveTextContent("—");
    expect(last[8]).toHaveTextContent("—");
    const nm = within(rows[5]).getAllByRole("cell");
    expect(nm[2]).toHaveTextContent("—");
    expect(nm[5]).toHaveTextContent("—");
    expect(nm[9]).toHaveTextContent("—");
  });

  it("p99_relative: 기준 계단 p99가 1 ms 미만이면 절대 기준으로", () => {
    const st = mk();
    withStep(st, 2, { p99_us: 900 });
    withStep(st, 3, { reasons: [{ kind: "p99_relative", value: 44 }] });
    render(<StairResultSection stair={st} />);
    expect(rowsOf()[4]).toHaveTextContent("p99 5 ms 이상");
    expect(rowsOf()[4]).not.toHaveTextContent("44.0×");
  });

  it("오류율 칸도 내림 — 0.996%는 1.0%가 아니라 0.9%", () => {
    const st = mk();
    withStep(st, 0, { error_rate: 0.00996 });
    render(<StairResultSection stair={st} />);
    const cells = within(rowsOf()[1]).getAllByRole("cell");
    expect(cells[7]).toHaveTextContent(/^0\.9%$/);
  });

  it("오류율 칸: 0이 아닌 미세값은 「<0.1%」, 진짜 0은 0.0%", () => {
    const st = mk();
    withStep(st, 0, { error_rate: 0.0004 });
    withStep(st, 1, { error_rate: 0 });
    render(<StairResultSection stair={st} />);
    expect(within(rowsOf()[1]).getAllByRole("cell")[7]).toHaveTextContent(/^<0\.1%$/);
    expect(within(rowsOf()[2]).getAllByRole("cell")[7]).toHaveTextContent(/^0\.0%$/);
  });

  it("achieved 사유는 내림 — 94.96%는 94.9%", () => {
    const st = mk();
    withStep(st, 5, { reasons: [{ kind: "achieved", value: 0.9496 }] });
    render(<StairResultSection stair={st} />);
    expect(rowsOf()[6]).toHaveTextContent("달성 94.9%");
  });

  it("slot_limited 행은 「슬롯 부족 의심」 + 경고색 줄", () => {
    const st = mk({ dropped_explained: false, slot_limited_targets: [600] });
    withStep(st, 5, { slot_limited: true });
    render(<StairResultSection stair={st} />);
    expect(rowsOf()[6]).toHaveTextContent("슬롯 부족 의심");
    expect(screen.getByText(/시스템 한계로 단정할 수 없음/).closest("[data-tone]")).toHaveAttribute(
      "data-tone",
      "warn",
    );
  });

  it("⚠ 줄은 discard_warning 계단마다", () => {
    const st = mk();
    const n = st.steps.filter((s) => s.discard_warning).length;
    expect(n).toBeGreaterThanOrEqual(1);
    const { unmount } = render(<StairResultSection stair={st} />);
    expect(screen.getAllByText(/^⚠ 계단 \d+:/)).toHaveLength(n);
    expect(
      screen.getByText(
        "⚠ 계단 3: 측정 구간 첫 10초 p99가 나머지의 2.2배 — 앞부분 버림(5초)이 짧았을 수 있습니다.",
      ),
    ).toBeInTheDocument();
    unmount();
    withStep(st, 0, { discard_warning: true, head_p99_ratio: 3 });
    render(<StairResultSection stair={st} />);
    expect(screen.getAllByText(/^⚠ 계단 \d+:/)).toHaveLength(n + 1);
  });

  it("notes 안내와 단위 줄", () => {
    const st = mk({ notes: { t0_estimated: true, open_loop_unknown: true } });
    render(<StairResultSection stair={st} />);
    expect(screen.getByText(/계단 시작 시각을 첫 데이터로 추정/)).toBeInTheDocument();
    expect(screen.getByText(/예전 버전 부하기라 계단별 달성/)).toBeInTheDocument();
    expect(screen.getByText(/단위: 반복\/초·요청\/초·ms/)).toBeInTheDocument();
  });
});

describe("ReportView 배치", () => {
  const base = {
    run: {
      id: "R",
      scenario_id: "S",
      status: "completed",
      profile: { vus: 1, ramp_up_seconds: 0, duration_seconds: 2 },
      env: {},
      started_at: 100,
      ended_at: 102,
      created_at: 99,
    },
    scenario_yaml: "version: 1\nname: x\nsteps: []\n",
    summary: {
      count: 5,
      errors: 0,
      rps: 2.5,
      duration_seconds: 2,
      mean_ms: 22,
      p50_ms: 20,
      p95_ms: 30,
      p99_ms: 30,
    },
    windows: [],
    steps: [],
    status_distribution: { "200": 5 },
    dropped: 0,
  };
  const profile = {
    vus: 1,
    ramp_up_seconds: 0,
    duration_seconds: 2,
    loop_breakdown_cap: 256,
    http_timeout_seconds: 30,
    measure_phases: false,
  };
  const verdict = {
    passed: true,
    criteria: [
      { metric: "error_rate", direction: "max" as const, threshold: 1, actual: 0, passed: true },
    ],
  };

  it("계단 결과는 VerdictPanel 앞, 없으면 섹션도 없다", () => {
    const { rerender } = render(
      <MemoryRouter>
        <ReportView
          report={{
            ...base,
            verdict,
            stair: mk(),
            validity: {
              level: "limited",
              reasons: [{ kind: "no_response_validation", severity: "warning" }],
            },
          }}
          profile={profile}
        />
      </MemoryRouter>,
    );
    const stairSec = screen.getByRole("region", { name: ko.report.stair.title });
    const verdictEl = screen.getByRole("region", { name: ko.report.verdictSectionLabel });
    const bannerEl = screen.getByRole("region", { name: ko.validity.bannerAria });
    expect(
      bannerEl.compareDocumentPosition(stairSec) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      stairSec.compareDocumentPosition(verdictEl) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    rerender(
      <MemoryRouter>
        <ReportView report={{ ...base, verdict }} profile={profile} />
      </MemoryRouter>,
    );
    expect(screen.queryByRole("region", { name: ko.report.stair.title })).toBeNull();
  });
});

describe("StairResultSection auto-stop states", () => {
  it("새 상태 행은 숫자 「—」와 한국어 이름", () => {
    const st = StairReportSchema.parse(
      JSON.parse(
        readFileSync(
          nodePath.resolve(
            __dirname,
            "../../../../../../testdata/stair_autostop_report_golden.json",
          ),
          "utf8",
        ),
      ),
    );
    render(<StairResultSection stair={st} />);
    const rows = rowsOf();
    for (const i of [5, 6]) {
      const cells = within(rows[i]).getAllByRole("cell");
      expect(cells[2]).toHaveTextContent("—");
      expect(cells[3]).toHaveTextContent("—");
      expect(cells[5]).toHaveTextContent("—");
    }
    expect(rows[5]).toHaveTextContent("일부 실행");
    expect(rows[6]).toHaveTextContent("실행 안 함");
    expect(stateLabel("emergency_stopped")).toBe("즉시 정지");
  });
});
