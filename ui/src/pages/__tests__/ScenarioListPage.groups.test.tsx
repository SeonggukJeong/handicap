import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ko } from "../../i18n/ko";
import { ScenarioListPage } from "../ScenarioListPage";

const fetchMock = vi.fn();
const KEY = "handicap:scenarios:collapsed-groups:v1";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sc(id: string, name: string, group: string | null) {
  return {
    id,
    name,
    yaml: `version: 1\nname: ${name}\nsteps: []\n`,
    version: 1,
    created_at: 0,
    updated_at: 0,
    group,
  };
}

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ScenarioListPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function serve(scenarios: ReturnType<typeof sc>[]) {
  fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ scenarios })));
}

const MIXED = [
  sc("S1", "로그인", null),
  sc("S2", "주문", "쇼핑"),
  sc("S3", "로그인", "결제"),
  sc("S4", "로그인", "쇼핑"),
  sc("S5", "조회", null),
];

describe("ScenarioListPage 그룹 묶음·접기 (US1)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("그룹 0개: 묶음 상자 없음·서버 응답 순서·행마다 복제/삭제/실행 목록", async () => {
    serve([sc("A", "하나", null), sc("B", "둘", null), sc("C", "셋", null)]);
    renderPage();
    const rows = await screen.findAllByTestId("scenario-row");
    expect(screen.queryAllByTestId("scenario-group")).toHaveLength(0);
    expect(rows.map((r) => within(r).getAllByRole("link")[0].textContent)).toEqual([
      "하나",
      "둘",
      "셋",
    ]);
    for (const r of rows) {
      expect(within(r).getByRole("button", { name: ko.pages.duplicate })).toBeInTheDocument();
      expect(within(r).getByRole("button", { name: ko.pages.deleteBtn })).toBeInTheDocument();
      expect(within(r).getByRole("link", { name: ko.pages.runsLink })).toBeInTheDocument();
    }
  });

  it("그룹 있음: 묶음이 이름순으로 먼저, 묶음 밖 행은 마지막 묶음 뒤", async () => {
    serve(MIXED);
    renderPage();
    const boxes = await screen.findAllByTestId("scenario-group");
    expect(boxes.map((b) => b.getAttribute("data-group-name"))).toEqual(["결제", "쇼핑"]);
    const ungrouped = screen.getByTestId("scenario-ungrouped");
    expect(
      boxes[1].compareDocumentPosition(ungrouped) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(within(ungrouped).getAllByTestId("scenario-row")).toHaveLength(2);
    expect(within(boxes[1]).getAllByTestId("scenario-row")).toHaveLength(2);
  });

  it("접기 버튼 접근 이름에 그룹 이름과 개수 숫자가 들어 있다", async () => {
    serve(MIXED);
    renderPage();
    const box = (await screen.findAllByTestId("scenario-group"))[1];
    const btn = within(box).getByRole("button", { expanded: true });
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    expect(btn).toHaveAccessibleName(expect.stringContaining("쇼핑"));
    expect(btn.textContent).toContain("2");
    expect(btn).toHaveAccessibleName(expect.stringContaining(ko.scenarioGroups.groupCount(2)));
    expect(btn).toHaveAccessibleName(expect.stringMatching(/\(2\)/));
  });

  it("접기: false가 되고 행이 사라지며 다시 마운트해도 접힌 채", async () => {
    serve(MIXED);
    const user = userEvent.setup();
    const first = renderPage();
    let box = (await screen.findAllByTestId("scenario-group"))[1];
    await user.click(within(box).getByRole("button", { expanded: true }));
    box = screen.getAllByTestId("scenario-group")[1];
    expect(within(box).getByRole("button", { expanded: false })).toBeInTheDocument();
    expect(within(box).queryAllByTestId("scenario-row")).toHaveLength(0);
    first.unmount();

    renderPage();
    box = (await screen.findAllByTestId("scenario-group"))[1];
    expect(within(box).getByRole("button", { expanded: false })).toBeInTheDocument();
    expect(within(box).queryAllByTestId("scenario-row")).toHaveLength(0);
    const other = screen.getAllByTestId("scenario-group")[0];
    expect(within(other).getAllByTestId("scenario-row")).toHaveLength(1);
  });

  it("머리 행의 다른 곳을 눌러서는 접히지 않는다", async () => {
    serve(MIXED);
    const user = userEvent.setup();
    renderPage();
    const box = (await screen.findAllByTestId("scenario-group"))[1];
    await user.click(within(box).getByTestId("scenario-group-header"));
    expect(within(box).getByRole("button", { expanded: true })).toBeInTheDocument();
    expect(within(box).getAllByTestId("scenario-row")).toHaveLength(2);
  });

  it("이제 없는 그룹 이름이 저장돼 있어도 그려지고, 목록이 도착하면 저장에서 빠진다(있는 이름은 남는다)", async () => {
    window.localStorage.setItem(KEY, JSON.stringify(["사라진그룹", "쇼핑"]));
    serve(MIXED);
    const user = userEvent.setup();
    renderPage();
    const boxes = await screen.findAllByTestId("scenario-group");
    expect(boxes).toHaveLength(2);
    await waitFor(() =>
      expect(JSON.parse(window.localStorage.getItem(KEY) ?? "null")).toEqual(["쇼핑"]),
    );
    expect(within(boxes[1]).getByRole("button", { expanded: false })).toBeInTheDocument();
    await user.click(within(boxes[0]).getByRole("button", { expanded: true }));
    expect(JSON.parse(window.localStorage.getItem(KEY) ?? "null")).toEqual(["쇼핑", "결제"]);
  });

  it("같은 이름의 시나리오가 두 묶음에 있어도 각 묶음 안에서 찾아진다", async () => {
    serve(MIXED);
    renderPage();
    const boxes = await screen.findAllByTestId("scenario-group");
    expect(within(boxes[0]).getByRole("link", { name: "로그인" })).toHaveAttribute(
      "href",
      "/scenarios/S3",
    );
    expect(within(boxes[1]).getByRole("link", { name: "로그인" })).toHaveAttribute(
      "href",
      "/scenarios/S4",
    );
  });

  it("깨진 저장값이면 전부 펼쳐서 그린다", async () => {
    window.localStorage.setItem(KEY, "{broken");
    serve(MIXED);
    renderPage();
    const boxes = await screen.findAllByTestId("scenario-group");
    for (const b of boxes) {
      expect(within(b).getByRole("button", { expanded: true })).toBeInTheDocument();
    }
  });

  it("모든 행이 같은 열 템플릿을 쓴다(열 머리·묶음 안·묶음 밖)", async () => {
    serve(MIXED);
    renderPage();
    await screen.findAllByTestId("scenario-group");
    const tpl = (el: HTMLElement) =>
      Array.from(el.classList).find((c) => c.startsWith("grid-cols-"));
    const header = screen.getByTestId("scenario-columns");
    const rows = screen.getAllByTestId("scenario-row");
    expect(tpl(header)).toBeTruthy();
    for (const r of rows) expect(tpl(r)).toBe(tpl(header));
  });

  it("모든 시나리오가 그룹에 있으면 scenario-ungrouped를 그리지 않는다", async () => {
    serve([sc("A", "하나", "쇼핑"), sc("B", "둘", "결제")]);
    renderPage();
    await screen.findAllByTestId("scenario-group");
    expect(screen.queryByTestId("scenario-ungrouped")).not.toBeInTheDocument();
  });

  it("localStorage.getItem이 throw해도 정상으로 그려지고 전부 펼쳐진다", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    serve(MIXED);
    renderPage();
    const boxes = await screen.findAllByTestId("scenario-group");
    for (const b of boxes) {
      expect(within(b).getByRole("button", { expanded: true })).toBeInTheDocument();
    }
    expect(screen.getAllByTestId("scenario-row")).toHaveLength(5);
  });

  it("묶음의 마지막 행에는 아래 구분선이 없고, 머리 행은 표 칸 수만큼 가로로 걸친다", async () => {
    serve(MIXED);
    renderPage();
    const boxes = await screen.findAllByTestId("scenario-group");
    const rows = within(boxes[0]).getAllByTestId("scenario-row");
    expect(rows[rows.length - 1]).not.toHaveClass("border-b");
    const boxRows = within(boxes[1]).getAllByTestId("scenario-row");
    expect(boxRows[0]).toHaveClass("border-b");
    const headerCell = within(boxes[0]).getByTestId("scenario-group-header").firstElementChild;
    expect(headerCell).toHaveAttribute("aria-colspan", "5");
    const heads = within(screen.getByTestId("scenario-columns")).getAllByRole("columnheader");
    expect(heads).toHaveLength(5);
    expect(heads[4]).not.toHaveAttribute("aria-hidden");
  });
});
