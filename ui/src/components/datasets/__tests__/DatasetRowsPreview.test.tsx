import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DatasetRowsPreview } from "../DatasetRowsPreview";
import { ko } from "../../../i18n/ko";

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  window.localStorage.clear();
});
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
/** offset/limit 쿼리를 읽어 total행짜리 데이터셋을 시뮬레이트. 셀 = r{전역idx}. */
function mockRowsByUrl(total: number) {
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const u = new URL(String(input), "http://localhost");
    const offset = Number(u.searchParams.get("offset") ?? "0");
    const limit = Number(u.searchParams.get("limit") ?? "10");
    const n = Math.max(Math.min(total - offset, limit), 0);
    const rows = Array.from({ length: n }, (_, i) => ({
      name: `r${offset + i}`,
      val: String(offset + i),
    }));
    return Promise.resolve(jsonResponse({ rows, offset, total }));
  });
}
function renderPreview(
  rowCount = 1000,
  columns: string[] = ["name", "val"],
  extra: { onSelectRow?: (rowIndex: number) => void; selectedRow?: number } = {},
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <DatasetRowsPreview
        datasetId="01J"
        name="users"
        columns={columns}
        rowCount={rowCount}
        {...extra}
      />
    </QueryClientProvider>,
  );
}
const panel = () => screen.getByRole("region", { name: ko.dataset.previewAria("users") });

describe("DatasetRowsPreview", () => {
  it("첫 페이지: 범위 표기·행 번호 1부터 (R5·R6)", async () => {
    mockRowsByUrl(1000);
    renderPreview();
    expect(await screen.findByText(ko.dataset.rowsRange(1, 10, 1000))).toBeInTheDocument();
    const cells = within(panel()).getAllByRole("cell");
    expect(cells[0]).toHaveTextContent("1"); // # 열
    expect(within(panel()).getByText("r0")).toBeInTheDocument();
  });

  it("다음 → offset 10 페이지·행 번호 11 (R5)", async () => {
    const user = userEvent.setup();
    mockRowsByUrl(1000);
    renderPreview();
    await screen.findByText(ko.dataset.rowsRange(1, 10, 1000));
    await user.click(screen.getByRole("button", { name: ko.dataset.nextPage }));
    expect(await screen.findByText(ko.dataset.rowsRange(11, 20, 1000))).toBeInTheDocument();
    expect(within(panel()).getByText("r10")).toBeInTheDocument();
  });

  it("행 번호는 로컬 state가 아니라 응답 offset 기준 (R6)", async () => {
    // 컴포넌트는 offset 0을 요청했지만 응답이 offset 50을 에코 → 번호는 51부터
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ rows: [{ name: "rX", val: "9" }], offset: 50, total: 1000 }),
    );
    renderPreview();
    expect(await screen.findByText(ko.dataset.rowsRange(51, 51, 1000))).toBeInTheDocument();
    expect(within(panel()).getAllByRole("cell")[0]).toHaveTextContent("51");
  });

  it("경계 disabled: offset 0에서 이전, 마지막 페이지에서 다음 (R5)", async () => {
    mockRowsByUrl(8); // 총 8행 = 1페이지
    renderPreview(8);
    await screen.findByText(ko.dataset.rowsRange(1, 8, 8));
    expect(screen.getByRole("button", { name: ko.dataset.prevPage })).toBeDisabled();
    expect(screen.getByRole("button", { name: ko.dataset.nextPage })).toBeDisabled();
  });

  it("페이지 전환 중(placeholder) 이전/다음 둘 다 disabled (R5)", async () => {
    mockRowsByUrl(1000);
    renderPreview();
    await screen.findByText(ko.dataset.rowsRange(1, 10, 1000));
    // 2번째 페이지 요청은 영영 pending
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: ko.dataset.nextPage }));
    expect(screen.getByRole("button", { name: ko.dataset.nextPage })).toBeDisabled();
    expect(screen.getByRole("button", { name: ko.dataset.prevPage })).toBeDisabled();
    // placeholder 동안 이전 페이지 내용 유지 (R13 keepPreviousData)
    expect(within(panel()).getByText("r0")).toBeInTheDocument();
  });

  it("행 이동: 743 → 743행부터, 범위 밖은 clamp (R7)", async () => {
    const user = userEvent.setup();
    mockRowsByUrl(1000);
    renderPreview();
    await screen.findByText(ko.dataset.rowsRange(1, 10, 1000));
    await user.type(screen.getByLabelText(ko.dataset.jumpLabel), "743");
    await user.click(screen.getByRole("button", { name: ko.dataset.jumpGo }));
    expect(await screen.findByText(ko.dataset.rowsRange(743, 752, 1000))).toBeInTheDocument();
    expect(within(panel()).getByText("r742")).toBeInTheDocument();
    // clamp: 5000 → 마지막 행(1000)
    await user.clear(screen.getByLabelText(ko.dataset.jumpLabel));
    await user.type(screen.getByLabelText(ko.dataset.jumpLabel), "5000");
    await user.click(screen.getByRole("button", { name: ko.dataset.jumpGo }));
    expect(await screen.findByText(ko.dataset.rowsRange(1000, 1000, 1000))).toBeInTheDocument();
  });

  it("컬럼 순서는 columns prop(메타) 순서 — 행 객체 키 순서 아님 (R8)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ rows: [{ a: "1", b: "2" }], offset: 0, total: 1 }),
    );
    renderPreview(1, ["b", "a"]); // 메타 순서 b,a (알파벳 역순)
    await screen.findByText(ko.dataset.rowsRange(1, 1, 1));
    const headers = within(panel()).getAllByRole("columnheader");
    expect(headers.map((h) => h.textContent)).toEqual([ko.dataset.rowNumHeader, "b", "a"]);
  });

  it("셀에 title 툴팁 (R9)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ rows: [{ name: "LONGVALUE", val: "v" }], offset: 0, total: 1 }),
    );
    renderPreview(1);
    await screen.findByText(ko.dataset.rowsRange(1, 1, 1));
    expect(within(panel()).getByText("LONGVALUE")).toHaveAttribute("title", "LONGVALUE");
  });

  it("0행이면 빈 상태 (R10)", async () => {
    mockRowsByUrl(0);
    renderPreview(0);
    expect(await screen.findByText(ko.dataset.noRows)).toBeInTheDocument();
  });

  it("에러면 Callout (R10)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "not found" }, 404));
    renderPreview();
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });

  it("행 이동 입력은 w-24 래퍼로 폭 제한 — Input 직접 w-24는 w-full에 진다 (줄바꿈 회귀 가드)", async () => {
    mockRowsByUrl(1000);
    renderPreview();
    await screen.findByText(ko.dataset.rowsRange(1, 10, 1000));
    const input = screen.getByLabelText(ko.dataset.jumpLabel);
    expect(input.parentElement).toHaveClass("w-24");
    expect(input).not.toHaveClass("w-24");
    for (const name of [ko.dataset.jumpGo, ko.dataset.prevPage, ko.dataset.nextPage]) {
      expect(screen.getByRole("button", { name })).toHaveClass("whitespace-nowrap");
    }
    const sizeSelect = screen.getByLabelText(ko.dataset.pageSizeLabel);
    expect(sizeSelect.parentElement).toHaveClass("w-20");
    expect(sizeSelect).not.toHaveClass("w-20");
  });

  it("이동 후 행 이동 입력이 비워진다", async () => {
    const user = userEvent.setup();
    mockRowsByUrl(1000);
    renderPreview();
    await screen.findByText(ko.dataset.rowsRange(1, 10, 1000));
    await user.type(screen.getByLabelText(ko.dataset.jumpLabel), "743");
    await user.click(screen.getByRole("button", { name: ko.dataset.jumpGo }));
    await screen.findByText(ko.dataset.rowsRange(743, 752, 1000));
    expect(screen.getByLabelText(ko.dataset.jumpLabel)).toHaveValue(null);
  });

  it("onSelectRow 미전달이면 행 번호 셀에 버튼이 없다 (기존 거동 — R12)", async () => {
    mockRowsByUrl(1000);
    renderPreview();
    await screen.findByText(ko.dataset.rowsRange(1, 10, 1000));
    expect(screen.queryByRole("button", { name: /행 \d+ 선택/ })).not.toBeInTheDocument();
  });

  it("onSelectRow 전달 시 행 번호 버튼 클릭이 0-based idx로 콜백", async () => {
    const user = userEvent.setup();
    const onSelectRow = vi.fn();
    mockRowsByUrl(1000);
    renderPreview(1000, ["name", "val"], { onSelectRow });
    await screen.findByText(ko.dataset.rowsRange(1, 10, 1000));
    await user.click(screen.getByRole("button", { name: ko.dataset.selectRowAria(2) }));
    expect(onSelectRow).toHaveBeenCalledWith(1); // 표시 1-based → 와이어 0-based
  });

  it("selectedRow 행은 하이라이트 + aria-pressed", async () => {
    mockRowsByUrl(1000);
    renderPreview(1000, ["name", "val"], { onSelectRow: () => {}, selectedRow: 1 });
    await screen.findByText(ko.dataset.rowsRange(1, 10, 1000));
    const btn = screen.getByRole("button", { name: ko.dataset.selectRowAria(2) });
    expect(btn).toHaveAttribute("aria-pressed", "true");
    expect(btn.closest("tr")).toHaveClass("bg-accent-50");
    // 비선택 행은 하이라이트 없음
    const other = screen.getByRole("button", { name: ko.dataset.selectRowAria(1) });
    expect(other.closest("tr")).not.toHaveClass("bg-accent-50");
  });

  it("T6: 기본 페이지 크기 10 — 첫 fetch limit=10", async () => {
    mockRowsByUrl(1000);
    renderPreview();
    await screen.findByText(ko.dataset.rowsRange(1, 10, 1000));
    expect(String(fetchMock.mock.calls[0][0])).toContain("limit=10");
  });

  it("T7: 크기 25 선택 → limit=25 refetch + localStorage 저장", async () => {
    const user = userEvent.setup();
    mockRowsByUrl(1000);
    renderPreview();
    await screen.findByText(ko.dataset.rowsRange(1, 10, 1000));
    await user.selectOptions(screen.getByLabelText(ko.dataset.pageSizeLabel), "25");
    expect(await screen.findByText(ko.dataset.rowsRange(1, 25, 1000))).toBeInTheDocument();
    const urls = fetchMock.mock.calls.map(([u]) => String(u));
    expect(urls.some((u) => u.includes("limit=25"))).toBe(true);
    expect(window.localStorage.getItem("handicap:dataset:preview-page-size:v1")).toBe("25");
  });

  it("T8: localStorage 저장값 25로 시드된다", async () => {
    window.localStorage.setItem("handicap:dataset:preview-page-size:v1", "25");
    mockRowsByUrl(1000);
    renderPreview();
    expect(await screen.findByText(ko.dataset.rowsRange(1, 25, 1000))).toBeInTheDocument();
  });

  it("T9: 크기 변경 시 offset 유지 + 이전/다음 보폭 = 현재 크기", async () => {
    const user = userEvent.setup();
    mockRowsByUrl(1000);
    renderPreview();
    await screen.findByText(ko.dataset.rowsRange(1, 10, 1000));
    await user.click(screen.getByRole("button", { name: ko.dataset.nextPage })); // offset 10
    await screen.findByText(ko.dataset.rowsRange(11, 20, 1000));
    await user.selectOptions(screen.getByLabelText(ko.dataset.pageSizeLabel), "25");
    // offset 10 유지 + 25행 렌더
    expect(await screen.findByText(ko.dataset.rowsRange(11, 35, 1000))).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: ko.dataset.nextPage })); // offset 35
    expect(await screen.findByText(ko.dataset.rowsRange(36, 60, 1000))).toBeInTheDocument();
  });
});
