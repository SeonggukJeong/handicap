import { describe, expect, it } from "vitest";
import { parseScenarioDoc, serializeDoc, applyEdit, type Edit } from "../yamlDoc";

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
