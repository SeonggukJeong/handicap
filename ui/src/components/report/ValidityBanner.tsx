import { useState } from "react";
import type { Narrative, Validity, ValidityReason } from "../../api/schemas";
import { ko } from "../../i18n/ko";
import { floorPct } from "./format";
import { Callout } from "../ui/Callout";

// wire fraction 0–1 → display digits for templates that append "%" themselves
// (matches InsightPanel floorPct(pct*100) signal; strip trailing % for ko.reason.transport_heavy).
function pctDigits(fraction: number): string {
  return floorPct(fraction * 100).replace(/%$/, "");
}

function reasonText(r: ValidityReason): string {
  switch (r.kind) {
    case "zero_requests":
      return ko.validity.reason.zero_requests;
    case "transport_heavy":
      return ko.validity.reason.transport_heavy(
        pctDigits(r.pct ?? 0),
        (r.count ?? 0).toLocaleString("en-US"),
      );
    case "silent_http_errors":
      return ko.validity.reason.silent_http_errors;
    case "no_response_validation":
      return ko.validity.reason.no_response_validation;
    case "load_not_delivered":
      return ko.validity.reason.load_not_delivered;
    case "loadgen_port_exhaustion":
      return ko.validity.reason.loadgen_port_exhaustion((r.count ?? 0).toLocaleString("en-US"));
    default:
      // unknown codes: graceful raw fallback (Task 3 / plan)
      return r.kind;
  }
}

const LEVEL_VARIANT: Record<Validity["level"], "info" | "warn" | "error"> = {
  ok: "info",
  limited: "warn",
  suspect: "error",
};

const CAN_LABELS: Record<string, string | undefined> = ko.narrative.can;
const CANNOT_LABELS: Record<string, string | undefined> = ko.narrative.cannot;

function label(map: Record<string, string | undefined>, code: string): string {
  return map[code] ?? code;
}

function ClaimList({
  heading,
  codes,
  map,
}: {
  heading: string;
  codes: string[];
  map: Record<string, string | undefined>;
}) {
  if (codes.length === 0) return null;
  return (
    <div className="mt-2">
      <h4 className="mb-1 text-sm font-semibold">{heading}</h4>
      <ul className="list-disc space-y-0.5 pl-5">
        {codes.map((code) => (
          <li key={code}>{label(map, code)}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * 시험 유효성 + 결과 해석 병합 블록 (spec §5.1).
 * `ok`는 미렌더(US1 0줄), `limited`는 상세 접힘, `suspect`는 상세 펼침.
 * 접힘 상태는 **영속하지 않는다** — 영속시키면 suspect 경고를 영구히 숨길 수 있다.
 */
export function ValidityBanner({
  validity,
  narrative,
}: {
  validity?: Validity | null;
  narrative?: Narrative | null;
}) {
  const [open, setOpen] = useState(validity?.level === "suspect");

  // `ok`면 reasons 유무와 무관하게 미렌더 — 서버 불변식(validity.rs:131-137)이
  // ok ⟺ reasons 0을 보장한다. `!validity`(구식 리포트)도 미렌더(가짜 ok 금지).
  if (!validity || validity.level === "ok") return null;

  const hasDetail =
    (narrative?.can_claim.length ?? 0) > 0 || (narrative?.cannot_claim.length ?? 0) > 0;

  return (
    <Callout
      variant={LEVEL_VARIANT[validity.level]}
      role="region"
      aria-label={ko.validity.bannerAria}
      title={ko.validity.title}
      className="mb-6"
    >
      {validity.reasons.length > 0 ? (
        <ul className="list-disc space-y-0.5 pl-5">
          {validity.reasons.map((r, idx) => (
            <li key={`${r.kind}-${idx}`}>{reasonText(r)}</li>
          ))}
        </ul>
      ) : null}
      {hasDetail ? (
        <>
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="mt-2 text-xs underline"
          >
            <span aria-hidden="true">{open ? "▾ " : "▸ "}</span>
            {ko.narrative.title}
          </button>
          {open ? (
            <div>
              <ClaimList
                heading={ko.narrative.canHeading}
                codes={narrative?.can_claim ?? []}
                map={CAN_LABELS}
              />
              <ClaimList
                heading={ko.narrative.cannotHeading}
                codes={narrative?.cannot_claim ?? []}
                map={CANNOT_LABELS}
              />
            </div>
          ) : null}
        </>
      ) : null}
    </Callout>
  );
}
