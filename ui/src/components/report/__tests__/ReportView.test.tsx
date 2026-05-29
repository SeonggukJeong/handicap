// jsdom doesn't implement createObjectURL; provide a no-op for DownloadJsonButton to mount.
if (typeof URL.createObjectURL === "undefined") {
  Object.defineProperty(URL, "createObjectURL", { value: () => "blob:noop", writable: true });
  Object.defineProperty(URL, "revokeObjectURL", { value: () => {}, writable: true });
}

import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { ReportView } from "../ReportView";
import type { Report } from "../../../api/schemas";

const STEP_ID = "01HX0000000000000000000001"; // valid ULID (26 chars, Crockford set)

const FIXTURE: Report = {
  run: {
    id: "R1",
    scenario_id: "S1",
    status: "completed",
    profile: { vus: 1, ramp_up_seconds: 0, duration_seconds: 2 },
    env: { BASE_URL: "http://x" },
    started_at: 100,
    ended_at: 102,
    created_at: 99,
  },
  scenario_yaml: [
    "version: 1",
    "name: x",
    "cookie_jar: auto",
    "variables: {}",
    "steps:",
    `  - id: ${STEP_ID}`,
    "    name: login",
    "    type: http",
    "    request:",
    "      method: POST",
    "      url: ${BASE_URL}/login",
    "    assert: []",
    "    extract: []",
    "",
  ].join("\n"),
  summary: {
    count: 15,
    errors: 1,
    rps: 7.5,
    duration_seconds: 2,
    p50_ms: 10,
    p95_ms: 50,
    p99_ms: 90,
  },
  windows: [
    {
      ts_second: 100,
      step_id: STEP_ID,
      count: 10,
      error_count: 1,
      status_counts: { "200": 9, "500": 1 },
      p50_ms: 10,
      p95_ms: 40,
      p99_ms: 70,
    },
    {
      ts_second: 101,
      step_id: STEP_ID,
      count: 5,
      error_count: 0,
      status_counts: { "200": 5 },
      p50_ms: 8,
      p95_ms: 50,
      p99_ms: 90,
    },
  ],
  steps: [
    {
      step_id: STEP_ID,
      count: 15,
      error_count: 1,
      status_counts: { "200": 14, "500": 1 },
      p50_ms: 10,
      p95_ms: 50,
      p99_ms: 90,
      loop_breakdown: [],
    },
  ],
  status_distribution: { "200": 14, "500": 1 },
};

describe("ReportView", () => {
  it("renders summary, charts, status distribution, step table, and download", () => {
    render(<ReportView report={FIXTURE} />);
    expect(screen.getByRole("region", { name: /Report summary/ })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /Time series — Requests/ })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /Time series — p95/ })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /Time series — Errors/ })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /Status distribution/ })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /Per-step stats/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Download JSON/ })).toBeInTheDocument();
  });

  it("resolves env in step URLs (resolveForDisplay)", () => {
    render(<ReportView report={FIXTURE} />);
    const stepRegion = screen.getByRole("region", { name: /Per-step stats/ });
    expect(stepRegion).toHaveTextContent("http://x/login");
  });

  it("labels a step nested inside a loop using its name", () => {
    const OUTER_ID = "01HX0000000000000000000003"; // loop step id (valid ULID)
    const INNER_ID = "01HX0000000000000000000002"; // inner http step id (valid ULID)
    const scenarioYaml = [
      "version: 1",
      "name: x",
      "cookie_jar: auto",
      "variables: {}",
      "steps:",
      `  - id: ${OUTER_ID}`,
      "    name: my-loop",
      "    type: loop",
      "    repeat: 2",
      "    do:",
      `      - id: ${INNER_ID}`,
      "        name: inner-tick",
      "        type: http",
      "        request:",
      "          method: GET",
      "          url: ${BASE_URL}/tick",
      "        assert: []",
      "        extract: []",
      "",
    ].join("\n");
    const report: Report = {
      ...FIXTURE,
      scenario_yaml: scenarioYaml,
      windows: [
        {
          ts_second: 100,
          step_id: INNER_ID,
          count: 4,
          error_count: 0,
          status_counts: { "200": 4 },
          p50_ms: 5,
          p95_ms: 10,
          p99_ms: 20,
        },
      ],
      steps: [
        {
          step_id: INNER_ID,
          count: 4,
          error_count: 0,
          status_counts: { "200": 4 },
          p50_ms: 5,
          p95_ms: 10,
          p99_ms: 20,
          loop_breakdown: [],
        },
      ],
      status_distribution: { "200": 4 },
    };
    render(<ReportView report={report} />);
    const stepRegion = screen.getByRole("region", { name: /Per-step stats/ });
    expect(stepRegion).toHaveTextContent("inner-tick");
    expect(stepRegion).not.toHaveTextContent(INNER_ID);
  });
});
