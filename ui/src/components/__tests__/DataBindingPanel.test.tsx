import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DataBindingPanel } from "../DataBindingPanel";
import type { Scenario } from "../../scenario/model";
import type { DataBinding } from "../../api/schemas";
import { ko } from "../../i18n/ko";

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

// The panel now emits a DataBinding[] (multi-binding). Most legacy tests assert on
// a SINGLE binding, so renderPanel adapts the array callback to the first binding
// (or null when empty), preserving the original single-binding assertions.
function renderPanel(
  scenario: Scenario,
  onChange: (b: DataBinding | null) => void = vi.fn(),
  onValidityChange: (ok: boolean, reasons?: string[]) => void = vi.fn(),
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const arrayOnChange = (bindings: DataBinding[]) => onChange(bindings[0] ?? null);
  const utils = render(
    <QueryClientProvider client={qc}>
      <DataBindingPanel
        scenario={scenario}
        onChange={arrayOnChange}
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
    const datasetSelect = await screen.findByLabelText(/데이터셋/i);
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

    const onValidityChange = vi.fn<(ok: boolean, reasons?: string[]) => void>();
    renderPanel(makeScenarioWithMissing(), vi.fn(), onValidityChange);

    // With no dataset selected, even an unmapped var must not block
    await waitFor(() => {
      const calls = onValidityChange.mock.calls;
      // The last validity call should be true
      const lastCall = calls[calls.length - 1];
      expect(lastCall?.[0]).toBe(true);
      expect(lastCall?.[1]).toEqual([]);
    });
  });

  it("uncovered var blocks only when a dataset IS selected", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(DATASET_LIST))
      .mockResolvedValueOnce(jsonResponse(DATASET_DETAIL));

    const onValidityChange = vi.fn<(ok: boolean, reasons?: string[]) => void>();
    renderPanel(makeScenarioWithMissing(), vi.fn(), onValidityChange);
    const user = userEvent.setup();

    // Wait for the DS1 option to appear then select it
    const datasetSelect = await screen.findByLabelText(/데이터셋/i);
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
    const datasetSelect = await screen.findByLabelText(/데이터셋/i);
    await screen.findByRole("option", { name: /users\.csv/i });
    await user.selectOptions(datasetSelect, "DS1");

    // Wait for policy select to be available (it appears once dataset is selected)
    const policySelect = await screen.findByLabelText(/정책/i);

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

  it("policy dropdown offers per_vu/iter_sequential/iter_random/unique", async () => {
    // Need two responses: list + detail (for when we select the dataset)
    fetchMock
      .mockResolvedValueOnce(jsonResponse(DATASET_LIST))
      .mockResolvedValueOnce(jsonResponse(DATASET_DETAIL));

    renderPanel(makeScenario());
    const user = userEvent.setup();

    // Select a dataset so the policy select appears
    const datasetSelect = await screen.findByLabelText(/데이터셋/i);
    await screen.findByRole("option", { name: /users\.csv/i });
    await user.selectOptions(datasetSelect, "DS1");

    // Wait for the policy select to appear
    const policySelect = await screen.findByLabelText(/정책/i);

    const options = within(policySelect as HTMLElement)
      .getAllByRole("option")
      .map((o) => o.getAttribute("value"));

    expect(options).toContain("per_vu");
    expect(options).toContain("iter_sequential");
    expect(options).toContain("iter_random");
    expect(options).toContain("unique");
    expect(options).toHaveLength(4);
  });

  it("selects the unique policy and shows the stop-VU banner", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(DATASET_LIST))
      .mockResolvedValueOnce(jsonResponse(DATASET_DETAIL));

    const user = userEvent.setup();
    const onChange = vi.fn();
    renderPanel(makeScenario(), onChange);
    const datasetSelect = await screen.findByLabelText(/데이터셋/i);
    await screen.findByRole("option", { name: /users\.csv/i });
    await user.selectOptions(datasetSelect, "DS1");
    const policySelect = await screen.findByLabelText(/정책/i);
    await user.selectOptions(policySelect, "unique");
    expect(policySelect).toHaveValue("unique");
    expect(screen.getByText(/소진된 VU/)).toBeInTheDocument();
  });

  it("extract-provided var is NOT flagged as uncovered", async () => {
    // Scenario uses {{username}} (uncovered) + {{token}} (produced by extract)
    // With a dataset that doesn't have "token" column, token should not block.
    // Map username to the username column, leaving token untouched (extract provides it).
    fetchMock
      .mockResolvedValueOnce(jsonResponse(DATASET_LIST))
      .mockResolvedValueOnce(jsonResponse(DATASET_DETAIL));

    const onValidityChange = vi.fn<(ok: boolean, reasons?: string[]) => void>();
    renderPanel(makeScenarioWithExtract(), vi.fn(), onValidityChange);
    const user = userEvent.setup();

    // Wait for DS1 option then select the dataset (has "username"/"email", NOT "token")
    const datasetSelect = await screen.findByLabelText(/데이터셋/i);
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

  it("미커버 변수가 있으면 reasons에 변수명 사유가 들어간다", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(DATASET_LIST))
      .mockResolvedValueOnce(jsonResponse(DATASET_DETAIL));

    const onValidityChange = vi.fn<(ok: boolean, reasons?: string[]) => void>();
    renderPanel(makeScenarioWithMissing(), vi.fn(), onValidityChange);
    const user = userEvent.setup();

    const datasetSelect = await screen.findByLabelText(/데이터셋/i);
    await screen.findByRole("option", { name: /users\.csv/i });
    await user.selectOptions(datasetSelect, "DS1");

    await waitFor(() => {
      const calls = onValidityChange.mock.calls;
      const last = calls[calls.length - 1];
      expect(last[0]).toBe(false);
      expect((last[1] as string[]).join(" ")).toContain("missing");
    });
  });

  it("자동 매칭된 행에 '자동 연결됨' 배지가 보인다", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(DATASET_LIST))
      .mockResolvedValueOnce(jsonResponse(DATASET_DETAIL));

    renderPanel(makeScenario());
    const user = userEvent.setup();

    const datasetSelect = await screen.findByLabelText(/데이터셋/i);
    await screen.findByRole("option", { name: /users\.csv/i });
    await user.selectOptions(datasetSelect, "DS1");

    expect(await screen.findByText(/자동 연결됨/)).toBeInTheDocument();
  });

  it("자동 매칭 행의 컬럼을 사용자가 바꾸면 '자동 연결됨' 배지가 사라진다", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(DATASET_LIST))
      .mockResolvedValueOnce(jsonResponse(DATASET_DETAIL));

    renderPanel(makeScenario());
    const user = userEvent.setup();

    // 데이터셋 선택 → 자동 매칭 → 배지 확인
    const datasetSelect = await screen.findByLabelText(/데이터셋/i);
    await screen.findByRole("option", { name: /users\.csv/i });
    await user.selectOptions(datasetSelect, "DS1");
    expect(await screen.findByText(/자동 연결됨/)).toBeInTheDocument();

    // 사용자가 source select에서 다른 컬럼(email)으로 변경
    const sourceSelect = screen.getByLabelText("username 소스");
    await user.selectOptions(sourceSelect, "email");

    // 배지가 사라져야 함
    expect(screen.queryByText(/자동 연결됨/)).toBeNull();
  });
});

describe("DataBindingPanel — initialBinding re-hydration (A1)", () => {
  function mockDatasets() {
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith("/api/datasets")) {
        return Promise.resolve(
          jsonResponse({
            datasets: [
              {
                id: "D1",
                name: "users",
                columns: ["user"],
                row_count: 3,
                byte_size: 10,
                created_at: 1,
              },
            ],
          }),
        );
      }
      if (url.endsWith("/api/datasets/D1")) {
        return Promise.resolve(
          jsonResponse({
            id: "D1",
            name: "users",
            columns: ["user"],
            row_count: 3,
            byte_size: 10,
            created_at: 1,
            sample: [{ user: "alice" }],
          }),
        );
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
  }

  function renderPanelWithBinding(initialBinding: DataBinding | null) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <DataBindingPanel
          scenario={makeScenario()}
          initialBindings={initialBinding ? [initialBinding] : []}
          onChange={() => {}}
          onValidityChange={() => {}}
        />
      </QueryClientProvider>,
    );
  }

  it("preselects the dataset, policy, and column mapping from initialBinding", async () => {
    mockDatasets();
    renderPanelWithBinding({
      dataset_id: "D1",
      policy: "iter_random",
      mappings: [{ kind: "column", var: "username", column: "user" }],
    });

    // The dataset <option> list loads async via useDatasets(); a controlled
    // <select value="D1"> shows "" until its matching option exists, so wait.
    await waitFor(() => expect(screen.getByLabelText("데이터셋")).toHaveValue("D1"));
    await waitFor(() => expect(screen.getByLabelText("정책")).toHaveValue("iter_random"));
    await waitFor(() => expect(screen.getByLabelText("username 소스")).toHaveValue("user"));
  });

  it("seeds a literal mapping for a var that is not a scanned column", async () => {
    mockDatasets();
    renderPanelWithBinding({
      dataset_id: "D1",
      policy: "per_vu",
      mappings: [{ kind: "literal", var: "username", value: "fixed" }],
    });
    await waitFor(() => expect(screen.getByLabelText("username 리터럴 값")).toHaveValue("fixed"));
  });

  it("does not duplicate a manual row seeded for an unscanned mapping var", async () => {
    mockDatasets();
    // `extra` is NOT referenced by makeScenario()'s {{username}} — it becomes a
    // manual row. The existing merge effect must not re-append it on mount.
    renderPanelWithBinding({
      dataset_id: "D1",
      policy: "per_vu",
      mappings: [{ kind: "literal", var: "extra", value: "v" }],
    });
    await waitFor(() => expect(screen.getAllByLabelText("매핑 변수명")).toHaveLength(1));
    expect(screen.getByLabelText("매핑 변수명")).toHaveValue("extra");
  });

  it("highlights a stale column mapping whose column is gone from the dataset (spec §6)", async () => {
    mockDatasets();
    renderPanelWithBinding({
      dataset_id: "D1",
      policy: "per_vu",
      mappings: [{ kind: "column", var: "username", column: "gone" }],
    });
    expect(await screen.findByText(/선택한 컬럼이 현재 데이터셋에 없음/)).toBeInTheDocument();
  });

  it("emits the seeded binding to onChange after mount", async () => {
    mockDatasets();
    const onChange = vi.fn<(b: DataBinding[]) => void>();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <DataBindingPanel
          scenario={makeScenario()}
          initialBindings={[
            {
              dataset_id: "D1",
              policy: "iter_random",
              mappings: [{ kind: "column", var: "username", column: "user" }],
            },
          ]}
          onChange={onChange}
          onValidityChange={() => {}}
        />
      </QueryClientProvider>,
    );
    await waitFor(() => {
      const last = onChange.mock.lastCall?.[0]?.[0];
      expect(last?.dataset_id).toBe("D1");
      expect(last?.policy).toBe("iter_random");
      expect(last?.mappings).toContainEqual({ kind: "column", var: "username", column: "user" });
    });
  });
});

describe("DataBindingPanel — deleted dataset notice (A2)", () => {
  function renderPanel() {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).endsWith("/api/datasets")) {
        return Promise.resolve(jsonResponse({ datasets: [] }));
      }
      if (String(url).endsWith("/api/datasets/D1")) {
        return Promise.resolve(jsonResponse({ error: "not found" }, 404));
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const onValidity = vi.fn();
    render(
      <QueryClientProvider client={qc}>
        <DataBindingPanel
          scenario={makeScenario()}
          initialBindings={[{ dataset_id: "D1", policy: "per_vu", mappings: [] }]}
          onChange={() => {}}
          onValidityChange={onValidity}
        />
      </QueryClientProvider>,
    );
    return { onValidity };
  }

  it("shows a notice and goes invalid when the selected dataset is gone", async () => {
    const { onValidity } = renderPanel();
    expect(await screen.findByText(/데이터셋이 삭제/)).toBeInTheDocument();
    await waitFor(() => expect(onValidity).toHaveBeenCalledWith(false, expect.any(Array)));
  });
});

// ── Multi-dataset binding (list editor) ────────────────────────────────────
const TWO_DATASETS = {
  datasets: [
    {
      id: "DS1",
      name: "users.csv",
      columns: ["username", "email"],
      row_count: 100,
      byte_size: 2048,
      created_at: 1000,
    },
    {
      id: "DS2",
      name: "extra.csv",
      columns: ["username", "extra"],
      row_count: 7,
      byte_size: 64,
      created_at: 2000,
    },
  ],
};

const DS2_DETAIL = {
  id: "DS2",
  name: "extra.csv",
  columns: ["username", "extra"],
  row_count: 7,
  byte_size: 64,
  created_at: 2000,
  sample: [{ username: "bob", extra: "x" }],
};

/** Scenario referencing TWO vars ({{username}} + {{extra}}) split across datasets. */
function makeScenarioTwoVars(): Scenario {
  return {
    version: 1 as const,
    name: "TwoVars",
    cookie_jar: "auto" as const,
    variables: {},
    steps: [
      {
        id: "01HWAAAAAAAAAAAAAAAAAAAAAD",
        name: "Use both",
        type: "http" as const,
        request: {
          method: "GET" as const,
          url: "http://example.com/{{username}}/{{extra}}",
          headers: {},
        },
        assert: [],
        extract: [],
      },
    ],
  };
}

describe("DataBindingPanel — multi-binding list editor", () => {
  function mockTwoDatasets() {
    fetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u.endsWith("/api/datasets")) return Promise.resolve(jsonResponse(TWO_DATASETS));
      if (u.endsWith("/api/datasets/DS1")) return Promise.resolve(jsonResponse(DATASET_DETAIL));
      if (u.endsWith("/api/datasets/DS2")) return Promise.resolve(jsonResponse(DS2_DETAIL));
      return Promise.resolve(jsonResponse({}, 404));
    });
  }

  function renderMulti(
    initialBindings: DataBinding[] = [],
    onChange: (b: DataBinding[]) => void = vi.fn(),
    onValidityChange: (ok: boolean, reasons: string[]) => void = vi.fn(),
    scenario: Scenario = makeScenario(),
  ) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const utils = render(
      <QueryClientProvider client={qc}>
        <DataBindingPanel
          scenario={scenario}
          initialBindings={initialBindings}
          onChange={onChange}
          onValidityChange={onValidityChange}
        />
      </QueryClientProvider>,
    );
    return { ...utils, onChange, onValidityChange };
  }

  it("카드 제거 후 포커스가 '데이터셋 추가' 버튼으로 이동한다 (a11y Fix 3)", async () => {
    mockTwoDatasets();
    const user = userEvent.setup();
    renderMulti();
    await screen.findByRole("option", { name: /users\.csv/i });
    // Add a second card so the remove button is visible.
    const addBtn = screen.getByRole("button", { name: /데이터셋 추가/ });
    await user.click(addBtn);
    await waitFor(() => expect(screen.getAllByLabelText(/데이터셋/i)).toHaveLength(2));

    // Remove the first card — focus should move to the add button.
    const removeButtons = screen.getAllByRole("button", { name: /바인딩 \d+ 제거/ });
    await user.click(removeButtons[0]);
    await waitFor(() => expect(screen.getAllByLabelText(/데이터셋/i)).toHaveLength(1));

    // jsdom focus behavior is generally reliable for programmatic focus() calls.
    const addBtnAfter = screen.getByRole("button", { name: /데이터셋 추가/ });
    expect(addBtnAfter).toHaveFocus();
  });

  it("adds a second binding card via '데이터셋 추가'", async () => {
    mockTwoDatasets();
    const user = userEvent.setup();
    renderMulti();
    // One card by default → one dataset select.
    expect(await screen.findByRole("option", { name: /users\.csv/i })).toBeInTheDocument();
    expect(screen.getAllByLabelText(/데이터셋/i)).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: /데이터셋 추가/ }));
    await waitFor(() => expect(screen.getAllByLabelText(/데이터셋/i)).toHaveLength(2));
  });

  it("removes a binding card", async () => {
    mockTwoDatasets();
    const user = userEvent.setup();
    renderMulti();
    await screen.findByRole("option", { name: /users\.csv/i });
    await user.click(screen.getByRole("button", { name: /데이터셋 추가/ }));
    await waitFor(() => expect(screen.getAllByLabelText(/데이터셋/i)).toHaveLength(2));

    // Remove the second card. Label is now noun-first: "바인딩 N 제거" (Fix 2).
    const removeButtons = screen.getAllByRole("button", { name: /바인딩 \d+ 제거/ });
    await user.click(removeButtons[removeButtons.length - 1]);
    await waitFor(() => expect(screen.getAllByLabelText(/데이터셋/i)).toHaveLength(1));
  });

  it("emits a DataBinding[] with both selected bindings", async () => {
    mockTwoDatasets();
    const user = userEvent.setup();
    const onChange = vi.fn<(b: DataBinding[]) => void>();
    renderMulti([], onChange);

    await screen.findByRole("option", { name: /users\.csv/i });
    const firstSelect = screen.getAllByLabelText(/데이터셋/i)[0];
    await user.selectOptions(firstSelect, "DS1");

    await user.click(screen.getByRole("button", { name: /데이터셋 추가/ }));
    await waitFor(() => expect(screen.getAllByLabelText(/데이터셋/i)).toHaveLength(2));
    const secondSelect = screen.getAllByLabelText(/데이터셋/i)[1];
    await user.selectOptions(secondSelect, "DS2");

    await waitFor(() => {
      const last = onChange.mock.lastCall?.[0];
      expect(last).toHaveLength(2);
      expect(last?.map((b) => b.dataset_id).sort()).toEqual(["DS1", "DS2"]);
    });
  });

  it("flags a duplicate variable mapped across two bindings", async () => {
    mockTwoDatasets();
    const onValidityChange = vi.fn<(ok: boolean, reasons: string[]) => void>();
    // Both cards map {{username}} → duplicate var across bindings (client warning).
    renderMulti(
      [
        {
          dataset_id: "DS1",
          policy: "per_vu",
          mappings: [{ kind: "column", var: "username", column: "username" }],
        },
        {
          dataset_id: "DS2",
          policy: "per_vu",
          mappings: [{ kind: "column", var: "username", column: "username" }],
        },
      ],
      vi.fn(),
      onValidityChange,
    );

    await waitFor(() => {
      const last = onValidityChange.mock.lastCall;
      expect(last?.[0]).toBe(false);
      expect((last?.[1] as string[]).join(" ")).toContain("username");
    });
    expect(await screen.findByText(/여러 데이터셋/)).toBeInTheDocument();
  });

  it("shows the per-card row count (행) for a selected dataset", async () => {
    mockTwoDatasets();
    renderMulti([{ dataset_id: "DS2", policy: "per_vu", mappings: [] }]);
    // DS2 has 7 rows — surfaced inline on the card header summary (and the option list).
    await waitFor(() => expect(screen.getAllByText(/7행/).length).toBeGreaterThan(0));
    // The card header summary carries the per-card row count (exact, distinguishes it
    // from the option list "extra.csv (7행)").
    expect(await screen.findByText("extra.csv · 매핑 1개 · 7행")).toBeInTheDocument();
  });

  it("does NOT flag a var as uncovered when a sibling card supplies it (split datasets)", async () => {
    // Scenario uses {{username}} + {{extra}}. DSA covers ONLY username, DSB covers ONLY
    // extra (disjoint columns so neither card auto-maps the other's var → no dup). Card 1
    // (DSA) maps username, card 2 (DSB) maps extra. Neither card should flag the other's
    // var as uncovered — the split-across-datasets pattern is the whole point of multi-binding.
    fetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u.endsWith("/api/datasets")) {
        return Promise.resolve(
          jsonResponse({
            datasets: [
              {
                id: "DSA",
                name: "a.csv",
                columns: ["username"],
                row_count: 5,
                byte_size: 10,
                created_at: 1,
              },
              {
                id: "DSB",
                name: "b.csv",
                columns: ["extra"],
                row_count: 6,
                byte_size: 12,
                created_at: 2,
              },
            ],
          }),
        );
      }
      if (u.endsWith("/api/datasets/DSA")) {
        return Promise.resolve(
          jsonResponse({
            id: "DSA",
            name: "a.csv",
            columns: ["username"],
            row_count: 5,
            byte_size: 10,
            created_at: 1,
            sample: [{ username: "alice" }],
          }),
        );
      }
      if (u.endsWith("/api/datasets/DSB")) {
        return Promise.resolve(
          jsonResponse({
            id: "DSB",
            name: "b.csv",
            columns: ["extra"],
            row_count: 6,
            byte_size: 12,
            created_at: 2,
            sample: [{ extra: "x" }],
          }),
        );
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
    const onValidityChange = vi.fn<(ok: boolean, reasons: string[]) => void>();
    renderMulti(
      [
        {
          dataset_id: "DSA",
          policy: "per_vu",
          mappings: [{ kind: "column", var: "username", column: "username" }],
        },
        {
          dataset_id: "DSB",
          policy: "per_vu",
          mappings: [{ kind: "column", var: "extra", column: "extra" }],
        },
      ],
      vi.fn(),
      onValidityChange,
      makeScenarioTwoVars(),
    );

    await waitFor(() => {
      const last = onValidityChange.mock.lastCall;
      expect(last?.[0]).toBe(true);
      expect(last?.[1]).toEqual([]);
    });
    // No card shows the "uncovered" blocking hint.
    expect(screen.queryByText(/매핑되지 않음/)).not.toBeInTheDocument();
  });
});

// ── Branch variable grouping (binding-varname T3, US1/US4) ─────────────────

/** 스캔 순서가 [username, checkout_branch.session_token, checkout_branch.order_id, late_var]가
 *  되도록 parallel 노드를 가운데 두고 뒤 스텝이 late_var를 참조한다.
 *  → partition 순서(ungrouped 먼저)와 rows 순서가 달라져 idx/순서 회귀에 이빨이 생긴다. */
function makeScenarioWithParallel(): Scenario {
  return {
    version: 1 as const,
    name: "Parallel",
    cookie_jar: "auto" as const,
    variables: {},
    steps: [
      {
        id: "01HWAAAAAAAAAAAAAAAAAAAAAC",
        name: "Login",
        type: "http" as const,
        request: {
          method: "POST" as const,
          url: "http://example.com/login/{{username}}",
          headers: {},
        },
        assert: [],
        extract: [],
      },
      {
        id: "01HWAAAAAAAAAAAAAAAAAAAAAD",
        name: "Fanout",
        type: "parallel" as const,
        branches: [
          {
            name: "checkout_branch",
            steps: [
              {
                id: "01HWAAAAAAAAAAAAAAAAAAAAAE",
                name: "Session",
                type: "http" as const,
                request: { method: "GET" as const, url: "http://example.com/session", headers: {} },
                assert: [],
                extract: [
                  { var: "session_token", from: "body" as const, path: "$.token" },
                  { var: "order_id", from: "body" as const, path: "$.oid" },
                ],
              },
            ],
          },
        ],
      },
      {
        id: "01HWAAAAAAAAAAAAAAAAAAAAAF",
        name: "Use",
        type: "http" as const,
        request: {
          method: "GET" as const,
          url: "http://example.com/o/{{checkout_branch.session_token}}/{{checkout_branch.order_id}}/{{late_var}}",
          headers: {},
        },
        assert: [],
        extract: [],
      },
    ],
  };
}

/** 가시 텍스트를 DOM에서 뽑는다(공백 정규화) — 카피가 바뀌어도 살아남는 비교용. */
function visibleTextOf(el: Element): string {
  const clone = el.cloneNode(true) as Element;
  clone.querySelectorAll("[aria-hidden='true']").forEach((n) => n.remove());
  return (clone.textContent ?? "").replace(/\s+/g, " ").trim();
}

const GROUP_ARIA = `${ko.binding.branchGroupLead} checkout_branch ${ko.binding.branchGroupAriaTail}`;

describe("branch variable grouping", () => {
  // T5 (US1)
  it("shows branch vars by their bare name under one branch header", async () => {
    renderPanel(makeScenarioWithParallel());

    const groupList = await screen.findByRole("list", {
      name: `${ko.binding.branchGroupLead} checkout_branch ${ko.binding.branchGroupAriaTail}`,
    });
    const badges = within(groupList).getAllByTitle(/^checkout_branch\./);
    expect(badges).toHaveLength(2);
    expect(badges[0]).toHaveTextContent(/^session_token$/);
    expect(badges[1]).toHaveTextContent(/^order_id$/);
    // 접두사가 행에서 사라졌다 (헤더로 올라갔다)
    expect(badges[0].textContent).not.toContain("checkout_branch");
    // title은 전체 display를 유지한다 (복사·검색 가능성)
    expect(badges[0]).toHaveAttribute("title", "checkout_branch.session_token");
  });

  // T7 — aria ⊇ visible (조립형이라 구조적으로 참, 드리프트 가드)
  it("group list accessible name starts with the visible header text", async () => {
    renderPanel(makeScenarioWithParallel());
    const header = await screen.findByTestId("branch-group-header");
    // startsWith below is direction-blind to an empty/short header (vacuously true if the
    // header renders "분기" alone or even nothing) — assert the branch name is actually
    // ON SCREEN first, independent of the aria comparison.
    expect(visibleTextOf(header)).toContain("checkout_branch");
    const groupList = screen.getByRole("list", { name: GROUP_ARIA });
    const aria = (groupList.getAttribute("aria-label") ?? "").replace(/\s+/g, " ");
    // 헤더는 두 인접 <span>(리드/분기명)을 CSS gap으로만 벌려 렌더한다 — JSX가
    // span 사이 개행-only 공백을 드롭해 textContent엔 공백이 없다("분기checkout_branch")
    // 반면 aria-label은 조립 시 명시 공백을 넣는다("분기 checkout_branch ..."). 둘 다
    // 공백을 제거하고 비교해 이 CSS-gap-vs-space 차이에 면역이면서, aria-label을 독립
    // 하드코딩 문자열로 바꾸는 미래의 드리프트는 여전히 잡는다.
    const strip = (s: string) => s.replace(/\s+/g, "");
    expect(strip(aria).startsWith(strip(visibleTextOf(header)))).toBe(true);
  });

  // T6 (US4) — 분기 없는 시나리오엔 새 구조가 안 생긴다
  it("adds no extra list and no named list when the scenario has no parallel branch", async () => {
    renderPanel(makeScenario());
    await screen.findByText("변수 매핑");
    expect(screen.getAllByRole("list")).toHaveLength(1);
    expect(screen.queryAllByRole("list", { name: /.+/ })).toHaveLength(0);
    expect(screen.queryByTestId("branch-group-header")).toBeNull();
  });

  // T4 — 그룹 행 조작이 원본 인덱스를 쓴다
  it("removing a grouped row removes only that row (original index, not local)", async () => {
    const user = userEvent.setup();
    renderPanel(makeScenarioWithParallel());
    const groupList = await screen.findByRole("list", { name: GROUP_ARIA });
    await user.click(
      within(groupList).getByRole("button", {
        name: ko.binding.removeMappingAria("checkout_branch.session_token"),
      }),
    );
    // username(원본 0)은 살아 있고, 지워진 건 session_token(원본 1)뿐이다.
    expect(screen.getByTitle("username")).toBeInTheDocument();
    expect(screen.queryByTitle("checkout_branch.session_token")).toBeNull();
    expect(screen.getByTitle("checkout_branch.order_id")).toBeInTheDocument();
    expect(screen.getByTitle("late_var")).toBeInTheDocument();
  });
});

describe("var name column width (US2)", () => {
  const tokens = (el: Element) => (el.getAttribute("class") ?? "").split(/\s+/);

  it("locks the badge width", async () => {
    renderPanel(makeScenarioWithMissing());
    const badge = await screen.findByTitle("missing");
    expect(tokens(badge)).toContain("w-48");
    expect(tokens(badge)).not.toContain("w-28");
  });

  it("keeps the error-hint indent in step with the badge width", async () => {
    // 힌트는 데이터셋이 선택돼야 렌더된다(`:641` "Error hints (only when dataset is selected)").
    fetchMock
      .mockResolvedValueOnce(jsonResponse(DATASET_LIST))
      .mockResolvedValueOnce(jsonResponse(DATASET_DETAIL));
    const user = userEvent.setup();
    renderPanel(makeScenarioWithMissing());

    const datasetSelect = await screen.findByLabelText(/데이터셋/i);
    await screen.findByRole("option", { name: /users\.csv/i });
    await user.selectOptions(datasetSelect, "DS1");

    const hint = (await screen.findByText(/매핑되지 않음/)).closest("p");
    expect(hint).not.toBeNull();
    expect(tokens(hint as Element)).toContain("ml-[200px]");
    expect(tokens(hint as Element)).not.toContain("ml-32");
  });
});
