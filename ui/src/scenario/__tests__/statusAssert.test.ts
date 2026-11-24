import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";
import { applyEdit, parseScenarioDoc, serializeDoc, type Edit } from "../yamlDoc";
import { assertionLabel } from "../assertLabel";

const ID1 = "01HX0000000000000000000001";
const ID2 = "01HX0000000000000000000002";
const ID3 = "01HX0000000000000000000003";
const ID4 = "01HX0000000000000000000004";

const mk = (assertBlock: string) => `version: 1
name: "demo"
cookie_jar: auto
variables: {}
steps:
  - id: "${ID1}"
    name: "a"
    type: http
    request:
      method: GET
      url: "/a"
${assertBlock}
`;

function firstAssert(src: string) {
  const out = parseScenarioDoc(src);
  if ("error" in out) throw new Error(out.error);
  const s = out.model.steps[0];
  if (s.type !== "http") throw new Error("expected http");
  return s.assert;
}

function write(edit: Edit): string {
  const out = parseScenarioDoc(mk(""));
  if ("error" in out) throw new Error(out.error);
  applyEdit(out.doc, edit);
  return serializeDoc(out.doc);
}

describe("상태 코드 검사 — 읽기", () => {
  it("숫자·목록·any를 읽는다", () => {
    expect(firstAssert(mk("    assert:\n      - status: 200"))).toEqual([
      { kind: "status", codes: [200] },
    ]);
    expect(firstAssert(mk("    assert:\n      - status: [200, 409]"))).toEqual([
      { kind: "status", codes: [200, 409] },
    ]);
    expect(firstAssert(mk("    assert:\n      - status: any"))).toEqual([{ kind: "status_any" }]);
  });

  it("빈 목록은 시나리오 파싱 오류", () => {
    const out = parseScenarioDoc(mk("    assert:\n      - status: []"));
    expect("error" in out).toBe(true);
  });
});

describe("상태 코드 검사 — 쓰기", () => {
  it("코드 하나는 숫자", () => {
    const y = write({
      type: "setStepAssert",
      stepId: ID1,
      asserts: [{ kind: "status", codes: [200] }],
    });
    expect(y).toMatch(/- status: 200$/m);
  });

  it("코드 둘은 flow 목록", () => {
    const y = write({
      type: "setStepAssert",
      stepId: ID1,
      asserts: [{ kind: "status", codes: [200, 409] }],
    });
    expect(y).toMatch(/- status: \[ ?200, 409 ?\]$/m);
    expect(firstAssert(y)).toEqual([{ kind: "status", codes: [200, 409] }]);
  });

  it("any는 따옴표 없이", () => {
    const y = write({ type: "setStepAssert", stepId: ID1, asserts: [{ kind: "status_any" }] });
    expect(y).toMatch(/- status: any$/m);
    expect(firstAssert(y)).toEqual([{ kind: "status_any" }]);
  });

  it("빈 배열은 assert: []", () => {
    const y = write({ type: "setStepAssert", stepId: ID1, asserts: [] });
    expect(y).toMatch(/assert: \[\]/);
  });
});

describe("상태 코드 검사 — 손대지 않은 스텝 보존", () => {
  it("[200, 200]·[200]·any·주석이 그대로다", () => {
    const src = `version: 1
name: "demo"
cookie_jar: auto
variables: {}
steps:
  - id: "${ID1}"
    name: "a"
    type: http
    request:
      method: GET
      url: "/a"
    assert:
      - status: [200, 200]  # 둘
  - id: "${ID2}"
    name: "b"
    type: http
    request:
      method: GET
      url: "/b"
    assert:
      - status: [200]
  - id: "${ID3}"
    name: "c"
    type: http
    request:
      method: GET
      url: "/c"
    assert:
      - status: any
  - id: "${ID4}"
    name: "d"
    type: http
    request:
      method: GET
      url: "/d"
`;
    const out = parseScenarioDoc(src);
    if ("error" in out) throw new Error(out.error);
    const reference = String(parseDocument(src));
    applyEdit(out.doc, { type: "setStepField", stepId: ID4, path: ["name"], value: "d2" });
    const after = serializeDoc(out.doc);
    // 기준 = 손대지 않은 문서를 다시 쓴 결과. 달라지는 줄은 이름 줄 하나뿐.
    const refLines = reference.split("\n");
    const afterLines = after.split("\n");
    expect(afterLines).toHaveLength(refLines.length);
    const diff = afterLines.filter((l, i) => l !== refLines[i]);
    expect(diff).toHaveLength(1);
    expect(diff[0]).toContain("d2");
    expect(after).toMatch(/- status: \[ ?200, 200 ?\]\s+# 둘/);
    expect(after).toMatch(/- status: \[ ?200 ?\]$/m);
    expect(after).toMatch(/- status: any$/m);
    const m = parseScenarioDoc(after);
    if ("error" in m) throw new Error(m.error);
    const asserts = m.model.steps.map((s) => (s.type === "http" ? s.assert : null));
    expect(asserts[0]).toEqual([{ kind: "status", codes: [200, 200] }]);
    expect(asserts[1]).toEqual([{ kind: "status", codes: [200] }]);
    expect(asserts[2]).toEqual([{ kind: "status_any" }]);
  });
});

describe("assertionLabel", () => {
  it("코드 목록은 가운뎃점으로 잇는다", () => {
    expect(assertionLabel({ kind: "status", codes: [200, 409] })).toBe("200·409");
    expect(assertionLabel({ kind: "status", codes: [201] })).toBe("201");
  });
  it("status_any는 보지 않음", () => {
    expect(assertionLabel({ kind: "status_any" })).toBe("보지 않음");
  });
});
