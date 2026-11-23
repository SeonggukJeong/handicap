import { describe, expect, it } from "vitest";
import { setupLiveView } from "../setupLive";

const live = (ok: number, failed: number) => ({ ok, failed, interrupted: 0 });

describe("setupLiveView", () => {
  it("고정 VU — 명 단위, 분모는 vus", () => {
    expect(setupLiveView({ vus: 50 }, live(37, 2))).toEqual({
      unit: "vu",
      ok: 37,
      failed: 2,
      total: 50,
      okPct: 74,
      failedPct: 4,
    });
  });

  it("live가 없으면 0", () => {
    const v = setupLiveView({ vus: 50 }, undefined);
    expect(v.ok).toBe(0);
    expect(v.failed).toBe(0);
    expect(v.total).toBe(50);
    expect(v.okPct).toBe(0);
  });

  it("open 고정은 슬롯 + max_in_flight", () => {
    const v = setupLiveView({ vus: 0, target_rps: 100, max_in_flight: 200 }, live(100, 0));
    expect(v.unit).toBe("slot");
    expect(v.total).toBe(200);
  });

  it("open 곡선·계단·유지 구간 open도 슬롯", () => {
    const stages = [{ target: 10, duration_seconds: 5 }];
    expect(setupLiveView({ vus: 0, stages, max_in_flight: 30 }, undefined)).toMatchObject({
      unit: "slot",
      total: 30,
    });
    expect(
      setupLiveView(
        {
          vus: 0,
          max_in_flight: 40,
          stair: {
            start_rps: 10,
            step_rps: 10,
            step_seconds: 10,
            max_steps: 3,
            settle_seconds: 1,
          },
        } as never,
        undefined,
      ),
    ).toMatchObject({ unit: "slot", total: 40 });
    expect(
      setupLiveView(
        {
          vus: 0,
          max_in_flight: 50,
          steady: { ramp_seconds: 1, hold_seconds: 5, discard_seconds: 0, target: 20 },
        } as never,
        undefined,
      ),
    ).toMatchObject({ unit: "slot", total: 50 });
  });

  it("open인데 max_in_flight가 없거나 null이면 분모 null", () => {
    const a = setupLiveView({ vus: 0, target_rps: 100, max_in_flight: null }, live(5, 0));
    expect(a.total).toBeNull();
    expect(a.okPct).toBe(0);
    const b = setupLiveView({ vus: 0, target_rps: 100 }, live(5, 0));
    expect(b.total).toBeNull();
    expect(b.okPct).toBe(0);
  });

  it("VU 곡선은 명 단위·분모 null", () => {
    const v = setupLiveView(
      { vus: 0, vu_stages: [{ target: 10, duration_seconds: 5 }] },
      live(120, 0),
    );
    expect(v.unit).toBe("vu");
    expect(v.total).toBeNull();
  });

  it("넘침은 잘라 합이 100을 넘지 않는다", () => {
    const a = setupLiveView({ vus: 10 }, live(12, 3));
    expect(a.okPct).toBe(100);
    expect(a.failedPct).toBe(0);
    const b = setupLiveView({ vus: 10 }, live(8, 5));
    expect(b.okPct).toBe(80);
    expect(b.failedPct).toBe(20);
  });

  it("vus 0은 분모 null", () => {
    expect(setupLiveView({ vus: 0 }, live(3, 0)).total).toBeNull();
  });
});
