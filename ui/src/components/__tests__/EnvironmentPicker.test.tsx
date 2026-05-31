import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { EnvironmentPicker } from "../EnvironmentPicker";
import type { EnvEntry } from "../../api/envOverlay";

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

// A tiny controlled host so we can drive the picker like RunDialog will.
function Host({
  baseVars,
  initialId = null,
}: {
  baseVars: Record<string, string>;
  initialId?: string | null;
}) {
  const [selectedEnvId, setSelectedEnvId] = useState<string | null>(initialId);
  const [overrides, setOverrides] = useState<EnvEntry[]>([]);
  return (
    <EnvironmentPicker
      selectedEnvId={selectedEnvId}
      onSelect={setSelectedEnvId}
      baseVars={baseVars}
      overrides={overrides}
      onOverridesChange={setOverrides}
    />
  );
}
function renderPicker(props: { baseVars: Record<string, string>; initialId?: string | null }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Host {...props} />
    </QueryClientProvider>,
  );
}
function region() {
  return screen.getByRole("region", { name: /Environment variables/i });
}

describe("EnvironmentPicker", () => {
  it("lists environments in the dropdown", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        environments: [{ id: "E1", name: "staging", var_count: 1, created_at: 1, updated_at: 1 }],
      }),
    );
    renderPicker({ baseVars: {} });
    expect(await screen.findByRole("option", { name: "staging" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "(없음)" })).toBeInTheDocument();
  });

  it("shows the selected env's vars as a read-only base list with override buttons", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        environments: [{ id: "E1", name: "staging", var_count: 1, created_at: 1, updated_at: 1 }],
      }),
    );
    const user = userEvent.setup();
    renderPicker({ baseVars: { BASE_URL: "http://s" }, initialId: "E1" });
    expect(await screen.findByText("BASE_URL")).toBeInTheDocument();
    expect(screen.getByText("http://s")).toBeInTheDocument();
    // clicking "override" seeds an editable override row pre-filled with the base value
    await user.click(screen.getByRole("button", { name: /override/i }));
    expect(await screen.findByLabelText("env key 0")).toHaveValue("BASE_URL");
    expect(screen.getByLabelText("env value 0")).toHaveValue("http://s");
  });

  it("marks a base key as overridden when an override row shadows it", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        environments: [{ id: "E1", name: "staging", var_count: 1, created_at: 1, updated_at: 1 }],
      }),
    );
    const user = userEvent.setup();
    renderPicker({ baseVars: { BASE_URL: "http://s" }, initialId: "E1" });
    await screen.findByText("BASE_URL");
    await user.click(screen.getByRole("button", { name: /override/i }));
    // base row now labelled 재정의됨; override row labelled "BASE_URL 재정의"
    await waitFor(() => expect(screen.getByText(/재정의됨/)).toBeInTheDocument());
    expect(screen.getByText(/BASE_URL 재정의/)).toBeInTheDocument();
  });

  it("adds an arbitrary override via the add row", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ environments: [] }));
    const user = userEvent.setup();
    renderPicker({ baseVars: {} });
    await user.type(within(region()).getByPlaceholderText("BASE_URL"), "EXTRA");
    await user.click(within(region()).getByRole("button", { name: /^add$/i }));
    expect(await screen.findByLabelText("env key 0")).toHaveValue("EXTRA");
  });
});
