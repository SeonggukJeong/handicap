import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { NarrativeBlock } from "../NarrativeBlock";
import type { Narrative } from "../../../api/schemas";
import { ko } from "../../../i18n/ko";

const SAMPLE: Narrative = {
  events: ["validity:transport_heavy", "insight:slo_pass"],
  can_claim: ["client_reachability_issue", "throughput_measured"],
  cannot_claim: ["sut_capacity", "production_identity"],
};

describe("NarrativeBlock", () => {
  it("renders nothing when narrative is missing (no fake ok)", () => {
    const { container } = render(<NarrativeBlock />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("region", { name: ko.narrative.sectionAria })).toBeNull();
  });

  it("renders three headings and mapped event/can/cannot via ko", () => {
    render(<NarrativeBlock narrative={SAMPLE} />);
    const region = screen.getByRole("region", { name: ko.narrative.sectionAria });
    expect(region).toHaveTextContent(ko.narrative.title);
    expect(region).toHaveTextContent(ko.narrative.eventsHeading);
    expect(region).toHaveTextContent(ko.narrative.canHeading);
    expect(region).toHaveTextContent(ko.narrative.cannotHeading);

    expect(region).toHaveTextContent(ko.narrative.event["validity:transport_heavy"]);
    expect(region).toHaveTextContent(ko.narrative.event["insight:slo_pass"]);
    expect(region).toHaveTextContent(ko.narrative.can.client_reachability_issue);
    expect(region).toHaveTextContent(ko.narrative.can.throughput_measured);
    expect(region).toHaveTextContent(ko.narrative.cannot.sut_capacity);
    expect(region).toHaveTextContent(ko.narrative.cannot.production_identity);
  });

  it("unknown event/can/cannot codes fall back to the wire code string", () => {
    const narrative: Narrative = {
      events: ["validity:future"],
      can_claim: ["future_can"],
      cannot_claim: ["future_cannot"],
    };
    render(<NarrativeBlock narrative={narrative} />);
    const region = screen.getByRole("region", { name: ko.narrative.sectionAria });
    expect(region).toHaveTextContent("validity:future");
    expect(region).toHaveTextContent("future_can");
    expect(region).toHaveTextContent("future_cannot");
  });
});
