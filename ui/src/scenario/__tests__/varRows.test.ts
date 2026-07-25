import { describe, expect, it } from "vitest";
import { buildVarRows } from "../varRows";
import { ScenarioModel, type Scenario } from "../model";

const A = "01HZZZZZZZZZZZZZZZZZZZZZZA";
const B = "01HZZZZZZZZZZZZZZZZZZZZZZB";

/** Global Constraint 8: 입력은 Record<string, unknown> — Partial<Scenario>는 type을 넓힌다. */
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

describe("buildVarRows", () => {
  it("model이 null이면 빈 배열", () => {
    expect(buildVarRows(null)).toEqual([]);
  });

  it("선언 변수는 declared 행 — 참조 스텝이 refIds에 담긴다", () => {
    const rows = buildVarRows(
      sc({
        variables: { host: "e.test" },
        steps: [step(A, { request: { method: "GET", url: "https://{{host}}/a", headers: {} } })],
      }),
    );
    expect(rows.find((r) => r.kind === "declared")).toMatchObject({
      name: "host",
      refIds: [A],
    });
  });

  it("추출했지만 아무도 안 쓰면 flat-extract 행의 refIds가 빈다", () => {
    const rows = buildVarRows(
      sc({ steps: [step(A, { extract: [{ var: "tok", from: "body", path: "$.t" }] })] }),
    );
    expect(rows.find((r) => r.kind === "flat-extract")).toMatchObject({
      name: "tok",
      refIds: [],
    });
  });

  it("추출 변수를 뒤 스텝이 쓰면 refIds가 채워진다", () => {
    const rows = buildVarRows(
      sc({
        steps: [
          step(A, { extract: [{ var: "tok", from: "body", path: "$.t" }] }),
          step(B, {
            request: {
              method: "GET",
              url: "https://e.test/b",
              headers: { Authorization: "{{tok}}" },
            },
          }),
        ],
      }),
    );
    expect(rows.find((r) => r.kind === "flat-extract")).toMatchObject({
      name: "tok",
      refIds: [B],
    });
  });

  it("어디서도 만들지 않는 변수를 참조하면 undefined 행", () => {
    const rows = buildVarRows(
      sc({
        steps: [
          step(A, { request: { method: "GET", url: "https://e.test/{{nope}}", headers: {} } }),
        ],
      }),
    );
    expect(rows.find((r) => r.kind === "undefined")).toMatchObject({ name: "nope" });
  });
});
