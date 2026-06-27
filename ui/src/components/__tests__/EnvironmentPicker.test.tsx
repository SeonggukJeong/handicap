import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { EnvironmentPicker } from "../EnvironmentPicker";
import type { EnvEntry } from "../../api/envOverlay";
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

// A tiny controlled host so we can drive the picker like RunDialog will.
function Host({
  baseVars,
  initialId = null,
  initialOverrides = [],
  showOverrides,
}: {
  baseVars: Record<string, string>;
  initialId?: string | null;
  initialOverrides?: EnvEntry[];
  showOverrides?: boolean;
}) {
  const [selectedEnvId, setSelectedEnvId] = useState<string | null>(initialId);
  const [overrides, setOverrides] = useState<EnvEntry[]>(initialOverrides);
  return (
    <EnvironmentPicker
      selectedEnvId={selectedEnvId}
      onSelect={setSelectedEnvId}
      baseVars={baseVars}
      overrides={overrides}
      onOverridesChange={setOverrides}
      showOverrides={showOverrides}
    />
  );
}
function renderPicker(props: {
  baseVars: Record<string, string>;
  initialId?: string | null;
  initialOverrides?: EnvEntry[];
  showOverrides?: boolean;
}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Host {...props} />
    </QueryClientProvider>,
  );
}
function region() {
  return screen.getByRole("region", { name: /환경 변수/i });
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
    await user.click(screen.getByRole("button", { name: /재정의/i }));
    expect(await screen.findByLabelText("환경 변수 키 0")).toHaveValue("BASE_URL");
    expect(screen.getByLabelText("환경 변수 값 0")).toHaveValue("http://s");
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
    await user.click(screen.getByRole("button", { name: /재정의/i }));
    // base row now labelled 재정의됨; override row labelled "BASE_URL 재정의"
    // Both strings come from the ko catalog (envOverriddenLabel / envShadowsBase)
    await waitFor(() =>
      expect(screen.getByText(ko.runDialog.envOverriddenLabel)).toBeInTheDocument(),
    );
    expect(screen.getByText(ko.runDialog.envShadowsBase("BASE_URL"))).toBeInTheDocument();
  });

  it("adds an arbitrary override via the add row", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ environments: [] }));
    const user = userEvent.setup();
    renderPicker({ baseVars: {} });
    await user.type(within(region()).getByPlaceholderText("BASE_URL"), "EXTRA");
    await user.click(within(region()).getByRole("button", { name: /^추가$/i }));
    expect(await screen.findByLabelText("환경 변수 키 0")).toHaveValue("EXTRA");
  });

  it("showOverrides=false hides override editor and shows applied hint", () => {
    fetchMock.mockResolvedValue(jsonResponse({ environments: [] }));
    renderPicker({
      baseVars: {},
      initialOverrides: [{ key: "BASE_URL", value: "x" }],
      showOverrides: false,
    });
    expect(screen.getByText("변수 1개 적용됨 (상세에서 편집)")).toBeInTheDocument();
    expect(screen.queryByLabelText("환경 변수 값 0")).not.toBeInTheDocument();
    expect(screen.getByRole("combobox")).toBeInTheDocument();
  });

  it("default (showOverrides absent) shows override editor (byte-identical)", () => {
    fetchMock.mockResolvedValue(jsonResponse({ environments: [] }));
    renderPicker({ baseVars: {}, initialOverrides: [{ key: "BASE_URL", value: "x" }] });
    expect(screen.getByDisplayValue("BASE_URL")).toBeInTheDocument();
  });
});
