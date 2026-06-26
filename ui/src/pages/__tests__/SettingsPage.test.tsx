import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { SettingsPage } from "../SettingsPage";
import { ko } from "../../i18n/ko";
import { STARTUP_STALL_MS, MIDRUN_STALL_MS } from "../../api/runStall";
import { usePoolWorkers } from "../../api/hooks";

vi.mock("../../api/hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/hooks")>()),
  usePoolWorkers: vi.fn(),
}));

// `usePoolWorkers` returns a full React-Query result; we only need isSuccess/data.
// `as unknown as` avoids tsc-b "conversion may be a mistake" on the partial.
function mockPool(data: { pool_mode: boolean } | null) {
  vi.mocked(usePoolWorkers).mockReturnValue(
    (data
      ? { isSuccess: true, data: { ...data, workers: [] } }
      : { isSuccess: false, data: undefined }) as unknown as ReturnType<typeof usePoolWorkers>,
  );
}

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  mockPool(null);
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
        <SettingsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// Full fixture with ALL required fields (strict schema check — no absent fields)
const MUTABLE_ROW = {
  key: "worker_capacity_vus",
  label: "워커당 VU 수용량",
  group: "limits",
  value: 2000,
  default: 2000,
  min: 1,
  max: 1000000,
  unit: "VU",
  mutable: true,
  source: "default",
};

const OVERRIDE_ROW = {
  key: "dataset_max_rows",
  label: "데이터셋 최대 행 수",
  group: "limits",
  value: 500,
  default: 1000,
  min: 1,
  max: 100000,
  unit: "행",
  mutable: true,
  source: "override",
};

const READONLY_ROW = {
  key: "trace_body_cap_bytes",
  label: "응답 본문 보관 한도",
  group: "test_run",
  value: 4096,
  default: 4096,
  min: 0,
  max: 0,
  unit: "bytes",
  mutable: false,
  source: "readonly",
};

const KEEPALIVE_ROW = {
  key: "pool_keepalive_seconds",
  label: "풀 gRPC keepalive (서버측)",
  group: "limits",
  value: 20,
  default: 20,
  min: 0,
  max: 0,
  unit: "초",
  mutable: false,
  source: "readonly",
};

const SETTINGS_RESPONSE = {
  settings: [MUTABLE_ROW, OVERRIDE_ROW, READONLY_ROW],
};

describe("SettingsPage", () => {
  it("renders env groups, sub-headers, mutable desc, and readonly note", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(SETTINGS_RESPONSE));
    renderPage();

    // env group header
    expect(await screen.findByText(ko.opsSettings.groupCommon)).toBeInTheDocument();
    // sub-section headers within the common group (SETTINGS_RESPONSE has mutable + readonly commons)
    expect(screen.getByText(ko.opsSettings.subMutable)).toBeInTheDocument();
    expect(screen.getByText(ko.opsSettings.subReadonly)).toBeInTheDocument();
    // mutable row desc is always visible
    expect(screen.getByText(ko.opsSettings.desc.worker_capacity_vus)).toBeInTheDocument();
    // readonly row shows readonlyNote
    expect(screen.getAllByText(ko.opsSettings.readonlyNote).length).toBeGreaterThan(0);
    // applyNote banner
    expect(screen.getByText(ko.opsSettings.applyNote)).toBeInTheDocument();
  });

  it("clicking 저장 calls putSetting with the entered value", async () => {
    let putBody: unknown = null;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).endsWith("/api/settings") && (!init?.method || init.method === "GET")) {
        return Promise.resolve(jsonResponse(SETTINGS_RESPONSE));
      }
      if (String(url).includes("/api/settings/worker_capacity_vus") && init?.method === "PUT") {
        putBody = JSON.parse(String(init.body));
        return Promise.resolve(jsonResponse({ ...MUTABLE_ROW, value: 1500, source: "override" }));
      }
      // refetch after mutation
      return Promise.resolve(jsonResponse(SETTINGS_RESPONSE));
    });

    const user = userEvent.setup();
    renderPage();
    await screen.findByText(ko.opsSettings.groupCommon);

    // find the input for worker_capacity_vus
    const input = screen.getByLabelText(MUTABLE_ROW.label);
    await user.clear(input);
    await user.type(input, "1500");

    const saveBtn = screen.getAllByRole("button", { name: ko.opsSettings.save })[0];
    await user.click(saveBtn);

    await waitFor(() => expect(putBody).toEqual({ value: 1500 }));
  });

  it("clicking 기본값 복원 on an override row calls deleteSetting", async () => {
    let deleteCalled = false;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).endsWith("/api/settings") && (!init?.method || init.method === "GET")) {
        return Promise.resolve(jsonResponse(SETTINGS_RESPONSE));
      }
      if (String(url).includes("/api/settings/dataset_max_rows") && init?.method === "DELETE") {
        deleteCalled = true;
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.resolve(jsonResponse(SETTINGS_RESPONSE));
    });

    const user = userEvent.setup();
    renderPage();
    await screen.findByText(ko.opsSettings.groupCommon);

    const resetBtn = screen.getByRole("button", { name: ko.opsSettings.reset });
    await user.click(resetBtn);

    await waitFor(() => expect(deleteCalled).toBe(true));
  });

  it("out-of-range input disables 저장 and shows outOfRange hint (R11)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(SETTINGS_RESPONSE));
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(ko.opsSettings.groupCommon);

    // Enter a value below min (min=1)
    const input = screen.getByLabelText(MUTABLE_ROW.label);
    await user.clear(input);
    await user.type(input, "0");

    // The save button for this row should be disabled
    const saveBtn = screen.getAllByRole("button", { name: ko.opsSettings.save })[0];
    expect(saveBtn).toBeDisabled();

    // outOfRange hint visible
    expect(screen.getByText(ko.opsSettings.outOfRange)).toBeInTheDocument();
  });

  it("opens HelpTip (ⓘ) and shows effect text", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(SETTINGS_RESPONSE));
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(ko.opsSettings.groupCommon);

    // The help button for the first mutable row
    const helpBtns = screen.getAllByRole("button", { name: /도움말/ });
    await user.click(helpBtns[0]);

    // Effect text is split into block spans per line — getAllByText for any matching line
    const lines = screen.getAllByText(/VU를 더 몰아|워커를 더 많이/);
    expect(lines.length).toBeGreaterThan(0);
  });

  it("draft is cleared after 저장 succeeds — input reflects server value on refetch (Fix 1)", async () => {
    const UPDATED_ROW = { ...MUTABLE_ROW, value: 1500, source: "override" };
    let putCalled = false;
    // First GET returns original; after PUT, second GET returns updated value
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).endsWith("/api/settings") && (!init?.method || init.method === "GET")) {
        if (!putCalled) return Promise.resolve(jsonResponse(SETTINGS_RESPONSE));
        // Second GET after mutation: return updated value
        return Promise.resolve(
          jsonResponse({ settings: [UPDATED_ROW, OVERRIDE_ROW, READONLY_ROW] }),
        );
      }
      if (String(url).includes("/api/settings/worker_capacity_vus") && init?.method === "PUT") {
        putCalled = true;
        return Promise.resolve(jsonResponse(UPDATED_ROW));
      }
      return Promise.resolve(jsonResponse(SETTINGS_RESPONSE));
    });

    const user = userEvent.setup();
    renderPage();
    await screen.findByText(ko.opsSettings.groupCommon);

    const input = screen.getByLabelText(MUTABLE_ROW.label) as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "1500");

    const saveBtn = screen.getAllByRole("button", { name: ko.opsSettings.save })[0];
    await user.click(saveBtn);

    // After mutation + refetch, the draft should be cleared and the input reflects the
    // server-returned value (1500), not a stale draft.
    await waitFor(() => expect(input.value).toBe("1500"));
  });

  it("shows role=alert error banner when putSetting rejects (Fix 2)", async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).endsWith("/api/settings") && (!init?.method || init.method === "GET")) {
        return Promise.resolve(jsonResponse(SETTINGS_RESPONSE));
      }
      if (String(url).includes("/api/settings/worker_capacity_vus") && init?.method === "PUT") {
        return Promise.resolve(jsonResponse({ error: "서버 오류" }, 500));
      }
      return Promise.resolve(jsonResponse(SETTINGS_RESPONSE));
    });

    const user = userEvent.setup();
    renderPage();
    await screen.findByText(ko.opsSettings.groupCommon);

    const input = screen.getByLabelText(MUTABLE_ROW.label);
    await user.clear(input);
    await user.type(input, "999");

    const saveBtn = screen.getAllByRole("button", { name: ko.opsSettings.save })[0];
    await user.click(saveBtn);

    // An error alert should appear after the mutation fails
    await waitFor(() => {
      const alerts = screen.getAllByRole("alert");
      // At least one alert contains an error message (not the applyNote amber banner)
      const errorAlert = alerts.find((el) => el.textContent && el.textContent.includes("오류"));
      expect(errorAlert).toBeDefined();
    });
  });

  // Heartbeat rows fixture
  const HEARTBEAT_INTERVAL_ROW = {
    key: "pool_heartbeat_interval_seconds",
    label: "하트비트 ping 주기",
    group: "limits",
    value: 20,
    default: 10,
    min: 1,
    max: 3600,
    unit: "초",
    mutable: true,
    source: "override",
  };

  const HEARTBEAT_STALE_ROW_30 = {
    key: "pool_stale_timeout_seconds",
    label: "풀 stale 타임아웃",
    group: "limits",
    value: 30,
    default: 30,
    min: 2,
    max: 7200,
    unit: "초",
    mutable: true,
    source: "default",
  };

  const HEARTBEAT_STALE_ROW_60 = {
    ...HEARTBEAT_STALE_ROW_30,
    value: 60,
  };

  it("shows 2x margin hint when stale < 2x interval", async () => {
    // stale=30 < 2*20=40 → hint should appear
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        settings: [MUTABLE_ROW, HEARTBEAT_INTERVAL_ROW, HEARTBEAT_STALE_ROW_30, READONLY_ROW],
      }),
    );
    renderPage();
    expect(await screen.findByText(ko.opsSettings.heartbeatMarginHint)).toBeInTheDocument();
  });

  it("hides 2x margin hint when stale >= 2x interval", async () => {
    // stale=60 >= 2*20=40 → no hint
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        settings: [MUTABLE_ROW, HEARTBEAT_INTERVAL_ROW, HEARTBEAT_STALE_ROW_60, READONLY_ROW],
      }),
    );
    renderPage();
    await screen.findByText(ko.opsSettings.groupCommon);
    expect(screen.queryByText(ko.opsSettings.heartbeatMarginHint)).not.toBeInTheDocument();
  });

  it("empty interval draft does not hide 2x margin hint (reads as saved value, not 0)", async () => {
    // stale=30, interval saved=20; user clears the interval draft to "".
    // With the fix: empty draft → NaN → fallback to s.value=20 → 30 < 2*20=40 → hint shown.
    // Without fix: Number("")=0 → 30 >= 0 → hint hidden (bug).
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        settings: [MUTABLE_ROW, HEARTBEAT_INTERVAL_ROW, HEARTBEAT_STALE_ROW_30, READONLY_ROW],
      }),
    );
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(ko.opsSettings.heartbeatApplyNote);

    const intervalInput = screen.getByLabelText(HEARTBEAT_INTERVAL_ROW.label);
    await user.clear(intervalInput);
    // interval draft is now empty — hint should still be visible (saved value 20 used)
    expect(screen.getByText(ko.opsSettings.heartbeatMarginHint)).toBeInTheDocument();
  });

  it("shows heartbeat apply note when both heartbeat rows are present", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        settings: [MUTABLE_ROW, HEARTBEAT_INTERVAL_ROW, HEARTBEAT_STALE_ROW_30, READONLY_ROW],
      }),
    );
    renderPage();
    expect(await screen.findByText(ko.opsSettings.heartbeatApplyNote)).toBeInTheDocument();
  });

  const STARTUP_GRACE_ROW = {
    key: "run_startup_grace_seconds",
    label: "Run 시작 grace (startup 라이브니스)",
    group: "limits",
    value: 90,
    default: 90,
    min: 10,
    max: 3600,
    unit: "초",
    mutable: true,
    source: "default",
  };

  it("shows C stall thresholds as readonly rows sourced from runStall.ts", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(SETTINGS_RESPONSE));
    renderPage();

    // C 라벨(클라 리터럴) 렌더
    expect(await screen.findByText(ko.opsSettings.runMidrunStallLabel)).toBeInTheDocument();
    expect(screen.getByText(ko.opsSettings.runStartupStallLabel)).toBeInTheDocument();

    // 값은 runStall.ts 상수에서 직접(초 변환) — 120 초 / 15 초
    expect(screen.getByText(`${MIDRUN_STALL_MS / 1000} 초`)).toBeInTheDocument();
    expect(screen.getByText(`${STARTUP_STALL_MS / 1000} 초`)).toBeInTheDocument();
  });

  it("shows A/B grace as editable rows with description", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ settings: [STARTUP_GRACE_ROW, READONLY_ROW] }));
    renderPage();

    // mutable 섹션에 A 라벨 + 설명
    expect(await screen.findByText("Run 시작 grace (startup 라이브니스)")).toBeInTheDocument();
    expect(screen.getByText(ko.opsSettings.desc.run_startup_grace_seconds)).toBeInTheDocument();
    // 저장 버튼(편집 가능)
    expect(screen.getAllByRole("button", { name: ko.opsSettings.save }).length).toBeGreaterThan(0);
  });

  it("places reaper knobs in the pool group and common settings in the common group (R3)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        settings: [MUTABLE_ROW, HEARTBEAT_INTERVAL_ROW, HEARTBEAT_STALE_ROW_30, KEEPALIVE_ROW],
      }),
    );
    renderPage();
    await screen.findByText(ko.opsSettings.groupCommon);

    const poolRegion = screen.getByRole("region", { name: ko.opsSettings.groupPool });
    const commonRegion = screen.getByRole("region", { name: ko.opsSettings.groupCommon });

    // reaper 2종 → pool group
    expect(within(poolRegion).getByText(HEARTBEAT_INTERVAL_ROW.label)).toBeInTheDocument();
    expect(within(poolRegion).getByText(HEARTBEAT_STALE_ROW_30.label)).toBeInTheDocument();

    // worker_capacity_vus + pool_keepalive_seconds → common group (keepalive is NOT pool-only)
    expect(within(commonRegion).getByText(MUTABLE_ROW.label)).toBeInTheDocument();
    expect(within(commonRegion).getByText(KEEPALIVE_ROW.label)).toBeInTheDocument();

    // keepalive must NOT be in the pool group
    expect(within(poolRegion).queryByText(KEEPALIVE_ROW.label)).not.toBeInTheDocument();

    // R1: common group is rendered before the pool group (DOM order)
    const regions = screen.getAllByRole("region");
    expect(regions[0]).toBe(commonRegion);
    expect(regions[1]).toBe(poolRegion);
  });

  it("shows the pool group note (R4)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ settings: [MUTABLE_ROW, HEARTBEAT_INTERVAL_ROW, HEARTBEAT_STALE_ROW_30] }),
    );
    renderPage();
    const poolRegion = await screen.findByRole("region", { name: ko.opsSettings.groupPool });
    expect(within(poolRegion).getByText(ko.opsSettings.poolGroupNote)).toBeInTheDocument();
  });

  it("shows the env note on worker_capacity_vus and pool_keepalive_seconds (R6)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ settings: [MUTABLE_ROW, KEEPALIVE_ROW] }));
    renderPage();
    await screen.findByText(ko.opsSettings.groupCommon);
    expect(screen.getByText(ko.opsSettings.envNote.workerCapacityPoolIgnored)).toBeInTheDocument();
    expect(screen.getByText(ko.opsSettings.envNote.poolKeepaliveAllModes)).toBeInTheDocument();
  });

  it("shows the active-pool mode banner when pool_mode is true (R5)", async () => {
    mockPool({ pool_mode: true });
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ settings: [MUTABLE_ROW, HEARTBEAT_INTERVAL_ROW, HEARTBEAT_STALE_ROW_30] }),
    );
    renderPage();
    expect(await screen.findByText(ko.opsSettings.modeActivePool)).toBeInTheDocument();
    expect(screen.queryByText(ko.opsSettings.modeInactive)).not.toBeInTheDocument();
  });

  it("shows the inactive mode banner when pool_mode is false (R5)", async () => {
    mockPool({ pool_mode: false });
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ settings: [MUTABLE_ROW, HEARTBEAT_INTERVAL_ROW, HEARTBEAT_STALE_ROW_30] }),
    );
    renderPage();
    expect(await screen.findByText(ko.opsSettings.modeInactive)).toBeInTheDocument();
    expect(screen.queryByText(ko.opsSettings.modeActivePool)).not.toBeInTheDocument();
  });

  it("omits the mode banner while the pool query is unresolved/errored (R5 graceful)", async () => {
    // default beforeEach mock: { isSuccess: false } → no banner
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ settings: [MUTABLE_ROW, HEARTBEAT_INTERVAL_ROW, HEARTBEAT_STALE_ROW_30] }),
    );
    renderPage();
    await screen.findByText(ko.opsSettings.groupPool);
    expect(screen.queryByText(ko.opsSettings.modeActivePool)).not.toBeInTheDocument();
    expect(screen.queryByText(ko.opsSettings.modeInactive)).not.toBeInTheDocument();
  });
});
