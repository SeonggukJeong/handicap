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
