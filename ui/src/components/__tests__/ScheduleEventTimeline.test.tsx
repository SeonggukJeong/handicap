import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ScheduleEventTimeline } from "../ScheduleEventTimeline";
import * as schedApi from "../../api/schedules";

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.spyOn(schedApi, "scheduleEvents").mockResolvedValue([
    { id: "e1", at: 1_700_000_000_000, kind: "fired", run_id: "run123", detail: null },
    {
      id: "e2",
      at: 1_700_000_100_000,
      kind: "skipped_overlap",
      run_id: null,
      detail: "previous run still running",
    },
  ]);
});

describe("ScheduleEventTimeline", () => {
  it("renders events with kind badges, run link, and detail", async () => {
    wrap(<ScheduleEventTimeline scheduleId="sch1" />);
    expect(await screen.findByText("fired")).toBeInTheDocument();
    expect(screen.getByText("skipped_overlap")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /run123|리포트/ })).toHaveAttribute(
      "href",
      "/runs/run123",
    );
    expect(screen.getByText(/previous run still running/)).toBeInTheDocument();
  });
});
