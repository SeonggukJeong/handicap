import { describe, it, expect } from "vitest";
import { scanTemplateTokens, applyTokenSubstitutions, type SubMap } from "../templateParams";

// http step fragment with flow + env tokens, incl. an env default and a reserved system var.
const FRAG = [
  "- id: 01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "  name: login",
  "  type: http",
  "  request:",
  "    method: POST",
  '    url: "${BASE_URL}/login?u={{user}}&trace=${vu_id}"',
  "    headers:",
  '      Authorization: "Bearer {{token}}"',
  '      X-Host: "${API_HOST:-https://fallback}"',
  "",
].join("\n");

const keepAll = (): SubMap => ({ flow: {}, env: {} });

describe("scanTemplateTokens", () => {
  it("collects flow and env tokens, dedups, drops reserved system vars", () => {
    const { flow, env } = scanTemplateTokens(FRAG);
    expect(flow).toEqual(["user", "token"]);
    // ${vu_id} excluded (reserved); ${API_HOST:-...} captures name only.
    expect(env).toEqual(["BASE_URL", "API_HOST"]);
  });

  it("scans templates whose step id is NOT a valid ULID (backend doesn't validate)", () => {
    const wild =
      '- id: not-a-ulid\n  name: x\n  type: http\n  request:\n    method: GET\n    url: "{{q}}"\n';
    expect(scanTemplateTokens(wild).flow).toEqual(["q"]);
  });

  it("returns empty for a fragment with no tokens", () => {
    const plain = "- id: A\n  name: x\n  type: http\n  request:\n    method: GET\n    url: /x\n";
    expect(scanTemplateTokens(plain)).toEqual({ flow: [], env: [] });
  });
});

describe("applyTokenSubstitutions", () => {
  it("identity (all keep) returns the input string byte-identical", () => {
    expect(applyTokenSubstitutions(FRAG, keepAll())).toBe(FRAG);
  });

  it("renames a flow token, preserving the {{ }} wrapper", () => {
    const out = applyTokenSubstitutions(FRAG, {
      flow: { token: { kind: "rename", to: "authToken" } },
      env: {},
    });
    expect(out).toContain("{{authToken}}");
    expect(out).not.toContain("{{token}}");
    expect(out).toContain("{{user}}"); // untouched
  });

  it("substitutes a flow token with a literal (drops the braces)", () => {
    const out = applyTokenSubstitutions(FRAG, {
      flow: { user: { kind: "literal", value: "alice" } },
      env: {},
    });
    expect(out).toContain("u=alice");
    expect(out).not.toContain("{{user}}");
  });

  it("renames an env token and preserves its :- default", () => {
    const out = applyTokenSubstitutions(FRAG, {
      flow: {},
      env: { API_HOST: { kind: "rename", to: "HOST2" } },
    });
    expect(out).toContain("${HOST2:-https://fallback}");
  });

  it("preserves comments on sibling lines", () => {
    const withComment =
      '# leading\n- id: A # trailing\n  name: x\n  type: http\n  request:\n    method: GET\n    url: "{{q}}"\n';
    const out = applyTokenSubstitutions(withComment, {
      flow: { q: { kind: "rename", to: "qq" } },
      env: {},
    });
    expect(out).toContain("# trailing");
    expect(out).toContain("{{qq}}");
  });
});
