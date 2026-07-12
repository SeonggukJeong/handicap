import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RunDialog } from "../RunDialog";
import { ko } from "../../i18n/ko";

// null 렌더 — 헬퍼의 렌더/미렌더는 LoadModelFields.test.tsx가 검증. 여기선 RunDialog 단위 경계 유지(헬퍼 hook fetch 차단).
// usePriorClosedRunAnchor의 실제 구현은 보존(importOriginal spread) — RunDialog가 이 hook을 직접 호출한다.
vi.mock("../VuSizingHelper", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../VuSizingHelper")>()),
  VuSizingHelper: () => null,
}));
vi.mock("../SlotSizingHelper", () => ({
  SlotSizingHelper: ({ onApply }: { onApply: (n: number) => void }) => (
    <button type="button" onClick={() => onApply(123)}>
      mock-apply-slots
    </button>
  ),
}));
vi.mock("../WorkerSizingHelper", () => ({
  WorkerSizingHelper: () => null,
}));

// usePoolWorkers를 모킹해 기존 테스트에서 fetch 호출 없이 data:undefined로 유지.
// 개별 풀-프리뷰 테스트에서 mockReturnValue로 덮어쓴다.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockUsePoolWorkers = vi.fn<() => { data: any }>(() => ({ data: undefined }));
vi.mock("../../api/hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/hooks")>();
  return { ...actual, usePoolWorkers: () => mockUsePoolWorkers() };
});

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  mockUsePoolWorkers.mockReturnValue({ data: undefined });
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

function setNativeValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function envSection() {
  return screen.getByRole("region", { name: /환경 변수/i });
}

async function toDetailed(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("radio", { name: "상세" }));
}

describe("RunDialog — 간단/상세 모드 토글 (T6)", () => {
  // R11: 간단 모드(기본) POST profile byte-identical 골든.
  // 간단 모드에서 숨겨진 loop_breakdown_cap/http_timeout_seconds/measure_phases 기본값이
  // POST payload에서 DROP되지 않음을 toEqual(exact)로 증명한다.
  const DEFAULT_SIMPLE_PROFILE = {
    loop_breakdown_cap: 256,
    http_timeout_seconds: 30,
    measure_phases: false,
    vus: 2,
    duration_seconds: 5,
    ramp_up_seconds: 0,
  };

  it("R11 golden: 간단 모드 기본 POST profile is byte-identical (toEqual)", async () => {
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
    // 간단 모드 기본값 — toDetailed 호출 없음
    await user.click(screen.getByRole("button", { name: "실행하기" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("R1"));

    const call = fetchMock.mock.calls.find(
      ([url, init]) =>
        typeof url === "string" &&
        url.endsWith("/api/runs") &&
        (init as RequestInit | undefined)?.method === "POST",
    );
    expect(call).toBeDefined();
    const body = JSON.parse((call![1] as RequestInit).body as string);
    expect(body.profile).toEqual(DEFAULT_SIMPLE_PROFILE);
    expect(body.env).toEqual({});
  });

  it("defaults to 간단; detailed-only sections absent", () => {
    renderDialog();
    expect(screen.getByRole("radio", { name: "간단" })).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByRole("button", { name: /판정·고급/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: /프로파일/i })).not.toBeInTheDocument();
  });

  it("상세 reveals profile + 판정·고급", async () => {
    const user = userEvent.setup();
    renderDialog();
    await toDetailed(user);
    expect(screen.getByRole("group", { name: /프로파일/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /판정·고급/ })).toBeInTheDocument();
  });

  it("SLO prefill opens 상세 (R2)", () => {
    renderWithInitial({
      profile: {
        vus: 2,
        duration_seconds: 5,
        ramp_up_seconds: 0,
        loop_breakdown_cap: 256,
        http_timeout_seconds: 30,
        measure_phases: false,
        data_binding: null,
        criteria: { max_p95_ms: 500 },
      },
      env: {},
    });
    expect(screen.getByRole("radio", { name: "상세" })).toHaveAttribute("aria-checked", "true");
  });

  it("env-override prefill opens 상세 (R2)", () => {
    renderWithInitial({
      profile: {
        vus: 2,
        duration_seconds: 5,
        ramp_up_seconds: 0,
        loop_breakdown_cap: 256,
        http_timeout_seconds: 30,
        measure_phases: false,
        data_binding: null,
      },
      env: { BASE_URL: "x" },
    });
    expect(screen.getByRole("radio", { name: "상세" })).toHaveAttribute("aria-checked", "true");
  });

  it("binding prefill opens 상세 (Fix-1a)", () => {
    renderWithInitial({
      profile: {
        vus: 2,
        duration_seconds: 5,
        ramp_up_seconds: 0,
        loop_breakdown_cap: 256,
        http_timeout_seconds: 30,
        measure_phases: false,
        data_binding: null,
        data_bindings: [{ dataset_id: "DS1", policy: "per_vu", mappings: [] }],
      },
      env: {},
    });
    expect(screen.getByRole("radio", { name: "상세" })).toHaveAttribute("aria-checked", "true");
  });

  it("바인딩 prefill → 간단 전환 시 applied count에 포함됨 (Fix-1c)", async () => {
    const user = userEvent.setup();
    renderWithInitial({
      profile: {
        vus: 2,
        duration_seconds: 5,
        ramp_up_seconds: 0,
        loop_breakdown_cap: 256,
        http_timeout_seconds: 30,
        measure_phases: false,
        data_binding: null,
        data_bindings: [{ dataset_id: "DS1", policy: "per_vu", mappings: [] }],
      },
      env: {},
    });
    // binding prefill → 상세로 열림 → 간단으로 전환
    await user.click(screen.getByRole("radio", { name: "간단" }));
    // binding 1개 → applied count에 포함 (Fix-1c)
    expect(screen.getByText("상세 설정 1개 적용됨")).toBeInTheDocument();
  });
});

describe("RunDialog — Section 프리미티브 구조 (B1)", () => {
  it("3개 번호 섹션 + 필수/선택 배지로 렌더한다", () => {
    renderDialog();
    expect(screen.getAllByText("부하 모델").length).toBeGreaterThanOrEqual(1); // Section title + sr-only legend 둘 다 존재
    expect(screen.getAllByText("환경").length).toBeGreaterThanOrEqual(1); // Section title + sr-only legend
    // 필수/선택 배지 (Badge 텍스트)
    expect(screen.getAllByText("필수").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("선택").length).toBeGreaterThanOrEqual(1);
  });

  it("부하 섹션 상단에 기본값 안내를 보인다", () => {
    renderDialog();
    expect(
      screen.getByText("기본값이 채워져 있어 바로 실행할 수 있습니다 — 대상에 맞게 조정하세요."),
    ).toBeInTheDocument();
  });
});

describe("RunDialog — Section 재구성 (R14②③④)", () => {
  it("상세 모드: 환경·측정·저장 독립 Section, '대상 설정' 없음, 측정이 판정·고급 앞 (R14②③④)", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole("radio", { name: "상세" }));
    expect(screen.getAllByText("환경").length).toBeGreaterThanOrEqual(1); // Section title + sr-only legend
    expect(screen.getAllByText("측정").length).toBeGreaterThanOrEqual(1); // 측정 Section eyebrow
    expect(screen.getAllByText("이 설정 저장").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("대상 설정")).not.toBeInTheDocument();
    // DOM 순서: 측정 eyebrow가 판정·고급 토글보다 앞
    const html = document.body.innerHTML;
    expect(html.indexOf("측정")).toBeLessThan(html.indexOf("판정·고급"));
  });
});

describe("RunDialog — env & ramp_up", () => {
  it("adds and removes env key/value pairs", async () => {
    const user = userEvent.setup();
    renderDialog();
    await toDetailed(user); // 환경 편집기는 상세 모드에서만 노출

    expect(within(envSection()).getByText(/환경 변수 없음/i)).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText("BASE_URL"), "BASE_URL");
    await user.click(within(envSection()).getByRole("button", { name: "추가" }));

    const keyInput = await screen.findByLabelText("환경 변수 키 0");
    const valueInput = screen.getByLabelText("환경 변수 값 0");
    expect(keyInput).toHaveValue("BASE_URL");

    await user.type(valueInput, "http://localhost:9090");
    expect(valueInput).toHaveValue("http://localhost:9090");

    await user.click(screen.getByRole("button", { name: /BASE_URL 환경변수 제거/i }));
    expect(within(envSection()).getByText(/환경 변수 없음/i)).toBeInTheDocument();
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
    await toDetailed(user); // 환경 편집기는 상세 모드에서만 노출

    const rampInput = screen.getByLabelText(/점진 시작/);
    await user.clear(rampInput);
    await user.type(rampInput, "2");

    await user.type(screen.getByPlaceholderText("BASE_URL"), "BASE_URL");
    await user.click(within(envSection()).getByRole("button", { name: "추가" }));
    await user.type(screen.getByLabelText("환경 변수 값 0"), "http://localhost:9090");

    await user.click(screen.getByRole("button", { name: "실행하기" }));

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
    await toDetailed(user); // 환경 편집기는 상세 모드에서만 노출

    await user.type(screen.getByLabelText("새 환경 변수 키"), "BASE_URL");
    await user.type(screen.getByLabelText("새 환경 변수 값"), "http://localhost:9090");
    await user.click(within(envSection()).getByRole("button", { name: "추가" }));

    expect(await screen.findByLabelText("환경 변수 키 0")).toHaveValue("BASE_URL");
    expect(screen.getByLabelText("환경 변수 값 0")).toHaveValue("http://localhost:9090");

    expect(screen.getByLabelText("새 환경 변수 키")).toHaveValue("");
    expect(screen.getByLabelText("새 환경 변수 값")).toHaveValue("");
  });

  it("disables Add when name is empty even if value is filled", async () => {
    const user = userEvent.setup();
    renderDialog();
    await toDetailed(user); // 환경 편집기는 상세 모드에서만 노출

    await user.type(screen.getByLabelText("새 환경 변수 값"), "http://localhost:9090");

    expect(within(envSection()).getByRole("button", { name: "추가" })).toBeDisabled();
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

    const runBtn = screen.getByRole("button", { name: "실행하기" });
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

    await user.click(screen.getByRole("button", { name: "실행하기" }));

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
    await toDetailed(user);
    await user.click(screen.getByRole("button", { name: /판정·고급/ })); // 접힌 그룹 펼침
    const cap = screen.getByLabelText(/루프 집계 상한/) as HTMLInputElement;
    await user.clear(cap);
    await user.type(cap, "10001");

    const runBtn = screen.getByRole("button", { name: "실행하기" });
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
    await toDetailed(user);
    await user.click(screen.getByRole("button", { name: /판정·고급/ })); // 접힌 그룹 펼침
    const cap = screen.getByLabelText(/루프 집계 상한/) as HTMLInputElement;
    await user.clear(cap);
    await user.type(cap, "0");
    await user.click(screen.getByRole("button", { name: "실행하기" }));

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
    await toDetailed(user);
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

    await user.click(screen.getByRole("button", { name: "실행하기" }));
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
    expect(screen.getByRole("spinbutton", { name: /동시 사용자/ })).toHaveValue(7);
    expect(screen.getByLabelText(/테스트 시간/)).toHaveValue(9);
    expect(screen.getByLabelText(/점진 시작/)).toHaveValue(3);
    expect(screen.getByLabelText(/루프 집계 상한/)).toHaveValue(128);
    expect(screen.getByLabelText(/HTTP 타임아웃/)).toHaveValue(120);
  });

  it("seeds env entries from initial.env", () => {
    renderWithInitial(initial);
    expect(screen.getByLabelText("환경 변수 키 0")).toHaveValue("BASE_URL");
    expect(screen.getByLabelText("환경 변수 값 0")).toHaveValue("http://x");
    expect(screen.getByLabelText("환경 변수 키 1")).toHaveValue("TOKEN");
    expect(screen.getByLabelText("환경 변수 값 1")).toHaveValue("abc");
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
    await toDetailed(user); // 저장 섹션은 상세-only
    await user.type(screen.getByLabelText("프리셋 이름"), "saved");
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
    await toDetailed(user); // 저장 섹션은 상세-only
    await user.type(screen.getByLabelText("프리셋 이름"), "dup");
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

    await toDetailed(user); // 이름변경 버튼은 상세-only
    // Load preset P1 to set loadedPresetId and reveal the rename button
    await user.selectOptions(await screen.findByLabelText("프리셋 불러오기"), "P1");
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

  it("1a: 프리셋 불러오기 라벨은 줄바꿈 방지 클래스를 가진다", async () => {
    mockPresets([{ id: "P1", name: "loadme" }]);
    renderDialog();
    // presets는 React Query로 비동기 fetch → findByText로 settle 대기
    const label = await screen.findByText("프리셋 불러오기");
    expect(label).toHaveClass("shrink-0");
    expect(label).toHaveClass("whitespace-nowrap");
  });

  it("1b: 프리셋을 불러오면 드롭다운에 표시되고, 폼을 수정하면 — 선택 —으로 복귀한다", async () => {
    const user = userEvent.setup();
    mockPresets([{ id: "P1", name: "loadme" }]);
    renderDialog();
    const select = (await screen.findByLabelText("프리셋 불러오기")) as HTMLSelectElement;
    await user.selectOptions(select, "P1");
    // 스냅샷은 post-paint effect에서 잡힘 → 비동기 단언
    await waitFor(() => expect(select.value).toBe("P1"));
    // 부하 폼 수정(VU) → 드롭다운이 "" (— 선택 —)로 복귀.
    // 정확-문자열 getByLabelText(ko.loadModel.vus="동시 사용자(VU)")는 타일 라벨("동시 사용자 (VU)", 공백)과
    // 정확매치 안 되므로 충돌 없음(Task 2 충돌은 *regex* getByLabelText만 해당).
    const vu = screen.getByLabelText(ko.loadModel.vus) as HTMLInputElement;
    // setNativeValue의 raw dispatchEvent는 act() 미경유 — usePriorClosedRunAnchor 백그라운드
    // 쿼리(useScenarioRuns/useRunReport)가 settle되며 내는 업데이트가 이 시점과 겹치면 act() 밖으로
    // 샌다. act()로 감싸면 그 갱신까지 같은 동기 플러시에 포함돼 경고가 사라진다(대신 위/아래의
    // 모든 await 지점은 RTL이 자체 act-wrap하므로, 테스트 전체에서 act 커버리지가 끊기는 지점이 없다).
    act(() => {
      setNativeValue(vu, "999");
    });
    await waitFor(() => expect(select.value).toBe(""));
  });

  it("1b 회귀가드: 불러온 뒤 폼을 수정해도 이름 변경/프리셋 삭제 버튼이 남는다 (loadedPresetId 미클리어)", async () => {
    const user = userEvent.setup();
    mockPresets([{ id: "P1", name: "loadme" }]);
    renderDialog();
    await toDetailed(user); // 이름변경/삭제 버튼은 상세-only 저장 섹션
    await user.selectOptions(await screen.findByLabelText("프리셋 불러오기"), "P1");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "이름 변경" })).toBeInTheDocument(),
    );
    const vu = screen.getByLabelText(ko.loadModel.vus) as HTMLInputElement;
    // act()로 감싸는 이유는 위 1b와 동일(usePriorClosedRunAnchor 백그라운드 쿼리 settle 갱신을
    // 같은 동기 플러시에 포함).
    act(() => {
      setNativeValue(vu, "999");
    });
    // 수정 후에도 버튼 잔존
    expect(screen.getByRole("button", { name: "이름 변경" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "프리셋 삭제" })).toBeInTheDocument();
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
    expect(await screen.findByLabelText("프리셋 불러오기")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "heavy" })).toBeInTheDocument();
  });

  it("loads a preset's profile + env into the form on selection", async () => {
    const user = userEvent.setup();
    mockPresets();
    renderPresetDialog();
    await toDetailed(user); // 환경 편집기(override 행)는 상세 모드에서만 노출
    await user.selectOptions(await screen.findByLabelText("프리셋 불러오기"), "P1");
    await waitFor(() =>
      expect(screen.getByRole("spinbutton", { name: /동시 사용자/ })).toHaveValue(50),
    );
    expect(screen.getByLabelText(/테스트 시간/)).toHaveValue(60);
    expect(screen.getByLabelText(/점진 시작/)).toHaveValue(5);
    expect(screen.getByLabelText("환경 변수 키 0")).toHaveValue("BASE_URL");
    expect(screen.getByLabelText("환경 변수 값 0")).toHaveValue("http://heavy");
  });

  it("바인딩 있는 프리셋 로드 → 간단이었어도 상세로 전환됨 (Fix-1b)", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith("/api/scenarios/S1/presets") && (!init || init.method === "GET")) {
        return Promise.resolve(
          jsonResponse({
            presets: [
              {
                id: "PB",
                name: "with-binding",
                vus: 2,
                duration_seconds: 5,
                created_at: 1,
                updated_at: 1,
              },
            ],
          }),
        );
      }
      if (url.endsWith("/api/presets/PB")) {
        return Promise.resolve(
          jsonResponse({
            id: "PB",
            scenario_id: "S1",
            name: "with-binding",
            profile: {
              vus: 2,
              duration_seconds: 5,
              ramp_up_seconds: 0,
              loop_breakdown_cap: 256,
              data_binding: null,
              data_bindings: [{ dataset_id: "DS1", policy: "per_vu", mappings: [] }],
            },
            env: {},
            created_at: 1,
            updated_at: 1,
          }),
        );
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
    renderPresetDialog();
    // 시작은 간단 모드
    expect(screen.getByRole("radio", { name: "간단" })).toHaveAttribute("aria-checked", "true");
    // 바인딩 있는 프리셋 로드
    await user.selectOptions(await screen.findByLabelText("프리셋 불러오기"), "PB");
    // Fix-1b: 상세 모드로 전환됐어야 함
    await waitFor(() => {
      expect(screen.getByRole("radio", { name: "상세" })).toHaveAttribute("aria-checked", "true");
    });
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
    await toDetailed(user);
    await user.click(screen.getByRole("button", { name: /판정·고급/ }));
    await user.type(screen.getByLabelText(/최대 p95/), "500");
    await user.type(screen.getByLabelText(/최대 에러율/), "1");

    await user.click(screen.getByRole("button", { name: "실행하기" }));
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
    await toDetailed(user);
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
    await toDetailed(user);
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

    await user.click(screen.getByRole("button", { name: "실행하기" }));
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
    await toDetailed(user);
    await user.click(screen.getByRole("button", { name: /판정·고급/ }));
    await user.type(screen.getByLabelText(/think 최소/), "100");
    await user.type(screen.getByLabelText(/think 최대/), "500");
    await user.type(screen.getByLabelText(/think 시드/), "7");

    await user.click(screen.getByRole("button", { name: "실행하기" }));
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

    await user.click(screen.getByRole("button", { name: "실행하기" }));
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
    await toDetailed(user);
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
    await user.click(screen.getByRole("button", { name: "실행하기" }));
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
    expect(screen.getByRole("radio", { name: /도착률/ })).toBeChecked();
    expect(screen.getByRole("spinbutton", { name: /도착률/i })).toHaveValue(750);
    expect(screen.getByLabelText(/동시 요청 상한/)).toHaveValue(400);
  });

  it("shows error message and aria-describedby when target_rps is invalid", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole("radio", { name: /도착률/ }));

    const targetRpsInput = screen.getByRole("spinbutton", { name: /도착률/i });
    await user.clear(targetRpsInput);
    // Empty value → invalid
    expect(
      screen.getByText(/도착률\(초당 반복\)은 1 ~ 1,000,000 사이여야 합니다/),
    ).toBeInTheDocument();
    expect(targetRpsInput).toHaveAttribute("aria-describedby", "target-rps-error");
    expect(screen.getByRole("button", { name: "실행하기" })).toBeDisabled();
  });

  it("shows error message and aria-describedby when max_in_flight is invalid", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole("radio", { name: /도착률/ }));

    const maxInFlightInput = screen.getByLabelText(/동시 요청 상한/);
    await user.clear(maxInFlightInput);
    // Empty value → invalid
    expect(screen.getByText(/동시 요청 상한은 1 ~ 10,000 사이여야 합니다/)).toBeInTheDocument();
    expect(maxInFlightInput).toHaveAttribute("aria-describedby", "max-in-flight-error");
    expect(screen.getByRole("button", { name: "실행하기" })).toBeDisabled();
  });

  it("load-model radio group is wrapped in a fieldset with a legend", () => {
    renderDialog();
    // 내부 LoadModelFields fieldset accessible name = "부하 모델" 정확히 (sr-only legend)
    // 외부 Section fieldset accessible name = "부하 모델필수" (title+badge) — 겹침 없음
    const fieldset = screen.getByRole("group", { name: "부하 모델" });
    expect(fieldset.tagName).toBe("FIELDSET");
    expect(within(fieldset).getByRole("radio", { name: /동시 사용자 \(VU\)/ })).toBeInTheDocument();
    expect(within(fieldset).getByRole("radio", { name: /도착률/ })).toBeInTheDocument();
  });

  it("open-loop mode shows target_rps + max_in_flight and gates empty max_in_flight", async () => {
    const user = userEvent.setup();
    renderDialog();

    // Switch to open-loop
    await user.click(screen.getByRole("radio", { name: /도착률/ }));

    // open-loop fields are visible
    expect(screen.getByRole("spinbutton", { name: /도착률/i })).toBeInTheDocument();

    // Fill in target_rps so the only missing piece is max_in_flight
    const targetRpsInput = screen.getByRole("spinbutton", { name: /도착률/i });
    await user.clear(targetRpsInput);
    await user.type(targetRpsInput, "100");

    // max_in_flight should be visible
    const cap = screen.getByLabelText(/동시 요청 상한/);
    expect(cap).toBeInTheDocument();

    // Clear max_in_flight → Run button should be disabled
    await user.clear(cap);
    expect(screen.getByRole("button", { name: "실행하기" })).toBeDisabled();
  });

  it("closed-loop mode is default and shows VUs/ramp-up inputs", () => {
    renderDialog();
    expect(screen.getByRole("radio", { name: /동시 사용자 \(VU\)/ })).toBeChecked();
    expect(screen.getByRole("spinbutton", { name: /동시 사용자/ })).toBeInTheDocument();
    expect(screen.getByLabelText(/점진 시작/)).toBeInTheDocument();
  });

  it("hides vus and ramp-up in open-loop mode and shows duration", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole("radio", { name: /도착률/ }));
    expect(screen.queryByRole("spinbutton", { name: /동시 사용자/ })).not.toBeInTheDocument();
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
    await toDetailed(user);
    await user.click(screen.getByRole("radio", { name: /도착률/ }));
    await user.click(screen.getByRole("radio", { name: "곡선" }));
    // default seeded 1 row → set its target/duration
    await user.clear(screen.getByLabelText("스테이지 0 목표"));
    await user.type(screen.getByLabelText("스테이지 0 목표"), "200");
    await user.clear(screen.getByLabelText("스테이지 0 지속시간"));
    await user.type(screen.getByLabelText("스테이지 0 지속시간"), "30");
    await user.clear(screen.getByLabelText(/동시 요청 상한/));
    await user.type(screen.getByLabelText(/동시 요청 상한/), "50");
    await user.click(screen.getByRole("button", { name: "실행하기" }));
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
    await toDetailed(user);
    await user.click(screen.getByRole("radio", { name: /도착률/ }));
    await user.click(screen.getByRole("radio", { name: "곡선" }));
    expect(screen.getAllByLabelText(/스테이지.*목표/i)).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: /단계 추가/ }));
    expect(screen.getAllByLabelText(/스테이지.*목표/i)).toHaveLength(2);
    await user.click(screen.getAllByRole("button", { name: /스테이지.*제거/i })[1]);
    expect(screen.getAllByLabelText(/스테이지.*목표/i)).toHaveLength(1);
  });

  it("curve mode: Run disabled when all targets are 0", async () => {
    const user = userEvent.setup();
    renderDialog();
    await toDetailed(user);
    await user.click(screen.getByRole("radio", { name: /도착률/ }));
    await user.click(screen.getByRole("radio", { name: "곡선" }));
    await user.clear(screen.getByLabelText("스테이지 0 목표"));
    await user.type(screen.getByLabelText("스테이지 0 목표"), "0");
    expect(screen.getByRole("button", { name: "실행하기" })).toBeDisabled();
  });

  it("closed+curve: Run disabled when all targets are 0 (stagesInvalid 게이트)", async () => {
    const user = userEvent.setup();
    renderDialog();
    await toDetailed(user);
    // closed가 기본 — 곡선만 전환 (동시 사용자(VU) 유지)
    await user.click(screen.getByRole("radio", { name: "곡선" }));
    await user.clear(screen.getByLabelText("스테이지 0 목표"));
    await user.type(screen.getByLabelText("스테이지 0 목표"), "0");
    expect(screen.getByRole("button", { name: "실행하기" })).toBeDisabled();
  });

  it("open+fixed: 슬롯 헬퍼 적용 → 동시 요청 상한 입력에 반영", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole("radio", { name: /도착률/ }));
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
    expect(screen.getByLabelText("스테이지 0 목표")).toHaveValue(100);
  });

  it("curve mode: shows inline helpers for target, duration, and max in-flight", async () => {
    const user = userEvent.setup();
    renderDialog();
    await toDetailed(user);
    await user.click(screen.getByRole("radio", { name: /도착률/ }));
    await user.click(screen.getByRole("radio", { name: "곡선" }));
    expect(screen.getByText(/각 단계가 끝날 때의 목표 도착률\(초당 반복\)/)).toBeInTheDocument();
    expect(screen.getByText(/이 단계가 지속되는 시간/)).toBeInTheDocument();
    expect(screen.getByText(/동시 요청 상한 — /)).toBeInTheDocument();
  });

  it("curve mode: selecting a load-shape template seeds stages", async () => {
    const user = userEvent.setup();
    renderDialog();
    await toDetailed(user);
    await user.click(screen.getByRole("radio", { name: /도착률/ }));
    await user.click(screen.getByRole("radio", { name: "곡선" }));
    // default seed is a single row
    expect(screen.getAllByLabelText(/스테이지.*목표/i)).toHaveLength(1);
    await user.selectOptions(screen.getByLabelText(/부하 모양/), "spike");
    expect(screen.getAllByLabelText(/스테이지.*목표/i).length).toBeGreaterThan(1);
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

    await user.click(screen.getByRole("radio", { name: /도착률/ }));

    const durationInput = screen.getByLabelText(/테스트 시간/);
    await user.clear(durationInput);
    await user.type(durationInput, "10");

    await user.clear(screen.getByRole("spinbutton", { name: /도착률/i }));
    await user.type(screen.getByRole("spinbutton", { name: /도착률/i }), "500");

    await user.clear(screen.getByLabelText(/동시 요청 상한/));
    await user.type(screen.getByLabelText(/동시 요청 상한/), "200");

    await user.click(screen.getByRole("button", { name: "실행하기" }));
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
  it("2차 축 '프로파일' fieldset이 상세에서 보인다", async () => {
    const user = userEvent.setup();
    renderDialog();
    await toDetailed(user);
    expect(screen.getByRole("group", { name: /프로파일/i })).toBeInTheDocument();
  });

  it("closed 모드에서 곡선 라디오가 활성화돼 선택 가능 (곧 지원 제거)", async () => {
    const user = userEvent.setup();
    renderDialog();
    await toDetailed(user);
    const curve = screen.getByRole("radio", { name: "곡선" });
    expect(curve).toBeEnabled();
    await user.click(curve);
    expect(curve).toBeChecked();
  });

  it("open→곡선→closed 전환 시 rateMode가 유지된다 (eager reset 제거)", async () => {
    const user = userEvent.setup();
    renderDialog();
    await toDetailed(user);
    await user.click(screen.getByRole("radio", { name: /도착률/ }));
    await user.click(screen.getByRole("radio", { name: "곡선" }));
    expect(screen.getByRole("radio", { name: "곡선" })).toBeChecked();
    await user.click(screen.getByRole("radio", { name: /동시 사용자 \(VU\)/ }));
    // closed+curve는 이제 유효한 모드 — closed로 이동해도 curve가 유지된다
    expect(screen.getByRole("radio", { name: "곡선" })).toBeChecked();
  });

  it("각 모드에서 HTTP timeout 입력은 정확히 1개", async () => {
    const user = userEvent.setup();
    renderDialog();
    await toDetailed(user);
    await user.click(screen.getByRole("button", { name: /판정·고급/ })); // 접힌 그룹 펼침
    expect(screen.getAllByLabelText(/HTTP 타임아웃/)).toHaveLength(1); // closed
    await user.click(screen.getByRole("radio", { name: /도착률/ }));
    expect(screen.getAllByLabelText(/HTTP 타임아웃/)).toHaveLength(1); // open+fixed
    await user.click(screen.getByRole("radio", { name: "곡선" }));
    expect(screen.getAllByLabelText(/HTTP 타임아웃/)).toHaveLength(1); // open+curve
  });
});

describe("RunDialog — HTTP timeout (S-A)", () => {
  it("disables Run and shows error when http_timeout_seconds is out of range", async () => {
    const user = userEvent.setup();
    renderDialog();
    await toDetailed(user);
    await user.click(screen.getByRole("button", { name: /판정·고급/ })); // 접힌 그룹 펼침
    const timeout = screen.getByLabelText(/HTTP 타임아웃/) as HTMLInputElement;
    await user.clear(timeout);
    await user.type(timeout, "601");

    const runBtn = screen.getByRole("button", { name: "실행하기" });
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
    await toDetailed(user);
    await user.click(screen.getByRole("button", { name: /판정·고급/ })); // 접힌 그룹 펼침
    const timeout = screen.getByLabelText(/HTTP 타임아웃/) as HTMLInputElement;
    expect(timeout.value).toBe("30");
    await user.clear(timeout);
    await user.type(timeout, "45");

    await user.click(screen.getByRole("button", { name: "실행하기" }));
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
    await toDetailed(user);
    await user.click(screen.getByRole("button", { name: /판정·고급/ })); // 접힌 섹션 펼침
    await user.type(screen.getByLabelText(/최대 5xx 비율/), "2"); // 2% → 0.02
    await user.type(screen.getByLabelText(/최대 5xx 수/), "0");
    await user.type(screen.getByLabelText(/최소 윈도 RPS/), "50");

    await user.click(screen.getByRole("button", { name: "실행하기" }));
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
    await toDetailed(user);
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
    await toDetailed(user); // 베이스 변수 목록 및 override 편집기는 상세 모드에서만 노출
    // wait for the environments list to load before selecting
    await screen.findByRole("option", { name: "staging" });
    await user.selectOptions(screen.getByLabelText("환경 선택"), "E1");
    await screen.findByText("BASE_URL");
    // override BASE_URL via the add row
    await user.type(screen.getByLabelText("새 환경 변수 키"), "BASE_URL");
    await user.type(screen.getByLabelText("새 환경 변수 값"), "http://override");
    await user.click(
      within(screen.getByRole("region", { name: /환경 변수/i })).getByRole("button", {
        name: /^추가$/i,
      }),
    );
    await user.click(screen.getByRole("button", { name: "실행하기" }));

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
    await toDetailed(user); // 베이스 변수 목록 및 override 편집기는 상세 모드에서만 노출
    // wait for the environments list to load before selecting
    await screen.findByRole("option", { name: "staging" });
    await user.selectOptions(screen.getByLabelText("환경 선택"), "E1");
    // add a standalone override
    await user.type(screen.getByLabelText("새 환경 변수 키"), "TOKEN");
    await user.type(screen.getByLabelText("새 환경 변수 값"), "t1");
    await user.click(
      within(screen.getByRole("region", { name: /환경 변수/i })).getByRole("button", {
        name: /^추가$/i,
      }),
    );
    expect(await screen.findByLabelText("환경 변수 키 0")).toHaveValue("TOKEN");
    // switch to E2 — override survives
    await user.selectOptions(screen.getByLabelText("환경 선택"), "E2");
    expect(screen.getByLabelText("환경 변수 키 0")).toHaveValue("TOKEN");
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
    await toDetailed(user); // 베이스 변수 목록은 상세 모드에서만 노출
    await screen.findByRole("option", { name: "staging" });
    await user.selectOptions(screen.getByLabelText("환경 선택"), "E1");
    await screen.findByText("BASE_URL"); // base list loaded
    // no overrides added — submit straight away
    await user.click(screen.getByRole("button", { name: "실행하기" }));

    await waitFor(() => expect(captured.body).toBeTruthy());
    const posted = JSON.parse(captured.body!);
    expect(posted.env).toEqual({ BASE_URL: "http://s", API_KEY: "k" });
  });
});

describe("RunDialog — 사유 블록 일반화 (T4 fix)", () => {
  it("접힌 진단 값이 invalid면 Run이 비활성이고 사유 블록에 이유가 보인다", async () => {
    const user = userEvent.setup();
    renderDialog();
    await toDetailed(user);
    await user.click(screen.getByRole("button", { name: /판정·고급/ }));
    const timeout = screen.getByLabelText(/HTTP 타임아웃/);
    await user.clear(timeout);
    await user.type(timeout, "601");
    await user.click(screen.getByRole("button", { name: /판정·고급/ })); // 접기 — 에러 p는 DOM에서 사라짐
    expect(screen.getByRole("button", { name: "실행하기" })).toBeDisabled();
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("실행하려면 다음을 해결하세요:");
    expect(status).toHaveTextContent(/HTTP 타임아웃은 1 ~ 600초 사이/);
  });

  it("think time이 한 칸만 채워지면 접힌 상태에서도 사유 블록에 페이싱 이유가 보인다", async () => {
    const user = userEvent.setup();
    renderDialog();
    await toDetailed(user);
    await user.click(screen.getByRole("button", { name: /판정·고급/ }));
    await user.type(screen.getByLabelText(/think 최소/), "100");
    await user.click(screen.getByRole("button", { name: /판정·고급/ }));
    expect(screen.getByRole("button", { name: "실행하기" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(/페이싱\(think time\)/);
  });

  it("open 모드에선 잔존 think 값이 있어도 사유 블록이 뜨지 않는다", async () => {
    const user = userEvent.setup();
    renderDialog();
    await toDetailed(user);
    await user.click(screen.getByRole("button", { name: /판정·고급/ }));
    await user.type(screen.getByLabelText(/think 최소/), "100"); // 한 칸만 = thinkInvalid
    await user.click(screen.getByRole("button", { name: /판정·고급/ })); // 접기
    expect(screen.getByRole("status")).toBeInTheDocument(); // closed에선 사유 표시
    await user.click(screen.getByRole("radio", { name: /도착률/ })); // open 전환
    expect(screen.queryByRole("status")).toBeNull(); // open에선 배너 없음
    expect(screen.getByRole("button", { name: "실행하기" })).toBeEnabled();
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
    await toDetailed(user);
    // Switch to closed+curve
    await user.click(screen.getByRole("radio", { name: "곡선" }));
    // stage 행 입력
    await user.clear(screen.getByLabelText("스테이지 0 목표"));
    await user.type(screen.getByLabelText("스테이지 0 목표"), "50");
    await user.clear(screen.getByLabelText("스테이지 0 지속시간"));
    await user.type(screen.getByLabelText("스테이지 0 지속시간"), "30");
    // 즉시 줄이기 선택
    await user.click(screen.getByRole("radio", { name: /즉시 줄이기/ }));
    await user.click(screen.getByRole("button", { name: "실행하기" }));
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
    expect(screen.getByRole("radio", { name: /동시 사용자 \(VU\)/ })).toBeChecked();
    expect(screen.getByLabelText("스테이지 0 목표")).toHaveValue(7);
    expect(screen.getByRole("radio", { name: /즉시 줄이기/ })).toBeChecked();
  });
});

// ───────────────────────────────────────────────────────────────
// T7: 프리셋 동선·측정 노출·진단 표면 (R5·R6·R7·R9·R18)
// ───────────────────────────────────────────────────────────────

/**
 * renderWithPresets — renderDialog 미러 + presets fetch 시드.
 * usePresets(scenarioId)→GET /api/scenarios/{id}/presets→{ presets:[...] } (not bare array).
 * PresetSummarySchema 6필드 전부 필수.
 */
function renderWithPresets() {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (
      String(url).includes("/api/scenarios/S1/presets") &&
      (!init || !init.method || init.method === "GET")
    ) {
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
    return Promise.resolve(jsonResponse({ presets: [] }));
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
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

describe("RunDialog — 프리셋 동선·측정·진단 (T7 R5·R6·R7·R9·R18)", () => {
  it("preset load strip은 부하 모델 fieldset 앞; save block은 상세-only (R7)", async () => {
    const user = userEvent.setup();
    renderWithPresets();
    // 프리셋 목록 로드 대기
    const loadSelect = await screen.findByLabelText("프리셋 불러오기");
    // 간단 모드: 저장 버튼 없어야
    expect(screen.queryByRole("button", { name: /프리셋으로 저장/ })).not.toBeInTheDocument();
    // DOM 순서: load strip이 부하 모델 fieldset보다 앞 (exact name — Section은 "부하 모델필수")
    const loadModelFieldset = screen.getByRole("group", { name: "부하 모델" });
    expect(
      // DOCUMENT_POSITION_FOLLOWING(4) — loadModelFieldset이 loadSelect 뒤에 오면 true
      loadSelect.compareDocumentPosition(loadModelFieldset) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // 상세 모드: 저장 버튼 보임
    await toDetailed(user);
    expect(screen.getByRole("button", { name: /프리셋으로 저장/ })).toBeInTheDocument();
  });

  it("측정 토글이 판정·고급 바깥 상세 섹션에 표시됨 (R9)", async () => {
    const user = userEvent.setup();
    renderDialog();
    await toDetailed(user);
    // 판정·고급 Section은 기본 접힘 — 펼치지 않아도 '단계 분해' 라벨이 보여야
    expect(screen.getByRole("button", { name: /판정·고급/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.getByText(/단계 분해/)).toBeInTheDocument();
  });

  it("간단 모드: 상세 값(SLO) 적용 시 '상세 설정 N개 적용됨' 표시 (R6)", async () => {
    const user = userEvent.setup();
    renderWithInitial({
      profile: {
        vus: 2,
        duration_seconds: 5,
        ramp_up_seconds: 0,
        loop_breakdown_cap: 256,
        http_timeout_seconds: 30,
        measure_phases: false,
        data_binding: null,
        criteria: { max_p95_ms: 500 },
      },
      env: {},
    });
    // criteria → 상세로 열림 → 간단으로 전환
    await user.click(screen.getByRole("radio", { name: "간단" }));
    // max_p95_ms 1개만 활성 → 정확히 1개 (칩은 이제 button — accessible name이 aria-hidden ⚙ 제외)
    expect(screen.getByRole("button", { name: /상세 설정 1개 적용됨/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /상세 설정 2개 적용됨/ })).not.toBeInTheDocument();
  });

  it("측정 토글(switch) on → measure_phases:true (R13)", async () => {
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
    await user.click(screen.getByRole("radio", { name: "상세" }));
    await user.click(screen.getByRole("switch", { name: /응답 시간 단계 분해/ }));
    await user.click(screen.getByRole("button", { name: "실행하기" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("R1"));

    const call = fetchMock.mock.calls.find(
      ([url, init]) =>
        typeof url === "string" &&
        url.endsWith("/api/runs") &&
        (init as RequestInit | undefined)?.method === "POST",
    );
    expect(call).toBeDefined();
    const body = JSON.parse((call![1] as RequestInit).body as string);
    expect(body.profile.measure_phases).toBe(true);
  });

  it("측정 HelpTip은 바깥 요약(measureDesc)보다 심화 내용(measureHelp)을 담는다", async () => {
    const user = userEvent.setup();
    renderDialog();
    await toDetailed(user);
    // HelpTip 버튼 열기 (측정 섹션의 ⓘ — label = measureTitle)
    await user.click(screen.getByRole("button", { name: ko.runDialog.measureTitle }));
    const note = await screen.findByRole("note");
    expect(note).toHaveTextContent("처리량은 더 오르지 않습니다"); // 심화 문구 식별 구절
    expect(note.textContent).not.toBe(ko.runDialog.measureDesc); // 한 줄 요약과 다름
  });

  it("간단 모드: measure_phases ON이 applied count에 포함됨 (R6·F1 이중계수 방지)", async () => {
    const user = userEvent.setup();
    renderDialog();
    await toDetailed(user);
    // 측정 토글 switch ON
    await user.click(screen.getByRole("switch", { name: /응답 시간 단계 분해/ }));
    // 간단 전환
    await user.click(screen.getByRole("radio", { name: "간단" }));
    // measure 단독 → 정확히 1개 (이중계수 시 2개가 되어 이 단언이 실패)
    expect(screen.getByRole("button", { name: /상세 설정 1개 적용됨/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /상세 설정 2개 적용됨/ })).not.toBeInTheDocument();
  });

  it("간단 모드 기본(count 0): 적용 칩 보이고 클릭하면 상세로 (R3)", async () => {
    const user = userEvent.setup();
    renderDialog(); // 기본 = 간단·count 0
    const chip = screen.getByRole("button", { name: /상세 설정 0개 적용됨/ });
    expect(chip).toBeInTheDocument();
    await user.click(chip);
    expect(screen.getByRole("radio", { name: "상세" })).toBeChecked();
  });

  it("간단 모드: 숨겨진 invalid http_timeout이 blockedReasons에 표시됨 (R5)", async () => {
    const user = userEvent.setup();
    renderDialog();
    await toDetailed(user);
    await user.click(screen.getByRole("button", { name: /판정·고급/ }));
    const timeout = screen.getByLabelText(/HTTP 타임아웃/);
    await user.clear(timeout);
    await user.type(timeout, "0");
    // 간단 전환 — 접힌 상태에서도(mode==="simple") 이유가 보여야
    await user.click(screen.getByRole("radio", { name: "간단" }));
    expect(screen.getByRole("button", { name: "실행하기" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(/HTTP 타임아웃/);
  });

  it("env 오버라이드 prefill + 간단 → '변수 N개 적용됨' 힌트 (R18)", async () => {
    const user = userEvent.setup();
    renderWithInitial({
      profile: {
        vus: 2,
        duration_seconds: 5,
        ramp_up_seconds: 0,
        loop_breakdown_cap: 256,
        http_timeout_seconds: 30,
        measure_phases: false,
        data_binding: null,
      },
      env: { BASE_URL: "x" },
    });
    // env override → 상세로 열림 → 간단으로 전환
    await user.click(screen.getByRole("radio", { name: "간단" }));
    // showOverrides=false 경로 → EnvironmentPicker가 적용 힌트 표시
    expect(screen.getByText(/변수.*개 적용됨/)).toBeInTheDocument();
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

    await user.click(screen.getByRole("button", { name: "실행하기" }));
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

// Helper to build a pool worker fixture with all L7 fields present.
function makePoolWorker(overrides: {
  worker_id?: string;
  hostname?: string;
  capacity_vus?: number;
  busy?: boolean;
  run_id?: string | null;
  last_seen_secs_ago?: number;
  drained?: boolean;
  capacity_override?: number | null;
  label?: string | null;
  stable?: boolean;
}) {
  return {
    worker_id: "w0",
    hostname: "h0",
    capacity_vus: 1,
    busy: false,
    run_id: null,
    last_seen_secs_ago: 2,
    drained: false,
    capacity_override: null,
    label: null,
    stable: true,
    ...overrides,
  };
}

describe("RunDialog — 풀 모드 유휴 워커 프리뷰 (L2 R8/R9)", () => {
  it("풀 모드에서 유휴 워커 수가 배너에 표시된다", () => {
    mockUsePoolWorkers.mockReturnValue({
      data: {
        pool_mode: true,
        workers: [
          makePoolWorker({ worker_id: "w1", hostname: "h1", capacity_vus: 1 }),
          makePoolWorker({ worker_id: "w2", hostname: "h2", capacity_vus: 1 }),
          makePoolWorker({
            worker_id: "w3",
            hostname: "h3",
            capacity_vus: 1,
            busy: true,
            run_id: "R1",
          }),
        ],
      },
    });
    renderDialog();
    // ko.workers.poolPreview(2) = "연결된 유휴 워커 2대 — ..."
    expect(screen.getByText(/유휴 워커 2대/)).toBeInTheDocument();
  });

  it("drained 워커는 유휴 카운트와 용량 계산에서 제외된다 (L7 R4)", () => {
    // w1 idle, w2 drained+idle (excluded from idle count), w3 busy
    mockUsePoolWorkers.mockReturnValue({
      data: {
        pool_mode: true,
        workers: [
          makePoolWorker({ worker_id: "w1", hostname: "h1", capacity_vus: 10 }),
          makePoolWorker({ worker_id: "w2", hostname: "h2", capacity_vus: 20, drained: true }),
          makePoolWorker({
            worker_id: "w3",
            hostname: "h3",
            capacity_vus: 5,
            busy: true,
            run_id: "R1",
          }),
        ],
      },
    });
    renderDialog();
    // Only w1 counts as idle → "유휴 워커 1대"
    expect(screen.getByText(/유휴 워커 1대/)).toBeInTheDocument();
    // capacity = w1 capacity_vus(10) only → "총 용량 10 VU"
    // (w2 is drained, w3 is busy — both excluded)
    expect(screen.getByText(/총 용량 10 VU/)).toBeInTheDocument();
    // drained note shows because drainedCount=1
    expect(screen.getByText(/비우는 중 1대 제외/)).toBeInTheDocument();
  });

  it("풀 모드가 아닐 때 배너가 없고 worker_count 입력은 그대로다", async () => {
    const user = userEvent.setup();
    mockUsePoolWorkers.mockReturnValue({ data: { pool_mode: false, workers: [] } });
    renderDialog();
    // 배너 부재
    expect(screen.queryByText(/유휴 워커/)).not.toBeInTheDocument();
    // 기존 open-loop worker_count 입력 회귀 0: open-loop 전환 후 worker_count disclosure 버튼이 존재한다.
    await toDetailed(user);
    await user.click(screen.getByRole("radio", { name: /도착률/ }));
    // worker_count는 접이식 disclosure 안에 있어 toggle 버튼이 존재하는 것으로 검증한다.
    expect(screen.getByRole("button", { name: /부하 생성기 워커 수/ })).toBeInTheDocument();
  });
});

describe("RunDialog — 풀 과부하 가드 (L3 R8/R9/R10)", () => {
  function mockPoolWorkers(capacities: number[]) {
    mockUsePoolWorkers.mockReturnValue({
      data: {
        pool_mode: true,
        workers: capacities.map((c, i) =>
          makePoolWorker({ worker_id: `w${i}`, hostname: `h${i}`, capacity_vus: c }),
        ),
      },
    });
  }

  it("총 유휴 용량(sum of capacity_vus)이 프리뷰에 표시된다", () => {
    mockPoolWorkers([5, 5]); // idle capacity = 10
    renderDialog();
    // ko.capacityGuard.totalCapacity(10) = "총 용량 10 VU"
    expect(screen.getByText(/총 용량 10 VU/)).toBeInTheDocument();
  });

  it("closed-fixed 모드에서 vus가 용량을 초과하면 초과 힌트가 표시된다 (role=status)", async () => {
    const user = userEvent.setup();
    mockPoolWorkers([5, 5]); // idle capacity = 10
    renderDialog();
    // default vus=2 < 10, no hint
    expect(screen.queryByText(/요청 VU가 풀 용량/)).not.toBeInTheDocument();

    // 20 VU로 늘리기 — capacity 10 초과
    const vusInput = screen.getByRole("spinbutton", { name: /동시 사용자/ });
    await user.clear(vusInput);
    await user.type(vusInput, "20");

    // ko.capacityGuard.overHint(10) visible with role=status
    const hint = await screen.findByText(/요청 VU가 풀 용량 10 VU를 초과합니다/);
    expect(hint.closest("[role='status']")).toBeInTheDocument();
  });

  it("open-loop 모드에서는 초과 힌트가 표시되지 않는다", async () => {
    const user = userEvent.setup();
    mockPoolWorkers([5, 5]); // idle capacity = 10
    renderDialog();
    await user.click(screen.getByRole("radio", { name: /도착률/ }));
    // 힌트 없음 (open-loop는 capacity guard 대상 아님)
    expect(screen.queryByText(/요청 VU가 풀 용량/)).not.toBeInTheDocument();
  });

  it("409 PoolCapacityError 발생 시 확인 다이얼로그가 열린다", async () => {
    fetchMock.mockImplementation(
      () =>
        new Response(
          JSON.stringify({ error: "capacity exceeded", achievable_vus: 10, requested_vus: 20 }),
          { status: 409, headers: { "content-type": "application/json" } },
        ),
    );
    mockPoolWorkers([5, 5]);
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: "실행하기" }));

    // 다이얼로그가 열려야 함 (role=alertdialog)
    const dialog = await screen.findByRole("alertdialog", { name: /풀 용량 부족/ });
    expect(dialog).toBeInTheDocument();
    // generic error banner는 억제됨
    expect(screen.queryByText(/capacity exceeded/)).not.toBeInTheDocument();
  });

  it("줄여 진행 클릭 시 achievable_vus로 clamped 프로파일로 재제출된다", async () => {
    let runsCallCount = 0;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (
        String(url).endsWith("/api/runs") &&
        (init as RequestInit | undefined)?.method === "POST"
      ) {
        runsCallCount++;
        if (runsCallCount === 1) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ error: "capacity exceeded", achievable_vus: 10, requested_vus: 20 }),
              { status: 409, headers: { "content-type": "application/json" } },
            ),
          );
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: "R-CLAMP",
              scenario_id: "S1",
              scenario_yaml: "version: 1\nname: t\nsteps: []\n",
              status: "pending",
              profile: { vus: 10, ramp_up_seconds: 0, duration_seconds: 5 },
              env: {},
              started_at: null,
              ended_at: null,
              created_at: 1,
            }),
            { status: 201, headers: { "content-type": "application/json" } },
          ),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ presets: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    });

    mockPoolWorkers([5, 5]);
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: "실행하기" }));
    // 다이얼로그 등장 대기
    await screen.findByRole("alertdialog", { name: /풀 용량 부족/ });

    // "줄여 진행" 클릭
    await user.click(screen.getByRole("button", { name: /10 VU로 줄여 진행/ }));

    // 재제출된 call의 body에 vus=10
    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter(
        ([url, init]) =>
          typeof url === "string" &&
          url.endsWith("/api/runs") &&
          (init as RequestInit | undefined)?.method === "POST",
      );
      expect(calls.length).toBe(2);
      const body = JSON.parse((calls[1]![1] as RequestInit).body as string);
      expect(body.profile.vus).toBe(10);
    });
  });

  it("강행 클릭 시 force:true로 재제출된다", async () => {
    let runsCallCount = 0;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (
        String(url).includes("/api/runs") &&
        (init as RequestInit | undefined)?.method === "POST"
      ) {
        runsCallCount++;
        if (runsCallCount === 1) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ error: "capacity exceeded", achievable_vus: 10, requested_vus: 20 }),
              { status: 409, headers: { "content-type": "application/json" } },
            ),
          );
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: "R-FORCE",
              scenario_id: "S1",
              scenario_yaml: "version: 1\nname: t\nsteps: []\n",
              status: "pending",
              profile: { vus: 2, ramp_up_seconds: 0, duration_seconds: 5 },
              env: {},
              started_at: null,
              ended_at: null,
              created_at: 1,
            }),
            { status: 201, headers: { "content-type": "application/json" } },
          ),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ presets: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    });

    mockPoolWorkers([5, 5]);
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: "실행하기" }));
    await screen.findByRole("alertdialog", { name: /풀 용량 부족/ });

    // "강행" 클릭
    await user.click(screen.getByRole("button", { name: /용량 무시하고 강행/ }));

    // 재제출 URL에 ?force=true
    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter(
        ([url]) => typeof url === "string" && url.includes("/api/runs"),
      );
      expect(calls.length).toBe(2);
      expect(String(calls[1]![0])).toContain("?force=true");
    });
  });
});

describe("RunDialog — 풀 과부하 가드 open-loop 확장 (L4 R8/R9/R10)", () => {
  function mockPoolWorkers(capacities: number[]) {
    mockUsePoolWorkers.mockReturnValue({
      data: {
        pool_mode: true,
        workers: capacities.map((c, i) =>
          makePoolWorker({ worker_id: `w${i}`, hostname: `h${i}`, capacity_vus: c }),
        ),
      },
    });
  }

  // R8: open+fixed 모드에서 max_in_flight > 풀 총용량이면 초과 힌트 표시
  it("open+fixed: max_in_flight > 풀 총용량이면 초과 힌트가 표시된다 (role=status)", async () => {
    const user = userEvent.setup();
    mockPoolWorkers([5, 5]); // idle capacity = 10
    renderDialog();

    // open+fixed 전환
    await user.click(screen.getByRole("radio", { name: /도착률/ }));

    // max_in_flight = 20 (> 10)
    const mif = screen.getByLabelText(/동시 요청 상한/);
    await user.clear(mif);
    await user.type(mif, "20");

    // 초과 힌트 표시 (role=status)
    const hint = await screen.findByText(/동시 요청 수.*풀 용량.*10.*초과/);
    expect(hint.closest("[role='status']")).toBeInTheDocument();
  });

  // R8: open+curve 모드에서 max_in_flight > 풀 총용량이면 초과 힌트 표시
  it("open+curve: max_in_flight > 풀 총용량이면 초과 힌트가 표시된다", async () => {
    const user = userEvent.setup();
    mockPoolWorkers([5, 5]); // idle capacity = 10
    renderDialog();
    await toDetailed(user);
    // open+curve 전환
    await user.click(screen.getByRole("radio", { name: /도착률/ }));
    await user.click(screen.getByRole("radio", { name: "곡선" }));

    // max_in_flight = 20 (> 10)
    const mif = screen.getByLabelText(/동시 요청 상한/);
    await user.clear(mif);
    await user.type(mif, "20");

    // 초과 힌트 표시
    const hint = await screen.findByText(/동시 요청 수.*풀 용량.*10.*초과/);
    expect(hint.closest("[role='status']")).toBeInTheDocument();
  });

  // R8: open+fixed 에서 max_in_flight <= 총용량이면 힌트 없음
  it("open+fixed: max_in_flight <= 풀 총용량이면 초과 힌트 없음", async () => {
    const user = userEvent.setup();
    mockPoolWorkers([5, 5]); // idle capacity = 10
    renderDialog();

    await user.click(screen.getByRole("radio", { name: /도착률/ }));

    // max_in_flight = 8 (< 10) — no hint
    const mif = screen.getByLabelText(/동시 요청 상한/);
    await user.clear(mif);
    await user.type(mif, "8");

    expect(screen.queryByText(/동시 요청 수.*풀 용량.*초과/)).not.toBeInTheDocument();
  });

  // R9: open+fixed 409 → 줄여 진행이 max_in_flight를 achievable로 clamp (target_rps 유지)
  it("open+fixed 409 → 줄여 진행: max_in_flight=achievable로 clamp, target_rps 불변, vus 미설정", async () => {
    let runsCallCount = 0;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (
        String(url).includes("/api/runs") &&
        (init as RequestInit | undefined)?.method === "POST"
      ) {
        runsCallCount++;
        if (runsCallCount === 1) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ error: "capacity exceeded", achievable_vus: 10, requested_vus: 20 }),
              { status: 409, headers: { "content-type": "application/json" } },
            ),
          );
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: "R-OPEN-CLAMP",
              scenario_id: "S1",
              scenario_yaml: "version: 1\nname: t\nsteps: []\n",
              status: "pending",
              profile: {
                vus: 0,
                ramp_up_seconds: 0,
                duration_seconds: 5,
                target_rps: 100,
                max_in_flight: 10,
              },
              env: {},
              started_at: null,
              ended_at: null,
              created_at: 1,
            }),
            { status: 201, headers: { "content-type": "application/json" } },
          ),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ presets: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    });

    mockPoolWorkers([5, 5]);
    const user = userEvent.setup();
    renderDialog();

    // open+fixed 전환 후 설정
    await user.click(screen.getByRole("radio", { name: /도착률/ }));
    await user.clear(screen.getByLabelText(/테스트 시간/));
    await user.type(screen.getByLabelText(/테스트 시간/), "5");
    const targetRps = screen.getByRole("spinbutton", { name: /도착률/i });
    await user.clear(targetRps);
    await user.type(targetRps, "100");
    const mif = screen.getByLabelText(/동시 요청 상한/);
    await user.clear(mif);
    await user.type(mif, "20");

    await user.click(screen.getByRole("button", { name: "실행하기" }));

    // 다이얼로그 등장 — open-loop용 슬롯 워딩 확인
    const dialog = await screen.findByRole("alertdialog", { name: /풀 용량 부족/ });
    expect(dialog).toBeInTheDocument();
    // 안내문(슬롯만 축소) 표시 확인
    expect(dialog).toHaveTextContent(/동시 슬롯만 줄입니다/);

    // "줄여 진행" 클릭
    await user.click(screen.getByRole("button", { name: /10.*줄여 진행/ }));

    // 2번째 POST payload 확인
    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter(
        ([url, init]) =>
          typeof url === "string" &&
          url.includes("/api/runs") &&
          (init as RequestInit | undefined)?.method === "POST",
      );
      expect(calls.length).toBe(2);
      const body = JSON.parse((calls[1]![1] as RequestInit).body as string);
      // max_in_flight가 achievable(10)로 clamped
      expect(body.profile.max_in_flight).toBe(10);
      // target_rps는 유지
      expect(body.profile.target_rps).toBe(100);
      // vus는 open-loop에서 0 (not set to achievable)
      expect(body.profile.vus).toBe(0);
    });
  });

  // R10: open+fixed 409 → 강행이 ?force=true로 동일 페이로드 재전송
  it("open+fixed 409 → 강행 클릭 시 force:true로 재제출된다", async () => {
    let runsCallCount = 0;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (
        String(url).includes("/api/runs") &&
        (init as RequestInit | undefined)?.method === "POST"
      ) {
        runsCallCount++;
        if (runsCallCount === 1) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ error: "capacity exceeded", achievable_vus: 10, requested_vus: 20 }),
              { status: 409, headers: { "content-type": "application/json" } },
            ),
          );
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: "R-OPEN-FORCE",
              scenario_id: "S1",
              scenario_yaml: "version: 1\nname: t\nsteps: []\n",
              status: "pending",
              profile: {
                vus: 0,
                ramp_up_seconds: 0,
                duration_seconds: 5,
                target_rps: 100,
                max_in_flight: 20,
              },
              env: {},
              started_at: null,
              ended_at: null,
              created_at: 1,
            }),
            { status: 201, headers: { "content-type": "application/json" } },
          ),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ presets: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    });

    mockPoolWorkers([5, 5]);
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("radio", { name: /도착률/ }));
    await user.clear(screen.getByLabelText(/테스트 시간/));
    await user.type(screen.getByLabelText(/테스트 시간/), "5");
    const targetRps = screen.getByRole("spinbutton", { name: /도착률/i });
    await user.clear(targetRps);
    await user.type(targetRps, "100");
    const mif = screen.getByLabelText(/동시 요청 상한/);
    await user.clear(mif);
    await user.type(mif, "20");

    await user.click(screen.getByRole("button", { name: "실행하기" }));
    await screen.findByRole("alertdialog", { name: /풀 용량 부족/ });

    await user.click(screen.getByRole("button", { name: /용량 무시하고 강행/ }));

    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter(
        ([url]) => typeof url === "string" && url.includes("/api/runs"),
      );
      expect(calls.length).toBe(2);
      expect(String(calls[1]![0])).toContain("?force=true");
    });
  });

  // 비-풀이면 힌트 미표시
  it("비-풀 모드에서는 open-loop 초과 힌트가 표시되지 않는다", async () => {
    const user = userEvent.setup();
    mockUsePoolWorkers.mockReturnValue({ data: { pool_mode: false, workers: [] } });
    renderDialog();

    await user.click(screen.getByRole("radio", { name: /도착률/ }));
    const mif = screen.getByLabelText(/동시 요청 상한/);
    await user.clear(mif);
    await user.type(mif, "200");

    expect(screen.queryByText(/동시 요청 수.*풀 용량.*초과/)).not.toBeInTheDocument();
  });
});

describe("RunDialog — B2 Callout 변환", () => {
  it("run 생성 mutation 오류를 role=alert Callout으로 보인다", async () => {
    // 500 에러 → mutation.error (non-PoolCapacityError) → role=alert 신규
    fetchMock.mockImplementation(
      () =>
        new Response(JSON.stringify({ error: "내부 서버 오류" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
    );
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: "실행하기" }));

    // 에러 메시지가 role=alert 요소 안에 있어야 한다 (다른 alert 없는 시나리오)
    const errText = await screen.findByText(/내부 서버 오류/);
    expect(errText.closest("[role='alert']")).toBeInTheDocument();
  });
});

describe("RunDialog — 풀 과부하 가드 closed+curve 확장 (L5 R8/R9/R10)", () => {
  function mockPoolWorkers(capacities: number[]) {
    mockUsePoolWorkers.mockReturnValue({
      data: {
        pool_mode: true,
        workers: capacities.map((c, i) =>
          makePoolWorker({ worker_id: `w${i}`, hostname: `h${i}`, capacity_vus: c }),
        ),
      },
    });
  }

  // R8: closed+curve 모드에서 peak > 풀 총용량이면 초과 힌트 표시
  it("closed+curve: 곡선 최고점이 풀 용량 초과 시 overHintCurve 표시 (role=status)", async () => {
    const user = userEvent.setup();
    mockPoolWorkers([5, 5]); // idle capacity = 10
    renderDialog();
    await toDetailed(user);
    // closed+curve 전환
    await user.click(screen.getByRole("radio", { name: "곡선" }));

    // stage 목표 VU = 50 (> 10)
    await user.clear(screen.getByLabelText("스테이지 0 목표"));
    await user.type(screen.getByLabelText("스테이지 0 목표"), "50");

    // overHintCurve 표시 (role=status) — ko.capacityGuard.overHintCurve(10)
    const hint = await screen.findByText(/곡선 최고점이 풀 유휴 용량 10 VU를 초과합니다/);
    expect(hint.closest("[role='status']")).toBeInTheDocument();
  });

  // R10: closed+curve peak <= 용량이면 다이얼로그 미표시(정상 fan-out)
  it("closed+curve peak <= 풀 총용량이면 409 다이얼로그 미표시 (정상 fan-out, R10)", async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (
        String(url).includes("/api/runs") &&
        (init as RequestInit | undefined)?.method === "POST"
      ) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: "R-CURVE-OK",
              scenario_id: "S1",
              scenario_yaml: "version: 1\nname: t\nsteps: []\n",
              status: "pending",
              profile: { vus: 0, ramp_up_seconds: 0, duration_seconds: 0 },
              env: {},
              started_at: null,
              ended_at: null,
              created_at: 1,
            }),
            { status: 201, headers: { "content-type": "application/json" } },
          ),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ presets: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    });

    mockPoolWorkers([5, 5]); // idle capacity = 10
    const user = userEvent.setup();
    const { onCreated } = renderDialog();
    await toDetailed(user);
    // closed+curve 전환 후 peak=8 (< 10)
    await user.click(screen.getByRole("radio", { name: "곡선" }));
    await user.clear(screen.getByLabelText("스테이지 0 목표"));
    await user.type(screen.getByLabelText("스테이지 0 목표"), "8");

    await user.click(screen.getByRole("button", { name: "실행하기" }));

    // 다이얼로그 미표시 + 정상 성공
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("R-CURVE-OK"));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  // R9: closed+curve 409 → 줄여서 발생이 scaleVuStages로 비례 clamp 후 재제출
  it("closed+curve 409 → 줄여서 발생: vu_stages 비례 축소 후 재제출, peak===achievable (R9)", async () => {
    let runsCallCount = 0;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (
        String(url).includes("/api/runs") &&
        (init as RequestInit | undefined)?.method === "POST"
      ) {
        runsCallCount++;
        if (runsCallCount === 1) {
          // 1차: 409 (peak 50 > achievable 30)
          return Promise.resolve(
            new Response(
              JSON.stringify({
                error: "capacity exceeded",
                achievable_vus: 30,
                requested_vus: 50,
              }),
              { status: 409, headers: { "content-type": "application/json" } },
            ),
          );
        }
        // 2차: 성공
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: "R-CURVE-CLAMP",
              scenario_id: "S1",
              scenario_yaml: "version: 1\nname: t\nsteps: []\n",
              status: "pending",
              profile: { vus: 0, ramp_up_seconds: 0, duration_seconds: 0 },
              env: {},
              started_at: null,
              ended_at: null,
              created_at: 1,
            }),
            { status: 201, headers: { "content-type": "application/json" } },
          ),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ presets: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    });

    mockPoolWorkers([15, 15]); // idle capacity = 30
    const user = userEvent.setup();
    renderDialog();
    await toDetailed(user);
    // closed+curve 전환 후 stage peak=50 (> 30)
    await user.click(screen.getByRole("radio", { name: "곡선" }));
    await user.clear(screen.getByLabelText("스테이지 0 목표"));
    await user.type(screen.getByLabelText("스테이지 0 목표"), "50");
    await user.clear(screen.getByLabelText("스테이지 0 지속시간"));
    await user.type(screen.getByLabelText("스테이지 0 지속시간"), "30");

    await user.click(screen.getByRole("button", { name: "실행하기" }));

    // 다이얼로그 등장 — 곡선 변형 body/note 확인
    const dialog = await screen.findByRole("alertdialog", { name: /풀 용량 부족/ });
    expect(dialog).toBeInTheDocument();
    // dialogBodyCurve 확인
    expect(dialog).toHaveTextContent(/연결된 풀 워커 용량은 30 VU/);
    // clampNoteCurve 확인
    expect(dialog).toHaveTextContent(/30\/50배로 축소/);

    // "줄여서 발생" 클릭 — ko.capacityGuard.clampCurve(30)
    await user.click(screen.getByRole("button", { name: /줄여서 발생.*30 VU로 축소/ }));

    // 2번째 POST payload 확인: vu_stages peak === achievable(30), vus=0, target_rps 미주입
    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter(
        ([url, init]) =>
          typeof url === "string" &&
          url.includes("/api/runs") &&
          (init as RequestInit | undefined)?.method === "POST",
      );
      expect(calls.length).toBe(2);
      const body = JSON.parse((calls[1]![1] as RequestInit).body as string);
      // vu_stages 비례 축소: peak 50 → achievable 30 (factor=0.6: 50*0.6=30)
      expect(body.profile.vu_stages).toBeDefined();
      const peakTarget = Math.max(
        ...(body.profile.vu_stages as { target: number }[]).map((s) => s.target),
      );
      expect(peakTarget).toBe(30);
      // target_rps 미주입 (curve 아님), vus 0
      expect(body.profile.target_rps).toBeUndefined();
      expect(body.profile.vus).toBe(0);
    });
  });
});

// ───────────────────────────────────────────────────────────────
// T8: 실시간 요약 footer (R8) + 곡선 읽기전용 카드 (R17)
// ───────────────────────────────────────────────────────────────

describe("RunDialog — 실시간 요약 footer (R8·T8)", () => {
  // footer 컨테이너: sticky bottom div
  const footer = () =>
    screen.getByRole("button", { name: "실행하기" }).closest('[class*="sticky"]')!;

  it("closed 100명·300초 → footer에 '동시 사용자 100명 · 5분' + 고정-모양 img", () => {
    renderWithInitial({
      profile: {
        vus: 100,
        duration_seconds: 300,
        ramp_up_seconds: 0,
        loop_breakdown_cap: 256,
        http_timeout_seconds: 30,
        measure_phases: false,
        data_binding: null,
      },
      env: {},
    });
    expect(footer()).toHaveTextContent("동시 사용자 100명 · 5분");
    // 고정(flat) 모드에서도 footer LoadShapePreview가 role=img로 렌더됨
    expect(screen.getByRole("img", { name: "부하 모양 미리보기" })).toBeInTheDocument();
  });

  it("open-loop 전환 → footer에 '반복 약 30,000회' (도착률 초당 100회 × 300초)", async () => {
    const user = userEvent.setup();
    renderWithInitial({
      profile: {
        vus: 100,
        duration_seconds: 300,
        ramp_up_seconds: 0,
        loop_breakdown_cap: 256,
        http_timeout_seconds: 30,
        measure_phases: false,
        data_binding: null,
      },
      env: {},
    });
    await user.click(screen.getByRole("radio", { name: /도착률/ }));
    expect(footer()).toHaveTextContent("반복 약 30,000회");
  });

  it("vus=0 → footer에 warn 텍스트 '설정을 확인하세요' + shape 없음", async () => {
    const user = userEvent.setup();
    renderDialog();
    const vusInput = screen.getByRole("spinbutton", { name: /동시 사용자/ });
    await user.clear(vusInput);
    await user.type(vusInput, "0");
    expect(footer()).toHaveTextContent("설정을 확인하세요");
    // warn 시 LoadShapePreview 미렌더
    expect(screen.queryByRole("img", { name: "부하 모양 미리보기" })).toBeNull();
  });

  it("closed+curve prefill → footer에 곡선 텍스트 + LoadShapePreview(role=img, VU label)", () => {
    renderWithInitial({
      profile: {
        vus: 0,
        duration_seconds: 0,
        ramp_up_seconds: 0,
        loop_breakdown_cap: 256,
        http_timeout_seconds: 30,
        measure_phases: false,
        data_binding: null,
        vu_stages: [{ target: 50, duration_seconds: 30 }],
      },
      env: {},
    });
    // 곡선 요약 텍스트 (ko.runDialog.summaryCurveVu): <b>+<span> 분산이므로 toHaveTextContent 사용
    expect(footer()).toHaveTextContent("최대 50명");
    // footer의 LoadShapePreview가 role=img + VU label
    expect(screen.getAllByRole("img").length).toBeGreaterThanOrEqual(1);
  });
});

describe("RunDialog — 곡선 읽기전용 카드 (R17·T8)", () => {
  it("vu_stages prefill + 간단 전환 → 곡선 카드 + role=img + Run → vu_stages 유지", async () => {
    fetchMock.mockImplementation(() =>
      jsonResponse({
        id: "R17",
        scenario_id: "S1",
        scenario_yaml: "version: 1\nname: t\nsteps: []\n",
        status: "pending",
        profile: { vus: 0, duration_seconds: 0 },
        env: {},
        started_at: null,
        ended_at: null,
        created_at: 1,
      }),
    );

    const user = userEvent.setup();
    renderWithInitial({
      profile: {
        vus: 0,
        duration_seconds: 0,
        ramp_up_seconds: 0,
        loop_breakdown_cap: 256,
        http_timeout_seconds: 30,
        measure_phases: false,
        data_binding: null,
        vu_stages: [
          { target: 50, duration_seconds: 30 },
          { target: 100, duration_seconds: 60 },
        ],
      },
      env: {},
    });

    // 곡선 prefill → 상세로 열림
    expect(screen.getByRole("radio", { name: "상세" })).toHaveAttribute("aria-checked", "true");

    // 간단으로 전환 — rateMode는 "curve" 유지 (스냅 금지)
    await user.click(screen.getByRole("radio", { name: "간단" }));

    // 읽기전용 곡선 카드 표시 (R17)
    expect(screen.getByText("곡선 부하 설정됨")).toBeInTheDocument();
    expect(screen.getByText("상세 모드에서 편집")).toBeInTheDocument();
    // 곡선 카드 안 StageCurvePreview는 role=img 컨테이너 안
    expect(screen.getAllByRole("img").length).toBeGreaterThanOrEqual(1);

    // Run 클릭 → vu_stages payload 유지 확인
    await user.click(screen.getByRole("button", { name: "실행하기" }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) =>
          typeof url === "string" &&
          url.endsWith("/api/runs") &&
          (init as RequestInit | undefined)?.method === "POST",
      );
      expect(call).toBeDefined();
      const body = JSON.parse((call![1] as RequestInit).body as string);
      expect(body.profile.vu_stages).toBeDefined();
      expect(body.profile.vu_stages).toHaveLength(2);
      expect(body.profile.vu_stages[0].target).toBe(50);
      expect(body.profile.vu_stages[1].target).toBe(100);
    });
  });

  it("stages prefill (open+curve) + 간단 전환 → 카드 프리뷰 aria-hidden + 푸터 role=img는 도착률 (Fix-2·open-loop a11y)", async () => {
    const user = userEvent.setup();
    renderWithInitial({
      profile: {
        vus: 0,
        duration_seconds: 0,
        ramp_up_seconds: 0,
        loop_breakdown_cap: 256,
        http_timeout_seconds: 30,
        measure_phases: false,
        data_binding: null,
        max_in_flight: 50,
        stages: [{ target: 100, duration_seconds: 10 }],
      },
      env: {},
    });

    // open+curve prefill → 상세로 열림
    expect(screen.getByRole("radio", { name: "상세" })).toHaveAttribute("aria-checked", "true");

    // 간단으로 전환 — rateMode는 "curve" 유지 (스냅 금지)
    await user.click(screen.getByRole("radio", { name: "간단" }));

    // 읽기전용 곡선 카드 표시
    expect(screen.getByText("곡선 부하 설정됨")).toBeInTheDocument();

    // 카드 컨테이너 스코프
    const cardContainer = screen.getByText("곡선 부하 설정됨").parentElement!;

    // Fix-2: 카드 안 프리뷰 wrapper는 aria-hidden (장식용 — SR 중복 억제)
    const hiddenWrapper = cardContainer.querySelector("[aria-hidden='true']");
    expect(hiddenWrapper).toBeInTheDocument();

    // 카드 안에는 role=img 없음 (SR 구술은 푸터 role=img에서만 1회)
    expect(within(cardContainer).queryByRole("img")).toBeNull();

    // 푸터 role=img (SR 단일 구술): open-loop → 도착률 변형 aria-label
    expect(
      screen.getByRole("img", { name: "레이트 곡선 미리보기 (x: 누적 초, y: 도착률)" }),
    ).toBeInTheDocument();

    // VU 변형 label은 전체 화면에도 없어야 함 (open-loop)
    expect(screen.queryByRole("img", { name: "VU 곡선 미리보기 (x: 누적 초, y: VU)" })).toBeNull();
  });
});

// ─── T9: 정밀계기 룩 구조 단언 ───────────────────────────────────────────────
describe("RunDialog — 정밀계기 룩 (T9)", () => {
  it("주 수치 입력에 tabular-nums 클래스가 적용된다 (numeric prop)", () => {
    renderDialog();
    // LoadModelFields에 numeric=true가 전달되면 VU 수치 input에 tabular-nums가 붙는다
    const vusInput = screen.getByRole("spinbutton", { name: /동시 사용자/i });
    expect(vusInput).toHaveClass("tabular-nums");
  });

  it("섹션 제목이 eyebrow 스타일(uppercase tracking)로 렌더된다", () => {
    const { container } = renderDialog();
    // eyebrow 클래스가 있는 요소 중 '부하 모델' 텍스트를 포함하는 것이 있어야 한다
    const uppercaseEls = container.querySelectorAll(".uppercase");
    const texts = Array.from(uppercaseEls).map((el) => el.textContent ?? "");
    expect(texts.some((t) => t.includes("부하 모델"))).toBe(true);
  });
});

// ─── R8: 헤더 제목 단언 ─────────────────────────────────────────────────────
describe("RunDialog — 헤더 제목 (R8)", () => {
  it("헤더 제목 '실행 설정' (R8)", () => {
    renderDialog();
    expect(screen.getByRole("heading", { name: "실행 설정" })).toBeInTheDocument();
  });
});

// ─── T5: sticky footer 하단 여백 ──────────────────────────────────────────────
describe("RunDialog — sticky footer 하단 여백 (T5)", () => {
  it("sticky footer는 하단 여백(pb-*)을 가진다", () => {
    renderDialog();
    const sticky = document.querySelector('[class*="sticky"]') as HTMLElement;
    expect(sticky).toBeTruthy();
    expect(sticky.className).toMatch(/\bpb-\d/);
  });
});

// ─── Option C: 크기 프리셋 상대배수 사이징 ──────────────────────────────────
describe("RunDialog — 크기 프리셋 상대배수 사이징 (Option C)", () => {
  const RUN_PRIOR = {
    id: "R-PRIOR",
    scenario_id: "S1",
    scenario_yaml: "version: 1\nname: t\nsteps: []\n",
    status: "completed",
    profile: { vus: 20, duration_seconds: 60 },
    env: {},
    started_at: 1,
    ended_at: 2,
    created_at: 1,
  };

  const REPORT_PRIOR = {
    run: {
      id: "R-PRIOR",
      scenario_id: "S1",
      status: "completed",
      profile: null,
      env: null,
      started_at: 1,
      ended_at: 2,
      created_at: 1,
    },
    scenario_yaml: "version: 1\nname: t\nsteps: []\n",
    summary: {
      count: 600,
      errors: 0,
      rps: 10,
      duration_seconds: 60,
      mean_ms: 5,
      p50_ms: 5,
      p95_ms: 5,
      p99_ms: 5,
    },
    windows: [],
    steps: [],
    status_distribution: {},
    dropped: 0,
  };

  it("직전 completed closed-loop run이 있으면 빠른 입력 칩이 그 값의 0.5×/1×/2×로 계산된다", async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url);
      if (
        u.endsWith("/api/scenarios/S1/runs") &&
        (!init || !init.method || init.method === "GET")
      ) {
        return Promise.resolve(jsonResponse({ runs: [RUN_PRIOR] }));
      }
      if (u.endsWith("/api/runs/R-PRIOR/report")) {
        return Promise.resolve(jsonResponse(REPORT_PRIOR));
      }
      return Promise.resolve(jsonResponse({ presets: [] }));
    });

    renderDialog();

    // "20명 · 1분"은 고정 폴백 3개(10/50/200명)엔 없는 값이라, 이게 뜨면 앵커 계산이
    // 실제로 반영됐다는 뜨거운 증거다(고정 폴백만으로는 절대 나올 수 없는 라벨).
    expect(await screen.findByRole("button", { name: "20명 · 1분" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "10명 · 30초" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "40명 · 2분" })).toBeInTheDocument();
    expect(
      screen.getByText(ko.loadModel.sizePresetsCaptionFromPrior(20, "1분")),
    ).toBeInTheDocument();
  });
});
