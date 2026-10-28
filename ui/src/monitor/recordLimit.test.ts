import { describe, it, expect } from "vitest";
import { worstCaseMb } from "./recordLimit";
import { newPanel } from "../api/monitors";

const p = (bar_count: number) => ({ ...newPanel(), bar_count });

describe("worstCaseMb", () => {
  it("uses one decimal below 10 MB", () => {
    expect(worstCaseMb([p(10)], 16)).toBe("0.2");
    expect(worstCaseMb([p(60)], 128)).toBe("7.5");
  });
  it("rounds and groups digits from 10 MB up", () => {
    expect(
      worstCaseMb(
        Array.from({ length: 9 }, () => p(300)),
        512,
      ),
    ).toBe("1,350");
  });
});
