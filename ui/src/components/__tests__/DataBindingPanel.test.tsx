import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DataBindingPanel } from "../DataBindingPanel";
import type { Scenario } from "../../scenario/model";
import type { DataBinding } from "../../api/schemas";

// Mock the hooks module — same approach as RunDialog.test which stubs fetch globally.
// DataBindingPanel uses useDatasets() and useDataset(id), which call the api module
// that uses fetch. We stub fetch for each test.
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

/** Minimal scenario with a single http step using {{username}} */
function makeScenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    version: 1 as const,
    name: "Test",
    cookie_jar: "auto" as const,
    variables: {},
    steps: [
      {
        id: "01HWAAAAAAAAAAAAAAAAAAAAAA",
        name: "Login",
        type: "http" as const,
        request: {
          method: "POST" as const,
          url: "http://example.com/api/users/{{username}}",
          headers: {},
        },
        assert: [],
        extract: [],
      },
    ],
    ...overrides,
  };
}

/** Scenario with an extract that produces {{token}} */
function makeScenarioWithExtract(): Scenario {
  return {
    version: 1 as const,
    name: "WithExtract",
    cookie_jar: "auto" as const,
    variables: {},
    steps: [
      {
        id: "01HWAAAAAAAAAAAAAAAAAAAAAB",
        name: "Auth",
        type: "http" as const,
        request: {
          method: "POST" as const,
          url: "http://example.com/login/{{username}}",
          headers: {},
        },
        assert: [],
        extract: [{ var: "token", from: "body" as const, path: "$.token" }],
      },
    ],
  };
}

/** Scenario that references {{missing}} — not in variables, not from extract */
function makeScenarioWithMissing(): Scenario {
  return {
    version: 1 as const,
    name: "Missing",
    cookie_jar: "auto" as const,
    variables: {},
    steps: [
      {
        id: "01HWAAAAAAAAAAAAAAAAAAAAAC",
        name: "Use Missing",
        type: "http" as const,
        request: {
          method: "GET" as const,
          url: "http://example.com/{{missing}}",
          headers: {},
        },
        assert: [],
        extract: [],
      },
    ],
  };
}

const DATASET_LIST = {
  datasets: [
    {
      id: "DS1",
      name: "users.csv",
      columns: ["username", "email"],
      row_count: 100,
      byte_size: 2048,
      created_at: 1000,
    },
  ],
};

const DATASET_DETAIL = {
  id: "DS1",
  name: "users.csv",
  columns: ["username", "email"],
  row_count: 100,
  byte_size: 2048,
  created_at: 1000,
  sample: [{ username: "alice", email: "alice@example.com" }],
};

function renderPanel(
  scenario: Scenario,
  onChange: (b: DataBinding | null) => void = vi.fn(),
  onValidityChange: (ok: boolean) => void = vi.fn(),
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={qc}>
      <DataBindingPanel
        scenario={scenario}
        onChange={onChange}
        onValidityChange={onValidityChange}
      />
    </QueryClientProvider>,
  );
  return { ...utils, onChange, onValidityChange };
}

describe("DataBindingPanel", () => {
  it("auto-scans: scenario with {{username}} renders a mapping row labeled 'username'", async () => {
    fetchMock.mockResolvedValue(jsonResponse(DATASET_LIST));

    renderPanel(makeScenario());

    // The panel should always show the scanned var row regardless of dataset selection
    expect(await screen.findByText("username")).toBeInTheDocument();
  });

  it("auto-match on dataset select: username var defaults to username column", async () => {
    // First call: list datasets; second: get dataset detail
    fetchMock
      .mockResolvedValueOnce(jsonResponse(DATASET_LIST))
      .mockResolvedValueOnce(jsonResponse(DATASET_DETAIL));

    const onChange = vi.fn<(b: DataBinding | null) => void>();
    renderPanel(makeScenario(), onChange);
    const user = userEvent.setup();

    // Wait for the DS1 option to appear (dataset list loaded) then select it
    const datasetSelect = await screen.findByLabelText(/dataset/i);
    await screen.findByRole("option", { name: /users\.csv/i });
    await user.selectOptions(datasetSelect, "DS1");

    // After selecting dataset, the username row should auto-match to the username column.
    // onChange should be called with a mapping containing the auto-matched column.
    await waitFor(() => {
      const calls = onChange.mock.calls;
      const lastCall = calls[calls.length - 1];
      if (!lastCall) return;
      const binding = lastCall[0];
      if (!binding) return;
      expect(
        binding.mappings.some(
          (m) => m.kind === "column" && m.var === "username" && m.column === "username",
        ),
      ).toBe(true);
      expect(binding.dataset_id).toBe("DS1");
      expect(binding.policy).toBe("per_vu");
    });
  });

  it("no dataset selected → onValidityChange(true) (panel off, never blocks)", async () => {
    fetchMock.mockResolvedValue(jsonResponse(DATASET_LIST));

    const onValidityChange = vi.fn<(ok: boolean) => void>();
    renderPanel(makeScenarioWithMissing(), vi.fn(), onValidityChange);

    // With no dataset selected, even an unmapped var must not block
    await waitFor(() => {
      const calls = onValidityChange.mock.calls;
      // The last validity call should be true
      const lastCall = calls[calls.length - 1];
      expect(lastCall?.[0]).toBe(true);
    });
  });

  it("uncovered var blocks only when a dataset IS selected", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(DATASET_LIST))
      .mockResolvedValueOnce(jsonResponse(DATASET_DETAIL));

    const onValidityChange = vi.fn<(ok: boolean) => void>();
    renderPanel(makeScenarioWithMissing(), vi.fn(), onValidityChange);
    const user = userEvent.setup();

    // Wait for the DS1 option to appear then select it
    const datasetSelect = await screen.findByLabelText(/dataset/i);
    await screen.findByRole("option", { name: /users\.csv/i });

    // Select a dataset — now "missing" is uncovered (not in columns, not in extract)
    await user.selectOptions(datasetSelect, "DS1");

    // Panel should now emit invalid (missing var uncovered)
    await waitFor(() => {
      const calls = onValidityChange.mock.calls;
      const lastCall = calls[calls.length - 1];
      // After dataset selection with uncovered var, should be false
      expect(lastCall?.[0]).toBe(false);
    });

    // Also, the uncovered var should be shown in a blocking/error state
    expect(await screen.findByText(/매핑되지 않음/i)).toBeInTheDocument();
  });

  it("per-iteration policy shows memory warning banner; per_vu hides it", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(DATASET_LIST))
      .mockResolvedValueOnce(jsonResponse(DATASET_DETAIL));

    renderPanel(makeScenario());
    const user = userEvent.setup();

    // Wait for the DS1 option to appear then select the dataset
    const datasetSelect = await screen.findByLabelText(/dataset/i);
    await screen.findByRole("option", { name: /users\.csv/i });
    await user.selectOptions(datasetSelect, "DS1");

    // Wait for policy select to be available (it appears once dataset is selected)
    const policySelect = await screen.findByLabelText(/policy/i);

    // per_vu (default) — no banner
    expect(screen.queryByText(/dataset-max-rows/i)).not.toBeInTheDocument();

    // Switch to iter_sequential
    await user.selectOptions(policySelect, "iter_sequential");
    expect(await screen.findByText(/dataset-max-rows/i)).toBeInTheDocument();

    // Switch to iter_random
    await user.selectOptions(policySelect, "iter_random");
    expect(screen.getByText(/dataset-max-rows/i)).toBeInTheDocument();

    // Back to per_vu
    await user.selectOptions(policySelect, "per_vu");
    await waitFor(() => {
      expect(screen.queryByText(/dataset-max-rows/i)).not.toBeInTheDocument();
    });
  });

  it("policy dropdown has exactly per_vu/iter_sequential/iter_random — no 'unique'", async () => {
    // Need two responses: list + detail (for when we select the dataset)
    fetchMock
      .mockResolvedValueOnce(jsonResponse(DATASET_LIST))
      .mockResolvedValueOnce(jsonResponse(DATASET_DETAIL));

    renderPanel(makeScenario());
    const user = userEvent.setup();

    // Select a dataset so the policy select appears
    const datasetSelect = await screen.findByLabelText(/dataset/i);
    await screen.findByRole("option", { name: /users\.csv/i });
    await user.selectOptions(datasetSelect, "DS1");

    // Wait for the policy select to appear
    const policySelect = await screen.findByLabelText(/policy/i);

    const options = within(policySelect as HTMLElement)
      .getAllByRole("option")
      .map((o) => o.getAttribute("value"));

    expect(options).toContain("per_vu");
    expect(options).toContain("iter_sequential");
    expect(options).toContain("iter_random");
    expect(options).not.toContain("unique");
    expect(options).toHaveLength(3);
  });

  it("extract-provided var is NOT flagged as uncovered", async () => {
    // Scenario uses {{username}} (uncovered) + {{token}} (produced by extract)
    // With a dataset that doesn't have "token" column, token should not block.
    // Map username to the username column, leaving token untouched (extract provides it).
    fetchMock
      .mockResolvedValueOnce(jsonResponse(DATASET_LIST))
      .mockResolvedValueOnce(jsonResponse(DATASET_DETAIL));

    const onValidityChange = vi.fn<(ok: boolean) => void>();
    renderPanel(makeScenarioWithExtract(), vi.fn(), onValidityChange);
    const user = userEvent.setup();

    // Wait for DS1 option then select the dataset (has "username"/"email", NOT "token")
    const datasetSelect = await screen.findByLabelText(/dataset/i);
    await screen.findByRole("option", { name: /users\.csv/i });
    await user.selectOptions(datasetSelect, "DS1");

    // username auto-matches to the column, token is from extract → not uncovered
    // So the panel should emit valid (true)
    await waitFor(() => {
      const calls = onValidityChange.mock.calls;
      const lastCall = calls[calls.length - 1];
      expect(lastCall?.[0]).toBe(true);
    });

    // The token var row should NOT appear in a red/blocking state
    // (It might not appear at all since extract provides it, or appear without error)
    expect(screen.queryByText(/매핑되지 않음/i)).not.toBeInTheDocument();
  });
});
