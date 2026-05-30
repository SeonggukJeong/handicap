import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UploadPanel } from "../UploadPanel";

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
function renderPanel() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <UploadPanel />
    </QueryClientProvider>,
  );
}

describe("UploadPanel", () => {
  it("previews a chosen file (columns + sample)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        columns: ["email", "pw"],
        row_count: 2,
        sample: [{ email: "a@ex.com", pw: "p1" }],
      }),
    );
    const user = userEvent.setup();
    renderPanel();
    const file = new File(["email,pw\na@ex.com,p1\n"], "users.csv", { type: "text/csv" });
    await user.upload(screen.getByLabelText(/choose file/i), file);

    expect(await screen.findByText("email")).toBeInTheDocument();
    expect(screen.getByText("a@ex.com")).toBeInTheDocument();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/datasets/preview");
  });

  it("saves after preview", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ columns: ["a"], row_count: 1, sample: [{ a: "x" }] })) // preview
      .mockResolvedValueOnce(
        jsonResponse({
          id: "01J",
          name: "users",
          columns: ["a"],
          row_count: 1,
          byte_size: 5,
          created_at: 1,
          sample: [{ a: "x" }],
        }),
      ); // save
    const user = userEvent.setup();
    renderPanel();
    await user.upload(
      screen.getByLabelText(/choose file/i),
      new File(["a\nx\n"], "users.csv", { type: "text/csv" }),
    );
    await screen.findByText("a");
    await user.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(fetchMock.mock.calls[1][0]).toBe("/api/datasets"));
  });

  it("re-previews when delimiter override changes", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ columns: ["a;b"], row_count: 1, sample: [{ "a;b": "1;2" }] }),
      ) // 쉼표로 오파싱
      .mockResolvedValueOnce(
        jsonResponse({ columns: ["a", "b"], row_count: 1, sample: [{ a: "1", b: "2" }] }),
      ); // 세미콜론 재파싱
    const user = userEvent.setup();
    renderPanel();
    await user.upload(
      screen.getByLabelText(/choose file/i),
      new File(["a;b\n1;2\n"], "x.csv", { type: "text/csv" }),
    );
    await screen.findByText("a;b");
    await user.selectOptions(screen.getByLabelText(/delimiter/i), ";");
    await waitFor(() => expect(screen.getByText("a")).toBeInTheDocument());
    expect(fetchMock.mock.calls[1][0]).toBe("/api/datasets/preview");
  });
});
