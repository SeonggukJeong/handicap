import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ImportBoards } from "../ImportBoards";
import { ImportResultCallout } from "../ImportResultCallout";
import { readTextFile } from "../../../api/readTextFile";
import { MAX_IMPORT_BYTES, type ImportResult } from "../../../api/monitorTransfer";
import { ko } from "../../../i18n/ko";

vi.mock("../../../api/readTextFile", () => ({ readTextFile: vi.fn() }));

const fetchMock = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.mocked(readTextFile).mockResolvedValue('{"format":"handicap-bundle"}');
});
afterEach(() => vi.unstubAllGlobals());

function res(status: number, body: unknown): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
const board = (over: Record<string, unknown> = {}) => ({
  id: "B1",
  name: "야간 결제 점검",
  pc_name: null,
  conflict: false,
  exists: false,
  enabled: false,
  scenarios: [],
  environments: [],
  warnings: [],
  ...over,
});
const analysis = (boards: unknown[]) => ({
  boards,
  summary: {
    boards: boards.length,
    conflicts: boards.filter((b) => (b as { conflict: boolean }).conflict).length,
    scenarios: 0,
    environments: 0,
  },
});
const counts = (added = 0, unchanged = 0) => ({ added, updated: 0, copied: 0, unchanged });
const result = (over: Partial<ImportResult> = {}): ImportResult => ({
  boards: [
    { id: "B1", name: "가", action: "added", warnings: [] },
    { id: "B2", name: "나", action: "added", warnings: [] },
  ],
  scenarios: counts(1, 0),
  environments: counts(0, 0),
  renamed: [],
  ...over,
});

function setup() {
  const onDone = vi.fn();
  const utils = render(
    <MemoryRouter>
      <ImportBoards onDone={onDone} />
    </MemoryRouter>,
  );
  const input = utils.container.querySelector('input[type="file"]') as HTMLInputElement;
  const pick = (file?: File) =>
    fireEvent.change(input, {
      target: { files: [file ?? new File(["x"], "a.handicap-board.json")] },
    });
  return { onDone, input, pick };
}

describe("ImportBoards", () => {
  it("hidden_input_is_triple_guarded", () => {
    const { input } = setup();
    expect(input).toHaveClass("hidden");
    expect(input).toHaveAttribute("tabindex", "-1");
    expect(input).toHaveAttribute("aria-hidden", "true");
    expect(input.accept).toBe(".json,application/json");
  });

  it("oversize_file_shows_error_without_request", async () => {
    const { pick } = setup();
    const f = new File(["x"], "big.json");
    Object.defineProperty(f, "size", { value: MAX_IMPORT_BYTES + 1 });
    pick(f);
    expect(await screen.findByText(ko.monitor.transfer.tooLarge)).toBeInTheDocument();
    expect(
      screen.getByRole("dialog", { name: ko.monitor.transfer.errorTitle }),
    ).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("analyze_400_shows_reason_and_no_import", async () => {
    fetchMock.mockResolvedValueOnce(res(400, { error: "핸디캡 보드 파일이 아닙니다" }));
    const { pick, onDone } = setup();
    pick();
    expect(await screen.findByText("핸디캡 보드 파일이 아닙니다")).toBeInTheDocument();
    expect(
      screen.getByRole("dialog", { name: ko.monitor.transfer.errorTitle }),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onDone).not.toHaveBeenCalled();
  });

  it("no_conflict_imports_and_shows_result", async () => {
    fetchMock
      .mockResolvedValueOnce(res(200, analysis([board(), board({ id: "B2", name: "b" })])))
      .mockResolvedValueOnce(res(200, result()));
    const { pick, onDone } = setup();
    pick();
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toMatch(/\/import$/);
    render(
      <MemoryRouter>
        <ImportResultCallout result={onDone.mock.calls[0][0]} />
      </MemoryRouter>,
    );
    expect(screen.getByText("보드 2개 가져옴(새로 2)")).toBeInTheDocument();
    expect(screen.getByText("시나리오: 새로 1")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "가" })).toHaveAttribute("href", "/monitors/B1");
  });

  it("conflicts_show_list_and_no_import", async () => {
    const b = board({
      conflict: true,
      exists: true,
      pc_name: "야간 결제 점검",
      scenarios: [{ id: "S1", name: "결제 흐름", state: "different" }],
      environments: [
        { id: "E1", name: "운영", state: "different" },
        { id: "E2", name: "동일환경", state: "same" },
      ],
    });
    fetchMock.mockResolvedValueOnce(res(200, analysis([b, board({ id: "B2", name: "무관" })])));
    const { pick, onDone } = setup();
    pick();
    const t = ko.monitor.transfer;
    expect(await screen.findByText(t.conflictBoard("야간 결제 점검"))).toBeInTheDocument();
    expect(screen.getByText(t.conflictScenario("결제 흐름", "야간 결제 점검"))).toBeInTheDocument();
    expect(screen.getByText(t.conflictEnv("운영", "야간 결제 점검"))).toBeInTheDocument();
    expect(screen.queryByText(/무관/)).toBeNull();
    expect(screen.queryByText(/동일환경/)).toBeNull();
    expect(screen.getByRole("dialog", { name: t.conflictTitle })).toBeInTheDocument();
    expect(screen.getByText(t.conflictLead)).toBeInTheDocument();
    expect(screen.getByText(t.conflictNote)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onDone).not.toHaveBeenCalled();
  });

  it("import_409_shows_same_list", async () => {
    fetchMock.mockResolvedValueOnce(res(200, analysis([board()]))).mockResolvedValueOnce(
      res(409, {
        error: "conflicts",
        boards: [board({ conflict: true, exists: true, name: "경합" })],
      }),
    );
    const { pick, onDone } = setup();
    pick();
    expect(await screen.findByText(ko.monitor.transfer.conflictBoard("경합"))).toBeInTheDocument();
    expect(screen.queryByText("conflicts")).toBeNull();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("close_button_closes_dialog", async () => {
    fetchMock.mockResolvedValueOnce(res(400, { error: "x오류" }));
    const { pick } = setup();
    pick();
    await screen.findByText("x오류");
    // Modal header ✕ shares the accessible name; the footer button is the one with text.
    fireEvent.click(screen.getByText(ko.monitor.transfer.close));
    expect(screen.queryByText("x오류")).toBeNull();
  });
});

describe("ImportResultCallout", () => {
  const renderCallout = (r: ImportResult) =>
    render(
      <MemoryRouter>
        <ImportResultCallout result={r} />
      </MemoryRouter>,
    );

  it("result_shows_renamed_and_warnings", () => {
    renderCallout(
      result({
        boards: [{ id: "B1", name: "가", action: "added", warnings: ["칸 1: 경고문"] }],
        renamed: [{ kind: "environment", from: "운영", to: "운영 (2)", reason: "name_taken" }],
      }),
    );
    expect(screen.getByText("보드 1개 가져옴(새로 1)")).toBeInTheDocument();
    expect(
      screen.getByText(ko.monitor.transfer.renamed("운영 (2)", "환경", "운영")),
    ).toBeInTheDocument();
    expect(screen.getByText(ko.monitor.transfer.warningHead("가"))).toBeInTheDocument();
    expect(screen.getByText("칸 1: 경고문")).toBeInTheDocument();
  });

  it("result_omits_zero_parts", () => {
    const { unmount } = renderCallout(
      result({ scenarios: counts(0, 0), environments: counts(0, 0) }),
    );
    expect(screen.queryByText(/^시나리오:/)).toBeNull();
    expect(screen.queryByText(/^환경:/)).toBeNull();
    unmount();
    renderCallout(result({ scenarios: counts(1, 0), environments: counts(0, 2) }));
    expect(screen.getByText("시나리오: 새로 1")).toBeInTheDocument();
    expect(screen.getByText("환경: 기존 것 사용 2")).toBeInTheDocument();
  });
});
