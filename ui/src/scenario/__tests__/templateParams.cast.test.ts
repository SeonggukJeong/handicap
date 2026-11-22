import { describe, it, expect } from "vitest";
import { parse } from "yaml";
import {
  applyTokenSubstitutions,
  scanTemplateTokens,
  scanTemplateCasts,
  fitsCast,
  type SubMap,
} from "../templateParams";

const lit = (value: string) => ({ kind: "literal" as const, value });
const subs = (flow: SubMap["flow"], env: SubMap["env"] = {}): SubMap => ({ flow, env });

// JSON 본문의 값 전체가 캐스트 토큰인 자리(num·bool·json·str) + 캐스트가 안 먹는 자리(헤더·섞인 글자).
const FRAG = [
  "- id: 01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "  name: s",
  "  type: http",
  "  request:",
  "    method: POST",
  '    url: "http://h/{{n}}"',
  "    headers:",
  '      X-N: "{{n:num}}"',
  "    body:",
  "      json:",
  '        age: "{{n:num}}"',
  '        ok: "{{flag:bool}}"',
  '        obj: "{{o:json}}"',
  '        name: "{{s:str}}"',
  '        mixed: "id-{{n}}"',
  '        list: ["{{n:num}}"]',
  "",
].join("\n");

const body = (yamlText: string) =>
  (parse(yamlText) as Array<{ request: { body: { json: Record<string, unknown> } } }>)[0].request
    .body.json;
const headers = (yamlText: string) =>
  (parse(yamlText) as Array<{ request: { headers: Record<string, unknown> } }>)[0].request.headers;

describe("scanTemplateTokens — 캐스트는 이름에서 뗀다", () => {
  it("`{{n:num}}`과 `{{n}}`은 같은 변수 `n` 하나", () => {
    expect(scanTemplateTokens(FRAG).flow).toEqual(["n", "flag", "o", "s"]);
  });

  it("키워드가 아닌 `:word`는 이름의 일부로 남는다", () => {
    const frag = FRAG.replace('"{{s:str}}"', '"{{s:foo}}"');
    expect(scanTemplateTokens(frag).flow).toContain("s:foo");
  });
});

describe("scanTemplateCasts — JSON 본문의 값 전체인 캐스트 자리만", () => {
  it("변수별로 필요한 타입을 모은다 (헤더·섞인 글자는 세지 않는다)", () => {
    expect(scanTemplateCasts(FRAG)).toEqual({
      n: ["num"],
      flag: ["bool"],
      o: ["json"],
      s: ["str"],
    });
  });
});

describe("fitsCast — 엔진 coerce 규칙과 같은 판정", () => {
  it.each([
    ["num", "5", true],
    ["num", "-1.5", true],
    ["num", " 7 ", true],
    ["num", "1e3", true],
    ["num", "", false],
    ["num", "abc", false],
    ["num", "01", false],
    ["num", "true", false],
    ["num", "1e400", false],
    ["num", "12345678901234567890", false],
    ["bool", "true", true],
    ["bool", "false", true],
    ["bool", "True", false],
    ["bool", " true", false],
    ["bool", "1", false],
    ["json", '{"a":1}', true],
    ["json", "[1,2]", true],
    ["json", "null", true],
    ["json", "{a:1}", false],
    ["json", "", false],
    ["str", "", true],
    ["str", "anything", true],
  ])("%s ← %j = %s", (cast, value, want) => {
    expect(fitsCast(value, cast)).toBe(want);
  });
});

describe("applyTokenSubstitutions — 캐스트 자리의 리터럴은 그 타입으로", () => {
  it("num·bool·json·str 자리에 타입대로 들어간다", () => {
    const out = applyTokenSubstitutions(
      FRAG,
      subs({ n: lit("5"), flag: lit("true"), o: lit('{"a":[1,"x"]}'), s: lit("7") }),
    );
    const b = body(out);
    expect(b.age).toBe(5);
    expect(b.ok).toBe(true);
    expect(b.obj).toEqual({ a: [1, "x"] });
    expect(b.name).toBe("7"); // :str — 숫자처럼 보여도 문자열
    expect(b.mixed).toBe("id-5"); // 섞인 글자는 문자열
    expect(b.list).toEqual([5]);
    expect(out).toContain("\n        age: 5\n");
    expect(out).toContain("\n        ok: true\n");
  });

  it("JSON 본문 밖(헤더)의 캐스트 꼴 토큰은 문자열로 남는다", () => {
    const out = applyTokenSubstitutions(FRAG, subs({ n: lit("5") }));
    expect(headers(out)["X-N"]).toBe("5");
  });

  it("타입에 안 맞는 값은 문자열로 넣는다 (화면이 미리 막는 경우)", () => {
    const out = applyTokenSubstitutions(FRAG, subs({ n: lit("abc"), flag: lit("yes") }));
    expect(body(out).age).toBe("abc");
    expect(body(out).ok).toBe("yes");
  });

  it(":json 리터럴 안의 토큰 글자는 다시 치환하지 않는다", () => {
    const out = applyTokenSubstitutions(FRAG, subs({ o: lit('{"k":"{{n}}"}'), n: lit("5") }));
    expect(body(out).obj).toEqual({ k: "{{n}}" });
  });

  it("이름 바꾸기는 캐스트를 지킨다", () => {
    const out = applyTokenSubstitutions(FRAG, subs({ n: { kind: "rename", to: "count" } }));
    expect(out).toContain('age: "{{count:num}}"');
    expect(out).toContain('url: "http://h/{{count}}"');
    expect(out).toContain('mixed: "id-{{count}}"');
  });
});

describe("applyTokenSubstitutions — 한 번에 치환 (리터럴 안의 글자는 다시 건드리지 않는다)", () => {
  const TWO = [
    "- id: 01ARZ3NDEKTSV4RRFFQ69G5FAV",
    "  name: s",
    "  type: http",
    "  request:",
    "    method: GET",
    '    url: "http://h/{{a}}/${B}"',
    "",
  ].join("\n");
  const url = (yamlText: string) =>
    (parse(yamlText) as Array<{ request: { url: string } }>)[0].request.url;

  it("flow 리터럴 안의 `${B}`는 env 치환을 다시 타지 않는다", () => {
    const out = applyTokenSubstitutions(TWO, subs({ a: lit("${B}") }, { B: lit("X") }));
    expect(url(out)).toBe("http://h/${B}/X");
  });

  it("env 리터럴 안의 `{{a}}`도 그대로", () => {
    const out = applyTokenSubstitutions(TWO, subs({ a: lit("1") }, { B: lit("{{a}}") }));
    expect(url(out)).toBe("http://h/1/{{a}}");
  });

  it("env 기본값(`:-`)은 이름 바꾸기에서 보존", () => {
    const frag = TWO.replace("${B}", "${B:-fallback}");
    const out = applyTokenSubstitutions(frag, subs({}, { B: { kind: "rename", to: "C" } }));
    expect(url(out)).toBe("http://h/{{a}}/${C:-fallback}");
  });
});
