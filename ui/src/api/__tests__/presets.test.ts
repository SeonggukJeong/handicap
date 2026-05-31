import { describe, expect, it } from "vitest";
import { PresetSchema, PresetSummarySchema } from "../presets";

describe("PresetSchema", () => {
  it("parses a full preset with a data_binding", () => {
    const p = PresetSchema.parse({
      id: "P1",
      scenario_id: "S1",
      name: "baseline",
      profile: {
        vus: 4,
        duration_seconds: 8,
        ramp_up_seconds: 1,
        loop_breakdown_cap: 256,
        data_binding: { dataset_id: "D1", policy: "per_vu", mappings: [] },
      },
      env: { BASE_URL: "http://x" },
      created_at: 1,
      updated_at: 2,
    });
    expect(p.name).toBe("baseline");
    expect(p.profile.data_binding?.dataset_id).toBe("D1");
  });

  it("accepts data_binding: null (preset saved without a binding)", () => {
    const p = PresetSchema.parse({
      id: "P2",
      scenario_id: "S1",
      name: "no-binding",
      profile: { vus: 1, duration_seconds: 1, data_binding: null },
      env: {},
      created_at: 1,
      updated_at: 1,
    });
    expect(p.profile.data_binding ?? null).toBeNull();
  });

  it("summary parses id/name/vus/duration", () => {
    const s = PresetSummarySchema.parse({
      id: "P1",
      name: "x",
      vus: 2,
      duration_seconds: 5,
      created_at: 1,
      updated_at: 1,
    });
    expect(s.vus).toBe(2);
  });
});
