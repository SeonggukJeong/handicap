import { describe, expect, it } from "vitest";
import { loopJudgeMeta } from "../loopJudgeMeta";
import { parseScenarioDoc } from "../yamlDoc";

const L1 = "01HX0000000000000000000A01";
const L2 = "01HX0000000000000000000A02";
const L3 = "01HX0000000000000000000A03";
const H1 = "01HX0000000000000000000B01";
const G1 = "01HX0000000000000000000C01";

const YAML = `version: 1
name: sc
steps:
  - id: "${L1}"
    name: "주문 재시도"
    type: loop
    repeat: 3
    while: { left: "{{code}}", op: eq, right: "WAIT" }
    do:
      - id: "${H1}"
        name: "조회"
        type: http
        request: { method: GET, url: "https://h/x" }
  - id: "${L2}"
    name: "일반 반복"
    type: loop
    repeat: 2
    do:
      - id: "01HX0000000000000000000B02"
        name: "핑"
        type: http
        request: { method: GET, url: "https://h/y" }
  - id: "${G1}"
    name: "분기"
    type: if
    cond: { left: "{{a}}", op: eq, right: "1" }
    then:
      - id: "${L3}"
        name: "분기 안 반복"
        type: loop
        while: { left: "{{code}}", op: ne, right: "OK" }
        do:
          - id: "01HX0000000000000000000B03"
            name: "다시"
            type: http
            request: { method: GET, url: "https://h/z" }
`;

describe("loopJudgeMeta", () => {
  it("조건 반복 loop만 이름·최대 횟수와 함께 나온다 (최상위·if 분기 안 포함)", () => {
    const parsed = parseScenarioDoc(YAML);
    if ("error" in parsed) throw new Error(parsed.error);
    const meta = loopJudgeMeta(parsed.model);
    expect(meta).toEqual({
      [L1]: { name: "주문 재시도", maxPasses: 3 },
      [L3]: { name: "분기 안 반복", maxPasses: undefined },
    });
    expect(L2 in meta).toBe(false);
    expect(H1 in meta).toBe(false);
  });
});
