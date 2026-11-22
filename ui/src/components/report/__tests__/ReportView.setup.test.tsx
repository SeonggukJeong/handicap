import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { ReportView } from "../ReportView";
import type { Profile, Report } from "../../../api/schemas";

vi.mock("../../../api/download", () => ({
  downloadFile: vi.fn(() => Promise.resolve()),
  downloadJson: vi.fn(() => Promise.resolve()),
}));

const SETUP_ID = "01HX0000000000000000000001";
const STEP_ID = "01HX0000000000000000000002";

const YAML = [
  "version: 1",
  "name: x",
  "cookie_jar: auto",
  "variables: {}",
  "setup:",
  "  steps:",
  `    - id: ${SETUP_ID}`,
  "      name: 로그인 준비",
  "      type: http",
  "      request:",
  "        method: POST",
  "        url: http://x/login",
  "steps:",
  `  - id: ${STEP_ID}`,
  "    name: 조회",
  "    type: http",
  "    request:",
  "      method: GET",
  "      url: http://x/o",
  "",
].join("\n");

const BASE: Report = {
  run: {
    id: "R1",
    scenario_id: "S1",
    status: "completed",
    profile: { vus: 1, ramp_up_seconds: 0, duration_seconds: 2 },
    env: {},
    started_at: 100,
    ended_at: 102,
    created_at: 99,
  },
  scenario_yaml: YAML,
  summary: {
    count: 15,
    errors: 0,
    rps: 7.5,
    duration_seconds: 2,
    mean_ms: 20,
    p50_ms: 10,
    p95_ms: 50,
    p99_ms: 90,
  },
  windows: [],
  steps: [
    {
      step_id: STEP_ID,
      count: 15,
      error_count: 0,
      status_counts: { "200": 15 },
      p50_ms: 10,
      p95_ms: 50,
      p99_ms: 90,
    },
  ],
  status_distribution: { "200": 15 },
  dropped: 0,
};

const PROFILE = { vus: 1, ramp_up_seconds: 0, duration_seconds: 2 } as Profile;

function renderIt(report: Report) {
  return render(
    <MemoryRouter>
      <ReportView report={report} profile={PROFILE} />
    </MemoryRouter>,
  );
}

const SUMMARY_LINE =
  "요약·판정에는 준비 스텝이 들어 있지 않습니다. 본 스텝은 준비 스텝을 마친 상태에서 측정했습니다.";

describe("ReportView 준비 스텝", () => {
  it("setup이 없으면 구획도 안내 줄도 없다", () => {
    renderIt(BASE);
    expect(screen.queryByRole("region", { name: "준비 스텝" })).not.toBeInTheDocument();
    expect(screen.queryByText(SUMMARY_LINE)).not.toBeInTheDocument();
  });

  it("setup이 있으면 구획과 안내 줄이 나오고 이름은 준비 스텝에서 온다", () => {
    renderIt({
      ...BASE,
      setup: {
        ok: 1,
        failed: 1,
        interrupted: 0,
        steps: [
          {
            step_id: SETUP_ID,
            count: 2,
            errors: 1,
            p50_ms: 5,
            p95_ms: 6,
            max_ms: 7,
            status_counts: { "200": 1 },
            failure_kinds: { status_assert: 1 },
          },
        ],
      },
    });
    expect(screen.getByRole("region", { name: "준비 스텝" })).toBeInTheDocument();
    expect(screen.getByText(SUMMARY_LINE)).toBeInTheDocument();
    expect(screen.getByText("로그인 준비")).toBeInTheDocument();
  });
});
