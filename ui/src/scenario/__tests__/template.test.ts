import { describe, expect, it } from "vitest";
import { resolveForDisplay } from "../template";

describe("resolveForDisplay", () => {
  it("substitutes ${NAME} from env", () => {
    expect(
      resolveForDisplay("${BASE_URL}/login", { BASE_URL: "http://localhost:9090" }),
    ).toBe("http://localhost:9090/login");
  });

  it("leaves unknown ${NAME} verbatim", () => {
    expect(resolveForDisplay("${BASE_URL}/login", {})).toBe("${BASE_URL}/login");
  });

  it("falls back to default for ${NAME:-default}", () => {
    expect(resolveForDisplay("${MISSING:-fallback}/x", {})).toBe("fallback/x");
    expect(
      resolveForDisplay("${BASE:-fb}", { BASE: "http://x" }),
    ).toBe("http://x");
  });

  it("leaves system vars (vu_id, iter_id) verbatim", () => {
    expect(resolveForDisplay("/users/${vu_id}", {})).toBe("/users/${vu_id}");
    expect(resolveForDisplay("/iter/${iter_id}", { iter_id: "ignored" })).toBe(
      "/iter/${iter_id}",
    );
  });

  it("leaves flow {{var}} placeholders verbatim", () => {
    expect(
      resolveForDisplay("${BASE_URL}/me", { BASE_URL: "http://x" }) +
        "?token={{token}}",
    ).toBe("http://x/me?token={{token}}");
  });

  it("tolerates malformed ${ without closing brace", () => {
    expect(resolveForDisplay("a${BROKEN", { BROKEN: "x" })).toBe("a${BROKEN");
  });
});
