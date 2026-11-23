import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import nodePath from "node:path";
import { StairReportSchema } from "../../../../api/schemas";
import { StairTable } from "../StairTable";
import { buildBandSeries } from "../stairBandSeries";

const golden = StairReportSchema.parse(
  JSON.parse(
    readFileSync(
      nodePath.resolve(__dirname, "../../../../../../testdata/stair_report_golden.json"),
      "utf8",
    ),
  ),
);

describe("StairTable — 통과한 요청이 없는 계단", () => {
  it("p99_us가 0인 계단은 p50·p95·p99가 「—」", () => {
    const stair = structuredClone(golden);
    stair.steps[0] = { ...stair.steps[0], p50_us: 0, p95_us: 0, p99_us: 0, state: "ok" };
    render(<StairTable stair={stair} />);
    const row = within(screen.getByRole("table", { name: "계단 표" })).getAllByRole("row")[1];
    const cells = row.querySelectorAll("td");
    expect([cells[4], cells[5], cells[6]].map((c) => c.textContent)).toEqual(["—", "—", "—"]);
    expect(cells[3].textContent).not.toBe("—");
  });
  it("값이 있는 계단은 그대로", () => {
    const stair = structuredClone(golden);
    stair.steps[0] = { ...stair.steps[0], p99_us: 4000, state: "ok" };
    render(<StairTable stair={stair} />);
    const row = within(screen.getByRole("table", { name: "계단 표" })).getAllByRole("row")[1];
    expect(row.querySelectorAll("td")[6].textContent).toBe("4");
  });
});

describe("buildBandSeries — p99_us 0인 초", () => {
  it("count가 있어도 p99_us가 0이면 점이 없다", () => {
    const rows = buildBandSeries([
      { offset_s: 0, launched: 5, count: 5, p99_us: 0 },
      { offset_s: 1, launched: 5, count: 5, p99_us: 2000 },
    ]);
    expect(rows.map((r) => r.p99_ms)).toEqual([null, 2]);
  });
});
