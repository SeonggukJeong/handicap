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
