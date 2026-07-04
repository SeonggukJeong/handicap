import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { Inspector } from "../Inspector";
import { useScenarioEditor } from "../../../scenario/store";
import { parseScenarioDoc } from "../../../scenario/yamlDoc";
import { ko } from "../../../i18n/ko";

const VALID_YAML = `version: 1
name: "demo"
cookie_jar: auto
variables: {}
steps:
  - id: "01HX0000000000000000000001"
    name: "login"
    type: http
    request:
      method: POST
      url: "/login"
    assert:
      - status: 200
`;

const IF_YAML = `version: 1
name: "demo"
cookie_jar: auto
variables: {}
steps:
  - id: "01HX0000000000000000000010"
    name: "branch"
    type: if
    cond:
      left: "{{code}}"
      op: eq
      right: "200"
    then:
      - id: "01HX0000000000000000000011"
        name: "ok"
        type: http
        request:
          method: GET
          url: "/ok"
        assert:
          - status: 200
`;

function loadAndSelect() {
  useScenarioEditor.setState(useScenarioEditor.getInitialState());
  useScenarioEditor.getState().loadFromString(VALID_YAML);
  useScenarioEditor.getState().select("01HX0000000000000000000001");
}

describe("Inspector — placeholder", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useScenarioEditor.setState(useScenarioEditor.getInitialState());
  });

  it("shows placeholder when no step is selected", () => {
    useScenarioEditor.getState().loadFromString(VALID_YAML);
    render(<Inspector />);
    expect(screen.getByText(/아웃라인에서 스텝을 선택/)).toBeInTheDocument();
  });
});

describe("Inspector — ExtractEditor", () => {
  beforeEach(() => {
    window.localStorage.clear();
    loadAndSelect();
  });

  it("adds a body extract row and writes it to the YAML", async () => {
    const user = userEvent.setup();
    render(<Inspector />);
    await user.click(screen.getByRole("button", { name: ko.editor.extractsLegend }));

    const extractSection = screen.getByRole("group", { name: "값 추출" });
    const addBtn = within(extractSection).getByRole("button", { name: /추가/i });
    await user.click(addBtn);

    const varInput = within(extractSection).getByPlaceholderText("var");
    await user.clear(varInput);
    await user.type(varInput, "token");

    const pathInput = within(extractSection).getByPlaceholderText("$.path");
    await user.clear(pathInput);
    await user.type(pathInput, "$.access_token");

    await user.tab();

    const yaml = useScenarioEditor.getState().yamlText;
    expect(yaml).toMatch(/extract:/);
    expect(yaml).toMatch(/var:\s*token/);
    expect(yaml).toMatch(/path:\s*"?\$\.access_token"?/);
    expect(yaml).toMatch(/from:\s*body/);
  });

  it("switching from to header swaps the second field from path to name", async () => {
    const user = userEvent.setup();
    render(<Inspector />);
    await user.click(screen.getByRole("button", { name: ko.editor.extractsLegend }));

    const extractSection = screen.getByRole("group", { name: "값 추출" });
    await user.click(within(extractSection).getByRole("button", { name: /추가/i }));

    const fromSelect = within(extractSection).getByLabelText("추출 0 종류");
    await user.selectOptions(fromSelect, "header");

    expect(within(extractSection).queryByPlaceholderText("$.path")).toBeNull();
    expect(
      within(extractSection).getByPlaceholderText(ko.editor.headerNamePlaceholder),
    ).toBeInTheDocument();
  });

  it("removes a row when its delete button is clicked", async () => {
    const user = userEvent.setup();
    render(<Inspector />);
    await user.click(screen.getByRole("button", { name: ko.editor.extractsLegend }));
    const extractSection = screen.getByRole("group", { name: "값 추출" });

    await user.click(within(extractSection).getByRole("button", { name: /추가/i }));
    await user.type(within(extractSection).getByPlaceholderText("var"), "t");
    await user.type(within(extractSection).getByPlaceholderText("$.path"), "$.x");
    await user.tab();

    expect(useScenarioEditor.getState().yamlText).toMatch(/extract:/);

    const removeBtn = within(extractSection).getByRole("button", {
      name: /추출 0 제거/i,
    });
    await user.click(removeBtn);

    expect(useScenarioEditor.getState().yamlText).not.toMatch(/extract:/);
  });

  it("does not write to yamlText on every keystroke (commit-on-blur)", async () => {
    const user = userEvent.setup();
    render(<Inspector />);
    await user.click(screen.getByRole("button", { name: ko.editor.extractsLegend }));

    const extractSection = screen.getByRole("group", { name: "값 추출" });
    await user.click(within(extractSection).getByRole("button", { name: /추가/i }));

    // Type a var. With commit-on-blur, yamlText must NOT contain "var: " yet.
    const varInput = within(extractSection).getByPlaceholderText("var");
    await user.click(varInput);
    await user.type(varInput, "tok");

    // Typing the full path. Still focused — no blur fired.
    const pathInput = within(extractSection).getByPlaceholderText("$.path");
    await user.click(pathInput);
    await user.clear(pathInput);
    await user.type(pathInput, "$.access_token");

    // Assert: yamlText still has NO extract entry while inputs are focused.
    expect(useScenarioEditor.getState().yamlText).not.toMatch(/var:\s*tok/);
    expect(useScenarioEditor.getState().yamlText).not.toMatch(/extract:\s*\n/);

    // Now blur → commit fires.
    await user.tab();
    expect(useScenarioEditor.getState().yamlText).toMatch(/var:\s*tok/);
    expect(useScenarioEditor.getState().yamlText).toMatch(/path:\s*"?\$\.access_token"?/);
  });

  it("does not blink on partial path edit of an existing row", async () => {
    const user = userEvent.setup();
    render(<Inspector />);
    await user.click(screen.getByRole("button", { name: ko.editor.extractsLegend }));

    // Bootstrap: add one complete row.
    const extractSection = screen.getByRole("group", { name: "값 추출" });
    await user.click(within(extractSection).getByRole("button", { name: /추가/i }));
    await user.type(within(extractSection).getByPlaceholderText("var"), "token");
    const pathInputBootstrap = within(extractSection).getByPlaceholderText("$.path");
    await user.clear(pathInputBootstrap);
    await user.type(pathInputBootstrap, "$.old");
    await user.tab();
    expect(useScenarioEditor.getState().yamlText).toMatch(/path:\s*"?\$\.old"?/);

    // Clear the path field and start typing a new value. Mid-typing, the row
    // must remain in yamlText (not blink out due to a transient invalid state).
    const pathInput = within(extractSection).getByPlaceholderText("$.path");
    await user.click(pathInput);
    await user.clear(pathInput);
    // Still focused — yamlText must still reference the LAST committed value.
    expect(useScenarioEditor.getState().yamlText).toMatch(/var:\s*token/);
    expect(useScenarioEditor.getState().yamlText).toMatch(/path:\s*"?\$\.old"?/);

    await user.type(pathInput, "$.new");
    // Still focused, still old value.
    expect(useScenarioEditor.getState().yamlText).toMatch(/path:\s*"?\$\.old"?/);

    // Blur → commit the new value.
    await user.tab();
    expect(useScenarioEditor.getState().yamlText).toMatch(/path:\s*"?\$\.new"?/);
    expect(useScenarioEditor.getState().yamlText).not.toMatch(/path:\s*"?\$\.old"?/);
  });
});

describe("Inspector — loop", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useScenarioEditor.setState(useScenarioEditor.getInitialState());
    useScenarioEditor.getState().resetEmpty();
  });

  it("shows a repeat field when a loop is selected and updates the model", async () => {
    const user = userEvent.setup();
    const loopId = useScenarioEditor.getState().addLoopStep("Loop A");
    useScenarioEditor.getState().select(loopId);
    render(<Inspector />);

    const repeat = screen.getByLabelText(/반복 횟수/i) as HTMLInputElement;
    expect(repeat).toBeInTheDocument();
    await user.clear(repeat);
    await user.type(repeat, "6");
    await user.tab(); // commit on blur

    const loop = useScenarioEditor.getState().model!.steps.find((s) => s.id === loopId)!;
    expect(loop.type).toBe("loop");
    if (loop.type === "loop") expect(loop.repeat).toBe(6);
  });

  it("editing a step nested in a loop works (request URL)", async () => {
    const user = userEvent.setup();
    const loopId = useScenarioEditor.getState().addLoopStep("Loop A");
    const loop = useScenarioEditor.getState().model!.steps.find((s) => s.id === loopId)!;
    const childId = loop.type === "loop" ? loop.do[0].id : "";
    useScenarioEditor.getState().select(childId);
    render(<Inspector />);

    // The URL field commits onChange and reflects the model on each keystroke,
    // so typing appends to the seeded "/" default. Appending proves the edit
    // targets the NESTED step's request.url (not a top-level step).
    const url = screen.getByDisplayValue("/") as HTMLInputElement;
    await user.click(url);
    await user.type(url, "inner");

    const after = useScenarioEditor.getState().model!.steps.find((s) => s.id === loopId)!;
    if (after.type === "loop" && after.do[0].type === "http")
      expect(after.do[0].request.url).toBe("/inner");
  });

  it("lists loop body steps and selects one on click", async () => {
    const user = userEvent.setup();
    const loopId = useScenarioEditor.getState().addLoopStep("Loop A");
    const loop = useScenarioEditor.getState().model!.steps.find((s) => s.id === loopId)!;
    const childId = loop.type === "loop" ? loop.do[0].id : "";
    useScenarioEditor.getState().select(loopId);
    render(<Inspector />);

    const childButton = screen.getByRole("button", { name: /Step 1/i });
    await user.click(childButton);
    expect(useScenarioEditor.getState().selectedStepId).toBe(childId);
  });
});

describe("Inspector — move up/down (container steps)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useScenarioEditor.setState(useScenarioEditor.getInitialState());
    useScenarioEditor.getState().resetEmpty();
  });

  it("reorders a top-level loop among its siblings via Move up", async () => {
    const user = userEvent.setup();
    const httpId = useScenarioEditor.getState().addStep("First");
    const loopId = useScenarioEditor.getState().addLoopStep("Loop A");
    useScenarioEditor.getState().select(loopId);
    render(<Inspector />);

    // Loop is last of two → Move down disabled, Move up enabled.
    expect(screen.getByTitle("아래로")).toBeDisabled();
    const up = screen.getByTitle("위로");
    expect(up).not.toBeDisabled();

    await user.click(up);

    const ids = useScenarioEditor.getState().model!.steps.map((s) => s.id);
    expect(ids).toEqual([loopId, httpId]);
    // Now first → Move up disabled.
    expect(screen.getByTitle("위로")).toBeDisabled();
  });

  it("reorders a top-level if among its siblings via Move down", async () => {
    const user = userEvent.setup();
    const ifId = useScenarioEditor.getState().addIfStep("Branch");
    const httpId = useScenarioEditor.getState().addStep("Last");
    useScenarioEditor.getState().select(ifId);
    render(<Inspector />);

    // If is first of two → Move up disabled, Move down enabled.
    expect(screen.getByTitle("위로")).toBeDisabled();
    const down = screen.getByTitle("아래로");
    expect(down).not.toBeDisabled();

    await user.click(down);

    const ids = useScenarioEditor.getState().model!.steps.map((s) => s.id);
    expect(ids).toEqual([httpId, ifId]);
  });
});

describe("Inspector — if route", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useScenarioEditor.setState(useScenarioEditor.getInitialState());
    useScenarioEditor.getState().loadFromString(IF_YAML);
    useScenarioEditor.getState().select("01HX0000000000000000000010");
  });

  it("shows the If heading and the branch name", () => {
    render(<Inspector />);
    expect(screen.getByRole("heading", { name: "조건(if)" })).toBeInTheDocument();
    expect((screen.getByLabelText("이름") as HTMLInputElement) ?? null).toBeTruthy();
  });

  it("navigates to a then-branch step", async () => {
    const user = userEvent.setup();
    render(<Inspector />);
    // RTL normalizes the em-dash separator out of the title-derived accessible
    // name ("ok — GET /ok" → "ok GET /ok"); match the normalized form.
    await user.click(screen.getByRole("button", { name: /ok\s+GET \/ok/i }));
    expect(useScenarioEditor.getState().selectedStepId).toBe("01HX0000000000000000000011");
  });
});

describe("Inspector — IfInspector (builder)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useScenarioEditor.setState(useScenarioEditor.getInitialState());
    useScenarioEditor.getState().loadFromString(IF_YAML);
    useScenarioEditor.getState().select("01HX0000000000000000000010");
  });

  it("renders the condition leaf with current values", () => {
    render(<Inspector />);
    const left = screen.getByLabelText("조건 왼쪽 값") as HTMLInputElement;
    const right = screen.getByLabelText("조건 오른쪽 값") as HTMLInputElement;
    expect(left.value).toBe("{{code}}");
    expect((screen.getByLabelText("조건 연산자") as HTMLSelectElement).value).toBe("eq");
    expect(right.value).toBe("200");
    // 조건 피연산자 placeholder도 ko 카탈로그 경유(영어 left/right 잔존 금지, R1)
    expect(left.placeholder).toBe(ko.editor.condLeftPlaceholder);
    expect(right.placeholder).toBe(ko.editor.condRightPlaceholder);
  });

  it("commits a changed right value on blur", async () => {
    const user = userEvent.setup();
    render(<Inspector />);
    const right = screen.getByLabelText("조건 오른쪽 값");
    await user.clear(right);
    await user.type(right, "404");
    await user.tab();
    const s = useScenarioEditor.getState().model!.steps[0];
    if (s.type === "if" && !("all" in s.cond) && !("any" in s.cond)) {
      expect(s.cond.right).toBe("404");
    } else throw new Error("expected compare cond");
  });

  it("hides the right input and drops right when op is exists", async () => {
    const user = userEvent.setup();
    render(<Inspector />);
    await user.selectOptions(screen.getByLabelText("조건 연산자"), "exists");
    expect(screen.queryByLabelText("조건 오른쪽 값")).toBeNull();
    const s = useScenarioEditor.getState().model!.steps[0];
    if (s.type === "if" && !("all" in s.cond) && !("any" in s.cond)) {
      expect(s.cond.op).toBe("exists");
      expect(s.cond.right).toBeUndefined();
    } else throw new Error("expected compare cond");
  });

  it("warns on an invalid regex for the matches op", async () => {
    const user = userEvent.setup();
    render(<Inspector />);
    await user.selectOptions(screen.getByLabelText("조건 연산자"), "matches");
    const right = screen.getByLabelText("조건 오른쪽 값");
    await user.clear(right);
    // user-event treats "[" as a key-descriptor delimiter; "[[" types a literal "[".
    await user.type(right, "[[");
    await user.tab();
    expect(screen.getByText(/invalid regex/i)).toBeInTheDocument();
  });

  it("wraps a leaf in a group and adds a condition", async () => {
    const user = userEvent.setup();
    render(<Inspector />);
    await user.click(screen.getByRole("button", { name: /그룹으로 묶기/i }));
    await user.click(screen.getByRole("button", { name: /\+ 조건/i }));
    const s = useScenarioEditor.getState().model!.steps[0];
    if (s.type === "if" && "all" in s.cond) expect(s.cond.all).toHaveLength(2);
    else throw new Error("expected all group");
  });

  it("adds a step to the else branch", async () => {
    const user = userEvent.setup();
    render(<Inspector />);
    await user.click(screen.getByRole("button", { name: /Else에 스텝 추가/i }));
    const s = useScenarioEditor.getState().model!.steps[0];
    if (s.type === "if") expect(s.else).toHaveLength(1);
    else throw new Error("expected if step");
  });

  it("adds then removes an elif branch", async () => {
    const user = userEvent.setup();
    render(<Inspector />);
    await user.click(screen.getByRole("button", { name: /\+ Elif 추가/i }));
    let s = useScenarioEditor.getState().model!.steps[0];
    if (s.type === "if") expect(s.elif).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: /Elif 1 제거/i }));
    s = useScenarioEditor.getState().model!.steps[0];
    if (s.type === "if") expect(s.elif).toHaveLength(0);
  });

  it("cannot remove a group's last child (no empty group)", async () => {
    const user = userEvent.setup();
    render(<Inspector />);
    // Wrap the single leaf into a group → group now has exactly 1 child.
    await user.click(screen.getByRole("button", { name: /그룹으로 묶기/i }));
    // With one child, no remove-condition button is offered, so the group
    // cannot be emptied into a vacuous-true {all: []}.
    expect(screen.queryByRole("button", { name: /조건 제거/i })).toBeNull();
    // Add a second condition → now removal is allowed again (2 children).
    await user.click(screen.getByRole("button", { name: /\+ 조건/i }));
    expect(screen.getAllByRole("button", { name: /조건 제거/i }).length).toBe(2);
    // Remove one → back to 1 child, group still non-empty, remove buttons gone.
    await user.click(screen.getAllByRole("button", { name: /조건 제거/i })[0]);
    const s = useScenarioEditor.getState().model!.steps[0];
    if (s.type === "if" && "all" in s.cond) expect(s.cond.all).toHaveLength(1);
    else throw new Error("expected all group with one child");
    expect(screen.queryByRole("button", { name: /조건 제거/i })).toBeNull();
  });
});

describe("Inspector — mutual nesting (9c)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useScenarioEditor.setState(useScenarioEditor.getInitialState());
    useScenarioEditor.getState().resetEmpty();
  });

  it("offers '+ Add if' on a top-level loop and nests it (9c)", async () => {
    const user = userEvent.setup();
    const loopId = useScenarioEditor.getState().addLoopStep("Loop 1");
    useScenarioEditor.getState().select(loopId);
    render(<Inspector />);
    await user.click(screen.getByRole("button", { name: /반복 본문에 조건 추가/i }));
    const loop = useScenarioEditor.getState().model!.steps.find((s) => s.id === loopId);
    expect(loop?.type).toBe("loop");
    if (loop?.type === "loop") {
      expect(loop.do.some((c) => c.type === "if")).toBe(true);
    }
  });

  it("offers '+ Add loop' on a top-level if THEN branch and nests it (9c)", async () => {
    const user = userEvent.setup();
    const ifId = useScenarioEditor.getState().addIfStep("If 1");
    useScenarioEditor.getState().select(ifId);
    render(<Inspector />);
    // BranchPanel for THEN exposes its own "+ Add loop"
    const addLoopButtons = screen.getAllByRole("button", { name: /반복 추가/i });
    await user.click(addLoopButtons[0]);
    const ifStep = useScenarioEditor.getState().model!.steps.find((s) => s.id === ifId);
    expect(ifStep?.type).toBe("if");
    if (ifStep?.type === "if") {
      expect(ifStep.then.some((c) => c.type === "loop")).toBe(true);
    }
  });

  it("does NOT offer nesting buttons on a nested container (depth gate, 9c)", async () => {
    // if { then: [ loop ] }  — select the nested loop; it must not offer '+ Add if'
    const ifId = useScenarioEditor.getState().addIfStep("If 1")!;
    const nestedLoopId = useScenarioEditor
      .getState()
      .addLoopInBranch(ifId, { kind: "then" }, "inner");
    useScenarioEditor.getState().select(nestedLoopId);
    render(<Inspector />);
    // Anchor: confirm the nested loop's inspector actually rendered (else the
    // empty-state aside would make the negative assertion pass vacuously).
    expect(screen.getByRole("heading", { name: "반복(loop)" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /반복 본문에 조건 추가/i }),
    ).not.toBeInTheDocument();
  });

  it("does NOT offer '+ Add loop' on a nested if's branches (symmetric depth gate, 9c)", async () => {
    // loop { do: [ if ] }  — select the nested if; its branches must not offer '+ Add loop'
    const loopId = useScenarioEditor.getState().addLoopStep("Loop 1")!;
    const nestedIfId = useScenarioEditor.getState().addIfInLoop(loopId, "inner");
    useScenarioEditor.getState().select(nestedIfId);
    render(<Inspector />);
    expect(screen.getByRole("heading", { name: "조건(if)" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /반복 추가/i })).not.toBeInTheDocument();
  });
});

// Regression: the inspector lives in a narrow ~300px column. Flex rows whose
// `flex-1` inputs keep the default `min-width:auto` push the Request fieldset
// wider than its column, so it visibly bleeds past the panel border (measured
// scrollWidth 332 > clientWidth 294). The fix is `min-w-0` on the inputs and
// `shrink-0` on the trailing buttons so the row can shrink to its column.
describe("Inspector — narrow-column overflow guard (#1)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useScenarioEditor.setState(useScenarioEditor.getInitialState());
  });

  it("keeps Headers row inputs/buttons shrinkable so the Request fieldset can't overflow", async () => {
    const user = userEvent.setup();
    loadAndSelect();
    render(<Inspector />);
    await user.click(screen.getByRole("button", { name: ko.editor.headersLabel }));

    // The Headers InspectorSection fieldset is a flex item in the narrow aside; min-w-0 lets it shrink.
    expect(screen.getByPlaceholderText("헤더 이름").closest("fieldset")).toHaveClass("min-w-0");

    // Two-field add row. The key input is now wrapped in its own width-authority
    // <div className="w-32 min-w-0"> (Input migration, R4③) — closest("div") alone
    // would stop at that wrapper, so scope to the outer flex row (class "flex").
    const addKey = screen.getByPlaceholderText("헤더 이름");
    expect(addKey).toHaveClass("min-w-0");
    const addBtn = within(addKey.closest("div.flex")!).getByRole("button", { name: "추가" });
    expect(addBtn).toHaveClass("shrink-0");

    // Add a non-common header (avoids datalist value-seeding) so a value row renders.
    await user.type(addKey, "X-Custom");
    await user.click(addBtn);
    const removeBtn = screen.getByRole("button", { name: "header X-Custom 제거" });
    const row = removeBtn.closest("li")!;
    // key input has list attr → role="combobox"; value input → role="textbox"
    const inputs = [
      ...within(row).getAllByRole("combobox"),
      ...within(row).getAllByRole("textbox"),
    ];
    expect(inputs).toHaveLength(2); // key + value
    inputs.forEach((i) => expect(i).toHaveClass("min-w-0"));
    expect(removeBtn).toHaveClass("shrink-0");
  });

  it("keeps form-body row inputs/buttons shrinkable too", async () => {
    const user = userEvent.setup();
    loadAndSelect();
    render(<Inspector />);
    await user.click(screen.getByRole("button", { name: ko.editor.bodyLabel }));

    await user.selectOptions(screen.getByDisplayValue("없음"), "form");
    const addField = screen.getByPlaceholderText("field");
    expect(addField).toHaveClass("min-w-0");
    // Same wrapper-div nuance as the Headers row above — scope to the outer flex row.
    expect(within(addField.closest("div.flex")!).getByRole("button", { name: "추가" })).toHaveClass(
      "shrink-0",
    );
  });
});

describe("Inspector — JSON body Format", () => {
  beforeEach(() => {
    window.localStorage.clear();
    loadAndSelect();
  });

  it("reformats minified JSON to 2-space indent on Format", async () => {
    const user = userEvent.setup();
    render(<Inspector />);
    await user.click(screen.getByRole("button", { name: ko.editor.bodyLabel }));
    await user.selectOptions(screen.getByDisplayValue("없음"), "json");
    const ta = screen.getByLabelText("JSON 본문") as HTMLTextAreaElement;
    // fireEvent (not userEvent.type) to avoid '{' key-descriptor parsing.
    fireEvent.change(ta, { target: { value: '{"a":1,"b":{"c":2}}' } });
    await user.click(screen.getByRole("button", { name: "포맷" }));
    expect(ta.value).toBe('{\n  "a": 1,\n  "b": {\n    "c": 2\n  }\n}');
  });

  it("persists the parsed value on Format (writes it to the YAML)", async () => {
    const user = userEvent.setup();
    render(<Inspector />);
    await user.click(screen.getByRole("button", { name: ko.editor.bodyLabel }));
    await user.selectOptions(screen.getByDisplayValue("없음"), "json");
    fireEvent.change(screen.getByLabelText("JSON 본문"), { target: { value: '{"a":1}' } });
    await user.click(screen.getByRole("button", { name: "포맷" }));
    expect(useScenarioEditor.getState().yamlText).toMatch(/a:\s*1/);
  });

  it("shows an error and leaves text unchanged on invalid JSON", async () => {
    const user = userEvent.setup();
    render(<Inspector />);
    await user.click(screen.getByRole("button", { name: ko.editor.bodyLabel }));
    await user.selectOptions(screen.getByDisplayValue("없음"), "json");
    const ta = screen.getByLabelText("JSON 본문") as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "{not json}" } });
    await user.click(screen.getByRole("button", { name: "포맷" }));
    expect(ta.value).toBe("{not json}");
    expect(screen.getByText(/JSON:/)).toBeInTheDocument();
  });
});

describe("Inspector — renameEpoch live reseed (#5)", () => {
  const STEP_ID = "01HX0000000000000000000001";
  const YAML_WITH_TOK = `version: 1
name: "demo"
cookie_jar: auto
variables: {}
steps:
  - id: "${STEP_ID}"
    name: "login"
    type: http
    request:
      method: GET
      url: "/x"
      headers:
        Authorization: "{{tok}}"
      body:
        json: { k: "{{tok}}" }
    extract:
      - from: status
        var: tok
`;

  beforeEach(() => {
    window.localStorage.clear();
    useScenarioEditor.setState(useScenarioEditor.getInitialState());
    useScenarioEditor.getState().loadFromString(YAML_WITH_TOK);
    useScenarioEditor.getState().select(STEP_ID);
  });

  it("re-seeds header/JSON-body/extract drafts live when a used variable is renamed", async () => {
    const user = userEvent.setup();
    render(<Inspector />);

    // 세 섹션 모두 기본 접힘 — 펼친다 (editor-space-qol 함정).
    await user.click(screen.getByRole("button", { name: ko.editor.headersLabel }));
    await user.click(screen.getByRole("button", { name: ko.editor.bodyLabel }));
    await user.click(screen.getByRole("button", { name: ko.editor.extractsLegend }));

    expect((screen.getByLabelText(/header value 0/i) as HTMLInputElement).value).toContain(
      "{{tok}}",
    );
    expect((screen.getByLabelText("JSON 본문") as HTMLTextAreaElement).value).toContain("{{tok}}");
    const extractSection = screen.getByRole("group", { name: ko.editor.extractsLegend });
    expect((within(extractSection).getByPlaceholderText("var") as HTMLInputElement).value).toBe(
      "tok",
    );

    act(() => {
      useScenarioEditor.getState().renameVariable("tok", "renamed");
    });

    // 재선택 없이 세 표면이 {{renamed}}/renamed로 갱신
    expect((screen.getByLabelText(/header value 0/i) as HTMLInputElement).value).toContain(
      "{{renamed}}",
    );
    expect((screen.getByLabelText("JSON 본문") as HTMLTextAreaElement).value).toContain(
      "{{renamed}}",
    );
    const extractSectionAfter = screen.getByRole("group", { name: ko.editor.extractsLegend });
    expect(
      (within(extractSectionAfter).getByPlaceholderText("var") as HTMLInputElement).value,
    ).toBe("renamed");
  });
});

describe("Inspector — U3 Korean labels", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useScenarioEditor.setState(useScenarioEditor.getInitialState());
    useScenarioEditor.getState().resetEmpty();
  });

  it("U3: panel is labeled 스텝 설정 with Korean section titles", async () => {
    const user = userEvent.setup();
    const id = useScenarioEditor.getState().addStep("S1");
    useScenarioEditor.getState().select(id);
    render(<Inspector />);
    expect(screen.getByRole("complementary", { name: "스텝 설정" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "HTTP 스텝" })).toBeInTheDocument();
    expect(screen.getByText("응답 검증")).toBeInTheDocument();
    // extracts 부연(힌트 문구)은 값 추출 섹션을 펼쳐야 렌더된다 (R1 기본 접힘)
    await user.click(screen.getByRole("button", { name: ko.editor.extractsLegend }));
    expect(screen.getByText(/응답에서 값을 꺼내/)).toBeInTheDocument(); // extracts 부연
  });
});

describe("Inspector — disabled header toggle", () => {
  const HEADER_YAML = `version: 1
name: "demo"
cookie_jar: auto
variables: {}
steps:
  - id: "01HX0000000000000000000001"
    name: "login"
    type: http
    request:
      method: POST
      url: "/login"
      headers:
        A: "1"
    assert:
      - status: 200
`;

  beforeEach(() => {
    window.localStorage.clear();
    useScenarioEditor.setState(useScenarioEditor.getInitialState());
    useScenarioEditor.getState().loadFromString(HEADER_YAML);
    useScenarioEditor.getState().select("01HX0000000000000000000001");
  });

  it("disabling a header moves it under request.disabled.headers in the YAML", async () => {
    const user = userEvent.setup();
    render(<Inspector />);
    await user.click(screen.getByRole("button", { name: ko.editor.headersLabel }));
    await user.click(screen.getByLabelText("header enabled 0")); // uncheck → disable
    const yaml = useScenarioEditor.getState().yamlText;
    const out = parseScenarioDoc(yaml);
    if (!("model" in out)) throw new Error(out.error);
    const step = out.model.steps[0];
    if (step.type !== "http") throw new Error("expected http");
    expect(step.request.headers).toEqual({});
    expect(step.request.disabled?.headers).toEqual({ A: "1" });
  });
});

describe("Inspector — timeout_seconds", () => {
  beforeEach(() => {
    window.localStorage.clear();
    loadAndSelect();
  });

  it("edits per-step timeout_seconds via setStepField (commits on blur)", async () => {
    const user = userEvent.setup();
    render(<Inspector />);
    await user.click(screen.getByRole("button", { name: ko.editor.sectionTiming }));

    const input = screen.getByLabelText(/타임아웃 \(초\)/i) as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "12");
    // F5 pattern: model not updated until blur
    fireEvent.blur(input);

    const step = useScenarioEditor.getState().model!.steps[0];
    expect(step.type).toBe("http");
    if (step.type === "http") {
      expect(step.timeout_seconds).toBe(12);
    }
  });

  it("clears timeout_seconds (sets undefined) when input is emptied and blurred", async () => {
    const user = userEvent.setup();
    // First set a value
    useScenarioEditor
      .getState()
      .setStepField("01HX0000000000000000000001", ["timeout_seconds"], 30);
    render(<Inspector />);
    await user.click(screen.getByRole("button", { name: ko.editor.sectionTiming }));

    const input = screen.getByLabelText(/타임아웃 \(초\)/i) as HTMLInputElement;
    await user.clear(input);
    // F5 pattern: commit on blur, not on change
    fireEvent.blur(input);

    const step = useScenarioEditor.getState().model!.steps[0];
    expect(step.type).toBe("http");
    if (step.type === "http") {
      expect(step.timeout_seconds).toBeUndefined();
    }
    expect(input.value).toBe("");
  });

  it("does NOT write NaN or out-of-range values on blur (reverts to last committed)", async () => {
    const user = userEvent.setup();
    // Seed a known-good value first
    useScenarioEditor
      .getState()
      .setStepField("01HX0000000000000000000001", ["timeout_seconds"], 30);
    render(<Inspector />);
    await user.click(screen.getByRole("button", { name: ko.editor.sectionTiming }));

    const input = screen.getByLabelText(/타임아웃 \(초\)/i) as HTMLInputElement;
    // Type an out-of-range value (700 > max 600) then blur
    await user.clear(input);
    await user.type(input, "700");
    fireEvent.blur(input);

    const step = useScenarioEditor.getState().model!.steps[0];
    expect(step.type).toBe("http");
    if (step.type === "http") {
      // Must revert to prior committed value, not write 700 or NaN
      expect(step.timeout_seconds).toBe(30);
      expect(step.timeout_seconds).not.toBeNaN();
    }
    // Draft input must also revert to the last committed value
    expect(input.value).toBe("30");
  });
});

describe("Inspector — think_time (S-B)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    loadAndSelect();
  });

  it("commits per-step think_time on blur", async () => {
    const user = userEvent.setup();
    render(<Inspector />);
    await user.click(screen.getByRole("button", { name: ko.editor.sectionTiming }));

    const minInput = screen.getByLabelText(/think 최솟값/i) as HTMLInputElement;
    const maxInput = screen.getByLabelText(/think 최댓값/i) as HTMLInputElement;
    await user.clear(minInput);
    await user.type(minInput, "100");
    await user.clear(maxInput);
    await user.type(maxInput, "300");
    // F5 pattern: model not updated until blur
    fireEvent.blur(maxInput);

    const step = useScenarioEditor.getState().model!.steps[0];
    expect(step.type).toBe("http");
    if (step.type === "http") {
      expect(step.think_time).toEqual({ min_ms: 100, max_ms: 300 });
    }
  });

  it("clears think_time (undefined) when both inputs emptied and blurred", async () => {
    const user = userEvent.setup();
    useScenarioEditor.getState().setStepField("01HX0000000000000000000001", ["think_time"], {
      min_ms: 100,
      max_ms: 300,
    });
    render(<Inspector />);
    await user.click(screen.getByRole("button", { name: ko.editor.sectionTiming }));

    const minInput = screen.getByLabelText(/think 최솟값/i) as HTMLInputElement;
    const maxInput = screen.getByLabelText(/think 최댓값/i) as HTMLInputElement;
    await user.clear(minInput);
    await user.clear(maxInput);
    // F5 pattern: commit on blur, not on change
    fireEvent.blur(maxInput);

    const step = useScenarioEditor.getState().model!.steps[0];
    expect(step.type).toBe("http");
    if (step.type === "http") {
      expect(step.think_time).toBeUndefined();
    }
    expect(minInput.value).toBe("");
    expect(maxInput.value).toBe("");
  });

  it("does not write think_time when only one of min/max is filled (incomplete pair)", async () => {
    const user = userEvent.setup();
    render(<Inspector />);
    await user.click(screen.getByRole("button", { name: ko.editor.sectionTiming }));

    const minInput = screen.getByLabelText(/think 최솟값/i) as HTMLInputElement;
    await user.clear(minInput);
    await user.type(minInput, "100");
    // Blur with max still empty = incomplete pair (focus leaving mid-entry).
    fireEvent.blur(minInput);

    const step = useScenarioEditor.getState().model!.steps[0];
    expect(step.type).toBe("http");
    if (step.type === "http") {
      // No write: an incomplete pair must not coerce "" → 0 or clobber.
      expect(step.think_time).toBeUndefined();
    }
    // Draft preserved so the user can finish typing the other field.
    expect(minInput.value).toBe("100");
  });

  it("reverts and does not write when both filled but invalid (max < min)", async () => {
    const user = userEvent.setup();
    // Pre-seed a known-good value first.
    useScenarioEditor.getState().setStepField("01HX0000000000000000000001", ["think_time"], {
      min_ms: 100,
      max_ms: 300,
    });
    render(<Inspector />);
    await user.click(screen.getByRole("button", { name: ko.editor.sectionTiming }));

    const minInput = screen.getByLabelText(/think 최솟값/i) as HTMLInputElement;
    const maxInput = screen.getByLabelText(/think 최댓값/i) as HTMLInputElement;
    // Set both drafts directly (no intermediate blur) so the single commit sees
    // an invalid pair (max < min), not a transient valid one.
    fireEvent.change(minInput, { target: { value: "200" } });
    fireEvent.change(maxInput, { target: { value: "50" } }); // max < min → invalid
    fireEvent.blur(maxInput);

    const step = useScenarioEditor.getState().model!.steps[0];
    expect(step.type).toBe("http");
    if (step.type === "http") {
      // Must keep the prior committed value, not write the invalid pair.
      expect(step.think_time).toEqual({ min_ms: 100, max_ms: 300 });
    }
    // Drafts revert to the last committed value.
    expect(minInput.value).toBe("100");
    expect(maxInput.value).toBe("300");
  });
});

describe("Inspector — ParallelInspector (P-b Task 8)", () => {
  function loadParallelAndSelect() {
    useScenarioEditor.setState(useScenarioEditor.getInitialState());
    useScenarioEditor.getState().resetEmpty();
    const pid = useScenarioEditor.getState().addParallelStep("Fan-out")!;
    // Rename the two default branches to recognizable names for assertions
    useScenarioEditor.getState().setBranchName(pid, 0, "user");
    useScenarioEditor.getState().setBranchName(pid, 1, "feed");
    useScenarioEditor.getState().select(pid);
    return pid;
  }

  beforeEach(() => {
    window.localStorage.clear();
    useScenarioEditor.setState(useScenarioEditor.getInitialState());
  });

  it("renders branch name inputs with current names (user / feed)", () => {
    const pid = loadParallelAndSelect();
    render(<Inspector />);
    // Should have two inputs labeled with the branch names
    const inputs = screen.getAllByRole("textbox") as HTMLInputElement[];
    const values = inputs.map((i) => i.value);
    expect(values).toContain("user");
    expect(values).toContain("feed");
    // Sanity: parallel step exists
    const step = useScenarioEditor.getState().model!.steps.find((s) => s.id === pid)!;
    expect(step.type).toBe("parallel");
  });

  it("+ Add branch appends a new branch to the parallel step", async () => {
    const user = userEvent.setup();
    const pid = loadParallelAndSelect();
    render(<Inspector />);

    const stepBefore = useScenarioEditor.getState().model!.steps.find((s) => s.id === pid)!;
    if (stepBefore.type !== "parallel") throw new Error("expected parallel");
    expect(stepBefore.branches).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: /분기 추가/i }));

    const stepAfter = useScenarioEditor.getState().model!.steps.find((s) => s.id === pid)!;
    if (stepAfter.type !== "parallel") throw new Error("expected parallel");
    expect(stepAfter.branches).toHaveLength(3);
  });

  it("editing a branch name (type + blur) commits via setBranchName", async () => {
    const user = userEvent.setup();
    const pid = loadParallelAndSelect();
    render(<Inspector />);

    // Find the 'user' name input and rename it
    const inputs = screen.getAllByRole("textbox") as HTMLInputElement[];
    const userInput = inputs.find((i) => i.value === "user")!;
    await user.clear(userInput);
    await user.type(userInput, "auth");
    // Blur to commit (F5 onBlur-commit pattern)
    await user.tab();

    const step = useScenarioEditor.getState().model!.steps.find((s) => s.id === pid)!;
    if (step.type !== "parallel") throw new Error("expected parallel");
    const names = step.branches.map((b) => b.name);
    expect(names).toContain("auth");
    expect(names).not.toContain("user");
  });

  it("shows a duplicate-name warning when two branches have the same name", async () => {
    const user = userEvent.setup();
    loadParallelAndSelect();
    render(<Inspector />);

    // Set both branch names to the same value
    const inputs = screen.getAllByRole("textbox") as HTMLInputElement[];
    const feedInput = inputs.find((i) => i.value === "feed")!;
    await user.clear(feedInput);
    await user.type(feedInput, "user"); // now both branches are named "user"
    await user.tab(); // commit

    // Duplicate warning should appear
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("alert").textContent).toMatch(/중복/);
  });

  it("+ Add step in branch adds an http step to that branch", async () => {
    const user = userEvent.setup();
    const pid = loadParallelAndSelect();
    render(<Inspector />);

    const step = useScenarioEditor.getState().model!.steps.find((s) => s.id === pid)!;
    if (step.type !== "parallel") throw new Error("expected parallel");
    const beforeLen = step.branches[0].steps.length;

    // Click the first "+ Add step in branch" button
    const addStepBtns = screen.getAllByRole("button", { name: /분기.*에 스텝 추가/i });
    await user.click(addStepBtns[0]);

    const after = useScenarioEditor.getState().model!.steps.find((s) => s.id === pid)!;
    if (after.type !== "parallel") throw new Error("expected parallel");
    expect(after.branches[0].steps.length).toBe(beforeLen + 1);
  });

  it("remove branch button is absent when only 1 branch remains", () => {
    useScenarioEditor.setState(useScenarioEditor.getInitialState());
    useScenarioEditor.getState().resetEmpty();
    const pid = useScenarioEditor.getState().addParallelStep("Solo")!;
    // Remove one branch so only 1 remains
    useScenarioEditor.getState().removeBranch(pid, 1);
    useScenarioEditor.getState().select(pid);
    render(<Inspector />);

    const step = useScenarioEditor.getState().model!.steps.find((s) => s.id === pid)!;
    if (step.type !== "parallel") throw new Error("expected parallel");
    expect(step.branches).toHaveLength(1);

    // With only 1 branch, the remove button must NOT be present
    expect(screen.queryByRole("button", { name: /분기.*제거/i })).not.toBeInTheDocument();
  });

  it("with 2 branches, removing one reduces to 1 and then remove button disappears", async () => {
    const user = userEvent.setup();
    const pid = loadParallelAndSelect();
    render(<Inspector />);

    // With 2 branches, remove buttons should be visible
    const removeBtns = screen.getAllByRole("button", { name: /분기.*제거/i });
    expect(removeBtns.length).toBe(2);

    await user.click(removeBtns[0]);

    const after = useScenarioEditor.getState().model!.steps.find((s) => s.id === pid)!;
    if (after.type !== "parallel") throw new Error("expected parallel");
    expect(after.branches).toHaveLength(1);

    // After removing to 1, no more remove buttons
    expect(screen.queryByRole("button", { name: /분기.*제거/i })).not.toBeInTheDocument();
  });
});

describe("Inspector — setKind orphan-drop (spec §7)", () => {
  const FORM_DISABLED_YAML = `version: 1
name: "demo"
cookie_jar: auto
variables: {}
steps:
  - id: "01HX0000000000000000000001"
    name: "submit"
    type: http
    request:
      method: POST
      url: "/submit"
      headers:
        A: "1"
      body:
        form:
          keep: "1"
      disabled:
        form:
          skip: "2"
        headers:
          X-Off: "h"
    assert:
      - status: 200
`;

  beforeEach(() => {
    window.localStorage.clear();
    useScenarioEditor.setState(useScenarioEditor.getInitialState());
    useScenarioEditor.getState().loadFromString(FORM_DISABLED_YAML);
    useScenarioEditor.getState().select("01HX0000000000000000000001");
  });

  it("switching body kind away from 'form' drops disabled.form but preserves disabled.headers", async () => {
    const user = userEvent.setup();
    render(<Inspector />);
    await user.click(screen.getByRole("button", { name: ko.editor.bodyLabel }));

    // The body-kind selector shows "폼" (current body kind).
    const kindSelect = screen.getByDisplayValue("폼");
    await user.selectOptions(kindSelect, "json");

    const yaml = useScenarioEditor.getState().yamlText;
    const out = parseScenarioDoc(yaml);
    if (!("model" in out)) throw new Error(out.error);
    const step = out.model.steps[0];
    if (step.type !== "http") throw new Error("expected http");

    // Orphan disabled.form must be dropped when the body kind leaves "form".
    expect(step.request.disabled?.form).toBeUndefined();
    // disabled.headers is body-kind-independent and must survive the kind switch.
    expect(step.request.disabled?.headers).toEqual({ "X-Off": "h" });
  });
});

describe("Inspector — U3 VarCheatSheet in Request fieldset", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useScenarioEditor.setState(useScenarioEditor.getInitialState());
    useScenarioEditor.getState().resetEmpty();
  });

  it("U3: Request 섹션에도 변수 표기 치트시트가 붙는다", async () => {
    const user = userEvent.setup();
    const id = useScenarioEditor.getState().addStep("S1");
    useScenarioEditor.getState().select(id);
    render(<Inspector />);
    await user.click(screen.getByRole("button", { name: "변수 표기 도움말" }));
    expect(screen.getByRole("note")).toHaveTextContent("환경 변수");
  });
});

describe("Inspector — assertion row status field label (ko-first)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    loadAndSelect();
  });

  it("assertion row renders the status field label from ko.editor.assertStatusField", async () => {
    const user = userEvent.setup();
    render(<Inspector />);
    await user.click(screen.getByRole("button", { name: ko.editor.assertionsLegend }));
    // VALID_YAML has `assert: - status: 200`, so an assertion row is visible.
    // The badge should show the localized 상태 label, not the bare English "status".
    expect(screen.getByText(ko.editor.assertStatusField)).toBeInTheDocument();
  });
});

describe("Inspector — URL input adopts primitive Input (design-system-editor)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    loadAndSelect();
  });

  it("URL input uses primitive Input with accent focus-ring class", () => {
    render(<Inspector />);
    const url = screen.getByLabelText(/URL/);
    expect(url).toHaveClass("focus:ring-accent-500/30"); // Input BASE — RED before migration
    expect(url).toHaveClass("font-mono"); // mono preserved
    expect(url).toHaveClass("text-xs"); // size="sm" density preserved
  });
});

describe("Inspector URL required marker (U3)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useScenarioEditor.setState(useScenarioEditor.getInitialState());
    useScenarioEditor.getState().resetEmpty();
  });

  it("clearing the URL commits an empty url to the model and shows the inline warning", async () => {
    const user = userEvent.setup();
    const id = useScenarioEditor.getState().addStep("S1");
    useScenarioEditor.getState().select(id);
    render(<Inspector />);
    const url = screen.getByLabelText(/URL/);
    await user.clear(url);
    // 완화 전에는 reparse가 실패해 model이 stale로 남았다(yamlError만 세팅).
    const state = useScenarioEditor.getState();
    expect(state.yamlError).toBeNull();
    expect(state.yamlText).toContain('url: ""');
    expect(screen.getByRole("alert")).toHaveTextContent("URL을 입력하세요");
    expect(url).toHaveAttribute("placeholder", expect.stringContaining("api.example.com"));
  });

  it("non-empty URL shows no warning", () => {
    const id = useScenarioEditor.getState().addStep("S1");
    useScenarioEditor.getState().select(id);
    render(<Inspector />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("Inspector — JSON 바디 캐스트 HelpTip (R7)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    loadAndSelect();
  });

  it("shows the cast HelpTip only when body kind is JSON", async () => {
    const user = userEvent.setup();
    render(<Inspector />);
    await user.click(screen.getByRole("button", { name: ko.editor.bodyLabel }));
    // 본문 종류 = JSON 선택 (기본은 "없음")
    await user.selectOptions(screen.getByDisplayValue(ko.editor.bodyNone), ko.editor.bodyJson);
    // ⓘ 버튼(aria-label = ko.editor.jsonCastLabel) → 클릭 시 popover 본문 노출
    const tip = screen.getByRole("button", { name: ko.editor.jsonCastLabel });
    expect(tip).toBeInTheDocument();
    await user.click(tip);
    expect(screen.getByText(ko.glossary.jsonCastIntro)).toBeInTheDocument();
  });

  it("does NOT show the cast HelpTip for form body", async () => {
    const user = userEvent.setup();
    render(<Inspector />);
    await user.click(screen.getByRole("button", { name: ko.editor.bodyLabel }));
    await user.selectOptions(screen.getByDisplayValue(ko.editor.bodyNone), ko.editor.bodyForm);
    expect(screen.queryByRole("button", { name: ko.editor.jsonCastLabel })).not.toBeInTheDocument();
  });
});

describe("Inspector — assert existing-row density (design-system-editor Task2 fold-in)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    loadAndSelect();
  });

  it("existing-row assert code input inherits text-xs density, not primitive default text-sm", async () => {
    const user = userEvent.setup();
    render(<Inspector />);
    await user.click(screen.getByRole("button", { name: ko.editor.assertionsLegend }));
    const assertSection = screen.getByRole("group", { name: ko.editor.assertionsLegend });
    // Existing-row input has no placeholder; the new-row sibling has placeholder="200".
    const inputs = within(assertSection).getAllByRole("spinbutton") as HTMLInputElement[];
    const existingRow = inputs.find((i) => i.placeholder !== "200")!;
    expect(existingRow).toHaveClass("text-xs");
    expect(existingRow).not.toHaveClass("text-sm");
  });
});

describe("StepNameField — 이름 blur-Untitled (R12/R13)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    loadAndSelect();
  });

  it("이름을 전부 지워도 타이핑 중 Untitled로 스냅되지 않는다 — draft는 빈 채 유지, store는 직전 이름", async () => {
    const user = userEvent.setup();
    render(<Inspector />);
    const input = screen.getByLabelText(ko.editor.fieldName);
    await user.clear(input);
    expect(input).toHaveValue(""); // 기존 구현은 여기서 "Untitled"로 스냅됨 → RED
    expect(useScenarioEditor.getState().model?.steps[0]?.name).toBe("login"); // 빈 값 미커밋 (R13)
  });

  it("빈 이름으로 blur하면 Untitled가 커밋된다", async () => {
    const user = userEvent.setup();
    render(<Inspector />);
    const input = screen.getByLabelText(ko.editor.fieldName);
    await user.clear(input);
    await user.tab(); // blur
    expect(input).toHaveValue("Untitled");
    expect(useScenarioEditor.getState().model?.steps[0]?.name).toBe("Untitled");
  });

  it("비-빈 타이핑은 즉시 커밋된다 (아웃라인 라이브 갱신 유지)", async () => {
    const user = userEvent.setup();
    render(<Inspector />);
    const input = screen.getByLabelText(ko.editor.fieldName);
    await user.clear(input);
    await user.type(input, "로그인");
    expect(useScenarioEditor.getState().model?.steps[0]?.name).toBe("로그인");
  });
});
