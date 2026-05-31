import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { DatasetsPage } from "../DatasetsPage";

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
    expect(await screen.findByText(/No datasets yet/i)).toBeInTheDocument();
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
    await user.click(screen.getByRole("button", { name: /delete/i }));
    await waitFor(() => expect(screen.getByText(/No datasets yet/i)).toBeInTheDocument());
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
    await user.click(await screen.findByRole("button", { name: /delete/i }));
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
    await user.click(await screen.findByRole("button", { name: /delete/i }));
    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    expect(confirmSpy.mock.calls[0][0]).toMatch(/heavy/);
    await waitFor(() => expect(deleteCalls).toBe(2));
    confirmSpy.mockRestore();
  });
});
