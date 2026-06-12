import { beforeEach, describe, expect, it } from "vitest";
import {
  extractStepsYaml,
  parseScenarioDoc,
  parseStepsFragment,
  prepareTemplateInsertion,
  reissueStepIdsInFragment,
} from "../yamlDoc";
import { parseDocument } from "yaml";
import { topAncestorIndex } from "../model";

// 26자 유효 ULID 생성기 (결정론): "01HX" + 0×19 + 3자리
let n = 0;
const genId = () => `01HX0000000000000000000${String(100 + n++)}`;

beforeEach(() => {
  n = 0;
});

// ⚠ 주석 위치 주의(reviewer 실증, yaml 2.9): 시퀀스 *선두* 주석은 items[0]이 아니라
// seq.commentBefore에 붙어 노드 이동을 따라오지 않는다 — 주석-보존 단언은 item *사이*
// 주석(다음 item의 commentBefore)으로만 한다.
const SCENARIO = `version: 1
name: src
steps:
  - id: 01HX0000000000000000000001
    name: Login
    type: http
    request:
      method: POST
      url: /login
    assert:
      - status: 200
  - id: 01HX0000000000000000000002
    name: Me
    type: http
    request:
      method: GET
      url: /me
  # loop comment
  - id: 01HX0000000000000000000003
    name: Loop
    type: loop
    repeat: 2
    do:
      - id: 01HX0000000000000000000004
        name: Inner
        type: http
        request:
          method: GET
          url: /inner
`;

// 중첩 4타입 + 주석 + `id`라는 이름의 헤더 키(오염 가드)
const NESTED_FRAGMENT = `# tpl comment
- id: AAA
  name: L
  type: loop
  repeat: 2
  do:
    - id: BBB
      name: inner
      type: http
      request:
        method: GET
        url: /x
        headers:
          id: keep-me
- id: CCC
  name: P
  type: parallel
  branches:
    - name: b1
      steps:
        - id: DDD
          name: pb
          type: http
          request:
            method: GET
            url: /p
- id: EEE
  name: C
  type: if
  cond:
    left: "{{a}}"
    op: eq
    right: "1"
  then:
    - id: FFF
      name: t1
      type: http
      request:
        method: GET
        url: /t
  elif:
    - cond:
        left: "{{a}}"
        op: eq
        right: "2"
      then:
        - id: GGG
          name: e1
          type: http
          request:
            method: GET
            url: /e
  else:
    - id: HHH
      name: el
      type: http
      request:
        method: GET
        url: /el
`;

describe("parseStepsFragment", () => {
  it("normalize 경유로 assert/body 와이어 모양을 통과시킨다", () => {
    const yaml = `- id: 01HX0000000000000000000001
  name: Login
  type: http
  request:
    method: POST
    url: /login
    body:
      json:
        user: "{{u}}"
  assert:
    - status: 200
`;
    const r = parseStepsFragment(yaml);
    expect("steps" in r).toBe(true);
    if ("steps" in r) {
      expect(r.steps).toHaveLength(1);
      const s = r.steps[0];
      expect(s.type).toBe("http");
      if (s.type === "http") {
        expect(s.assert).toEqual([{ kind: "status", code: 200 }]);
        expect(s.request.body).toEqual({ kind: "json", value: { user: "{{u}}" } });
      }
    }
  });

  it("빈 배열·비배열·2단 중첩(loop-in-loop)을 거부한다", () => {
    expect("error" in parseStepsFragment("[]\n")).toBe(true);
    expect("error" in parseStepsFragment("not: steps\n")).toBe(true);
    const loopInLoop = `- id: 01HX0000000000000000000001
  name: L
  type: loop
  repeat: 1
  do:
    - id: 01HX0000000000000000000002
      name: L2
      type: loop
      repeat: 1
      do:
        - id: 01HX0000000000000000000003
          name: x
          type: http
          request:
            method: GET
            url: /x
`;
    expect("error" in parseStepsFragment(loopInLoop)).toBe(true);
  });
});

describe("extractStepsYaml", () => {
  it("선택 인덱스의 노드만 주석 보존하며 스텝 배열 YAML로 추출한다", () => {
    const parsed = parseScenarioDoc(SCENARIO);
    if (!("model" in parsed)) throw new Error("scenario must parse");
    const yaml = extractStepsYaml(parsed.doc, [0, 2]);
    // item-간 주석(`# loop comment`)은 Loop 노드의 commentBefore라 노드를 따라온다
    expect(yaml).toContain("# loop comment");
    expect(yaml).toContain("Login");
    expect(yaml).toContain("Loop");
    expect(yaml).not.toContain("Me");
    // round-trip: 추출 결과는 그대로 유효한 fragment
    expect("steps" in parseStepsFragment(yaml)).toBe(true);
  });
});

describe("reissueStepIdsInFragment", () => {
  it("중첩 4타입 전부 재발급·유일 + headers의 id 키 비오염 + 주석 보존", () => {
    const doc = parseDocument(NESTED_FRAGMENT);
    const firstId = reissueStepIdsInFragment(doc, genId);
    const out = String(doc);
    // 원본 스텝 id 전부 소거
    for (const old of ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF", "GGG", "HHH"]) {
      expect(out).not.toMatch(new RegExp(`id: ${old}\\b`));
    }
    // 8개 스텝 = 8개 신규 id, 첫 id는 첫 스텝 것
    expect(n).toBe(8);
    expect(firstId).toBe("01HX0000000000000000000100");
    // 헤더 키 id는 그대로 (구조-인지 walk)
    expect(out).toContain("id: keep-me");
    // 주석 보존
    expect(out).toContain("# tpl comment");
  });
});

describe("prepareTemplateInsertion", () => {
  it("야생 비-ULID id 템플릿이 재발급 경유로 게이트를 통과한다 (재발급-후-검증 순서)", () => {
    const wild = `- id: login-1
  name: Login
  type: http
  request:
    method: GET
    url: /x
`;
    const r = prepareTemplateInsertion(wild, genId);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.firstId).toMatch(/^01HX/);
      expect(r.preparedYaml).not.toContain("login-1");
      expect(r.steps).toHaveLength(1);
    }
  });

  it("YAML 문법 오류·UI 게이트 불통은 ok:false", () => {
    expect(prepareTemplateInsertion("- id: [broken", genId).ok).toBe(false);
    // parallel-in-loop 류 UI 규칙 위반은 재발급 후에도 게이트가 거부
    const bad = `- id: x
  name: L
  type: loop
  repeat: 1
  do:
    - id: y
      name: P
      type: parallel
      branches:
        - name: b
          steps:
            - id: z
              name: s
              type: http
              request:
                method: GET
                url: /x
`;
    expect(prepareTemplateInsertion(bad, genId).ok).toBe(false);
  });
});

// if/parallel 내부 스텝을 포함하는 시나리오 (유효 ULID만 사용)
const NESTED_SCENARIO = `version: 1
name: nested
steps:
  - id: 01HX0000000000000000000010
    name: Http
    type: http
    request:
      method: GET
      url: /x
  - id: 01HX0000000000000000000011
    name: Parallel
    type: parallel
    branches:
      - name: b1
        steps:
          - id: 01HX0000000000000000000012
            name: pb
            type: http
            request:
              method: GET
              url: /p
  - id: 01HX0000000000000000000013
    name: If
    type: if
    cond:
      left: "{{a}}"
      op: eq
      right: "1"
    then:
      - id: 01HX0000000000000000000014
        name: t1
        type: http
        request:
          method: GET
          url: /t
    elif:
      - cond:
          left: "{{a}}"
          op: eq
          right: "2"
        then:
          - id: 01HX0000000000000000000015
            name: e1
            type: http
            request:
              method: GET
              url: /e
    else:
      - id: 01HX0000000000000000000016
        name: el
        type: http
        request:
          method: GET
          url: /el
`;

describe("topAncestorIndex", () => {
  it("중첩 스텝이면 최상위 조상 인덱스, 최상위면 자기 인덱스, 미발견/null이면 null", () => {
    const parsed = parseScenarioDoc(SCENARIO);
    if (!("model" in parsed)) throw new Error("scenario must parse");
    const steps = parsed.model.steps;
    expect(topAncestorIndex(steps, "01HX0000000000000000000002")).toBe(1); // 최상위
    expect(topAncestorIndex(steps, "01HX0000000000000000000004")).toBe(2); // loop 내부 → loop 인덱스
    expect(topAncestorIndex(steps, "01HX0000000000000000000999")).toBe(null);
    expect(topAncestorIndex(steps, null)).toBe(null);
  });

  it("if 내부 스텝 → if 컨테이너 인덱스, parallel 내부 스텝 → parallel 컨테이너 인덱스", () => {
    const parsed = parseScenarioDoc(NESTED_SCENARIO);
    if (!("model" in parsed)) throw new Error("scenario must parse");
    const steps = parsed.model.steps;
    // parallel 컨테이너는 인덱스 1, 내부 스텝 DDD → 1
    expect(topAncestorIndex(steps, "01HX0000000000000000000012")).toBe(1);
    // if 컨테이너는 인덱스 2, then 내부 스텝 FFF → 2
    expect(topAncestorIndex(steps, "01HX0000000000000000000014")).toBe(2);
    // elif then 내부 스텝 GGG → if 컨테이너 인덱스 2
    expect(topAncestorIndex(steps, "01HX0000000000000000000015")).toBe(2);
    // else 내부 스텝 HHH → if 컨테이너 인덱스 2
    expect(topAncestorIndex(steps, "01HX0000000000000000000016")).toBe(2);
  });
});
