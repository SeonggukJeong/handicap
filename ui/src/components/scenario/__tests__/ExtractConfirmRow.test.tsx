import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ExtractConfirmRow } from "../ExtractConfirmRow";
import { ko } from "../../../i18n/ko";

describe("ExtractConfirmRow — varName input adopts primitive Input (design-system-editor)", () => {
  it("varName input uses primitive Input with accent focus-ring class + font-mono preserved", () => {
    render(
      <ExtractConfirmRow
        proposed={{ var: "token", from: "body", path: "$.token" }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const varName = screen.getByLabelText(ko.editor.extractVarNameAria);
    expect(varName).toHaveClass("focus:ring-accent-500/30"); // Input BASE — RED before migration
    expect(varName).toHaveClass("font-mono");
  });

  it('varName input preserves inherited text-xs density (size="sm") — not the Input default text-sm', () => {
    render(
      <ExtractConfirmRow
        proposed={{ var: "token", from: "body", path: "$.token" }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const varName = screen.getByLabelText(ko.editor.extractVarNameAria);
    expect(varName).toHaveClass("text-xs");
    expect(varName).not.toHaveClass("text-sm");
  });
});

describe("ExtractConfirmRow — accent 색 (button-accent-migration)", () => {
  it("확인(추가) 버튼과 행 배경은 accent 토큰(indigo→accent)", () => {
    render(
      <ExtractConfirmRow
        proposed={{ var: "token", from: "body", path: "$.token" }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const addBtn = screen.getByRole("button", { name: "추가" }); // 유일(다른 버튼="취소")
    expect(addBtn).toHaveClass("bg-accent-600"); // 이주 전 RED (현 bg-indigo-600)
    const row = addBtn.closest("div"); // 버튼의 직속 부모 = bg-*-50 행
    expect(row?.className).toContain("bg-accent-50"); // 이주 전 RED (현 bg-indigo-50)
  });
});
