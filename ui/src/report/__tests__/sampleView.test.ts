import { describe, expect, it } from "vitest";
import { noLatencyWord, sampleName, sampleView } from "../sampleView";

describe("sampleView", () => {
  it.each([
    [{ selected: "failed", default: "passed", split: true }, true, "실패한 요청"],
    [{ selected: "all", default: "passed", split: true }, true, "모든 요청"],
    [{ selected: "passed", default: "passed", split: true }, false, null],
    [{ selected: "all", default: "all", split: false }, false, null],
  ] as const)("%j → switched %s, tag %s", (sample, switched, tag) => {
    const v = sampleView({ sample });
    expect(v.switched).toBe(switched);
    expect(v.tag).toBe(tag);
    expect(v.selected).toBe(sample.selected);
    expect(v.default).toBe(sample.default);
    expect(v.split).toBe(sample.split);
  });

  it("sample 없음 → all/all/false/false/null", () => {
    expect(sampleView({})).toEqual({
      selected: "all",
      default: "all",
      split: false,
      switched: false,
      tag: null,
    });
  });

  it("sampleName", () => {
    expect(sampleName("passed")).toBe("통과한 요청");
    expect(sampleName("failed")).toBe("실패한 요청");
    expect(sampleName("all")).toBe("모든 요청");
  });

  it("noLatencyWord", () => {
    expect(noLatencyWord("failed", 0)).toBe("실패한 요청 없음");
    expect(noLatencyWord("failed", 5)).toBe("실패한 요청은 모두 보내기 전에 실패해 잰 시간이 없음");
    expect(noLatencyWord("all", 0)).toBe("요청이 모두 보내기 전에 실패해 잰 시간이 없음");
    expect(noLatencyWord("passed", 0)).toBe("통과한 요청 없음");
  });
});
