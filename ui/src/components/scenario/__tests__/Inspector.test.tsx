import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { Inspector } from "../Inspector";
import { useScenarioEditor } from "../../../scenario/store";
import { parseScenarioDoc } from "../../../scenario/yamlDoc";

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
    useScenarioEditor.setState(useScenarioEditor.getInitialState());
  });

  it("shows placeholder when no step is selected", () => {
    useScenarioEditor.getState().loadFromString(VALID_YAML);
    render(<Inspector />);
    expect(screen.getByText(/Select a step/i)).toBeInTheDocument();
  });
});

describe("Inspector — ExtractEditor", () => {
  beforeEach(() => loadAndSelect());

  it("adds a body extract row and writes it to the YAML", async () => {
    const user = userEvent.setup();
    render(<Inspector />);

    const extractSection = screen.getByRole("group", { name: /Extracts?/i });
    const addBtn = within(extractSection).getByRole("button", { name: /Add/i });
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

    const extractSection = screen.getByRole("group", { name: /Extracts?/i });
    await user.click(within(extractSection).getByRole("button", { name: /Add/i }));

    const fromSelect = within(extractSection).getByLabelText("extract-from-0");
    await user.selectOptions(fromSelect, "header");

    expect(within(extractSection).queryByPlaceholderText("$.path")).toBeNull();
    expect(within(extractSection).getByPlaceholderText("header name")).toBeInTheDocument();
  });

  it("removes a row when its delete button is clicked", async () => {
    const user = userEvent.setup();
    render(<Inspector />);
    const extractSection = screen.getByRole("group", { name: /Extracts?/i });

    await user.click(within(extractSection).getByRole("button", { name: /Add/i }));
    await user.type(within(extractSection).getByPlaceholderText("var"), "t");
    await user.type(within(extractSection).getByPlaceholderText("$.path"), "$.x");
    await user.tab();

    expect(useScenarioEditor.getState().yamlText).toMatch(/extract:/);

    const removeBtn = within(extractSection).getByRole("button", {
      name: /Remove extract 0/i,
    });
    await user.click(removeBtn);

    expect(useScenarioEditor.getState().yamlText).not.toMatch(/extract:/);
  });

  it("does not write to yamlText on every keystroke (commit-on-blur)", async () => {
    const user = userEvent.setup();
    render(<Inspector />);

    const extractSection = screen.getByRole("group", { name: /Extracts?/i });
    await user.click(within(extractSection).getByRole("button", { name: /Add/i }));

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

    // Bootstrap: add one complete row.
    const extractSection = screen.getByRole("group", { name: /Extracts?/i });
    await user.click(within(extractSection).getByRole("button", { name: /Add/i }));
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
    useScenarioEditor.setState(useScenarioEditor.getInitialState());
    useScenarioEditor.getState().resetEmpty();
  });

  it("shows a repeat field when a loop is selected and updates the model", async () => {
    const user = userEvent.setup();
    const loopId = useScenarioEditor.getState().addLoopStep("Loop A");
    useScenarioEditor.getState().select(loopId);
    render(<Inspector />);

    const repeat = screen.getByLabelText(/repeat/i) as HTMLInputElement;
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
    expect(screen.getByTitle("Move down")).toBeDisabled();
    const up = screen.getByTitle("Move up");
    expect(up).not.toBeDisabled();

    await user.click(up);

    const ids = useScenarioEditor.getState().model!.steps.map((s) => s.id);
    expect(ids).toEqual([loopId, httpId]);
    // Now first → Move up disabled.
    expect(screen.getByTitle("Move up")).toBeDisabled();
  });

  it("reorders a top-level if among its siblings via Move down", async () => {
    const user = userEvent.setup();
    const ifId = useScenarioEditor.getState().addIfStep("Branch");
    const httpId = useScenarioEditor.getState().addStep("Last");
    useScenarioEditor.getState().select(ifId);
    render(<Inspector />);

    // If is first of two → Move up disabled, Move down enabled.
    expect(screen.getByTitle("Move up")).toBeDisabled();
    const down = screen.getByTitle("Move down");
    expect(down).not.toBeDisabled();

    await user.click(down);

    const ids = useScenarioEditor.getState().model!.steps.map((s) => s.id);
    expect(ids).toEqual([httpId, ifId]);
  });
});

describe("Inspector — if route", () => {
  beforeEach(() => {
    useScenarioEditor.setState(useScenarioEditor.getInitialState());
    useScenarioEditor.getState().loadFromString(IF_YAML);
    useScenarioEditor.getState().select("01HX0000000000000000000010");
  });

  it("shows the If heading and the branch name", () => {
    render(<Inspector />);
    expect(screen.getByRole("heading", { name: "If" })).toBeInTheDocument();
    expect((screen.getByLabelText("Name") as HTMLInputElement) ?? null).toBeTruthy();
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
    useScenarioEditor.setState(useScenarioEditor.getInitialState());
    useScenarioEditor.getState().loadFromString(IF_YAML);
    useScenarioEditor.getState().select("01HX0000000000000000000010");
  });

  it("renders the condition leaf with current values", () => {
    render(<Inspector />);
    expect((screen.getByLabelText("left") as HTMLInputElement).value).toBe("{{code}}");
    expect((screen.getByLabelText("op") as HTMLSelectElement).value).toBe("eq");
    expect((screen.getByLabelText("right") as HTMLInputElement).value).toBe("200");
  });

  it("commits a changed right value on blur", async () => {
    const user = userEvent.setup();
    render(<Inspector />);
    const right = screen.getByLabelText("right");
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
    await user.selectOptions(screen.getByLabelText("op"), "exists");
    expect(screen.queryByLabelText("right")).toBeNull();
    const s = useScenarioEditor.getState().model!.steps[0];
    if (s.type === "if" && !("all" in s.cond) && !("any" in s.cond)) {
      expect(s.cond.op).toBe("exists");
      expect(s.cond.right).toBeUndefined();
    } else throw new Error("expected compare cond");
  });

  it("warns on an invalid regex for the matches op", async () => {
    const user = userEvent.setup();
    render(<Inspector />);
    await user.selectOptions(screen.getByLabelText("op"), "matches");
    const right = screen.getByLabelText("right");
    await user.clear(right);
    // user-event treats "[" as a key-descriptor delimiter; "[[" types a literal "[".
    await user.type(right, "[[");
    await user.tab();
    expect(screen.getByText(/invalid regex/i)).toBeInTheDocument();
  });

  it("wraps a leaf in a group and adds a condition", async () => {
    const user = userEvent.setup();
    render(<Inspector />);
    await user.click(screen.getByRole("button", { name: /wrap in group/i }));
    await user.click(screen.getByRole("button", { name: /\+ condition/i }));
    const s = useScenarioEditor.getState().model!.steps[0];
    if (s.type === "if" && "all" in s.cond) expect(s.cond.all).toHaveLength(2);
    else throw new Error("expected all group");
  });

  it("adds a step to the else branch", async () => {
    const user = userEvent.setup();
    render(<Inspector />);
    await user.click(screen.getByRole("button", { name: /add step to else/i }));
    const s = useScenarioEditor.getState().model!.steps[0];
    if (s.type === "if") expect(s.else).toHaveLength(1);
    else throw new Error("expected if step");
  });

  it("adds then removes an elif branch", async () => {
    const user = userEvent.setup();
    render(<Inspector />);
    await user.click(screen.getByRole("button", { name: /add elif/i }));
    let s = useScenarioEditor.getState().model!.steps[0];
    if (s.type === "if") expect(s.elif).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: /remove elif 1/i }));
    s = useScenarioEditor.getState().model!.steps[0];
    if (s.type === "if") expect(s.elif).toHaveLength(0);
  });

  it("cannot remove a group's last child (no empty group)", async () => {
    const user = userEvent.setup();
    render(<Inspector />);
    // Wrap the single leaf into a group → group now has exactly 1 child.
    await user.click(screen.getByRole("button", { name: /wrap in group/i }));
    // With one child, no remove-condition button is offered, so the group
    // cannot be emptied into a vacuous-true {all: []}.
    expect(screen.queryByRole("button", { name: /remove condition/i })).toBeNull();
    // Add a second condition → now removal is allowed again (2 children).
    await user.click(screen.getByRole("button", { name: /\+ condition/i }));
    expect(screen.getAllByRole("button", { name: /remove condition/i }).length).toBe(2);
    // Remove one → back to 1 child, group still non-empty, remove buttons gone.
    await user.click(screen.getAllByRole("button", { name: /remove condition/i })[0]);
    const s = useScenarioEditor.getState().model!.steps[0];
    if (s.type === "if" && "all" in s.cond) expect(s.cond.all).toHaveLength(1);
    else throw new Error("expected all group with one child");
    expect(screen.queryByRole("button", { name: /remove condition/i })).toBeNull();
  });
});

describe("Inspector — mutual nesting (9c)", () => {
  beforeEach(() => {
    useScenarioEditor.setState(useScenarioEditor.getInitialState());
    useScenarioEditor.getState().resetEmpty();
  });

  it("offers '+ Add if' on a top-level loop and nests it (9c)", async () => {
    const user = userEvent.setup();
    const loopId = useScenarioEditor.getState().addLoopStep("Loop 1");
    useScenarioEditor.getState().select(loopId);
    render(<Inspector />);
    await user.click(screen.getByRole("button", { name: /add if/i }));
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
    const addLoopButtons = screen.getAllByRole("button", { name: /add loop/i });
    await user.click(addLoopButtons[0]);
    const ifStep = useScenarioEditor.getState().model!.steps.find((s) => s.id === ifId);
    expect(ifStep?.type).toBe("if");
    if (ifStep?.type === "if") {
      expect(ifStep.then.some((c) => c.type === "loop")).toBe(true);
    }
  });

  it("does NOT offer nesting buttons on a nested container (depth gate, 9c)", async () => {
    // if { then: [ loop ] }  — select the nested loop; it must not offer '+ Add if'
    const ifId = useScenarioEditor.getState().addIfStep("If 1");
    const nestedLoopId = useScenarioEditor
      .getState()
      .addLoopInBranch(ifId, { kind: "then" }, "inner");
    useScenarioEditor.getState().select(nestedLoopId);
    render(<Inspector />);
    // Anchor: confirm the nested loop's inspector actually rendered (else the
    // empty-state aside would make the negative assertion pass vacuously).
    expect(screen.getByRole("heading", { name: "Loop" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /add if/i })).not.toBeInTheDocument();
  });

  it("does NOT offer '+ Add loop' on a nested if's branches (symmetric depth gate, 9c)", async () => {
    // loop { do: [ if ] }  — select the nested if; its branches must not offer '+ Add loop'
    const loopId = useScenarioEditor.getState().addLoopStep("Loop 1");
    const nestedIfId = useScenarioEditor.getState().addIfInLoop(loopId, "inner");
    useScenarioEditor.getState().select(nestedIfId);
    render(<Inspector />);
    expect(screen.getByRole("heading", { name: "If" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /add loop/i })).not.toBeInTheDocument();
  });
});

// Regression: the inspector lives in a narrow ~300px column. Flex rows whose
// `flex-1` inputs keep the default `min-width:auto` push the Request fieldset
// wider than its column, so it visibly bleeds past the panel border (measured
// scrollWidth 332 > clientWidth 294). The fix is `min-w-0` on the inputs and
// `shrink-0` on the trailing buttons so the row can shrink to its column.
describe("Inspector — narrow-column overflow guard (#1)", () => {
  beforeEach(() => {
    useScenarioEditor.setState(useScenarioEditor.getInitialState());
  });

  it("keeps Headers row inputs/buttons shrinkable so the Request fieldset can't overflow", async () => {
    const user = userEvent.setup();
    loadAndSelect();
    render(<Inspector />);

    // The Request fieldset is a flex item in the narrow aside; min-w-0 lets it shrink.
    expect(screen.getByPlaceholderText("Header").closest("fieldset")).toHaveClass("min-w-0");

    // Two-field add row.
    const addKey = screen.getByPlaceholderText("Header");
    expect(addKey).toHaveClass("min-w-0");
    const addBtn = within(addKey.closest("div")!).getByRole("button", { name: "Add" });
    expect(addBtn).toHaveClass("shrink-0");

    // Add a non-common header (avoids datalist value-seeding) so a value row renders.
    await user.type(addKey, "X-Custom");
    await user.click(addBtn);
    const removeBtn = screen.getByRole("button", { name: "Remove header X-Custom" });
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

    await user.selectOptions(screen.getByDisplayValue("none"), "form");
    const addField = screen.getByPlaceholderText("field");
    expect(addField).toHaveClass("min-w-0");
    expect(within(addField.closest("div")!).getByRole("button", { name: "Add" })).toHaveClass(
      "shrink-0",
    );
  });
});

describe("Inspector — JSON body Format", () => {
  beforeEach(() => loadAndSelect());

  it("reformats minified JSON to 2-space indent on Format", async () => {
    const user = userEvent.setup();
    render(<Inspector />);
    await user.selectOptions(screen.getByDisplayValue("none"), "json");
    const ta = screen.getByLabelText("json body") as HTMLTextAreaElement;
    // fireEvent (not userEvent.type) to avoid '{' key-descriptor parsing.
    fireEvent.change(ta, { target: { value: '{"a":1,"b":{"c":2}}' } });
    await user.click(screen.getByRole("button", { name: "Format" }));
    expect(ta.value).toBe('{\n  "a": 1,\n  "b": {\n    "c": 2\n  }\n}');
  });

  it("persists the parsed value on Format (writes it to the YAML)", async () => {
    const user = userEvent.setup();
    render(<Inspector />);
    await user.selectOptions(screen.getByDisplayValue("none"), "json");
    fireEvent.change(screen.getByLabelText("json body"), { target: { value: '{"a":1}' } });
    await user.click(screen.getByRole("button", { name: "Format" }));
    expect(useScenarioEditor.getState().yamlText).toMatch(/a:\s*1/);
  });

  it("shows an error and leaves text unchanged on invalid JSON", async () => {
    const user = userEvent.setup();
    render(<Inspector />);
    await user.selectOptions(screen.getByDisplayValue("none"), "json");
    const ta = screen.getByLabelText("json body") as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "{not json}" } });
    await user.click(screen.getByRole("button", { name: "Format" }));
    expect(ta.value).toBe("{not json}");
    expect(screen.getByText(/JSON:/)).toBeInTheDocument();
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
    useScenarioEditor.setState(useScenarioEditor.getInitialState());
    useScenarioEditor.getState().loadFromString(HEADER_YAML);
    useScenarioEditor.getState().select("01HX0000000000000000000001");
  });

  it("disabling a header moves it under request.disabled.headers in the YAML", async () => {
    const user = userEvent.setup();
    render(<Inspector />);
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
