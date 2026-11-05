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
