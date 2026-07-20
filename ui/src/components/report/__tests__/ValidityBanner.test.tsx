import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ValidityBanner } from "../ValidityBanner";
import type { Validity } from "../../../api/schemas";
import { ko } from "../../../i18n/ko";
import { floorPct } from "../format";

describe("ValidityBanner", () => {
  it("renders nothing when validity is missing (no fake ok)", () => {
    const { container } = render(<ValidityBanner />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("region", { name: ko.validity.bannerAria })).toBeNull();
  });

  it("renders region with title and static reason kinds", () => {
    const validity: Validity = {
      level: "limited",
      reasons: [
        { kind: "zero_requests", severity: "critical" },
        { kind: "no_response_validation", severity: "warning" },
        { kind: "silent_http_errors", severity: "warning" },
        { kind: "load_not_delivered", severity: "warning" },
      ],
    };
    render(<ValidityBanner validity={validity} />);
    const region = screen.getByRole("region", { name: ko.validity.bannerAria });
    expect(region).toHaveTextContent(ko.validity.title);
    expect(region).toHaveTextContent(ko.validity.reason.zero_requests);
    expect(region).toHaveTextContent(ko.validity.reason.no_response_validation);
    expect(region).toHaveTextContent(ko.validity.reason.silent_http_errors);
    expect(region).toHaveTextContent(ko.validity.reason.load_not_delivered);
  });

  it("formats transport_heavy pct as percent (wire 0–1 fraction → display like InsightPanel)", () => {
    const validity: Validity = {
      level: "suspect",
      reasons: [
        {
          kind: "transport_heavy",
          severity: "critical",
          pct: 0.8,
          count: 80,
        },
      ],
    };
    render(<ValidityBanner validity={validity} />);
    // wire fraction 0.8 → 80%; ko template appends "%" after digits
    const digits = floorPct(0.8 * 100).replace(/%$/, "");
    const expected = ko.validity.reason.transport_heavy(digits, (80).toLocaleString("en-US"));
    expect(screen.getByRole("region", { name: ko.validity.bannerAria })).toHaveTextContent(
      expected,
    );
  });

  it("unknown reason kind falls back to the wire code string", () => {
    const validity: Validity = {
      level: "limited",
      reasons: [{ kind: "future_reason", severity: "info" }],
    };
    render(<ValidityBanner validity={validity} />);
    expect(screen.getByRole("region", { name: ko.validity.bannerAria })).toHaveTextContent(
      "future_reason",
    );
  });
});
