import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { Summary } from "../Summary";

describe("Summary", () => {
  it("renders all summary cards with formatted numbers", () => {
    render(
      <Summary
        summary={{
          count: 12345,
          errors: 7,
          rps: 123.4,
          duration_seconds: 30,
          p50_ms: 10,
          p95_ms: 50,
          p99_ms: 90,
        }}
      />,
    );
    const region = screen.getByRole("region", { name: /Report summary/i });
    expect(region).toHaveTextContent("12,345");
    expect(region).toHaveTextContent("7");
    expect(region).toHaveTextContent("123.4");
    expect(region).toHaveTextContent("30s");
    expect(region).toHaveTextContent("10 ms");
    expect(region).toHaveTextContent("50 ms");
    expect(region).toHaveTextContent("90 ms");
  });
});
