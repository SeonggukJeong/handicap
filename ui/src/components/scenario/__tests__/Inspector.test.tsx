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
});
