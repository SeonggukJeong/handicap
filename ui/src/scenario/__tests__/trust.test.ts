import { describe, expect, it } from "vitest";
import { evaluateTrust, isTrustApplicable } from "../trust";
import { ScenarioModel, type Scenario } from "../model";

const A = "01HZZZZZZZZZZZZZZZZZZZZZZA";
const B = "01HZZZZZZZZZZZZZZZZZZZZZZB";

function sc(over: Record<string, unknown> = {}): Scenario {
  return ScenarioModel.parse({
    version: 1,
    name: "t",
    cookie_jar: "auto",
    variables: {},
    steps: [],
    ...over,
  });
}

function step(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: `s-${id.slice(-1)}`,
    type: "http",
    request: { method: "GET", url: "https://e.test/a", headers: {} },
    assert: [],
    extract: [],
    ...over,
  };
}

const OK = [{ kind: "status", code: 200 }];
/** 추출만 하고 아무도 안 씀 → C 실패 */
const DANGLING = { extract: [{ var: "tok", from: "body", path: "$.t" }] };
/** 어디서도 안 만드는 변수 참조 → B 실패 */
const UNDEF = { request: { method: "GET", url: "https://e.test/{{nope}}", headers: {} } };

describe("evaluateTrust — 진리표 (spec §5)", () => {
  it("행 1: B 실패면 A·C와 무관하게 weak", () => {
    expect(evaluateTrust(sc({ steps: [step(A, { ...UNDEF, assert: OK })] })).level).toBe("weak");
  });

  it("행 2: 검증 전무 + C 실패 = weak", () => {
    const r = evaluateTrust(sc({ steps: [step(A, DANGLING)] }));
    expect(r.noValidationAtAll).toBe(true);
    expect(r.level).toBe("weak");
  });

  it("행 3: 검증 전무 + C 통과/na = caution", () => {
    const r = evaluateTrust(sc({ steps: [step(A)] }));
    expect(r.noValidationAtAll).toBe(true);
    expect(r.level).toBe("caution");
  });

  it("행 4: 검증 부분 + C 실패 = caution (행 2와의 차이는 A의 전무/부분뿐)", () => {
    const r = evaluateTrust(sc({ steps: [step(A, { assert: OK }), step(B, DANGLING)] }));
    expect(r.noValidationAtAll).toBe(false);
    expect(r.level).toBe("caution");
  });

  it("행 5: 검증 부분 + C 통과/na = caution", () => {
    expect(evaluateTrust(sc({ steps: [step(A, { assert: OK }), step(B)] })).level).toBe("caution");
  });

  it("행 6: A 통과 + C 실패 = caution", () => {
    expect(evaluateTrust(sc({ steps: [step(A, { ...DANGLING, assert: OK })] })).level).toBe(
      "caution",
    );
  });

  it("행 7: 전부 통과 = good", () => {
    const r = evaluateTrust(sc({ steps: [step(A, { assert: OK })] }));
    expect(r.level).toBe("good");
    expect(r.failed).toBe(0);
  });
});

describe("evaluateTrust — 점검 상세", () => {
  it("A는 검증 없는 스텝의 id와 이름을 문서순으로 싣는다 (중첩 컨테이너 포함)", () => {
    const r = evaluateTrust(
      sc({
        steps: [
          {
            id: A,
            name: "p",
            type: "parallel",
            branches: [{ name: "b1", steps: [step(B)] }],
          },
        ],
      }),
    );
    const a = r.checks.find((c) => c.id === "response_validation");
    expect(a?.status).toBe("fail");
    expect(a?.steps).toEqual([{ id: B, name: "s-B" }]);
  });

  it("C는 na일 때 분모에서 빠진다 — extract가 없으면 applicable=2", () => {
    const r = evaluateTrust(sc({ steps: [step(A, { assert: OK })] }));
    expect(r.checks.find((c) => c.id === "broken_extract_chain")?.status).toBe("na");
    expect(r.applicable).toBe(2);
    expect(r.passed).toBe(2);
  });

  it("B·C는 스텝 칩 대신 개수만 싣는다 (spec D14)", () => {
    const r = evaluateTrust(sc({ steps: [step(A, { ...UNDEF, ...DANGLING })] }));
    const b = r.checks.find((c) => c.id === "undefined_vars");
    const c = r.checks.find((x) => x.id === "broken_extract_chain");
    expect(b?.count).toBe(1);
    expect(b?.steps).toEqual([]);
    expect(c?.count).toBe(1);
    expect(c?.steps).toEqual([]);
  });

  it("checks는 항상 3개, 고정 순서 A→B→C", () => {
    expect(evaluateTrust(sc({ steps: [step(A)] })).checks.map((c) => c.id)).toEqual([
      "response_validation",
      "undefined_vars",
      "broken_extract_chain",
    ]);
  });
});

describe("isTrustApplicable", () => {
  it("http 스텝이 없으면 false", () => {
    expect(isTrustApplicable(sc({ steps: [] }))).toBe(false);
  });
  it("http 스텝이 있으면 true", () => {
    expect(isTrustApplicable(sc({ steps: [step(A)] }))).toBe(true);
  });
});
