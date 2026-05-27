import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Pure-logic tests for the dirty-flag baseline-seeding pattern used in
// ScenarioEditPage.  We don't need DOM rendering to verify the core invariant:
//   • first onChange from EditorShell seeds originalYaml (baseline)
//   • dirty = (originalYaml !== yamlText) is FALSE after seeding with the
//     same text that was just set
// ---------------------------------------------------------------------------

function simulateDirtyLogic() {
  let yamlText = "";
  let originalYaml = "";
  let baselineSeeded = false;

  // Mirrors the useEffect([data]) logic
  function onDataLoaded(_version: number) {
    baselineSeeded = false;
  }

  // Mirrors handleEditorChange
  function handleEditorChange(next: string) {
    yamlText = next;
    if (!baselineSeeded) {
      baselineSeeded = true;
      originalYaml = next;
    }
  }

  // Mirrors onSuccess handler in Save mutate call
  function onSaveSuccess(savedYaml: string, _savedVersion: number) {
    originalYaml = savedYaml;
    baselineSeeded = true;
  }

  const dirty = () => originalYaml !== yamlText;

  return { onDataLoaded, handleEditorChange, onSaveSuccess, dirty };
}

describe("ScenarioEditPage dirty-flag baseline seeding", () => {
  it("Save button is NOT dirty after first EditorShell onChange (normalization seeding)", () => {
    const { onDataLoaded, handleEditorChange, dirty } = simulateDirtyLogic();

    // Step 1: data arrives, version recorded, baseline flag reset
    onDataLoaded(1);

    // Step 2: EditorShell mounts, normalizes the YAML, fires first onChange
    const normalizedYaml = "steps:\n  - name: home\n    request:\n      method: GET\n      url: /\n";
    handleEditorChange(normalizedYaml);

    // Expect: baseline seeded with normalized form → dirty is false
    expect(dirty()).toBe(false);
  });

  it("becomes dirty after user edits the YAML", () => {
    const { onDataLoaded, handleEditorChange, dirty } = simulateDirtyLogic();

    onDataLoaded(1);
    const normalizedYaml = "steps:\n  - name: home\n";
    handleEditorChange(normalizedYaml); // first call: seeds baseline

    const editedYaml = "steps:\n  - name: home\n  - name: extra\n";
    handleEditorChange(editedYaml); // subsequent calls don't re-seed

    expect(dirty()).toBe(true);
  });

  it("resets dirty to false after save success", () => {
    const { onDataLoaded, handleEditorChange, onSaveSuccess, dirty } = simulateDirtyLogic();

    onDataLoaded(1);
    const normalizedYaml = "steps:\n  - name: home\n";
    handleEditorChange(normalizedYaml);

    const editedYaml = "steps:\n  - name: home\n  - name: extra\n";
    handleEditorChange(editedYaml);
    expect(dirty()).toBe(true);

    // After save, server returns the saved yaml as canonical form
    onSaveSuccess(editedYaml, 2);
    expect(dirty()).toBe(false);
  });

  it("re-seeds baseline when new data loads (e.g. refetch)", () => {
    const { onDataLoaded, handleEditorChange, dirty } = simulateDirtyLogic();

    // First load + seed
    onDataLoaded(1);
    handleEditorChange("steps:\n  - name: home\n");
    expect(dirty()).toBe(false);

    // Data refetch arrives (e.g. optimistic update resolved)
    onDataLoaded(2);

    // EditorShell fires onChange with the new normalized form
    handleEditorChange("steps:\n  - name: home\n  - name: extra\n");
    expect(dirty()).toBe(false); // re-seeded → still not dirty
  });

  it.todo("ScenarioNewPage renders EditorShell instead of textarea");
  it.todo("ScenarioNewPage Create button calls mutation with yamlText from EditorShell");
  it.todo("ScenarioEditPage renders EditorShell initialized with scenario yaml");
  it.todo("ScenarioEditPage Save button calls update mutation with {yaml, version}");
});
