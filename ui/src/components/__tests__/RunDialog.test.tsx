import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RunDialog } from "../RunDialog";

// null 렌더 — 헬퍼의 렌더/미렌더는 LoadModelFields.test.tsx가 검증. 여기선 RunDialog 단위 경계 유지(헬퍼 hook fetch 차단).
vi.mock("../VuSizingHelper", () => ({ VuSizingHelper: () => null }));
vi.mock("../SlotSizingHelper", () => ({
  SlotSizingHelper: ({ onApply }: { onApply: (n: number) => void }) => (
    <button type="button" onClick={() => onApply(123)}>
      mock-apply-slots
    </button>
  ),
}));

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

    const rampInput = screen.getByLabelText(/점진 시작/);
    await user.clear(rampInput);
    await user.type(rampInput, "2");

    await user.type(screen.getByPlaceholderText("BASE_URL"), "BASE_URL");
    await user.click(within(envSection()).getByRole("button", { name: "Add" }));
    await user.type(screen.getByLabelText("env value 0"), "http://localhost:9090");

    await user.click(screen.getByRole("button", { name: /^실행$/ }));

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

    const duration = screen.getByLabelText(/테스트 시간/);
    await user.clear(duration);
    await user.type(duration, "5");

    const ramp = screen.getByLabelText(/점진 시작/);
    await user.clear(ramp);
    await user.type(ramp, "6");

    const runBtn = screen.getByRole("button", { name: /^실행$/ });
    expect(runBtn).toBeDisabled();
    expect(screen.getByText(/점진 시작은 테스트 시간 이하여야 합니다/)).toBeInTheDocument();
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

    await user.click(screen.getByRole("button", { name: /^실행$/ }));

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

    await user.click(screen.getByRole("button", { name: /판정·고급/ })); // 접힌 그룹 펼침
    const cap = screen.getByLabelText(/루프 집계 상한/) as HTMLInputElement;
    await user.clear(cap);
    await user.type(cap, "10001");

    const runBtn = screen.getByRole("button", { name: /^실행$/ });
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

    await user.click(screen.getByRole("button", { name: /판정·고급/ })); // 접힌 그룹 펼침
    const cap = screen.getByLabelText(/루프 집계 상한/) as HTMLInputElement;
    await user.clear(cap);
    await user.type(cap, "0");
    await user.click(screen.getByRole("button", { name: /^실행$/ }));

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

  it("hides the cap input when the scenario has no loop step", async () => {
    const user = userEvent.setup();
    renderDialog(false);
    // 펼친 뒤에도 부재여야 의미 보존(접힘 상태 부재는 vacuous).
    await user.click(screen.getByRole("button", { name: /판정·고급/ }));
    expect(screen.queryByLabelText(/루프 집계 상한/)).not.toBeInTheDocument();
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

    await user.click(screen.getByRole("button", { name: /^실행$/ }));
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
      measure_phases: false,
      data_binding: null,
    },
    env: { BASE_URL: "http://x", TOKEN: "abc" },
  };

  it("seeds vus / duration / ramp-up / loop cap from initial.profile", () => {
    renderWithInitial(initial);
    expect(screen.getByLabelText(/동시 사용자/)).toHaveValue(7);
    expect(screen.getByLabelText(/테스트 시간/)).toHaveValue(9);
    expect(screen.getByLabelText(/점진 시작/)).toHaveValue(3);
    expect(screen.getByLabelText(/루프 집계 상한/)).toHaveValue(128);
    expect(screen.getByLabelText(/HTTP 타임아웃/)).toHaveValue(120);
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
    await waitFor(() => expect(screen.getByLabelText(/동시 사용자/)).toHaveValue(50));
    expect(screen.getByLabelText(/테스트 시간/)).toHaveValue(60);
    expect(screen.getByLabelText(/점진 시작/)).toHaveValue(5);
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

    await user.click(screen.getByRole("button", { name: /판정·고급/ }));
    await user.type(screen.getByLabelText(/최대 p95/), "500");
    await user.type(screen.getByLabelText(/최대 에러율/), "1");

    await user.click(screen.getByRole("button", { name: /^실행$/ }));
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
    await user.click(screen.getByRole("button", { name: /판정·고급/ }));
    expect(screen.getByLabelText(/최대 p50/)).toHaveAttribute("type", "number");
    expect(screen.getByLabelText(/최대 p95/)).toHaveAttribute("type", "number");
    expect(screen.getByLabelText(/최대 p99/)).toHaveAttribute("type", "number");
    expect(screen.getByLabelText(/최대 에러율/)).toHaveAttribute("type", "number");
    expect(screen.getByLabelText("최소 RPS")).toHaveAttribute("type", "number");
  });

  it("collapses the 판정·고급 group by default and expands on toggle", async () => {
    const user = userEvent.setup();
    renderDialog();
    const toggle = screen.getByRole("button", { name: /판정·고급/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByLabelText(/최대 p95/)).not.toBeInTheDocument();
    // HTTP 타임아웃 입력도 이제 접힌 그룹 안 — 접힘 시 DOM 부재
    expect(screen.queryByLabelText(/HTTP 타임아웃/)).not.toBeInTheDocument();
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByLabelText(/최대 p95/)).toBeInTheDocument();
    expect(screen.getByLabelText(/HTTP 타임아웃/)).toBeInTheDocument();
  });

  it("auto-expands and prefills when initial criteria are present", () => {
    renderWithInitial({
      profile: {
        vus: 2,
        duration_seconds: 5,
        ramp_up_seconds: 0,
        loop_breakdown_cap: 256,
        http_timeout_seconds: 30,
        measure_phases: false,
        data_binding: null,
        criteria: { max_p95_ms: 500, max_error_rate: 0.02 },
      },
      env: {},
    });
    // seeded criteria → section starts expanded, values prefilled (error_rate 0.02 → 2%)
    expect(screen.getByRole("button", { name: /판정·고급/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByLabelText(/최대 p95/)).toHaveValue(500);
    expect(screen.getByLabelText(/최대 에러율/)).toHaveValue(2);
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

    await user.click(screen.getByRole("button", { name: /^실행$/ }));
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

    await user.click(screen.getByRole("button", { name: /판정·고급/ }));
    await user.type(screen.getByLabelText(/think 최소/), "100");
    await user.type(screen.getByLabelText(/think 최대/), "500");
    await user.type(screen.getByLabelText(/think 시드/), "7");

    await user.click(screen.getByRole("button", { name: /^실행$/ }));
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

    await user.click(screen.getByRole("button", { name: /^실행$/ }));
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

    await user.click(screen.getByRole("button", { name: /판정·고급/ }));
    // min > max → invalid
    await user.type(screen.getByLabelText(/think 최소/), "500");
    await user.type(screen.getByLabelText(/think 최대/), "100");

    const err = screen.getByText(/min ≤ max ≤ 600000/);
    expect(err).toHaveAttribute("id", "think-time-error");
    expect(screen.getByLabelText(/think 최소/)).toHaveAttribute(
      "aria-describedby",
      "think-time-error",
    );
    expect(screen.getByLabelText(/think 최대/)).toHaveAttribute(
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
    await user.click(screen.getByRole("button", { name: /^실행$/ }));
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
        measure_phases: false,
        data_binding: null,
        target_rps: 750,
        max_in_flight: 400,
      },
      env: {},
    };
    renderWithInitial(openLoopInitial);
    expect(screen.getByRole("radio", { name: /요청 속도 기준/ })).toBeChecked();
    expect(screen.getByLabelText(/목표 RPS/i)).toHaveValue(750);
    expect(screen.getByLabelText(/동시 요청 상한/)).toHaveValue(400);
  });

  it("shows error message and aria-describedby when target_rps is invalid", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole("radio", { name: /요청 속도 기준/ }));

    const targetRpsInput = screen.getByLabelText(/목표 RPS/i);
    await user.clear(targetRpsInput);
    // Empty value → invalid
    expect(screen.getByText(/목표 RPS는 1 ~ 1,000,000 사이여야 합니다/)).toBeInTheDocument();
    expect(targetRpsInput).toHaveAttribute("aria-describedby", "target-rps-error");
    expect(screen.getByRole("button", { name: /^실행$/ })).toBeDisabled();
  });

  it("shows error message and aria-describedby when max_in_flight is invalid", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole("radio", { name: /요청 속도 기준/ }));

    const maxInFlightInput = screen.getByLabelText(/동시 요청 상한/);
    await user.clear(maxInFlightInput);
    // Empty value → invalid
    expect(screen.getByText(/동시 요청 상한은 1 ~ 10,000 사이여야 합니다/)).toBeInTheDocument();
    expect(maxInFlightInput).toHaveAttribute("aria-describedby", "max-in-flight-error");
    expect(screen.getByRole("button", { name: /^실행$/ })).toBeDisabled();
  });

  it("load-model radio group is wrapped in a fieldset with a legend", () => {
    renderDialog();
    const fieldset = screen.getByRole("group", { name: /부하 모델/i });
    expect(fieldset.tagName).toBe("FIELDSET");
    expect(within(fieldset).getByRole("radio", { name: /사용자 수 기준/ })).toBeInTheDocument();
    expect(within(fieldset).getByRole("radio", { name: /요청 속도 기준/ })).toBeInTheDocument();
  });

  it("open-loop mode shows target_rps + max_in_flight and gates empty max_in_flight", async () => {
    const user = userEvent.setup();
    renderDialog();

    // Switch to open-loop
    await user.click(screen.getByRole("radio", { name: /요청 속도 기준/ }));

    // open-loop fields are visible
    expect(screen.getByLabelText(/목표 RPS/i)).toBeInTheDocument();

    // Fill in target_rps so the only missing piece is max_in_flight
    const targetRpsInput = screen.getByLabelText(/목표 RPS/i);
    await user.clear(targetRpsInput);
    await user.type(targetRpsInput, "100");

    // max_in_flight should be visible
    const cap = screen.getByLabelText(/동시 요청 상한/);
    expect(cap).toBeInTheDocument();

    // Clear max_in_flight → Run button should be disabled
    await user.clear(cap);
    expect(screen.getByRole("button", { name: /^실행$/ })).toBeDisabled();
  });

  it("closed-loop mode is default and shows VUs/ramp-up inputs", () => {
    renderDialog();
    expect(screen.getByRole("radio", { name: /사용자 수 기준/ })).toBeChecked();
    expect(screen.getByLabelText(/동시 사용자/)).toBeInTheDocument();
    expect(screen.getByLabelText(/점진 시작/)).toBeInTheDocument();
  });

  it("hides vus and ramp-up in open-loop mode and shows duration", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole("radio", { name: /요청 속도 기준/ }));
    expect(screen.queryByLabelText(/동시 사용자/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/점진 시작/)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/테스트 시간/)).toBeInTheDocument();
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
    await user.click(screen.getByRole("radio", { name: /요청 속도 기준/ }));
    await user.click(screen.getByRole("radio", { name: "곡선" }));
    // default seeded 1 row → set its target/duration
    await user.clear(screen.getByLabelText("stage target 0"));
    await user.type(screen.getByLabelText("stage target 0"), "200");
    await user.clear(screen.getByLabelText("stage duration 0"));
    await user.type(screen.getByLabelText("stage duration 0"), "30");
    await user.clear(screen.getByLabelText(/동시 요청 상한/));
    await user.type(screen.getByLabelText(/동시 요청 상한/), "50");
    await user.click(screen.getByRole("button", { name: /^실행$/ }));
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
    await user.click(screen.getByRole("radio", { name: /요청 속도 기준/ }));
    await user.click(screen.getByRole("radio", { name: "곡선" }));
    expect(screen.getAllByLabelText(/stage target/i)).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: /단계 추가/ }));
    expect(screen.getAllByLabelText(/stage target/i)).toHaveLength(2);
    await user.click(screen.getAllByRole("button", { name: /remove stage/i })[1]);
    expect(screen.getAllByLabelText(/stage target/i)).toHaveLength(1);
  });

  it("curve mode: Run disabled when all targets are 0", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole("radio", { name: /요청 속도 기준/ }));
    await user.click(screen.getByRole("radio", { name: "곡선" }));
    await user.clear(screen.getByLabelText("stage target 0"));
    await user.type(screen.getByLabelText("stage target 0"), "0");
    expect(screen.getByRole("button", { name: /^실행$/ })).toBeDisabled();
  });

  it("closed+curve: Run disabled when all targets are 0 (stagesInvalid 게이트)", async () => {
    const user = userEvent.setup();
    renderDialog();
    // closed가 기본 — 곡선만 전환 (사용자 수 기준 유지)
    await user.click(screen.getByRole("radio", { name: "곡선" }));
    await user.clear(screen.getByLabelText("stage target 0"));
    await user.type(screen.getByLabelText("stage target 0"), "0");
    expect(screen.getByRole("button", { name: /^실행$/ })).toBeDisabled();
  });

  it("open+fixed: 슬롯 헬퍼 적용 → 동시 요청 상한 입력에 반영", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole("radio", { name: /요청 속도 기준/ }));
    await user.click(screen.getByRole("button", { name: "mock-apply-slots" }));
    expect(screen.getByLabelText(/동시 요청 상한/)).toHaveValue(123);
  });

  it("prefills curve mode from initial.profile.stages", () => {
    renderWithInitial({
      profile: {
        vus: 0,
        duration_seconds: 0,
        ramp_up_seconds: 0,
        loop_breakdown_cap: 0,
        http_timeout_seconds: 30,
        measure_phases: false,
        data_binding: null,
        max_in_flight: 50,
        stages: [{ target: 100, duration_seconds: 10 }],
      },
      env: {},
    });
    expect(screen.getByRole("radio", { name: "곡선" })).toBeChecked();
    expect(screen.getByLabelText("stage target 0")).toHaveValue(100);
  });

  it("curve mode: shows inline helpers for target, duration, and max in-flight", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole("radio", { name: /요청 속도 기준/ }));
    await user.click(screen.getByRole("radio", { name: "곡선" }));
    expect(screen.getByText(/각 단계가 끝날 때의 목표 초당 요청 수/)).toBeInTheDocument();
    expect(screen.getByText(/이 단계가 지속되는 시간/)).toBeInTheDocument();
    expect(screen.getByText(/동시 요청 상한 — /)).toBeInTheDocument();
  });

  it("curve mode: selecting a load-shape template seeds stages", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole("radio", { name: /요청 속도 기준/ }));
    await user.click(screen.getByRole("radio", { name: "곡선" }));
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

    await user.click(screen.getByRole("radio", { name: /요청 속도 기준/ }));

    const durationInput = screen.getByLabelText(/테스트 시간/);
    await user.clear(durationInput);
    await user.type(durationInput, "10");

    await user.clear(screen.getByLabelText(/목표 RPS/i));
    await user.type(screen.getByLabelText(/목표 RPS/i), "500");

    await user.clear(screen.getByLabelText(/동시 요청 상한/));
    await user.type(screen.getByLabelText(/동시 요청 상한/), "200");

    await user.click(screen.getByRole("button", { name: /^실행$/ }));
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

  it("closed 모드에서 곡선 라디오가 활성화돼 선택 가능 (곧 지원 제거)", async () => {
    const user = userEvent.setup();
    renderDialog();
    const curve = screen.getByRole("radio", { name: "곡선" });
    expect(curve).toBeEnabled();
    await user.click(curve);
    expect(curve).toBeChecked();
  });

  it("open→곡선→closed 전환 시 rateMode가 유지된다 (eager reset 제거)", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole("radio", { name: /요청 속도 기준/ }));
    await user.click(screen.getByRole("radio", { name: "곡선" }));
    expect(screen.getByRole("radio", { name: "곡선" })).toBeChecked();
    await user.click(screen.getByRole("radio", { name: /사용자 수 기준/ }));
    // closed+curve는 이제 유효한 모드 — closed로 이동해도 curve가 유지된다
    expect(screen.getByRole("radio", { name: "곡선" })).toBeChecked();
  });

  it("각 모드에서 HTTP timeout 입력은 정확히 1개", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole("button", { name: /판정·고급/ })); // 접힌 그룹 펼침
    expect(screen.getAllByLabelText(/HTTP 타임아웃/)).toHaveLength(1); // closed
    await user.click(screen.getByRole("radio", { name: /요청 속도 기준/ }));
    expect(screen.getAllByLabelText(/HTTP 타임아웃/)).toHaveLength(1); // open+fixed
    await user.click(screen.getByRole("radio", { name: "곡선" }));
    expect(screen.getAllByLabelText(/HTTP 타임아웃/)).toHaveLength(1); // open+curve
  });
});

describe("RunDialog — HTTP timeout (S-A)", () => {
  it("disables Run and shows error when http_timeout_seconds is out of range", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: /판정·고급/ })); // 접힌 그룹 펼침
    const timeout = screen.getByLabelText(/HTTP 타임아웃/) as HTMLInputElement;
    await user.clear(timeout);
    await user.type(timeout, "601");

    const runBtn = screen.getByRole("button", { name: /^실행$/ });
    expect(runBtn).toBeDisabled();
    expect(screen.getByText(/HTTP 타임아웃은 1 ~ 600초 사이/)).toBeInTheDocument();
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

    await user.click(screen.getByRole("button", { name: /판정·고급/ })); // 접힌 그룹 펼침
    const timeout = screen.getByLabelText(/HTTP 타임아웃/) as HTMLInputElement;
    expect(timeout.value).toBe("30");
    await user.clear(timeout);
    await user.type(timeout, "45");

    await user.click(screen.getByRole("button", { name: /^실행$/ }));
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

describe("RunDialog — B6 status-class + window RPS criteria", () => {
  it("submits status-class and window-rps criteria with % conversion", async () => {
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
    const { onCreated } = renderDialog(false);

    await user.click(screen.getByRole("button", { name: /판정·고급/ })); // 접힌 섹션 펼침
    await user.type(screen.getByLabelText(/최대 5xx 비율/), "2"); // 2% → 0.02
    await user.type(screen.getByLabelText(/최대 5xx 수/), "0");
    await user.type(screen.getByLabelText(/최소 윈도 RPS/), "50");

    await user.click(screen.getByRole("button", { name: /^실행$/ }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("R1"));

    const call = fetchMock.mock.calls.find(
      ([url, init]) =>
        typeof url === "string" &&
        url.endsWith("/api/runs") &&
        (init as RequestInit | undefined)?.method === "POST",
    );
    const body = JSON.parse((call![1] as RequestInit).body as string);
    expect(body.profile.criteria.max_5xx_rate).toBeCloseTo(0.02);
    expect(body.profile.criteria.max_5xx_count).toBe(0);
    expect(body.profile.criteria.min_window_rps).toBe(50);
  });

  it("prefills rps_warmup_seconds from ramp when min_window_rps set (closed-loop)", async () => {
    const user = userEvent.setup();
    renderDialog(false);

    const rampInput = screen.getByLabelText(/점진 시작/);
    await user.clear(rampInput);
    await user.type(rampInput, "3");

    await user.click(screen.getByRole("button", { name: /판정·고급/ })); // 펼침
    expect(screen.getByLabelText(/RPS 워밍업/)).toHaveValue(null); // 처음 비어있음
    await user.type(screen.getByLabelText(/최소 윈도 RPS/), "50");
    expect(screen.getByLabelText(/RPS 워밍업/)).toHaveValue(3);
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
    await user.click(screen.getByRole("button", { name: /^실행$/ }));

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
    await user.click(screen.getByRole("button", { name: /^실행$/ }));

    await waitFor(() => expect(captured.body).toBeTruthy());
    const posted = JSON.parse(captured.body!);
    expect(posted.env).toEqual({ BASE_URL: "http://s", API_KEY: "k" });
  });
});

describe("RunDialog — 사유 블록 일반화 (T4 fix)", () => {
  it("접힌 진단 값이 invalid면 Run이 비활성이고 사유 블록에 이유가 보인다", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole("button", { name: /판정·고급/ }));
    const timeout = screen.getByLabelText(/HTTP 타임아웃/);
    await user.clear(timeout);
    await user.type(timeout, "601");
    await user.click(screen.getByRole("button", { name: /판정·고급/ })); // 접기 — 에러 p는 DOM에서 사라짐
    expect(screen.getByRole("button", { name: /^실행$/ })).toBeDisabled();
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("실행하려면 다음을 해결하세요:");
    expect(status).toHaveTextContent(/HTTP 타임아웃은 1 ~ 600초 사이/);
  });

  it("think time이 한 칸만 채워지면 접힌 상태에서도 사유 블록에 페이싱 이유가 보인다", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole("button", { name: /판정·고급/ }));
    await user.type(screen.getByLabelText(/think 최소/), "100");
    await user.click(screen.getByRole("button", { name: /판정·고급/ }));
    expect(screen.getByRole("button", { name: /^실행$/ })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(/페이싱\(think time\)/);
  });

  it("open 모드에선 잔존 think 값이 있어도 사유 블록이 뜨지 않는다", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole("button", { name: /판정·고급/ }));
    await user.type(screen.getByLabelText(/think 최소/), "100"); // 한 칸만 = thinkInvalid
    await user.click(screen.getByRole("button", { name: /판정·고급/ })); // 접기
    expect(screen.getByRole("status")).toBeInTheDocument(); // closed에선 사유 표시
    await user.click(screen.getByRole("radio", { name: /요청 속도 기준/ })); // open 전환
    expect(screen.queryByRole("status")).toBeNull(); // open에선 배너 없음
    expect(screen.getByRole("button", { name: /^실행$/ })).toBeEnabled();
  });
});

describe("RunDialog — closed+curve (Task 7+8)", () => {
  it("closed+curve 제출: vu_stages payload + ramp_down immediate", async () => {
    fetchMock.mockImplementation(() =>
      jsonResponse({
        id: "RVC1",
        scenario_id: "S1",
        scenario_yaml: "version: 1\nname: t\nsteps: []\n",
        status: "pending",
        profile: { vus: 0, ramp_up_seconds: 0, duration_seconds: 0 },
        env: {},
        started_at: null,
        ended_at: null,
        created_at: 1,
      }),
    );
    const user = userEvent.setup();
    const { onCreated } = renderDialog(false);

    // Switch to closed+curve
    await user.click(screen.getByRole("radio", { name: "곡선" }));
    // stage 행 입력
    await user.clear(screen.getByLabelText("stage target 0"));
    await user.type(screen.getByLabelText("stage target 0"), "50");
    await user.clear(screen.getByLabelText("stage duration 0"));
    await user.type(screen.getByLabelText("stage duration 0"), "30");
    // 즉시 줄이기 선택
    await user.click(screen.getByRole("radio", { name: /즉시 줄이기/ }));
    await user.click(screen.getByRole("button", { name: /^실행$/ }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("RVC1"));

    const call = fetchMock.mock.calls.find(
      ([url, init]) =>
        typeof url === "string" &&
        url.endsWith("/api/runs") &&
        (init as RequestInit | undefined)?.method === "POST",
    );
    expect(call).toBeDefined();
    const body = JSON.parse((call![1] as RequestInit).body as string);
    expect(body.profile.vu_stages).toEqual([{ target: 50, duration_seconds: 30 }]);
    expect(body.profile.ramp_down).toBe("immediate");
    // 곡선 총 길이 = sum(vu_stages); duration_seconds>0 또는 vus>0 + vu_stages면 서버 400 (controller 불변식)
    expect(body.profile.duration_seconds).toBe(0);
    expect(body.profile.vus).toBe(0);
    expect(body.profile.target_rps).toBeUndefined();
    expect(body.profile.max_in_flight).toBeUndefined();
    expect(body.profile.stages).toBeUndefined();
  });

  it("vu_stages 든 run 프리필이 closed+curve로 역도출되고 stage 행·rampDown이 시드된다", () => {
    renderWithInitial({
      profile: {
        vus: 0,
        duration_seconds: 0,
        ramp_up_seconds: 0,
        loop_breakdown_cap: 0,
        http_timeout_seconds: 30,
        measure_phases: false,
        data_binding: null,
        vu_stages: [{ target: 7, duration_seconds: 11 }],
        ramp_down: "immediate",
      },
      env: {},
    });
    expect(screen.getByRole("radio", { name: "곡선" })).toBeChecked();
    expect(screen.getByRole("radio", { name: /사용자 수 기준/ })).toBeChecked();
    expect(screen.getByLabelText("stage target 0")).toHaveValue(7);
    expect(screen.getByRole("radio", { name: /즉시 줄이기/ })).toBeChecked();
  });
});

describe("RunDialog — U1b 재구성 불변식", () => {
  it("payload byte-identical: 기본값 제출 payload가 재구성 전과 동일하다", async () => {
    fetchMock.mockImplementation(() =>
      jsonResponse({
        id: "RB1",
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

    await user.click(screen.getByRole("button", { name: /^실행$/ }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("RB1"));

    const call = fetchMock.mock.calls.find(
      ([url, init]) =>
        typeof url === "string" &&
        url.endsWith("/api/runs") &&
        (init as RequestInit | undefined)?.method === "POST",
    );
    expect(call).toBeDefined();
    const body = JSON.parse((call![1] as RequestInit).body as string);
    // 깊은 완전 일치(toEqual) — 재구성이 필드를 추가/누락하면 즉시 RED.
    // 기대 객체는 재구성 전 HEAD의 실제 payload 캡처로 확정(JSON.stringify가
    // undefined 필드(data_binding/criteria/think_*)를 생략한 결과 기준).
    expect(body).toEqual({
      scenario_id: "S1",
      profile: {
        vus: 2,
        duration_seconds: 5,
        ramp_up_seconds: 0,
        loop_breakdown_cap: 256,
        http_timeout_seconds: 30,
        measure_phases: false,
      },
      env: {},
    });
  });
});
