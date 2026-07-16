import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { DatasetsPage } from "../DatasetsPage";
import { ko } from "../../i18n/ko";

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <DatasetsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("DatasetsPage", () => {
  it("lists datasets", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        datasets: [
          {
            id: "01J",
            name: "users",
            columns: ["email", "pw"],
            row_count: 2,
            byte_size: 30,
            created_at: 1,
          },
        ],
      }),
    );
    renderPage();
    expect(await screen.findByText("users")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument(); // row_count
  });

  it("shows empty state", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ datasets: [] }));
    renderPage();
    expect(await screen.findByText(ko.empty.datasets)).toBeInTheDocument();
  });

  it("shows delete error in a callout (F6 guard)", async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          datasets: [
            {
              id: "D1",
              name: "users",
              columns: ["email"],
              row_count: 1,
              byte_size: 9,
              created_at: 1,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "서버 오류" }), { status: 500 }));
    renderPage();
    await screen.findByText("users");
    await user.click(screen.getByRole("button", { name: /삭제/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/삭제/);
  });

  it("deletes a dataset", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          datasets: [
            {
              id: "01J",
              name: "users",
              columns: ["email"],
              row_count: 1,
              byte_size: 9,
              created_at: 1,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 })) // delete
      .mockResolvedValueOnce(jsonResponse({ datasets: [] })); // refetch
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("users");
    await user.click(screen.getByRole("button", { name: /삭제/i }));
    await waitFor(() => expect(screen.getByText(ko.empty.datasets)).toBeInTheDocument());
  });
});

describe("DatasetsPage — soft delete (A2)", () => {
  it("skips force-delete when user declines confirm", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    let deleteCalls = 0;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (
        String(url).endsWith("/api/datasets") &&
        (!init || init.method === "GET" || !init.method)
      ) {
        return Promise.resolve(
          jsonResponse({
            datasets: [
              {
                id: "D1",
                name: "users",
                columns: ["user"],
                row_count: 2,
                byte_size: 1,
                created_at: 1,
              },
            ],
          }),
        );
      }
      if (String(url).includes("/api/datasets/D1") && init?.method === "DELETE") {
        deleteCalls += 1;
        if (String(url).includes("force=true"))
          return Promise.resolve(new Response(null, { status: 204 }));
        return Promise.resolve(
          jsonResponse(
            {
              error: "1개 프리셋",
              presets: [{ preset_id: "P1", name: "heavy", scenario_id: "S1" }],
            },
            409,
          ),
        );
      }
      return Promise.resolve(jsonResponse({}, 404));
    });

    renderPage();
    await user.click(await screen.findByRole("button", { name: /삭제/i }));
    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    // User declined — no force DELETE should have been sent
    await waitFor(() => expect(deleteCalls).toBe(1));
    confirmSpy.mockRestore();
  });

  it("confirms then force-deletes when a preset references the dataset", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    let deleteCalls = 0;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (
        String(url).endsWith("/api/datasets") &&
        (!init || init.method === "GET" || !init.method)
      ) {
        return Promise.resolve(
          jsonResponse({
            datasets: [
              {
                id: "D1",
                name: "users",
                columns: ["user"],
                row_count: 2,
                byte_size: 1,
                created_at: 1,
              },
            ],
          }),
        );
      }
      if (String(url).includes("/api/datasets/D1") && init?.method === "DELETE") {
        deleteCalls += 1;
        if (String(url).includes("force=true"))
          return Promise.resolve(new Response(null, { status: 204 }));
        return Promise.resolve(
          jsonResponse(
            {
              error: "1개 프리셋",
              presets: [{ preset_id: "P1", name: "heavy", scenario_id: "S1" }],
            },
            409,
          ),
        );
      }
      return Promise.resolve(jsonResponse({}, 404));
    });

    renderPage();
    await user.click(await screen.findByRole("button", { name: /삭제/i }));
    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    expect(confirmSpy.mock.calls[0][0]).toMatch(/heavy/);
    await waitFor(() => expect(deleteCalls).toBe(2));
    confirmSpy.mockRestore();
  });
});

const twoDatasets = {
  datasets: [
    { id: "01A", name: "users", columns: ["email"], row_count: 2, byte_size: 10, created_at: 1 },
    { id: "01B", name: "items", columns: ["sku"], row_count: 1, byte_size: 5, created_at: 2 },
  ],
};
function routeFetch() {
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/rows")) {
      const which = url.includes("01A") ? "users" : "items";
      const rows =
        which === "users" ? [{ email: "a@ex.com" }, { email: "b@ex.com" }] : [{ sku: "S1" }];
      return Promise.resolve(jsonResponse({ rows, offset: 0, total: rows.length }));
    }
    return Promise.resolve(jsonResponse(twoDatasets));
  });
}

describe("DatasetsPage 미리보기 확장 (R4·R13)", () => {
  it("접힌 상태에선 rows fetch 없음, 펼치면 패널 렌더 (R4·R13)", async () => {
    routeFetch();
    renderPage();
    await screen.findByText("users");
    expect(fetchMock.mock.calls.every(([u]) => !String(u).includes("/rows"))).toBe(true);
    const user = userEvent.setup();
    await user.click(screen.getAllByRole("button", { name: ko.dataset.previewToggle })[0]);
    const region = await screen.findByRole("region", {
      name: ko.dataset.previewAria("users"),
    });
    expect(await within(region).findByText("a@ex.com")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: ko.dataset.previewToggle })[0]).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("다른 행을 펼치면 이전 패널이 접힌다 — 단일 확장 (R4)", async () => {
    routeFetch();
    renderPage();
    await screen.findByText("users");
    const user = userEvent.setup();
    const toggles = () => screen.getAllByRole("button", { name: ko.dataset.previewToggle });
    await user.click(toggles()[0]);
    await screen.findByRole("region", { name: ko.dataset.previewAria("users") });
    await user.click(toggles()[1]);
    await screen.findByRole("region", { name: ko.dataset.previewAria("items") });
    expect(
      screen.queryByRole("region", { name: ko.dataset.previewAria("users") }),
    ).not.toBeInTheDocument();
  });

  it("같은 토글을 다시 누르면 접힌다 (R4)", async () => {
    routeFetch();
    renderPage();
    await screen.findByText("users");
    const user = userEvent.setup();
    await user.click(screen.getAllByRole("button", { name: ko.dataset.previewToggle })[0]);
    await screen.findByRole("region", { name: ko.dataset.previewAria("users") });
    await user.click(screen.getAllByRole("button", { name: ko.dataset.previewToggle })[0]);
    expect(
      screen.queryByRole("region", { name: ko.dataset.previewAria("users") }),
    ).not.toBeInTheDocument();
  });

  it("접었다 다시 펼치면 offset이 리셋된다 (R4 리셋)", async () => {
    // 100행 데이터셋 — 다음 페이지로 간 뒤 접기→재펼침이 1페이지로 복귀해야 한다
    // (remount 리셋이 CSS-hide 등으로 바뀌는 드리프트를 잡는 회귀 가드)
    // 기본 페이지 크기 10(spec R2) — limit 쿼리를 그대로 반영해 실제 요청 보폭과 fixture가 어긋나지 않게 한다.
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/rows")) {
        const u = new URL(url, "http://localhost");
        const offset = Number(u.searchParams.get("offset") ?? "0");
        const limit = Number(u.searchParams.get("limit") ?? "10");
        const n = Math.max(Math.min(100 - offset, limit), 0);
        const rows = Array.from({ length: n }, (_, i) => ({ email: `u${offset + i}@ex.com` }));
        return Promise.resolve(jsonResponse({ rows, offset, total: 100 }));
      }
      return Promise.resolve(
        jsonResponse({
          datasets: [
            {
              id: "01A",
              name: "users",
              columns: ["email"],
              row_count: 100,
              byte_size: 10,
              created_at: 1,
            },
          ],
        }),
      );
    });
    renderPage();
    await screen.findByText("users");
    const user = userEvent.setup();
    const toggle = () => screen.getByRole("button", { name: ko.dataset.previewToggle });
    await user.click(toggle());
    const region = await screen.findByRole("region", { name: ko.dataset.previewAria("users") });
    await user.click(within(region).getByRole("button", { name: ko.dataset.nextPage }));
    expect(await screen.findByText(ko.dataset.rowsRange(11, 20, 100))).toBeInTheDocument();
    await user.click(toggle()); // 접기
    await user.click(toggle()); // 재펼침 → remount → offset 0
    expect(await screen.findByText(ko.dataset.rowsRange(1, 10, 100))).toBeInTheDocument();
  });
});
