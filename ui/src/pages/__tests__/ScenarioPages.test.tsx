import { describe, expect, it, vi } from "vitest";

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
    const normalizedYaml =
      "steps:\n  - name: home\n    request:\n      method: GET\n      url: /\n";
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
});

// ---------------------------------------------------------------------------
// ScenarioNewPage Cancel guard: only prompt to discard when the draft is dirty.
// Reuses the same baseline-seeding so an untouched (normalized) starter is NOT
// falsely dirty — otherwise Cancel would nag on every brand-new page.
// ---------------------------------------------------------------------------
function simulateCancelGuard() {
  const STARTER = "starter";
  let yamlText = STARTER;
  let originalYaml = STARTER;
  let baselineSeeded = false;
  let navigated = false;

  function handleEditorChange(next: string) {
    yamlText = next;
    if (!baselineSeeded) {
      baselineSeeded = true;
      originalYaml = next;
    }
  }
  const dirty = () => originalYaml !== yamlText;
  // Mirrors ScenarioNewPage cancel(): confirm only when dirty, else navigate.
  function cancel(confirmFn: () => boolean) {
    if (!dirty() || confirmFn()) navigated = true;
  }
  return { handleEditorChange, dirty, cancel, didNavigate: () => navigated };
}

describe("ScenarioNewPage cancel guard", () => {
  it("navigates without confirming an untouched (normalization-seeded) draft", () => {
    const g = simulateCancelGuard();
    g.handleEditorChange("starter\n"); // EditorShell normalizes STARTER → seeds baseline
    expect(g.dirty()).toBe(false);
    const confirmFn = vi.fn(() => false);
    g.cancel(confirmFn);
    expect(confirmFn).not.toHaveBeenCalled();
    expect(g.didNavigate()).toBe(true);
  });

  it("blocks navigation when the draft is dirty and the user cancels the confirm", () => {
    const g = simulateCancelGuard();
    g.handleEditorChange("starter\n"); // seed baseline
    g.handleEditorChange("starter\nsteps: edited"); // user edits → dirty
    expect(g.dirty()).toBe(true);
    const confirmFn = vi.fn(() => false);
    g.cancel(confirmFn);
    expect(confirmFn).toHaveBeenCalledTimes(1);
    expect(g.didNavigate()).toBe(false);
  });

  it("navigates when the draft is dirty and the user confirms discard", () => {
    const g = simulateCancelGuard();
    g.handleEditorChange("starter\n");
    g.handleEditorChange("starter\nedited");
    const confirmFn = vi.fn(() => true);
    g.cancel(confirmFn);
    expect(confirmFn).toHaveBeenCalledTimes(1);
    expect(g.didNavigate()).toBe(true);
  });
});
