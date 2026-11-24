import { describe, expect, it } from "vitest";
import { flattenHttpSteps } from "../../scenario/model";
import { parseScenarioDoc } from "../../scenario/yamlDoc";
import { readScenarioFacts } from "../scenarioFacts";

const U = (c: string) => `01HZZZZZZZZZZZZZZZZZZZZZZ${c}`;

describe("readScenarioFacts", () => {
  it("lenient_reads_engine_serialized_yaml", () => {
    const y = `version: 1
name: 신청 흐름
steps:
  - id: ${U("A")}
    name: 로그인
    type: http
    request: { method: POST, url: "\${BASE_URL}/login" }
    assert:
      - status: 200
    extract:
      - from: body
        var: t
        path: $.t
  - id: ${U("B")}
    name: 조회
    type: http
    request: { method: GET, url: "\${BASE_URL}/q" }
    assert:
      - status: 200
      - status: 201
  - id: ${U("C")}
    name: 세 번째
    type: http
    request: { method: GET, url: "\${BASE_URL}/z" }
    extract:
      - from: status
        var: s
`;
    const f = readScenarioFacts(y);
    expect(f.ok).toBe(true);
    if (!f.ok) return;
    expect(f.name).toBe("신청 흐름");
    expect(f.steps.map((s) => s.statusChecks)).toEqual([[[200]], [[200], [201]], []]);
    expect(f.steps.map((s) => s.fallibleExtract)).toEqual([true, false, false]);
    expect(f.steps[0]).toMatchObject({ method: "POST", name: "로그인" });
  });

  it("목록·any·숫자 문자열 표기를 읽는다", () => {
    const y = `version: 1
name: n
steps:
  - id: s1
    name: x
    type: http
    request: { method: GET, url: "/x" }
    assert:
      - status: [200, 409]
      - status: any
      - status: "200"
`;
    const f = readScenarioFacts(y);
    expect(f.ok).toBe(true);
    if (!f.ok) return;
    expect(f.steps[0].statusChecks).toEqual([[200, 409], "any", [200]]);
  });

  it("order_matches_flatten", () => {
    const h = (c: string) =>
      `{ type: http, id: ${U(c)}, name: s${c}, request: { method: GET, url: "/x" } }`;
    const y = `version: 1
name: n
steps:
  - ${h("A")}
  - type: loop
    id: ${U("B")}
    name: L
    repeat: 2
    do:
      - ${h("C")}
  - type: if
    id: ${U("D")}
    name: I
    cond: { left: "{{a}}", op: eq, right: "1" }
    then:
      - ${h("E")}
    elif:
      - cond: { left: "{{a}}", op: eq, right: "2" }
        then:
          - ${h("F")}
    else:
      - ${h("G")}
  - type: parallel
    id: ${U("H")}
    name: P
    branches:
      - name: b1
        steps:
          - ${h("J")}
      - name: b2
        steps:
          - ${h("K")}
  - ${h("M")}
`;
    const parsed = parseScenarioDoc(y);
    expect(parsed).toHaveProperty("model");
    if (!("model" in parsed)) return;
    const f = readScenarioFacts(y);
    expect(f.ok).toBe(true);
    if (!f.ok) return;
    expect(f.steps.map((s) => s.id)).toEqual(flattenHttpSteps(parsed.model.steps).map((s) => s.id));
    expect(f.steps.length).toBe(8);
  });

  it("survives_zod_rejection", () => {
    const y = `version: 1
name: n
steps:
  - id: s1
    name: bad
    type: http
    request: { method: GET, url: "/x" }
    assert:
      - status: 700
`;
    expect("error" in parseScenarioDoc(y)).toBe(true);
    const f = readScenarioFacts(y);
    expect(f.ok).toBe(true);
    if (!f.ok) return;
    expect(f.steps[0].statusChecks).toEqual([[700]]);
    expect(f.steps[0].id).toBe("s1");
  });

  it("accepts_model_shape_and_ignores_garbage", () => {
    const y = `version: 1
name: n
steps:
  - id: s1
    name: x
    type: http
    request: { method: GET, url: "/x" }
    assert:
      - kind: status
        codes: [404]
      - kind: status_any
      - status: abc
      - status: 2.5
      - status: null
      - status: ""
      - status: true
`;
    const f = readScenarioFacts(y);
    expect(f.ok).toBe(true);
    if (!f.ok) return;
    expect(f.steps[0].statusChecks).toEqual([[404], "any"]);
  });

  it("준비 스텝의 사실은 setupSteps에 따로 담긴다", () => {
    const y = `version: 1
name: n
setup:
  steps:
    - id: S1
      name: 준비
      request: { method: POST, url: "https://auth.example/p" }
steps:
  - id: B1
    name: 본
    request: { method: GET, url: "https://api.example/b" }
`;
    const f = readScenarioFacts(y);
    expect(f.ok).toBe(true);
    if (!f.ok) return;
    expect(f.setupSteps.map((s) => s.id)).toEqual(["S1"]);
    expect(f.steps.map((s) => s.id)).toEqual(["B1"]);
  });

  it("setup이 없거나 모양이 이상해도 던지지 않는다", () => {
    for (const setup of ["null", "3", '{ steps: "x" }']) {
      const y = `version: 1
name: n
setup: ${setup}
steps:
  - id: B1
    name: 본
    request: { method: GET, url: "/b" }
`;
      const f = readScenarioFacts(y);
      expect(f.ok).toBe(true);
      if (!f.ok) return;
      expect(f.setupSteps).toEqual([]);
      expect(f.steps.map((s) => s.id)).toEqual(["B1"]);
    }
  });

  it("broken_yaml_is_not_ok", () => {
    expect(readScenarioFacts("steps: [\n")).toEqual({ ok: false });
    expect(readScenarioFacts("")).toEqual({ ok: true, name: null, steps: [], setupSteps: [] });
    expect(readScenarioFacts("hello")).toEqual({
      ok: true,
      name: null,
      steps: [],
      setupSteps: [],
    });
  });
});
