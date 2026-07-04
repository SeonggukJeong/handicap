import { describe, it, expect } from "vitest";
import { parseDocument } from "yaml";
import { applyEdit } from "../yamlDoc";

function apply(yaml: string, branchName: string, oldName: string, newName: string): string {
  const doc = parseDocument(yaml);
  applyEdit(doc, { type: "renameParallelVar", branchName, oldName, newName });
  return String(doc);
}

const BASE = `version: 1
name: "t"
variables: {}
steps:
  - id: "01HX0000000000000000000010"
    type: parallel
    name: B
    branches:
      - name: B
        steps:
          - id: "01HX0000000000000000000020"
            type: http
            name: prod
            request: { method: GET, url: "/p" }
            extract: [ { var: s, from: status } ]
          - id: "01HX0000000000000000000030"
            type: http
            name: use
            request:
              method: GET
              url: "/u?x={{s}}&keep={{other}}"
              headers: { Authorization: "Bearer {{s:str}}" }
      - name: C
        steps:
          - id: "01HX0000000000000000000040"
            type: http
            name: cprod
            request: { method: GET, url: "/c?x={{s}}" }
            extract: [ { var: s, from: status } ]
  - id: "01HX0000000000000000000050"
    type: http
    name: down
    request: { method: GET, url: "/d?y={{B.s}}&z={{C.s}}" }
`;

describe("renameParallelVar (R5)", () => {
  it("(a) renames extract var only in matching branch, not branch C", () => {
    const out = apply(BASE, "B", "s", "s2");
    // branch B's extract renamed
    expect(out).toContain("var: s2");
    // branch C's extract var untouched. NOTE: extracts are flow-style (`[ { var: s, from: status } ]`)
    // and the `yaml` package preserves flow style on round-trip → serialized as `var: s, from: status`
    // (NOT `var: s\n`). Assert the flow form.
    const cBlock = out.slice(out.indexOf("name: C"));
    expect(cBlock).toContain("var: s,");
    expect(cBlock).not.toContain("var: s2");
  });

  it("(b) rewrites branch-internal bare {{s}} (with cast) but not {{other}} or branch-B-external bare", () => {
    const out = apply(BASE, "B", "s", "s2");
    expect(out).toContain("/u?x={{s2}}&keep={{other}}"); // {{s}}→{{s2}}, {{other}} preserved
    expect(out).toContain("Bearer {{s2:str}}"); // cast preserved
    // branch C's internal bare {{s}} NOT rewritten (different branch identity)
    expect(out).toContain("/c?x={{s}}");
  });

  it("(c) rewrites downstream {{B.s}} but not {{C.s}}", () => {
    const out = apply(BASE, "B", "s", "s2");
    expect(out).toContain("{{B.s2}}");
    expect(out).toContain("{{C.s}}"); // different branch namespace untouched
  });

  it("multi-node same-name branch: both nodes' extract + internal bare rewritten (F2)", () => {
    const twoNode = `version: 1
name: "t"
variables: {}
steps:
  - id: "01HX0000000000000000000060"
    type: parallel
    name: n1
    branches:
      - name: B
        steps: [ { id: "01HX0000000000000000000070", type: http, name: a, request: { method: GET, url: "/a?x={{s}}" }, extract: [ { var: s, from: status } ] } ]
  - id: "01HX0000000000000000000080"
    type: parallel
    name: n2
    branches:
      - name: B
        steps: [ { id: "01HX0000000000000000000090", type: http, name: b, request: { method: GET, url: "/b?x={{s}}" }, extract: [ { var: s, from: status } ] } ]
`;
    const out = apply(twoNode, "B", "s", "s2");
    expect(out).toContain("/a?x={{s2}}");
    expect(out).toContain("/b?x={{s2}}");
    expect((out.match(/var: s2/g) ?? []).length).toBe(2); // both branches' extract renamed
    expect(out).not.toContain("var: s,"); // no un-renamed extract remains (flow-style; both nodes hit)
  });

  it("namespaced exact-match: {{B.sX}}/{{B.s.z}} not matched", () => {
    const tricky = `version: 1
name: "t"
variables: {}
steps:
  - id: "01HX00000000000000000000A0"
    type: parallel
    name: B
    branches:
      - name: B
        steps: [ { id: "01HX00000000000000000000B0", type: http, name: a, request: { method: GET, url: "/a" }, extract: [ { var: s, from: status } ] } ]
  - id: "01HX00000000000000000000C0"
    type: http
    name: d
    request: { method: GET, url: "/d?a={{B.sX}}&b={{B.s.z}}&c={{B.s}}" }
`;
    const out = apply(tricky, "B", "s", "s2");
    expect(out).toContain("{{B.sX}}"); // longer name — not matched
    expect(out).toContain("{{B.s.z}}"); // dotted suffix — not matched
    expect(out).toContain("{{B.s2}}"); // exact — matched
  });

  it("preserves quote style and does not touch map keys", () => {
    const withKeys = `version: 1
name: "t"
variables: {}
steps:
  - id: "01HX00000000000000000000D0"
    type: parallel
    name: B
    branches:
      - name: B
        steps:
          - id: "01HX00000000000000000000E0"
            type: http
            name: a
            request:
              method: POST
              url: "/a"
              headers: { s: "literal-key" }
            extract: [ { var: s, from: status } ]
`;
    const out = apply(withKeys, "B", "s", "s2");
    expect(out).toContain('s: "literal-key"'); // header KEY 's' not renamed
    expect(out).toContain("var: s2");
  });

  it("(b negative) bareRe lookahead does not corrupt non-matching cast/name tokens in the matched branch", () => {
    const yaml = `version: 1
name: "t"
variables: {}
steps:
  - id: "01HX00000000000000000000F0"
    type: parallel
    name: B
    branches:
      - name: B
        steps:
          - id: "01HX00000000000000000000G0"
            type: http
            name: a
            request: { method: GET, url: "/a?x={{s}}&y={{s:notacast}}&z={{sX}}" }
            extract: [ { var: s, from: status } ]
`;
    const out = apply(yaml, "B", "s", "s2");
    expect(out).toContain("{{s2}}"); // exact base match — rewritten
    expect(out).toContain("{{s:notacast}}"); // notacast ∉ CAST_KEYWORDS → base is "s:notacast", not "s" — untouched
    expect(out).toContain("{{sX}}"); // longer name — base is "sX", not "s" — untouched
    expect(out).not.toContain("{{s2:notacast}}"); // the corruption an asymmetric lookahead would produce
  });
});
