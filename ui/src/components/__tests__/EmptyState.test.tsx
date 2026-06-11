import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EmptyState } from "../EmptyState";

describe("EmptyState", () => {
  it("본문과 action을 렌더한다", () => {
    render(<EmptyState body="아직 없습니다." action={<button type="button">만들기</button>} />);
    expect(screen.getByText("아직 없습니다.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "만들기" })).toBeInTheDocument();
  });

  it("action 없으면 본문만", () => {
    render(<EmptyState body="아직 없습니다." />);
    expect(screen.getByText("아직 없습니다.")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
