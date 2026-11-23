import { describe, expect, it } from "vitest";
import { sampleNotice } from "../sampleNotice";

const rep = (def?: "passed" | "all") =>
  ({
    run: { id: "x" },
    sample: def ? { selected: def, default: def, split: def === "passed" } : undefined,
  }) as never;

describe("sampleNotice", () => {
  it("모두 통과한 요청 → null", () => {
    expect(sampleNotice([rep("passed"), rep("passed")])).toBeNull();
  });
  it("모두 옛 run(표본 없음) → null", () => {
    expect(sampleNotice([rep(), rep("all")])).toBeNull();
  });
  it("표본이 섞이면 안내 문구", () => {
    const text =
      "고른 run 중 일부는 실패한 요청을 포함해 응답 시간을 계산했습니다. 응답 시간을 그대로 비교하기 어렵습니다.";
    expect(sampleNotice([rep("passed"), rep()])).toBe(text);
    expect(sampleNotice([rep("all"), rep("passed"), rep("passed")])).toBe(text);
  });
});
