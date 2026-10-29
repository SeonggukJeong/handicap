import { describe, expect, it } from "vitest";
import { formatDateHms } from "../time";

describe("formatDateHms", () => {
  it("local YYYY-MM-DD HH:MM:SS, zero padded", () => {
    expect(formatDateHms(new Date(2026, 0, 5, 3, 4, 9).getTime())).toBe("2026-01-05 03:04:09");
    expect(formatDateHms(new Date(2026, 9, 29, 23, 59, 59).getTime())).toBe("2026-10-29 23:59:59");
  });
});
