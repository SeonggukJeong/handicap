import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RunDialog } from "../RunDialog";

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

function renderDialog(hasLoop = true) {
  const onCreated = vi.fn();
  const onCancel = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={qc}>
      <RunDialog
        scenarioId="S1"
        hasLoop={hasLoop}
        scenario={null}
        onCreated={onCreated}
        onCancel={onCancel}
      />
    </QueryClientProvider>,
  );
  return { ...utils, onCreated, onCancel };
}

function envSection() {
  return screen.getByRole("region", { name: /Environment variables/i });
}

describe("RunDialog — env & ramp_up", () => {
  it("adds and removes env key/value pairs", async () => {
    const user = userEvent.setup();
    renderDialog();

    expect(within(envSection()).getByText(/No env vars/i)).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText("BASE_URL"), "BASE_URL");
    await user.click(within(envSection()).getByRole("button", { name: "Add" }));

    const keyInput = await screen.findByLabelText("env key 0");
    const valueInput = screen.getByLabelText("env value 0");
    expect(keyInput).toHaveValue("BASE_URL");

    await user.type(valueInput, "http://localhost:9090");
    expect(valueInput).toHaveValue("http://localhost:9090");

    await user.click(screen.getByRole("button", { name: /Remove env BASE_URL/i }));
    expect(within(envSection()).getByText(/No env vars/i)).toBeInTheDocument();
  });

  it("posts env entries and ramp_up_seconds on Run", async () => {
    fetchMock.mockImplementation(() =>
      jsonResponse({
        id: "R1",
        scenario_id: "S1",
        scenario_yaml: "version: 1\nname: t\nsteps: []\n",
        status: "pending",
        profile: { vus: 2, ramp_up_seconds: 2, duration_seconds: 5 },
        env: { BASE_URL: "http://localhost:9090" },
        started_at: null,
        ended_at: null,
        created_at: 1,
      }),
    );

    const user = userEvent.setup();
    const { onCreated } = renderDialog();

    const rampInput = screen.getByLabelText(/Ramp-up/);
    await user.clear(rampInput);
    await user.type(rampInput, "2");

    await user.type(screen.getByPlaceholderText("BASE_URL"), "BASE_URL");
    await user.click(within(envSection()).getByRole("button", { name: "Add" }));
    await user.type(screen.getByLabelText("env value 0"), "http://localhost:9090");

    await user.click(screen.getByRole("button", { name: /^Run$/ }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("R1"));

    const call = fetchMock.mock.calls.find(
      ([url, init]) =>
        typeof url === "string" &&
        url.endsWith("/api/runs") &&
        (init as RequestInit | undefined)?.method === "POST",
    );
    expect(call).toBeDefined();
    const body = JSON.parse((call![1] as RequestInit).body as string);
    expect(body).toMatchObject({
      scenario_id: "S1",
      profile: { vus: 2, duration_seconds: 5, ramp_up_seconds: 2 },
      env: { BASE_URL: "http://localhost:9090" },
    });
  });

  it("adds env entry with name and value in one step", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText("new env key"), "BASE_URL");
    await user.type(screen.getByLabelText("new env value"), "http://localhost:9090");
    await user.click(within(envSection()).getByRole("button", { name: "Add" }));

    expect(await screen.findByLabelText("env key 0")).toHaveValue("BASE_URL");
    expect(screen.getByLabelText("env value 0")).toHaveValue("http://localhost:9090");

    expect(screen.getByLabelText("new env key")).toHaveValue("");
    expect(screen.getByLabelText("new env value")).toHaveValue("");
  });

  it("disables Add when name is empty even if value is filled", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText("new env value"), "http://localhost:9090");

    expect(within(envSection()).getByRole("button", { name: "Add" })).toBeDisabled();
  });

  it("disables Run when ramp_up_seconds > duration_seconds", async () => {
    const user = userEvent.setup();
    renderDialog();

    const duration = screen.getByLabelText(/Duration/);
    await user.clear(duration);
    await user.type(duration, "5");

    const ramp = screen.getByLabelText(/Ramp-up/);
    await user.clear(ramp);
    await user.type(ramp, "6");

    const runBtn = screen.getByRole("button", { name: /^Run$/ });
    expect(runBtn).toBeDisabled();
    expect(screen.getByText(/Ramp-up must be ≤ duration/)).toBeInTheDocument();
  });

  it("posts loop_breakdown_cap (default 256) on Run", async () => {
    fetchMock.mockImplementation(() =>
      jsonResponse({
        id: "R2",
        scenario_id: "S1",
        scenario_yaml: "version: 1\nname: t\nsteps: []\n",
        status: "pending",
        profile: { vus: 2, ramp_up_seconds: 0, duration_seconds: 5, loop_breakdown_cap: 256 },
        env: {},
        started_at: null,
        ended_at: null,
        created_at: 1,
      }),
    );

    const user = userEvent.setup();
    const { onCreated } = renderDialog();

    await user.click(screen.getByRole("button", { name: /^Run$/ }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("R2"));

    const call = fetchMock.mock.calls.find(
      ([url, init]) =>
        typeof url === "string" &&
        url.endsWith("/api/runs") &&
        (init as RequestInit | undefined)?.method === "POST",
    );
    expect(call).toBeDefined();
    const body = JSON.parse((call![1] as RequestInit).body as string);
    expect(body.profile.loop_breakdown_cap).toBe(256);
  });

  it("disables Run and shows error when loop_breakdown_cap > 10000", async () => {
    const user = userEvent.setup();
    renderDialog();

    const cap = screen.getByLabelText(/loop breakdown cap/i) as HTMLInputElement;
    await user.clear(cap);
    await user.type(cap, "10001");

    const runBtn = screen.getByRole("button", { name: /^Run$/ });
    expect(runBtn).toBeDisabled();
    expect(screen.getByText(/0 ~ 10000 사이여야 합니다/)).toBeInTheDocument();
  });

  it("lets the user set loop_breakdown_cap to 0 (off)", async () => {
    fetchMock.mockImplementation(() =>
      jsonResponse({
        id: "R3",
        scenario_id: "S1",
        scenario_yaml: "version: 1\nname: t\nsteps: []\n",
        status: "pending",
        profile: { vus: 2, ramp_up_seconds: 0, duration_seconds: 5, loop_breakdown_cap: 0 },
        env: {},
        started_at: null,
        ended_at: null,
        created_at: 1,
      }),
    );

    const user = userEvent.setup();
    const { onCreated } = renderDialog();

    const cap = screen.getByLabelText(/loop breakdown cap/i) as HTMLInputElement;
    await user.clear(cap);
    await user.type(cap, "0");
    await user.click(screen.getByRole("button", { name: /^Run$/ }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("R3"));

    const call = fetchMock.mock.calls.find(
      ([url, init]) =>
        typeof url === "string" &&
        url.endsWith("/api/runs") &&
        (init as RequestInit | undefined)?.method === "POST",
    );
    expect(call).toBeDefined();
    const body = JSON.parse((call![1] as RequestInit).body as string);
    expect(body.profile.loop_breakdown_cap).toBe(0);
  });

  it("hides the cap input when the scenario has no loop step", () => {
    renderDialog(false);
    expect(screen.queryByLabelText(/loop breakdown cap/i)).not.toBeInTheDocument();
  });

  it("posts loop_breakdown_cap=0 when there is no loop step", async () => {
    fetchMock.mockImplementation(() =>
      jsonResponse({
        id: "R4",
        scenario_id: "S1",
        scenario_yaml: "version: 1\nname: t\nsteps: []\n",
        status: "pending",
        profile: { vus: 2, ramp_up_seconds: 0, duration_seconds: 5, loop_breakdown_cap: 0 },
        env: {},
        started_at: null,
        ended_at: null,
        created_at: 1,
      }),
    );

    const user = userEvent.setup();
    const { onCreated } = renderDialog(false);

    await user.click(screen.getByRole("button", { name: /^Run$/ }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("R4"));

    const call = fetchMock.mock.calls.find(
      ([url, init]) =>
        typeof url === "string" &&
        url.endsWith("/api/runs") &&
        (init as RequestInit | undefined)?.method === "POST",
    );
    expect(call).toBeDefined();
    const body = JSON.parse((call![1] as RequestInit).body as string);
    expect(body.profile.loop_breakdown_cap).toBe(0);
  });
});

import type { RunPrefill } from "../../api/runPrefill";

function renderWithInitial(initial: RunPrefill, opts?: { scenarioChangedWarning?: boolean }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <RunDialog
        scenarioId="S1"
        hasLoop={true}
        scenario={null}
        initial={initial}
        scenarioChangedWarning={opts?.scenarioChangedWarning ?? false}
        onCreated={vi.fn()}
        onCancel={vi.fn()}
      />
    </QueryClientProvider>,
  );
}

describe("RunDialog — initial prefill (A1)", () => {
  const initial: RunPrefill = {
    profile: {
      vus: 7,
      duration_seconds: 9,
      ramp_up_seconds: 3,
      loop_breakdown_cap: 128,
      http_timeout_seconds: 120,
      data_binding: null,
    },
    env: { BASE_URL: "http://x", TOKEN: "abc" },
  };

  it("seeds vus / duration / ramp-up / loop cap from initial.profile", () => {
    renderWithInitial(initial);
    expect(screen.getByLabelText("VUs")).toHaveValue(7);
    expect(screen.getByLabelText("Duration (s)")).toHaveValue(9);
    expect(screen.getByLabelText("Ramp-up (s)")).toHaveValue(3);
    expect(screen.getByLabelText("loop breakdown cap")).toHaveValue(128);
    expect(screen.getByLabelText(/HTTP timeout/i)).toHaveValue(120);
  });

  it("seeds env entries from initial.env", () => {
    renderWithInitial(initial);
    expect(screen.getByLabelText("env key 0")).toHaveValue("BASE_URL");
    expect(screen.getByLabelText("env value 0")).toHaveValue("http://x");
    expect(screen.getByLabelText("env key 1")).toHaveValue("TOKEN");
    expect(screen.getByLabelText("env value 1")).toHaveValue("abc");
  });

  it("shows a drift warning when scenarioChangedWarning is set", () => {
    renderWithInitial(initial, { scenarioChangedWarning: true });
    expect(screen.getByRole("alert")).toHaveTextContent(/이 run 이후 수정됨/);
  });

  it("does not show the drift warning by default", () => {
    renderWithInitial(initial);
    expect(screen.queryByText(/이 run 이후 수정됨/)).toBeNull();
  });
});

describe("RunDialog — save/manage preset (A2)", () => {
  function mockPresets(existing: Array<{ id: string; name: string }> = []) {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith("/api/scenarios/S1/presets") && (!init || init.method === "GET")) {
        return Promise.resolve(
          jsonResponse({
            presets: existing.map((p) => ({
              id: p.id,
              name: p.name,
              vus: 1,
              duration_seconds: 1,
              created_at: 1,
              updated_at: 1,
            })),
          }),
        );
      }
      if (url.endsWith("/api/scenarios/S1/presets") && init?.method === "POST") {
        return Promise.resolve(
          jsonResponse(
            {
              id: "NEW",
              scenario_id: "S1",
              name: "saved",
              profile: { vus: 2, duration_seconds: 5, ramp_up_seconds: 0, loop_breakdown_cap: 0 },
              env: {},
              created_at: 1,
              updated_at: 1,
            },
            201,
          ),
        );
      }
      if (url.match(/\/api\/presets\/[^/]+$/) && init?.method === "PUT") {
        return Promise.resolve(
          jsonResponse({
            id: "P1",
            scenario_id: "S1",
            name: "renamed",
            profile: { vus: 1, duration_seconds: 1, ramp_up_seconds: 0, loop_breakdown_cap: 0 },
            env: {},
            created_at: 1,
            updated_at: 2,
          }),
        );
      }
      if (url.match(/\/api\/presets\/P1$/) && (!init || init.method === "GET")) {
        return Promise.resolve(
          jsonResponse({
            id: "P1",
            scenario_id: "S1",
            name: "loadme",
            profile: { vus: 1, duration_seconds: 1, ramp_up_seconds: 0, loop_breakdown_cap: 0 },
            env: {},
            created_at: 1,
            updated_at: 1,
          }),
        );
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
  }

  function renderDialog() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <RunDialog
          scenarioId="S1"
          hasLoop={false}
          scenario={null}
          onCreated={vi.fn()}
          onCancel={vi.fn()}
        />
      </QueryClientProvider>,
    );
  }

  it("POSTs a new preset from the current form state", async () => {
    const user = userEvent.setup();
    mockPresets([]);
    renderDialog();
    await user.type(screen.getByLabelText("preset name"), "saved");
    await user.click(screen.getByRole("button", { name: "프리셋으로 저장" }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([u, i]) =>
          String(u).endsWith("/api/scenarios/S1/presets") && (i as RequestInit)?.method === "POST",
      );
      expect(call).toBeTruthy();
      const body = JSON.parse((call![1] as RequestInit).body as string);
      expect(body.name).toBe("saved");
      expect(body.profile.vus).toBe(2); // default form vus
    });
  });

  it("confirms then PUTs when the name already exists", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    mockPresets([{ id: "P1", name: "dup" }]);
    renderDialog();
    await user.type(screen.getByLabelText("preset name"), "dup");
    await user.click(screen.getByRole("button", { name: "프리셋으로 저장" }));
    await waitFor(() => {
      const put = fetchMock.mock.calls.find(
        ([u, i]) => String(u).endsWith("/api/presets/P1") && (i as RequestInit)?.method === "PUT",
      );
      expect(put).toBeTruthy();
    });
    confirmSpy.mockRestore();
  });

  it("PUTs with the new name when renamePreset is called", async () => {
    const user = userEvent.setup();
    mockPresets([{ id: "P1", name: "loadme" }]);
    renderDialog();

    // Load preset P1 to set loadedPresetId and reveal the rename button
    await user.selectOptions(await screen.findByLabelText("load preset"), "P1");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "이름 변경" })).toBeInTheDocument(),
    );

    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("renamed-name");

    await user.click(screen.getByRole("button", { name: "이름 변경" }));

    await waitFor(() => {
      const put = fetchMock.mock.calls.find(
        ([u, i]) => String(u).endsWith("/api/presets/P1") && (i as RequestInit)?.method === "PUT",
      );
      expect(put).toBeTruthy();
      expect(JSON.parse((put![1] as RequestInit).body as string).name).toBe("renamed-name");
    });

    promptSpy.mockRestore();
  });
});

describe("RunDialog — load preset (A2)", () => {
  function mockPresets() {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith("/api/scenarios/S1/presets") && (!init || init.method === "GET")) {
        return Promise.resolve(
          jsonResponse({
            presets: [
              {
                id: "P1",
                name: "heavy",
                vus: 50,
                duration_seconds: 60,
                created_at: 1,
                updated_at: 1,
              },
            ],
          }),
        );
      }
      if (url.endsWith("/api/presets/P1")) {
        return Promise.resolve(
          jsonResponse({
            id: "P1",
            scenario_id: "S1",
            name: "heavy",
            profile: {
              vus: 50,
              duration_seconds: 60,
              ramp_up_seconds: 5,
              loop_breakdown_cap: 256,
              data_binding: null,
            },
            env: { BASE_URL: "http://heavy" },
            created_at: 1,
            updated_at: 1,
          }),
        );
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
  }

  function renderPresetDialog() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <RunDialog
          scenarioId="S1"
          hasLoop={true}
          scenario={null}
          onCreated={vi.fn()}
          onCancel={vi.fn()}
        />
      </QueryClientProvider>,
    );
  }

  it("renders the preset dropdown when presets exist", async () => {
    mockPresets();
    renderPresetDialog();
    expect(await screen.findByLabelText("load preset")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "heavy" })).toBeInTheDocument();
  });

  it("loads a preset's profile + env into the form on selection", async () => {
    const user = userEvent.setup();
    mockPresets();
    renderPresetDialog();
    await user.selectOptions(await screen.findByLabelText("load preset"), "P1");
    await waitFor(() => expect(screen.getByLabelText("VUs")).toHaveValue(50));
    expect(screen.getByLabelText("Duration (s)")).toHaveValue(60);
    expect(screen.getByLabelText("Ramp-up (s)")).toHaveValue(5);
    expect(screen.getByLabelText("env key 0")).toHaveValue("BASE_URL");
    expect(screen.getByLabelText("env value 0")).toHaveValue("http://heavy");
  });
});

describe("RunDialog — SLO criteria (A4a)", () => {
  it("includes criteria in the run POST body with error_rate as a fraction", async () => {
    fetchMock.mockImplementation(() =>
      jsonResponse({
        id: "R1",
        scenario_id: "S1",
        scenario_yaml: "version: 1\nname: t\nsteps: []\n",
        status: "pending",
        profile: { vus: 2, ramp_up_seconds: 0, duration_seconds: 5 },
        env: {},
        started_at: null,
        ended_at: null,
        created_at: 1,
      }),
    );
    const user = userEvent.setup();
    const { onCreated } = renderDialog();

    await user.click(screen.getByRole("button", { name: /SLO 기준/ }));
    await user.type(screen.getByLabelText(/Max p95/), "500");
    await user.type(screen.getByLabelText(/Max error rate/), "1");

    await user.click(screen.getByRole("button", { name: /^Run$/ }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("R1"));

    const call = fetchMock.mock.calls.find(
      ([url, init]) =>
        typeof url === "string" &&
        url.endsWith("/api/runs") &&
        (init as RequestInit | undefined)?.method === "POST",
    );
    const body = JSON.parse((call![1] as RequestInit).body as string);
    expect(body.profile.criteria).toEqual({ max_p95_ms: 500, max_error_rate: 0.01 });
  });

  it("SLO inputs have type=number to prevent NaN from non-numeric text", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole("button", { name: /SLO 기준/ }));
    expect(screen.getByLabelText(/Max p50/)).toHaveAttribute("type", "number");
    expect(screen.getByLabelText(/Max p95/)).toHaveAttribute("type", "number");
    expect(screen.getByLabelText(/Max p99/)).toHaveAttribute("type", "number");
    expect(screen.getByLabelText(/Max error rate/)).toHaveAttribute("type", "number");
    expect(screen.getByLabelText(/Min RPS/)).toHaveAttribute("type", "number");
  });

  it("collapses the SLO section by default and expands on toggle", async () => {
    const user = userEvent.setup();
    renderDialog();
    const toggle = screen.getByRole("button", { name: /SLO 기준/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByLabelText(/Max p95/)).not.toBeInTheDocument();
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByLabelText(/Max p95/)).toBeInTheDocument();
  });

  it("auto-expands and prefills when initial criteria are present", () => {
    renderWithInitial({
      profile: {
        vus: 2,
        duration_seconds: 5,
        ramp_up_seconds: 0,
        loop_breakdown_cap: 256,
        http_timeout_seconds: 30,
        data_binding: null,
        criteria: { max_p95_ms: 500, max_error_rate: 0.02 },
      },
      env: {},
    });
    // seeded criteria → section starts expanded, values prefilled (error_rate 0.02 → 2%)
    expect(screen.getByRole("button", { name: /SLO 기준/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByLabelText(/Max p95/)).toHaveValue(500);
    expect(screen.getByLabelText(/Max error rate/)).toHaveValue(2);
  });

  it("omits criteria when all SLO inputs are empty", async () => {
    fetchMock.mockImplementation(() =>
      jsonResponse({
        id: "R2",
        scenario_id: "S1",
        scenario_yaml: "version: 1\nname: t\nsteps: []\n",
        status: "pending",
        profile: { vus: 2, ramp_up_seconds: 0, duration_seconds: 5 },
        env: {},
        started_at: null,
        ended_at: null,
        created_at: 1,
      }),
    );
    const user = userEvent.setup();
    const { onCreated } = renderDialog();

    await user.click(screen.getByRole("button", { name: /^Run$/ }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("R2"));

    const call = fetchMock.mock.calls.find(
      ([url, init]) =>
        typeof url === "string" &&
        url.endsWith("/api/runs") &&
        (init as RequestInit | undefined)?.method === "POST",
    );
    const body = JSON.parse((call![1] as RequestInit).body as string);
    expect(body.profile.criteria).toBeUndefined();
  });
});

describe("RunDialog — Pacing think time (S-B)", () => {
  it("submits think_time and think_seed from the Pacing section", async () => {
    fetchMock.mockImplementation(() =>
      jsonResponse({
        id: "RTT1",
        scenario_id: "S1",
        scenario_yaml: "version: 1\nname: t\nsteps: []\n",
        status: "pending",
        profile: { vus: 2, ramp_up_seconds: 0, duration_seconds: 5 },
        env: {},
        started_at: null,
        ended_at: null,
        created_at: 1,
      }),
    );
    const user = userEvent.setup();
    const { onCreated } = renderDialog();

    await user.click(screen.getByRole("button", { name: /Pacing/ }));
    await user.type(screen.getByLabelText(/Think min/), "100");
    await user.type(screen.getByLabelText(/Think max/), "500");
    await user.type(screen.getByLabelText(/Think seed/), "7");

    await user.click(screen.getByRole("button", { name: /^Run$/ }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("RTT1"));

    const call = fetchMock.mock.calls.find(
      ([url, init]) =>
        typeof url === "string" &&
        url.endsWith("/api/runs") &&
        (init as RequestInit | undefined)?.method === "POST",
    );
    const body = JSON.parse((call![1] as RequestInit).body as string);
    expect(body.profile.think_time).toEqual({ min_ms: 100, max_ms: 500 });
    expect(body.profile.think_seed).toBe(7);
  });

  it("omits think_time/think_seed when Pacing inputs are empty (byte-identical)", async () => {
    fetchMock.mockImplementation(() =>
      jsonResponse({
        id: "RTT2",
        scenario_id: "S1",
        scenario_yaml: "version: 1\nname: t\nsteps: []\n",
        status: "pending",
        profile: { vus: 2, ramp_up_seconds: 0, duration_seconds: 5 },
        env: {},
        started_at: null,
        ended_at: null,
        created_at: 1,
      }),
    );
    const user = userEvent.setup();
    const { onCreated } = renderDialog();

    await user.click(screen.getByRole("button", { name: /^Run$/ }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("RTT2"));

    const call = fetchMock.mock.calls.find(
      ([url, init]) =>
        typeof url === "string" &&
        url.endsWith("/api/runs") &&
        (init as RequestInit | undefined)?.method === "POST",
    );
    const body = JSON.parse((call![1] as RequestInit).body as string);
    expect(body.profile.think_time).toBeUndefined();
    expect(body.profile.think_seed).toBeUndefined();
  });

  it("links the Pacing error to the think inputs via aria-describedby when invalid", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: /Pacing/ }));
    // min > max → invalid
    await user.type(screen.getByLabelText(/Think min/), "500");
    await user.type(screen.getByLabelText(/Think max/), "100");

    const err = screen.getByText(/min ≤ max ≤ 600000/);
    expect(err).toHaveAttribute("id", "think-time-error");
    expect(screen.getByLabelText(/Think min/)).toHaveAttribute(
      "aria-describedby",
      "think-time-error",
    );
    expect(screen.getByLabelText(/Think max/)).toHaveAttribute(
      "aria-describedby",
      "think-time-error",
    );
  });
});

describe("RunDialog — open-loop mode (S-C)", () => {
  it("closed-loop submit does NOT include target_rps or max_in_flight", async () => {
    fetchMock.mockImplementation(() =>
      jsonResponse({
        id: "RCLOSED1",
        scenario_id: "S1",
        scenario_yaml: "version: 1\nname: t\nsteps: []\n",
        status: "pending",
        profile: { vus: 2, ramp_up_seconds: 0, duration_seconds: 5 },
        env: {},
        started_at: null,
        ended_at: null,
        created_at: 1,
      }),
    );

    const user = userEvent.setup();
    const { onCreated } = renderDialog();

    // Default is closed-loop — just submit
    await user.click(screen.getByRole("button", { name: /^Run$/ }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("RCLOSED1"));

    const call = fetchMock.mock.calls.find(
      ([url, init]) =>
        typeof url === "string" &&
        url.endsWith("/api/runs") &&
        (init as RequestInit | undefined)?.method === "POST",
    );
    expect(call).toBeDefined();
    const body = JSON.parse((call![1] as RequestInit).body as string);
    expect(body.profile.target_rps).toBeUndefined();
    expect(body.profile.max_in_flight).toBeUndefined();
  });

  it("prefills open-loop fields and selects open-loop radio when initial has target_rps", () => {
    const openLoopInitial: RunPrefill = {
      profile: {
        vus: 0,
        duration_seconds: 30,
        ramp_up_seconds: 0,
        loop_breakdown_cap: 0,
        http_timeout_seconds: 30,
        data_binding: null,
        target_rps: 750,
        max_in_flight: 400,
      },
      env: {},
    };
    renderWithInitial(openLoopInitial);
    expect(screen.getByRole("radio", { name: /open-loop/i })).toBeChecked();
    expect(screen.getByLabelText(/target rps/i)).toHaveValue(750);
    expect(screen.getByLabelText(/max in.?flight/i)).toHaveValue(400);
  });

  it("shows error message and aria-describedby when target_rps is invalid", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole("radio", { name: /open-loop/i }));

    const targetRpsInput = screen.getByLabelText(/target rps/i);
    await user.clear(targetRpsInput);
    // Empty value → invalid
    expect(screen.getByText(/Target RPS must be between 1 and 1,000,000/)).toBeInTheDocument();
    expect(targetRpsInput).toHaveAttribute("aria-describedby", "target-rps-error");
    expect(screen.getByRole("button", { name: /^Run$/ })).toBeDisabled();
  });

  it("shows error message and aria-describedby when max_in_flight is invalid", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole("radio", { name: /open-loop/i }));

    const maxInFlightInput = screen.getByLabelText(/max in.?flight/i);
    await user.clear(maxInFlightInput);
    // Empty value → invalid
    expect(screen.getByText(/Max in-flight must be between 1 and 10,000/)).toBeInTheDocument();
    expect(maxInFlightInput).toHaveAttribute("aria-describedby", "max-in-flight-error");
    expect(screen.getByRole("button", { name: /^Run$/ })).toBeDisabled();
  });

  it("load-model radio group is wrapped in a fieldset with a legend", () => {
    renderDialog();
    const fieldset = screen.getByRole("group", { name: /부하 모델/i });
    expect(fieldset.tagName).toBe("FIELDSET");
    expect(within(fieldset).getByRole("radio", { name: /closed-loop/i })).toBeInTheDocument();
    expect(within(fieldset).getByRole("radio", { name: /open-loop/i })).toBeInTheDocument();
  });

  it("open-loop mode shows target_rps + max_in_flight and gates empty max_in_flight", async () => {
    const user = userEvent.setup();
    renderDialog();

    // Switch to open-loop
    await user.click(screen.getByRole("radio", { name: /open-loop/i }));

    // open-loop fields are visible
    expect(screen.getByLabelText(/target rps/i)).toBeInTheDocument();

    // Fill in target_rps so the only missing piece is max_in_flight
    const targetRpsInput = screen.getByLabelText(/target rps/i);
    await user.clear(targetRpsInput);
    await user.type(targetRpsInput, "100");

    // max_in_flight should be visible
    const cap = screen.getByLabelText(/max in.?flight/i);
    expect(cap).toBeInTheDocument();

    // Clear max_in_flight → Run button should be disabled
    await user.clear(cap);
    expect(screen.getByRole("button", { name: /^Run$/ })).toBeDisabled();
  });

  it("closed-loop mode is default and shows VUs/ramp-up inputs", () => {
    renderDialog();
    expect(screen.getByRole("radio", { name: /closed-loop/i })).toBeChecked();
    expect(screen.getByLabelText("VUs")).toBeInTheDocument();
    expect(screen.getByLabelText(/Ramp-up/)).toBeInTheDocument();
  });

  it("hides vus and ramp-up in open-loop mode and shows duration", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole("radio", { name: /open-loop/i }));
    expect(screen.queryByLabelText("VUs")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Ramp-up/)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/Duration/)).toBeInTheDocument();
  });

  it("curve mode: submits stages payload with duration_seconds 0 and no target_rps", async () => {
    fetchMock.mockImplementation(() =>
      jsonResponse({
        id: "RSTG1",
        scenario_id: "S1",
        scenario_yaml: "version: 1\nname: t\nsteps: []\n",
        status: "pending",
        profile: { vus: 0, ramp_up_seconds: 0, duration_seconds: 0, max_in_flight: 50 },
        env: {},
        started_at: null,
        ended_at: null,
        created_at: 1,
      }),
    );
    const user = userEvent.setup();
    const { onCreated } = renderDialog();
    await user.click(screen.getByRole("radio", { name: /open-loop/i }));
    await user.click(screen.getByRole("radio", { name: /곡선/ }));
    // default seeded 1 row → set its target/duration
    await user.clear(screen.getByLabelText("stage target 0"));
    await user.type(screen.getByLabelText("stage target 0"), "200");
    await user.clear(screen.getByLabelText("stage duration 0"));
    await user.type(screen.getByLabelText("stage duration 0"), "30");
    await user.clear(screen.getByLabelText("Max in-flight"));
    await user.type(screen.getByLabelText("Max in-flight"), "50");
    await user.click(screen.getByRole("button", { name: /^Run$/ }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("RSTG1"));
    const call = fetchMock.mock.calls.find(
      ([url, init]) =>
        typeof url === "string" &&
        url.endsWith("/api/runs") &&
        (init as RequestInit | undefined)?.method === "POST",
    );
    const body = JSON.parse((call![1] as RequestInit).body as string);
    expect(body.profile.stages).toEqual([{ target: 200, duration_seconds: 30 }]);
    expect(body.profile.target_rps).toBeUndefined();
    expect(body.profile.duration_seconds).toBe(0);
    expect(body.profile.max_in_flight).toBe(50);
  });

  it("curve mode: + 단계 추가 adds a row; × removes it", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole("radio", { name: /open-loop/i }));
    await user.click(screen.getByRole("radio", { name: /곡선/ }));
    expect(screen.getAllByLabelText(/stage target/i)).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: /단계 추가/ }));
    expect(screen.getAllByLabelText(/stage target/i)).toHaveLength(2);
    await user.click(screen.getAllByRole("button", { name: /remove stage/i })[1]);
    expect(screen.getAllByLabelText(/stage target/i)).toHaveLength(1);
  });

  it("curve mode: Run disabled when all targets are 0", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole("radio", { name: /open-loop/i }));
    await user.click(screen.getByRole("radio", { name: /곡선/ }));
    await user.clear(screen.getByLabelText("stage target 0"));
    await user.type(screen.getByLabelText("stage target 0"), "0");
    expect(screen.getByRole("button", { name: /^Run$/ })).toBeDisabled();
  });

  it("prefills curve mode from initial.profile.stages", () => {
    renderWithInitial({
      profile: {
        vus: 0,
        duration_seconds: 0,
        ramp_up_seconds: 0,
        loop_breakdown_cap: 0,
        http_timeout_seconds: 30,
        data_binding: null,
        max_in_flight: 50,
        stages: [{ target: 100, duration_seconds: 10 }],
      },
      env: {},
    });
    expect(screen.getByRole("radio", { name: /곡선/ })).toBeChecked();
    expect(screen.getByLabelText("stage target 0")).toHaveValue(100);
  });

  it("curve mode: shows inline helpers for target, duration, and max in-flight", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole("radio", { name: /open-loop/i }));
    await user.click(screen.getByRole("radio", { name: /곡선/ }));
    expect(screen.getByText(/각 단계가 끝날 때의 목표 초당 요청 수/)).toBeInTheDocument();
    expect(screen.getByText(/이 단계가 지속되는 시간/)).toBeInTheDocument();
    expect(screen.getByText(/동시 처리 상한/)).toBeInTheDocument();
  });

  it("curve mode: selecting a load-shape template seeds stages", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole("radio", { name: /open-loop/i }));
    await user.click(screen.getByRole("radio", { name: /곡선/ }));
    // default seed is a single row
    expect(screen.getAllByLabelText(/stage target/i)).toHaveLength(1);
    await user.selectOptions(screen.getByLabelText(/부하 모양/), "spike");
    expect(screen.getAllByLabelText(/stage target/i).length).toBeGreaterThan(1);
  });

  it("submits target_rps and max_in_flight in open-loop mode", async () => {
    fetchMock.mockImplementation(() =>
      jsonResponse({
        id: "ROPEN1",
        scenario_id: "S1",
        scenario_yaml: "version: 1\nname: t\nsteps: []\n",
        status: "pending",
        profile: {
          vus: 0,
          ramp_up_seconds: 0,
          duration_seconds: 10,
          target_rps: 500,
          max_in_flight: 200,
        },
        env: {},
        started_at: null,
        ended_at: null,
        created_at: 1,
      }),
    );

    const user = userEvent.setup();
    const { onCreated } = renderDialog();

    await user.click(screen.getByRole("radio", { name: /open-loop/i }));

    const durationInput = screen.getByLabelText(/Duration/);
    await user.clear(durationInput);
    await user.type(durationInput, "10");

    await user.clear(screen.getByLabelText(/target rps/i));
    await user.type(screen.getByLabelText(/target rps/i), "500");

    await user.clear(screen.getByLabelText(/max in.?flight/i));
    await user.type(screen.getByLabelText(/max in.?flight/i), "200");

    await user.click(screen.getByRole("button", { name: /^Run$/ }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("ROPEN1"));

    const call = fetchMock.mock.calls.find(
      ([url, init]) =>
        typeof url === "string" &&
        url.endsWith("/api/runs") &&
        (init as RequestInit | undefined)?.method === "POST",
    );
    expect(call).toBeDefined();
    const body = JSON.parse((call![1] as RequestInit).body as string);
    expect(body.profile.target_rps).toBe(500);
    expect(body.profile.max_in_flight).toBe(200);
    expect(body.profile.vus).toBe(0);
    expect(body.profile.ramp_up_seconds).toBe(0);
    // No think_time in open-loop
    expect(body.profile.think_time).toBeUndefined();
  });
});

describe("RunDialog — load model 2축 리팩터 (Task 3)", () => {
  it("2차 축 '프로파일' fieldset이 항상 보인다", () => {
    renderDialog();
    expect(screen.getByRole("group", { name: /프로파일/i })).toBeInTheDocument();
  });

  it("closed 모드에서 곡선 라디오는 disabled", () => {
    renderDialog();
    expect(screen.getByRole("radio", { name: /곡선/ })).toBeDisabled();
  });

  it("open→곡선→closed 전환 시 rateMode가 fixed로 리셋된다", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole("radio", { name: /open-loop/i }));
    await user.click(screen.getByRole("radio", { name: /곡선/ }));
    expect(screen.getByRole("radio", { name: /곡선/ })).toBeChecked();
    await user.click(screen.getByRole("radio", { name: /closed-loop/i }));
    // 다시 open으로 가도 곡선이 아니라 고정이 선택돼 있어야 함(리셋됨)
    await user.click(screen.getByRole("radio", { name: /open-loop/i }));
    expect(screen.getByRole("radio", { name: /고정/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /곡선/ })).not.toBeChecked();
  });

  it("각 모드에서 HTTP timeout 입력은 정확히 1개", async () => {
    const user = userEvent.setup();
    renderDialog();
    expect(screen.getAllByLabelText(/HTTP timeout/i)).toHaveLength(1); // closed
    await user.click(screen.getByRole("radio", { name: /open-loop/i }));
    expect(screen.getAllByLabelText(/HTTP timeout/i)).toHaveLength(1); // open+fixed
    await user.click(screen.getByRole("radio", { name: /곡선/ }));
    expect(screen.getAllByLabelText(/HTTP timeout/i)).toHaveLength(1); // open+curve
  });
});

describe("RunDialog — HTTP timeout (S-A)", () => {
  it("disables Run and shows error when http_timeout_seconds is out of range", async () => {
    const user = userEvent.setup();
    renderDialog();

    const timeout = screen.getByLabelText(/HTTP timeout/i) as HTMLInputElement;
    await user.clear(timeout);
    await user.type(timeout, "601");

    const runBtn = screen.getByRole("button", { name: /^Run$/ });
    expect(runBtn).toBeDisabled();
    expect(screen.getByText(/HTTP timeout must be between 1 and 600 seconds/)).toBeInTheDocument();
  });

  it("submits http_timeout_seconds from the input (default 30)", async () => {
    fetchMock.mockImplementation(() =>
      jsonResponse({
        id: "R5",
        scenario_id: "S1",
        scenario_yaml: "version: 1\nname: t\nsteps: []\n",
        status: "pending",
        profile: { vus: 2, ramp_up_seconds: 0, duration_seconds: 5, http_timeout_seconds: 45 },
        env: {},
        started_at: null,
        ended_at: null,
        created_at: 1,
      }),
    );

    const user = userEvent.setup();
    const { onCreated } = renderDialog();

    const timeout = screen.getByLabelText(/HTTP timeout/i) as HTMLInputElement;
    expect(timeout.value).toBe("30");
    await user.clear(timeout);
    await user.type(timeout, "45");

    await user.click(screen.getByRole("button", { name: /^Run$/ }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("R5"));

    const call = fetchMock.mock.calls.find(
      ([url, init]) =>
        typeof url === "string" &&
        url.endsWith("/api/runs") &&
        (init as RequestInit | undefined)?.method === "POST",
    );
    expect(call).toBeDefined();
    const body = JSON.parse((call![1] as RequestInit).body as string);
    expect(body.profile.http_timeout_seconds).toBe(45);
  });
});

describe("RunDialog — environment overlay (B-2)", () => {
  function routeFetch(handlers: {
    run?: unknown;
    envList?: unknown;
    env?: Record<string, unknown>;
  }) {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/api/environments") && (!init || !init.method || init.method === "GET")) {
        return Promise.resolve(jsonResponse(handlers.envList ?? { environments: [] }));
      }
      if (u.includes("/api/environments/") && (!init || !init.method || init.method === "GET")) {
        const id = u.split("/api/environments/")[1];
        return Promise.resolve(
          jsonResponse(handlers.env?.[id] ?? {}, handlers.env?.[id] ? 200 : 404),
        );
      }
      if (u.endsWith("/api/runs") && init?.method === "POST") {
        return Promise.resolve(jsonResponse(handlers.run, 201));
      }
      // presets list etc. — empty
      return Promise.resolve(jsonResponse({ presets: [] }));
    });
  }

  const RUN = {
    id: "R1",
    scenario_id: "S1",
    scenario_yaml: "version: 1\nname: t\nsteps: []\n",
    status: "pending",
    profile: { vus: 2, ramp_up_seconds: 0, duration_seconds: 5 },
    env: {},
    started_at: null,
    ended_at: null,
    created_at: 1,
  };

  it("merges env base + override and posts the resolved flat env", async () => {
    const captured: { body?: string } = {};
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/api/environments") && (!init || !init.method || init.method === "GET")) {
        return Promise.resolve(
          jsonResponse({
            environments: [
              { id: "E1", name: "staging", var_count: 2, created_at: 1, updated_at: 1 },
            ],
          }),
        );
      }
      if (u.includes("/api/environments/E1")) {
        return Promise.resolve(
          jsonResponse({
            id: "E1",
            name: "staging",
            vars: { BASE_URL: "http://s", API_KEY: "k" },
            created_at: 1,
            updated_at: 1,
          }),
        );
      }
      if (u.endsWith("/api/runs") && init?.method === "POST") {
        captured.body = String(init.body);
        return Promise.resolve(jsonResponse(RUN, 201));
      }
      return Promise.resolve(jsonResponse({ presets: [] }));
    });

    const user = userEvent.setup();
    renderDialog();
    // wait for the environments list to load before selecting
    await screen.findByRole("option", { name: "staging" });
    await user.selectOptions(screen.getByLabelText("select environment"), "E1");
    await screen.findByText("BASE_URL");
    // override BASE_URL via the add row
    await user.type(screen.getByLabelText("new env key"), "BASE_URL");
    await user.type(screen.getByLabelText("new env value"), "http://override");
    await user.click(
      within(screen.getByRole("region", { name: /Environment variables/i })).getByRole("button", {
        name: /^add$/i,
      }),
    );
    await user.click(screen.getByRole("button", { name: /^Run$/ }));

    await waitFor(() => expect(captured.body).toBeTruthy());
    const posted = JSON.parse(captured.body!);
    // override wins over base; untouched base key carried through
    expect(posted.env).toEqual({ BASE_URL: "http://override", API_KEY: "k" });
  });

  it("keeps overrides when switching environments (no orphan)", async () => {
    routeFetch({
      run: RUN,
      envList: {
        environments: [
          { id: "E1", name: "staging", var_count: 1, created_at: 1, updated_at: 1 },
          { id: "E2", name: "prod", var_count: 1, created_at: 1, updated_at: 1 },
        ],
      },
      env: {
        E1: {
          id: "E1",
          name: "staging",
          vars: { BASE_URL: "http://s" },
          created_at: 1,
          updated_at: 1,
        },
        E2: {
          id: "E2",
          name: "prod",
          vars: { BASE_URL: "http://p" },
          created_at: 1,
          updated_at: 1,
        },
      },
    });
    const user = userEvent.setup();
    renderDialog();
    // wait for the environments list to load before selecting
    await screen.findByRole("option", { name: "staging" });
    await user.selectOptions(screen.getByLabelText("select environment"), "E1");
    // add a standalone override
    await user.type(screen.getByLabelText("new env key"), "TOKEN");
    await user.type(screen.getByLabelText("new env value"), "t1");
    await user.click(
      within(screen.getByRole("region", { name: /Environment variables/i })).getByRole("button", {
        name: /^add$/i,
      }),
    );
    expect(await screen.findByLabelText("env key 0")).toHaveValue("TOKEN");
    // switch to E2 — override survives
    await user.selectOptions(screen.getByLabelText("select environment"), "E2");
    expect(screen.getByLabelText("env key 0")).toHaveValue("TOKEN");
  });

  it("submits the selected env's vars as-is when there are no overrides (spec interaction row 2)", async () => {
    const captured: { body?: string } = {};
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/api/environments") && (!init || !init.method || init.method === "GET")) {
        return Promise.resolve(
          jsonResponse({
            environments: [
              { id: "E1", name: "staging", var_count: 2, created_at: 1, updated_at: 1 },
            ],
          }),
        );
      }
      if (u.includes("/api/environments/E1")) {
        return Promise.resolve(
          jsonResponse({
            id: "E1",
            name: "staging",
            vars: { BASE_URL: "http://s", API_KEY: "k" },
            created_at: 1,
            updated_at: 1,
          }),
        );
      }
      if (u.endsWith("/api/runs") && init?.method === "POST") {
        captured.body = String(init.body);
        return Promise.resolve(jsonResponse(RUN, 201));
      }
      return Promise.resolve(jsonResponse({ presets: [] }));
    });

    const user = userEvent.setup();
    renderDialog();
    await screen.findByRole("option", { name: "staging" });
    await user.selectOptions(screen.getByLabelText("select environment"), "E1");
    await screen.findByText("BASE_URL"); // base list loaded
    // no overrides added — submit straight away
    await user.click(screen.getByRole("button", { name: /^run$/i }));

    await waitFor(() => expect(captured.body).toBeTruthy());
    const posted = JSON.parse(captured.body!);
    expect(posted.env).toEqual({ BASE_URL: "http://s", API_KEY: "k" });
  });
});
