import { describe, expect, it } from "vitest";
import { queryKeys, sameRunPlaceholder } from "../hooks";

describe("queryKeys.runReport", () => {
  it("기준마다 키가 다르고 둘 다 run 접두사를 지킨다", () => {
    const base = queryKeys.runReport("R");
    const whole = queryKeys.runReport("R", "whole");
    expect(base).not.toEqual(whole);
    expect(base.slice(0, 3)).toEqual(["runs", "R", "report"]);
    expect(whole.slice(0, 3)).toEqual(["runs", "R", "report"]);
  });
});

describe("sameRunPlaceholder", () => {
  it("같은 run에서 기준만 바뀌면 이전 데이터를 돌려준다", () => {
    const pick = sameRunPlaceholder("R");
    expect(pick({ n: 1 }, { queryKey: queryKeys.runReport("R", "steady") })).toEqual({ n: 1 });
  });

  it("run이 바뀌면 undefined", () => {
    const pick = sameRunPlaceholder("B");
    expect(pick({ n: 1 }, { queryKey: queryKeys.runReport("A") })).toBeUndefined();
  });

  it("이전 쿼리가 없으면 undefined", () => {
    expect(sameRunPlaceholder("R")(undefined, undefined)).toBeUndefined();
  });
});
