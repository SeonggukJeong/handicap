import { describe, expect, it } from "vitest";
import { type HarEntry, distinctHosts, entryHost, isStaticAsset, selectEntries } from "../filters";

function entry(url: string, mimeType = "application/json"): HarEntry {
  return {
    request: { method: "GET", url, headers: [] },
    response: { status: 200, content: { mimeType } },
  };
}

describe("filters", () => {
  it("isStaticAsset: 확장자 기준", () => {
    expect(isStaticAsset(entry("https://x.com/a.jpg"))).toBe(true);
    expect(isStaticAsset(entry("https://x.com/style.css?v=2"))).toBe(true);
    expect(isStaticAsset(entry("https://x.com/api/users"))).toBe(false);
  });

  it("isStaticAsset: 응답 content-type 기준", () => {
    expect(isStaticAsset(entry("https://x.com/img", "image/png"))).toBe(true);
    expect(isStaticAsset(entry("https://x.com/api", "application/json"))).toBe(false);
  });

  it("entryHost / distinctHosts: 순서 유지·중복 제거·파싱불가 null", () => {
    expect(entryHost(entry("https://a.com/x"))).toBe("a.com");
    expect(entryHost(entry("/relative"))).toBeNull();
    const hosts = distinctHosts([
      entry("https://a.com/1"),
      entry("https://b.com/2"),
      entry("https://a.com/3"),
    ]);
    expect(hosts).toEqual(["a.com", "b.com"]);
  });

  it("selectEntries: excludeStatic·includedHosts·excludedIndices 적용 + 순서 유지", () => {
    const entries = [
      entry("https://a.com/api/1"), // 0 keep
      entry("https://a.com/logo.png"), // 1 static
      entry("https://cdn.com/api/2"), // 2 host excluded
      entry("https://a.com/api/3"), // 3 index excluded
    ];
    const kept = selectEntries(entries, {
      excludeStatic: true,
      includedHosts: new Set(["a.com"]),
      excludedIndices: new Set([3]),
    });
    expect(kept.map((e) => e.request.url)).toEqual(["https://a.com/api/1"]);
  });

  it("selectEntries: includedHosts=null이면 모든 호스트(파싱불가 host 포함) 통과", () => {
    const entries = [entry("https://a.com/api"), entry("/relative")];
    const kept = selectEntries(entries, {
      excludeStatic: false,
      includedHosts: null,
      excludedIndices: new Set(),
    });
    expect(kept).toHaveLength(2);
  });

  it("selectEntries: includedHosts가 Set이어도 파싱불가(null host) 요청은 통과(미리보기와 일치)", () => {
    const entries = [entry("https://a.com/api"), entry("/relative")];
    const kept = selectEntries(entries, {
      excludeStatic: false,
      includedHosts: new Set(["a.com"]),
      excludedIndices: new Set(),
    });
    expect(kept).toHaveLength(2); // a.com + null-host 둘 다 keep
  });
});
