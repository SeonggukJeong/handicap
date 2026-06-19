import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { EnvironmentsPage } from "../EnvironmentsPage";
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
        <EnvironmentsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("EnvironmentsPage", () => {
  it("lists environments with their var counts", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        environments: [{ id: "E1", name: "staging", var_count: 2, created_at: 1, updated_at: 1 }],
      }),
    );
    renderPage();
    expect(await screen.findByText("staging")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("shows empty state", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ environments: [] }));
    renderPage();
    expect(await screen.findByText(ko.empty.environments)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: `${ko.empty.environmentsCta} →` }),
    ).toBeInTheDocument();
  });

  it("creates an environment", async () => {
    let posted: unknown = null;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (
        String(url).endsWith("/api/environments") &&
        (!init || init.method === "GET" || !init.method)
      ) {
        return Promise.resolve(jsonResponse({ environments: [] }));
      }
      if (String(url).endsWith("/api/environments") && init?.method === "POST") {
        posted = JSON.parse(String(init.body));
        return Promise.resolve(
          jsonResponse(
            {
              id: "E9",
              name: "prod",
              vars: { BASE_URL: "http://p" },
              created_at: 1,
              updated_at: 1,
            },
            201,
          ),
        );
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(ko.empty.environments);

    await user.click(screen.getByRole("button", { name: ko.pages.newEnvironment }));
    await user.type(screen.getByLabelText(/환경 이름/i), "prod");
    await user.type(screen.getByPlaceholderText("BASE_URL"), "BASE_URL");
    await user.type(screen.getByPlaceholderText(/값/i), "http://p");
    await user.click(screen.getByRole("button", { name: /^추가$/i }));
    await user.click(screen.getByRole("button", { name: /^저장$/i }));

    await waitFor(() => expect(posted).toEqual({ name: "prod", vars: { BASE_URL: "http://p" } }));
  });

  it("deletes an environment after confirm", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          environments: [{ id: "E1", name: "staging", var_count: 0, created_at: 1, updated_at: 1 }],
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 })) // delete
      .mockResolvedValueOnce(jsonResponse({ environments: [] })); // refetch
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("staging");
    await user.click(screen.getByRole("button", { name: /삭제/i }));
    await waitFor(() => expect(screen.getByText(ko.empty.environments)).toBeInTheDocument());
    confirmSpy.mockRestore();
  });
});
