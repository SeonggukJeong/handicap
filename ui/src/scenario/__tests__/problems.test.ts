import { describe, expect, it } from "vitest";
import { ko } from "../../i18n/ko";
import type { Step } from "../model";
import { collectProblems, formatGateMessages } from "../problems";
import { parseScenarioDoc } from "../yamlDoc";

const ULID_A = "01ARZ3NDEKTSV4RRFFQ69G5FA1";
const ULID_B = "01ARZ3NDEKTSV4RRFFQ69G5FA2";
const ULID_C = "01ARZ3NDEKTSV4RRFFQ69G5FA3";

function stepsOf(yaml: string): Step[] {
  const parsed = parseScenarioDoc(yaml);
  if (!("model" in parsed)) throw new Error(`fixture must parse: ${parsed.error}`);
  return parsed.model.steps;
}

describe("collectProblems — 모델-가용 항목", () => {
  it("빈 URL 스텝을 step 문제로 낸다", () => {
    const steps = stepsOf(`version: 1
name: s
steps:
  - type: http
    id: ${ULID_A}
    name: ping
    request:
      method: GET
      url: ""
`);
    expect(collectProblems(steps, null)).toEqual([
      { kind: "step", stepId: ULID_A, message: ko.editor.problemEmptyUrl("ping") },
    ]);
  });

  it("호스트 없는 / 시작 URL을 step 문제로 낸다 (addStep 시드 '/' 포함)", () => {
    const steps = stepsOf(`version: 1
name: s
steps:
  - type: http
    id: ${ULID_A}
    name: login
    request:
      method: GET
      url: /login
`);
    expect(collectProblems(steps, null)).toEqual([
      { kind: "step", stepId: ULID_A, message: ko.editor.problemHostlessUrl("login") },
    ]);
  });

  it("절대 URL·환경변수·흐름변수 URL은 문제로 내지 않는다", () => {
    // 주의: TS 템플릿 리터럴이라 ${BASE_URL}는 \${BASE_URL}로 이스케이프
    const steps = stepsOf(`version: 1
name: s
steps:
  - type: http
    id: ${ULID_A}
    name: a
    request:
      method: GET
      url: https://api.example.com/health
  - type: http
    id: ${ULID_B}
    name: b
    request:
      method: GET
      url: "\${BASE_URL}/login"
  - type: http
    id: ${ULID_C}
    name: c
    request:
      method: GET
      url: "{{base}}/x"
`);
    expect(collectProblems(steps, null)).toEqual([]);
  });

  it("컨테이너(loop) 안의 빈 URL도 검출한다 (flattenHttpSteps 재귀)", () => {
    const steps = stepsOf(`version: 1
name: s
steps:
  - type: loop
    id: ${ULID_A}
    name: l
    repeat: 2
    do:
      - type: http
        id: ${ULID_B}
        name: inner
        request:
          method: GET
          url: ""
`);
    expect(collectProblems(steps, null)).toEqual([
      { kind: "step", stepId: ULID_B, message: ko.editor.problemEmptyUrl("inner") },
    ]);
  });

  it("공백-only URL은 빈 URL로 본다 (trim 가드)", () => {
    const steps = stepsOf(`version: 1
name: s
steps:
  - type: http
    id: ${ULID_A}
    name: ws
    request:
      method: GET
      url: "   "
`);
    expect(collectProblems(steps, null)).toEqual([
      { kind: "step", stepId: ULID_A, message: ko.editor.problemEmptyUrl("ws") },
    ]);
  });

  it("프로토콜-상대 //host/path도 호스트-없음으로 본다 (엔진은 비절대 URL 해석 불가 — 의도 고정)", () => {
    const steps = stepsOf(`version: 1
name: s
steps:
  - type: http
    id: ${ULID_A}
    name: pr
    request:
      method: GET
      url: //api.example.com/health
`);
    expect(collectProblems(steps, null)).toEqual([
      { kind: "step", stepId: ULID_A, message: ko.editor.problemHostlessUrl("pr") },
    ]);
  });

  it("steps가 null(pre-load)이고 yamlError도 없으면 빈 배열", () => {
    expect(collectProblems(null, null)).toEqual([]);
  });
});

describe("collectProblems — 게이트 에러 short-circuit", () => {
  it("yamlError가 있으면 (stale) 모델 문제는 숨기고 게이트 항목만 낸다", () => {
    const steps = stepsOf(`version: 1
name: s
steps:
  - type: http
    id: ${ULID_A}
    name: ping
    request:
      method: GET
      url: ""
`);
    const out = collectProblems(steps, "steps.0.request.url: Required");
    expect(out).toEqual([{ kind: "gate", message: ko.editor.gateRequired("steps.0.request.url") }]);
  });
});

describe("formatGateMessages — Zod 원문 → 한국어 매핑 + fallback", () => {
  it("Required를 매핑한다", () => {
    expect(formatGateMessages("steps.0.request.url: Required")).toEqual([
      ko.editor.gateRequired("steps.0.request.url"),
    ]);
  });

  it("Invalid literal을 매핑한다 (version: 1)", () => {
    expect(formatGateMessages("version: Invalid literal value, expected 1")).toEqual([
      ko.editor.gateInvalidLiteral("version", "1"),
    ]);
  });

  it("invalid_type(Expected/received)을 매핑한다", () => {
    expect(formatGateMessages("steps.0.repeat: Expected number, received string")).toEqual([
      ko.editor.gateInvalidType("steps.0.repeat", "number", "string"),
    ]);
  });

  it("자체 superRefine 문구(name required / duplicate branch name)를 매핑한다", () => {
    expect(formatGateMessages("steps.0.name: step name required")).toEqual([
      ko.editor.gateNameRequired("steps.0.name"),
    ]);
    // superRefine issue path는 스텝 기준 ["branches", i, "name"] — 실제 join 결과는 아래 형식
    expect(formatGateMessages('steps.1.branches.1.name: duplicate branch name "b1"')).toEqual([
      ko.editor.gateDuplicateBranch("steps.1.branches.1.name", "b1"),
    ]);
  });

  it("여러 세그먼트를 분리하고, 미지의 문구는 원문 그대로 둔다", () => {
    expect(
      formatGateMessages("a: Required; Nested mappings are not allowed in compact mappings"),
    ).toEqual([ko.editor.gateRequired("a"), "Nested mappings are not allowed in compact mappings"]);
  });
});
