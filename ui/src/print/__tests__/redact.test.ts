import { describe, expect, it } from "vitest";
import {
  displayPath,
  hostOf,
  middleEllipsis,
  requestLine,
  requestLineBudget,
  targetSystems,
} from "../redact";
import type { StepFacts } from "../scenarioFacts";

const step = (url: string): StepFacts => ({
  id: "x",
  name: "x",
  method: "GET",
  url,
  statusCodes: [],
  fallibleExtract: false,
});

describe("hostOf", () => {
  it("target_resolved_host_only", () => {
    expect(hostOf("https://u:p@h.example:8443/x?token=${TOKEN}", { TOKEN: "SECRET" })).toBe(
      "h.example:8443",
    );
  });
  it("target_unresolved_falls_back_to_template", () => {
    expect(hostOf("${BASE_URL}/x?token=${TOKEN}", {})).toBe("${BASE_URL}");
    expect(hostOf("http://{{h}}:8080/a", {})).toBe("{{h}}:8080");
    expect(hostOf("http://${USER}:${PASS}@{{h}}/a", {})).toBe("{{h}}");
    expect(hostOf("http://${HOST}/a", {})).toBe("${HOST}");
    expect(hostOf("/login", {})).toBe("");
  });
  it("target_flow_vars_in_path_still_resolve", () => {
    expect(
      hostOf("${BASE_URL}/users/{{id}}?t={{tok}}", {
        BASE_URL: "https://api.local",
      }),
    ).toBe("api.local");
  });
  it("target_env_secret_never_returned", () => {
    const r = hostOf("${BASE_URL}/x", {
      BASE_URL: "https://admin:pw@api.local/v1?k=S3CR3T",
    });
    expect(r).toBe("api.local");
    expect(r).not.toContain("admin");
    expect(r).not.toContain("pw");
    expect(r).not.toContain("S3CR3T");
  });
});

describe("credential-safe authority parsing (F3)", () => {
  const noSecret = (r: string, ...secrets: string[]) => {
    for (const x of secrets) expect(r).not.toContain(x);
  };
  it("display_path_skips_leading_token_with_default_url", () => {
    const r = displayPath("${BASE:-http://svc:s3cret@api.local}/orders");
    expect(r).toBe("/orders");
    noSecret(r, "s3cret", "svc");
  });
  it("display_path_unclosed_leading_token_prints_root", () => {
    const r = displayPath("${BASE:-http://svc:s3cret@api.local/orders");
    expect(r).toBe("/");
    noSecret(r, "s3cret");
  });
  it("display_path_protocol_relative", () => {
    const r = displayPath("//svc:hunter2@host/api/x");
    expect(r).toBe("/api/x");
    noSecret(r, "hunter2", "svc");
  });
  it("host_of_protocol_relative", () => {
    const r = hostOf("//svc:hunter2@host/api/x", {});
    expect(r).toBe("host");
    noSecret(r, "hunter2", "svc");
  });
  it("display_path_userinfo_with_raw_slash", () => {
    const r = displayPath("https://u:pa/ss@h/x");
    expect(r).toBe("/x");
    noSecret(r, "pa", "ss@");
  });
  it("display_path_userinfo_with_raw_question_and_hash", () => {
    const q = displayPath("https://admin:pa?ss@{{h}}/x");
    expect(q).toBe("/x");
    noSecret(q, "pa", "ss@");
    const h = displayPath("https://admin:pa#ss@{{h}}/x");
    expect(h).toBe("/x");
    noSecret(h, "pa", "ss@");
  });
  it("host_of_fallback_userinfo_with_raw_question", () => {
    const r = hostOf("https://admin:pa?ss@{{h}}/x", {});
    expect(r).toBe("{{h}}");
    noSecret(r, "pa", "ss@", "admin");
  });
  it("host_of_fallback_userinfo_with_raw_slash", () => {
    const r = hostOf("https://u:pa/ss@{{h}}/x", {});
    expect(r).toBe("{{h}}");
    noSecret(r, "pa", "ss@");
  });
  it("host_of_token_host_ignores_at_in_query", () => {
    expect(hostOf("{{base}}/x?e=a@b.com", {})).toBe("{{base}}");
  });
});

describe("targetSystems", () => {
  it("target_systems_dedupe_cap", () => {
    const u = (h: string) => `https://${h}/x`;
    expect(targetSystems([u("a"), u("a"), u("b"), u("c"), u("d")].map(step), {})).toBe(
      "a, b 외 2곳",
    );
    expect(targetSystems(["/a", "/b"].map(step), {})).toBe("–");
  });
});

describe("displayPath / ellipsis / requestLine", () => {
  it("display_path_raw", () => {
    expect(displayPath("${BASE_URL}/users/{{id}}?q=${TOKEN}#f")).toBe("/users/{{id}}?…");
    expect(displayPath("https://h/x")).toBe("/x");
    expect(displayPath("https://h")).toBe("/");
    expect(displayPath("/a/b")).toBe("/a/b");
  });
  it("middle_ellipsis", () => {
    expect(middleEllipsis("short", 20)).toBe("short");
    const s = "a".repeat(30) + "b".repeat(30);
    const r = middleEllipsis(s, 20);
    expect(r.length).toBe(20);
    expect(r).toBe("a".repeat(11) + "…" + "b".repeat(8));
  });
  it("request_line", () => {
    expect(requestLine("GET", "/a?x")).toBe("GET /a?…");
    expect(requestLineBudget(46)).toBe(35);
    expect(requestLineBudget(10)).toBe(24);
  });
});
