import { describe, expect, it } from "vitest";
import { parseScenarioDoc } from "../../scenario/yamlDoc";
import type { Har } from "../filters";
import {
  type ConvertOptions,
  harToScenarioYaml,
  inferName,
  parameterizeUrl,
  parseHar,
} from "../harToScenario";

const DEFAULTS: ConvertOptions = {
  excludeStatic: false,
  includedHosts: null,
  excludedIndices: new Set(),
  headerMode: "all",
  statusAssert: false,
  name: "Imported scenario",
};

function har(entries: Har["log"]["entries"], pages?: Har["log"]["pages"]): Har {
  return { log: { entries, pages } };
}

function getEntry(): Har["log"]["entries"][number] {
  return {
    request: {
      method: "GET",
      url: "https://api.example.com/users?page=1",
      headers: [
        { name: "accept", value: "application/json" },
        { name: "host", value: "api.example.com" },
        { name: ":authority", value: "api.example.com" },
      ],
    },
    response: { status: 200, content: { mimeType: "application/json" } },
  };
}

function jsonPostEntry(bodyText: string): Har["log"]["entries"][number] {
  return {
    request: {
      method: "POST",
      url: "https://api.example.com/login",
      headers: [{ name: "content-type", value: "application/json" }],
      postData: { mimeType: "application/json", text: bodyText },
    },
    response: { status: 201, content: { mimeType: "application/json" } },
  };
}

describe("harToScenarioYaml", () => {
  it("R1: 캡처 순서 step 목록 + name='METHOD path' + ULID id", () => {
    const yaml = harToScenarioYaml(har([getEntry()]), DEFAULTS);
    const r = parseScenarioDoc(yaml);
    expect("model" in r).toBe(true);
    if (!("model" in r)) return;
    const step = r.model.steps[0];
    expect(step.name).toBe("GET /users");
    expect(step.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(step.type).toBe("http");
  });

  it("R2: 출력은 와이어-형 (parseScenarioDoc 통과 + body 'json:'/assert '- status:' 리터럴)", () => {
    const yaml = harToScenarioYaml(har([jsonPostEntry('{"u":"a"}')]), {
      ...DEFAULTS,
      statusAssert: true,
    });
    // 파싱 성공
    const r = parseScenarioDoc(yaml);
    expect("model" in r).toBe(true);
    // 와이어 구조 리터럴 (모델-형 {kind,value}/{kind,code}였다면 false-green이므로 직접 확인)
    expect(yaml).toMatch(/body:\s*\n\s*json:/);
    expect(yaml).toMatch(/assert:\s*\n\s*- status:/);
    expect(yaml).not.toContain("kind:");
  });

  it("R3: body 매핑 — json / json-cast-literal→raw / form-params / form-text / raw / none", () => {
    // json
    expect(harToScenarioYaml(har([jsonPostEntry('{"a":1}')]), DEFAULTS)).toMatch(/json:/);
    // json이지만 미지원 cast keyword(:int) 리터럴 → raw 폴백.
    // (표준 {{x:num}}/{{x:str}}/{{x:bool}} 단독값은 jsonBodyCastErrors가 유효로 봐 안 걸린다 — :int은 미지원이라 걸림)
    const castY = harToScenarioYaml(har([jsonPostEntry('{"t":"{{x:int}}"}')]), DEFAULTS);
    expect(castY).toMatch(/raw:/);
    expect(parseScenarioDoc(castY)).toHaveProperty("model"); // raw라 cast 검증 안 탐
    // form from params
    const formParams: Har = har([
      {
        request: {
          method: "POST",
          url: "https://x.com/f",
          headers: [],
          postData: {
            mimeType: "application/x-www-form-urlencoded",
            params: [{ name: "a", value: "1" }],
          },
        },
      },
    ]);
    expect(harToScenarioYaml(formParams, DEFAULTS)).toMatch(/form:/);
    // form from text (no params)
    const formText: Har = har([
      {
        request: {
          method: "POST",
          url: "https://x.com/f",
          headers: [],
          postData: { mimeType: "application/x-www-form-urlencoded", text: "a=1&b=2" },
        },
      },
    ]);
    const ft = harToScenarioYaml(formText, DEFAULTS);
    expect(ft).toMatch(/form:/);
    expect(ft).toContain("a:");
    // raw (text/plain)
    const rawE: Har = har([
      {
        request: {
          method: "POST",
          url: "https://x.com/r",
          headers: [],
          postData: { mimeType: "text/plain", text: "hello" },
        },
      },
    ]);
    expect(harToScenarioYaml(rawE, DEFAULTS)).toMatch(/raw:/);
    // none (GET, no postData) → body 키 없음
    expect(harToScenarioYaml(har([getEntry()]), DEFAULTS)).not.toMatch(/body:/);
  });

  it("R3 폴백: content-type=json이지만 본문이 깨진 JSON → raw 폴백 (parseScenarioDoc 통과)", () => {
    const yaml = harToScenarioYaml(har([jsonPostEntry("{not valid json")]), DEFAULTS);
    expect(yaml).toMatch(/raw:/);
    expect(yaml).toContain("{not valid json");
    expect(parseScenarioDoc(yaml)).toHaveProperty("model");
  });

  it("R4: 헤더 모드 — all 유지 / strip-volatile / semantic-only, :의사헤더는 전모드 제거", () => {
    const all = parseScenarioDoc(
      harToScenarioYaml(har([getEntry()]), { ...DEFAULTS, headerMode: "all" }),
    );
    if ("model" in all) {
      const s = all.model.steps[0];
      if (s.type === "http") {
        expect(s.request.headers).toHaveProperty("accept");
        expect(s.request.headers).toHaveProperty("host");
        expect(s.request.headers).not.toHaveProperty(":authority"); // 전모드 제거
      }
    }
    const strip = parseScenarioDoc(
      harToScenarioYaml(har([getEntry()]), { ...DEFAULTS, headerMode: "strip-volatile" }),
    );
    if ("model" in strip) {
      const s = strip.model.steps[0];
      if (s.type === "http") {
        expect(s.request.headers).not.toHaveProperty("host");
        expect(s.request.headers).toHaveProperty("accept");
      }
    }
    const sem = parseScenarioDoc(
      harToScenarioYaml(har([getEntry()]), { ...DEFAULTS, headerMode: "semantic-only" }),
    );
    if ("model" in sem) {
      const s = sem.model.steps[0];
      if (s.type === "http") {
        expect(s.request.headers).toHaveProperty("accept");
        expect(s.request.headers).not.toHaveProperty("host");
      }
    }
  });

  it("R6: statusAssert on→[{status}], off→[]", () => {
    const on = parseScenarioDoc(
      harToScenarioYaml(har([getEntry()]), { ...DEFAULTS, statusAssert: true }),
    );
    if ("model" in on) {
      const s = on.model.steps[0];
      if (s.type === "http") expect(s.assert).toEqual([{ kind: "status", code: 200 }]);
    }
    const off = parseScenarioDoc(harToScenarioYaml(har([getEntry()]), DEFAULTS));
    if ("model" in off) {
      const s = off.model.steps[0];
      if (s.type === "http") expect(s.assert).toEqual([]);
    }
  });

  it("R1 폴백: 상대 URL이어도 크래시 없이 name=url 원문", () => {
    const rel: Har = har([{ request: { method: "GET", url: "/relative/path", headers: [] } }]);
    const yaml = harToScenarioYaml(rel, DEFAULTS);
    expect(yaml).toContain("GET /relative/path");
  });

  it("R7: inferName — page title > 첫 호스트 > 폴백", () => {
    expect(inferName(har([getEntry()], [{ title: "  쇼핑 흐름  " }]))).toBe("쇼핑 흐름");
    expect(inferName(har([getEntry()]))).toBe("api.example.com");
    expect(inferName(har([{ request: { method: "GET", url: "/rel", headers: [] } }]))).toBe(
      "Imported scenario",
    );
  });

  it("R11: parseHar — 깨진 JSON·빈 entries는 throw", () => {
    expect(() => parseHar("{not json")).toThrow();
    expect(() => parseHar(JSON.stringify({ log: { entries: [] } }))).toThrow();
    expect(parseHar(JSON.stringify(har([getEntry()]))).log.entries).toHaveLength(1);
  });
});

describe("parameterizeUrl / hostVars (R9, R12)", () => {
  it("매핑된 호스트의 origin을 ${변수}로 치환, path·query 유지", () => {
    expect(
      parameterizeUrl("https://api.example.com/users?p=1", { "api.example.com": "BASE_URL" }),
    ).toBe("${BASE_URL}/users?p=1");
  });

  it("매핑에 없는 호스트·상대 URL은 불변", () => {
    expect(parameterizeUrl("https://cdn.x.com/a", { "api.example.com": "BASE_URL" })).toBe(
      "https://cdn.x.com/a",
    );
    expect(parameterizeUrl("/relative/path", { "api.example.com": "BASE_URL" })).toBe(
      "/relative/path",
    );
  });

  it("hostVars 미지정이면 불변(byte-identical)", () => {
    expect(parameterizeUrl("https://api.example.com/a")).toBe("https://api.example.com/a");
  });

  it("harToScenarioYaml: hostVars 주면 step url이 ${BASE_URL}/path 와이어-형", () => {
    const h = har([getEntry()]);
    const yaml = harToScenarioYaml(h, { ...DEFAULTS, hostVars: { "api.example.com": "BASE_URL" } });
    expect(yaml).toContain("url: ${BASE_URL}/users");
    // 와이어 구조 유지(파싱 + step 존재). (ui/CLAUDE.md "HAR import R2")
    const parsed = parseScenarioDoc(yaml);
    expect("model" in parsed).toBe(true);
  });

  it("harToScenarioYaml: hostVars 미지정이면 기존 절대 URL(byte-identical 경로)", () => {
    const h = har([getEntry()]);
    expect(harToScenarioYaml(h, DEFAULTS)).toContain("url: https://api.example.com/users");
  });
});
