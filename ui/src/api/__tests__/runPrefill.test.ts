import { describe, expect, it } from "vitest";
import { envValueToRecord, normalizeProfile, profileDurationSeconds } from "../runPrefill";
import { ProfileSchema } from "../schemas";

describe("profileDurationSeconds", () => {
  it("returns duration_seconds for closed-loop / fixed-rate (no stages)", () => {
    expect(profileDurationSeconds(ProfileSchema.parse({ vus: 2, duration_seconds: 5 }))).toBe(5);
  });

  it("returns the sum of stage durations for a curve run (duration_seconds is 0)", () => {
    const p = ProfileSchema.parse({
      vus: 0,
      duration_seconds: 0,
      max_in_flight: 50,
      stages: [
        { target: 200, duration_seconds: 2 },
        { target: 0, duration_seconds: 2 },
      ],
    });
    expect(profileDurationSeconds(p)).toBe(4);
  });

  it("falls back to duration_seconds when stages is empty", () => {
    expect(
      profileDurationSeconds(ProfileSchema.parse({ vus: 1, duration_seconds: 7, stages: [] })),
    ).toBe(7);
  });
});

describe("envValueToRecord", () => {
  it("keeps string entries", () => {
    expect(envValueToRecord({ BASE_URL: "http://x", TOKEN: "abc" })).toEqual({
      BASE_URL: "http://x",
      TOKEN: "abc",
    });
  });

  it("drops non-string values (ADR-0014: env vars are strings)", () => {
    expect(envValueToRecord({ a: "1", b: 2, c: true, d: null })).toEqual({ a: "1" });
  });

  it("returns {} for null / arrays / primitives", () => {
    expect(envValueToRecord(null)).toEqual({});
    expect(envValueToRecord(["x"])).toEqual({});
    expect(envValueToRecord("nope")).toEqual({});
    expect(envValueToRecord(undefined)).toEqual({});
  });
});

describe("normalizeProfile", () => {
  it("fills defaults and returns a clean Profile (no leaked | undefined)", () => {
    // A run's profile, as stored — defaulted fields may be absent.
    const p = normalizeProfile({ vus: 4, duration_seconds: 8 });
    expect(p.ramp_up_seconds).toBe(0);
    expect(p.loop_breakdown_cap).toBe(256);
    expect(p.vus).toBe(4);
  });

  it("preserves an existing data_binding", () => {
    const p = normalizeProfile({
      vus: 1,
      duration_seconds: 1,
      data_binding: { dataset_id: "D1", policy: "per_vu", mappings: [] },
    });
    expect(p.data_binding?.dataset_id).toBe("D1");
  });
});
