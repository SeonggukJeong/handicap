import { describe, expect, it } from "vitest";
import {
  bandIndex,
  bandKey,
  enumerateBands,
  filterDropCandidates,
  findParentBand,
  hasNestedContainer,
  keyboardCandidateIds,
  legalTargetBands,
} from "../dropRules";
import { parseScenarioDoc } from "../yamlDoc";

// 전 컨테이너 유형 + 중첩 + 단일-자식 + 빈-else fixture. id는 유효 ULID 필수(I/L/O/U 제외).
// S1 http · L1 loop(l1a,l1b 전-http) · I1 if(then t1/elif0 e1/else x1 전-http)
// L2 loop(NestedIf NI(ni1) + l2b) · I2 if(then: NestedLoop NL(nl1), else i2e)
// L3 loop(only1 단일자식) · I3 if(then t3, else 없음) · P parallel(A:[pa1], B:[pb1,pb2])
const FX_YAML = `version: 1
name: fx
steps:
  - id: "01HX0000000000000000000001"
    name: s1
    type: http
    request: { method: GET, url: /s1 }
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
    elif:
      - cond: { left: "1", op: eq, right: "2" }
        then:
          - id: "01HX0000000000000000000007"
            name: e1
            type: http
            request: { method: GET, url: /e1 }
    else:
      - id: "01HX0000000000000000000008"
        name: x1
        type: http
        request: { method: GET, url: /x1 }
  - id: "01HX0000000000000000000009"
    name: L2
    type: loop
    repeat: 1
    do:
      - id: "01HX000000000000000000000A"
        name: NI
        type: if
        cond: { left: "1", op: eq, right: "1" }
        then:
          - id: "01HX000000000000000000000B"
            name: ni1
            type: http
            request: { method: GET, url: /ni1 }
      - id: "01HX000000000000000000000C"
        name: l2b
        type: http
        request: { method: GET, url: /l2b }
  - id: "01HX000000000000000000000D"
    name: I2
    type: if
    cond: { left: "1", op: eq, right: "1" }
    then:
      - id: "01HX000000000000000000000E"
        name: NL
        type: loop
        repeat: 1
        do:
          - id: "01HX000000000000000000000F"
            name: nl1
            type: http
            request: { method: GET, url: /nl1 }
    else:
      - id: "01HX000000000000000000000G"
        name: i2e
        type: http
        request: { method: GET, url: /i2e }
  - id: "01HX000000000000000000000H"
    name: L3
    type: loop
    repeat: 1
    do:
      - id: "01HX000000000000000000000J"
        name: only1
        type: http
        request: { method: GET, url: /only1 }
  - id: "01HX000000000000000000000K"
    name: I3
    type: if
    cond: { left: "1", op: eq, right: "1" }
    then:
      - id: "01HX000000000000000000000M"
        name: t3
        type: http
        request: { method: GET, url: /t3 }
  - id: "01HX000000000000000000000N"
    name: P
    type: parallel
    branches:
      - name: A
        steps:
          - id: "01HX000000000000000000000P"
            name: pa1
            type: http
            request: { method: GET, url: /pa1 }
      - name: B
        steps:
          - id: "01HX000000000000000000000Q"
            name: pb1
            type: http
            request: { method: GET, url: /pb1 }
          - id: "01HX000000000000000000000R"
            name: pb2
            type: http
            request: { method: GET, url: /pb2 }
`;

const parsed = parseScenarioDoc(FX_YAML);
if (!("model" in parsed)) throw new Error("fixture must parse");
const STEPS = parsed.model.steps;

const S1 = "01HX0000000000000000000001";
const L1 = "01HX0000000000000000000002";
const L1A = "01HX0000000000000000000003";
const I1 = "01HX0000000000000000000005";
const X1 = "01HX0000000000000000000008";
const L2 = "01HX0000000000000000000009";
const NI = "01HX000000000000000000000A";
const L3 = "01HX000000000000000000000H";
const ONLY1 = "01HX000000000000000000000J";
const I3 = "01HX000000000000000000000K";
const P = "01HX000000000000000000000N";
const PB1 = "01HX000000000000000000000Q";

describe("enumerateBands / findParentBand / bandIndex", () => {
  it("전 밴드를 열거하고 빈 else도 포함한다 (케이스 12 전제)", () => {
    const keys = enumerateBands(STEPS).map((b) => bandKey(b.ref));
    expect(keys).toContain("top");
    expect(keys).toContain(`${L1}:do`);
    expect(keys).toContain(`${I1}:then`);
    expect(keys).toContain(`${I1}:elif_0`);
    expect(keys).toContain(`${I1}:else`);
    expect(keys).toContain(`${NI}:then`);
    expect(keys).toContain(`${P}:branch_0`);
    expect(keys).toContain(`${P}:branch_1`);
    expect(keys).toContain(`${I3}:else`); // else 부재(default []) → 그래도 등록
  });

  it("findParentBand — top/do/elif/else/branch 정체", () => {
    expect(findParentBand(STEPS, S1)).toEqual({ parentId: null, band: "top" });
    expect(findParentBand(STEPS, L1A)).toEqual({ parentId: L1, band: "do" });
    expect(findParentBand(STEPS, "01HX0000000000000000000007")).toEqual({
      parentId: I1,
      band: "elif_0",
    });
    expect(findParentBand(STEPS, X1)).toEqual({ parentId: I1, band: "else" });
    expect(findParentBand(STEPS, PB1)).toEqual({ parentId: P, band: "branch_1" });
    expect(findParentBand(STEPS, "없는id")).toBeNull();
  });

  it("bandIndex는 행 id → bandKey 맵", () => {
    const idx = bandIndex(STEPS);
    expect(idx.get(S1)).toBe("top");
    expect(idx.get(L1A)).toBe(`${L1}:do`);
    expect(idx.get(PB1)).toBe(`${P}:branch_1`);
  });
});

describe("hasNestedContainer", () => {
  it("중첩 컨테이너 보유 판정", () => {
    const l1 = STEPS.find((s) => s.id === L1)!;
    const l2 = STEPS.find((s) => s.id === L2)!;
    const i2 = STEPS.find((s) => s.id === "01HX000000000000000000000D")!;
    expect(hasNestedContainer(l1)).toBe(false); // 전-http
    expect(hasNestedContainer(l2)).toBe(true); // NestedIf 보유
    expect(hasNestedContainer(i2)).toBe(true); // NestedLoop 보유
  });
});

describe("legalTargetBands — spec §5 매트릭스", () => {
  const legal = (id: string) => legalTargetBands(STEPS, id);

  it("① http는 loop do·if 분기·parallel 레인·최상위 전부 합법", () => {
    const s = legal(S1);
    expect(s.has("top")).toBe(true);
    expect(s.has(`${L1}:do`)).toBe(true);
    expect(s.has(`${I1}:then`)).toBe(true);
    expect(s.has(`${I1}:elif_0`)).toBe(true);
    expect(s.has(`${P}:branch_0`)).toBe(true);
    expect(s.has(`${NI}:then`)).toBe(true); // 중첩 밴드도 http는 OK
  });

  it("② 전-http loop → 최상위 if 분기 합법 / 전-http-분기 if(I1) → 최상위 loop do 합법", () => {
    expect(legal(L1).has(`${I1}:then`)).toBe(true);
    expect(legal(I1).has(`${L1}:do`)).toBe(true);
  });

  it("③④ 중첩 컨테이너를 품은 loop/if는 교차 진입 불법 (3단 차단)", () => {
    expect(legal(L2).has(`${I1}:then`)).toBe(false); // L2가 NestedIf 보유
    expect(legal("01HX000000000000000000000D").has(`${L1}:do`)).toBe(false); // I2가 NestedLoop 보유
  });

  it("⑤ 컨테이너는 중첩 컨테이너의 밴드로 불법 (중첩 밴드=http만)", () => {
    expect(legal(L1).has(`${NI}:then`)).toBe(false);
    expect(legal(I1).has(`${"01HX000000000000000000000E"}:do`)).toBe(false); // NL.do
  });

  it("⑥ loop/if는 parallel 레인 불법", () => {
    expect(legal(L1).has(`${P}:branch_0`)).toBe(false);
    expect(legal(I1).has(`${P}:branch_1`)).toBe(false);
  });

  it("⑦ parallel은 최상위(자기 밴드)만 — 어떤 밴드도 불법", () => {
    const s = legal(P);
    expect(s).toEqual(new Set(["top"]));
  });

  it("⑧ 자기 서브트리 밴드 불법 (사이클)", () => {
    expect(legal(L1).has(`${L1}:do`)).toBe(false);
    expect(legal(L2).has(`${NI}:then`)).toBe(false); // 자손 밴드
  });

  it("⑨ min(1) 밴드 마지막 자식은 자기 밴드만 (경계 밖 전부 불법)", () => {
    expect(legal(ONLY1)).toEqual(new Set([`${L3}:do`]));
  });

  it("⑨-예외 else 소스 마지막 자식은 경계 밖 합법", () => {
    const s = legal(X1); // I1.else의 유일 자식
    expect(s.has("top")).toBe(true);
    expect(s.has(`${L1}:do`)).toBe(true);
  });

  it("⑩ 중첩 컨테이너(NI) → 최상위 합법 (티어 승격; L2.do엔 l2b가 남아 min(1) 통과)", () => {
    expect(legal(NI).has("top")).toBe(true);
  });

  it("⑩-보강(P5a): NL은 I2.then의 유일 자식 — min(1)×중첩 interplay로 자기 밴드만", () => {
    expect(legal("01HX000000000000000000000E")).toEqual(
      new Set([`${"01HX000000000000000000000D"}:then`]),
    );
  });

  it("⑨-예외(P5b): 최상위 유일 스텝도 경계 밖 합법 (top은 min 제약 없음)", () => {
    const mini = parseScenarioDoc(`version: 1
name: mini
steps:
  - id: "01HX0000000000000000000001"
    name: solo
    type: http
    request: { method: GET, url: /solo }
  - id: "01HX0000000000000000000002"
    name: LX
    type: loop
    repeat: 1
    do:
      - id: "01HX0000000000000000000003"
        name: lx1
        type: http
        request: { method: GET, url: /lx1 }
`);
    if (!("model" in mini)) throw new Error("mini fixture must parse");
    // solo는 top의 2개 중 1개가 아니라… top 자체가 min 제약이 없음을 보이려면
    // LX.do로 진입 가능해야 한다(top이 min(1)처럼 취급되면 여기서 갇힌다).
    const s = legalTargetBands(mini.model.steps, "01HX0000000000000000000001");
    expect(s.has(`${"01HX0000000000000000000002"}:do`)).toBe(true);
  });

  it("자기 밴드는 항상 포함 (그룹내 재정렬 보존)", () => {
    expect(legal(S1).has("top")).toBe(true);
    expect(legal(L1A).has(`${L1}:do`)).toBe(true);
  });
});

describe("filterDropCandidates / keyboardCandidateIds", () => {
  it("포인터 후보 = 합법 밴드의 행 + 합법 placeholder만", () => {
    const legal = legalTargetBands(STEPS, S1);
    const idx = bandIndex(STEPS);
    const ids = [S1, L1, L1A, PB1, `band:${I3}:else`, `band:${I1}:then`, "없는id"];
    const out = filterDropCandidates(ids, legal, idx);
    expect(out).toContain(L1A); // 합법 밴드(L1:do)의 행
    expect(out).toContain(`band:${I3}:else`); // 합법 빈-else placeholder
    expect(out).not.toContain("없는id");
  });

  it("불법 밴드의 행은 후보 제외 — loop 드래그 시 parallel 레인 행 제외 (R3)", () => {
    const legal = legalTargetBands(STEPS, L1);
    const idx = bandIndex(STEPS);
    const out = filterDropCandidates([S1, PB1, "01HX000000000000000000000B"], legal, idx);
    expect(out).toContain(S1); // top 행
    expect(out).not.toContain(PB1); // parallel 레인
    expect(out).not.toContain("01HX000000000000000000000B"); // NI.then(중첩 밴드)
  });

  it("키보드 후보 = 기존 형제 그룹 제한 유지", () => {
    const out = keyboardCandidateIds(STEPS, L1A, [S1, L1, L1A, "01HX0000000000000000000004", PB1]);
    expect(out).toContain(L1A);
    expect(out).toContain("01HX0000000000000000000004");
    expect(out).not.toContain(S1);
    expect(out).not.toContain(PB1);
  });
});
