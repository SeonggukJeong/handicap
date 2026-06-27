import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
  it("로딩 중 한국어 배너 표시 (R4)", async () => {
    // fetch never resolves → loading state
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
    wrap(<SchedulesPage />);
    expect(await screen.findByText(ko.common.loading)).toBeInTheDocument();
  });

  it("에러 시 한국어 배너 표시 (R4)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: "서버 오류" }),
      }),
    );
    wrap(<SchedulesPage />);
    expect(await screen.findByText(ko.common.failedToLoad("서버 오류"))).toBeInTheDocument();
  });

  it("renders schedule list with trigger summary + last_status badge", async () => {
    wrap(<SchedulesPage />);
    expect(await screen.findByText("nightly")).toBeInTheDocument();
    expect(screen.getByText("매일 02:00")).toBeInTheDocument(); // describeTrigger
    expect(screen.getByText("fired")).toBeInTheDocument();
  });

  it("새 스케줄 버튼 클릭 시 폼 카드(region) 노출 — Callout 변환 가드 (ds-spread)", async () => {
    const user = userEvent.setup();
    wrap(<SchedulesPage />);
    await screen.findByText("nightly"); // initial schedule list loaded
    await user.click(screen.getByRole("button", { name: ko.pages.newSchedule }));
    expect(screen.getByRole("region", { name: ko.schedule.formAria })).toBeInTheDocument();
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
