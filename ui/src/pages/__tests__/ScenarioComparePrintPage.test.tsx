import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScenarioComparePrintPage } from "../ScenarioComparePrintPage";
import type { CompareDoc } from "../../print/compare/buildCompareDoc";

const seen: CompareDoc[] = [];

vi.mock("../../print/compare/CompareDocument", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    CompareDocument: (p: { doc: CompareDoc; kind: string; onLadder?: (l: number) => void }) => {
      seen.push(p.doc);
      React.useEffect(() => {
        p.onLadder?.(p.kind === "summary" ? 2 : 0);
      }, [p]);
      return (
        <div data-testid="doc">
          <div data-testid="before-box">
            {p.doc.before.role} {p.doc.before.shortId}
          </div>
          <div data-testid="after-box">
            {p.doc.after.role} {p.doc.after.shortId}
          </div>
        </div>
      );
    },
  };
});

const YAML = 'version: 1\nname: "주문 흐름"\nsteps: []\n';
const T0 = 1_700_000_000_000;
const profile = {
  vus: 1,
  ramp_up_seconds: 0,
  duration_seconds: 5,
  loop_breakdown_cap: 256,
  http_timeout_seconds: 30,
};

type RunOpts = {
  status?: string;
  started?: number | null;
  created?: number;
  lastMetric?: number | null;
  label?: string | null;
};

function runBody(id: string, o: RunOpts = {}) {
  return {
    id,
    scenario_id: "S1",
    scenario_yaml: YAML,
    status: o.status ?? "completed",
    profile,
    env: null,
    started_at: o.started === undefined ? T0 : o.started,
    ended_at: null,
    created_at: o.created ?? T0,
    message: null,
    verdict: null,
    last_metric_ts: o.lastMetric ?? null,
    label: o.label ?? null,
  };
}

function reportBody(id: string) {
  return {
    run: {
      id,
      scenario_id: "S1",
      status: "completed",
      profile,
      env: null,
      started_at: T0,
      ended_at: T0 + 5000,
      created_at: T0,
    },
    scenario_yaml: YAML,
    verdict: null,
    summary: {
      count: 50,
      errors: 2,
      rps: 10,
      duration_seconds: 5,
      mean_ms: 20,
      p50_ms: 10,
      p95_ms: 50,
      p99_ms: 90,
    },
    windows: [],
    steps: [],
    status_distribution: { "200": 48, "500": 2 },
    dropped: 0,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const scenarioBody = {
  id: "S1",
  name: "주문 흐름",
  yaml: YAML,
  version: 1,
  created_at: 0,
  updated_at: 0,
  group: null,
};

const EARLY = "01HXAAAAAAAAAAAAAAAEARLY01";
const MID = "01HXAAAAAAAAAAAAAAAAMID002";
const LATE = "01HXAAAAAAAAAAAAAAAAALATE3";
const RUNNING = "01HXAAAAAAAAAAAAAAARUNNIN4";
const tail = (id: string) => `#${id.slice(-6)}`;

const fetchMock = vi.fn();
let runList: ReturnType<typeof runBody>[];
let listMode: "ok" | "fail" | "hang";

function reportCalls(): string[] {
  return fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.endsWith("/report"));
}

function listCalls(): string[] {
  return fetchMock.mock.calls
    .map((c) => String(c[0]))
    .filter((u) => u.endsWith("/api/scenarios/S1/runs"));
}

beforeEach(() => {
  seen.length = 0;
  fetchMock.mockReset();
  listMode = "ok";
  runList = [
    runBody(EARLY, { started: T0, created: T0 }),
    runBody(LATE, { started: T0 + 60_000, created: T0 + 60_000 }),
    runBody(MID, { started: T0 + 30_000, created: T0 + 30_000 }),
  ];
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation((url: string) => {
    if (url.endsWith("/api/scenarios/S1/runs")) {
      if (listMode === "hang") return new Promise(() => {});
      if (listMode === "fail") return Promise.resolve(json({ error: "boom" }, 500));
      return Promise.resolve(json({ runs: runList }));
    }
    const rep = /\/api\/runs\/([^/]+)\/report$/.exec(url);
    if (rep) return Promise.resolve(json(reportBody(rep[1])));
    if (url.endsWith("/api/scenarios/S1")) return Promise.resolve(json(scenarioBody));
    return Promise.resolve(json({ error: "nf" }, 404));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function Loc() {
  const l = useLocation();
  return <div data-testid="loc">{l.pathname + l.search}</div>;
}

function renderPage(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="/scenarios/:id/compare/print"
            element={
              <>
                <ScenarioComparePrintPage />
                <Loc />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

describe("ScenarioComparePrintPage", () => {
  it("renders the document with the earlier run as before and fetches only the pair's reports", async () => {
    renderPage(`/scenarios/S1/compare/print?runs=${LATE},${EARLY}`);
    expect(await screen.findByTestId("before-box")).toHaveTextContent(`이전 ${tail(EARLY)}`);
    expect(screen.getByTestId("after-box")).toHaveTextContent(`이후 ${tail(LATE)}`);
    expect(reportCalls()).toHaveLength(2);
  });

  it("one run id: asks for two or more, no report request", async () => {
    renderPage(`/scenarios/S1/compare/print?runs=${EARLY}`);
    expect(await screen.findByText("비교하려면 측정을 2개 이상 고르세요")).toBeInTheDocument();
    expect(reportCalls()).toHaveLength(0);
  });

  it("run not in this scenario: explains, no report request", async () => {
    renderPage(`/scenarios/S1/compare/print?runs=${EARLY},NOPE`);
    expect(
      await screen.findByText(
        "이 시나리오의 측정이 아니거나 없는 측정이 있어 비교 보고서를 만들 수 없습니다",
      ),
    ).toBeInTheDocument();
    expect(reportCalls()).toHaveLength(0);
  });

  it("a pair run still running: not-terminal notice, no report request", async () => {
    runList = [runBody(EARLY), runBody(RUNNING, { status: "running", started: T0 + 1000 })];
    renderPage(`/scenarios/S1/compare/print?runs=${EARLY},${RUNNING}`);
    expect(await screen.findByText("측정이 끝난 뒤 출력할 수 있습니다")).toBeInTheDocument();
    expect(reportCalls()).toHaveLength(0);
  });

  it("run list failure is an alert", async () => {
    listMode = "fail";
    renderPage(`/scenarios/S1/compare/print?runs=${EARLY},${LATE}`);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });

  it("run list loading is a status", async () => {
    listMode = "hang";
    renderPage(`/scenarios/S1/compare/print?runs=${EARLY},${LATE}`);
    expect(await screen.findByRole("status")).toBeInTheDocument();
    expect(screen.queryByTestId("doc")).not.toBeInTheDocument();
  });

  it("three runs: two pickers, cross-disabled options, changing one updates pair", async () => {
    const user = userEvent.setup();
    renderPage(`/scenarios/S1/compare/print?runs=${EARLY},${MID},${LATE}&pair=${LATE},${EARLY}`);
    await screen.findByTestId("doc");
    expect(screen.getAllByRole("combobox")).toHaveLength(2);
    const first = screen.getByRole("combobox", { name: "비교할 측정 1" });
    const second = screen.getByRole("combobox", { name: "비교할 측정 2" });
    expect(first).toHaveValue(LATE);
    expect(second).toHaveValue(EARLY);
    expect(within(first).getByRole("option", { name: new RegExp(tail(EARLY)) })).toBeDisabled();
    expect(within(second).getByRole("option", { name: new RegExp(tail(LATE)) })).toBeDisabled();
    const midOption = within(first).getByRole("option", { name: new RegExp(tail(MID)) });
    expect(midOption).toBeEnabled();
    expect(midOption.textContent).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);

    await user.selectOptions(second, MID);
    await waitFor(() =>
      expect(
        new URLSearchParams(screen.getByTestId("loc").textContent!.split("?")[1]).get("pair"),
      ).toBe(`${LATE},${MID}`),
    );
    await waitFor(() => expect(screen.getByTestId("before-box")).toHaveTextContent(tail(MID)));
    expect(screen.getByRole("combobox", { name: "비교할 측정 1" })).toHaveValue(LATE);
    expect(screen.getByRole("combobox", { name: "비교할 측정 2" })).toHaveValue(MID);
  });

  it("pair with three ids: pickers and the document use the same default pair", async () => {
    renderPage(
      `/scenarios/S1/compare/print?runs=${EARLY},${MID},${LATE}&pair=${EARLY},${MID},${LATE}`,
    );
    await screen.findByTestId("doc");
    expect(screen.getByRole("combobox", { name: "비교할 측정 1" })).toHaveValue(EARLY);
    expect(screen.getByRole("combobox", { name: "비교할 측정 2" })).toHaveValue(LATE);
    expect(screen.getByTestId("before-box")).toHaveTextContent(tail(EARLY));
    expect(screen.getByTestId("after-box")).toHaveTextContent(tail(LATE));
  });

  it("a failed background refetch of the run list keeps the built document", async () => {
    const qc = renderPage(`/scenarios/S1/compare/print?runs=${EARLY},${LATE}`);
    await screen.findByTestId("doc");
    listMode = "fail";
    await act(async () => {
      await qc.invalidateQueries({ queryKey: ["scenarios", "S1", "runs"] });
    });
    await waitFor(() =>
      expect(qc.getQueryState(["scenarios", "S1", "runs"])?.status).toBe("error"),
    );
    expect(screen.getByTestId("doc")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("three runs with a running pair member: pickers stay so the pair can be changed back", async () => {
    const user = userEvent.setup();
    runList = [
      runBody(EARLY),
      runBody(MID, { started: T0 + 30_000, created: T0 + 30_000 }),
      runBody(RUNNING, { status: "running", started: T0 + 90_000, created: T0 + 90_000 }),
    ];
    renderPage(
      `/scenarios/S1/compare/print?runs=${EARLY},${MID},${RUNNING}&pair=${EARLY},${RUNNING}`,
    );
    expect(await screen.findByText("측정이 끝난 뒤 출력할 수 있습니다")).toBeInTheDocument();
    const second = screen.getByRole("combobox", { name: "비교할 측정 2" });
    expect(second).toHaveValue(RUNNING);
    await user.selectOptions(second, MID);
    expect(await screen.findByTestId("doc")).toBeInTheDocument();
    expect(screen.getByTestId("before-box")).toHaveTextContent(tail(EARLY));
    expect(screen.getByTestId("after-box")).toHaveTextContent(tail(MID));
  });

  it("long run labels: the picker width is capped", async () => {
    runList = [EARLY, MID, LATE].map((id, i) =>
      runBody(id, { started: T0 + i * 30_000, created: T0 + i * 30_000, label: "가".repeat(200) }),
    );
    renderPage(`/scenarios/S1/compare/print?runs=${EARLY},${MID},${LATE}`);
    await screen.findByTestId("doc");
    expect(screen.getByRole("combobox", { name: "비교할 측정 1" })).toHaveStyle({
      maxWidth: "24rem",
    });
  });

  it("two runs: no pickers", async () => {
    renderPage(`/scenarios/S1/compare/print?runs=${EARLY},${LATE}`);
    await screen.findByTestId("doc");
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("ladder notice only in the summary edition", async () => {
    const user = userEvent.setup();
    renderPage(`/scenarios/S1/compare/print?runs=${EARLY},${LATE}`);
    await screen.findByTestId("doc");
    const notice = "1장에 맞추려고 일부를 줄였습니다(표준판에 전체)";
    expect(screen.queryByText(notice)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "요약판" }));
    expect(await screen.findByText(notice)).toBeInTheDocument();
  });

  it("scenario name still loading: status instead of document", async () => {
    let release: (r: Response) => void = () => {};
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string) =>
      url.endsWith("/api/scenarios/S1")
        ? new Promise<Response>((res) => {
            release = res;
          })
        : base(url),
    );
    renderPage(`/scenarios/S1/compare/print?runs=${EARLY},${LATE}`);
    await waitFor(() => expect(reportCalls()).toHaveLength(2));
    await screen.findByRole("status");
    expect(screen.queryByTestId("doc")).not.toBeInTheDocument();
    await act(async () => {
      release(json(scenarioBody));
    });
    expect(await screen.findByTestId("doc")).toBeInTheDocument();
  });

  it("kind buttons: aria-pressed, only kind changes in the url", async () => {
    const user = userEvent.setup();
    renderPage(
      `/scenarios/S1/compare/print?runs=${EARLY},${MID},${LATE}&pair=${EARLY},${LATE}&baseline=${MID}`,
    );
    await screen.findByTestId("doc");
    expect(screen.getByRole("button", { name: "표준판" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "요약판" }));
    expect(screen.getByRole("button", { name: "요약판" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "표준판" })).toHaveAttribute("aria-pressed", "false");
    const q = new URLSearchParams(screen.getByTestId("loc").textContent!.split("?")[1]);
    expect(q.get("kind")).toBe("summary");
    expect(q.get("runs")).toBe(`${EARLY},${MID},${LATE}`);
    expect(q.get("pair")).toBe(`${EARLY},${LATE}`);
    expect(q.get("baseline")).toBe(MID);
  });

  it("back link returns to the compare page with runs and baseline as received", async () => {
    renderPage(`/scenarios/S1/compare/print?runs=${EARLY},${LATE}&baseline=${LATE}`);
    await screen.findByTestId("doc");
    expect(screen.getByRole("link", { name: "돌아가기" })).toHaveAttribute(
      "href",
      `/scenarios/S1/compare?runs=${EARLY},${LATE}&baseline=${LATE}`,
    );
  });

  it("print button calls window.print", async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(window, "print").mockImplementation(() => {});
    renderPage(`/scenarios/S1/compare/print?runs=${EARLY},${LATE}`);
    await screen.findByTestId("doc");
    await user.click(screen.getByRole("button", { name: "인쇄 / PDF 저장" }));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("flicker guard: re-fetching the run list with only an unrelated run changed keeps the same doc", async () => {
    const running = (lastMetric: number) =>
      runBody(RUNNING, {
        status: "running",
        started: T0 + 90_000,
        created: T0 + 90_000,
        lastMetric,
      });
    runList = [
      runBody(EARLY),
      runBody(LATE, { started: T0 + 60_000, created: T0 + 60_000 }),
      running(1),
    ];
    const qc = renderPage(`/scenarios/S1/compare/print?runs=${EARLY},${LATE}`);
    await screen.findByTestId("doc");
    const first = seen[seen.length - 1];
    runList = [runList[0], runList[1], running(2)];
    await act(async () => {
      await qc.invalidateQueries({ queryKey: ["scenarios", "S1", "runs"] });
    });
    await waitFor(() => expect(listCalls().length).toBeGreaterThanOrEqual(2));
    expect(new Set(seen).size).toBe(1);
    expect(seen[seen.length - 1]).toBe(first);
  });
});
