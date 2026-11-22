import { describe, expect, it } from "vitest";
import { ko } from "../../i18n/ko";
import { allSteps, setupSteps, type Scenario } from "../model";
import { collectProblems } from "../problems";
import { scanEnvVars, scanFlowVars, undefinedVarRefs, buildVarRefIndex } from "../scanVars";
import { evaluateTrust, isTrustApplicable } from "../trust";
import { executionFingerprint, fingerprintHash } from "../trustPrefs";
import { applyEdit, parseScenarioDoc, serializeDoc } from "../yamlDoc";

const S1 = "01ARZ3NDEKTSV4RRFFQ69G5FA1";
const S2 = "01ARZ3NDEKTSV4RRFFQ69G5FA2";
const S3 = "01ARZ3NDEKTSV4RRFFQ69G5FA3";

const LOGIN = `  - id: ${S1}
    name: 로그인
    type: http
    request:
      method: POST
      url: "\${BASE_URL}/login"
      body:
        json:
          id: "{{user}}"
    assert:
      - status: 200
    extract:
      - var: token
        from: body
        path: "$.token"
`;

const ORDERS = `  - id: ${S2}
    name: 주문 조회
    type: http
    request:
      method: GET
      url: "http://x/orders"
      headers:
        Authorization: "Bearer {{token}}"
    assert:
      - status: 200
`;

function docYaml(setupBlock: string, steps = ORDERS): string {
  return `version: 1\nname: s\n${setupBlock}steps:\n${steps}`;
}

function modelOf(yaml: string): Scenario {
  const parsed = parseScenarioDoc(yaml);
  if (!("model" in parsed)) throw new Error(`fixture must parse: ${parsed.error}`);
  return parsed.model;
}

const WITH_SETUP = docYaml(`setup:\n  steps:\n${LOGIN}`);

describe("setup 모델과 YAML", () => {
  it("setup이 있는 YAML을 읽으면 model.setup.steps가 채워진다", () => {
    const m = modelOf(WITH_SETUP);
    expect(m.setup?.steps.length).toBe(1);
    expect(setupSteps(m).map((s) => s.id)).toEqual([S1]);
    expect(allSteps(m).map((s) => s.id)).toEqual([S1, S2]);
  });

  it("setup: (null)은 준비 없음", () => {
    const m = modelOf(docYaml("setup:\n"));
    expect(m.setup).toBeUndefined();
    expect(setupSteps(m)).toEqual([]);
  });

  it("setup: {} 는 거절한다", () => {
    const r = parseScenarioDoc(docYaml("setup: {}\n"));
    expect("error" in r).toBe(true);
  });

  it("setup 아래 모르는 키는 거절한다", () => {
    const r = parseScenarioDoc(docYaml(`setup:\n  steps:\n${LOGIN}  every: 10\n`));
    expect("error" in r).toBe(true);
  });

  it("setup.steps에 loop이 있으면 거절한다", () => {
    const loop = `  - id: ${S3}
    name: 반복
    type: loop
    repeat: 2
    do:
      - id: ${S1}
        name: a
        type: http
        request:
          method: GET
          url: "http://x/a"
`;
    const r = parseScenarioDoc(docYaml(`setup:\n  steps:\n${loop}`));
    expect("error" in r).toBe(true);
  });

  it("준비 없는 문서를 편집해 직렬화해도 setup이라는 글자가 생기지 않는다", () => {
    const parsed = parseScenarioDoc(docYaml(""));
    if (!("doc" in parsed)) throw new Error("must parse");
    applyEdit(parsed.doc, { type: "setName", value: "바꿈" });
    const out = serializeDoc(parsed.doc);
    expect(out).toContain("바꿈");
    expect(out).not.toContain("setup");
    expect(parsed.model.setup).toBeUndefined();
  });
});

describe("collectProblems — 스텝 id 겹침", () => {
  it("setup과 steps를 통틀어 id가 겹치면 문제로 낸다", () => {
    const dup = docYaml(`setup:\n  steps:\n${LOGIN}`, ORDERS.replace(S2, S1));
    const m = modelOf(dup);
    const out = collectProblems(m.steps, null, setupSteps(m));
    expect(out).toContainEqual({ kind: "plain", message: ko.editor.problemDuplicateStepId(S1) });
  });

  it("준비 스텝의 빈 URL·스킴 없는 URL도 문제로 낸다(스텝 선택 연결 없음)", () => {
    const m = modelOf(
      docYaml(`setup:\n  steps:\n${LOGIN.replace('"${BASE_URL}/login"', '"/login"')}`),
    );
    const out = collectProblems(m.steps, null, setupSteps(m));
    expect(out).toContainEqual({
      kind: "plain",
      message: ko.editor.problemUrlNeedsScheme("로그인"),
    });
    const empty = modelOf(
      docYaml(`setup:\n  steps:\n${LOGIN.replace('"${BASE_URL}/login"', '""')}`),
    );
    expect(collectProblems(empty.steps, null, setupSteps(empty))).toContainEqual({
      kind: "plain",
      message: ko.editor.problemEmptyUrl("로그인"),
    });
  });

  it("변수로 시작하는 준비 스텝 URL은 경고하지 않는다", () => {
    const m = modelOf(WITH_SETUP);
    expect(collectProblems(m.steps, null, setupSteps(m))).toEqual([]);
  });

  it("겹치지 않으면 문제가 없다", () => {
    const m = modelOf(WITH_SETUP);
    expect(collectProblems(m.steps, null, setupSteps(m))).toEqual([]);
  });
});

describe("scanVars — 준비 스텝", () => {
  it("준비가 추출한 token을 본 스텝이 읽으면 정의 안 됨이 아니다", () => {
    expect([...undefinedVarRefs(modelOf(WITH_SETUP)).keys()]).not.toContain("token");
  });

  it("준비가 본 스텝의 추출을 읽으면 정의 안 됨이다", () => {
    const body = ORDERS.replace(
      "    assert:\n      - status: 200\n",
      '    assert:\n      - status: 200\n    extract:\n      - var: orderId\n        from: body\n        path: "$.id"\n',
    );
    const setup = LOGIN.replace('"{{user}}"', '"{{orderId}}"');
    const m = modelOf(docYaml(`setup:\n  steps:\n${setup}`, body));
    const undef = undefinedVarRefs(m);
    expect(undef.get("orderId")?.stepIds).toEqual([S1]);
  });

  it("준비 스텝의 참조도 색인에 든다", () => {
    const idx = buildVarRefIndex(modelOf(WITH_SETUP));
    expect(idx.get("user")).toEqual([S1]);
    expect(idx.get("token")).toEqual([S2]);
  });

  it("scanFlowVars가 준비 스텝만 쓰는 {{user}}를 돌려준다", () => {
    expect(scanFlowVars(modelOf(WITH_SETUP)).has("user")).toBe(true);
  });

  it("scanEnvVars가 준비 스텝의 ${BASE_URL}을 돌려준다", () => {
    expect(scanEnvVars(modelOf(WITH_SETUP)).has("BASE_URL")).toBe(true);
  });
});

describe("실행 지문 — 준비 스텝", () => {
  it("준비 스텝을 고치면 지문이 바뀐다", () => {
    const a = fingerprintHash(modelOf(WITH_SETUP));
    const b = fingerprintHash(modelOf(WITH_SETUP.replace("/login", "/signin")));
    expect(a).not.toBe(b);
  });

  it("준비 스텝이 없으면 지문 글자에 setup이 없다", () => {
    expect(executionFingerprint(modelOf(docYaml("")))).not.toContain("setup");
  });
});

describe("trust — 준비 스텝", () => {
  const NO_ASSERT_SETUP = docYaml(
    `setup:\n  steps:\n${LOGIN.replace("    assert:\n      - status: 200\n", "")}`,
  );

  it("준비 스텝에 상태 검증이 없으면 항목에 나온다", () => {
    const a = evaluateTrust(modelOf(NO_ASSERT_SETUP)).checks.find(
      (c) => c.id === "response_validation",
    );
    expect(a?.status).toBe("fail");
    expect(a?.steps.map((s) => s.id)).toEqual([S1]);
  });

  it("본 스텝에 없을 때와 같은 항목 모양이다", () => {
    const inBody = docYaml("", LOGIN.replace("    assert:\n      - status: 200\n", ""));
    const a = evaluateTrust(modelOf(inBody)).checks.find((c) => c.id === "response_validation");
    expect(a?.status).toBe("fail");
    expect(a?.steps.map((s) => s.id)).toEqual([S1]);
  });

  it("본 스텝이 비어도 준비 스텝만 있으면 평가 대상이다", () => {
    const m = modelOf(`version: 1\nname: s\nsetup:\n  steps:\n${LOGIN}steps: []\n`);
    expect(isTrustApplicable(m)).toBe(true);
  });
});
