import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { Inspector } from "../Inspector";
import { useScenarioEditor } from "../../../scenario/store";

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
