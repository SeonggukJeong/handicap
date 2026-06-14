import { describe, it, expect } from "vitest";
import { recommendVus, pickLatestClosedRun, recommendSlots, pickLatestOpenRun } from "../sizing";
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

describe("recommendSlots", () => {
  it("단일-스텝 정확값: 1000 RPS × 50ms = 50슬롯", () => {
    expect(recommendSlots(1000, 50)).toEqual({ recommendedSlots: 50 });
  });

  it("200 RPS × 250ms = 50슬롯", () => {
    expect(recommendSlots(200, 250)?.recommendedSlots).toBe(50);
  });

  it("insight 수식 동치: ceil(target × p50/1000), 최소 1", () => {
    // 2000 RPS × 53ms = 106 (= insights.rs:224 required)
    expect(recommendSlots(2000, 53)?.recommendedSlots).toBe(106);
    // floor: 아주 작은 곱도 최소 1
    expect(recommendSlots(1, 1)?.recommendedSlots).toBe(1);
    expect(recommendSlots(1, 0.4)?.recommendedSlots).toBe(1);
  });

  it("가드 → null", () => {
    expect(recommendSlots(0, 50)).toBeNull(); // target < 1
    expect(recommendSlots(1_000_001, 50)).toBeNull(); // target > max
    expect(recommendSlots(1.5, 50)).toBeNull(); // 비정수 target
    expect(recommendSlots(1000, 0)).toBeNull(); // latency 0
    expect(recommendSlots(1000, -5)).toBeNull(); // latency 음수
    expect(recommendSlots(1000, NaN)).toBeNull(); // latency NaN
    expect(recommendSlots(1000, Infinity)).toBeNull(); // latency Inf
  });
});

describe("pickLatestOpenRun", () => {
  // pickLatestOpenRun이 읽는 필드(status/profile.target_rps/profile.stages/created_at)만 가진 최소 fixture.
  const mk = (profile: Record<string, unknown>, created_at: number, status = "completed"): Run =>
    ({ id: `r${created_at}`, status, profile, created_at }) as unknown as Run;

  it("open-loop(target_rps) completed 중 최신 선택", () => {
    const runs = [
      mk({ target_rps: 100, max_in_flight: 50 }, 100),
      mk({ target_rps: 200, max_in_flight: 80 }, 300), // 최신 open
      mk({ vus: 5 }, 400), // closed+fixed → 제외
      mk({ target_rps: 50, max_in_flight: 10 }, 500, "running"), // 비완료 → 제외
    ];
    expect(pickLatestOpenRun(runs)?.created_at).toBe(300);
  });

  it("open-loop(stages, target_rps 없음)도 포함", () => {
    const runs = [mk({ stages: [{ target: 100, duration_seconds: 10 }], max_in_flight: 50 }, 200)];
    expect(pickLatestOpenRun(runs)?.created_at).toBe(200);
  });

  it("closed+fixed가 stray max_in_flight를 달고 있어도 제외(양성 식)", () => {
    // is_open_loop는 max_in_flight를 안 보고 target_rps/stages만 본다.
    const runs = [mk({ vus: 5, max_in_flight: 999 }, 100)];
    expect(pickLatestOpenRun(runs)).toBeNull();
  });

  it("VU곡선(vu_stages, target_rps/stages 없음) 제외", () => {
    const runs = [mk({ vus: 0, vu_stages: [{ target: 10, duration_seconds: 5 }] }, 100)];
    expect(pickLatestOpenRun(runs)).toBeNull();
  });

  it("해당 run 없으면 null", () => {
    expect(pickLatestOpenRun([mk({ vus: 5 }, 1), mk({ target_rps: 10 }, 2, "failed")])).toBeNull();
  });
});
