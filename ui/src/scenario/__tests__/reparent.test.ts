import { beforeEach, describe, expect, it } from "vitest";
import { computeReorder, resolveDrop } from "../reorder";
import { applyEdit, parseScenarioDoc, serializeDoc } from "../yamlDoc";
import { useScenarioEditor } from "../store";

// Task 1 fixture 축약판 — top: s1, L1(l1a,l1b), I1(then t1 / else 없음→빈 else), L3(only1)
const YAML = `version: 1
name: fx
steps:
  - id: "01HX0000000000000000000001"
    name: s1
    type: http
    request: { method: GET, url: /s1 }
  # keep-me — 노드 이동 시 주석 보존 단언용(P5c; 선두 아닌 item 주석은 노드에 붙는다)
  - id: "01HX0000000000000000000002"
    name: L1
    type: loop
    repeat: 2
    do:
      - id: "01HX0000000000000000000003"
        name: l1a
        type: http
        request: { method: GET, url: /a }
      - id: "01HX0000000000000000000004"
        name: l1b
        type: http
        request: { method: GET, url: /b }
  - id: "01HX0000000000000000000005"
    name: I1
    type: if
    cond: { left: "1", op: eq, right: "1" }
    then:
      - id: "01HX0000000000000000000006"
        name: t1
        type: http
        request: { method: GET, url: /t1 }
  - id: "01HX000000000000000000000H"
    name: L3
    type: loop
    repeat: 1
    do:
      - id: "01HX000000000000000000000J"
        name: only1
        type: http
        request: { method: GET, url: /only1 }
`;

const S1 = "01HX0000000000000000000001";
const L1 = "01HX0000000000000000000002";
const L1A = "01HX0000000000000000000003";
const L1B = "01HX0000000000000000000004";
const I1 = "01HX0000000000000000000005";
const T1 = "01HX0000000000000000000006";
const L3 = "01HX000000000000000000000H";

function freshModel() {
  const p = parseScenarioDoc(YAML);
  if (!("model" in p)) throw new Error("fixture must parse");
  return p;
}

// 리뷰 Important(bandSeqPath 정규식 라우팅 미커버): elif_{i}/branch_{i} 밴드 fixture.
// M1(top http) + IE(if: then t1 / elif[0].then e1) — elif_0 라우팅 전용.
const ELIF_YAML = `version: 1
name: fx-elif
steps:
  - id: "01HX0000000000000000000101"
    name: m1
    type: http
    request: { method: GET, url: /m1 }
  - id: "01HX0000000000000000000102"
    name: IE
    type: if
    cond: { left: "1", op: eq, right: "1" }
    then:
      - id: "01HX0000000000000000000103"
        name: t1
        type: http
        request: { method: GET, url: /t1 }
    elif:
      - cond: { left: "1", op: eq, right: "2" }
        then:
          - id: "01HX0000000000000000000104"
            name: e1
            type: http
            request: { method: GET, url: /e1 }
`;
const M1 = "01HX0000000000000000000101";
const IE = "01HX0000000000000000000102";
const E1 = "01HX0000000000000000000104";

// M2(top http) + PP(parallel: branch A=[pa1], branch B=[pb1,pb2]) — branch_1
// 라우팅 전용(branch_0 아닌 branch_1로 인덱스 라우팅을 실제로 구분).
const PARALLEL_YAML = `version: 1
name: fx-parallel
steps:
  - id: "01HX0000000000000000000201"
    name: m2
    type: http
    request: { method: GET, url: /m2 }
  - id: "01HX0000000000000000000202"
    name: PP
    type: parallel
    branches:
      - name: A
        steps:
          - id: "01HX0000000000000000000203"
            name: pa1
            type: http
            request: { method: GET, url: /pa1 }
      - name: B
        steps:
          - id: "01HX0000000000000000000204"
            name: pb1
            type: http
            request: { method: GET, url: /pb1 }
          - id: "01HX0000000000000000000205"
            name: pb2
            type: http
            request: { method: GET, url: /pb2 }
`;
const M2 = "01HX0000000000000000000201";
const PP = "01HX0000000000000000000202";
const PB1 = "01HX0000000000000000000204";
const PB2 = "01HX0000000000000000000205";

function freshElifModel() {
  const p = parseScenarioDoc(ELIF_YAML);
  if (!("model" in p)) throw new Error("elif fixture must parse");
  return p;
}

function freshParallelModel() {
  const p = parseScenarioDoc(PARALLEL_YAML);
  if (!("model" in p)) throw new Error("parallel fixture must parse");
  return p;
}

describe("resolveDrop — 같은 밴드 (N1 핀: computeReorder 동치)", () => {
  it("같은 밴드 드롭은 half와 무관하게 computeReorder 결과 verbatim", () => {
    const { model } = freshModel();
    const topIds = model.steps.map((s) => s.id);
    for (const overId of topIds) {
      for (const half of ["above", "below", null] as const) {
        const expected = computeReorder(topIds, S1, overId);
        const got = resolveDrop(model.steps, S1, overId, half);
        expect(got).toEqual(
          expected === null ? null : { kind: "move", stepId: S1, toIndex: expected },
        );
      }
    }
  });

  it("케이스 13: 컨테이너 헤더 행(over=L1, 같은 top 밴드) = 재정렬이지 밴드 진입 아님", () => {
    const { model } = freshModel();
    const got = resolveDrop(model.steps, S1, L1, "below");
    expect(got).toEqual({ kind: "move", stepId: S1, toIndex: 1 });
  });
});

describe("resolveDrop — 교차 밴드", () => {
  it("행 위 above/below → 그 행 앞/뒤 인덱스로 reparent", () => {
    const { model } = freshModel();
    expect(resolveDrop(model.steps, S1, L1A, "above")).toEqual({
      kind: "reparent",
      stepId: S1,
      target: { parentId: L1, band: "do", index: 0 },
    });
    expect(resolveDrop(model.steps, S1, L1A, "below")).toEqual({
      kind: "reparent",
      stepId: S1,
      target: { parentId: L1, band: "do", index: 1 },
    });
  });

  it("빈-else placeholder id → index 0 reparent (케이스 12)", () => {
    const { model } = freshModel();
    expect(resolveDrop(model.steps, S1, `band:${I1}:else`, null)).toEqual({
      kind: "reparent",
      stepId: S1,
      target: { parentId: I1, band: "else", index: 0 },
    });
  });

  it("컨테이너째 이동: L1(전-http) → I1.then의 t1 아래", () => {
    const { model } = freshModel();
    expect(resolveDrop(model.steps, L1, T1, "below")).toEqual({
      kind: "reparent",
      stepId: L1,
      target: { parentId: I1, band: "then", index: 1 },
    });
  });

  it("over null / 미지 id → null", () => {
    const { model } = freshModel();
    expect(resolveDrop(model.steps, S1, null, null)).toBeNull();
    expect(resolveDrop(model.steps, S1, "01HX000000000000000000ZZZZ", "above")).toBeNull();
  });
});

describe("applyEdit reparentStep — YAML AST verbatim 이동", () => {
  it("top http → loop.do (앞으로 이동해도 타깃 노드 참조가 유지된다)", () => {
    const { doc } = freshModel();
    applyEdit(doc, { type: "reparentStep", stepId: S1, parentId: L1, band: "do", index: 1 });
    const text = serializeDoc(doc);
    const reparsed = parseScenarioDoc(text);
    if (!("model" in reparsed)) throw new Error(`must reparse: ${text}`);
    const l1 = reparsed.model.steps.find((s) => s.id === L1)!;
    expect(l1.type === "loop" && l1.do.map((c) => c.id)).toEqual([L1A, S1, L1B]);
    expect(reparsed.model.steps.map((s) => s.id)).toEqual([L1, I1, L3]);
  });

  it("loop 자식 → 최상위 (티어 승격 방향)", () => {
    const { doc } = freshModel();
    applyEdit(doc, { type: "reparentStep", stepId: L1A, parentId: null, band: "top", index: 0 });
    const reparsed = parseScenarioDoc(serializeDoc(doc));
    if (!("model" in reparsed)) throw new Error("must reparse");
    expect(reparsed.model.steps[0].id).toBe(L1A);
    const l1 = reparsed.model.steps.find((s) => s.id === L1)!;
    expect(l1.type === "loop" && l1.do.map((c) => c.id)).toEqual([L1B]);
  });

  it("빈(부재) else로 이동 시 else seq를 block으로 생성", () => {
    const { doc } = freshModel();
    applyEdit(doc, { type: "reparentStep", stepId: S1, parentId: I1, band: "else", index: 0 });
    const text = serializeDoc(doc);
    expect(text).toContain("else:");
    const reparsed = parseScenarioDoc(text);
    if (!("model" in reparsed)) throw new Error("must reparse");
    const i1 = reparsed.model.steps.find((s) => s.id === I1)!;
    expect(i1.type === "if" && i1.else.map((c) => c.id)).toEqual([S1]);
  });

  it("전-http 컨테이너째 이동: L1 → I1.then (Loop↔NestedLoop YAML 동형 + 주석 동반 이동)", () => {
    const { doc } = freshModel();
    applyEdit(doc, { type: "reparentStep", stepId: L1, parentId: I1, band: "then", index: 1 });
    const text = serializeDoc(doc);
    expect(text).toContain("# keep-me"); // P5c: verbatim 노드 이동 = 노드-부착 주석 보존
    const reparsed = parseScenarioDoc(text);
    if (!("model" in reparsed)) throw new Error("must reparse");
    const i1 = reparsed.model.steps.find((s) => s.id === I1)!;
    expect(i1.type === "if" && i1.then.map((c) => c.id)).toEqual([T1, L1]);
  });

  it("이동 노드의 내용은 verbatim (repeat/do 보존)", () => {
    const { doc } = freshModel();
    applyEdit(doc, { type: "reparentStep", stepId: L1, parentId: I1, band: "then", index: 0 });
    const reparsed = parseScenarioDoc(serializeDoc(doc));
    if (!("model" in reparsed)) throw new Error("must reparse");
    const i1 = reparsed.model.steps.find((s) => s.id === I1)!;
    const moved = i1.type === "if" ? i1.then[0] : null;
    expect(moved && moved.type === "loop" && moved.repeat).toBe(2);
    expect(moved && moved.type === "loop" && moved.do.map((c) => c.id)).toEqual([L1A, L1B]);
  });

  it("top http → elif_0 밴드 (bandSeqPath의 elif_{i} 정규식 라우팅)", () => {
    const { doc } = freshElifModel();
    applyEdit(doc, { type: "reparentStep", stepId: M1, parentId: IE, band: "elif_0", index: 0 });
    const reparsed = parseScenarioDoc(serializeDoc(doc));
    if (!("model" in reparsed)) throw new Error("must reparse");
    const ie = reparsed.model.steps.find((s) => s.id === IE)!;
    expect(ie.type === "if" && ie.elif[0].then.map((c) => c.id)).toEqual([M1, E1]);
    // top-level에선 사라짐(다른 밴드 아님)
    expect(reparsed.model.steps.map((s) => s.id)).toEqual([IE]);
  });

  it("top http → branch_1 밴드 index 1 (bandSeqPath의 branch_{i} 정규식 라우팅)", () => {
    const { doc } = freshParallelModel();
    applyEdit(doc, {
      type: "reparentStep",
      stepId: M2,
      parentId: PP,
      band: "branch_1",
      index: 1,
    });
    const reparsed = parseScenarioDoc(serializeDoc(doc));
    if (!("model" in reparsed)) throw new Error("must reparse");
    const pp = reparsed.model.steps.find((s) => s.id === PP)!;
    expect(pp.type === "parallel" && pp.branches[1].steps.map((c) => c.id)).toEqual([PB1, M2, PB2]);
    // branch_0(A)은 무변경
    expect(pp.type === "parallel" && pp.branches[0].steps.map((c) => c.id)).toEqual([
      "01HX0000000000000000000203",
    ]);
  });
});

describe("store.reparentStep — 트랜잭셔널 (N3 핀)", () => {
  beforeEach(() => {
    useScenarioEditor.setState(useScenarioEditor.getInitialState());
  });

  it("합법 이동은 doc/model/yamlText 일괄 갱신", () => {
    useScenarioEditor.getState().loadFromString(YAML);
    useScenarioEditor.getState().reparentStep(S1, { parentId: L1, band: "do", index: 0 });
    const st = useScenarioEditor.getState();
    expect(st.yamlError).toBeNull();
    const l1 = st.model!.steps.find((s) => s.id === L1)!;
    expect(l1.type === "loop" && l1.do.map((c) => c.id)).toEqual([S1, L1A, L1B]);
    expect(st.yamlText).toContain("s1");
  });

  it("재파싱을 깨는 이동(마지막 자식 빼내기)은 상태 무변이 no-op", () => {
    useScenarioEditor.getState().loadFromString(YAML);
    const before = useScenarioEditor.getState().yamlText;
    // L3.do의 유일 자식을 최상위로 — do가 비어 min(1) 위반 → reparse 실패해야 함
    useScenarioEditor.getState().reparentStep("01HX000000000000000000000J", {
      parentId: null,
      band: "top",
      index: 0,
    });
    const st = useScenarioEditor.getState();
    expect(st.yamlText).toBe(before); // 트랜잭션: 원본 doc 무변이
    expect(st.yamlError).toBeNull(); // 에러 상태도 오염 없음 (조용한 no-op — 게이트는 R2가 담당)
    const l3 = st.model!.steps.find((s) => s.id === L3)!;
    expect(l3.type === "loop" && l3.do).toHaveLength(1);
  });
});
