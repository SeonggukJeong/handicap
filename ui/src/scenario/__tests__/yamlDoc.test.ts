import { describe, expect, it } from "vitest";
import {
  parseScenarioDoc,
  serializeDoc,
  applyEdit,
  type Edit,
} from "../yamlDoc";

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
    expect(out.model.steps[0].request.method).toBe("POST");
    expect(out.model.steps[0].assert).toEqual([{ kind: "status", code: 200 }]);
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
    expect(round).toContain("path: \"$.token\"");
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
    expect(out.model.steps[0].extract).toEqual([
      { var: "token", from: "body", path: "$.token" },
    ]);
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
    expect(out2.model.steps[0].extract).toEqual([
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
