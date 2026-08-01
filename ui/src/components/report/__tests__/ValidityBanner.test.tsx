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

  it("loadgen_port_exhaustion reason names the load generator machine, not SUT (F1)", () => {
    // F1: before this reason existed, `level` could compute to "ok" ("해석 가능")
    // while InsightPanel already rendered the critical loadgen_port_exhaustion
    // insight — a contradiction. ValidityBanner must surface the same reason text.
    const validity: Validity = {
      level: "suspect",
      reasons: [{ kind: "loadgen_port_exhaustion", severity: "critical", count: 3 }],
    };
    render(<ValidityBanner validity={validity} />);
    const expected = ko.validity.reason.loadgen_port_exhaustion((3).toLocaleString("en-US"));
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

  // Task 3의 NarrativeBlock.test.tsx가 지녔던 커버리지: 미지 can_claim/cannot_claim
  // 코드는 map[code] ?? code(ValidityBanner.tsx label())로 raw wire-code 문자열을
  // 그대로 보여준다. level: "suspect"로 detail을 기본 펼침 상태로 만들어야 claim
  // 목록이 실제로 렌더된다(접힌 상태면 이 분기에 도달 못 한다).
  it("미지 can_claim/cannot_claim 코드는 raw wire-code 문자열로 폴백한다", () => {
    render(
      <ValidityBanner
        validity={{ level: "suspect", reasons: [{ kind: "zero_requests", severity: "critical" }] }}
        narrative={{
          can_claim: ["future_can_claim_code"],
          cannot_claim: ["future_cannot_claim_code"],
        }}
      />,
    );
    const region = screen.getByRole("region", { name: ko.validity.bannerAria });
    expect(region).toHaveTextContent("future_can_claim_code");
    expect(region).toHaveTextContent("future_cannot_claim_code");
  });

  // Task 3: merged validity + narrative block (spec §5.1). ok is unrendered (US1 — 0 lines),
  // limited collapses the interpretation detail, suspect expands it.
  it("suspect면 상세가 펼쳐지고 can/cannot이 유효성 region 안에 딱 한 번 있다", () => {
    render(
      <ValidityBanner
        validity={{ level: "suspect", reasons: [{ kind: "zero_requests", severity: "critical" }] }}
        narrative={{
          can_claim: ["client_reachability_issue"],
          cannot_claim: ["production_identity"],
        }}
      />,
    );
    // 픽스처 조건: suspect(기본 펼침) + can_claim 비지 않음 — 둘 중 하나라도
    // 빠지면 canHeading이 0개가 되어 이 단언이 공허해진다.
    const headings = screen.getAllByText(ko.narrative.canHeading);
    expect(headings).toHaveLength(1);
    const region = screen.getByRole("region", { name: ko.validity.bannerAria });
    expect(region).toContainElement(headings[0]);
  });

  it("limited면 상세가 접혀 있다", () => {
    render(
      <ValidityBanner
        validity={{
          level: "limited",
          reasons: [{ kind: "no_response_validation", severity: "warning" }],
        }}
        narrative={{
          can_claim: ["throughput_measured"],
          cannot_claim: ["production_identity"],
        }}
      />,
    );
    expect(screen.queryByText(ko.narrative.canHeading)).toBeNull();
    expect(screen.getByRole("button", { name: ko.narrative.title })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("ok면 블록 자체를 안 그린다 (US1 — 0줄)", () => {
    const { container } = render(
      <ValidityBanner
        validity={{ level: "ok", reasons: [] }}
        narrative={{ can_claim: [], cannot_claim: [] }}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("validity 부재(구식 리포트)면 미렌더 — 가짜 ok 금지", () => {
    const { container } = render(<ValidityBanner validity={undefined} narrative={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("narrative가 없으면 토글도 안 뜬다", () => {
    render(
      <ValidityBanner
        validity={{
          level: "limited",
          reasons: [{ kind: "no_response_validation", severity: "warning" }],
        }}
        narrative={undefined}
      />,
    );
    expect(screen.queryByRole("button", { name: ko.narrative.title })).toBeNull();
  });

  // 위 테스트만 두면 `hasDetail = narrative != null`로 잘못 써도 통과한다 —
  // "열 것이 없으면 토글도 없다"를 증명하려면 빈 배열 분기가 따로 필요하다.
  it("can/cannot이 둘 다 비면 토글이 안 뜬다", () => {
    render(
      <ValidityBanner
        validity={{
          level: "limited",
          reasons: [{ kind: "no_response_validation", severity: "warning" }],
        }}
        narrative={{ can_claim: [], cannot_claim: [] }}
      />,
    );
    expect(screen.queryByRole("button", { name: ko.narrative.title })).toBeNull();
  });
});
