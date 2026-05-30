import { describe, it, expect } from "vitest";
import { ProfileSchema, DataBindingSchema } from "../schemas";

describe("data_binding schema", () => {
  it("parses a profile with a column-mapped per_vu binding", () => {
    const p = ProfileSchema.parse({
      vus: 2,
      duration_seconds: 5,
      data_binding: {
        dataset_id: "01J",
        policy: "per_vu",
        mappings: [{ kind: "column", var: "username", column: "email" }],
      },
    });
    expect(p.data_binding?.policy).toBe("per_vu");
    expect(p.data_binding?.mappings[0]).toEqual({
      kind: "column",
      var: "username",
      column: "email",
    });
  });

  it("parses a profile with no binding (back-compat)", () => {
    const p = ProfileSchema.parse({ vus: 1, duration_seconds: 1 });
    expect(p.data_binding ?? null).toBeNull();
  });

  it("accepts a literal mapping", () => {
    const b = DataBindingSchema.parse({
      dataset_id: "d",
      policy: "iter_sequential",
      mappings: [{ kind: "literal", var: "role", value: "admin" }],
    });
    expect(b.mappings[0]).toEqual({ kind: "literal", var: "role", value: "admin" });
  });

  it("parses a profile with an explicit null binding (back-compat)", () => {
    const p = ProfileSchema.parse({ vus: 1, duration_seconds: 1, data_binding: null });
    expect(p.data_binding ?? null).toBeNull();
  });

  it("rejects unknown binding policy", () => {
    expect(() =>
      DataBindingSchema.parse({
        dataset_id: "d",
        policy: "round_robin",
        mappings: [],
      }),
    ).toThrow();
  });

  it("rejects column mapping without column field", () => {
    expect(() =>
      DataBindingSchema.parse({
        dataset_id: "d",
        policy: "per_vu",
        mappings: [{ kind: "column", var: "x" }],
      }),
    ).toThrow();
  });
});
