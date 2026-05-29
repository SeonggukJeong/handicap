import { describe, it, expect } from "vitest";
import { STARTER_YAML } from "../ScenarioNewPage";

describe("STARTER_YAML", () => {
  it("does not pre-seed a base_url variable", () => {
    expect(STARTER_YAML).not.toContain("base_url");
  });

  it("contains an empty variables map", () => {
    expect(STARTER_YAML).toContain("variables: {}");
  });
});
