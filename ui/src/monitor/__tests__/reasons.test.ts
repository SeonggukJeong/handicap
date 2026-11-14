import { describe, expect, it } from "vitest";
import { WIDEST_REASON_CANDIDATES } from "../reasons";

describe("WIDEST_REASON_CANDIDATES — check.rs REASON_*와 같은 글자를 유지", () => {
  it("조건 반복 소진 사유가 크기 프로브 후보에 든다", () => {
    expect(WIDEST_REASON_CANDIDATES).toContain("조건 반복 최대 횟수 도달");
  });

  it("판정 줄 상한 사유가 크기 프로브 후보에 든다", () => {
    expect(WIDEST_REASON_CANDIDATES).toContain("판정 줄 상한 초과");
  });

  it("앞서 빠져 있던 짧은 사유도 후보에 든다", () => {
    for (const r of ["값 다름", "앞 단계 실패", "분기 값 없음"]) {
      expect(WIDEST_REASON_CANDIDATES).toContain(r);
    }
  });

  it("어떤 후보도 기존 최대 폭(응답 시간 기준 스텝 없음)보다 길지 않다", () => {
    // 이 목록의 가장 넓은 글자가 보드 전체 사유 줄 배율을 정한다 — 더 긴 고정 사유를 넣으면
    // 조건 반복이 없는 기존 보드의 사유 글자도 작아진다. 사유를 줄이거나 배율 영향을 검토할 것.
    const max = "응답 시간 기준 스텝 없음".length;
    for (const r of WIDEST_REASON_CANDIDATES) {
      expect(r.length, `"${r}"가 벽 화면 사유 배율의 기준 폭을 넘는다`).toBeLessThanOrEqual(max);
    }
  });
});
