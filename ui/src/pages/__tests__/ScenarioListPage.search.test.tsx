import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
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
  sc("S4", "환불", "쇼핑"),
  sc("S5", "조회", null),
];

const rowNames = () =>
  screen.queryAllByTestId("scenario-row").map((r) => within(r).getAllByRole("link")[0].textContent);

describe("ScenarioListPage 검색 (US4)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("그룹이 0개여도 검색 칸과 행 체크 칸이 보인다", async () => {
    serve([sc("A", "하나", null), sc("B", "둘", null)]);
    renderPage();
    await screen.findAllByTestId("scenario-row");
    expect(
      screen.getByRole("searchbox", { name: ko.scenarioGroups.searchPlaceholder }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: ko.scenarioGroups.selectRow("하나") }),
    ).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: ko.scenarioGroups.selectAll })).toBeInTheDocument();
  });

  it("이름 일부로 맞는 행만 남는다", async () => {
    serve(MIXED);
    const user = userEvent.setup();
    renderPage();
    await screen.findAllByTestId("scenario-row");
    await user.type(
      screen.getByRole("searchbox", { name: ko.scenarioGroups.searchPlaceholder }),
      "조",
    );
    expect(rowNames()).toEqual(["조회"]);
  });

  it("그룹 이름이 맞으면 그 묶음 전부가 보인다", async () => {
    serve(MIXED);
    const user = userEvent.setup();
    renderPage();
    await screen.findAllByTestId("scenario-row");
    await user.type(
      screen.getByRole("searchbox", { name: ko.scenarioGroups.searchPlaceholder }),
      "쇼핑",
    );
    expect(rowNames()).toEqual(["주문", "환불"]);
    expect(screen.getAllByTestId("scenario-group")).toHaveLength(1);
  });

  it("접어 둔 묶음도 검색 중엔 펼쳐 보이고, 지우면 다시 접히며 저장값은 그대로", async () => {
    window.localStorage.setItem(KEY, JSON.stringify(["쇼핑"]));
    serve(MIXED);
    const user = userEvent.setup();
    renderPage();
    await screen.findAllByTestId("scenario-group");
    const box = () =>
      screen.getAllByTestId("scenario-group").find((b) => b.dataset.groupName === "쇼핑")!;
    expect(within(box()).queryAllByTestId("scenario-row")).toHaveLength(0);

    const search = screen.getByRole("searchbox", { name: ko.scenarioGroups.searchPlaceholder });
    await user.type(search, "환불");
    expect(within(box()).getAllByTestId("scenario-row")).toHaveLength(1);
    const toggle = within(box()).getByRole("button", { expanded: true });
    await user.click(toggle);
    expect(within(box()).getByRole("button", { expanded: true })).toBeInTheDocument();
    expect(window.localStorage.getItem(KEY)).toBe(JSON.stringify(["쇼핑"]));

    await user.clear(search);
    expect(within(box()).queryAllByTestId("scenario-row")).toHaveLength(0);
    expect(within(box()).getByRole("button", { expanded: false })).toBeInTheDocument();
    expect(window.localStorage.getItem(KEY)).toBe(JSON.stringify(["쇼핑"]));
  });

  it("그룹이 0개일 때도 검색은 평평한 행을 거르고, 맞는 것이 없으면 searchEmpty", async () => {
    serve([sc("A", "하나", null), sc("B", "둘", null), sc("C", "하늘", null)]);
    const user = userEvent.setup();
    renderPage();
    await screen.findAllByTestId("scenario-row");
    const box = screen.getByRole("searchbox", { name: ko.scenarioGroups.searchPlaceholder });
    await user.type(box, "하");
    expect(rowNames()).toEqual(["하나", "하늘"]);
    expect(screen.queryAllByTestId("scenario-group")).toHaveLength(0);
    await user.type(box, "없음");
    expect(screen.getByText(ko.scenarioGroups.searchEmpty)).toBeInTheDocument();
    expect(rowNames()).toEqual([]);
  });

  it("검색 중 접기 버튼은 aria-disabled이고 펼침 그대로이며 눌러도 상태가 안 바뀐다, 지우면 되돌아온다", async () => {
    serve(MIXED);
    const user = userEvent.setup();
    renderPage();
    await screen.findAllByTestId("scenario-group");
    const box = () =>
      screen.getAllByTestId("scenario-group").find((b) => b.dataset.groupName === "쇼핑")!;
    const before = within(box()).getByRole("button", { expanded: true });
    expect(before).not.toHaveAttribute("aria-disabled", "true");
    expect(before).toHaveClass("hover:underline");
    await user.type(
      screen.getByRole("searchbox", { name: ko.scenarioGroups.searchPlaceholder }),
      "쇼핑",
    );
    const inert = within(box()).getByRole("button", { expanded: true });
    expect(inert).toHaveAttribute("aria-disabled", "true");
    expect(inert).not.toHaveClass("hover:underline");
    expect(inert).toHaveClass("cursor-default");
    await user.click(inert);
    expect(within(box()).getAllByTestId("scenario-row")).toHaveLength(2);
    await user.clear(screen.getByRole("searchbox", { name: ko.scenarioGroups.searchPlaceholder }));
    const back = within(box()).getByRole("button", { expanded: true });
    expect(back).not.toHaveAttribute("aria-disabled", "true");
    expect(back).toHaveClass("hover:underline");
  });

  it("맞는 것이 없는 묶음은 상자째 사라진다", async () => {
    serve(MIXED);
    const user = userEvent.setup();
    renderPage();
    await screen.findAllByTestId("scenario-group");
    await user.type(
      screen.getByRole("searchbox", { name: ko.scenarioGroups.searchPlaceholder }),
      "조회",
    );
    expect(screen.queryAllByTestId("scenario-group")).toHaveLength(0);
    expect(
      within(screen.getByTestId("scenario-ungrouped")).getAllByTestId("scenario-row"),
    ).toHaveLength(1);
  });

  it("결과가 0이면 searchEmpty 한 줄", async () => {
    serve(MIXED);
    const user = userEvent.setup();
    renderPage();
    await screen.findAllByTestId("scenario-row");
    await user.type(
      screen.getByRole("searchbox", { name: ko.scenarioGroups.searchPlaceholder }),
      "없는이름",
    );
    expect(screen.getByText(ko.scenarioGroups.searchEmpty)).toBeInTheDocument();
    expect(screen.queryAllByTestId("scenario-row")).toHaveLength(0);
  });
});
