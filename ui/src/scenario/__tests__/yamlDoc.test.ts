import { describe, expect, it } from "vitest";
import {
  parseScenarioDoc,
  serializeDoc,
  applyEdit,
  renameScenarioYaml,
  type Edit,
} from "../yamlDoc";
import { useScenarioEditor } from "../store";
import type { GenSpec } from "../genVars";

const VALID_YAML = `version: 1
name: "demo"
cookie_jar: auto
variables:
  base_url: "http://localhost:8080"
steps:
  - id: "01HX0000000000000000000001"
    name: "login"
    type: http
    request:
      method: POST
      url: "{{base_url}}/login"
      headers:
        Content-Type: application/json
      body:
        json:
          username: "user"
    assert:
      - status: 200
    extract:                # comment on a Slice-4 key we must not lose
      - var: token
        from: body
        path: "$.token"
  - id: "01HX0000000000000000000002"
    name: "profile"
    type: http
    request:
      method: GET
      url: "{{base_url}}/me"
    assert:
      - status: 200
`;

describe("parseScenarioDoc", () => {
  it("parses a valid scenario and returns a model + doc", () => {
    const out = parseScenarioDoc(VALID_YAML);
    if ("error" in out) throw new Error(`expected ok: ${out.error}`);
    expect(out.model.steps).toHaveLength(2);
    const s0 = out.model.steps[0];
    if (s0.type !== "http") throw new Error("expected http step");
    expect(s0.request.method).toBe("POST");
    expect(s0.assert).toEqual([{ kind: "status", code: 200 }]);
  });

  it("doc preserves the raw yaml extract key and comment", () => {
    const out = parseScenarioDoc(VALID_YAML);
    if ("error" in out) throw new Error("expected ok");
    // doc still has it
    const round = serializeDoc(out.doc);
    expect(round).toContain("extract:");
    expect(round).toContain("var: token");
  });

  it("returns an error for invalid yaml syntax", () => {
    const out = parseScenarioDoc(":\n  ::");
    expect("error" in out).toBe(true);
  });

  it("returns an error for valid yaml that fails schema", () => {
    const out = parseScenarioDoc("version: 1\nname: ''\nsteps: []\n");
    expect("error" in out).toBe(true);
  });

  it("preserves request.disabled (headers + form) into the parsed model", () => {
    const yaml = `version: 1
name: t
steps:
  - id: "01HX0000000000000000000001"
    name: s
    type: http
    request:
      method: POST
      url: https://api/x
      headers:
        A: "1"
      body:
        form:
          keep: "1"
      disabled:
        headers:
          X-Off: "h"
        form:
          skip: "2"
`;
    const out = parseScenarioDoc(yaml);
    if (!("model" in out)) throw new Error(out.error);
    const step = out.model.steps[0];
    if (step.type !== "http") throw new Error("expected http step");
    expect(step.request.disabled?.headers).toEqual({ "X-Off": "h" });
    expect(step.request.disabled?.form).toEqual({ skip: "2" });
    expect(step.request.headers).toEqual({ A: "1" }); // active unaffected
  });
});

describe("applyEdit — setStepField", () => {
  it("changes the method of step 0 without touching other keys or comments", () => {
    const out = parseScenarioDoc(VALID_YAML);
    if ("error" in out) throw new Error("expected ok");
    const edit: Edit = {
      type: "setStepField",
      stepId: "01HX0000000000000000000001",
      path: ["request", "method"],
      value: "PUT",
    };
    applyEdit(out.doc, edit);
    const round = serializeDoc(out.doc);
    expect(round).toContain("method: PUT");
    expect(round).toContain("# comment on a Slice-4 key we must not lose");
    expect(round).toContain('path: "$.token"');
  });

  it("sets a nested header value", () => {
    const out = parseScenarioDoc(VALID_YAML);
    if ("error" in out) throw new Error("expected ok");
    applyEdit(out.doc, {
      type: "setStepField",
      stepId: "01HX0000000000000000000002",
      path: ["request", "headers"],
      value: { "X-Trace": "1" },
    });
    const round = serializeDoc(out.doc);
    expect(round).toMatch(/X-Trace:\s*"?1"?/);
  });

  it("per-step think_time survives set → serialize → parse → normalize (not write-only)", () => {
    const out = parseScenarioDoc(VALID_YAML);
    if ("error" in out) throw new Error(`expected ok: ${out.error}`);
    const stepId = out.model.steps[0].id; // first http step's ULID
    applyEdit(out.doc, {
      type: "setStepField",
      stepId,
      path: ["think_time"],
      value: { min_ms: 100, max_ms: 500 },
    });
    const yaml = serializeDoc(out.doc);
    expect(yaml).toContain("min_ms: 100"); // write path

    const reparsed = parseScenarioDoc(yaml);
    if ("error" in reparsed) throw new Error(`reparse failed: ${reparsed.error}`);
    const step = reparsed.model.steps[0];
    // read passthrough: normalizeStep must carry think_time, and Zod must accept it
    expect(step.type === "http" ? step.think_time : undefined).toEqual({
      min_ms: 100,
      max_ms: 500,
    });
  });

  it("is a silent no-op when the stepId is not in the tree (stale stepId)", () => {
    const out = parseScenarioDoc(VALID_YAML);
    if ("error" in out) throw new Error("expected ok");
    const before = serializeDoc(out.doc);
    applyEdit(out.doc, {
      type: "setStepField",
      stepId: "01HX0000000000000000000999", // 트리에 없는 ULID
      path: ["request", "method"],
      value: "DELETE",
    });
    expect(serializeDoc(out.doc)).toBe(before); // doc 직렬화 불변
  });
});

describe("applyEdit — addStep and removeStep", () => {
  it("appends a new step with given id", () => {
    const out = parseScenarioDoc(VALID_YAML);
    if ("error" in out) throw new Error("expected ok");
    applyEdit(out.doc, {
      type: "addStep",
      id: "01HX0000000000000000000003",
      name: "fresh",
    });
    const round = serializeDoc(out.doc);
    expect(round).toContain("01HX0000000000000000000003");
    expect(round).toContain("name: fresh");
    const out2 = parseScenarioDoc(round);
    if ("error" in out2) throw new Error("re-parse failed");
    expect(out2.model.steps).toHaveLength(3);
    expect(out2.model.steps[2].id).toBe("01HX0000000000000000000003");
  });

  it("removes step by id and preserves untouched comments", () => {
    const out = parseScenarioDoc(VALID_YAML);
    if ("error" in out) throw new Error("expected ok");
    applyEdit(out.doc, {
      type: "removeStep",
      stepId: "01HX0000000000000000000001",
    });
    const round = serializeDoc(out.doc);
    expect(round).not.toContain("01HX0000000000000000000001");
    expect(round).toContain("01HX0000000000000000000002");
    const out2 = parseScenarioDoc(round);
    if ("error" in out2) throw new Error("re-parse failed");
    expect(out2.model.steps).toHaveLength(1);
  });
});

describe("applyEdit — moveStep", () => {
  it("swaps steps by id", () => {
    const out = parseScenarioDoc(VALID_YAML);
    if ("error" in out) throw new Error("expected ok");
    applyEdit(out.doc, {
      type: "moveStep",
      stepId: "01HX0000000000000000000002",
      toIndex: 0,
    });
    const round = serializeDoc(out.doc);
    const out2 = parseScenarioDoc(round);
    if ("error" in out2) throw new Error("re-parse failed");
    expect(out2.model.steps[0].id).toBe("01HX0000000000000000000002");
    expect(out2.model.steps[1].id).toBe("01HX0000000000000000000001");
  });
});

describe("applyEdit — setVariable / removeVariable / setName / setCookieJar", () => {
  it("sets a variable", () => {
    const out = parseScenarioDoc(VALID_YAML);
    if ("error" in out) throw new Error("expected ok");
    applyEdit(out.doc, { type: "setVariable", key: "token", value: "abc" });
    const round = serializeDoc(out.doc);
    expect(round).toMatch(/token:\s*abc/);
  });

  it("removes a variable", () => {
    const out = parseScenarioDoc(VALID_YAML);
    if ("error" in out) throw new Error("expected ok");
    applyEdit(out.doc, { type: "removeVariable", key: "base_url" });
    const round = serializeDoc(out.doc);
    expect(round).not.toContain("base_url:");
  });

  it("renames the scenario", () => {
    const out = parseScenarioDoc(VALID_YAML);
    if ("error" in out) throw new Error("expected ok");
    applyEdit(out.doc, { type: "setName", value: "renamed" });
    const round = serializeDoc(out.doc);
    expect(round).toContain("name: renamed");
  });

  it("toggles cookie_jar", () => {
    const out = parseScenarioDoc(VALID_YAML);
    if ("error" in out) throw new Error("expected ok");
    applyEdit(out.doc, { type: "setCookieJar", value: "off" });
    const round = serializeDoc(out.doc);
    expect(round).toContain("cookie_jar: off");
  });
});

describe("applyEdit — setVariableGen (스칼라↔맵)", () => {
  it("writes a generator spec as a YAML map that round-trips into the model as a GenSpec", () => {
    const out = parseScenarioDoc(VALID_YAML);
    if ("error" in out) throw new Error("expected ok");
    applyEdit(out.doc, {
      type: "setVariableGen",
      key: "checkin",
      spec: { gen: "date", format: "%Y-%m-%d", tz: "Asia/Seoul" },
    });
    const round = serializeDoc(out.doc);
    expect(round).toContain("gen: date");
    const reparsed = parseScenarioDoc(round);
    if ("error" in reparsed) throw new Error(`reparse failed: ${reparsed.error}`);
    expect(reparsed.model.variables.checkin).toEqual({
      gen: "date",
      format: "%Y-%m-%d",
      tz: "Asia/Seoul",
    });
  });

  it("switching a generator variable to setVariable collapses the map back to a plain scalar (no leftover map keys)", () => {
    const out = parseScenarioDoc(VALID_YAML);
    if ("error" in out) throw new Error("expected ok");
    applyEdit(out.doc, { type: "setVariableGen", key: "checkin", spec: { gen: "uuid" } });
    applyEdit(out.doc, { type: "setVariable", key: "checkin", value: "v" });
    const round = serializeDoc(out.doc);
    expect(round).toMatch(/\bcheckin:\s*v\b/);
    expect(round).not.toContain("gen:"); // 맵 키 잔존 없음
    const reparsed = parseScenarioDoc(round);
    if ("error" in reparsed) throw new Error(`reparse failed: ${reparsed.error}`);
    expect(reparsed.model.variables.checkin).toBe("v");
  });

  it("re-calling setVariableGen on the same key replaces the generator params", () => {
    const out = parseScenarioDoc(VALID_YAML);
    if ("error" in out) throw new Error("expected ok");
    applyEdit(out.doc, {
      type: "setVariableGen",
      key: "qty",
      spec: { gen: "random_int", min: 1, max: 10 },
    });
    applyEdit(out.doc, {
      type: "setVariableGen",
      key: "qty",
      spec: { gen: "random_int", min: 100, max: 200, step: 10 },
    });
    const reparsed = parseScenarioDoc(serializeDoc(out.doc));
    if ("error" in reparsed) throw new Error(`reparse failed: ${reparsed.error}`);
    expect(reparsed.model.variables.qty).toEqual({
      gen: "random_int",
      min: 100,
      max: 200,
      step: 10,
    });
  });

  it("removeVariable/renameVariable operate on a generator row (rename preserves the value map + comment)", () => {
    const out = parseScenarioDoc(VALID_YAML);
    if ("error" in out) throw new Error("expected ok");
    applyEdit(out.doc, {
      type: "setVariableGen",
      key: "orderRef",
      spec: { gen: "uuid" },
    });
    applyEdit(out.doc, { type: "renameVariable", oldName: "orderRef", newName: "orderId" });
    let round = serializeDoc(out.doc);
    expect(round).toContain("gen: uuid");
    expect(round).toMatch(/\borderId:/);
    expect(round).not.toMatch(/\borderRef:/);

    applyEdit(out.doc, { type: "removeVariable", key: "orderId" });
    round = serializeDoc(out.doc);
    expect(round).not.toMatch(/\borderId:/);
    expect(round).not.toContain("gen: uuid");
  });

  it("does not create YAML anchors/aliases when the same spec object is applied to two keys", () => {
    const out = parseScenarioDoc(VALID_YAML);
    if ("error" in out) throw new Error("expected ok");
    const spec: GenSpec = { gen: "uuid" };
    applyEdit(out.doc, { type: "setVariableGen", key: "a", spec });
    applyEdit(out.doc, { type: "setVariableGen", key: "b", spec });
    const round = serializeDoc(out.doc);
    expect(round).not.toContain("&");
    expect(round).not.toContain("*");
    const reparsed = parseScenarioDoc(round);
    if ("error" in reparsed) throw new Error(`reparse failed: ${reparsed.error}`);
    expect(reparsed.model.variables.a).toEqual({ gen: "uuid" });
    expect(reparsed.model.variables.b).toEqual({ gen: "uuid" });
  });

  it("leaves other variables' values and comments untouched (targeted edit)", () => {
    const yaml = `version: 1
name: "demo"
cookie_jar: auto
variables:
  base_url: "http://localhost:8080" # keep me
  token: "abc"
steps: []
`;
    const out = parseScenarioDoc(yaml);
    if ("error" in out) throw new Error("expected ok");
    applyEdit(out.doc, {
      type: "setVariableGen",
      key: "token",
      spec: { gen: "uuid" },
    });
    const round = serializeDoc(out.doc);
    expect(round).toContain('base_url: "http://localhost:8080" # keep me');
    expect(round).toContain("gen: uuid");
  });
});

describe("extract — model integration", () => {
  it("model now exposes extract on the step", () => {
    const out = parseScenarioDoc(VALID_YAML);
    if ("error" in out) throw new Error("expected ok");
    const s0 = out.model.steps[0];
    if (s0.type !== "http") throw new Error("expected http step");
    expect(s0.extract).toEqual([{ var: "token", from: "body", path: "$.token" }]);
  });

  it("round-trips extract through model+doc edits", () => {
    const out = parseScenarioDoc(VALID_YAML);
    if ("error" in out) throw new Error("expected ok");

    applyEdit(out.doc, {
      type: "setStepExtract",
      stepId: "01HX0000000000000000000001",
      extract: [
        { var: "token", from: "body", path: "$.access_token" },
        { var: "trace", from: "header", name: "X-Trace" },
      ],
    });
    const round = serializeDoc(out.doc);
    expect(round).toContain("X-Trace");
    expect(round).toContain("access_token");
    const out2 = parseScenarioDoc(round);
    if ("error" in out2) throw new Error("re-parse failed");
    const s0 = out2.model.steps[0];
    if (s0.type !== "http") throw new Error("expected http step");
    expect(s0.extract).toEqual([
      { var: "token", from: "body", path: "$.access_token" },
      { var: "trace", from: "header", name: "X-Trace" },
    ]);
  });

  it("setting empty extract clears the key", () => {
    const out = parseScenarioDoc(VALID_YAML);
    if ("error" in out) throw new Error("expected ok");
    applyEdit(out.doc, {
      type: "setStepExtract",
      stepId: "01HX0000000000000000000001",
      extract: [],
    });
    const round = serializeDoc(out.doc);
    expect(round).not.toMatch(/extract:\s/);
  });
});

const LOOP_BASE = `version: 1
name: x
cookie_jar: auto
variables: {}
steps:
  - id: "01HX0000000000000000000001"
    name: top
    type: http
    request:
      method: GET
      url: "/top" # keep this comment
    assert: []
`;

function parseLoop(y: string) {
  const r = parseScenarioDoc(y);
  if ("error" in r) throw new Error(r.error);
  return r;
}

describe("yamlDoc loop edits", () => {
  it("addLoopStep appends a loop with one placeholder http step", () => {
    const { doc } = parseLoop(LOOP_BASE);
    applyEdit(doc, {
      type: "addLoopStep",
      id: "01HX0000000000000000000010",
      name: "Loop 1",
      childId: "01HX000000000000000000000C",
    });
    const r = parseScenarioDoc(serializeDoc(doc));
    if ("error" in r) throw new Error(r.error);
    const loop = r.model.steps[1];
    expect(loop.type).toBe("loop");
    if (loop.type === "loop") {
      expect(loop.repeat).toBe(1);
      expect(loop.do).toHaveLength(1);
      expect(loop.do[0].id).toBe("01HX000000000000000000000C");
    }
  });

  it("addStepInLoop appends an http step into the loop body", () => {
    const { doc } = parseLoop(LOOP_BASE);
    applyEdit(doc, {
      type: "addLoopStep",
      id: "01HX0000000000000000000010",
      name: "Loop",
      childId: "01HX000000000000000000000C",
    });
    applyEdit(doc, {
      type: "addStepInLoop",
      loopId: "01HX0000000000000000000010",
      id: "01HX000000000000000000000D",
      name: "second",
    });
    const r = parseLoop(serializeDoc(doc));
    const loop = r.model.steps[1];
    if (loop.type === "loop")
      expect(loop.do.map((s) => s.id)).toEqual([
        "01HX000000000000000000000C",
        "01HX000000000000000000000D",
      ]);
  });

  it("setLoopRepeat updates repeat", () => {
    const { doc } = parseLoop(LOOP_BASE);
    applyEdit(doc, {
      type: "addLoopStep",
      id: "01HX0000000000000000000010",
      name: "Loop",
      childId: "01HX000000000000000000000C",
    });
    applyEdit(doc, {
      type: "setLoopRepeat",
      loopId: "01HX0000000000000000000010",
      repeat: 7,
    });
    const r = parseLoop(serializeDoc(doc));
    const loop = r.model.steps[1];
    if (loop.type === "loop") expect(loop.repeat).toBe(7);
  });

  it("setStepField targets a step nested inside a loop", () => {
    const { doc } = parseLoop(LOOP_BASE);
    applyEdit(doc, {
      type: "addLoopStep",
      id: "01HX0000000000000000000010",
      name: "Loop",
      childId: "01HX000000000000000000000C",
    });
    applyEdit(doc, {
      type: "setStepField",
      stepId: "01HX000000000000000000000C",
      path: ["request", "url"],
      value: "/inner",
    });
    const r = parseLoop(serializeDoc(doc));
    const loop = r.model.steps[1];
    if (loop.type === "loop" && loop.do[0].type === "http")
      expect(loop.do[0].request.url).toBe("/inner");
  });

  it("preserves a comment on a sibling key after a nested edit", () => {
    const { doc } = parseLoop(LOOP_BASE);
    applyEdit(doc, {
      type: "setStepField",
      stepId: "01HX0000000000000000000001",
      path: ["request", "method"],
      value: "POST",
    });
    expect(serializeDoc(doc)).toContain("# keep this comment");
  });

  it("round-trips a loop step through doc edits (model deep-equal)", () => {
    const { doc } = parseLoop(LOOP_BASE);
    applyEdit(doc, {
      type: "addLoopStep",
      id: "01HX0000000000000000000010",
      name: "warm up",
      childId: "01HX000000000000000000000C",
    });
    applyEdit(doc, {
      type: "setLoopRepeat",
      loopId: "01HX0000000000000000000010",
      repeat: 3,
    });
    applyEdit(doc, {
      type: "addStepInLoop",
      loopId: "01HX0000000000000000000010",
      id: "01HX000000000000000000000D",
      name: "second",
    });
    const first = parseLoop(serializeDoc(doc));
    const second = parseLoop(serializeDoc(first.doc));
    expect(second.model.steps).toEqual(first.model.steps);
    const loop = first.model.steps[1];
    expect(loop.type).toBe("loop");
    if (loop.type === "loop") {
      expect(loop.repeat).toBe(3);
      expect(loop.do.map((s) => s.id)).toEqual([
        "01HX000000000000000000000C",
        "01HX000000000000000000000D",
      ]);
    }
  });
});

const IF_YAML = `version: 1
name: "demo"
cookie_jar: auto
variables: {}
steps:
  - id: "01HX0000000000000000000010"
    name: "branch"
    type: if
    cond:
      left: "{{code}}"
      op: eq
      right: "200"
    then:
      - id: "01HX0000000000000000000011"
        name: "ok"
        type: http
        request:
          method: GET
          url: "/ok"
        assert:
          - status: 200
`;

const LOOP_WITH_BODY = `version: 1
name: x
cookie_jar: auto
variables: {}
steps:
  - id: "01HX0000000000000000000040"
    name: outer-loop
    type: loop
    repeat: 1
    do:
      - id: "01HX0000000000000000000043"
        name: seed
        type: http
        request:
          method: GET
          url: "/seed"
        assert:
          - status: 200
`;

const EMPTY_YAML = `version: 1
name: x
cookie_jar: auto
variables: {}
steps: []
`;

describe("applyEdit — if node", () => {
  it("addIfStep appends a valid if with a seeded then child", () => {
    const out = parseScenarioDoc(EMPTY_YAML);
    if ("error" in out) throw new Error(out.error);
    applyEdit(out.doc, {
      type: "addIfStep",
      id: "01HX0000000000000000000010",
      name: "branch",
      childId: "01HX0000000000000000000011",
    });
    const re = parseScenarioDoc(serializeDoc(out.doc));
    if ("error" in re) throw new Error(re.error);
    const s = re.model.steps[0];
    expect(s.type).toBe("if");
    if (s.type === "if") expect(s.then).toHaveLength(1);
  });

  it("setIfCond replaces the condition tree and drops the old right", () => {
    const out = parseScenarioDoc(IF_YAML);
    if ("error" in out) throw new Error(out.error);
    applyEdit(out.doc, {
      type: "setIfCond",
      ifId: "01HX0000000000000000000010",
      cond: {
        all: [
          { left: "{{a}}", op: "eq", right: "1" },
          { left: "{{b}}", op: "exists" },
        ],
      },
    });
    const txt = serializeDoc(out.doc);
    expect(txt).toContain("all:");
    const re = parseScenarioDoc(txt);
    if ("error" in re) throw new Error(re.error);
    const s = re.model.steps[0];
    if (s.type === "if") expect("all" in s.cond).toBe(true);
  });

  it("setIfCond omits right for exists/empty ops", () => {
    const out = parseScenarioDoc(IF_YAML);
    if ("error" in out) throw new Error(out.error);
    applyEdit(out.doc, {
      type: "setIfCond",
      ifId: "01HX0000000000000000000010",
      cond: { left: "{{t}}", op: "exists", right: "ignored" },
    });
    expect(serializeDoc(out.doc)).not.toContain("right:");
  });

  it("addStepInBranch fills then / else / an elif branch", () => {
    const out = parseScenarioDoc(IF_YAML);
    if ("error" in out) throw new Error(out.error);
    applyEdit(out.doc, {
      type: "addStepInBranch",
      ifId: "01HX0000000000000000000010",
      branch: { kind: "else" },
      id: "01HX0000000000000000000020",
      name: "e1",
    });
    applyEdit(out.doc, {
      type: "addElif",
      ifId: "01HX0000000000000000000010",
      childId: "01HX0000000000000000000021",
    });
    applyEdit(out.doc, {
      type: "addStepInBranch",
      ifId: "01HX0000000000000000000010",
      branch: { kind: "elif", index: 0 },
      id: "01HX0000000000000000000022",
      name: "e2",
    });
    const re = parseScenarioDoc(serializeDoc(out.doc));
    if ("error" in re) throw new Error(re.error);
    const s = re.model.steps[0];
    if (s.type === "if") {
      expect(s.else).toHaveLength(1);
      expect(s.elif[0].then).toHaveLength(2); // seeded child + added
    }
  });

  it("setElifCond updates only the targeted elif condition", () => {
    const out = parseScenarioDoc(IF_YAML);
    if ("error" in out) throw new Error(out.error);
    applyEdit(out.doc, {
      type: "addElif",
      ifId: "01HX0000000000000000000010",
      childId: "01HX0000000000000000000021",
    });
    applyEdit(out.doc, {
      type: "setElifCond",
      ifId: "01HX0000000000000000000010",
      index: 0,
      cond: { left: "{{code}}", op: "eq", right: "404" },
    });
    const re = parseScenarioDoc(serializeDoc(out.doc));
    if ("error" in re) throw new Error(re.error);
    const s = re.model.steps[0];
    if (s.type === "if" && !("all" in s.elif[0].cond) && !("any" in s.elif[0].cond)) {
      expect(s.elif[0].cond.right).toBe("404");
    } else throw new Error("expected compare elif cond");
  });

  it("removeElif drops the branch", () => {
    const out = parseScenarioDoc(IF_YAML);
    if ("error" in out) throw new Error(out.error);
    applyEdit(out.doc, {
      type: "addElif",
      ifId: "01HX0000000000000000000010",
      childId: "01HX0000000000000000000021",
    });
    applyEdit(out.doc, {
      type: "removeElif",
      ifId: "01HX0000000000000000000010",
      index: 0,
    });
    const re = parseScenarioDoc(serializeDoc(out.doc));
    if ("error" in re) throw new Error(re.error);
    const s = re.model.steps[0];
    if (s.type === "if") expect(s.elif).toHaveLength(0);
  });

  it("addLoopInBranch nests a loop in the then branch (9c)", () => {
    const out = parseScenarioDoc(IF_YAML);
    if ("error" in out) throw new Error(out.error);
    applyEdit(out.doc, {
      type: "addLoopInBranch",
      ifId: "01HX0000000000000000000010",
      branch: { kind: "then" },
      id: "01HX0000000000000000000030",
      name: "inner loop",
      childId: "01HX0000000000000000000031",
    });
    const re = parseScenarioDoc(serializeDoc(out.doc));
    if ("error" in re) throw new Error(re.error);
    const s = re.model.steps[0];
    expect(s.type).toBe("if");
    if (s.type === "if") {
      // appended, not replaced — the fixture's existing then child must survive.
      expect(s.then).toHaveLength(2);
      const nested = s.then.find((c) => c.id === "01HX0000000000000000000030");
      expect(nested?.type).toBe("loop");
      if (nested?.type === "loop") {
        expect(nested.repeat).toBe(1);
        expect(nested.do.map((c) => c.id)).toEqual(["01HX0000000000000000000031"]);
      }
    }
  });

  it("addLoopInBranch nests a loop in the else branch (9c)", () => {
    const out = parseScenarioDoc(IF_YAML);
    if ("error" in out) throw new Error(out.error);
    applyEdit(out.doc, {
      type: "addLoopInBranch",
      ifId: "01HX0000000000000000000010",
      branch: { kind: "else" },
      id: "01HX0000000000000000000032",
      name: "else loop",
      childId: "01HX0000000000000000000033",
    });
    const re = parseScenarioDoc(serializeDoc(out.doc));
    if ("error" in re) throw new Error(re.error);
    const s = re.model.steps[0];
    expect(s.type).toBe("if");
    if (s.type === "if") {
      const nested = s.else.find((c) => c.id === "01HX0000000000000000000032");
      expect(nested?.type).toBe("loop");
      if (nested?.type === "loop") {
        expect(nested.repeat).toBe(1);
        expect(nested.do.map((c) => c.id)).toEqual(["01HX0000000000000000000033"]);
      }
    }
  });

  it("addIfInLoop nests an if in the loop body (9c)", () => {
    const out = parseScenarioDoc(LOOP_WITH_BODY);
    if ("error" in out) throw new Error(out.error);
    applyEdit(out.doc, {
      type: "addIfInLoop",
      loopId: "01HX0000000000000000000040",
      id: "01HX0000000000000000000041",
      name: "inner if",
      childId: "01HX0000000000000000000042",
    });
    const re = parseScenarioDoc(serializeDoc(out.doc));
    if ("error" in re) throw new Error(re.error);
    const loop = re.model.steps.find((s) => s.id === "01HX0000000000000000000040");
    expect(loop?.type).toBe("loop");
    if (loop?.type === "loop") {
      const nested = loop.do.find((c) => c.id === "01HX0000000000000000000041");
      expect(nested?.type).toBe("if");
      if (nested?.type === "if") {
        expect(nested.then.map((c) => c.id)).toEqual(["01HX0000000000000000000042"]);
      }
    }
  });

  it("removeStep deletes a step nested in an else branch (findStepPath recursion)", () => {
    const out = parseScenarioDoc(IF_YAML);
    if ("error" in out) throw new Error(out.error);
    applyEdit(out.doc, {
      type: "addStepInBranch",
      ifId: "01HX0000000000000000000010",
      branch: { kind: "else" },
      id: "01HX0000000000000000000020",
      name: "e1",
    });
    applyEdit(out.doc, {
      type: "addStepInBranch",
      ifId: "01HX0000000000000000000010",
      branch: { kind: "else" },
      id: "01HX0000000000000000000021",
      name: "e2",
    });
    applyEdit(out.doc, { type: "removeStep", stepId: "01HX0000000000000000000020" });
    const re = parseScenarioDoc(serializeDoc(out.doc));
    if ("error" in re) throw new Error(re.error);
    const s = re.model.steps[0];
    if (s.type === "if") expect(s.else.map((c) => c.id)).toEqual(["01HX0000000000000000000021"]);
  });
});

const BASE = `version: 1
name: t
steps: []
`;

function apply(yaml: string, edit: Parameters<typeof applyEdit>[1]): string {
  const r = parseScenarioDoc(yaml);
  if ("error" in r) throw new Error(r.error);
  applyEdit(r.doc, edit);
  return serializeDoc(r.doc);
}

describe("parallel edits", () => {
  it("addParallelStep seeds two named branches with one http each", () => {
    const out = apply(BASE, {
      type: "addParallelStep",
      id: "01HX0000000000000000000010",
      name: "fan",
      branch1Id: "01HX0000000000000000000011",
      branch2Id: "01HX0000000000000000000012",
    });
    const r = parseScenarioDoc(out);
    if ("error" in r) throw new Error(r.error);
    const p = r.model.steps[0];
    expect(p.type).toBe("parallel");
    if (p.type !== "parallel") return;
    expect(p.branches.map((b) => b.name)).toEqual(["branch1", "branch2"]);
    expect(p.branches[0].steps[0].id).toBe("01HX0000000000000000000011");
  });

  it("addBranch / addStepInParallelBranch / setBranchName / removeBranch", () => {
    let out = apply(BASE, {
      type: "addParallelStep",
      id: "01HX0000000000000000000010",
      name: "fan",
      branch1Id: "01HX0000000000000000000011",
      branch2Id: "01HX0000000000000000000012",
    });
    out = apply(out, {
      type: "addBranch",
      parallelId: "01HX0000000000000000000010",
      name: "branch3",
      childId: "01HX0000000000000000000013",
    });
    out = apply(out, {
      type: "addStepInParallelBranch",
      parallelId: "01HX0000000000000000000010",
      branchIndex: 0,
      id: "01HX0000000000000000000014",
      name: "Step 2",
    });
    out = apply(out, {
      type: "setBranchName",
      parallelId: "01HX0000000000000000000010",
      branchIndex: 1,
      name: "feed",
    });
    out = apply(out, {
      type: "removeBranch",
      parallelId: "01HX0000000000000000000010",
      index: 2,
    });
    const r = parseScenarioDoc(out);
    if ("error" in r) throw new Error(r.error);
    const p = r.model.steps[0];
    if (p.type !== "parallel") throw new Error("not parallel");
    expect(p.branches.length).toBe(2);
    expect(p.branches[1].name).toBe("feed");
    expect(p.branches[0].steps.map((s) => s.id)).toEqual([
      "01HX0000000000000000000011",
      "01HX0000000000000000000014",
    ]);
  });

  it("removeStep / setStepField descend into a parallel branch (searchSeq)", () => {
    let out = apply(BASE, {
      type: "addParallelStep",
      id: "01HX0000000000000000000010",
      name: "fan",
      branch1Id: "01HX0000000000000000000011",
      branch2Id: "01HX0000000000000000000012",
    });
    out = apply(out, {
      type: "setStepField",
      stepId: "01HX0000000000000000000011",
      path: ["request", "url"],
      value: "/changed",
    });
    expect(out).toContain("/changed");
    out = apply(out, { type: "removeStep", stepId: "01HX0000000000000000000012" });
    // branch2 now has 0 steps → Zod min(1) would reject parseScenarioDoc, so assert at
    // the doc-text level that searchSeq descended and removed the id (NOT via parseScenarioDoc).
    expect(out).not.toContain("01HX0000000000000000000012");
  });
});

describe("renameScenarioYaml", () => {
  it("changes only the name and preserves other keys + comments", () => {
    const src = "version: 1\n# top comment\nname: demo\ncookie_jar: auto\nsteps: []\n";
    const out = renameScenarioYaml(src, "demo (copy)");
    expect(out).toContain("name: demo (copy)");
    expect(out).toContain("# top comment");
    expect(out).toContain("cookie_jar: auto");
    expect(out).toContain("version: 1");
    expect(out).not.toContain("name: demo\n"); // 옛 값 잔류 없음
  });

  it("writes a PLAIN scalar (no inherited quotes)", () => {
    const src = 'version: 1\nname: "quoted demo"\nsteps: []\n';
    const out = renameScenarioYaml(src, "demo (copy)");
    expect(out).toContain("name: demo (copy)"); // 따옴표 비상속
  });

  it("round-trips through parseScenarioDoc with the new name", () => {
    const src =
      "version: 1\nname: demo\nsteps:\n  - { type: http, id: 01HZX0000000000000000000A0, name: home, request: { method: GET, url: /, headers: {} } }\n";
    const out = renameScenarioYaml(src, "demo (copy)");
    const parsed = parseScenarioDoc(out);
    expect("model" in parsed).toBe(true);
    if ("model" in parsed) expect(parsed.model.name).toBe("demo (copy)");
  });
});

describe("default_think_time", () => {
  it("default_think_time을 파싱해 모델에 보존한다 (normalize 읽기 경로)", () => {
    const yaml = `version: 1
name: "demo"
default_think_time:
  min_ms: 500
  max_ms: 1000
steps: []
`;
    const r = parseScenarioDoc(yaml);
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.model.default_think_time).toEqual({ min_ms: 500, max_ms: 1000 });
  });

  it("setDefaultThinkTime이 YAML에 쓰이고 재파싱된 모델에 되읽힌다 (왕복)", () => {
    const store = useScenarioEditor.getState();
    store.loadFromString(`version: 1
name: "demo"
steps: []
`);
    useScenarioEditor.getState().setDefaultThinkTime({ min_ms: 500, max_ms: 1000 });
    const s1 = useScenarioEditor.getState();
    expect(s1.yamlText).toContain("default_think_time");
    expect(s1.model?.default_think_time).toEqual({ min_ms: 500, max_ms: 1000 });

    // 제거 → 키가 사라지고 모델도 undefined
    useScenarioEditor.getState().setDefaultThinkTime(undefined);
    const s2 = useScenarioEditor.getState();
    expect(s2.yamlText).not.toContain("default_think_time");
    expect(s2.model?.default_think_time).toBeUndefined();
  });

  const withDefault = (block: string) => `version: 1
name: "demo"
${block}steps: []
`;

  it("default_think_time Zod: 유효/min>max/600001/absent", () => {
    // 유효
    const ok = parseScenarioDoc(
      withDefault("default_think_time:\n  min_ms: 500\n  max_ms: 1000\n"),
    );
    expect("error" in ok).toBe(false);
    // min > max → 거부
    expect(
      "error" in
        parseScenarioDoc(withDefault("default_think_time:\n  min_ms: 900\n  max_ms: 100\n")),
    ).toBe(true);
    // max > 600000 → 거부
    expect(
      "error" in
        parseScenarioDoc(withDefault("default_think_time:\n  min_ms: 0\n  max_ms: 600001\n")),
    ).toBe(true);
    // absent → undefined (현행 시나리오 회귀 0)
    const bare = parseScenarioDoc(withDefault(""));
    expect("error" in bare).toBe(false);
    if ("error" in bare) return;
    expect(bare.model.default_think_time).toBeUndefined();
  });
});

describe("setStepsThinkTime (일괄 think-time)", () => {
  const MULTI = `version: 1
name: "demo"
cookie_jar: auto
variables: {}
default_think_time:
  min_ms: 200
  max_ms: 500
steps:
  - id: "01HX0000000000000000000001"
    name: "a"
    type: http
    request:
      method: GET
      url: "/a"
  # keep-me: 형제 주석
  - id: "01HX0000000000000000000002"
    name: "b"
    type: http
    request:
      method: GET
      url: "/b"
  - id: "01HX0000000000000000000003"
    name: "loop"
    type: loop
    repeat: 2
    do:
      - id: "01HX0000000000000000000004"
        name: "c"
        type: http
        request:
          method: GET
          url: "/c"
`;

  const parse = (yaml: string) => {
    const r = parseScenarioDoc(yaml);
    if ("error" in r) throw new Error(`fixture parse failed: ${r.error}`);
    return r;
  };

  const applyTo = (yaml: string, edit: Edit) => {
    const { doc } = parse(yaml);
    applyEdit(doc, edit);
    return serializeDoc(doc);
  };

  it("지정한 id만 바뀌고 나머지는 보존된다", () => {
    const out = applyTo(MULTI, {
      type: "setStepsThinkTime",
      stepIds: ["01HX0000000000000000000001", "01HX0000000000000000000004"],
      value: { min_ms: 300, max_ms: 800 },
    });
    const sc = parse(out).model;
    const rows = sc.steps;
    expect(rows[0].type === "http" && rows[0].think_time).toEqual({ min_ms: 300, max_ms: 800 });
    expect(rows[1].type === "http" && rows[1].think_time).toBeUndefined();
    // rows[2].do[0]는 LoopBodyStep(http|nested-if) 판별 유니온이라 .type === "http"까지
    // narrow해야 think_time 접근이 tsc를 통과한다(모델의 loop.do가 http-only가 아님 —
    // 브리프 verbatim 코드는 이 유니온을 가정하지 않아 TS2339, self-audit로 발견).
    expect(
      rows[2].type === "loop" && rows[2].do[0].type === "http" && rows[2].do[0].think_time,
    ).toEqual({
      min_ms: 300,
      max_ms: 800,
    });
  });

  it("value undefined면 think_time 키가 사라진다", () => {
    const seeded = applyTo(MULTI, {
      type: "setStepsThinkTime",
      stepIds: ["01HX0000000000000000000001", "01HX0000000000000000000002"],
      value: { min_ms: 10, max_ms: 20 },
    });
    expect(seeded).toContain("think_time");

    const cleared = applyTo(seeded, {
      type: "setStepsThinkTime",
      stepIds: ["01HX0000000000000000000001", "01HX0000000000000000000002"],
      value: undefined,
    });
    // 주의: 원본 fixture(MULTI)의 `default_think_time:`이 부분문자열로
    // "think_time:"을 포함하므로(`default_` + `think_time:`) raw
    // `not.toContain("think_time:")`은 구현 정합성과 무관하게 항상 실패한다
    // (브리프 verbatim 버그, self-audit로 발견 — task-2-report.md 참고).
    // 파싱된 모델에서 대상 스텝의 think_time만 확인해 같은 의도를 검증한다.
    const clearedModel = parse(cleared).model;
    expect(
      clearedModel.steps[0].type === "http" && clearedModel.steps[0].think_time,
    ).toBeUndefined();
    expect(
      clearedModel.steps[1].type === "http" && clearedModel.steps[1].think_time,
    ).toBeUndefined();
  });

  it("빈 stepIds는 문서를 바꾸지 않는다", () => {
    const out = applyTo(MULTI, {
      type: "setStepsThinkTime",
      stepIds: [],
      value: { min_ms: 1, max_ms: 2 },
    });
    expect(out).toBe(serializeDoc(parse(MULTI).doc));
  });

  it("존재하지 않는 id가 섞여도 나머지는 정상 적용된다", () => {
    const out = applyTo(MULTI, {
      type: "setStepsThinkTime",
      stepIds: ["01HX0000000000000000000009", "01HX0000000000000000000002"],
      value: { min_ms: 5, max_ms: 5 },
    });
    const sc = parse(out).model;
    expect(sc.steps[1].type === "http" && sc.steps[1].think_time).toEqual({ min_ms: 5, max_ms: 5 });
  });

  it("형제 주석을 보존한다", () => {
    const out = applyTo(MULTI, {
      type: "setStepsThinkTime",
      stepIds: ["01HX0000000000000000000002"],
      value: { min_ms: 7, max_ms: 9 },
    });
    expect(out).toContain("keep-me: 형제 주석");
  });
});

describe("store.setStepsThinkTime (http leaf 필터)", () => {
  const YAML_WITH_LOOP = `version: 1
name: "demo"
cookie_jar: auto
variables: {}
steps:
  - id: "01HX0000000000000000000003"
    name: "loop"
    type: loop
    repeat: 2
    do:
      - id: "01HX0000000000000000000004"
        name: "c"
        type: http
        request:
          method: GET
          url: "/c"
`;

  it("컨테이너 id는 걸러져 doc/model divergence가 생기지 않는다", () => {
    useScenarioEditor.getState().loadFromString(YAML_WITH_LOOP);
    // 루프 컨테이너 id만 넘긴다 — 필터가 없으면 컨테이너에 think_time을 써서 Zod가 거부한다.
    useScenarioEditor
      .getState()
      .setStepsThinkTime(["01HX0000000000000000000003"], { min_ms: 1, max_ms: 2 });
    const s = useScenarioEditor.getState();
    expect(s.yamlError).toBeNull();
    expect(s.yamlText).not.toContain("think_time");
  });

  it("http leaf id는 정상 적용된다", () => {
    useScenarioEditor.getState().loadFromString(YAML_WITH_LOOP);
    useScenarioEditor
      .getState()
      .setStepsThinkTime(["01HX0000000000000000000004"], { min_ms: 1, max_ms: 2 });
    const s = useScenarioEditor.getState();
    expect(s.yamlError).toBeNull();
    expect(s.yamlText).toContain("think_time");
  });

  it("yamlError 상태에서는 무변이다 (편집 게이트)", () => {
    useScenarioEditor.getState().loadFromString(YAML_WITH_LOOP);
    useScenarioEditor.getState().setPendingYamlText("steps: [oops");
    useScenarioEditor.getState().commitPendingYaml();
    expect(useScenarioEditor.getState().yamlError).not.toBeNull();
    const before = useScenarioEditor.getState().yamlText;
    useScenarioEditor
      .getState()
      .setStepsThinkTime(["01HX0000000000000000000004"], { min_ms: 1, max_ms: 2 });
    expect(useScenarioEditor.getState().yamlText).toBe(before);
  });
});
