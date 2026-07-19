import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VariablesPanel } from "../VariablesPanel";
import { useScenarioEditor } from "../../../scenario/store";
import { ko } from "../../../i18n/ko";

const reset = () =>
  useScenarioEditor.setState(
    (
      useScenarioEditor as unknown as {
        getInitialState: () => ReturnType<typeof useScenarioEditor.getState>;
      }
    ).getInitialState(),
  );

describe("VariablesPanel", () => {
  beforeEach(() => {
    reset();
    useScenarioEditor.getState().resetEmpty();
  });

  it("model이 null이어도 getSnapshot 캐싱 경고 없이 빈 상태를 렌더한다", () => {
    reset(); // beforeEach의 resetEmpty()를 되돌려 model: null 유지(EditorShell pre-load 윈도 재현)
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      render(<VariablesPanel />);
      expect(screen.getByText("변수 없음")).toBeInTheDocument();
      const snapshotWarnings = errorSpy.mock.calls.filter((args) =>
        args.some((a) => typeof a === "string" && a.includes("getSnapshot should be cached")),
      );
      expect(snapshotWarnings).toEqual([]);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("lists variables and adds one via the two-field row", async () => {
    const user = userEvent.setup();
    render(<VariablesPanel />);
    expect(screen.getByText("변수 없음")).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText("new_var"), "base");
    await user.click(screen.getByRole("button", { name: "추가" }));
    expect(useScenarioEditor.getState().model!.variables).toHaveProperty("base");
  });

  it("removes a variable", async () => {
    const user = userEvent.setup();
    useScenarioEditor.getState().setVariable("tok", "x");
    render(<VariablesPanel />);
    await user.click(screen.getByRole("button", { name: "tok 변수 제거" }));
    expect(useScenarioEditor.getState().model!.variables).not.toHaveProperty("tok");
  });

  it("U3: 변수 표기 치트시트 popover — 3분류(흐름/환경/시스템)를 연다/ESC로 닫는다", async () => {
    const user = userEvent.setup();
    render(<VariablesPanel />);
    const tip = screen.getByRole("button", { name: "변수 표기 도움말" });
    await user.click(tip);
    const note = screen.getByRole("note");
    expect(note).toHaveTextContent("흐름 변수");
    expect(note).toHaveTextContent("${ENV}");
    expect(note).toHaveTextContent("${vu_id}");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });

  it("R1/R2: 값을 전폭 textarea로 렌더하고 편집을 store에 커밋한다", async () => {
    const user = userEvent.setup();
    useScenarioEditor.getState().setVariable("tok", "abc");
    render(<VariablesPanel />);
    const ta = screen.getByRole("textbox", { name: "tok 값" });
    expect(ta.tagName).toBe("TEXTAREA");
    expect(ta).toHaveClass("w-full");
    await user.type(ta, "d");
    expect(useScenarioEditor.getState().model!.variables.tok).toBe("abcd");
  });

  it("R1: 변수명은 truncate + title 로 전폭 표시한다", () => {
    useScenarioEditor.getState().setVariable("a_very_long_variable_name", "v");
    render(<VariablesPanel />);
    const name = screen.getByText("a_very_long_variable_name");
    expect(name).toHaveClass("truncate");
    expect(name).toHaveAttribute("title", "a_very_long_variable_name");
  });

  it("filters rows by case-insensitive substring over name, value, and branch display", async () => {
    const user = userEvent.setup();
    useScenarioEditor.getState().setVariable("auth", "Bearer X");
    useScenarioEditor.getState().setVariable("token", "abc");
    render(<VariablesPanel />);
    const search = screen.getByPlaceholderText(ko.editor.varSearchPlaceholder);
    await user.type(search, "AUT"); // 대소문자 무시 → auth 매치, token 미매치
    expect(screen.getByText("auth")).toBeInTheDocument();
    expect(screen.queryByText("token")).not.toBeInTheDocument();
    await user.clear(search);
    await user.type(search, "bearer"); // 값 매치
    expect(screen.getByText("auth")).toBeInTheDocument();
    await user.clear(search);
    await user.type(search, "zzz"); // 무매치
    expect(screen.getByText(ko.editor.varSearchEmpty)).toBeInTheDocument();
  });

  it("R7: filters a parallel-extract row by branch name alone, var name alone, and full branch.var display", async () => {
    const user = userEvent.setup();
    // non-shadow parallel-extract row: branch "B" extracts "fresh" → display "B.fresh"
    useScenarioEditor.getState().loadFromString(`version: 1
name: "t"
variables: {}
steps:
  - id: "01HX0000000000000000000010"
    type: parallel
    name: B
    branches:
      - name: B
        steps:
          - id: "01HX0000000000000000000020"
            type: http
            name: a
            request: { method: GET, url: "/a?x={{fresh}}" }
            extract: [ { var: fresh, from: status } ]
  - id: "01HX0000000000000000000030"
    type: http
    name: d
    request: { method: GET, url: "/d?y={{B.fresh}}" }
`);
    render(<VariablesPanel />);
    const search = screen.getByPlaceholderText(ko.editor.varSearchPlaceholder);
    const rowByRenamePencil = () =>
      screen.queryByRole("button", { name: ko.editor.renameVariableAria("B.fresh") });

    // (a) branch name alone
    await user.type(search, "b"); // 대소문자 무시
    expect(rowByRenamePencil()).toBeInTheDocument();
    await user.clear(search);

    // (b) var name alone
    await user.type(search, "FRE"); // 대소문자 무시
    expect(rowByRenamePencil()).toBeInTheDocument();
    await user.clear(search);

    // (c) full "branch.var" display, case-insensitively
    await user.type(search, "B.FRESH");
    expect(rowByRenamePencil()).toBeInTheDocument();
    await user.clear(search);

    // non-matching query hides the row
    await user.type(search, "zzz");
    expect(rowByRenamePencil()).not.toBeInTheDocument();
    expect(screen.getByText(ko.editor.varSearchEmpty)).toBeInTheDocument();
  });

  it("clears the search query when a variable is added", async () => {
    const user = userEvent.setup();
    render(<VariablesPanel />);
    await user.type(screen.getByPlaceholderText(ko.editor.varSearchPlaceholder), "zzz");
    await user.type(screen.getByPlaceholderText("new_var"), "brandnew");
    await user.click(screen.getByRole("button", { name: ko.editor.variablesAdd }));
    expect(
      (screen.getByPlaceholderText(ko.editor.varSearchPlaceholder) as HTMLInputElement).value,
    ).toBe("");
    expect(screen.getByText("brandnew")).toBeInTheDocument();
  });

  it("scrolls the variable list while pinning header/add-var (R13)", () => {
    render(<VariablesPanel />);
    const list = screen.getByRole("list");
    expect(list.className).toContain("overflow-auto");
    expect(list.className).toContain("min-h-0");
    expect(list.className).toContain("pr-1.5");
  });

  it("검색어가 팝오버 앵커 행을 필터링하면 열린 사용처 팝오버를 닫는다 (whole-branch 리뷰 fold-in)", async () => {
    const user = userEvent.setup();
    const scenario = `version: 1
name: t
cookie_jar: auto
variables:
  token: seed
steps:
  - id: 01HX0000000000000000000001
    name: a
    type: http
    request: { method: GET, url: "/x?a={{token}}", headers: {} }
`;
    useScenarioEditor.getState().loadFromString(scenario);
    render(<VariablesPanel />);

    await user.click(screen.getByRole("button", { name: ko.editor.variableUsageNavAria("token") }));
    expect(
      await screen.findByRole("menu", { name: ko.editor.varUsageListAria }),
    ).toBeInTheDocument(); // 검색 전: 팝오버 열림

    // fireEvent.change(포인터 이벤트 없음)로 검증 — user.type/click은 검색창에
    // pointerdown을 발화해 VarUsagePopover의 기존 "바깥 pointerdown→닫힘" 핸들러가
    // 우연히 팝오버를 닫혀버려, 이 state-hygiene 버그(앵커 unmount 자체가 원인)를
    // 가려버린다. fireEvent.change만 써서 그 우회 경로를 배제하고 진짜 버그만 노출.
    const search = screen.getByPlaceholderText(ko.editor.varSearchPlaceholder);
    fireEvent.change(search, { target: { value: "zzz" } }); // "token" 행을 필터링해 제거 → 앵커가 unmount

    expect(screen.queryByRole("menu")).not.toBeInTheDocument(); // 검색 후: 팝오버 닫힘
  });

  it("R4: 사용되는 변수는 'N개 스텝에서 사용', 안 쓰이는 변수는 '미사용' 힌트를 보인다", () => {
    // {{used}}를 한 http 스텝의 url에서 참조하는 시나리오 + 미참조 변수 {{lonely}}
    useScenarioEditor.getState().loadFromString(`version: 1
name: x
cookie_jar: auto
variables:
  used: "u"
  lonely: "l"
steps:
  - id: "01HX0000000000000000000001"
    name: s
    type: http
    request:
      method: GET
      url: "/x?q={{used}}"
    assert:
      - status: 200
`);
    render(<VariablesPanel />);
    expect(screen.getByText("1개 스텝에서 사용")).toBeInTheDocument();
    expect(screen.getByText("미사용")).toBeInTheDocument();
  });
});

describe("VariablesPanel — newKey input adopts primitive Input (design-system-editor)", () => {
  beforeEach(() => {
    reset();
    useScenarioEditor.getState().resetEmpty();
  });

  it("newKey input uses primitive Input with accent focus-ring class", () => {
    render(<VariablesPanel />);
    const newKey = screen.getByPlaceholderText("new_var");
    expect(newKey).toHaveClass("focus:ring-accent-500/30"); // Input BASE — RED before migration
    expect(newKey).toHaveClass("font-mono"); // mono preserved
  });
});

const MIXED = `version: 1
name: t
cookie_jar: auto
variables:
  token: seed
steps:
  - id: 01HX0000000000000000000001
    name: consume
    type: http
    request:
      method: GET
      url: "/x?a={{token}}&b={{alpha.s}}&c={{missing}}"
      headers: {}
    extract:
      - from: body
        path: $.u
        var: flatVar
  - id: 01HX0000000000000000000050
    name: par
    type: parallel
    branches:
      - name: alpha
        steps:
          - id: 01HX0000000000000000000051
            name: leaf
            type: http
            request: { method: GET, url: "/y", headers: {} }
            extract:
              - from: body
                path: $.t
                var: s
`;

describe("VariablesPanel — unified rows", () => {
  beforeEach(() => useScenarioEditor.setState(useScenarioEditor.getInitialState()));

  it("renders declared / flat-extract / parallel-extract / undefined rows with gated affordances", () => {
    useScenarioEditor.getState().loadFromString(MIXED);
    render(<VariablesPanel />);
    // 선언 token: 연필 있음(flat non-shadow)
    expect(
      screen.getByRole("button", { name: ko.editor.renameVariableAria("token") }),
    ).toBeInTheDocument();
    // flat-extract flatVar: 연필 있음, 값/× 없음
    expect(
      screen.getByRole("button", { name: ko.editor.renameVariableAria("flatVar") }),
    ).toBeInTheDocument();
    // R5: flat-extract 행은 값 textarea/× 제거 버튼이 없다(둘 다 declared 전용)
    expect(
      screen.queryByRole("textbox", { name: ko.editor.variableValueAria("flatVar") }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: ko.editor.removeVariableAria("flatVar") }),
    ).toBeNull();
    // parallel-extract alpha.s (non-shadow) — split display + rename pencil + info-title badge
    expect(screen.getByText("alpha.")).toBeInTheDocument(); // 고정 prefix span
    expect(
      screen.getByRole("button", { name: ko.editor.renameVariableAria("alpha.s") }),
    ).toBeInTheDocument();
    expect(screen.getByTitle(ko.editor.variableBranchInfoTitle)).toBeInTheDocument();
    // 미정의 missing: "정의안됨" + 연필 없음
    expect(screen.getByText(ko.editor.variableUndefined)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: ko.editor.renameVariableAria("missing") }),
    ).toBeNull();
  });

  it("nav count opens a usage popover listing refIds in document order and jumps without cycling/closing", async () => {
    const user = userEvent.setup();
    const scenario = `version: 1
name: t
cookie_jar: auto
variables:
  token: seed
steps:
  - id: 01HX0000000000000000000001
    name: a
    type: http
    request: { method: GET, url: "/x?a={{token}}", headers: {} }
  - id: 01HX0000000000000000000002
    name: b
    type: http
    request: { method: GET, url: "/y?b={{token}}", headers: {} }
`;
    useScenarioEditor.getState().loadFromString(scenario);
    const onJump = vi.fn();
    render(<VariablesPanel onJumpToStep={onJump} />);
    await user.click(screen.getByRole("button", { name: ko.editor.variableUsageNavAria("token") }));
    const menu = await screen.findByRole("menu", { name: ko.editor.varUsageListAria });
    const items = within(menu).getAllByRole("menuitem");
    expect(items).toHaveLength(2);
    await user.click(items[0]);
    expect(onJump).toHaveBeenNthCalledWith(1, "01HX0000000000000000000001");
    expect(screen.getByRole("menu")).toBeInTheDocument(); // 클릭해도 안 닫힘
    await user.click(items[1]);
    expect(onJump).toHaveBeenNthCalledWith(2, "01HX0000000000000000000002");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument(); // ESC는 닫음
  });

  it("toggle-close: pointerdown on the trigger keeps the menu open (anchor-exclusion); a second click closes it", async () => {
    const user = userEvent.setup();
    const scenario = `version: 1
name: t
cookie_jar: auto
variables:
  token: seed
steps:
  - id: 01HX0000000000000000000001
    name: a
    type: http
    request: { method: GET, url: "/x?a={{token}}", headers: {} }
  - id: 01HX0000000000000000000002
    name: b
    type: http
    request: { method: GET, url: "/y?b={{token}}", headers: {} }
`;
    useScenarioEditor.getState().loadFromString(scenario);
    render(<VariablesPanel />);
    const trigger = screen.getByRole("button", {
      name: ko.editor.variableUsageNavAria("token"),
    });

    await user.click(trigger);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    // 트리거 자신에 대한 바깥-pointerdown은 anchor-exclusion 가드로 무시돼야 열린 채 유지
    fireEvent.pointerDown(trigger);
    expect(screen.getByRole("menu")).toBeInTheDocument();

    // 트리거 재클릭(React onClick 토글)이 실제 닫음
    await user.click(trigger);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("switching to a different variable's usage trigger shows exactly one menu, updated to the new variable's steps", async () => {
    const scenario = `version: 1
name: t
cookie_jar: auto
variables:
  a: "1"
  b: "2"
steps:
  - id: 01HX0000000000000000000001
    name: step-a
    type: http
    request: { method: GET, url: "/x?q={{a}}", headers: {} }
  - id: 01HX0000000000000000000002
    name: step-b
    type: http
    request: { method: GET, url: "/y?q={{b}}", headers: {} }
`;
    useScenarioEditor.getState().loadFromString(scenario);
    const user = userEvent.setup();
    render(<VariablesPanel />);

    // 실제 포인터 시퀀스(pointerdown→pointerup→click) — production onClick이 e.currentTarget을
    // 핸들러 본문에서 로컬로 캡처해두므로(state-updater 안에서 읽지 않음) deferred-currentTarget
    // 경합 없이 안전하게 트리거 전환을 검증한다.
    await user.click(screen.getByRole("button", { name: ko.editor.variableUsageNavAria("a") }));
    const firstMenu = await screen.findByRole("menu", { name: ko.editor.varUsageListAria });
    expect(within(firstMenu).getByText("step-a")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: ko.editor.variableUsageNavAria("b") }));
    const menus = screen.getAllByRole("menu");
    expect(menus).toHaveLength(1);
    expect(within(menus[0]).getByText("step-b")).toBeInTheDocument();
    expect(within(menus[0]).queryByText("step-a")).not.toBeInTheDocument();
  });

  it("inline rename commits on Enter and shows an inline error on collision", () => {
    useScenarioEditor.getState().loadFromString(MIXED);
    render(<VariablesPanel />);
    // rename token → collide with 'flatVar' (existing producer)
    fireEvent.click(screen.getByRole("button", { name: ko.editor.renameVariableAria("token") }));
    const input = screen.getByRole("textbox", { name: ko.editor.variableRenameInputAria("token") });
    fireEvent.change(input, { target: { value: "flatVar" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText(ko.editor.variableRenameCollision("flatVar"))).toBeInTheDocument();
    expect(useScenarioEditor.getState().yamlText).toContain("token: seed"); // 미커밋

    // typing a corrected name clears the stale collision error (before any re-commit)
    fireEvent.change(input, { target: { value: "somethingElse" } });
    expect(
      screen.queryByText(ko.editor.variableRenameCollision("flatVar")),
    ).not.toBeInTheDocument();

    // valid rename commits
    fireEvent.change(input, { target: { value: "auth" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(useScenarioEditor.getState().yamlText).toContain("auth: seed");
    expect(useScenarioEditor.getState().yamlText).toContain("{{auth}}");
  });

  it("R10: 0-ref 변수는 '미사용' 텍스트만 렌더하고 nav 버튼을 만들지 않는다", () => {
    const scenario = `version: 1
name: t
cookie_jar: auto
variables:
  lonely: "l"
steps:
  - id: 01HX0000000000000000000001
    name: s
    type: http
    request:
      method: GET
      url: "/x"
      headers: {}
`;
    useScenarioEditor.getState().loadFromString(scenario);
    render(<VariablesPanel />);
    expect(screen.getByText(ko.editor.variableUnused)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: ko.editor.variableUsageNavAria("lonely") }),
    ).toBeNull();
  });

  it("R9: 선언 + parallel 분기가 동일 이름을 추출(shadow)하면 declared 행은 rename 연필이 없다", () => {
    const scenario = `version: 1
name: t
cookie_jar: auto
variables:
  s: seed
steps:
  - id: 01HX0000000000000000000001
    name: par
    type: parallel
    branches:
      - name: alpha
        steps:
          - id: 01HX0000000000000000000002
            name: leaf
            type: http
            request: { method: GET, url: "/y", headers: {} }
            extract:
              - from: body
                path: $.t
                var: s
`;
    useScenarioEditor.getState().loadFromString(scenario);
    render(<VariablesPanel />);
    expect(screen.queryByRole("button", { name: ko.editor.renameVariableAria("s") })).toBeNull();
  });

  it("disables the rename pencil while yamlError is set", () => {
    useScenarioEditor.getState().loadFromString(MIXED);
    useScenarioEditor.getState().setPendingYamlText("version: 1\nname: t\nsteps: [\n");
    useScenarioEditor.getState().commitPendingYaml(); // yamlError 세팅 — model은 보존됨(store.commitPendingYaml)
    render(<VariablesPanel />);
    // model 보존이라 행은 렌더되지만 rename 연필은 disabled (R9 편집 게이트)
    expect(
      screen.getByRole("button", { name: ko.editor.renameVariableAria("token") }),
    ).toBeDisabled();
  });

  it("non-shadow parallel row shows rename pencil and commits (R8)", async () => {
    const user = userEvent.setup();
    useScenarioEditor.getState().loadFromString(`version: 1
name: "t"
variables: {}
steps:
  - id: "01HX0000000000000000000010"
    type: parallel
    name: B
    branches:
      - name: B
        steps:
          - id: "01HX0000000000000000000020"
            type: http
            name: a
            request: { method: GET, url: "/a?x={{fresh}}" }
            extract: [ { var: fresh, from: status } ]
  - id: "01HX0000000000000000000030"
    type: http
    name: d
    request: { method: GET, url: "/d?y={{B.fresh}}" }
`);
    render(<VariablesPanel />);
    // pencil aria uses display "B.fresh"
    await user.click(screen.getByRole("button", { name: ko.editor.renameVariableAria("B.fresh") }));
    const input = screen.getByRole("textbox", {
      name: ko.editor.variableRenameInputAria("B.fresh"),
    });
    await user.clear(input);
    await user.type(input, "renamed{Enter}");
    const yaml = useScenarioEditor.getState().yamlText;
    expect(yaml).toContain("{{renamed}}");
    expect(yaml).toContain("{{B.renamed}}");
  });

  it("R10: non-shadow parallel row's usage popover lists branch-internal ref before downstream ref, in doc order", async () => {
    const user = userEvent.setup();
    useScenarioEditor.getState().loadFromString(`version: 1
name: "t"
variables: {}
steps:
  - id: "01HX0000000000000000000010"
    type: parallel
    name: B
    branches:
      - name: B
        steps:
          - id: "01HX0000000000000000000020"
            type: http
            name: a
            request: { method: GET, url: "/a?x={{fresh}}" }
            extract: [ { var: fresh, from: status } ]
  - id: "01HX0000000000000000000030"
    type: http
    name: d
    request: { method: GET, url: "/d?y={{B.fresh}}" }
`);
    const onJump = vi.fn();
    render(<VariablesPanel onJumpToStep={onJump} />);
    await user.click(
      screen.getByRole("button", { name: ko.editor.variableUsageNavAria("B.fresh") }),
    );
    const menu = await screen.findByRole("menu", { name: ko.editor.varUsageListAria });
    const items = within(menu).getAllByRole("menuitem");
    expect(items).toHaveLength(2);
    await user.click(items[0]);
    expect(onJump).toHaveBeenNthCalledWith(1, "01HX0000000000000000000020"); // branch-internal ref first (doc order)
    expect(screen.getByRole("menu")).toBeInTheDocument(); // usages 사이 이동해도 유지
    await user.click(items[1]);
    expect(onJump).toHaveBeenNthCalledWith(2, "01HX0000000000000000000030"); // downstream namespaced ref
  });

  it("shadow parallel row has no rename pencil and shows shadow title (R9)", () => {
    useScenarioEditor.getState().loadFromString(`version: 1
name: "t"
variables: { s: "x" }
steps:
  - id: "01HX0000000000000000000040"
    type: parallel
    name: B
    branches:
      - name: B
        steps: [ { id: "01HX0000000000000000000050", type: http, name: a, request: { method: GET, url: "/a" }, extract: [ { var: s, from: status } ] } ]
`);
    render(<VariablesPanel />);
    expect(screen.queryByRole("button", { name: ko.editor.renameVariableAria("B.s") })).toBeNull();
    expect(screen.getByTitle(ko.editor.variableBranchShadowTitle)).toBeInTheDocument();
  });

  it("parallel rename collision shows inline error, no commit (R8)", async () => {
    const user = userEvent.setup();
    useScenarioEditor.getState().loadFromString(`version: 1
name: "t"
variables: { taken: "x" }
steps:
  - id: "01HX0000000000000000000060"
    type: parallel
    name: B
    branches:
      - name: B
        steps: [ { id: "01HX0000000000000000000070", type: http, name: a, request: { method: GET, url: "/a" }, extract: [ { var: fresh, from: status } ] } ]
`);
    render(<VariablesPanel />);
    await user.click(screen.getByRole("button", { name: ko.editor.renameVariableAria("B.fresh") }));
    const input = screen.getByRole("textbox", {
      name: ko.editor.variableRenameInputAria("B.fresh"),
    });
    await user.clear(input);
    await user.type(input, "taken{Enter}"); // into-shadow collision
    expect(screen.getByText(ko.editor.variableRenameCollision("taken"))).toBeInTheDocument();
    expect(useScenarioEditor.getState().yamlText).toContain("var: fresh"); // not committed
  });
});

describe("VariablesPanel — 분기 미스코프 힌트 + '선언 추가' 조건부 숨김 (parallel-var-scope Task 4, US1)", () => {
  beforeEach(() => useScenarioEditor.setState(useScenarioEditor.getInitialState()));

  // MIXED + 최상위 뒤 스텝이 bare {{s}}로 참조(s는 분기 alpha가 추출). 기존 MIXED만으론 이 케이스가
  // RED로 안 선다(브리프 F6/E3 — MIXED는 {{alpha.s}}를 namespaced로만 참조하고 분기 leaf는 참조 0이라
  // 새 규칙에서도 행 집합이 그대로다).
  const MIXED_DOWNSTREAM_BARE = `${MIXED.trimEnd()}
  - id: 01HX0000000000000000000099
    name: bareS
    type: http
    request: { method: GET, url: "/z?d={{s}}", headers: {} }
`;

  it("다운스트림 bare 미정의(candidates=1) 행 s: 힌트 렌더 + '선언 추가' 미렌더(핵심 회귀 가드)", () => {
    useScenarioEditor.getState().loadFromString(MIXED_DOWNSTREAM_BARE);
    render(<VariablesPanel />);
    const sLi = screen.getByTitle(ko.editor.variableUndefinedAria("s")).closest("li")!;
    expect(
      within(sLi).getByText(ko.editor.variableBranchCandidateHint("alpha", "s")),
    ).toBeInTheDocument();
    expect(
      within(sLi).queryByRole("button", { name: ko.editor.variableDeclareAddAria("s") }),
    ).toBeNull();
  });

  it("candidates=0인 missing 행: 힌트 없음 + '선언 추가' 렌더(현행 유지)", () => {
    useScenarioEditor.getState().loadFromString(MIXED_DOWNSTREAM_BARE);
    render(<VariablesPanel />);
    const missingLi = screen.getByTitle(ko.editor.variableUndefinedAria("missing")).closest("li")!;
    expect(
      within(missingLi).getByRole("button", {
        name: ko.editor.variableDeclareAddAria("missing"),
      }),
    ).toBeInTheDocument();
    expect(within(missingLi).queryByText(/parallel 분기/)).toBeNull();
  });

  it("두 형제 분기가 같은 이름을 추출(candidates=2+)하면 후보 나열 힌트 + '선언 추가' 미렌더", () => {
    useScenarioEditor.getState().loadFromString(`version: 1
name: two
cookie_jar: auto
variables: {}
steps:
  - id: 01HX0000000000000000000100
    name: par
    type: parallel
    branches:
      - name: A
        steps: [ { id: "01HX0000000000000000000101", type: http, name: a, request: { method: GET, url: "/a" }, extract: [ { var: dup, from: status } ] } ]
      - name: B
        steps: [ { id: "01HX0000000000000000000102", type: http, name: b, request: { method: GET, url: "/b" }, extract: [ { var: dup, from: status } ] } ]
  - id: 01HX0000000000000000000103
    name: after
    type: http
    request: { method: GET, url: "/u?v={{dup}}", headers: {} }
`);
    render(<VariablesPanel />);
    const dupLi = screen.getByTitle(ko.editor.variableUndefinedAria("dup")).closest("li")!;
    expect(
      within(dupLi).getByText(ko.editor.variableBranchCandidatesHint(["A", "B"], "dup")),
    ).toBeInTheDocument();
    expect(
      within(dupLi).queryByRole("button", { name: ko.editor.variableDeclareAddAria("dup") }),
    ).toBeNull();
  });

  it("형제 분기 참조(sibling kind)는 전용 문구 + '선언 추가' 미렌더", () => {
    useScenarioEditor.getState().loadFromString(`version: 1
name: sib
cookie_jar: auto
variables: {}
steps:
  - id: 01HX0000000000000000000200
    name: par
    type: parallel
    branches:
      - name: A
        steps: [ { id: "01HX0000000000000000000201", type: http, name: a, request: { method: GET, url: "/x?v={{v}}" } } ]
      - name: B
        steps: [ { id: "01HX0000000000000000000202", type: http, name: b, request: { method: GET, url: "/y" }, extract: [ { var: v, from: status } ] } ]
`);
    render(<VariablesPanel />);
    const vLi = screen.getByTitle(ko.editor.variableUndefinedAria("v")).closest("li")!;
    expect(within(vLi).getByText(ko.editor.variableSiblingBranchHint)).toBeInTheDocument();
    expect(
      within(vLi).queryByRole("button", { name: ko.editor.variableDeclareAddAria("v") }),
    ).toBeNull();
  });

  it("미정의 행 usage 팝오버는 stepIds만(분기 내부 정당 참조 step 제외) — refIndex 전체가 아님", async () => {
    const user = userEvent.setup();
    useScenarioEditor.getState().loadFromString(`version: 1
name: wiring
cookie_jar: auto
variables: {}
steps:
  - id: 01HX0000000000000000000300
    name: par
    type: parallel
    branches:
      - name: alpha
        steps: [ { id: "01HX0000000000000000000301", type: http, name: leaf, request: { method: GET, url: "/{{s}}" }, extract: [ { var: s, from: status } ] } ]
  - id: 01HX0000000000000000000302
    name: after
    type: http
    request: { method: GET, url: "/z?d={{s}}" }
`);
    const onJump = vi.fn();
    render(<VariablesPanel onJumpToStep={onJump} />);
    const sLi = screen.getByTitle(ko.editor.variableUndefinedAria("s")).closest("li")!;
    await user.click(
      within(sLi).getByRole("button", { name: ko.editor.variableUsageNavAria("s") }),
    );
    const menu = await screen.findByRole("menu", { name: ko.editor.varUsageListAria });
    const items = within(menu).getAllByRole("menuitem");
    expect(items).toHaveLength(1); // 분기 내부 leaf(...301)는 정당 참조라 제외 — 다운스트림(...302)만
    await user.click(items[0]);
    expect(onJump).toHaveBeenNthCalledWith(1, "01HX0000000000000000000302");
  });
});

describe("VariablesPanel — 추출/미정의 행 적응형 줄바꿈 (extract-var-name-visibility)", () => {
  beforeEach(() => useScenarioEditor.setState(useScenarioEditor.getInitialState()));

  const tokens = (el: Element) => (el.getAttribute("class") ?? "").split(/\s+/);

  // 선언 s를 alpha 분기가 다시 추출 → declared non-renamable + parallel shadow 행
  const SHADOW = `version: 1
name: t
cookie_jar: auto
variables:
  s: seed
steps:
  - id: 01HX0000000000000000000060
    name: par
    type: parallel
    branches:
      - name: alpha
        steps:
          - id: 01HX0000000000000000000061
            name: leaf
            type: http
            request: { method: GET, url: "/y", headers: {} }
            extract:
              - from: body
                path: $.t
                var: s
`;

  it("R1: flat-extract·parallel-extract·undefined 행 li는 flex-wrap + gap-x-2/gap-y-1 (gap-2 부재)", () => {
    useScenarioEditor.getState().loadFromString(MIXED);
    render(<VariablesPanel />);
    const lis = [
      screen.getByTitle("flatVar").closest("li")!,
      screen.getByTitle("alpha.s").closest("li")!,
      screen.getByTitle(ko.editor.variableUndefinedAria("missing")).closest("li")!,
    ];
    for (const li of lis) {
      const t = tokens(li);
      expect(t).toContain("flex-wrap");
      expect(t).toContain("gap-x-2");
      expect(t).toContain("gap-y-1");
      expect(t).not.toContain("gap-2");
    }
  });

  it("R2: 이름 span은 min-w-[72px] (min-w-0 부재), rename 래퍼도 동일하되 <Input> 자신은 min-w-0 유지", () => {
    useScenarioEditor.getState().loadFromString(MIXED);
    render(<VariablesPanel />);
    // 이름 span 3/4곳: nameCell(flat-extract) · parallel non-shadow · undefined
    for (const title of ["flatVar", "alpha.s", ko.editor.variableUndefinedAria("missing")]) {
      const t = tokens(screen.getByTitle(title));
      expect(t).toContain("min-w-[72px]");
      expect(t).not.toContain("min-w-0");
    }
    // flat rename 래퍼: ✎ 클릭 → input.parentElement 가 래퍼 div (Input.tsx는 bare <input>)
    fireEvent.click(screen.getByRole("button", { name: ko.editor.renameVariableAria("flatVar") }));
    const input = screen.getByRole("textbox", {
      name: ko.editor.variableRenameInputAria("flatVar"),
    });
    const wrapper = input.parentElement!;
    expect(tokens(wrapper)).toContain("min-w-[72px]");
    expect(tokens(wrapper)).not.toContain("min-w-0");
    expect(tokens(input)).toContain("min-w-0"); // <Input> 자신은 유지 — w-full이 줄어든 래퍼를 채우는 데 필요(spec R2 단서)
  });

  it("R2/R5: parallel rename 래퍼·shadow 이름 span은 min-w-[72px], declared non-renamable span도 min-w-[72px]", () => {
    // (a) non-shadow parallel rename 래퍼 — MIXED
    useScenarioEditor.getState().loadFromString(MIXED);
    const { unmount } = render(<VariablesPanel />);
    fireEvent.click(screen.getByRole("button", { name: ko.editor.renameVariableAria("alpha.s") }));
    const pInput = screen.getByRole("textbox", {
      name: ko.editor.variableRenameInputAria("alpha.s"),
    });
    expect(tokens(pInput.parentElement!)).toContain("min-w-[72px]");
    expect(tokens(pInput.parentElement!)).not.toContain("min-w-0");
    unmount();
    // (b) shadow span + declared non-renamable span — SHADOW
    useScenarioEditor.getState().loadFromString(SHADOW);
    render(<VariablesPanel />);
    const shadow = screen.getByTitle("alpha.s"); // shadow 행 이름 span (title=display)
    expect(tokens(shadow)).toContain("min-w-[72px]");
    expect(tokens(shadow)).not.toContain("min-w-0");
    const declared = screen.getByTitle("s"); // declared non-renamable span — 배지 동석 대비 min-w-[72px] 전환(editor-var-conflict-quickadd R9, 구 "의도적 무변경" 락인 반전)
    expect(tokens(declared)).toContain("min-w-[72px]");
    expect(tokens(declared)).not.toContain("min-w-0");
  });

  it("사용처 버튼은 text-left — declared 행(flex-col stretch)에서 브라우저 기본 중앙정렬 방지, 전 행 좌측 통일", () => {
    useScenarioEditor.getState().loadFromString(MIXED);
    render(<VariablesPanel />);
    // declared token(flex-col li: 버튼이 full-width stretch라 text-align이 실렌더를 좌우)
    // + parallel alpha.s(flex-row li: content-폭이라 무영향이지만 공유 셀 계약 락인)
    for (const name of ["token", "alpha.s"]) {
      const t = tokens(screen.getByRole("button", { name: ko.editor.variableUsageNavAria(name) }));
      expect(t).toContain("text-left");
    }
  });
});

describe("VariablesPanel — 선언↔추출 충돌 배지 (editor-var-conflict-quickadd R3/R4/R9)", () => {
  beforeEach(() => useScenarioEditor.setState(useScenarioEditor.getInitialState()));

  const tokens = (el: Element) => (el.getAttribute("class") ?? "").split(/\s+/);

  // 선언 token을 비-parallel 스텝 extract가 다시 씀 → flat 충돌(R3①)
  const FLAT_CONFLICT = `version: 1
name: t
cookie_jar: auto
variables:
  token: seed
steps:
  - id: 01HX0000000000000000000001
    name: login
    type: http
    request: { method: POST, url: "/login", headers: {} }
    extract:
      - from: body
        path: $.tok
        var: token
`;

  // bare 선언 s + parallel-only extract s → amber 배지 없음(R4, shadow 배지만)
  const BARE_SHADOW = `version: 1
name: t
cookie_jar: auto
variables:
  s: seed
steps:
  - id: 01HX0000000000000000000060
    name: par
    type: parallel
    branches:
      - name: alpha
        steps:
          - id: 01HX0000000000000000000061
            name: leaf
            type: http
            request: { method: GET, url: "/y", headers: {} }
            extract:
              - from: body
                path: $.t
                var: s
`;

  // 점 포함 선언 brX.tok == parallel merge 키 → 진짜 덮어쓰기 배지(R3③, 리뷰 F2)
  const DOTTED = `version: 1
name: t
cookie_jar: auto
variables:
  brX.tok: seed
steps:
  - id: 01HX0000000000000000000060
    name: par
    type: parallel
    branches:
      - name: brX
        steps:
          - id: 01HX0000000000000000000061
            name: leaf
            type: http
            request: { method: GET, url: "/y", headers: {} }
            extract:
              - from: body
                path: $.t
                var: tok
`;

  // 3중 동명: 선언 s + flat extract s + parallel extract s → 배지 ∧ renamable=false (R9 최악 조합)
  const TRIPLE = `version: 1
name: t
cookie_jar: auto
variables:
  s: seed
steps:
  - id: 01HX0000000000000000000001
    name: consume
    type: http
    request: { method: GET, url: "/x", headers: {} }
    extract:
      - from: body
        path: $.u
        var: s
  - id: 01HX0000000000000000000060
    name: par
    type: parallel
    branches:
      - name: alpha
        steps:
          - id: 01HX0000000000000000000061
            name: leaf
            type: http
            request: { method: GET, url: "/y", headers: {} }
            extract:
              - from: body
                path: $.t
                var: s
`;

  it("R3①: flat 충돌 선언 행에 amber 배지 + 조건형 title, rename 연필은 유지", () => {
    useScenarioEditor.getState().loadFromString(FLAT_CONFLICT);
    render(<VariablesPanel />);
    const badge = screen.getByText(ko.editor.variableOverwritten);
    expect(badge).toHaveAttribute("title", ko.editor.variableOverwrittenTitle);
    const t = tokens(badge);
    expect(t).toContain("bg-amber-50");
    expect(t).toContain("text-amber-700");
    expect(t).toContain("shrink-0");
    // flat 충돌은 rename 비활성 근거가 아니다(renamable은 parallelNames만 본다)
    expect(
      screen.getByRole("button", { name: ko.editor.renameVariableAria("token") }),
    ).toBeInTheDocument();
  });

  it("R3②: 충돌 없는 선언 행(MIXED token)엔 배지 부재", () => {
    useScenarioEditor.getState().loadFromString(MIXED);
    render(<VariablesPanel />);
    expect(screen.queryByText(ko.editor.variableOverwritten)).toBeNull();
  });

  it("R4: bare 선언 + parallel-only extract는 amber 배지 부재(shadow 배지만)", () => {
    useScenarioEditor.getState().loadFromString(BARE_SHADOW);
    render(<VariablesPanel />);
    expect(screen.queryByText(ko.editor.variableOverwritten)).toBeNull();
    expect(screen.getByTitle(ko.editor.variableBranchShadowTitle)).toBeInTheDocument();
  });

  it("R3③: 점 포함 선언이 merge 키와 리터럴 동일하면 배지 — 선언 행 within 스코프", () => {
    useScenarioEditor.getState().loadFromString(DOTTED);
    render(<VariablesPanel />);
    // getByTitle("brX.tok")은 선언 span(title=name)과 parallel 행 span(title=display)을
    // 동시 매치 — 선언 행 전용 앵커(값 textarea)로 li를 잡아 within 스코프(리뷰 nit #3)
    const li = screen
      .getByRole("textbox", { name: ko.editor.variableValueAria("brX.tok") })
      .closest("li")!;
    expect(within(li).getByText(ko.editor.variableOverwritten)).toBeInTheDocument();
  });

  it("R9: 배지 행 nameline은 flex-wrap(gap-2 부재), TRIPLE non-renamable 선언 span은 min-w-[72px] + 배지 동석", () => {
    useScenarioEditor.getState().loadFromString(TRIPLE);
    render(<VariablesPanel />);
    const li = screen
      .getByRole("textbox", { name: ko.editor.variableValueAria("s") })
      .closest("li")!;
    // renamable=false(parallel s 추출) → 연필 없음 = non-renamable span 경로
    expect(
      within(li).queryByRole("button", { name: ko.editor.renameVariableAria("s") }),
    ).toBeNull();
    const badge = within(li).getByText(ko.editor.variableOverwritten); // flat extract s → 배지
    // 배지+×는 한 묶음(trailer group)으로 함께 wrap — ×만 단독 줄바꿈 방지(badge-x-wrap-fix)
    const trailer = badge.parentElement!;
    const tt = tokens(trailer);
    expect(tt).toContain("ml-auto");
    expect(tt).toContain("shrink-0");
    expect(tt).toContain("gap-x-2");
    expect(
      within(trailer as HTMLElement).getByRole("button", {
        name: ko.editor.removeVariableAria("s"),
      }),
    ).toBeInTheDocument();
    const nameline = trailer.parentElement!;
    const nt = tokens(nameline);
    expect(nt).toContain("flex-wrap");
    expect(nt).toContain("gap-x-2");
    expect(nt).toContain("gap-y-1");
    expect(nt).not.toContain("gap-2");
    const nameSpan = within(li).getByTitle("s");
    expect(tokens(nameSpan)).toContain("min-w-[72px]");
    expect(tokens(nameSpan)).not.toContain("min-w-0");
  });
});

describe("VariablesPanel — 미정의 변수 원클릭 선언 (editor-var-conflict-quickadd R5–R8)", () => {
  beforeEach(() => useScenarioEditor.setState(useScenarioEditor.getInitialState()));

  const DOTTED_UNDEF = `version: 1
name: t
cookie_jar: auto
variables: {}
steps:
  - id: 01HX0000000000000000000001
    name: consume
    type: http
    request:
      method: GET
      url: "/x?a={{ghost.v}}"
      headers: {}
`;

  it("R5: '선언 추가' 클릭 → 빈 값 선언·⚠ 행 소멸·선언 행 등장·검색어 유지", async () => {
    const user = userEvent.setup();
    useScenarioEditor.getState().loadFromString(MIXED);
    render(<VariablesPanel />);
    const search = screen.getByPlaceholderText(ko.editor.varSearchPlaceholder);
    await user.type(search, "missing");
    await user.click(
      screen.getByRole("button", { name: ko.editor.variableDeclareAddAria("missing") }),
    );
    expect(useScenarioEditor.getState().model!.variables).toHaveProperty("missing", "");
    expect(useScenarioEditor.getState().yamlText).toContain("missing:");
    expect(screen.queryByTitle(ko.editor.variableUndefinedAria("missing"))).toBeNull();
    expect(
      screen.getByRole("textbox", { name: ko.editor.variableValueAria("missing") }),
    ).toBeInTheDocument();
    // 검색어 미클리어(R5) — 하단 추가 경로의 setQuery("") 복사 금지
    expect(search).toHaveValue("missing");
  });

  it("R7: 점 포함 미정의 이름도 리터럴 키로 선언", async () => {
    const user = userEvent.setup();
    useScenarioEditor.getState().loadFromString(DOTTED_UNDEF);
    render(<VariablesPanel />);
    await user.click(
      screen.getByRole("button", { name: ko.editor.variableDeclareAddAria("ghost.v") }),
    );
    // 주의: toHaveProperty는 점을 경로로 해석 — 리터럴 키는 배열 형
    expect(useScenarioEditor.getState().model!.variables).toHaveProperty(["ghost.v"], "");
  });

  it("R6: yamlError 상태에서 '선언 추가'·하단 '추가' 둘 다 disabled", async () => {
    const user = userEvent.setup();
    useScenarioEditor.getState().loadFromString(MIXED);
    useScenarioEditor.getState().setPendingYamlText("version: 1\nname: t\nsteps: [\n");
    useScenarioEditor.getState().commitPendingYaml(); // yamlError 세팅 — model은 보존됨
    render(<VariablesPanel />);
    expect(
      screen.getByRole("button", { name: ko.editor.variableDeclareAddAria("missing") }),
    ).toBeDisabled();
    // 하단 버튼: 이름을 먼저 타이핑해 빈-이름 disabled와 구분(teeth)
    await user.type(screen.getByPlaceholderText("new_var"), "x");
    expect(screen.getByRole("button", { name: ko.editor.variablesAdd })).toBeDisabled();
  });

  it("R8: 미정의 행 사용처 팝오버가 열린 채 키보드로 '선언 추가' → 팝오버 닫힘", async () => {
    const user = userEvent.setup();
    useScenarioEditor.getState().loadFromString(MIXED);
    render(<VariablesPanel />);
    await user.click(
      screen.getByRole("button", { name: ko.editor.variableUsageNavAria("missing") }),
    );
    expect(
      await screen.findByRole("menu", { name: ko.editor.varUsageListAria }),
    ).toBeInTheDocument();
    // 키보드 활성화(Enter) — 마우스 클릭은 팝오버의 outside-pointerdown이 선제로 닫아
    // R8 setUsageNav(null) 없이도 통과(false-green)하므로 반드시 키보드 경로로(teeth)
    screen.getByRole("button", { name: ko.editor.variableDeclareAddAria("missing") }).focus();
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
