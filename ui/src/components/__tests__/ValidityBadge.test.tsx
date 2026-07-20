import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ValidityBadge } from "../ValidityBadge";
import type { Validity } from "../../api/schemas";
import { ko } from "../../i18n/ko";

function validity(level: Validity["level"], reasons: Validity["reasons"] = []): Validity {
  return { level, reasons };
}

describe("ValidityBadge", () => {
  it("renders each level label from ko.validity.level.*", () => {
    const { rerender } = render(<ValidityBadge validity={validity("ok")} />);
    expect(screen.getByText(ko.validity.level.ok)).toBeInTheDocument();

    rerender(<ValidityBadge validity={validity("limited")} />);
    expect(screen.getByText(ko.validity.level.limited)).toBeInTheDocument();

    rerender(<ValidityBadge validity={validity("suspect")} />);
    expect(screen.getByText(ko.validity.level.suspect)).toBeInTheDocument();
  });

  it("ok uses slate/neutral tone classes", () => {
    render(<ValidityBadge validity={validity("ok")} />);
    const el = screen.getByText(ko.validity.level.ok);
    expect(el.className).toMatch(/slate/);
    expect(el.className).not.toMatch(/emerald/);
  });

  it("limited uses amber tone classes", () => {
    render(<ValidityBadge validity={validity("limited")} />);
    expect(screen.getByText(ko.validity.level.limited).className).toMatch(/amber/);
  });

  it("suspect uses red/amber-red tone classes", () => {
    render(<ValidityBadge validity={validity("suspect")} />);
    const el = screen.getByText(ko.validity.level.suspect);
    expect(el.className).toMatch(/red|amber/);
  });

  it("renders nothing when validity is missing (no fake ok)", () => {
    const { container } = render(<ValidityBadge />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText(ko.validity.level.ok)).toBeNull();
  });

  it("renders nothing when validity is null/undefined", () => {
    const { container, rerender } = render(<ValidityBadge validity={null} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<ValidityBadge validity={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });
});
