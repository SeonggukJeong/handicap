import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ActiveVuChart } from "../ActiveVuChart";
import { ko } from "../../../i18n/ko";
import type { ActiveVuSample, WorkerActiveVuSeries } from "../../../api/schemas";

const merged: ActiveVuSample[] = [
  { ts_second: 100, desired: 5, actual: 4 },
  { ts_second: 101, desired: 5, actual: 5 },
];
const byWorker: WorkerActiveVuSeries[] = [
  { worker_id: "01HWORKERA000000000000000", samples: [{ ts_second: 100, desired: 3, actual: 2 }] },
  { worker_id: "01HWORKERB000000000000000", samples: [{ ts_second: 100, desired: 2, actual: 2 }] },
];

describe("ActiveVuChart", () => {
  it("single worker (byWorker empty): no toggle, no fanout caption", () => {
    render(<ActiveVuChart series={merged} byWorker={[]} width={400} height={200} />);
    expect(screen.getByRole("region", { name: ko.report.activeVuTitle })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: ko.report.activeVuViewByWorker }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(ko.report.activeVuFanout(2))).not.toBeInTheDocument();
  });

  it("multi worker: toggle + fanout caption; 워커별 view shows ordinal labels with worker_id title", async () => {
    const user = userEvent.setup();
    render(<ActiveVuChart series={merged} byWorker={byWorker} width={400} height={200} />);
    // Caption shown in both views.
    expect(screen.getByText(ko.report.activeVuFanout(2))).toBeInTheDocument();
    // Default view = 합계 (no per-worker legend list yet).
    expect(screen.queryByText(ko.report.activeVuWorkerLabel(1))).not.toBeInTheDocument();
    // Switch to 워커별.
    await user.click(screen.getByRole("button", { name: ko.report.activeVuViewByWorker }));
    const w1 = screen.getByText(ko.report.activeVuWorkerLabel(1));
    const w2 = screen.getByText(ko.report.activeVuWorkerLabel(2));
    expect(w1).toBeInTheDocument();
    expect(w2).toBeInTheDocument();
    // R12: raw worker_id surfaced via title on the legend item.
    expect(w1.closest("li")).toHaveAttribute("title", "01HWORKERA000000000000000");
    expect(w2.closest("li")).toHaveAttribute("title", "01HWORKERB000000000000000");
  });
});
