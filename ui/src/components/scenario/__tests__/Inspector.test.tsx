import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { Inspector } from "../Inspector";
import { useScenarioEditor } from "../../../scenario/store";
import { parseScenarioDoc } from "../../../scenario/yamlDoc";
import { ko } from "../../../i18n/ko";
import { ScenarioModel } from "../../../scenario/model";

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

const DECODE_YAML = `version: 1
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
    extract:
      - var: uid
        from: header
        name: Authorization
        decode: jwt
        claim: $.sub
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
  function extractSectionOf() {
    return screen.getByRole("group", { name: "값 추출" });
  }

  async function addHeaderRow(user: ReturnType<typeof userEvent.setup>) {
    render(<Inspector />);
    await user.click(screen.getByRole("button", { name: ko.editor.extractsLegend }));
    const sec = extractSectionOf();
    await user.click(within(sec).getByRole("button", { name: /추가/i }));
    await user.type(within(sec).getByPlaceholderText("var"), "uid");
    await user.selectOptions(within(sec).getByLabelText(ko.editor.extractFromAria(0)), "header");
    await user.type(
      within(sec).getByPlaceholderText(ko.editor.headerNamePlaceholder),
      "Authorization",
    );
    await user.tab();
    return sec;
  }

  it("decode select writes decode and reveals claim; claim commits on blur (R9)", async () => {
    const user = userEvent.setup();
    const sec = await addHeaderRow(user);
    expect(within(sec).queryByLabelText(ko.editor.extractClaimAria(0))).toBeNull();

    await user.selectOptions(within(sec).getByLabelText(ko.editor.extractDecodeAria(0)), "jwt");
    expect(useScenarioEditor.getState().yamlText).toMatch(/decode:\s*jwt/);

    const claim = within(sec).getByLabelText(ko.editor.extractClaimAria(0));
    await user.type(claim, "$.sub");
    expect(useScenarioEditor.getState().yamlText).not.toMatch(/claim:/); // onBlur commit
    await user.tab();
    expect(useScenarioEditor.getState().yamlError).toBeNull();
    expect(useScenarioEditor.getState().yamlText).toMatch(/claim:\s*"?\$\.sub"?/);
  });

  it("choosing 없음 removes both decode and claim keys (R9/R11)", async () => {
    useScenarioEditor.getState().loadFromString(DECODE_YAML);
    useScenarioEditor.getState().select("01HX0000000000000000000001");
    const user = userEvent.setup();
    render(<Inspector />);
    await user.click(screen.getByRole("button", { name: ko.editor.extractsLegend }));
    const sec = extractSectionOf();
    expect(within(sec).getByLabelText(ko.editor.extractClaimAria(0))).toHaveValue("$.sub");

    await user.selectOptions(
      within(sec).getByLabelText(ko.editor.extractDecodeAria(0)),
      ko.editor.extractDecodeNone,
    );
    expect(useScenarioEditor.getState().yamlError).toBeNull();
    const yaml = useScenarioEditor.getState().yamlText;
    expect(yaml).not.toMatch(/decode:/);
    expect(yaml).not.toMatch(/claim:/);
    expect(yaml).toMatch(/name:\s*Authorization/);
  });

  it("switching to cookie keeps decode; status drops decode/claim (R9)", async () => {
    useScenarioEditor.getState().loadFromString(DECODE_YAML);
    useScenarioEditor.getState().select("01HX0000000000000000000001");
    const user = userEvent.setup();
    render(<Inspector />);
    await user.click(screen.getByRole("button", { name: ko.editor.extractsLegend }));
    const sec = extractSectionOf();
    const from = within(sec).getByLabelText(ko.editor.extractFromAria(0));

    await user.selectOptions(from, "cookie");
    expect(useScenarioEditor.getState().yamlError).toBeNull();
    const cookieYaml = useScenarioEditor.getState().yamlText;
    expect(cookieYaml).toMatch(/from:\s*cookie/);
    expect(cookieYaml).toMatch(/decode:\s*jwt/);
    expect(cookieYaml).toMatch(/claim:\s*"?\$\.sub"?/);

    await user.selectOptions(from, "status");
    expect(useScenarioEditor.getState().yamlError).toBeNull();
    const yaml = useScenarioEditor.getState().yamlText;
    expect(yaml).toMatch(/from:\s*status/);
    expect(yaml).not.toMatch(/decode:/);
    expect(yaml).not.toMatch(/claim:/);
    expect(within(sec).queryByLabelText(ko.editor.extractDecodeAria(0))).toBeNull();
  });

  it("empty claim is not written (R11)", async () => {
    const user = userEvent.setup();
    const sec = await addHeaderRow(user);
    await user.selectOptions(within(sec).getByLabelText(ko.editor.extractDecodeAria(0)), "base64");
    const claim = within(sec).getByLabelText(ko.editor.extractClaimAria(0));
    await user.type(claim, "x");
    await user.clear(claim); // draft claim === "" (not undefined) — the case R11 guards
    await user.tab();
    // A `claim: ""` write fails Zod .min(1) and dispatch only sets yamlError
    // (yamlText unchanged) — so this null check is what gives the test teeth.
    expect(useScenarioEditor.getState().yamlError).toBeNull();
    const yaml = useScenarioEditor.getState().yamlText;
    expect(yaml).toMatch(/decode:\s*base64/);
    expect(yaml).not.toMatch(/claim:/);
  });

  it("new decode controls are disabled while the YAML buffer is broken", async () => {
    useScenarioEditor.getState().loadFromString(DECODE_YAML);
    useScenarioEditor.getState().select("01HX0000000000000000000001");
    const user = userEvent.setup();
    render(<Inspector />);
    await user.click(screen.getByRole("button", { name: ko.editor.extractsLegend }));
    act(() => {
      useScenarioEditor.getState().setPendingYamlText("version: 1\nname: t\nsteps: [\n");
      useScenarioEditor.getState().commitPendingYaml();
    });
    const sec = extractSectionOf();
    expect(within(sec).getByLabelText(ko.editor.extractDecodeAria(0))).toBeDisabled();
    expect(within(sec).getByLabelText(ko.editor.extractClaimAria(0))).toBeDisabled();
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

// 조건 칸에 `{{ }}` 없이 변수명만 쓰면 엔진은 글자 그대로 비교한다 → 안내 + [수정].
const BARE_VAR_YAML = `version: 1
name: "demo"
cookie_jar: auto
variables:
  expected: "true"
steps:
  - id: "01HX0000000000000000000001"
    name: "get"
    type: http
    request:
      method: GET
      url: "/flag"
    extract:
      - var: flag
        from: body
        path: "$.ok"
  - id: "01HX0000000000000000000010"
    name: "branch"
    type: if
    cond:
      left: "flag"
      op: eq
      right: "true"
    then:
      - id: "01HX0000000000000000000011"
        name: "ok"
        type: http
        request:
          method: GET
          url: "/ok"
`;

function ifCond() {
  const s = useScenarioEditor.getState().model!.steps[1];
  if (s.type !== "if") throw new Error("expected if step");
  return s.cond;
}

describe("Inspector — 조건 칸 중괄호 빠뜨림 안내", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useScenarioEditor.setState(useScenarioEditor.getInitialState());
    useScenarioEditor.getState().loadFromString(BARE_VAR_YAML);
    useScenarioEditor.getState().select("01HX0000000000000000000010");
  });

  it("왼쪽 칸이 변수명과 같으면 안내하고, [수정]이 {{변수}}로 바꾼다", async () => {
    const user = userEvent.setup();
    render(<Inspector />);
    const hint = screen.getByText(ko.editor.condBareVarHint("flag"));
    expect(hint.textContent).toContain("{{flag}}");
    await user.click(
      screen.getByRole("button", { name: ko.editor.condBareVarFixAria("왼쪽", "flag") }),
    );
    expect(ifCond()).toEqual({ left: "{{flag}}", op: "eq", right: "true" });
    expect((screen.getByLabelText("조건 왼쪽 값") as HTMLInputElement).value).toBe("{{flag}}");
    expect(screen.queryByText(ko.editor.condBareVarHint("flag"))).toBeNull();
  });

  it("오른쪽 칸도 같은 규칙으로 안내·수정한다", async () => {
    const user = userEvent.setup();
    render(<Inspector />);
    const right = screen.getByLabelText("조건 오른쪽 값");
    await user.clear(right);
    await user.type(right, "expected");
    // 입력 중(커밋 전)에도 안내가 보인다.
    expect(screen.getByText(ko.editor.condBareVarHint("expected"))).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: ko.editor.condBareVarFixAria("오른쪽", "expected") }),
    );
    expect(ifCond()).toEqual({ left: "flag", op: "eq", right: "{{expected}}" });
  });

  it("중괄호가 있거나 변수명이 아닌 값에는 안내하지 않는다", async () => {
    const user = userEvent.setup();
    render(<Inspector />);
    const left = screen.getByLabelText("조건 왼쪽 값");
    await user.clear(left);
    await user.type(left, "{{{{flag}}");
    await user.tab();
    // 오른쪽 "true"는 변수가 아니다 → 안내 0개.
    expect(screen.queryByRole("button", { name: /로 수정$/ })).toBeNull();
    expect(screen.queryByText(/같은 이름의 변수가 있습니다/)).toBeNull();
  });

  it("exists처럼 오른쪽 칸이 없는 연산자에서는 오른쪽 안내가 없다", async () => {
    const user = userEvent.setup();
    useScenarioEditor
      .getState()
      .loadFromString(
        BARE_VAR_YAML.replace('left: "flag"', 'left: "{{flag}}"').replace(
          'right: "true"',
          'right: "expected"',
        ),
      );
    useScenarioEditor.getState().select("01HX0000000000000000000010");
    render(<Inspector />);
    expect(screen.getByText(ko.editor.condBareVarHint("expected"))).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("조건 연산자"), "exists");
    expect(screen.queryByText(ko.editor.condBareVarHint("expected"))).toBeNull();
  });

  it("그룹 안의 조건은 그 조건만 수정한다", async () => {
    const user = userEvent.setup();
    render(<Inspector />);
    await user.click(screen.getByRole("button", { name: /그룹으로 묶기/i }));
    await user.click(screen.getByRole("button", { name: /\+ 조건/i }));
    await user.click(
      screen.getByRole("button", { name: ko.editor.condBareVarFixAria("왼쪽", "flag") }),
    );
    const c = ifCond();
    if (!("all" in c)) throw new Error("expected all group");
    expect(c.all[0]).toEqual({ left: "{{flag}}", op: "eq", right: "true" });
    expect(c.all[1]).toEqual({ left: "", op: "eq", right: "" });
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

  it("min→max 포커스 이동 중 중간 쌍이 커밋되지 않는다 (상향 편집)", async () => {
    const user = userEvent.setup();
    render(<Inspector />);
    await user.click(screen.getByRole("button", { name: ko.editor.sectionTiming }));

    const minInput = screen.getByLabelText(/think 최솟값/i) as HTMLInputElement;
    const maxInput = screen.getByLabelText(/think 최댓값/i) as HTMLInputElement;

    // 베이스라인 {200,500}을 먼저 커밋한다.
    await user.clear(minInput);
    await user.type(minInput, "200");
    await user.clear(maxInput);
    await user.type(maxInput, "500");
    fireEvent.blur(maxInput);

    // 범위를 올린다: min을 먼저 고치고 max로 포커스를 옮긴다.
    await user.clear(minInput);
    await user.type(minInput, "1000");
    await user.click(maxInput); // 여기서 중간 쌍 {1000,500}이 커밋되면 안 된다
    await user.clear(maxInput);
    await user.type(maxInput, "2000");
    fireEvent.blur(maxInput);

    const step = useScenarioEditor.getState().model!.steps[0];
    expect(step.type).toBe("http");
    if (step.type === "http") {
      expect(step.think_time).toEqual({ min_ms: 1000, max_ms: 2000 });
    }
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

  it("다른 스텝을 선택하면 이전 스텝의 미커밋 draft가 아니라 그 스텝의 커밋값으로 재시드된다 (resetKey 격리)", async () => {
    // useThinkTimePair의 resetKey(=step.id) 재시드 경로만 골라내는 테스트.
    //
    // 이전 버전(두 스텝의 think_time이 서로 달랐던 버전)은 스텝 전환 시 cfgMin/cfgMax도
    // 같이 바뀌어 reseed(useCallback([cfgMin,cfgMax]))의 identity가 바뀌었다 — 그래서
    // resetKey를 effect dep에서 완전히 빼도(`useEffect(() => reseed(), [reseed])`)
    // "reseed 값-변경" 경로만으로 effect가 재발화해 테스트가 통과했다(공허).
    //
    // 여기선 두 스텝의 커밋된 think_time을 **동일**({min_ms:100,max_ms:300})하게
    // 맞춰 cfgMin/cfgMax·reseed identity가 전환 전후로 불변이게 한다. 그 상태에서
    // 첫 스텝 입력에 미커밋 draft("999")를 남기고 전환하면, resetKey가 유일한
    // 트리거이므로 — 그게 없으면 "999" 잔존 draft가 두 번째 스텝 화면에 그대로
    // 새어나가 아래 단언이 깨진다(이빨 실증: teeth-demo 참고).
    const TWO_STEP_SAME_THINK_YAML = `version: 1
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
    think_time:
      min_ms: 100
      max_ms: 300
  - id: "01HX0000000000000000000002"
    name: "logout"
    type: http
    request:
      method: POST
      url: "/logout"
    think_time:
      min_ms: 100
      max_ms: 300
`;
    act(() => {
      useScenarioEditor.getState().loadFromString(TWO_STEP_SAME_THINK_YAML);
      useScenarioEditor.getState().select("01HX0000000000000000000001");
    });
    render(<Inspector />);
    await userEvent.setup().click(screen.getByRole("button", { name: ko.editor.sectionTiming }));

    const minInput = screen.getByLabelText(/think 최솟값/i) as HTMLInputElement;
    expect(minInput.value).toBe("100");
    expect((screen.getByLabelText(/think 최댓값/i) as HTMLInputElement).value).toBe("300");

    // 첫 스텝 min 입력에 미커밋 draft를 남긴다 — blur도, max(짝)로의 포커스
    // 이동도 없음(커밋 경계를 건드리지 않고 순수 draft 상태만 바꾼다).
    fireEvent.change(minInput, { target: { value: "999" } });
    expect(minInput.value).toBe("999");

    // 같은 마운트 안에서 두 번째 스텝(동일 커밋값)으로 전환한다.
    act(() => {
      useScenarioEditor.getState().select("01HX0000000000000000000002");
    });

    // resetKey가 없었다면 cfgMin/cfgMax가 두 스텝 모두 100/300이라 reseed identity가
    // 안 바뀌어 이 재시드가 안 일어나고, 방금 남긴 "999" draft가 새 스텝 화면에 그대로
    // 새어나간다 — 즉 이 두 단언이 resetKey 메커니즘 자체를 검증한다.
    expect((screen.getByLabelText(/think 최솟값/i) as HTMLInputElement).value).toBe("100");
    expect((screen.getByLabelText(/think 최댓값/i) as HTMLInputElement).value).toBe("300");
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

  /** 분기 *자식*(컨테이너 아님)을 선택하고 그 자식에 think_time을 지정한다.
   *  기존 loadParallelAndSelect()는 parallel 컨테이너를 선택하므로 여기 못 쓴다. */
  function selectBranchChildWithThink() {
    useScenarioEditor.setState(useScenarioEditor.getInitialState());
    useScenarioEditor.getState().resetEmpty();
    const pid = useScenarioEditor.getState().addParallelStep("Fan-out")!;
    const par = useScenarioEditor.getState().model!.steps.find((s) => s.id === pid)!;
    if (par.type !== "parallel") throw new Error("expected parallel step");
    const childId = par.branches[0].steps[0].id;
    // 값을 지정 → state는 override(=parallel_unset 아님). 이게 이 케이스의 요점이다.
    useScenarioEditor.getState().setStepField(childId, ["think_time"], { min_ms: 50, max_ms: 60 });
    useScenarioEditor.getState().select(childId);
    return childId;
  }

  it("분기 안에 think_time이 지정된 스텝도 병렬 미적용 안내를 보여준다", async () => {
    const user = userEvent.setup();
    selectBranchChildWithThink();
    render(<Inspector />);
    // 타이밍 섹션은 기본 접힘(editorPrefs.timing = false)이라 먼저 펼친다.
    await user.click(screen.getByRole("button", { name: ko.editor.sectionTiming }));

    // 이빨: 값이 실제로 지정돼 있어야 state가 override가 되어 이 케이스가 의미를 갖는다.
    // (값이 없으면 parallel_unset이라 state 유도 구현도 통과해 버려 vacuous해진다.)
    expect(screen.getByLabelText(/think 최솟값/i)).toHaveValue(50);
    expect(screen.getByText(ko.editor.parallelNoDefaultNote)).toBeInTheDocument();
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

const DEFAULTS_YAML = `version: 1
name: "demo"
default_think_time:
  min_ms: 500
  max_ms: 1000
steps:
  - id: "01HX0000000000000000000001"
    name: "login"
    type: http
    request:
      method: POST
      url: "/login"
  - id: "01HX0000000000000000000020"
    name: "assets"
    type: parallel
    branches:
      - name: "b1"
        steps:
          - id: "01HX0000000000000000000021"
            name: "img"
            type: http
            request:
              method: GET
              url: "/img"
`;

const DEFAULTS_ZERO_YAML = `version: 1
name: "demo"
default_think_time:
  min_ms: 0
  max_ms: 0
steps:
  - id: "01HX0000000000000000000001"
    name: "login"
    type: http
    request:
      method: POST
      url: "/login"
  - id: "01HX0000000000000000000020"
    name: "assets"
    type: parallel
    branches:
      - name: "b1"
        steps:
          - id: "01HX0000000000000000000021"
            name: "img"
            type: http
            request:
              method: GET
              url: "/img"
`;

// 섹션 제목 버튼은 기존 이디엄대로 ko.editor.sectionTiming("타이밍") — RunDialog의
// 동명 개념("페이싱")과 문구가 다르니 혼동 주의(브리프 초안의 sectionPacing 오기 정정).
async function openTiming(user: ReturnType<typeof userEvent.setup>) {
  const btn = screen.queryByRole("button", { name: new RegExp(ko.editor.sectionTiming) });
  if (btn && btn.getAttribute("aria-expanded") === "false") await user.click(btn);
}

describe("Inspector — think time 3상태 (think-time-defaults R8/R9)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useScenarioEditor.setState(useScenarioEditor.getInitialState());
  });

  it("상속 중이면 시나리오 기본값 힌트를 보여준다 (기본값 없으면 안 보여준다)", async () => {
    const user = userEvent.setup();
    act(() => {
      useScenarioEditor.getState().loadFromString(DEFAULTS_YAML);
      useScenarioEditor.getState().select("01HX0000000000000000000001");
    });
    render(<Inspector />);
    await openTiming(user);
    expect(
      screen.getByText(ko.editor.inheritedThink(ko.editor.thinkRange(500, 1000))),
    ).toBeInTheDocument();

    // 기본값이 없는 시나리오 → 힌트 없음(R10 회귀 0)
    act(() => {
      useScenarioEditor.getState().loadFromString(VALID_YAML);
      useScenarioEditor.getState().select("01HX0000000000000000000001");
    });
    expect(screen.queryByText(/상속 중/)).not.toBeInTheDocument();
  });

  it("'이 스텝은 대기 없음' 체크 → think_time {0,0} + 입력 disabled, 해제 → 키 제거(상속 복귀)", async () => {
    const user = userEvent.setup();
    act(() => {
      useScenarioEditor.getState().loadFromString(DEFAULTS_YAML);
      useScenarioEditor.getState().select("01HX0000000000000000000001");
    });
    render(<Inspector />);
    await openTiming(user);

    await user.click(screen.getByLabelText(ko.editor.stepNoWaitLabel));
    const step = () =>
      useScenarioEditor
        .getState()
        .model!.steps.find((s) => s.id === "01HX0000000000000000000001") as {
        think_time?: unknown;
      };
    expect(step().think_time).toEqual({ min_ms: 0, max_ms: 0 });
    expect(screen.getByLabelText(ko.editor.fieldThinkMin)).toBeDisabled();
    expect(screen.getByLabelText(ko.editor.fieldThinkMax)).toBeDisabled();

    await user.click(screen.getByLabelText(ko.editor.stepNoWaitLabel));
    expect(step().think_time).toBeUndefined();
    expect(screen.getByLabelText(ko.editor.fieldThinkMin)).not.toBeDisabled();
  });

  it("parallel 분기 내부 스텝엔 미적용 안내가 뜨고 상속 힌트는 숨는다", async () => {
    const user = userEvent.setup();
    act(() => {
      useScenarioEditor.getState().loadFromString(DEFAULTS_YAML);
      useScenarioEditor.getState().select("01HX0000000000000000000021"); // 분기 안 http
    });
    render(<Inspector />);
    await openTiming(user);
    expect(screen.getByText(ko.editor.parallelNoDefaultNote)).toBeInTheDocument();
    expect(
      screen.queryByText(ko.editor.inheritedThink(ko.editor.thinkRange(500, 1000))),
    ).not.toBeInTheDocument();
  });

  it("US2-①: 기본값이 {0,0}이면 '0–0ms'가 아니라 '대기없음'으로 안내한다", async () => {
    const user = userEvent.setup();
    act(() => {
      useScenarioEditor.getState().loadFromString(DEFAULTS_ZERO_YAML);
      useScenarioEditor.getState().select("01HX0000000000000000000001");
    });
    render(<Inspector />);
    await openTiming(user);
    expect(screen.getByText(ko.editor.inheritedThink(ko.editor.thinkNoWait))).toBeInTheDocument();
    expect(screen.queryByText(/0–0ms/)).not.toBeInTheDocument();
  });

  // spec 테스트 16 — insideParallel이 inheriting보다 우선함을 기본값 {0,0}에서도
  // 락인한다. 주의: 이 경로에선 삼항의 첫 분기가 잡혀 formatThink가 **미평가**라
  // R1(표시 단일 소스) 커버리지는 없다 — 그건 위 :1404와 thinkTime.test.ts가 담당.
  // 기존 :1390은 같은 우선순위를 {500,1000}에서 덮는다.
  it("US2-①: 기본값이 {0,0}이어도 분기 안 스텝은 미적용 안내가 우선한다", async () => {
    const user = userEvent.setup();
    act(() => {
      useScenarioEditor.getState().loadFromString(DEFAULTS_ZERO_YAML);
      useScenarioEditor.getState().select("01HX0000000000000000000021"); // 분기 안 http
    });
    render(<Inspector />);
    await openTiming(user);
    expect(screen.getByText(ko.editor.parallelNoDefaultNote)).toBeInTheDocument();
    expect(
      screen.queryByText(ko.editor.inheritedThink(ko.editor.thinkNoWait)),
    ).not.toBeInTheDocument();
  });
});

const LOOP_COND_YAML = (extra: string) => `version: 1
name: "demo"
cookie_jar: auto
variables: {}
steps:
  - id: "01HX0000000000000000000040"
    name: "poll"
    type: loop
${extra}
    do:
      - id: "01HX0000000000000000000041"
        name: "ping"
        type: http
        request:
          method: GET
          url: "/ping"
`;

const WHILE_BLOCK = `    repeat: 5
    while:
      left: "{{code}}"
      op: eq
      right: "200"`;

function loadLoop(extra: string) {
  useScenarioEditor.setState(useScenarioEditor.getInitialState());
  useScenarioEditor.getState().loadFromString(LOOP_COND_YAML(extra));
  useScenarioEditor.getState().select("01HX0000000000000000000040");
}

describe("Inspector — 반복 조건 (loop-do-while)", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("조건 없는 loop: 구역을 열면 조건 추가만 보이고, 누르면 while이 생긴다", async () => {
    const user = userEvent.setup();
    loadLoop("    repeat: 3");
    render(<Inspector />);
    expect(screen.queryByRole("checkbox", { name: ko.editor.loopKeepThink })).toBeNull();
    await user.click(screen.getByRole("button", { name: ko.editor.loopCondSection }));
    expect(screen.getByText(ko.editor.loopCondIntro)).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: ko.editor.loopKeepThink })).toBeNull();
    expect(screen.queryByRole("button", { name: ko.editor.loopCondRemove })).toBeNull();
    await user.click(screen.getByRole("button", { name: ko.editor.loopCondAdd }));
    const loop = useScenarioEditor.getState().model!.steps[0];
    expect(loop.type === "loop" && loop.while).toEqual({ left: "", op: "eq", right: "" });
    expect(screen.getByRole("checkbox", { name: ko.editor.loopKeepThink })).toBeChecked();
  });

  it("조건 있는 loop: 열린 채 시작, 최대 반복 횟수 라벨, keep_think 체크 해제 → YAML", async () => {
    const user = userEvent.setup();
    loadLoop(WHILE_BLOCK);
    render(<Inspector />);
    expect(screen.getByRole("button", { name: ko.editor.loopCondSection })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByLabelText(ko.editor.fieldRepeatMax)).toHaveValue(5);
    const keep = screen.getByLabelText(ko.editor.loopKeepThink);
    expect(screen.getAllByLabelText(ko.editor.loopKeepThink)).toHaveLength(1);
    expect(keep).toBeChecked();
    expect(screen.getByRole("button", { name: "think time 항상 적용 도움말" })).toBeInTheDocument();
    await user.click(keep);
    expect(useScenarioEditor.getState().yamlText).toContain("keep_think: false");
  });

  it("횟수를 비우고 blur → repeat 없음 + 안내, 다시 4 → repeat: 4", async () => {
    const user = userEvent.setup();
    loadLoop(WHILE_BLOCK);
    render(<Inspector />);
    const repeat = screen.getByLabelText(ko.editor.fieldRepeatMax);
    await user.clear(repeat);
    await user.click(document.body);
    expect(useScenarioEditor.getState().yamlText).not.toContain("repeat:");
    expect(screen.getByText(ko.editor.loopRepeatUnlimitedHint)).toBeInTheDocument();
    await user.type(screen.getByLabelText(ko.editor.fieldRepeatMax), "4");
    await user.click(document.body);
    expect(useScenarioEditor.getState().yamlText).toContain("repeat: 4");
    expect(screen.queryByText(ko.editor.loopRepeatUnlimitedHint)).toBeNull();
  });

  it("잘못된 숫자 입력(badInput)으로 blur → 이전 값 복원, repeat 유지", async () => {
    const user = userEvent.setup();
    loadLoop(WHILE_BLOCK);
    render(<Inspector />);
    const before = useScenarioEditor.getState().yamlText;
    const repeat = screen.getByLabelText(ko.editor.fieldRepeatMax);
    Object.defineProperty(repeat, "validity", { value: { badInput: true }, configurable: true });
    await user.clear(repeat); // 브라우저는 잘못된 입력도 value === "" 로 보고한다
    await user.click(document.body);
    expect(useScenarioEditor.getState().yamlText).toBe(before);
    expect(useScenarioEditor.getState().yamlText).toContain("repeat: 5");
    expect(screen.getByLabelText(ko.editor.fieldRepeatMax)).toHaveValue(5);
  });

  it("구역 열림은 선택이 바뀔 때 다시 시드된다", async () => {
    const user = userEvent.setup();
    const yaml = `version: 1
name: "demo"
cookie_jar: auto
variables: {}
steps:
  - id: "01HX0000000000000000000060"
    name: "cond"
    type: loop
    repeat: 5
    while:
      left: "{{code}}"
      op: eq
      right: "200"
    do:
      - id: "01HX0000000000000000000061"
        name: "a"
        type: http
        request:
          method: GET
          url: "/a"
  - id: "01HX0000000000000000000062"
    name: "plain"
    type: loop
    repeat: 3
    do:
      - id: "01HX0000000000000000000063"
        name: "b"
        type: http
        request:
          method: GET
          url: "/b"
  - id: "01HX0000000000000000000064"
    name: "gate"
    type: if
    cond:
      left: "{{code}}"
      op: eq
      right: "200"
    then:
      - id: "01HX0000000000000000000065"
        name: "nested"
        type: loop
        repeat: 2
        do:
          - id: "01HX0000000000000000000066"
            name: "c"
            type: http
            request:
              method: GET
              url: "/c"
`;
    useScenarioEditor.setState(useScenarioEditor.getInitialState());
    useScenarioEditor.getState().loadFromString(yaml);
    const select = (id: string) => act(() => useScenarioEditor.getState().select(id));
    select("01HX0000000000000000000060");
    render(<Inspector />);
    const toggle = () => screen.getByRole("button", { name: ko.editor.loopCondSection });
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    select("01HX0000000000000000000062");
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: ko.editor.loopCondAdd })).toBeNull();
    select("01HX0000000000000000000060");
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    // if 분기 안 loop에서도 구역이 보인다
    select("01HX0000000000000000000065");
    await user.click(toggle());
    expect(screen.getByRole("button", { name: ko.editor.loopCondAdd })).toBeInTheDocument();
  });

  it("회귀 가드: 조건 없는 loop에서 횟수를 비우고 blur → 이전 값 복원, YAML 불변", async () => {
    const user = userEvent.setup();
    loadLoop("    repeat: 3");
    render(<Inspector />);
    const before = useScenarioEditor.getState().yamlText;
    const repeat = screen.getByLabelText(ko.editor.fieldRepeat);
    await user.clear(repeat);
    await user.click(document.body);
    expect(screen.getByLabelText(ko.editor.fieldRepeat)).toHaveValue(3);
    expect(useScenarioEditor.getState().yamlText).toBe(before);
  });

  it("회귀 가드: 횟수를 비운 채 조건 삭제 → while 없음 + repeat: 1", async () => {
    const user = userEvent.setup();
    loadLoop(WHILE_BLOCK);
    render(<Inspector />);
    await user.clear(screen.getByLabelText(ko.editor.fieldRepeatMax));
    await user.click(document.body);
    await user.click(screen.getByRole("button", { name: ko.editor.loopCondRemove }));
    const yaml = useScenarioEditor.getState().yamlText;
    expect(yaml).not.toContain("while");
    expect(yaml).toContain("repeat: 1");
    expect(useScenarioEditor.getState().yamlError).toBeNull();
    expect(screen.getByLabelText(ko.editor.fieldRepeat)).toHaveValue(1);
  });

  it("자식 버튼: while 없는 loop은 loop ×3 그대로(회귀 가드), 조건 loop은 조건 라벨", () => {
    const yaml = (loopExtra: string) => `version: 1
name: "demo"
cookie_jar: auto
variables: {}
steps:
  - id: "01HX0000000000000000000050"
    name: "outer"
    type: if
    cond:
      left: "{{code}}"
      op: eq
      right: "200"
    then:
      - id: "01HX0000000000000000000051"
        name: "inner"
        type: loop
${loopExtra}
        do:
          - id: "01HX0000000000000000000052"
            name: "ping"
            type: http
            request:
              method: GET
              url: "/ping"
`;
    useScenarioEditor.setState(useScenarioEditor.getInitialState());
    useScenarioEditor.getState().loadFromString(yaml("        repeat: 3"));
    useScenarioEditor.getState().select("01HX0000000000000000000050");
    const { unmount } = render(<Inspector />);
    expect(screen.getByText("loop ×3")).toBeInTheDocument();
    unmount();
    useScenarioEditor
      .getState()
      .loadFromString(
        yaml(
          `        repeat: 5\n        while:\n          left: "{{code}}"\n          op: eq\n          right: "200"`,
        ),
      );
    useScenarioEditor.getState().select("01HX0000000000000000000050");
    render(<Inspector />);
    expect(screen.getByText("조건 반복 · 최대 5")).toBeInTheDocument();
  });

  it("반복 조건 구역에 빈 값이 뒤 요청 주소에 실리는 위험 안내가 보인다", () => {
    useScenarioEditor.setState(useScenarioEditor.getInitialState());
    useScenarioEditor.getState().loadFromString(`version: 1
name: "demo"
cookie_jar: auto
variables: {}
steps:
  - id: "01HX0000000000000000000060"
    name: "poll"
    type: loop
    repeat: 5
    while:
      left: "{{code}}"
      op: eq
      right: "WAIT"
    do:
      - id: "01HX0000000000000000000061"
        name: "ping"
        type: http
        request:
          method: GET
          url: "/ping"
`);
    useScenarioEditor.getState().select("01HX0000000000000000000060");
    render(<Inspector />);
    expect(
      screen.getByText(
        "이 반복 안에서는 응답에 없는 값을 빈 값으로 두고 에러로 세지 않습니다. 요청이 실패한 스텝이 뽑는 값도 빈 값이 됩니다. 빈 값이 된 값을 뒤 스텝의 요청 주소에 쓰면(예: /orders/{{orderId}}) 그 요청은 보내지 않고 에러로 셉니다. 헤더·본문에는 빈 값이 그대로 들어가므로, 뒤에서 그 값을 쓰기 전에 조건 분기로 확인하세요.",
      ),
    ).toBeInTheDocument();
  });
});

const warnYaml = (think: string, right: string, op = "ne") => `version: 1
name: "demo"
cookie_jar: auto
variables: {}
steps:
  - id: "01HX0000000000000000000070"
    name: "주문 재시도"
    type: loop
    while:
      left: "{{code}}"
      op: ${op}
      right: "${right}"
    do:
      - id: "01HX0000000000000000000071"
        name: "poll"
        type: http
        request:
          method: GET
          url: "/poll"
${think}        extract:
          - var: code
            from: body
            path: "$.code"
`;

describe("Inspector — 조건 반복 경고 (US3)", () => {
  beforeEach(() => {
    useScenarioEditor.setState(useScenarioEditor.getInitialState());
  });

  it("ne OK + think 없음 + 횟수 비움 → 두 경고와 접미 문장", () => {
    useScenarioEditor.getState().loadFromString(warnYaml("", "OK"));
    useScenarioEditor.getState().select("01HX0000000000000000000070");
    render(<Inspector />);
    const text = document.body.textContent ?? "";
    expect(text).toContain(
      "대기 없이 재시도합니다. 응답이 빠르면 초당 수백 번 다시 요청할 수 있습니다. 반복 안 스텝에 think time을 넣으세요.",
    );
    expect(text).toContain(
      "요청이 실패해 값을 못 뽑아도 조건이 참이라 계속 반복합니다. '대기 값과 같다'처럼 값을 받았을 때만 참이 되는 조건을 권합니다.",
    );
    expect(text).toContain("최대 횟수도 없어 run이 끝날 때까지 이어집니다.");
    const parsed = ScenarioModel.safeParse(useScenarioEditor.getState().model);
    expect(parsed.success).toBe(true);
  });

  it("think를 넣고 eq WAIT로 바꾸면 경고 Callout이 없다", () => {
    useScenarioEditor
      .getState()
      .loadFromString(warnYaml("        think_time: { min_ms: 500, max_ms: 500 }\n", "WAIT", "eq"));
    useScenarioEditor.getState().select("01HX0000000000000000000070");
    render(<Inspector />);
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("대기 없이 재시도합니다");
    expect(text).not.toContain("계속 반복합니다");
    expect(text).not.toContain("최대 횟수도 없어");
  });
});
