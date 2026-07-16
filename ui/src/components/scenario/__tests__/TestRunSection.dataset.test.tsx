import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TestRunSection } from "../TestRunSection";
import { ko } from "../../../i18n/ko";

// URL 라우팅 fetch 스텁 — one-shot 큐 금지(무조건-훅 함정 회피). Response 생성은
// DatasetRowsPreview.test.tsx의 jsonResponse 헬퍼와 동일 형태를 이 파일에 복제.
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const DATASET_ID = "01JDS";
const datasetsFixture = {
  datasets: [
    {
      id: DATASET_ID,
      name: "users",
      columns: ["username", "password"],
      row_count: 40,
      byte_size: 1,
      created_at: 1765500000000,
    },
  ],
};
const rowsFixture = {
  rows: Array.from({ length: 40 }, (_, i) => ({ username: `u${i}`, password: `p${i}` })).slice(
    0,
    50,
  ),
  offset: 0,
  total: 40,
};

// 단발/시드 응답(ScenarioTrace)·순차 응답(SequentialTrace) fixture — Task 4 테스트
// (testRunDataset.test.ts)의 trace/seq 와이어 형태를 이 파일에 복제.
const TRACE_OK = {
  ok: true,
  total_ms: 5,
  steps: [
    {
      step_id: "01HX0000000000000000000010",
      kind: "http",
      loop_index: null,
      branch: null,
      request: { method: "GET", url: "http://x/u/bob", headers: {}, body: null },
      response: {
        status: 200,
        latency_ms: 3,
        download_ms: null,
        headers: {},
        set_cookies: [],
        body: "ok",
        body_truncated: false,
      },
      extracted: {},
      unbound_vars: [],
      error: null,
    },
  ],
  final_vars: {},
  truncated: false,
  error: null,
};

const STEP_A = "01HX0000000000000000000001";
const STEP_B = "01HX0000000000000000000002";
function mkStepTrace(stepId: string, status: number) {
  return {
    step_id: stepId,
    kind: "http",
    loop_index: null,
    branch: null,
    request: { method: "GET", url: "http://x", headers: {}, body: null },
    response: {
      status,
      latency_ms: 3,
      download_ms: null,
      headers: {},
      set_cookies: [],
      body: "ok",
      body_truncated: false,
    },
    extracted: {},
    unbound_vars: [],
    error: null,
  };
}
const ROW0_TRACE = {
  ok: true,
  total_ms: 5,
  steps: [mkStepTrace(STEP_A, 200), mkStepTrace(STEP_B, 200)],
  final_vars: {},
  truncated: false,
  error: null,
};
const ROW1_TRACE = {
  ok: false,
  total_ms: 6,
  steps: [mkStepTrace(STEP_A, 200), mkStepTrace(STEP_B, 500)],
  final_vars: {},
  truncated: false,
  error: null,
};
const SEQ_OK = {
  ok: true,
  truncated: false,
  total_ms: 11,
  rows: [
    { row_index: 0, trace: ROW0_TRACE },
    { row_index: 1, trace: ROW0_TRACE },
  ],
};
const SEQ_MIRROR = {
  ok: false,
  truncated: false,
  total_ms: 11,
  rows: [
    { row_index: 0, trace: ROW0_TRACE },
    { row_index: 1, trace: ROW1_TRACE },
  ],
};

let testRunResponse: unknown;
const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
  const url = String(input);
  if (url.includes("/api/environments")) return jsonResponse({ environments: [] });
  if (url.includes("/api/datasets") && url.includes("/rows")) return jsonResponse(rowsFixture);
  if (url.includes("/api/datasets")) return jsonResponse(datasetsFixture);
  if (url.includes("/api/test-runs")) return jsonResponse(testRunResponse);
  throw new Error(`unexpected fetch ${url}`);
});

beforeEach(() => {
  fetchMock.mockClear();
  testRunResponse = TRACE_OK;
  vi.stubGlobal("fetch", fetchMock);
  window.localStorage.clear();
});

// payload 단언 헬퍼: /test-runs 호출의 body를 파싱
function lastTestRunBody(): Record<string, unknown> {
  const calls = fetchMock.mock.calls.filter(([u]) => String(u).includes("/test-runs"));
  const call = calls[calls.length - 1];
  expect(call).toBeDefined();
  return JSON.parse((call[1] as RequestInit | undefined)?.body as string);
}

const YAML_2_STEPS = `version: 1
name: s
steps:
  - id: "${STEP_A}"
    name: stepA
    type: http
    request:
      method: GET
      url: http://x/a
  - id: "${STEP_B}"
    name: stepB
    type: http
    request:
      method: GET
      url: http://x/b
`;

function renderSection(yaml: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TestRunSection yamlText={yaml} />
    </QueryClientProvider>,
  );
}

async function openDatasetSection(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: ko.editor.dsSectionTitle }));
}

async function selectDataset(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole("option", { name: "users" });
  await user.selectOptions(screen.getByLabelText(ko.editor.dsPickLabel), DATASET_ID);
}

describe("TestRunSection 데이터셋 섹션 (R11/R14/R15)", () => {
  it("기본 접힘 + 지연 fetch — /api/datasets 미발생", () => {
    renderSection(YAML_2_STEPS);
    expect(screen.getByRole("button", { name: ko.editor.dsSectionTitle })).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/api/datasets"))).toBe(false);
  });

  it("single_row payload — row_index 0-based, mappings 키 없음, start_row/row_limit 없음 (R11)", async () => {
    const user = userEvent.setup();
    renderSection(YAML_2_STEPS);
    await openDatasetSection(user);
    await selectDataset(user);

    const rowNumInput = screen.getByLabelText(ko.editor.dsRowNumLabel);
    await user.clear(rowNumInput);
    await user.type(rowNumInput, "18");
    await user.click(screen.getByRole("button", { name: ko.editor.testRunRun }));

    const body = lastTestRunBody();
    const dataset = body.dataset as { mode: string; bindings: Record<string, unknown>[] };
    expect(dataset.mode).toBe("single_row");
    expect(dataset.bindings[0].row_index).toBe(17);
    expect(dataset.bindings[0]).not.toHaveProperty("mappings");
    expect(dataset).not.toHaveProperty("start_row");
    expect(dataset).not.toHaveProperty("row_limit");
  });

  it("sequential payload — 시작 행 1-based→0-based, 행 수 그대로 (R11)", async () => {
    const user = userEvent.setup();
    testRunResponse = SEQ_OK;
    renderSection(YAML_2_STEPS);
    await openDatasetSection(user);
    await selectDataset(user);
    await user.click(screen.getByRole("radio", { name: ko.editor.dsModeSeq }));

    await user.type(screen.getByLabelText(ko.editor.dsStartRowLabel), "2");
    await user.type(screen.getByLabelText(ko.editor.dsRowLimitLabel), "5");
    await user.click(screen.getByRole("button", { name: ko.editor.testRunRun }));

    const body = lastTestRunBody();
    const dataset = body.dataset as { start_row: number; row_limit: number };
    expect(dataset.start_row).toBe(1);
    expect(dataset.row_limit).toBe(5);
  });

  it("sequential payload — 빈 시작 행/행 수는 두 키 모두 absent", async () => {
    const user = userEvent.setup();
    testRunResponse = SEQ_OK;
    renderSection(YAML_2_STEPS);
    await openDatasetSection(user);
    await selectDataset(user);
    await user.click(screen.getByRole("radio", { name: ko.editor.dsModeSeq }));
    await user.click(screen.getByRole("button", { name: ko.editor.testRunRun }));

    const body = lastTestRunBody();
    const dataset = body.dataset as Record<string, unknown>;
    expect(dataset).not.toHaveProperty("start_row");
    expect(dataset).not.toHaveProperty("row_limit");
  });

  it("매핑 편집 → 전부 삭제 시 mappings 키 없음 (None 정규화, R11)", async () => {
    const user = userEvent.setup();
    testRunResponse = SEQ_OK;
    renderSection(YAML_2_STEPS);
    await openDatasetSection(user);
    await selectDataset(user);
    await user.click(screen.getByRole("radio", { name: ko.editor.dsModeSeq }));

    await user.click(screen.getByRole("button", { name: ko.editor.dsMappingEdit }));
    await user.click(screen.getByRole("button", { name: ko.editor.dsMappingRemoveAria(0) }));
    await user.click(screen.getByRole("button", { name: ko.editor.dsMappingRemoveAria(0) }));
    await user.click(screen.getByRole("button", { name: ko.editor.testRunRun }));

    const body = lastTestRunBody();
    const dataset = body.dataset as { bindings: Record<string, unknown>[] };
    expect(dataset.bindings[0]).not.toHaveProperty("mappings");
  });

  it("매핑 편집 → var 수정 시 mappings에 반영된다 (R11)", async () => {
    const user = userEvent.setup();
    testRunResponse = SEQ_OK;
    renderSection(YAML_2_STEPS);
    await openDatasetSection(user);
    await selectDataset(user);
    await user.click(screen.getByRole("radio", { name: ko.editor.dsModeSeq }));

    await user.click(screen.getByRole("button", { name: ko.editor.dsMappingEdit }));
    const varInput0 = screen.getByLabelText(ko.editor.dsMappingVarAria(0));
    await user.clear(varInput0);
    await user.type(varInput0, "login_id");
    await user.click(screen.getByRole("button", { name: ko.editor.testRunRun }));

    const body = lastTestRunBody();
    const dataset = body.dataset as { bindings: { mappings: unknown }[] };
    expect(dataset.bindings[0].mappings).toEqual([
      { kind: "column", var: "login_id", column: "username" },
      { kind: "column", var: "password", column: "password" },
    ]);
  });

  it("incomplete 게이트 — single_row 행 미선택 시 실행 버튼 disabled + 안내 문구 (R11)", async () => {
    const user = userEvent.setup();
    renderSection(YAML_2_STEPS);
    await openDatasetSection(user);
    await selectDataset(user);

    expect(screen.getByRole("button", { name: ko.editor.testRunRun })).toBeDisabled();
    expect(screen.getByText(ko.editor.dsIncompleteRow)).toBeInTheDocument();
  });

  it("incomplete 게이트 — single_row 행 번호에 0 입력 시 실행 버튼 disabled + 안내 문구 (최종 리뷰 S1)", async () => {
    const user = userEvent.setup();
    renderSection(YAML_2_STEPS);
    await openDatasetSection(user);
    await selectDataset(user);

    const rowNumInput = screen.getByLabelText(ko.editor.dsRowNumLabel);
    await user.clear(rowNumInput);
    await user.type(rowNumInput, "0");

    expect(screen.getByRole("button", { name: ko.editor.testRunRun })).toBeDisabled();
    expect(screen.getByText(ko.editor.dsIncompleteRow)).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/test-runs"))).toBe(false);
  });

  it("R15: 예상 요청 수가 최대 요청 수를 넘으면 힌트 표시, 넘지 않으면 미표시", async () => {
    const user = userEvent.setup();
    renderSection(YAML_2_STEPS);
    await openDatasetSection(user);
    await selectDataset(user);
    await user.click(screen.getByRole("radio", { name: ko.editor.dsModeSeq }));

    // 40행 × leaf 2 = 80 > maxRequests 50 (기본값)
    expect(screen.getByText(ko.editor.dsBudgetHint(80, 50))).toBeInTheDocument();

    await user.type(screen.getByLabelText(ko.editor.dsRowLimitLabel), "10");
    // 10행 × leaf 2 = 20 <= 50 → 힌트 사라짐
    expect(screen.queryByText(/예상 요청 수/)).not.toBeInTheDocument();
  });

  it("R14: SequentialRunPanel 렌더 + 기본 펼침(첫 실패 행) + 칩 스트립 미러", async () => {
    const user = userEvent.setup();
    testRunResponse = SEQ_MIRROR;
    renderSection(YAML_2_STEPS);
    await openDatasetSection(user);
    await selectDataset(user);
    await user.click(screen.getByRole("radio", { name: ko.editor.dsModeSeq }));
    await user.click(screen.getByRole("button", { name: ko.editor.testRunRun }));

    await screen.findByRole("region", { name: ko.editor.seqResultAria });

    const row2Toggle = screen.getByRole("button", { name: new RegExp(ko.editor.seqRowLabel(2)) });
    expect(row2Toggle).toHaveAttribute("aria-expanded", "true");

    const strip = screen.getByRole("group", { name: ko.editor.testFlowTitle });
    expect(
      within(strip).getByRole("button", { name: ko.editor.chipAriaFail("stepB") }),
    ).toBeInTheDocument();

    const row1Toggle = screen.getByRole("button", { name: new RegExp(ko.editor.seqRowLabel(1)) });
    await user.click(row1Toggle);

    expect(
      within(strip).getByRole("button", { name: ko.editor.chipAriaPass("stepB") }),
    ).toBeInTheDocument();
    expect(
      within(strip).queryByRole("button", { name: ko.editor.chipAriaFail("stepB") }),
    ).not.toBeInTheDocument();
  });

  it("T1: 데이터셋 선택 직후 — 미리보기 부재 + rows fetch 0 + 토글 aria-expanded=false (US1)", async () => {
    const user = userEvent.setup();
    renderSection(YAML_2_STEPS);
    await openDatasetSection(user);
    await selectDataset(user);

    const toggle = screen.getByRole("button", { name: ko.editor.dsPreviewToggle });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("region", { name: ko.dataset.previewAria("users") }),
    ).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/rows"))).toBe(false);
  });

  it("T2: 데이터 확인 클릭 → 렌더 + limit=10 fetch, 재클릭 → 닫힘 (US1)", async () => {
    const user = userEvent.setup();
    renderSection(YAML_2_STEPS);
    await openDatasetSection(user);
    await selectDataset(user);

    const toggle = screen.getByRole("button", { name: ko.editor.dsPreviewToggle });
    await user.click(toggle);
    const region = await screen.findByRole("region", { name: ko.dataset.previewAria("users") });
    expect(region).toBeInTheDocument();
    const rowsCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes("/rows"));
    expect(String(rowsCalls[0][0])).toContain("limit=10");

    // a11y fold-in(리뷰): 열린 토글은 region과 aria-controls로 연결돼야 한다.
    const controlsId = toggle.getAttribute("aria-controls");
    expect(controlsId).toBeTruthy();
    expect(controlsId).toBe(region.getAttribute("id"));

    await user.click(toggle);
    expect(
      screen.queryByRole("region", { name: ko.dataset.previewAria("users") }),
    ).not.toBeInTheDocument();
    // 닫힘 상태에선 aria-controls가 없어야 한다(HelpTip/VerdictBadge 이디엄).
    expect(toggle).not.toHaveAttribute("aria-controls");
  });

  it("T2b: 모드 전환에도 열림 상태 유지 (R1.3)", async () => {
    const user = userEvent.setup();
    renderSection(YAML_2_STEPS);
    await openDatasetSection(user);
    await selectDataset(user);
    await user.click(screen.getByRole("button", { name: ko.editor.dsPreviewToggle }));
    await screen.findByRole("region", { name: ko.dataset.previewAria("users") });

    await user.click(screen.getByRole("radio", { name: ko.editor.dsModeSeq }));

    expect(screen.getByRole("button", { name: ko.editor.dsPreviewToggle })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(
      screen.getByRole("region", { name: ko.dataset.previewAria("users") }),
    ).toBeInTheDocument();
  });

  it("T3: 미리보기 연 채 데이터셋 해제→재선택 → 닫힘 리셋 (R1.4)", async () => {
    const user = userEvent.setup();
    renderSection(YAML_2_STEPS);
    await openDatasetSection(user);
    await selectDataset(user);
    await user.click(screen.getByRole("button", { name: ko.editor.dsPreviewToggle }));
    await screen.findByRole("region", { name: ko.dataset.previewAria("users") });

    await user.selectOptions(screen.getByLabelText(ko.editor.dsPickLabel), "");
    await user.selectOptions(screen.getByLabelText(ko.editor.dsPickLabel), DATASET_ID);

    expect(screen.getByRole("button", { name: ko.editor.dsPreviewToggle })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(
      screen.queryByRole("region", { name: ko.dataset.previewAria("users") }),
    ).not.toBeInTheDocument();
  });

  it("T4: sequential — 행 클릭 → 시작 행 채움 + payload start_row 0-based (US3)", async () => {
    const user = userEvent.setup();
    testRunResponse = SEQ_OK;
    renderSection(YAML_2_STEPS);
    await openDatasetSection(user);
    await selectDataset(user);
    await user.click(screen.getByRole("radio", { name: ko.editor.dsModeSeq }));

    await user.click(screen.getByRole("button", { name: ko.editor.dsPreviewToggle }));
    await screen.findByRole("region", { name: ko.dataset.previewAria("users") });
    await user.click(screen.getByRole("button", { name: ko.dataset.selectRowAria(7) }));

    expect(screen.getByLabelText(ko.editor.dsStartRowLabel)).toHaveValue(7);
    await user.click(screen.getByRole("button", { name: ko.editor.testRunRun }));
    const body = lastTestRunBody();
    expect((body.dataset as { start_row: number }).start_row).toBe(6);
  });

  it("T5: sequential — 시작 행 직접 입력 → 해당 행 하이라이트, 빈 draft면 하이라이트 없음 (R3.3)", async () => {
    const user = userEvent.setup();
    renderSection(YAML_2_STEPS);
    await openDatasetSection(user);
    await selectDataset(user);
    await user.click(screen.getByRole("radio", { name: ko.editor.dsModeSeq }));
    await user.click(screen.getByRole("button", { name: ko.editor.dsPreviewToggle }));
    await screen.findByRole("region", { name: ko.dataset.previewAria("users") });

    await user.type(screen.getByLabelText(ko.editor.dsStartRowLabel), "3");
    expect(screen.getByRole("button", { name: ko.dataset.selectRowAria(3) })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await user.clear(screen.getByLabelText(ko.editor.dsStartRowLabel));
    expect(screen.getByRole("button", { name: ko.dataset.selectRowAria(3) })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });
});
