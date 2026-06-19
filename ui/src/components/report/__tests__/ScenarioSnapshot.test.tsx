import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect } from "vitest";
import { ScenarioSnapshot } from "../ScenarioSnapshot";

describe("ScenarioSnapshot", () => {
  it("is collapsed by default and expands on click", async () => {
    const yaml = "version: 1\nname: test\n";
    render(<ScenarioSnapshot yaml={yaml} />);
    expect(screen.queryByText(yaml)).toBeNull();
    const btn = screen.getByRole("button", { name: /시나리오 YAML/ });
    await userEvent.setup().click(btn);
    expect(screen.getByText(/version: 1/)).toBeInTheDocument();
  });
});
