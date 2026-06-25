import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CompareOverlaySection } from "../CompareOverlaySection";
import type { Report } from "../../../api/schemas";

function rep(id: string): Report {
  return {
    run: { id },
    windows: [
      {
        ts_second: 1000,
        step_id: "s",
        count: 10,
        error_count: 1,
        status_counts: {},
        p50_ms: 4,
        p95_ms: 8,
        p99_ms: 9,
      },
      {
        ts_second: 1001,
        step_id: "s",
        count: 12,
        error_count: 0,
        status_counts: {},
        p50_ms: 4,
        p95_ms: 9,
        p99_ms: 10,
      },
    ],
  } as unknown as Report;
}
const reports = [rep("aaaaaa111111"), rep("bbbbbb222222")];

describe("CompareOverlaySection", () => {
  it("defaults to req/s + p95 charts (errors off)", () => {
    render(<CompareOverlaySection reports={reports} baselineIdx={0} />);
    expect(screen.getByRole("region", { name: /초당 요청 수/ })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /p95/ })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /초당 에러/ })).not.toBeInTheDocument();
  });

  it("checking errors adds the errors chart; unchecking req/s removes it", async () => {
    const user = userEvent.setup();
    render(<CompareOverlaySection reports={reports} baselineIdx={0} />);
    await user.click(screen.getByRole("checkbox", { name: /초당 에러/ }));
    expect(screen.getByRole("region", { name: /초당 에러/ })).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: /초당 요청 수/ }));
    expect(screen.queryByRole("region", { name: /초당 요청 수/ })).not.toBeInTheDocument();
  });
});
