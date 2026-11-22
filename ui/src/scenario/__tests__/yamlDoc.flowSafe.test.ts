import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseScenarioDoc, serializeDoc, applyEdit, type Edit } from "../yamlDoc";

// 서버(serde_yaml = libyaml)는 flow 표기(`{ }`·`[ ]`) 안에서 `?`·`:`로 시작하는 평문 글자를
// 키/값 표시로 읽는다 — `{ sec-ch-ua-mobile: ?0 }`는 파싱 오류, `{ ?c: 1 }`는 키가 조용히 `c`로 바뀐다.
// `yaml` 패키지(1.2)는 둘 다 따옴표 없이 쓴다.

const STARTER = `version: 1
name: "Untitled"
cookie_jar: auto
variables: {}
steps: []
`;

const STEP_ID = "01HX0000000000000000000001";

function docOf(src: string) {
  const r = parseScenarioDoc(src);
  if ("error" in r) throw new Error(r.error);
  return r.doc;
}

function edit(src: string, ...edits: Edit[]): string {
  const doc = docOf(src);
  for (const e of edits) applyEdit(doc, e);
  return serializeDoc(doc);
}

describe("빈 flow 컬렉션에 첫 항목을 넣으면 block 표기로 쓴다", () => {
  it("빈 시나리오에 스텝 추가 — 시나리오 전체가 flow 표기로 바뀌지 않는다", () => {
    const out = edit(STARTER, { type: "addStep", id: STEP_ID, name: "Step 1" });
    expect(out).toContain(`steps:\n  - id: ${STEP_ID}\n`);
    expect(out).not.toMatch(/[[{]\s*\n/);
  });

  it("빈 시나리오에 스텝 추가 뒤 `?`로 시작하는 헤더 값 — 평문 block 줄로 남는다", () => {
    const out = edit(
      STARTER,
      { type: "addStep", id: STEP_ID, name: "Step 1" },
      {
        type: "setStepField",
        stepId: STEP_ID,
        path: ["request", "headers"],
        value: { "sec-ch-ua-mobile": "?0", "Sec-Fetch-User": "?1" },
      },
    );
    expect(out).toContain("\n        sec-ch-ua-mobile: ?0\n        Sec-Fetch-User: ?1\n");
  });

  it("빈 `variables: {}`에 변수 추가 — block 표기", () => {
    const out = edit(STARTER, { type: "setVariable", key: "q", value: "?x" });
    expect(out).toContain("variables:\n  q: ?x\n");
  });

  it("항목이 이미 있는 flow 컬렉션은 표기를 바꾸지 않는다", () => {
    const src = STARTER.replace("variables: {}", "variables: { a: b }");
    const out = edit(src, { type: "setVariable", key: "c", value: "d" });
    expect(out).toContain("variables: { a: b, c: d }");
  });
});

describe("serializeDoc — flow 표기 안의 `?`·`:` 시작 글자는 따옴표로 감싼다", () => {
  const FLOW = `version: 1
name: demo
steps:
  [
    {
      id: ${STEP_ID},
      name: Step 1,
      type: http,
      request: { method: GET, url: /, headers: { a: b } },
      assert: [ { status: 200 } ]
    }
  ]
`;

  it("이미 flow 표기인 시나리오에 `?0` 헤더 값 — 따옴표가 붙고 값은 그대로", () => {
    const headers = {
      "sec-ch-ua-mobile": "?0",
      "Sec-Fetch-User": "?1",
      ":authority": "x",
      q: ":v",
    };
    const out = edit(FLOW, {
      type: "setStepField",
      stepId: STEP_ID,
      path: ["request", "headers"],
      value: headers,
    });
    expect(out).toContain('sec-ch-ua-mobile: "?0"');
    expect(out).toContain('Sec-Fetch-User: "?1"');
    expect(out).toContain('":authority": x');
    expect(out).toContain('q: ":v"');
    expect(parse(out).steps[0].request.headers).toEqual(headers);
  });

  it("flow 표기 안의 `?`로 시작하는 키도 감싼다", () => {
    const src = STARTER.replace("variables: {}", "variables: { a: b }");
    const out = edit(src, { type: "setVariable", key: "?c", value: "1" });
    expect(out).toContain('"?c": "1"');
  });

  it("flow 표기 안에 날 문자열로 들어간 `?` 값도 감싼다", () => {
    const src = STARTER.replace("variables: {}", "variables: { a: b }");
    const out = edit(src, { type: "setVariable", key: "c", value: "?x" });
    expect(out).toContain('variables: { a: b, c: "?x" }');
  });

  it("block 표기의 `?`·`:` 시작 값은 건드리지 않는다 (바이트 동일)", () => {
    const src = `version: 1
name: demo
variables:
  q: ?0
  r: :v
steps: []
`;
    expect(serializeDoc(docOf(src))).toBe(src);
  });

  // serde_yaml 0.9로 대조한 목록(후보 237개 중 `yaml`은 문자열 평문으로 쓰고 serde는 정수로 읽는 것 전부).
  const SERDE_INTS = ["0b1", "0b101", "+0b101", "-0b101", "+0o17", "-0o17", "+0x1F", "-0x1f"];

  it.each(SERDE_INTS)("block 표기에서도 서버가 정수로 읽는 %j 는 감싼다 (헤더 값)", (value) => {
    const out = edit(
      STARTER,
      { type: "addStep", id: STEP_ID, name: "Step 1" },
      {
        type: "setStepField",
        stepId: STEP_ID,
        path: ["request", "headers"],
        value: { "X-A": value },
      },
    );
    expect(out).toContain(`\n        X-A: "${value}"\n`);
  });

  it.each(SERDE_INTS)("날 문자열로 들어간 %j 변수 값도 감싼다", (value) => {
    const out = edit(STARTER, { type: "setVariable", key: "v", value });
    expect(out).toContain(`variables:\n  v: "${value}"\n`);
  });

  it.each(["0x1F", "0o17", "0b", "0b2", "+0x", "-0o8", "0B101", "a0b1", "+12", "1e3"])(
    "서버와 같게 읽히는 %j 의 표기는 `yaml` 기본 그대로",
    (value) => {
      const withGuard = edit(STARTER, { type: "setVariable", key: "v", value });
      const doc = docOf(STARTER);
      applyEdit(doc, { type: "setVariable", key: "v", value });
      expect(withGuard).toBe(String(doc));
    },
  );

  it("중간에 `?`·`:`가 든 flow 값은 건드리지 않는다", () => {
    const src = STARTER.replace("variables: {}", "variables: { u: http://a/b?c=1 }");
    expect(serializeDoc(docOf(src))).toBe(src);
  });
});
