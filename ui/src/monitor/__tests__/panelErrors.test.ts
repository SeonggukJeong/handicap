import { describe, it, expect } from "vitest";
import { parseGroupError, parsePanelError } from "../panelErrors";

describe("parseGroupError", () => {
  it("parses_group_prefix", () => {
    expect(parseGroupError("점검 묶음 2: 칸이 없는 점검 묶음입니다")).toEqual({
      groupNumber: 2,
      reason: "칸이 없는 점검 묶음입니다",
    });
  });
  it("panel_prefix_is_null", () => {
    expect(parseGroupError("칸 1: x")).toBeNull();
  });
});

describe("parsePanelError", () => {
  it("parses_panel_prefix", () => {
    expect(parsePanelError("칸 3: 시나리오를 선택해야 합니다")).toEqual({
      index: 2,
      reason: "시나리오를 선택해야 합니다",
    });
  });
  it("board_level_message_is_null", () => {
    expect(parsePanelError("칸은 1~9개여야 합니다")).toBeNull();
  });
  it("keeps_multiline_reason", () => {
    expect(parsePanelError("칸 1: a\nb")).toEqual({ index: 0, reason: "a\nb" });
  });
});
