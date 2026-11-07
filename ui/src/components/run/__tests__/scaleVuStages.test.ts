import { describe, it, expect } from "vitest";
import { scaleVuStages } from "../sizing";

describe("scaleVuStages", () => {
  it("scales all stage targets by achievable/peak, preserving shape", () => {
    // peak 50, achievable 30 → factor 0.6: [50,20] → [30,12]
    const out = scaleVuStages(
      [
        { target: "50", duration_seconds: "10" },
        { target: "20", duration_seconds: "10" },
      ],
      30,
      50,
    );
    expect(out.map((s) => s.target)).toEqual(["30", "12"]);
    expect(out.map((s) => s.duration_seconds)).toEqual(["10", "10"]); // duration untouched
  });
  it("floors the peak stage at >=1 so at least one target stays positive", () => {
    // tiny achievable: peak 100, achievable 1 → factor 0.01, peak stage rounds to 1 (not 0)
    const out = scaleVuStages([{ target: "100", duration_seconds: "5" }], 1, 100);
    expect(out[0].target).toBe("1");
  });
  it("rounds each stage (not floor)", () => {
    const out = scaleVuStages([{ target: "10", duration_seconds: "5" }], 3, 10); // 10*0.3=3
    expect(out[0].target).toBe("3");
  });
});
