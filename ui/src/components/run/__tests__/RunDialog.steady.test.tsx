import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RunDialog } from "../RunDialog";
import { ProfileSchema } from "../../../api/schemas";
import type { RunPrefill } from "../../../api/runPrefill";

vi.mock("../VuSizingHelper", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../VuSizingHelper")>()),
  VuSizingHelper: () => null,
}));
vi.mock("../SlotSizingHelper", () => ({ SlotSizingHelper: () => null }));
vi.mock("../WorkerSizingHelper", () => ({ WorkerSizingHelper: () => null }));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockUsePoolWorkers = vi.fn<() => { data: any }>(() => ({ data: undefined }));
vi.mock("../../../api/hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../api/hooks")>();
  return { ...actual, usePoolWorkers: () => mockUsePoolWorkers() };
});

const fetchMock = vi.fn();

const RUN_RESPONSE = {
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

beforeEach(() => {
  fetchMock.mockReset();
  mockUsePoolWorkers.mockReturnValue({ data: undefined });
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation(() => jsonResponse(RUN_RESPONSE));
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function renderDialog(initial?: RunPrefill) {
  const onCreated = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={qc}>
      <RunDialog
        scenarioId="S1"
        hasLoop={true}
        scenario={null}
        initial={initial}
        onCreated={onCreated}
        onCancel={vi.fn()}
      />
    </QueryClientProvider>,
  );
  return { ...utils, onCreated };
}

function postedProfile() {
  const call = fetchMock.mock.calls.find(
    ([url, init]) =>
      typeof url === "string" &&
      url.endsWith("/api/runs") &&
      (init as RequestInit | undefined)?.method === "POST",
  );
  expect(call).toBeDefined();
  return JSON.parse((call![1] as RequestInit).body as string).profile;
}

async function toDetailed(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("radio", { name: "상세" }));
}

async function setNum(user: ReturnType<typeof userEvent.setup>, el: HTMLElement, v: string) {
  await user.clear(el);
  await user.type(el, v);
}

const num = (name: string | RegExp) => screen.getByRole("spinbutton", { name });

// 서버 정규화 모양: stages 두 칸 + target_rps null.
const openRampStored = {
  vus: 0,
  duration_seconds: 0,
  ramp_up_seconds: 0,
  target_rps: null,
  max_in_flight: 200,
  stages: [
    { target: 40, duration_seconds: 20 },
    { target: 40, duration_seconds: 40 },
  ],
  steady: { ramp_seconds: 20, hold_seconds: 40, discard_seconds: 5, target: 40 },
  loop_breakdown_cap: 256,
  http_timeout_seconds: 30,
  measure_phases: false,
  data_binding: null,
};

async function openFixedDetailed(user: ReturnType<typeof userEvent.setup>) {
  await toDetailed(user);
  await user.click(screen.getByRole("radio", { name: /도착률/ }));
}

describe("RunDialog — steady 칸 (상승·버림)", () => {
  it("도착률 고정 + 상승 → steady 페이로드", async () => {
    const user = userEvent.setup();
    const { onCreated } = renderDialog();
    await openFixedDetailed(user);
    await setNum(user, num(/도착률/), "40");
    await setNum(user, screen.getByLabelText(/테스트 시간/), "60");
    await setNum(user, num("상승 시간(초)"), "20");
    await setNum(user, num("앞부분 버림(초)"), "5");
    await user.click(screen.getByRole("button", { name: "실행하기" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("R1"));
    const p = postedProfile();
    expect(p.steady).toEqual({
      target: 40,
      ramp_seconds: 20,
      hold_seconds: 40,
      discard_seconds: 5,
    });
    expect(p.duration_seconds).toBe(0);
    expect(p).not.toHaveProperty("target_rps");
  });

  it("VU 고정 + 상승 → steady 페이로드", async () => {
    const user = userEvent.setup();
    const { onCreated } = renderDialog();
    await toDetailed(user);
    await setNum(user, screen.getByRole("spinbutton", { name: /동시 사용자/ }), "10");
    await setNum(user, screen.getByLabelText(/테스트 시간/), "60");
    await setNum(user, screen.getByLabelText(/점진 시작/), "10");
    await user.click(screen.getByRole("button", { name: "실행하기" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("R1"));
    const p = postedProfile();
    expect(p.ramp_up_seconds).toBe(10);
    expect(p.duration_seconds).toBe(60);
    expect(p.steady).toEqual({ ramp_seconds: 10, hold_seconds: 50, discard_seconds: 0 });
    expect(p.steady).not.toHaveProperty("target");
  });

  it("error면 실행 버튼이 꺼진다", async () => {
    const user = userEvent.setup();
    renderDialog();
    await openFixedDetailed(user);
    await setNum(user, screen.getByLabelText(/테스트 시간/), "12");
    await setNum(user, num("앞부분 버림(초)"), "10");
    expect(screen.getByRole("button", { name: "실행하기" })).toBeDisabled();
  });

  it("VU 상승만·성립 안 함은 제출된다", async () => {
    const user = userEvent.setup();
    const { onCreated } = renderDialog();
    await toDetailed(user);
    await setNum(user, screen.getByLabelText(/점진 시작/), "5");
    expect(screen.getByRole("button", { name: "실행하기" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "실행하기" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("R1"));
    const p = postedProfile();
    expect(p).not.toHaveProperty("steady");
    expect(p.ramp_up_seconds).toBe(5);
  });

  it("간단 모드에서 VU 상승을 넣고 도착률로 바꿔도 도착률 상승은 0", async () => {
    const user = userEvent.setup();
    const { onCreated } = renderDialog();
    await setNum(user, screen.getByLabelText(/점진 시작/), "10");
    await user.click(screen.getByRole("radio", { name: /도착률/ }));
    await user.click(screen.getByRole("button", { name: "실행하기" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("R1"));
    const p = postedProfile();
    expect(p).not.toHaveProperty("steady");
    expect(p).not.toHaveProperty("stages");
    expect(p).toHaveProperty("target_rps");
  });

  it("상세에서 넣은 버림은 간단 모드에서도 요약 줄로 보인다", async () => {
    const user = userEvent.setup();
    renderDialog();
    await toDetailed(user);
    await setNum(user, screen.getByLabelText(/테스트 시간/), "60");
    await setNum(user, num("앞부분 버림(초)"), "5");
    await user.click(screen.getByRole("radio", { name: "간단" }));
    expect(screen.getByText("유지 60초 · 리포트 기본 기준은 뒤 55초")).toBeInTheDocument();
    expect(screen.queryByText(/상승 0초/)).toBeNull();
  });

  it("간단 모드에서 숨은 steady 오류는 막힌 이유에 뜬다", async () => {
    const user = userEvent.setup();
    renderDialog();
    await openFixedDetailed(user);
    await setNum(user, screen.getByLabelText(/테스트 시간/), "60");
    await setNum(user, num("상승 시간(초)"), "100");
    await user.click(screen.getByRole("radio", { name: "간단" }));
    expect(screen.getByRole("button", { name: "실행하기" })).toBeDisabled();
    expect(
      within(screen.getByRole("status")).getByText(/상승이 실행 시간과 같거나 깁니다/),
    ).toBeInTheDocument();
  });

  it("steady 저장본 프리필", () => {
    renderDialog({ profile: ProfileSchema.parse(openRampStored), env: {} });
    expect(screen.getByRole("radio", { name: "상세" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: /도착률/ })).toBeChecked();
    expect(num(/도착률/)).toHaveValue(40);
    expect(screen.getByLabelText(/테스트 시간/)).toHaveValue(60);
    expect(num("상승 시간(초)")).toHaveValue(20);
    expect(num("앞부분 버림(초)")).toHaveValue(5);
  });

  it("steady_prefill_draws_fixed_shape: steady 저장본 프리필은 곡선이 아니라 고정 모양", () => {
    renderDialog({ profile: ProfileSchema.parse(openRampStored), env: {} });
    expect(screen.getByRole("img", { name: "부하 모양 미리보기" })).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /레이트 곡선 미리보기/ })).toBeNull();
  });

  it("VU 상승만 있는 다시 실행은 지금처럼 간단 모드", () => {
    renderDialog({
      profile: ProfileSchema.parse({
        vus: 5,
        duration_seconds: 60,
        ramp_up_seconds: 10,
        steady: { ramp_seconds: 10, hold_seconds: 50, discard_seconds: 0 },
      }),
      env: {},
    });
    expect(screen.getByRole("radio", { name: "간단" })).toHaveAttribute("aria-checked", "true");
  });

  it("프리셋 불러오기가 steady 칸을 채운다", async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith("/api/scenarios/S1/presets") && (!init || init.method === "GET")) {
        return Promise.resolve(
          jsonResponse({
            presets: [
              {
                id: "P1",
                name: "ramp",
                vus: 0,
                duration_seconds: 0,
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
            name: "ramp",
            profile: openRampStored,
            env: {},
            created_at: 1,
            updated_at: 1,
          }),
        );
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
    const user = userEvent.setup();
    renderDialog();
    await user.selectOptions(await screen.findByLabelText("프리셋 불러오기"), "P1");
    await waitFor(() => expect(num("상승 시간(초)")).toHaveValue(20));
    expect(screen.getByRole("radio", { name: /도착률/ })).toBeChecked();
    expect(num(/도착률/)).toHaveValue(40);
    expect(screen.getByLabelText(/테스트 시간/)).toHaveValue(60);
    expect(num("앞부분 버림(초)")).toHaveValue(5);
  });

  it("앞부분 버림에 음수·소수를 넣어도 잘못된 steady가 나가지 않는다", async () => {
    const user = userEvent.setup();
    renderDialog();
    await openFixedDetailed(user);
    await setNum(user, screen.getByLabelText(/테스트 시간/), "60");
    for (const v of ["2.5", "-3"]) {
      fireEvent.change(num("앞부분 버림(초)"), { target: { value: v } });
      expect(num("앞부분 버림(초)")).toHaveValue(Number(v));
      expect(screen.getByRole("button", { name: "실행하기" })).toBeDisabled();
      expect(screen.getByRole("alert")).toHaveTextContent(
        "상승·버림 초는 0 이상의 정수여야 합니다",
      );
      expect(num("앞부분 버림(초)")).toHaveAttribute("aria-invalid", "true");
    }
    await user.click(screen.getByRole("button", { name: "실행하기" }));
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith("/api/runs"))).toBe(false);
  });
});
