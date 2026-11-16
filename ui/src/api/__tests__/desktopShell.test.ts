import { describe, expect, it } from "vitest";
import { readDesktopShell } from "../desktopShell";

describe("readDesktopShell", () => {
  it("표지가 없으면 null", () => expect(readDesktopShell({})).toBeNull());
  it("모양이 틀리면 null", () =>
    expect(readDesktopShell({ __HANDICAP_DESKTOP__: { rolePageUrl: 3 } })).toBeNull());
  it("여분 필드면 null(strict)", () =>
    expect(
      readDesktopShell({ __HANDICAP_DESKTOP__: { rolePageUrl: "x", token: "t" } }),
    ).toBeNull());
  it("정상 표지", () =>
    expect(
      readDesktopShell({ __HANDICAP_DESKTOP__: { rolePageUrl: "tauri://localhost/role.html" } }),
    ).toEqual({ rolePageUrl: "tauri://localhost/role.html" }));
});
