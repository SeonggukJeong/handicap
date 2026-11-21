import { describe, expect, it } from "vitest";
import { ko } from "../../i18n/ko";
import { profileSummary } from "../profileSummary";

describe("profileSummary", () => {
  it("closed+fixed", () => {
    const s = profileSummary({ vus: 20, duration_seconds: 60 });
    expect(s).toBe(ko.runSummary.closedFixed(20, 60));
    expect(s).toContain("20");
    expect(s).toContain("60");
  });

  it("closed+curve는 피크", () => {
    const s = profileSummary({
      vus: 0,
      duration_seconds: 0,
      vu_stages: [
        { target: 10, duration_seconds: 30 },
        { target: 50, duration_seconds: 30 },
      ],
    });
    expect(s).toBe(ko.runSummary.closedCurve(50, 60));
    expect(s).toContain("50");
    expect(s).toContain("60");
  });

  it("open+fixed", () => {
    const s = profileSummary({ vus: 0, target_rps: 100, duration_seconds: 45 });
    expect(s).toBe(ko.runSummary.openFixed(100, 45));
    expect(s).toContain("100");
    expect(s).toContain("45");
  });

  it("open+curve는 피크 (Math.max vs last-stage 구분: 내림차순 픽스처)", () => {
    const s = profileSummary({
      vus: 0,
      duration_seconds: 0,
      stages: [
        { target: 150, duration_seconds: 25 },
        { target: 80, duration_seconds: 20 },
      ],
    });
    expect(s).toBe(ko.runSummary.openCurve(150, 45));
    expect(s).toContain("150");
    expect(s).toContain("45");
  });
});

describe("steady_run_reads_as_fixed_everywhere", () => {
  const STEADY_OPEN = {
    vus: 0,
    duration_seconds: 0,
    max_in_flight: 50,
    stages: [
      { target: 80, duration_seconds: 30 },
      { target: 80, duration_seconds: 270 },
    ],
    steady: { target: 80, ramp_seconds: 30, hold_seconds: 270, discard_seconds: 5 },
  };
  it("도착률 고정 + 상승: 열린 80/s, 곡선·0 없음, 끝에 상승·버림", () => {
    const s = profileSummary(STEADY_OPEN);
    expect(s).toContain("열린 80/s");
    expect(s).not.toContain("열린 0/s");
    expect(s).not.toContain("곡선");
    expect(s.endsWith("상승 30초 · 버림 5초")).toBe(true);
  });
  it("상승 0이면 버림만, 버림 0이면 상승만", () => {
    expect(
      profileSummary({
        vus: 0,
        target_rps: 80,
        duration_seconds: 300,
        steady: { ramp_seconds: 0, hold_seconds: 300, discard_seconds: 5 },
      }).endsWith("버림 5초"),
    ).toBe(true);
    const rampOnly = profileSummary({
      ...STEADY_OPEN,
      steady: { target: 80, ramp_seconds: 30, hold_seconds: 270, discard_seconds: 0 },
    });
    expect(rampOnly.endsWith("상승 30초")).toBe(true);
    expect(rampOnly).not.toContain("버림");
  });
  it("VU 고정 + 상승도 같은 꼬리가 붙는다", () => {
    expect(
      profileSummary({
        vus: 5,
        duration_seconds: 60,
        steady: { ramp_seconds: 10, hold_seconds: 50, discard_seconds: 0 },
      }),
    ).toBe("고정 5 VU · 60s · 상승 10초");
  });
  it("steady 없는 프로필은 끝에 아무것도 붙지 않는다", () => {
    expect(profileSummary({ vus: 0, target_rps: 100, duration_seconds: 45 })).toBe(
      "열린 100/s · 45s",
    );
  });
});

describe("profileSummary stair", () => {
  it("계단 N개 · 최대 X/s", () => {
    const s = profileSummary({
      vus: 0,
      duration_seconds: 0,
      stair: { targets: [100, 800], hold_seconds: 60, ramp_seconds: 5, discard_seconds: 15 },
      stages: [{ target: 100, duration_seconds: 5 }],
    });
    expect(s).toBe("계단 2개 · 최대 800/s");
  });
});
