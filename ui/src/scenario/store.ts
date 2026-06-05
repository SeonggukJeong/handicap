import { create } from "zustand";
import type { StoreApi } from "zustand";
import { Document } from "yaml";
import { type Extract, type Scenario, type Condition, findStepById, isParallelStep } from "./model";
import { newStepId } from "./ulid";
import { applyEdit, parseScenarioDoc, serializeDoc, type Edit, type BranchSel } from "./yamlDoc";

const STARTER_YAML = `version: 1
name: "Untitled"
cookie_jar: auto
variables: {}
steps: []
`;

export type Tab = "canvas" | "yaml";

export interface ScenarioEditorState {
  doc: Document | null;
  model: Scenario | null;
  yamlText: string;
  yamlError: string | null;

  selectedStepId: string | null;
  activeTab: Tab;
  pendingYamlText: string | null;

  loadFromString(yaml: string): void;
  resetEmpty(): void;

  // Edit ops (mirror Edit variants)
  setName(value: string): void;
  setCookieJar(value: "auto" | "off"): void;
  setVariable(key: string, value: string): void;
  removeVariable(key: string): void;
  addStep(name: string): string; // returns new id
  addLoopStep(name: string): string; // returns new loop id
  addStepInLoop(loopId: string, name: string): string; // returns new child id
  setLoopRepeat(loopId: string, repeat: number): void;
  addIfStep(name: string): string; // returns new if id
  setIfCond(ifId: string, cond: Condition): void;
  setElifCond(ifId: string, index: number, cond: Condition): void;
  addStepInBranch(ifId: string, branch: BranchSel, name: string): string; // returns child id
  addLoopInBranch(ifId: string, branch: BranchSel, name: string): string; // returns new loop id
  addIfInLoop(loopId: string, name: string): string; // returns new if id
  addElif(ifId: string): void;
  removeElif(ifId: string, index: number): void;
  addParallelStep(name: string): string; // returns new parallel id
  addBranch(parallelId: string): void;
  removeBranch(parallelId: string, index: number): void;
  addStepInParallelBranch(parallelId: string, branchIndex: number, name: string): string; // returns new child id
  setBranchName(parallelId: string, branchIndex: number, name: string): void;
  removeStep(stepId: string): void;
  moveStep(stepId: string, toIndex: number): void;
  setStepField(stepId: string, path: ReadonlyArray<string>, value: unknown): void;
  setStepAssert(stepId: string, asserts: ReadonlyArray<{ kind: "status"; code: number }>): void;
  setStepExtract(stepId: string, extract: ReadonlyArray<Extract>): void;

  // UI state
  select(id: string | null): void;
  setActiveTab(tab: Tab): void;

  // Monaco-driven (debounced) sync
  setPendingYamlText(text: string): void;
  commitPendingYaml(): void;
  clearPendingYaml(): void;
}

const INITIAL: Pick<
  ScenarioEditorState,
  "doc" | "model" | "yamlText" | "yamlError" | "selectedStepId" | "activeTab" | "pendingYamlText"
> = {
  doc: null,
  model: null,
  yamlText: "",
  yamlError: null,
  selectedStepId: null,
  activeTab: "canvas",
  pendingYamlText: null,
};

export const useScenarioEditor = create<ScenarioEditorState>((set, get) => ({
  ...INITIAL,

  loadFromString(yaml) {
    const result = parseScenarioDoc(yaml);
    if ("error" in result) {
      set({
        doc: null,
        model: null,
        yamlText: yaml,
        yamlError: result.error,
        selectedStepId: null,
        pendingYamlText: null,
      });
      return;
    }
    set({
      doc: result.doc,
      model: result.model,
      yamlText: serializeDoc(result.doc),
      yamlError: null,
      selectedStepId: null,
      pendingYamlText: null,
    });
  },

  resetEmpty() {
    get().loadFromString(STARTER_YAML);
  },

  setName(value) {
    dispatch(set, get, { type: "setName", value });
  },
  setCookieJar(value) {
    dispatch(set, get, { type: "setCookieJar", value });
  },
  setVariable(key, value) {
    dispatch(set, get, { type: "setVariable", key, value });
  },
  removeVariable(key) {
    dispatch(set, get, { type: "removeVariable", key });
  },
  addStep(name) {
    const id = newStepId();
    dispatch(set, get, { type: "addStep", id, name });
    return id;
  },
  addLoopStep(name) {
    const id = newStepId();
    const childId = newStepId();
    dispatch(set, get, { type: "addLoopStep", id, name, childId });
    return id;
  },
  addStepInLoop(loopId, name) {
    const id = newStepId();
    dispatch(set, get, { type: "addStepInLoop", loopId, id, name });
    return id;
  },
  setLoopRepeat(loopId, repeat) {
    dispatch(set, get, { type: "setLoopRepeat", loopId, repeat });
  },
  addIfStep(name) {
    const id = newStepId();
    const childId = newStepId();
    dispatch(set, get, { type: "addIfStep", id, name, childId });
    return id;
  },
  setIfCond(ifId, cond) {
    dispatch(set, get, { type: "setIfCond", ifId, cond });
  },
  setElifCond(ifId, index, cond) {
    dispatch(set, get, { type: "setElifCond", ifId, index, cond });
  },
  addStepInBranch(ifId, branch, name) {
    const id = newStepId();
    dispatch(set, get, { type: "addStepInBranch", ifId, branch, id, name });
    return id;
  },
  addLoopInBranch(ifId, branch, name) {
    const id = newStepId();
    const childId = newStepId();
    dispatch(set, get, { type: "addLoopInBranch", ifId, branch, id, name, childId });
    return id;
  },
  addIfInLoop(loopId, name) {
    const id = newStepId();
    const childId = newStepId();
    dispatch(set, get, { type: "addIfInLoop", loopId, id, name, childId });
    return id;
  },
  addElif(ifId) {
    const childId = newStepId();
    dispatch(set, get, { type: "addElif", ifId, childId });
  },
  removeElif(ifId, index) {
    dispatch(set, get, { type: "removeElif", ifId, index });
  },
  addParallelStep(name) {
    const id = newStepId();
    const branch1Id = newStepId();
    const branch2Id = newStepId();
    dispatch(set, get, { type: "addParallelStep", id, name, branch1Id, branch2Id });
    return id;
  },
  addBranch(parallelId) {
    // Generate a non-colliding default name branch{N}
    const model = get().model;
    const found = model ? findStepById(model.steps, parallelId) : null;
    const existingNames = new Set(
      found && isParallelStep(found) ? found.branches.map((b) => b.name) : [],
    );
    let n = existingNames.size + 1;
    while (existingNames.has(`branch${n}`)) n++;
    const name = `branch${n}`;
    const childId = newStepId();
    dispatch(set, get, { type: "addBranch", parallelId, name, childId });
  },
  removeBranch(parallelId, index) {
    dispatch(set, get, { type: "removeBranch", parallelId, index });
  },
  addStepInParallelBranch(parallelId, branchIndex, name) {
    const id = newStepId();
    dispatch(set, get, { type: "addStepInParallelBranch", parallelId, branchIndex, id, name });
    return id;
  },
  setBranchName(parallelId, branchIndex, name) {
    dispatch(set, get, { type: "setBranchName", parallelId, branchIndex, name });
  },
  removeStep(stepId) {
    if (get().selectedStepId === stepId) set({ selectedStepId: null });
    dispatch(set, get, { type: "removeStep", stepId });
  },
  moveStep(stepId, toIndex) {
    dispatch(set, get, { type: "moveStep", stepId, toIndex });
  },
  setStepField(stepId, path, value) {
    dispatch(set, get, { type: "setStepField", stepId, path, value });
  },
  setStepAssert(stepId, asserts) {
    dispatch(set, get, { type: "setStepAssert", stepId, asserts });
  },
  setStepExtract(stepId, extract) {
    dispatch(set, get, { type: "setStepExtract", stepId, extract });
  },

  select(id) {
    set({ selectedStepId: id });
  },
  setActiveTab(tab) {
    set({ activeTab: tab });
  },

  // setPendingYamlText ONLY stores the text — it MUST NOT re-derive model.
  // Tests rely on referential equality: s.model === initialModel after this call.
  setPendingYamlText(text) {
    set({ pendingYamlText: text });
  },
  commitPendingYaml() {
    const text = get().pendingYamlText;
    if (text === null) return;
    const result = parseScenarioDoc(text);
    if ("error" in result) {
      // MUST NOT replace model — tests assert referential equality is preserved.
      set({ yamlError: result.error });
      return;
    }
    set({
      doc: result.doc,
      model: result.model,
      yamlText: serializeDoc(result.doc),
      yamlError: null,
      pendingYamlText: null,
    });
  },
  clearPendingYaml() {
    set({ pendingYamlText: null, yamlError: null });
  },
}));

function dispatch(
  set: StoreApi<ScenarioEditorState>["setState"],
  get: () => ScenarioEditorState,
  edit: Edit,
): void {
  const doc = get().doc;
  if (!doc) return;
  applyEdit(doc, edit);
  // Re-derive model from the mutated doc. This guarantees the model in state
  // is always the Zod-validated canonical output, not a raw mutation.
  const reparsed = parseScenarioDoc(serializeDoc(doc));
  if ("error" in reparsed) {
    set({ yamlError: reparsed.error });
    return;
  }
  set({
    doc: reparsed.doc,
    model: reparsed.model,
    yamlText: serializeDoc(reparsed.doc),
    yamlError: null,
  });
}

// Zustand v5 does not expose getInitialState() out of the box.
// This shim is used by tests to reset store state between test runs:
//   useScenarioEditor.setState(useScenarioEditor.getInitialState())
// It copies the plain data fields from INITIAL and keeps action references
// from the live store (spreading is safe because Zustand stores plain objects,
// not class instances).
// Action references in Zustand v5 are stable (closed over set/get at store
// creation time), so we capture them once at module load instead of calling
// getState() once per action per getInitialState() call.
const actions = (() => {
  const s = useScenarioEditor.getState();
  return {
    loadFromString: s.loadFromString,
    resetEmpty: s.resetEmpty,
    setName: s.setName,
    setCookieJar: s.setCookieJar,
    setVariable: s.setVariable,
    removeVariable: s.removeVariable,
    addStep: s.addStep,
    addLoopStep: s.addLoopStep,
    addStepInLoop: s.addStepInLoop,
    setLoopRepeat: s.setLoopRepeat,
    addIfStep: s.addIfStep,
    setIfCond: s.setIfCond,
    setElifCond: s.setElifCond,
    addStepInBranch: s.addStepInBranch,
    addLoopInBranch: s.addLoopInBranch,
    addIfInLoop: s.addIfInLoop,
    addElif: s.addElif,
    removeElif: s.removeElif,
    addParallelStep: s.addParallelStep,
    addBranch: s.addBranch,
    removeBranch: s.removeBranch,
    addStepInParallelBranch: s.addStepInParallelBranch,
    setBranchName: s.setBranchName,
    removeStep: s.removeStep,
    moveStep: s.moveStep,
    setStepField: s.setStepField,
    setStepAssert: s.setStepAssert,
    setStepExtract: s.setStepExtract,
    select: s.select,
    setActiveTab: s.setActiveTab,
    setPendingYamlText: s.setPendingYamlText,
    commitPendingYaml: s.commitPendingYaml,
    clearPendingYaml: s.clearPendingYaml,
  };
})();

(useScenarioEditor as unknown as { getInitialState: () => ScenarioEditorState }).getInitialState =
  () => ({ ...INITIAL, ...actions });
