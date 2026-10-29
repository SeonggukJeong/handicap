import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { ApiError } from "../../../api/client";
import type { CheckRecord, CheckResult, PanelConfig } from "../../../api/monitors";
import type { StepTrace } from "../../../api/schemas";
import { ko } from "../../../i18n/ko";
import { formatDateHms } from "../../../monitor/time";
import { CheckRecordDialog } from "../CheckRecordDialog";

const getRecord = vi.fn();
vi.mock("../../../api/monitors", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../api/monitors")>()),
  getRecord: (...a: unknown[]) => getRecord(...a),
}));

const S1 = "01HX0000000000000000000001";
const S2 = "01HX0000000000000000000002";
const YAML = `version: 1
name: sc
steps:
  - id: "${S1}"
    name: "로그인"
    type: http
    request:
      method: POST
      url: https://h/x
  - id: "${S2}"
    name: "조회"
    type: http
    request:
      method: GET
      url: https://h/y
`;
vi.mock("../../../api/hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../api/hooks")>()),
  useScenarios: () => ({
    data: {
      scenarios: [{ id: "SC", name: "sc", yaml: YAML, version: 1, created_at: 0, updated_at: 0 }],
    },
  }),
}));

const AT = new Date(2026, 9, 29, 10, 11, 12).getTime();
const panel = {
  id: "P1",
  title: "결제",
  scenario_id: "SC",
} as unknown as PanelConfig;

const clicked: CheckResult = {
  at_ms: AT,
  verdict: "fail",
  latency_ms: 1234,
  reason: null,
  detail: null,
  display: [],
};

function http(over: Partial<StepTrace> & { body?: string; reqBody?: string | null } = {}) {
  const { body, reqBody, ...rest } = over;
  const step: StepTrace = {
    step_id: S1,
    kind: "http",
    loop_index: null,
    branch: null,
    request: {
      method: "GET",
      url: "https://h/x",
      headers: { "X-Req": "r1" },
      body: reqBody === undefined ? null : reqBody,
    },
    response: {
      status: 200,
      latency_ms: 12,
      download_ms: null,
      headers: { "X-Resp": "p1" },
      set_cookies: [],
      body: body ?? "plain-body",
      body_truncated: false,
    },
    extracted: {},
    unbound_vars: [],
    error: null,
    ...rest,
  };
  return step;
}

function rec(over: Partial<CheckRecord> = {}, steps: StepTrace[] = [http()]): CheckRecord {
  return {
    at_ms: AT,
    limit_kb: 128,
    result: { ...clicked },
    trace: {
      ok: true,
      total_ms: 20,
      steps,
      final_vars: {},
      truncated: false,
      error: null,
    },
    clipped: [],
    ...over,
  };
}

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}
const dlg = (c: CheckResult = clicked) => (
  <CheckRecordDialog boardId="B1" panel={panel} clicked={c} onClose={() => {}} />
);

beforeEach(() => getRecord.mockReset());
afterEach(() => vi.restoreAllMocks());

describe("CheckRecordDialog", () => {
  it("header_shows_clicked_result_immediately", async () => {
    getRecord.mockReturnValue(new Promise(() => {}));
    wrap(dlg());
    expect(screen.getByText(ko.monitor.stateFail)).toBeInTheDocument();
    expect(screen.getByText("1,234 ms")).toBeInTheDocument();
    expect(screen.getByText(ko.monitor.loading)).toBeInTheDocument();
    expect(screen.getByText(ko.monitor.recordTitle("결제", formatDateHms(AT)))).toBeInTheDocument();
    expect(getRecord).toHaveBeenCalledWith("B1", "P1", AT);
  });

  it("header_reason_from_record", async () => {
    getRecord.mockResolvedValue(
      rec({ result: { ...clicked, reason: "상태코드 500", detail: "기대 200" } }),
    );
    wrap(dlg());
    expect(await screen.findByText("상태코드 500")).toBeInTheDocument();
    expect(screen.getByText("기대 200")).toBeInTheDocument();
  });

  it("step_row_loop_chip_and_error", async () => {
    getRecord.mockResolvedValue(rec({}, [http({ loop_index: 2, error: "연결 거부" })]));
    wrap(dlg());
    expect(await screen.findByText("#2")).toBeInTheDocument();
    const err = screen.getByText("연결 거부");
    expect(err.className).toMatch(/red/);
  });

  it("missing_record_shows_message", async () => {
    getRecord.mockRejectedValue(new ApiError(404, "not found"));
    wrap(dlg());
    expect(await screen.findByText(ko.monitor.recordMissing)).toBeInTheDocument();
  });

  it("load_error_shows_message", async () => {
    getRecord.mockRejectedValue(new ApiError(500, "boom"));
    wrap(dlg());
    expect(await screen.findByText(ko.monitor.recordLoadError("boom"))).toBeInTheDocument();
  });

  it("null_trace_config_error / null_trace_timeout", async () => {
    getRecord.mockResolvedValue(rec({ trace: null }));
    const a = wrap(dlg({ ...clicked, verdict: "config_error" }));
    expect(await screen.findByText(ko.monitor.recordNoTraceConfig)).toBeInTheDocument();
    a.unmount();
    getRecord.mockResolvedValue(rec({ trace: null }));
    wrap(dlg({ ...clicked, verdict: "fail", at_ms: AT + 1 }));
    expect(await screen.findByText(ko.monitor.recordNoTraceTimeout)).toBeInTheDocument();
  });

  it("trace_error_line and truncated_trace_notice", async () => {
    const r = rec({}, []);
    r.trace!.error = "시나리오 없음";
    r.trace!.truncated = true;
    getRecord.mockResolvedValue(r);
    wrap(dlg());
    expect(
      await screen.findByText(ko.monitor.recordTraceError("시나리오 없음")),
    ).toBeInTheDocument();
    expect(screen.getByText(ko.monitor.recordTraceCut)).toBeInTheDocument();
  });

  it("steps_collapsed_by_default_single_step_expanded", async () => {
    getRecord.mockResolvedValue(rec({}, [http(), http({ step_id: S2 })]));
    const a = wrap(dlg());
    const rows = await screen.findAllByRole("button", { expanded: false });
    expect(rows).toHaveLength(2);
    expect(screen.queryByText(ko.monitor.recordReqHeaders)).not.toBeInTheDocument();
    expect(screen.queryByText(ko.monitor.recordRespHeaders)).not.toBeInTheDocument();
    a.unmount();
    getRecord.mockResolvedValue(rec({}, [http()]));
    wrap(dlg({ ...clicked, at_ms: AT + 1 }));
    expect(await screen.findByText(ko.monitor.recordRespHeaders)).toBeInTheDocument();
    expect(screen.getByRole("button", { expanded: true })).toBeInTheDocument();
  });

  it("step_row_summary", async () => {
    const ifRow: StepTrace = {
      ...http(),
      step_id: "IF1",
      kind: "if",
      branch: "none",
      request: null,
      response: null,
    };
    getRecord.mockResolvedValue(
      rec({}, [
        http({
          step_id: S1,
          request: { method: "GET", url: "https://h/x", headers: {}, body: null },
        }),
        ifRow,
        http({ step_id: "UNKNOWN" }),
      ]),
    );
    wrap(dlg());
    expect(
      await screen.findByRole("button", { name: "로그인 · GET https://h/x · 200 · 12 ms" }),
    ).toBeInTheDocument();
    // branchText("none") is non-identity: the raw "none" must not leak.
    expect(screen.getByText("조건 분기 → (미매치)")).toBeInTheDocument();
    expect(screen.queryByText(/→ none/)).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "UNKNOWN · GET https://h/x · 200 · 12 ms" }),
    ).toBeInTheDocument();
  });

  it("masked_hint_only_when_masked", async () => {
    getRecord.mockResolvedValue(
      rec({}, [
        http({
          request: {
            method: "GET",
            url: "https://h/x",
            headers: { Authorization: "Bearer ••••" },
            body: null,
          },
        }),
      ]),
    );
    const a = wrap(dlg());
    expect(await screen.findByText(ko.monitor.recordMaskedHint)).toBeInTheDocument();
    a.unmount();
    getRecord.mockResolvedValue(rec());
    wrap(dlg({ ...clicked, at_ms: AT + 1 }));
    await screen.findByText(ko.monitor.recordRespHeaders);
    expect(screen.queryByText(ko.monitor.recordMaskedHint)).not.toBeInTheDocument();
  });

  it("request_body_hidden_until_reveal_and_rehidden_on_reopen", async () => {
    const user = userEvent.setup();
    getRecord.mockResolvedValue(rec({}, [http({ reqBody: '{"pw":"p"}' })]));
    const a = wrap(dlg());
    expect(await screen.findByText(ko.monitor.recordReqBodyHidden)).toBeInTheDocument();
    expect(screen.queryByText(/pw/)).not.toBeInTheDocument();
    expect(screen.queryByText(/"p"/)).not.toBeInTheDocument();
    const revealBtn = screen.getByRole("button", { name: "로그인 요청 본문 보기" });
    expect(revealBtn).toHaveAttribute("aria-expanded", "false");
    expect(revealBtn).toHaveTextContent(ko.monitor.recordReveal);
    await user.click(revealBtn);
    expect(screen.getByText(/"p"/)).toBeInTheDocument();
    const hideBtn = screen.getByRole("button", { name: "로그인 요청 본문 가리기" });
    expect(hideBtn).toHaveAttribute("aria-expanded", "true");
    expect(hideBtn).toHaveTextContent(ko.monitor.recordHide);
    const region = document.getElementById(hideBtn.getAttribute("aria-controls")!);
    expect(region).toContainElement(screen.getByText(/"p"/));
    expect(screen.queryByText(ko.monitor.recordReqBodyHidden)).not.toBeInTheDocument();
    a.unmount();
    wrap(dlg());
    expect(await screen.findByText(ko.monitor.recordReqBodyHidden)).toBeInTheDocument();
    expect(screen.queryByText(/"p"/)).not.toBeInTheDocument();
  });

  it("clipped_body_shows_limit_notice", async () => {
    getRecord.mockResolvedValue(
      rec({ clipped: [{ step: 0, side: "response" }], limit_kb: 128 }, [
        http({ body: '{"a":"cut' }),
      ]),
    );
    wrap(dlg());
    expect(await screen.findByText(ko.monitor.recordClipped(128))).toBeInTheDocument();
    expect(screen.getByText('{"a":"cut').tagName).toBe("PRE");
  });

  it("clipped_valid_json_body_is_raw_without_tree", async () => {
    // Valid JSON that is still flagged clipped must NOT become a tree.
    getRecord.mockResolvedValue(
      rec({ clipped: [{ step: 0, side: "response" }], limit_kb: 128 }, [http({ body: '{"a":1}' })]),
    );
    wrap(dlg());
    expect(await screen.findByText(ko.monitor.recordClipped(128))).toBeInTheDocument();
    expect(screen.getByText('{"a":1}').tagName).toBe("PRE");
    expect(
      screen.queryByRole("button", { name: ko.monitor.recordViewRaw }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: ko.monitor.recordViewTree }),
    ).not.toBeInTheDocument();
  });

  it("clipped_step_index_maps_to_trace_steps_not_http_only", async () => {
    const ifRow: StepTrace = {
      ...http(),
      step_id: "IF1",
      kind: "if",
      branch: "then",
      request: null,
      response: null,
    };
    getRecord.mockResolvedValue(
      rec({ clipped: [{ step: 1, side: "response" }], limit_kb: 128 }, [
        ifRow,
        http({ body: "plain-body" }),
      ]),
    );
    const user = userEvent.setup();
    wrap(dlg());
    const row = await screen.findByRole("button", { expanded: false });
    expect(screen.queryByText(ko.monitor.recordClipped(128))).not.toBeInTheDocument();
    await user.click(row);
    expect(screen.getAllByText(ko.monitor.recordClipped(128))).toHaveLength(1);
    const pre = screen.getByText("plain-body");
    expect(
      within(pre.closest("div")!.parentElement as HTMLElement).getByText(
        ko.monitor.recordClipped(128),
      ),
    ).toBeInTheDocument();
  });

  it("clipped_request_notice_visible_while_body_hidden", async () => {
    getRecord.mockResolvedValue(
      rec({ clipped: [{ step: 0, side: "request" }], limit_kb: 128 }, [
        http({ reqBody: '{"pw":"p"}' }),
      ]),
    );
    wrap(dlg());
    expect(await screen.findByText(ko.monitor.recordReqBodyHidden)).toBeInTheDocument();
    expect(screen.getByText(ko.monitor.recordClipped(128))).toBeInTheDocument();
    expect(screen.queryByText(/pw/)).not.toBeInTheDocument();
  });

  it("reveal_buttons_have_distinct_names_per_step", async () => {
    getRecord.mockResolvedValue(
      rec({}, [http({ reqBody: "a" }), http({ step_id: S2, reqBody: "b" })]),
    );
    const user = userEvent.setup();
    wrap(dlg());
    const rows = await screen.findAllByRole("button", { expanded: false });
    for (const r of rows) await user.click(r);
    const names = screen
      .getAllByRole("button", { name: /요청 본문 보기$/ })
      .map((b) => b.getAttribute("aria-label"));
    expect(names).toEqual(["로그인 요청 본문 보기", "조회 요청 본문 보기"]);
  });

  it("engine_truncated_notice", async () => {
    const s = http();
    s.response!.body_truncated = true;
    getRecord.mockResolvedValue(rec({}, [s]));
    wrap(dlg());
    expect(await screen.findByText(ko.monitor.recordEngineTruncated)).toBeInTheDocument();
  });

  it("large_json_body_shows_raw_not_tree", async () => {
    const big = JSON.stringify({ a: "x".repeat(70 * 1024) });
    getRecord.mockResolvedValue(rec({}, [http({ body: big })]));
    const a = wrap(dlg());
    expect(await screen.findByText(ko.monitor.recordTreeTooLarge)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: ko.monitor.recordViewTree }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: ko.monitor.recordViewRaw }),
    ).not.toBeInTheDocument();
    a.unmount();

    getRecord.mockResolvedValue(rec({}, [http({ body: '{"k":"v"}' })]));
    wrap(dlg({ ...clicked, at_ms: AT + 1 }));
    const tree = await screen.findByText(/k: "v"/);
    expect(tree).toBeInTheDocument();
    expect(screen.queryByText(ko.monitor.recordTreeTooLarge)).not.toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: ko.monitor.recordViewRaw });
    await userEvent.setup().click(toggle);
    expect(screen.getByText('{"k":"v"}').tagName).toBe("PRE");
  });

  it("multibyte_body_counts_utf8_bytes", async () => {
    // 25k 한글 = 75KB UTF-8 (글자 수로는 64KB 미만)
    const body = JSON.stringify({ a: "가".repeat(25_000) });
    getRecord.mockResolvedValue(rec({}, [http({ body })]));
    wrap(dlg());
    expect(await screen.findByText(ko.monitor.recordTreeTooLarge)).toBeInTheDocument();
  });

  it("wrapped_json_shows_unwrapped_notice", async () => {
    getRecord.mockResolvedValue(
      rec({}, [http({ body: JSON.stringify(JSON.stringify({ k: "v" })) })]),
    );
    wrap(dlg());
    expect(await screen.findByText(ko.monitor.previewUnwrapped)).toBeInTheDocument();
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/k: "v"/)).toBeInTheDocument();
  });
});
