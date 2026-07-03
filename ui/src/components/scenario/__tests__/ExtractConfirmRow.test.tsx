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
});
