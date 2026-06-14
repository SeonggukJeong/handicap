import { describe, it, expect } from "vitest";
import { recommendVus, pickLatestClosedRun } from "../sizing";
import type { Run } from "../../api/schemas";

describe("recommendVus", () => {
  it("prior: 선형 스케일 (VU 50→200 RPS, 목표 400 → 100)", () => {
    expect(recommendVus(400, { kind: "prior", priorVus: 50, priorRps: 200 })).toEqual({
      recommendedVus: 100,
      rpsPerVu: 4,
      basis: "prior",
    });
  });

  it("measured: 1요청/250ms → 4 rps/vu, 목표 400 → 100", () => {
    const r = recommendVus(400, { kind: "measured", reqPerIter: 1, iterMs: 250 });
    expect(r?.recommendedVus).toBe(100);
    expect(r?.basis).toBe("measured");
  });

  it("ceil + 최소 1", () => {
    expect(recommendVus(1, { kind: "prior", priorVus: 50, priorRps: 200 })?.recommendedVus).toBe(1);
    expect(recommendVus(401, { kind: "prior", priorVus: 50, priorRps: 200 })?.recommendedVus).toBe(
      101,
    );
  });

  it("가드 → null", () => {
    expect(recommendVus(0, { kind: "prior", priorVus: 50, priorRps: 200 })).toBeNull(); // target<1
    expect(recommendVus(1_000_001, { kind: "prior", priorVus: 50, priorRps: 200 })).toBeNull(); // target>max
    expect(recommendVus(1.5, { kind: "prior", priorVus: 50, priorRps: 200 })).toBeNull(); // 비정수
    expect(recommendVus(400, { kind: "estimate", reqPerIter: 0, iterMs: 250 })).toBeNull(); // rpsPerVu 0
    expect(recommendVus(400, { kind: "measured", reqPerIter: 1, iterMs: 0 })).toBeNull(); // iterMs 0 → Inf
    expect(recommendVus(400, { kind: "prior", priorVus: 0, priorRps: 200 })).toBeNull(); // div0 → Inf
  });
});

describe("pickLatestClosedRun", () => {
  // pickLatestClosedRun이 읽는 필드(status/profile.vus/created_at)만 가진 최소 fixture를 cast.
  const mk = (vus: number, created_at: number, status = "completed"): Run =>
    ({ id: `r${created_at}`, status, profile: { vus }, created_at }) as unknown as Run;

  it("vus>0인 completed 중 최신 선택 (vus==0=open/curve, 비완료 제외)", () => {
    const runs = [
      mk(10, 100),
      mk(50, 300),
      mk(0, 400), // open-loop 또는 VU곡선 → 제외
      mk(20, 500, "running"), // 비완료 → 제외
    ];
    expect(pickLatestClosedRun(runs)?.profile.vus).toBe(50);
  });

  it("해당 run 없으면 null", () => {
    expect(pickLatestClosedRun([mk(0, 1), mk(5, 2, "failed")])).toBeNull();
  });
});
