import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Validity } from "../../../api/schemas";
import { ValidityBanner } from "../ValidityBanner";

describe("ValidityBanner setup_failed", () => {
  it("준비 스텝 실패 사유를 한국어 문구로 보인다", () => {
    const validity: Validity = {
      level: "limited",
      reasons: [{ kind: "setup_failed", severity: "warning", count: 2 }],
    };
    render(<ValidityBanner validity={validity} />);
    expect(screen.getByText("준비 스텝 실패로 부하가 설정보다 적었습니다")).toBeInTheDocument();
    expect(screen.queryByText("setup_failed")).not.toBeInTheDocument();
  });
});
