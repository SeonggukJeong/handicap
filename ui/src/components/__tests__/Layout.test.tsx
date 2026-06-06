import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Layout } from "../Layout";

describe("Layout nav", () => {
  it("has a Schedules nav link to /schedules", () => {
    render(
      <MemoryRouter>
        <Layout />
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: /schedules/i })).toHaveAttribute("href", "/schedules");
  });
});
