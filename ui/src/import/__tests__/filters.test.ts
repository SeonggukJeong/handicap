import { describe, expect, it } from "vitest";
import {
  type HarEntry,
  type PreviewEntry,
  dedupKey,
  distinctHosts,
  duplicateIndices,
  entryHost,
  isStaticAsset,
  selectEntries,
} from "../filters";

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

describe("dedupKey / duplicateIndices (R6)", () => {
  it("dedupKey: 쿼리스트링·프래그먼트·호스트를 무시하고 method+경로로 키", () => {
    expect(dedupKey("get", "https://a.com/api/users?page=1")).toBe(
      dedupKey("GET", "https://b.com/api/users?page=2#x"),
    );
  });

  it("dedupKey: method가 다르면 다른 키 (GET≠POST)", () => {
    expect(dedupKey("GET", "https://a.com/x")).not.toBe(dedupKey("POST", "https://a.com/x"));
  });

  it("dedupKey: 상대/파싱불가 URL도 쿼리 무시", () => {
    expect(dedupKey("GET", "/a?x=1")).toBe(dedupKey("GET", "/a?x=2"));
    expect(dedupKey("GET", "/a")).toBe(dedupKey("GET", "/a#frag"));
  });

  it("duplicateIndices: 그룹의 2번째+ index만 반환(첫 발생 제외)", () => {
    const preview: PreviewEntry[] = [
      { index: 0, method: "GET", url: "https://a.com/users?p=1" },
      { index: 2, method: "GET", url: "https://a.com/users?p=2" }, // dup of 0
      { index: 5, method: "POST", url: "https://a.com/users" }, // 다른 method
      { index: 7, method: "GET", url: "https://a.com/users" }, // dup of 0 (쿼리 무시)
    ];
    const dups = duplicateIndices(preview);
    expect([...dups].sort((x, y) => x - y)).toEqual([2, 7]);
    expect(dups.has(0)).toBe(false);
    expect(dups.has(5)).toBe(false);
  });
});
