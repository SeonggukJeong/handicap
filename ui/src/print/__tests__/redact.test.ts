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
  const both = (url: string, env: Record<string, string> = {}) => ({
    host: hostOf(url, env),
    path: displayPath(url),
  });

  // ── round 1 ──
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
  it("protocol_relative_userinfo", () => {
    const r = both("//svc:hunter2@host/api/x");
    expect(r).toEqual({ host: "host", path: "/api/x" });
    noSecret(`${r.host} ${r.path}`, "hunter2", "svc");
  });
  it("userinfo_with_raw_slash_is_ambiguous", () => {
    for (const url of ["https://u:pa/ss@h/x", "https://u:pa/ss@{{h}}/x"]) {
      const r = both(url);
      expect(r).toEqual({ host: "", path: "/" });
      noSecret(`${r.host} ${r.path}`, "pa", "ss@");
    }
  });
  it("userinfo_with_raw_question_or_hash_is_ambiguous", () => {
    for (const url of ["https://admin:pa?ss@{{h}}/x", "https://admin:pa#ss@{{h}}/x"]) {
      const r = both(url);
      expect(r).toEqual({ host: "", path: "/" });
      noSecret(`${r.host} ${r.path}`, "pa", "ss@", "admin");
    }
  });
  it("host_of_token_host_ignores_at_in_query", () => {
    expect(hostOf("{{base}}/x?e=a@b.com", {})).toBe("{{base}}");
  });

  // ── round 2: `@` only counts inside the authority ──
  it("blocker_query_at_after_token_host", () => {
    for (const url of [
      "https://{{host}}/login?email=qa@corp.com&password=Secret1",
      "https://${API_HOST}/login?email=qa@corp.com&password=Secret1",
    ]) {
      const r = both(url);
      expect(r.path).toBe("/login?…");
      expect(r.host).toBe(url.includes("{{") ? "{{host}}" : "${API_HOST}");
      noSecret(`${r.host} ${r.path}`, "Secret1", "password", "corp.com", "qa@");
    }
  });
  it("blocker_query_at_after_host_with_token_port", () => {
    const r = both("https://api.x:{{port}}/login?u=a@b&p=Secret1");
    expect(r).toEqual({ host: "api.x:{{port}}", path: "/login?…" });
    noSecret(`${r.host} ${r.path}`, "Secret1", "b&p");
  });
  it("blocker_fragment_at", () => {
    const r = both("https://{{h}}#frag@leak");
    expect(r).toEqual({ host: "{{h}}", path: "/" });
    noSecret(`${r.host} ${r.path}`, "leak", "frag");
  });
  it("path_at_is_path", () => {
    expect(displayPath("https://api.example.com/users/@me")).toBe("/users/@me");
    expect(both("https://{{h}}/x?e=a@b.com")).toEqual({ host: "{{h}}", path: "/x?…" });
    expect(both("https://{{h}}:8080/u/@me")).toEqual({ host: "{{h}}:8080", path: "/u/@me" });
  });
  it("non_host_authority_with_later_at_is_ambiguous", () => {
    const r = both("https://dXNlcjpwYXNz/abc==@host/x");
    expect(r).toEqual({ host: "", path: "/" });
    noSecret(`${r.host} ${r.path}`, "dXNlcjpwYXNz", "abc==");
  });
  it("host_like_authorities", () => {
    expect(both("http://localhost:8080/a@b")).toEqual({ host: "localhost:8080", path: "/a@b" });
    expect(hostOf("http://[::1]:8080/a", {})).toBe("[::1]:8080");
    expect(displayPath("http://[::1]:8080/a@b")).toBe("/a@b");
    expect(both("https://{{sub}}.example.com/a@b")).toEqual({
      host: "{{sub}}.example.com",
      path: "/a@b",
    });
  });
  it("display_path_skips_two_leading_tokens", () => {
    const r = displayPath("${A:-x}${B:-http://u:p@h}/x");
    expect(r).toBe("/x");
    noSecret(r, "u:p", "@h");
  });
  it("host_of_never_prints_placeholder_default", () => {
    const r = hostOf("${BASE:-http://svc:s3cret@api.local}/orders", { BASE: "zzz" });
    expect(r).toBe("${BASE}");
    noSecret(r, "s3cret", "api.local", "svc", ":-");
    // 풀린 기본값은 실제 접속 대상(userinfo 제외)
    expect(hostOf("https://${H:-u:p@inner.host}/x", {})).toBe("inner.host");
    // 풀 수 없으면(포트 자리표시자) 원형 폴백 — 기본값 속 호스트·자격증명은 절대 안 나온다
    const p = hostOf("https://${H:-u:p@inner.host}:{{port}}/x", {});
    expect(p).toBe("${H}:{{port}}");
    noSecret(p, "u:p", "inner.host", ":-");
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
