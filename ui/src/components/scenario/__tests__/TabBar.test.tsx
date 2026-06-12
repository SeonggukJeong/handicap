import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TabBar } from "../TabBar";

describe("TabBar", () => {
  it("renders both tab labels with the active one styled", () => {
    render(<TabBar active="canvas" onChange={() => {}} />);
    const canvas = screen.getByRole("tab", { name: "Canvas" });
    const yaml = screen.getByRole("tab", { name: "YAML" });
    expect(canvas).toHaveAttribute("aria-selected", "true");
    expect(yaml).toHaveAttribute("aria-selected", "false");
    expect(canvas.className).toContain("border-slate-900");
    expect(yaml.className).not.toContain("border-slate-900");
  });

  it("calls onChange when an inactive tab is clicked", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TabBar active="canvas" onChange={onChange} />);
    await user.click(screen.getByRole("tab", { name: "YAML" }));
    expect(onChange).toHaveBeenCalledWith("yaml");
  });
});
