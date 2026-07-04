import { create } from "zustand";
import type { StoreApi } from "zustand";
import { Document } from "yaml";
import {
  type Extract,
  type Scenario,
  type Condition,
  findStepById,
  isParallelStep,
  topAncestorIndex,
} from "./model";
import { newStepId } from "./ulid";
import { applyEdit, parseScenarioDoc, serializeDoc, type Edit, type BranchSel } from "./yamlDoc";
import {
  collectProducedVars,
  collectNamespacedProducers,
  parallelExtractNames,
  buildVarRefIndex,
} from "./scanVars";

export type RenameVarError = "self" | "invalid" | "shadow" | "collision";

const STARTER_YAML = `version: 1
name: "Untitled"
cookie_jar: auto
variables: {}
steps: []
`;

export interface ScenarioEditorState {
  doc: Document | null;
  model: Scenario | null;
  yamlText: string;
  yamlError: string | null;

  selectedStepId: string | null;
  pendingYamlText: string | null;

  loadFromString(yaml: string): void;
  resetEmpty(): void;

  // Edit ops (mirror Edit variants)
  setName(value: string): void;
  setCookieJar(value: "auto" | "off"): void;
  setVariable(key: string, value: string): void;
  removeVariable(key: string): void;
  /** flat 변수(선언·비-parallel extract) rename. 선언 키 + 모든 extract.var + 모든
   *  {{old}} 참조(cast 보존) + 조건 오퍼랜드를 트랜잭셔널로 재작성. 실패 시 no-op +
   *  에러코드 반환(null=성공·커밋됨). yamlError·shadow·충돌·불법 newName에서 no-op. */
  renameVariable(oldName: string, newName: string): RenameVarError | null;
  addStep(name: string): string | null; // returns new id (null when yamlError)
  addLoopStep(name: string): string | null; // returns new loop id
  addStepInLoop(loopId: string, name: string): string | null; // returns new child id
  setLoopRepeat(loopId: string, repeat: number): void;
  addIfStep(name: string): string | null; // returns new if id
  setIfCond(ifId: string, cond: Condition): void;
  setElifCond(ifId: string, index: number, cond: Condition): void;
  addStepInBranch(ifId: string, branch: BranchSel, name: string): string | null; // returns child id
  addLoopInBranch(ifId: string, branch: BranchSel, name: string): string | null; // returns new loop id
  addIfInLoop(loopId: string, name: string): string | null; // returns new if id
  addElif(ifId: string): void;
  removeElif(ifId: string, index: number): void;
  addParallelStep(name: string): string | null; // returns new parallel id
  addBranch(parallelId: string): void;
  removeBranch(parallelId: string, index: number): void;
  addStepInParallelBranch(parallelId: string, branchIndex: number, name: string): string | null; // returns new child id
  setBranchName(parallelId: string, branchIndex: number, name: string): void;
  removeStep(stepId: string): void;
  moveStep(stepId: string, toIndex: number): void;
  reparentStep(
    stepId: string,
    target: { parentId: string | null; band: string; index: number },
  ): void;
  setStepField(stepId: string, path: ReadonlyArray<string>, value: unknown): void;
  setStepAssert(stepId: string, asserts: ReadonlyArray<{ kind: "status"; code: number }>): void;
  setStepExtract(stepId: string, extract: ReadonlyArray<Extract>): void;
  /** Append one extract to an http step (response-based extract authoring).
   *  Commits any pending Monaco buffer first; no-ops if the buffer is unparseable
   *  or the target step is missing / non-http (R7). */
  addStepExtract(stepId: string, extract: Extract): void;

  /** 준비된(재발급 완료) 템플릿 fragment를 선택 스텝의 최상위 조상 뒤(없으면 끝)에
   *  삽입. add* 계열처럼 첫 삽입 스텝 id를 반환 — 호출부가 select(id)로 자동 선택. */
  insertTemplateSteps(prepared: { preparedYaml: string; firstId: string }): string;

  // UI state
  select(id: string | null): void;

  // Monaco-driven (debounced) sync
  setPendingYamlText(text: string): void;
  commitPendingYaml(): void;
  clearPendingYaml(): void;
}

const INITIAL: Pick<
  ScenarioEditorState,
  "doc" | "model" | "yamlText" | "yamlError" | "selectedStepId" | "pendingYamlText"
> = {
  doc: null,
  model: null,
  yamlText: "",
  yamlError: null,
  selectedStepId: null,
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
  renameVariable(oldName, newName) {
    const doc = get().doc;
    const model = get().model;
    if (!doc || !model) return "invalid";
    if (get().yamlError !== null) return "invalid"; // 편집 게이트(R7) — 깨진 버퍼 중 무변이
    if (newName === oldName) return "self";
    if (!/^[^\s{}:]+$/.test(newName)) return "invalid";
    if (parallelExtractNames(model).has(oldName)) return "shadow"; // 슬라이스 B
    const collisions = new Set<string>([
      ...collectProducedVars(model),
      ...collectNamespacedProducers(model),
      ...buildVarRefIndex(model).keys(),
    ]);
    if (collisions.has(newName)) return "collision";
    // 트랜잭셔널(reparentStep 선례): clone → apply → reparse → 성공 시에만 커밋.
    const clone = doc.clone();
    applyEdit(clone, { type: "renameVariable", oldName, newName });
    const reparsed = parseScenarioDoc(serializeDoc(clone));
    if ("error" in reparsed) return "invalid"; // 합법성 게이트 — 원본 doc 무오염
    set({
      doc: reparsed.doc,
      model: reparsed.model,
      yamlText: serializeDoc(reparsed.doc),
      yamlError: null,
    });
    return null;
  },
  addStep(name) {
    if (get().yamlError !== null) return null; // 편집 게이트(R1) — phantom-select 방지
    const id = newStepId();
    dispatch(set, get, { type: "addStep", id, name });
    return id;
  },
  addLoopStep(name) {
    if (get().yamlError !== null) return null; // 편집 게이트(R1) — phantom-select 방지
    const id = newStepId();
    const childId = newStepId();
    dispatch(set, get, { type: "addLoopStep", id, name, childId });
    return id;
  },
  addStepInLoop(loopId, name) {
    if (get().yamlError !== null) return null; // 편집 게이트(R1) — phantom-select 방지
    const id = newStepId();
    dispatch(set, get, { type: "addStepInLoop", loopId, id, name });
    return id;
  },
  setLoopRepeat(loopId, repeat) {
    dispatch(set, get, { type: "setLoopRepeat", loopId, repeat });
  },
  addIfStep(name) {
    if (get().yamlError !== null) return null; // 편집 게이트(R1) — phantom-select 방지
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
    if (get().yamlError !== null) return null; // 편집 게이트(R1) — phantom-select 방지
    const id = newStepId();
    dispatch(set, get, { type: "addStepInBranch", ifId, branch, id, name });
    return id;
  },
  addLoopInBranch(ifId, branch, name) {
    if (get().yamlError !== null) return null; // 편집 게이트(R1) — phantom-select 방지
    const id = newStepId();
    const childId = newStepId();
    dispatch(set, get, { type: "addLoopInBranch", ifId, branch, id, name, childId });
    return id;
  },
  addIfInLoop(loopId, name) {
    if (get().yamlError !== null) return null; // 편집 게이트(R1) — phantom-select 방지
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
    if (get().yamlError !== null) return null; // 편집 게이트(R1) — phantom-select 방지
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
    if (get().yamlError !== null) return null; // 편집 게이트(R1) — phantom-select 방지
    const id = newStepId();
    dispatch(set, get, { type: "addStepInParallelBranch", parallelId, branchIndex, id, name });
    return id;
  },
  setBranchName(parallelId, branchIndex, name) {
    dispatch(set, get, { type: "setBranchName", parallelId, branchIndex, name });
  },
  removeStep(stepId) {
    if (get().yamlError !== null) return; // 편집 게이트(R1) — selection clear 이전
    if (get().selectedStepId === stepId) set({ selectedStepId: null });
    dispatch(set, get, { type: "removeStep", stepId });
  },
  moveStep(stepId, toIndex) {
    dispatch(set, get, { type: "moveStep", stepId, toIndex });
  },
  reparentStep(stepId, target) {
    const doc = get().doc;
    if (!doc) return;
    if (get().yamlError !== null) return; // 편집 게이트(R1)
    // 트랜잭셔널(spec R6): clone에 적용 → 재파싱 성공 시에만 커밋. generic dispatch는
    // in-place 변이 후 재파싱 실패 시 롤백이 없다(아래 dispatch 참조) — re-parent는
    // 불법 상태를 만들 수 있는 첫 edit라 원본 doc을 직접 변이하지 않는다.
    const clone = doc.clone();
    applyEdit(clone, { type: "reparentStep", stepId, ...target });
    const reparsed = parseScenarioDoc(serializeDoc(clone));
    if ("error" in reparsed) return; // 합법성 게이트(R2) 뚫린 버그 가드 — 상태 무변이 no-op
    set({
      doc: reparsed.doc,
      model: reparsed.model,
      yamlText: serializeDoc(reparsed.doc),
      yamlError: null,
    });
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
  addStepExtract(stepId, extract) {
    // (a) Commit any uncommitted Monaco buffer first — the test-run panel is reachable
    // below the YAML tab during the debounce window, so doc/model can be stale.
    if (get().pendingYamlText !== null) {
      get().commitPendingYaml();
      // Unparseable buffer: commitPendingYaml set yamlError and left doc/model stale.
      // Writing now would clobber the user's uncommitted edits — no-op instead.
      if (get().yamlError !== null) return;
    }
    const model = get().model;
    if (!model) return;
    const step = findStepById(model.steps, stepId);
    if (!step || step.type !== "http") return; // deleted or non-http target → no-op (R7)
    dispatch(set, get, {
      type: "setStepExtract",
      stepId,
      extract: [...step.extract, extract],
    });
  },
  insertTemplateSteps(prepared) {
    const afterTopIndex = topAncestorIndex(get().model?.steps ?? [], get().selectedStepId);
    dispatch(set, get, {
      type: "insertSteps",
      afterTopIndex,
      stepsYaml: prepared.preparedYaml,
    });
    return prepared.firstId;
  },

  select(id) {
    set({ selectedStepId: id });
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
  if (get().yamlError !== null) return; // 편집 게이트(R1): 깨진 YAML 버퍼 동안 무변이
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
    renameVariable: s.renameVariable,
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
    reparentStep: s.reparentStep,
    setStepField: s.setStepField,
    setStepAssert: s.setStepAssert,
    setStepExtract: s.setStepExtract,
    addStepExtract: s.addStepExtract,
    insertTemplateSteps: s.insertTemplateSteps,
    select: s.select,
    setPendingYamlText: s.setPendingYamlText,
    commitPendingYaml: s.commitPendingYaml,
    clearPendingYaml: s.clearPendingYaml,
  };
})();

(useScenarioEditor as unknown as { getInitialState: () => ScenarioEditorState }).getInitialState =
  () => ({ ...INITIAL, ...actions });
