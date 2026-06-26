import { describe, expect, it } from "vitest";
import type { PreviewEntry } from "../filters";
import {
  buildEnvInput,
  defaultHostVars,
  hostsByRequestCount,
  originOf,
  validateEnv,
} from "../hostEnv";

const preview: PreviewEntry[] = [
  { index: 0, method: "GET", url: "https://api.example.com/a" },
  { index: 1, method: "GET", url: "https://cdn.example.com/b" },
  { index: 2, method: "GET", url: "https://api.example.com/c" }, // api 2회
];

describe("hostEnv (R8/R10/R11)", () => {
  it("hostsByRequestCount: 요청 수 desc, 동률 first-seen", () => {
    expect(hostsByRequestCount(preview)).toEqual(["api.example.com", "cdn.example.com"]);
  });

  it("defaultHostVars: 첫 BASE_URL, 이후 BASE_URL_2…", () => {
    expect(defaultHostVars(["api.example.com", "cdn.example.com"])).toEqual({
      "api.example.com": "BASE_URL",
      "cdn.example.com": "BASE_URL_2",
    });
  });

  it("originOf: first-seen origin", () => {
    expect(originOf("api.example.com", preview)).toBe("https://api.example.com");
  });

  it("buildEnvInput: {name, vars:{변수명: origin}}", () => {
    const input = buildEnvInput(
      { "api.example.com": "BASE_URL", "cdn.example.com": "CDN" },
      preview,
      "  스테이징  ",
    );
    expect(input).toEqual({
      name: "스테이징",
      vars: { BASE_URL: "https://api.example.com", CDN: "https://cdn.example.com" },
    });
  });

  it("validateEnv: 정상이면 ok", () => {
    expect(validateEnv({ "a.com": "BASE_URL" }, "env").ok).toBe(true);
  });

  it("validateEnv: 빈/패턴위반/중복/빈환경이름이면 ok=false", () => {
    expect(validateEnv({ "a.com": "" }, "env").ok).toBe(false);
    expect(validateEnv({ "a.com": "1bad" }, "env").invalidHosts).toEqual(["a.com"]);
    expect(validateEnv({ "a.com": "X", "b.com": "X" }, "env").dupNames).toEqual(["X"]);
    expect(validateEnv({ "a.com": "BASE_URL" }, "   ").ok).toBe(false);
  });

  it("validateEnv: 예약어는 soft 경고지만 ok에 영향 없음", () => {
    const v = validateEnv({ "a.com": "vu_id" }, "env");
    expect(v.reservedHosts).toEqual(["a.com"]);
    expect(v.ok).toBe(true);
  });
});
