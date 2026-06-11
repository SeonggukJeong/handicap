import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SchedulesPage } from "../SchedulesPage";
import { ko } from "../../i18n/ko";

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((url: string) => {
      if (url.endsWith("/api/schedules")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              schedules: [
                {
                  id: "sch1",
                  name: "nightly",
                  scenario_id: "s1",
                  trigger: { kind: "cron", cron_expr: "0 2 * * *" },
                  enabled: true,
                  next_run_at: 1_700_000_000_000,
                  last_status: "fired",
                  last_fired_at: 1,
                },
              ],
            }),
        });
      }
      if (url.endsWith("/api/scenarios")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ scenarios: [] }),
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("SchedulesPage", () => {
  it("renders schedule list with trigger summary + last_status badge", async () => {
    wrap(<SchedulesPage />);
    expect(await screen.findByText("nightly")).toBeInTheDocument();
    expect(screen.getByText("매일 02:00")).toBeInTheDocument(); // describeTrigger
    expect(screen.getByText("fired")).toBeInTheDocument();
  });

  it("빈 상태: 3요소 문구 + 스케줄 만들기 CTA", async () => {
    // 기존 beforeEach stub을 빈 목록 응답으로 덮어쓴다
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.endsWith("/api/schedules")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ schedules: [] }),
          });
        }
        if (url.endsWith("/api/scenarios")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ scenarios: [] }),
          });
        }
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
      }),
    );
    wrap(<SchedulesPage />);
    expect(await screen.findByText(ko.empty.schedules)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: `${ko.empty.schedulesCta} →` })).toBeInTheDocument();
  });
});
