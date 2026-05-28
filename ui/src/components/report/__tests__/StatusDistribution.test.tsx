import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { StatusDistribution } from "../StatusDistribution";

describe("StatusDistribution", () => {
  it("renders an SVG bar chart when distribution is non-empty", () => {
    render(<StatusDistribution distribution={{ "200": 950, "500": 50 }} />);
    const region = screen.getByRole("region", { name: /Status distribution/ });
    expect(region.querySelector("svg")).not.toBeNull();
    expect(region).toHaveTextContent("Status codes");
  });

  it("shows empty-state text when no status data", () => {
    render(<StatusDistribution distribution={{}} />);
    expect(screen.getByText(/No status data/)).toBeInTheDocument();
  });
});
