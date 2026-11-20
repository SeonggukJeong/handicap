import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ko } from "../../i18n/ko";
import { ScenarioListPage } from "../ScenarioListPage";

const fetchMock = vi.fn();
const KEY = "handicap:scenarios:collapsed-groups:v1";
const g = ko.scenarioGroups;

type Sc = ReturnType<typeof sc>;

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

let current: Sc[] = [];
let posts: { url: string; body: Record<string, unknown> }[] = [];
let postFails = false;
let hold: Promise<void> | null = null;

function installFetch() {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push({ url, body });
      if (postFails) return jsonResponse({ error: "서버가 거절했습니다" }, 400);
      if (url.endsWith("/scenario-groups/assign")) {
        const ids = new Set(body.scenario_ids as string[]);
        current = current.map((s) => (ids.has(s.id) ? { ...s, group: body.group as string } : s));
      } else if (url.endsWith("/scenario-groups/rename")) {
        current = current.map((s) =>
          s.group === body.from ? { ...s, group: body.to as string } : s,
        );
      }
      return jsonResponse({ updated: 1 });
    }
    if (hold) await hold;
    return jsonResponse({ scenarios: current });
  });
}

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ScenarioListPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { qc, ...view };
}

const row = (name: string) => screen.getByRole("checkbox", { name: g.selectRow(name) });
const selectAll = () => screen.getByRole("checkbox", { name: g.selectAll });
const slot = () => screen.getByTestId("scenario-action-slot");
const band = () => {
  const b = screen.queryByTestId("scenario-selection-band");
  return b?.dataset.selected === "true" ? b : null;
};
const groupBox = (name: string) =>
  screen.getAllByTestId("scenario-group").find((b) => b.dataset.groupName === name);
const stored = () => JSON.parse(window.localStorage.getItem(KEY) ?? "null") as string[] | null;
const search = () => screen.getByRole("searchbox", { name: g.searchPlaceholder });

function many(n: number): Sc[] {
  return Array.from({ length: n }, (_, i) => sc(`ID${i}`, `시나리오${i}`, null));
}

describe("ScenarioListPage 체크·일괄 지정·이름 바꾸기 (US3)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    fetchMock.mockReset();
    posts = [];
    postFails = false;
    hold = null;
    current = [];
    installFetch();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("체크가 없으면 띠가 없고, 1개 체크하면 개수·그룹 지정·선택 해제가 나온다", async () => {
    current = [sc("A", "하나", null), sc("B", "둘", null)];
    const user = userEvent.setup();
    renderPage();
    await screen.findAllByTestId("scenario-row");
    expect(band()).toBeNull();
    await user.click(row("하나"));
    const b = band()!;
    expect(within(b).getByText(g.selectedCount(1))).toBeInTheDocument();
    expect(b.textContent).toContain("1개");
    expect(within(b).getByRole("button", { name: g.assign })).toBeEnabled();
    await user.click(within(b).getByRole("button", { name: g.clearSelection }));
    expect(band()).toBeNull();
    expect(row("하나")).not.toBeChecked();
  });

  it("묶음 머리 체크: 일부만 체크면 indeterminate, 누르면 그 묶음 전부", async () => {
    current = [sc("A", "하나", "쇼핑"), sc("B", "둘", "쇼핑"), sc("C", "셋", null)];
    const user = userEvent.setup();
    renderPage();
    await screen.findAllByTestId("scenario-row");
    const head = screen.getByRole("checkbox", { name: g.selectGroup("쇼핑") });
    expect(head).not.toBeChecked();
    await user.click(row("하나"));
    expect(head).toHaveProperty("indeterminate", true);
    await user.click(head);
    expect(head).toBeChecked();
    expect(head).toHaveProperty("indeterminate", false);
    expect(row("하나")).toBeChecked();
    expect(row("둘")).toBeChecked();
    expect(row("셋")).not.toBeChecked();
    expect(within(band()!).getByText(g.selectedCount(2))).toBeInTheDocument();
  });

  it("전체 선택은 접힌 묶음 안의 것까지 지금 검색에 맞는 전부", async () => {
    window.localStorage.setItem(KEY, JSON.stringify(["쇼핑"]));
    current = [sc("A", "하나", "쇼핑"), sc("B", "둘", "쇼핑"), sc("C", "셋", null)];
    const user = userEvent.setup();
    renderPage();
    await screen.findAllByTestId("scenario-group");
    expect(screen.queryAllByTestId("scenario-row")).toHaveLength(1);
    await user.click(selectAll());
    const text = within(band()!).getByText(g.selectedCount(3)).textContent;
    expect(text).toContain("3");
  });

  it("검색으로 가려진 채 체크된 것은 전체 선택·해제에도 유지되고 개수에 들어간다", async () => {
    current = [
      sc("A", "알파", null),
      sc("B1", "베타1", null),
      sc("B2", "베타2", null),
      sc("B3", "베타3", null),
    ];
    const user = userEvent.setup();
    renderPage();
    await screen.findAllByTestId("scenario-row");
    await user.click(row("알파"));
    await user.type(search(), "베타");
    expect(screen.queryAllByTestId("scenario-row")).toHaveLength(3);
    expect(within(band()!).getByText(g.selectedCount(1))).toBeInTheDocument();
    await user.click(selectAll());
    expect(within(band()!).getByText(g.selectedCount(4)).textContent).toContain("4");
    await user.click(selectAll());
    expect(within(band()!).getByText(g.selectedCount(1)).textContent).toContain("1");
    await user.clear(search());
    expect(row("알파")).toBeChecked();
  });

  it("체크해 둔 시나리오가 다른 곳에서 지워진 뒤 다시 읽히면 선택에서 빠진다", async () => {
    current = [sc("A", "하나", null), sc("B", "둘", null), sc("C", "셋", null)];
    const user = userEvent.setup();
    const { qc } = renderPage();
    await screen.findAllByTestId("scenario-row");
    await user.click(row("하나"));
    await user.click(row("둘"));
    expect(within(band()!).getByText(g.selectedCount(2))).toBeInTheDocument();
    current = current.filter((s) => s.id !== "B");
    await act(async () => {
      await qc.invalidateQueries();
    });
    await waitFor(() => expect(screen.queryAllByTestId("scenario-row")).toHaveLength(2));
    expect(within(band()!).getByText(g.selectedCount(1)).textContent).toContain("1");
  });

  it("그룹 지정: 창 글 → 적용 → assign 본문 → 창 닫힘·체크 해제", async () => {
    current = [sc("A", "하나", null), sc("B", "둘", null), sc("C", "셋", null)];
    const user = userEvent.setup();
    renderPage();
    await screen.findAllByTestId("scenario-row");
    await user.click(row("하나"));
    await user.click(row("셋"));
    await user.click(within(band()!).getByRole("button", { name: g.assign }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(g.assignManyText(2))).toBeInTheDocument();
    expect(within(band()!).getByRole("button", { name: g.assign })).toBeDisabled();
    await user.type(within(dialog).getByLabelText(g.fieldLabel), "신규그룹");
    await user.click(within(dialog).getByRole("button", { name: g.apply }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toContain("/scenario-groups/assign");
    expect(new Set(posts[0].body.scenario_ids as string[])).toEqual(new Set(["A", "C"]));
    expect(posts[0].body.group).toBe("신규그룹");
    expect(band()).toBeNull();
    const box = await screen.findByTestId("scenario-group");
    expect(box.dataset.groupName).toBe("신규그룹");
    expect(within(box).getAllByTestId("scenario-row")).toHaveLength(2);
  });

  it("그룹 지정 실패: 창이 열린 채 사유가 보이고 체크는 유지된다", async () => {
    current = [sc("A", "하나", null)];
    postFails = true;
    const user = userEvent.setup();
    renderPage();
    await screen.findAllByTestId("scenario-row");
    await user.click(row("하나"));
    await user.click(within(band()!).getByRole("button", { name: g.assign }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(g.fieldLabel), "x");
    await user.click(within(dialog).getByRole("button", { name: g.apply }));
    expect(await within(dialog).findByText(g.failed("서버가 거절했습니다"))).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(row("하나")).toBeChecked();
  });

  it("501개 체크면 그룹 지정이 막히고 tooMany가 보이며, 500개면 눌린다", async () => {
    current = many(501);
    const user = userEvent.setup();
    const first = renderPage();
    await screen.findAllByTestId("scenario-row");
    await user.click(selectAll());
    let b = band()!;
    expect(within(b).getByText(g.selectedCount(501)).textContent).toContain("501");
    expect(within(b).getByRole("button", { name: g.assign })).toBeDisabled();
    expect(within(b).getByText(g.tooMany)).toBeInTheDocument();
    expect(b).toHaveClass("flex-wrap");
    first.unmount();

    current = many(500);
    renderPage();
    await screen.findAllByTestId("scenario-row");
    await user.click(selectAll());
    b = band()!;
    expect(within(b).getByText(g.selectedCount(500)).textContent).toContain("500");
    expect(within(b).getByRole("button", { name: g.assign })).toBeEnabled();
    expect(within(b).queryByText(g.tooMany)).toBeNull();
  });
});

describe("ScenarioListPage 이름 바꾸기·안내 줄 (US3)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    fetchMock.mockReset();
    posts = [];
    postFails = false;
    hold = null;
    current = [];
    installFetch();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("이름 바꾸기: 기존 이름을 치면 합치기 안내, 새 이름으로 바꾸면 접힘 기억이 옛→새 이름(목록 도착 전·후)이고 도착 전엔 옛 이름 상자도 접힌 채", async () => {
    window.localStorage.setItem(KEY, JSON.stringify(["쇼핑"]));
    current = [sc("A", "하나", "쇼핑"), sc("B", "둘", "쇼핑"), sc("C", "셋", "결제")];
    const user = userEvent.setup();
    renderPage();
    await screen.findAllByTestId("scenario-group");
    const box = screen
      .getAllByTestId("scenario-group")
      .find((b) => b.dataset.groupName === "쇼핑")!;
    await user.click(within(box).getByRole("button", { name: g.renameGroupLabel("쇼핑") }));
    const dialog = await screen.findByRole("dialog");
    const field = within(dialog).getByLabelText(g.fieldLabel);
    await user.type(field, "결제");
    expect(within(dialog).getByText(g.mergeHint(2, 1))).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: g.mergeOk })).toBeInTheDocument();
    await user.clear(field);
    await user.type(field, "새이름");

    let release: () => void = () => {};
    hold = new Promise<void>((r) => {
      release = r;
    });
    await user.click(within(dialog).getByRole("button", { name: g.renameOk }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toContain("/scenario-groups/rename");
    expect(posts[0].body).toEqual({ from: "쇼핑", to: "새이름" });
    expect(JSON.parse(window.localStorage.getItem(KEY) ?? "null")).toEqual(["새이름"]);
    const oldBox = groupBox("쇼핑")!;
    expect(within(oldBox).getByRole("button", { expanded: false })).toBeInTheDocument();
    expect(within(oldBox).queryAllByTestId("scenario-row")).toHaveLength(0);

    hold = null;
    release();
    await waitFor(() =>
      expect(
        screen.getAllByTestId("scenario-group").some((b) => b.dataset.groupName === "새이름"),
      ).toBe(true),
    );
    const renamed = screen
      .getAllByTestId("scenario-group")
      .find((b) => b.dataset.groupName === "새이름")!;
    expect(within(renamed).getByRole("button", { expanded: false })).toBeInTheDocument();
    expect(within(renamed).queryAllByTestId("scenario-row")).toHaveLength(0);
    expect(JSON.parse(window.localStorage.getItem(KEY) ?? "null")).toEqual(["새이름"]);
  });

  it("안내·띠 자리: 세 상태(안내/띠/비어 있음)에서 같은 높이 클래스의 한 칸이고 상태 영역은 계속 마운트돼 있다", async () => {
    current = [sc("A", "하나", null), sc("B", "둘", null)];
    const user = userEvent.setup();
    const first = renderPage();
    await screen.findAllByTestId("scenario-row");
    const s0 = slot();
    const heightClass = Array.from(s0.classList).find((c) => c.startsWith("min-h-"));
    expect(heightClass).toBeTruthy();
    const status = within(s0).getByRole("status");
    expect(status.textContent).toBe("");
    expect(within(s0).getByText(g.createHint)).toBeInTheDocument();

    await user.click(row("하나"));
    expect(slot()).toBe(s0);
    expect(s0).toHaveClass(heightClass!);
    expect(within(s0).getByRole("status")).toBe(status);
    expect(status.textContent).toContain("1");
    expect(within(s0).getByText(g.selectedCount(1))).toBe(status);
    expect(within(s0).getByTestId("scenario-selection-band")).toBe(band());
    expect(within(s0).queryByText(g.createHint)).toBeNull();

    await user.click(row("하나"));
    expect(within(s0).getByRole("status")).toBe(status);
    expect(status.textContent).toBe("");
    first.unmount();

    current = [sc("A", "하나", "쇼핑"), sc("B", "둘", null)];
    renderPage();
    await screen.findAllByTestId("scenario-row");
    expect(slot()).toHaveClass(heightClass!);
    expect(within(slot()).queryByText(g.createHint)).toBeNull();
    expect(band()).toBeNull();
    expect(within(slot()).getByRole("status").textContent).toBe("");
  });

  it("그룹 지정에 성공하면 포커스가 검색 칸으로 간다", async () => {
    current = [sc("A", "하나", null)];
    const user = userEvent.setup();
    renderPage();
    await screen.findAllByTestId("scenario-row");
    await user.click(row("하나"));
    await user.click(within(band()!).getByRole("button", { name: g.assign }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(g.fieldLabel), "신규");
    await user.click(within(dialog).getByRole("button", { name: g.apply }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(search()));
  });

  it("그룹 지정이 실패한 뒤 창을 닫았다 다시 열면 지난 오류가 보이지 않는다", async () => {
    current = [sc("A", "하나", null)];
    postFails = true;
    const user = userEvent.setup();
    renderPage();
    await screen.findAllByTestId("scenario-row");
    await user.click(row("하나"));
    await user.click(within(band()!).getByRole("button", { name: g.assign }));
    let dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(g.fieldLabel), "x");
    await user.click(within(dialog).getByRole("button", { name: g.apply }));
    expect(await within(dialog).findByText(g.failed("서버가 거절했습니다"))).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: ko.common.cancel }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(within(band()!).getByRole("button", { name: g.assign }));
    dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByText(g.failed("서버가 거절했습니다"))).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("검색 중 묶음 머리 체크는 그 묶음의 맞는 행에만 걸리고 개수도 맞는 수다", async () => {
    current = [
      sc("A", "사과", "쇼핑"),
      sc("B", "사과파이", "쇼핑"),
      sc("C", "배", "쇼핑"),
      sc("D", "바나나", null),
    ];
    const user = userEvent.setup();
    renderPage();
    await screen.findAllByTestId("scenario-group");
    await user.type(search(), "사과");
    const box = groupBox("쇼핑")!;
    expect(within(box).getAllByTestId("scenario-row")).toHaveLength(2);
    const toggle = within(box).getByRole("button", { expanded: true });
    expect(toggle.textContent).toContain("2");
    expect(toggle.textContent).not.toContain("3");
    expect(toggle).toHaveAccessibleName(expect.stringMatching(/\(2\)/));
    await user.click(within(box).getByRole("checkbox", { name: g.selectGroup("쇼핑") }));
    expect(within(band()!).getByText(g.selectedCount(2)).textContent).toContain("2");
    await user.clear(search());
    expect(row("사과")).toBeChecked();
    expect(row("사과파이")).toBeChecked();
    expect(row("배")).not.toBeChecked();
  });

  it("합치기: 기존 그룹 이름으로 제출하면 {from,to}가 가고, 접힘 기억에 중복이 없고, 목록 뒤 상자가 하나만 접힌 채 남는다", async () => {
    window.localStorage.setItem(KEY, JSON.stringify(["쇼핑", "결제"]));
    current = [sc("A", "하나", "쇼핑"), sc("B", "둘", "쇼핑"), sc("C", "셋", "결제")];
    const user = userEvent.setup();
    renderPage();
    await screen.findAllByTestId("scenario-group");
    await user.click(
      within(groupBox("쇼핑")!).getByRole("button", { name: g.renameGroupLabel("쇼핑") }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(g.fieldLabel), "결제");
    expect(within(dialog).getByText(g.mergeHint(2, 1))).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: g.mergeOk }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toEqual({ from: "쇼핑", to: "결제" });
    expect(stored()).toEqual(["결제"]);
    await waitFor(() => expect(screen.getAllByTestId("scenario-group")).toHaveLength(1));
    const only = groupBox("결제")!;
    expect(within(only).getByRole("button", { expanded: false })).toBeInTheDocument();
    expect(within(only).queryAllByTestId("scenario-row")).toHaveLength(0);
    expect(stored()).toEqual(["결제"]);
  });

  it("이름 바꾸기 직후 목록이 오기 전에 다른 묶음을 접어도 새 이름의 접힘이 저장에서 빠지지 않는다", async () => {
    window.localStorage.setItem(KEY, JSON.stringify(["쇼핑"]));
    current = [sc("A", "하나", "쇼핑"), sc("C", "셋", "결제")];
    const user = userEvent.setup();
    renderPage();
    await screen.findAllByTestId("scenario-group");
    await user.click(
      within(groupBox("쇼핑")!).getByRole("button", { name: g.renameGroupLabel("쇼핑") }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(g.fieldLabel), "새이름");
    let release: () => void = () => {};
    hold = new Promise<void>((r) => {
      release = r;
    });
    await user.click(within(dialog).getByRole("button", { name: g.renameOk }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(within(groupBox("결제")!).getByRole("button", { expanded: true }));
    expect(stored()).toEqual(["새이름", "결제"]);
    hold = null;
    release();
    await waitFor(() => expect(groupBox("새이름")).toBeDefined());
    expect(stored()).toEqual(["새이름", "결제"]);
    expect(
      within(groupBox("새이름")!).getByRole("button", { expanded: false }),
    ).toBeInTheDocument();
  });

  it("이름 바꾸기 성공 뒤 목록이 오면 포커스가 바뀐 그룹의 접기 버튼에 있다", async () => {
    current = [sc("A", "하나", "쇼핑")];
    const user = userEvent.setup();
    renderPage();
    await screen.findAllByTestId("scenario-group");
    await user.click(
      within(groupBox("쇼핑")!).getByRole("button", { name: g.renameGroupLabel("쇼핑") }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(g.fieldLabel), "새이름");
    await user.click(within(dialog).getByRole("button", { name: g.renameOk }));
    await waitFor(() => expect(groupBox("새이름")).toBeDefined());
    const toggle = within(groupBox("새이름")!).getByRole("button", { expanded: true });
    await waitFor(() => expect(document.activeElement).toBe(toggle));
  });

  it("그룹마다 이름 바꾸기 버튼의 접근 이름이 그룹 이름을 담는다", async () => {
    current = [sc("A", "하나", "쇼핑"), sc("B", "둘", "결제")];
    renderPage();
    await screen.findAllByTestId("scenario-group");
    const btn = within(groupBox("쇼핑")!).getByRole("button", {
      name: g.renameGroupLabel("쇼핑"),
    });
    expect(btn.textContent).toBe(g.rename);
    expect(btn).toHaveAccessibleName(expect.stringContaining("쇼핑"));
    expect(screen.getAllByRole("button", { name: /이름 바꾸기/ })).toHaveLength(2);
    expect(screen.queryByRole("button", { name: g.rename })).toBeNull();
  });

  it("안내 줄: 그룹 0개+체크 0개에서만 보인다", async () => {
    current = [sc("A", "하나", null)];
    const user = userEvent.setup();
    renderPage();
    await screen.findAllByTestId("scenario-row");
    expect(screen.getByText(g.createHint)).toBeInTheDocument();
    await user.click(row("하나"));
    expect(screen.queryByText(g.createHint)).toBeNull();
    await user.click(row("하나"));
    expect(screen.getByText(g.createHint)).toBeInTheDocument();
  });

  it("그룹이 하나라도 있으면 안내 줄이 없다", async () => {
    current = [sc("A", "하나", "쇼핑"), sc("B", "둘", null)];
    renderPage();
    await screen.findAllByTestId("scenario-row");
    expect(screen.queryByText(g.createHint)).toBeNull();
  });
});
