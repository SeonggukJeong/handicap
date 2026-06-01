import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ScenarioTrace } from "../../../api/schemas";
import { TestRunPanel } from "../TestRunPanel";

const TRACE: ScenarioTrace = {
  ok: false,
  total_ms: 42,
  truncated: true,
  error: null,
  final_vars: { token: "abc" },
  steps: [
    {
      step_id: "01HX0000000000000000000010",
      kind: "if",
      loop_index: null,
      branch: "none",
      request: null,
      response: null,
      extracted: {},
      unbound_vars: ["missing_cond"],
      error: null,
    },
    {
      step_id: "01HX0000000000000000000011",
      kind: "http",
      loop_index: 2,
      branch: null,
      request: { method: "GET", url: "http://api/ping", headers: { a: "1" }, body: null },
      response: {
        status: 500,
        latency_ms: 9,
        headers: {},
        set_cookies: [],
        body: "boom",
        body_truncated: false,
      },
      extracted: { id: "42" },
      unbound_vars: [],
      error: "status 500 != 200",
    },
  ],
};

describe("TestRunPanel", () => {
  it("renders the truncated banner and a per-step summary", () => {
    render(<TestRunPanel trace={TRACE} />);
    // truncated banner
    expect(screen.getByText(/상한 도달/)).toBeInTheDocument();
    // http row: method + url + status
    expect(screen.getByText("GET")).toBeInTheDocument();
    expect(screen.getByText("http://api/ping")).toBeInTheDocument();
    expect(screen.getByText("500")).toBeInTheDocument();
    // if row: branch label (none -> "(미매치)")
    expect(screen.getByText(/\(미매치\)/)).toBeInTheDocument();
    // loop_index tag
    expect(screen.getByText("#2")).toBeInTheDocument();
    // unbound var amber chip
    expect(screen.getByText("missing_cond")).toBeInTheDocument();
    // extracted chip
    expect(screen.getByText(/id=42/)).toBeInTheDocument();
    // step error
    expect(screen.getByText(/status 500 != 200/)).toBeInTheDocument();
  });

  it("shows an ok summary when the trace succeeded and is not truncated", () => {
    render(<TestRunPanel trace={{ ...TRACE, ok: true, truncated: false, steps: [] }} />);
    expect(screen.queryByText(/상한 도달/)).not.toBeInTheDocument();
    expect(screen.getByText(/OK/)).toBeInTheDocument();
  });
});
