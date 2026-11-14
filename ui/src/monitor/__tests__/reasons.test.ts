import { describe, expect, it } from "vitest";
import { WIDEST_REASON_CANDIDATES } from "../reasons";

describe("WIDEST_REASON_CANDIDATES — check.rs REASON_*와 같은 글자를 유지", () => {
  it("가장 긴 고정 사유(조건 반복 소진)가 크기 프로브 후보에 든다", () => {
    // 후보에 없으면 사유 줄 배율이 이 글자를 못 담아 큰 글자에서 …로 잘린다.
    expect(WIDEST_REASON_CANDIDATES).toContain("조건 반복이 최대 횟수까지 풀리지 않음");
  });
});
