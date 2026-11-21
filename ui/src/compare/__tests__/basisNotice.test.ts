import { describe, expect, it } from "vitest";
import { basisNotice } from "../basisNotice";

const rep = (id: string, selected?: "steady" | "whole") =>
  ({ run: { id }, basis: selected ? { selected } : undefined }) as never;
const labels = { a: "#aaa111", b: "#bbb222", c: "#ccc333" };

describe("basisNotice", () => {
  it("모두 basis 없음 → null", () => {
    expect(basisNotice([rep("a"), rep("b")], labels)).toBeNull();
  });
  it("모두 유지 구간 → null", () => {
    expect(basisNotice([rep("a", "steady"), rep("b", "steady")], labels)).toBeNull();
  });
  it("steady 기준과 basis 없는 run이 섞이면 run 순서대로 적는다", () => {
    expect(basisNotice([rep("a", "steady"), rep("b")], labels)).toBe(
      "집계 기준이 다릅니다 — #aaa111: 유지 구간, #bbb222: 전체 구간",
    );
  });
  it("steady run이지만 전체 구간으로 떨어진 것(selected whole)은 전체 구간", () => {
    expect(basisNotice([rep("a", "whole"), rep("b", "steady")], labels)).toBe(
      "집계 기준이 다릅니다 — #aaa111: 전체 구간, #bbb222: 유지 구간",
    );
  });
  it("세 run", () => {
    expect(basisNotice([rep("a", "steady"), rep("b"), rep("c", "steady")], labels)).toBe(
      "집계 기준이 다릅니다 — #aaa111: 유지 구간, #bbb222: 전체 구간, #ccc333: 유지 구간",
    );
  });
});
