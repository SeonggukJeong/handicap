import { describe, expect, it } from "vitest";
import { safeDecodeComponent, safeDecodeUrl } from "../urlDecode";

// spec 2026-07-12-har-query-decode-design.md §2 R1–R5 acceptance.
describe("safeDecodeUrl — 허용 집합 디코딩 (R1)", () => {
  it("한글 경로·쿼리를 디코딩한다", () => {
    expect(
      safeDecodeUrl(
        "https://a.com/%EA%B2%80%EC%83%89/%EC%83%81%ED%92%88?%EC%B9%B4=%EC%8B%A0%EB%B0%9C",
      ),
    ).toBe("https://a.com/검색/상품?카=신발");
  });

  it("%20을 공백으로 디코딩한다", () => {
    expect(safeDecodeUrl("/p?q=%ED%95%9C%20%EA%B8%80")).toBe("/p?q=한 글");
  });

  it("ASCII unreserved(%41%42%43)는 디코딩하지 않는다 — 리뷰 1R 제거", () => {
    const u = "https://a.com/q?v=%41%42%43";
    expect(safeDecodeUrl(u)).toBe(u);
  });

  it("astral-plane 이모지(%F0%9F%98%80)는 가시 비ASCII로 디코딩", () => {
    expect(safeDecodeUrl("/q?e=%F0%9F%98%80")).toBe("/q?e=😀");
  });
});

describe("safeDecodeUrl — 보존 (R2)", () => {
  it("중첩 URL의 구조 escape(%3A %2F %3F %3D %26)는 불변", () => {
    const u = "https://a.com/api?redirect=https%3A%2F%2Fb.com%2Fpath%3Fx%3D1%26y%3D2";
    expect(safeDecodeUrl(u)).toBe(u);
  });

  it("템플릿 토큰 문자(%7B %7D %24)는 불변 — {{/${ 생성 차단", () => {
    const u = "https://a.com/q?tpl=%7B%7Bu%7D%7D&d=%24%7Bv%7D";
    expect(safeDecodeUrl(u)).toBe(u);
  });

  it("리터럴 %25·%2B·raw +는 불변", () => {
    const u = "https://a.com/q?pct=100%25&plus=a%2Bb&raw=c+d";
    expect(safeDecodeUrl(u)).toBe(u);
  });

  it("혼합 run은 문자 단위 부분 디코딩 — 한글만 풀고 %26 보존", () => {
    expect(safeDecodeUrl("https://a.com/q?name=%EA%B9%80%26%EC%9D%B4")).toBe(
      "https://a.com/q?name=김%26이",
    );
  });

  it("보존 escape는 소문자 hex 원문 그대로(재작성 없음)", () => {
    const u = "https://a.com/q?p=%2fpath%3d1";
    expect(safeDecodeUrl(u)).toBe(u); // %2F·%3D로 대문자화되면 실패
  });

  it("비가시 문자(nbsp %C2%A0, zwsp %E2%80%8B)는 불변", () => {
    const u = "https://a.com/q?x=%C2%A0y&z=%E2%80%8B";
    expect(safeDecodeUrl(u)).toBe(u);
  });

  it("UTF-8 BOM(%EF%BB%BF)은 단독·구조문자 인접 시 불변, 가시문자 인접 run은 BOM만 보존하고 가시문자는 디코딩", () => {
    // c=%EA%B9%80%EF%BB%BF: 김(가시, R1)+BOM(비가시, R2)이 한 escape run — R2 "혼합 run 문자 단위
    // 부분 디코딩"과 동일 패턴으로 김만 풀리고 BOM은 원문 escape로 남는다(전체 unchanged 아님).
    const u = "https://a.com/q?a=%EF%BB%BF&b=%EF%BB%BF%26&c=%EA%B9%80%EF%BB%BF";
    expect(safeDecodeUrl(u)).toBe("https://a.com/q?a=%EF%BB%BF&b=%EF%BB%BF%26&c=김%EF%BB%BF");
  });
});

describe("safeDecodeUrl — 경계 보존 (R3)", () => {
  it("authority의 escape는 불변, 경로만 디코딩", () => {
    expect(safeDecodeUrl("https://%ED%95%9C@h.com/p%ED%95%9C")).toBe("https://%ED%95%9C@h.com/p한");
  });

  it("#fragment는 불변", () => {
    expect(safeDecodeUrl("/p?q=%ED%95%9C#f%ED%95%9C")).toBe("/p?q=한#f%ED%95%9C");
  });

  it("${VAR} 프리픽스 입력(호스트 치환 출력)도 그대로 동작", () => {
    expect(safeDecodeUrl("${BASE_URL}/my?tab=%ED%99%88%20%EC%84%A4%EC%A0%95")).toBe(
      "${BASE_URL}/my?tab=홈 설정",
    );
  });

  it("상대 URL·escape 없는 입력은 byte-identical", () => {
    expect(safeDecodeUrl("/relative/path?a=1")).toBe("/relative/path?a=1");
    expect(safeDecodeUrl("https://api.example.com/users?page=1")).toBe(
      "https://api.example.com/users?page=1",
    );
  });
});

describe("safeDecodeUrl — 깨진 입력 (R4)", () => {
  it("유효 한글에 깨진 바이트가 인접한 run은 전체 보존(바이트 분할 안 함)", () => {
    const u = "https://a.com/q?bad=%EA%B9%80%FF";
    expect(safeDecodeUrl(u)).toBe(u);
  });

  it("잘린/깨진 escape(%2, %GG)는 불변·no-throw", () => {
    expect(safeDecodeUrl("/q?x=%2")).toBe("/q?x=%2");
    expect(safeDecodeUrl("/q?x=%GG")).toBe("/q?x=%GG");
  });
});

describe("safeDecodeUrl — 멱등 (R5)", () => {
  it("파일 내 전체 golden 입력 corpus에 재적용해도 불변 (의존성 0 property-over-corpus)", () => {
    // spec R5 acceptance의 "property"는 fast-check 추가 없이 corpus 전수로 해석(신규 의존성 0 제약).
    const corpus = [
      "https://a.com/%EA%B2%80%EC%83%89/%EC%83%81%ED%92%88?%EC%B9%B4=%EC%8B%A0%EB%B0%9C",
      "/p?q=%ED%95%9C%20%EA%B8%80",
      "https://a.com/q?v=%41%42%43",
      "https://a.com/api?redirect=https%3A%2F%2Fb.com%2Fpath%3Fx%3D1%26y%3D2",
      "https://a.com/q?tpl=%7B%7Bu%7D%7D&d=%24%7Bv%7D",
      "https://a.com/q?pct=100%25&plus=a%2Bb&raw=c+d",
      "https://a.com/q?name=%EA%B9%80%26%EC%9D%B4",
      "https://a.com/q?p=%2fpath%3d1",
      "https://a.com/q?x=%C2%A0y&z=%E2%80%8B",
      "https://%ED%95%9C@h.com/p%ED%95%9C",
      "/p?q=%ED%95%9C#f%ED%95%9C",
      "${BASE_URL}/my?tab=%ED%99%88%20%EC%84%A4%EC%A0%95",
      "/relative/path?a=1",
      "https://a.com/q?bad=%EA%B9%80%FF",
      "/q?x=%2",
      "/q?x=%GG",
      "https://a.com/q?a=%EF%BB%BF&b=%EF%BB%BF%26&c=%EA%B9%80%EF%BB%BF",
      "/q?e=%F0%9F%98%80",
      "%EF%BB%BF",
    ];
    for (const u of corpus) {
      const once = safeDecodeUrl(u);
      expect(safeDecodeUrl(once)).toBe(once);
    }
  });
});

describe("safeDecodeComponent", () => {
  it("URL 구조 파싱 없이 문자열 전체에 run 치환을 적용한다", () => {
    expect(safeDecodeComponent("/%EA%B2%80%EC%83%89")).toBe("/검색");
    expect(safeDecodeComponent("a%2Fb")).toBe("a%2Fb");
  });
});
