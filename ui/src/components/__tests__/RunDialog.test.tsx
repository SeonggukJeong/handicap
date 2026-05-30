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
    fetchMock.mockResolvedValue(
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
    fetchMock.mockResolvedValue(
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
    fetchMock.mockResolvedValue(
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
    fetchMock.mockResolvedValue(
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
