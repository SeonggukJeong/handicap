import { describe, expect, it } from "vitest";
import { jsonBodyCastErrors } from "../cast";
import { ScenarioModel } from "../model";

describe("jsonBodyCastErrors", () => {
  it("accepts valid pure casts and cast-less tokens", () => {
    const body = {
      age: "{{age:num}}",
      ok: "{{vip:bool}}",
      zip: "{{zip:str}}",
      j: "{{cfg:json}}",
      name: "{{name}}",
      lit: "hello",
      n: 7,
    };
    expect(jsonBodyCastErrors(body)).toEqual([]);
  });

  it("flags an unknown cast keyword", () => {
    const errs = jsonBodyCastErrors({ age: "{{age:int}}" });
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("unknown cast ':int'");
  });

  it("accepts internal spaces around the colon (engine trims kw)", () => {
    // 엔진 parse_cast_leaf은 kw.trim()이라 `{{ age : num }}`를 유효한 :num으로 받는다.
    expect(jsonBodyCastErrors({ age: "{{ age : num }}" })).toEqual([]);
  });

  it("flags an unknown cast even with internal spaces (engine/UI lockstep)", () => {
    // `{{ age : int }}` → 엔진은 kw='int' → UnknownVar(runtime). UI도 미지원 keyword로 잡아야 함.
    const errs = jsonBodyCastErrors({ age: "{{ age : int }}" });
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("unknown cast ':int'");
  });

  it("flags a cast inside a non-standalone leaf", () => {
    const errs = jsonBodyCastErrors({ msg: "age is {{age:num}}!" });
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("standalone");
  });

  it("accepts a valid env/system token cast", () => {
    expect(jsonBodyCastErrors({ n: "${COUNT:num}", uid: "${vu_id:num}" })).toEqual([]);
  });

  it("accepts a :json cast on flow and env tokens", () => {
    expect(jsonBodyCastErrors({ o: "{{obj:json}}", c: "${cfg:json}" })).toEqual([]);
  });

  it("flags an unknown cast keyword on an env token", () => {
    const errs = jsonBodyCastErrors({ n: "${COUNT:int}" });
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("unknown cast ':int'");
  });

  it("flags a cast inside a non-standalone env leaf", () => {
    const errs = jsonBodyCastErrors({ msg: "n is ${COUNT:num}!" });
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("standalone");
  });

  it("accepts the env default ending in a keyword as a cast (engine/UI lockstep)", () => {
    // `${FOO:-bar:num}` → 엔진·UI 모두 마지막 :num을 캐스트로 본다(R3 경계).
    expect(jsonBodyCastErrors({ x: "${FOO:-bar:num}" })).toEqual([]);
  });

  it("does not flag the env default operator :-", () => {
    expect(jsonBodyCastErrors({ host: "${HOST:-num}" })).toEqual([]);
  });

  it("recurses arrays and nested objects", () => {
    const errs = jsonBodyCastErrors({ items: [{ q: "{{q:int}}" }] });
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("unknown cast ':int'");
  });
});

describe("ScenarioModel cast validation", () => {
  const base = (body: unknown) => ({
    version: 1,
    name: "s",
    steps: [
      {
        id: "01HX0000000000000000000001",
        name: "post",
        type: "http",
        request: { method: "POST", url: "/x", body: { kind: "json", value: body } },
      },
    ],
  });

  it("rejects a scenario with an unknown cast", () => {
    const r = ScenarioModel.safeParse(base({ age: "{{age:int}}" }));
    expect(r.success).toBe(false);
  });

  it("accepts a scenario with valid casts", () => {
    const r = ScenarioModel.safeParse(base({ age: "{{age:num}}", ok: "{{v:bool}}" }));
    expect(r.success).toBe(true);
  });
});
