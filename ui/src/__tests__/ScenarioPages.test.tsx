import { describe, it } from "vitest";

describe("ScenarioNewPage + ScenarioEditPage with EditorShell", () => {
  it.todo("ScenarioNewPage renders EditorShell instead of textarea");
  it.todo("ScenarioNewPage Create button calls mutation with yamlText from EditorShell");
  it.todo("ScenarioEditPage renders EditorShell initialized with scenario yaml");
  it.todo("ScenarioEditPage Save button is disabled when yaml is unchanged");
  it.todo("ScenarioEditPage Save button calls update mutation with {yaml, version}");
});
