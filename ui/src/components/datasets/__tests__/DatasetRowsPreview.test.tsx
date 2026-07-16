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
    const limit = Number(u.searchParams.get("limit") ?? "50");
    const n = Math.max(Math.min(total - offset, limit), 0);
    const rows = Array.from({ length: n }, (_, i) => ({
      name: `r${offset + i}`,
      val: String(offset + i),
    }));
    return Promise.resolve(jsonResponse({ rows, offset, total }));
  });
}
function renderPreview(rowCount = 1000, columns: string[] = ["name", "val"]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <DatasetRowsPreview datasetId="01J" name="users" columns={columns} rowCount={rowCount} />
    </QueryClientProvider>,
  );
}
const panel = () => screen.getByRole("region", { name: ko.dataset.previewAria("users") });

describe("DatasetRowsPreview", () => {
  it("첫 페이지: 범위 표기·행 번호 1부터 (R5·R6)", async () => {
    mockRowsByUrl(1000);
    renderPreview();
    expect(await screen.findByText(ko.dataset.rowsRange(1, 50, 1000))).toBeInTheDocument();
    const cells = within(panel()).getAllByRole("cell");
    expect(cells[0]).toHaveTextContent("1"); // # 열
    expect(within(panel()).getByText("r0")).toBeInTheDocument();
  });

  it("다음 → offset 50 페이지·행 번호 51 (R5)", async () => {
    const user = userEvent.setup();
    mockRowsByUrl(1000);
    renderPreview();
    await screen.findByText(ko.dataset.rowsRange(1, 50, 1000));
    await user.click(screen.getByRole("button", { name: ko.dataset.nextPage }));
    expect(await screen.findByText(ko.dataset.rowsRange(51, 100, 1000))).toBeInTheDocument();
    expect(within(panel()).getByText("r50")).toBeInTheDocument();
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
    mockRowsByUrl(30); // 총 30행 = 1페이지
    renderPreview(30);
    await screen.findByText(ko.dataset.rowsRange(1, 30, 30));
    expect(screen.getByRole("button", { name: ko.dataset.prevPage })).toBeDisabled();
    expect(screen.getByRole("button", { name: ko.dataset.nextPage })).toBeDisabled();
  });

  it("페이지 전환 중(placeholder) 이전/다음 둘 다 disabled (R5)", async () => {
    mockRowsByUrl(1000);
    renderPreview();
    await screen.findByText(ko.dataset.rowsRange(1, 50, 1000));
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
    await screen.findByText(ko.dataset.rowsRange(1, 50, 1000));
    await user.type(screen.getByLabelText(ko.dataset.jumpLabel), "743");
    await user.click(screen.getByRole("button", { name: ko.dataset.jumpGo }));
    expect(await screen.findByText(ko.dataset.rowsRange(743, 792, 1000))).toBeInTheDocument();
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
});
