import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { AppliedTimeouts } from "../AppliedTimeouts";
import { ko } from "../../../i18n/ko";
import { normalizeProfile } from "../../../api/runPrefill";

function prof(over: Record<string, unknown>) {
  return normalizeProfile({ vus: 1, duration_seconds: 5, ...over });
}

describe("AppliedTimeouts (spec §4 — 명시 설정 시에만 한 줄)", () => {
  it("① connect만 설정: 기본값 병기 — 전체일치(부분문자열 함정 방어)", () => {
    render(
      <AppliedTimeouts
        profile={prof({ connect_timeout_seconds: 5 })}
        hasStepTimeoutOverride={false}
      />,
    );
    const line = screen.getByText(new RegExp(ko.report.appliedTimeoutsLead));
    // ①/②는 "(기본값)" 접미로만 갈리므로 textContent 정확 비교(spec §5-①).
    expect(line.textContent).toBe(
      `${ko.report.appliedTimeoutsLead} — ${ko.report.appliedTimeoutsHttpDefault(30)} · ${ko.report.appliedTimeoutsConnect(5)}`,
    );
    expect(line.textContent).toContain("5"); // 보간 소실 가드(공허 11호)
  });
  it("② 둘 다 설정: 두 세그먼트 숫자 — 전체일치", () => {
    render(
      <AppliedTimeouts
        profile={prof({ http_timeout_seconds: 10, connect_timeout_seconds: 5 })}
        hasStepTimeoutOverride={false}
      />,
    );
    const line = screen.getByText(new RegExp(ko.report.appliedTimeoutsLead));
    expect(line.textContent).toBe(
      `${ko.report.appliedTimeoutsLead} — ${ko.report.appliedTimeoutsHttp(10)} · ${ko.report.appliedTimeoutsConnect(5)}`,
    );
    expect(line.textContent).toContain("10");
  });
  it("③ http만 비기본: 요청 세그먼트만", () => {
    render(
      <AppliedTimeouts
        profile={prof({ http_timeout_seconds: 10 })}
        hasStepTimeoutOverride={false}
      />,
    );
    expect(screen.getByText(new RegExp(ko.report.appliedTimeoutsLead)).textContent).toBe(
      `${ko.report.appliedTimeoutsLead} — ${ko.report.appliedTimeoutsHttp(10)}`,
    );
  });
  it("④ 둘 다 기본: 미렌더(0-diff)", () => {
    const { container } = render(
      <AppliedTimeouts profile={prof({})} hasStepTimeoutOverride={false} />,
    );
    expect(container.firstChild).toBeNull();
    // 게이트는 노브 기준 — 오버라이드만 있고 노브 미설정이면 여전히 미렌더(꼬리는 부속, 단독 발화 금지).
    const { container: c2 } = render(
      <AppliedTimeouts profile={prof({})} hasStepTimeoutOverride={true} />,
    );
    expect(c2.firstChild).toBeNull();
  });
  it("⑤ 스텝 오버라이드 꼬리: true면 존재·false면 부재", () => {
    render(
      <AppliedTimeouts
        profile={prof({ connect_timeout_seconds: 5 })}
        hasStepTimeoutOverride={true}
      />,
    );
    expect(screen.getByText(new RegExp(ko.report.appliedTimeoutsLead)).textContent).toContain(
      ko.report.appliedTimeoutsStepOverride,
    );
    // false면 부재 — 제목이 약속한 양쪽을 다 단언(공허 제목 9호 방지, 리뷰 M5).
    // 2번째 render는 screen 다중매치를 피해 반환 container로 단언.
    const { container: cf } = render(
      <AppliedTimeouts
        profile={prof({ connect_timeout_seconds: 5 })}
        hasStepTimeoutOverride={false}
      />,
    );
    expect(cf.textContent).not.toContain(ko.report.appliedTimeoutsStepOverride);
  });
});
