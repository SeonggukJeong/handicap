import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { ko } from "../../i18n/ko";
import { OnboardingGuide } from "../OnboardingGuide";

const KEY = "handicap.onboarding.v1";

function renderGuide(firstScenarioId: string | null) {
  return render(
    <MemoryRouter>
      <OnboardingGuide firstScenarioId={firstScenarioId} />
    </MemoryRouter>,
  );
}

describe("OnboardingGuide (홈 시작 가이드 카드)", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("시나리오 없음 → ① CTA 링크, ②③은 회색 안내", () => {
    renderGuide(null);
    const card = screen.getByRole("region", { name: ko.onboarding.ariaLabel });
    expect(within(card).getByRole("link", { name: `${ko.onboarding.step1Cta} →` })).toHaveAttribute(
      "href",
      "/scenarios/new",
    );
    expect(within(card).getByText(ko.onboarding.step2Blocked)).toBeInTheDocument();
    expect(within(card).getByText(ko.onboarding.step3Blocked)).toBeInTheDocument();
    expect(within(card).queryByRole("link", { name: `${ko.onboarding.step2Cta} →` })).toBeNull();
  });

  it("시나리오 있음 → ① 완료(CTA 없음), ② 첫 시나리오 실행 목록 링크", () => {
    renderGuide("S1");
    const card = screen.getByRole("region", { name: ko.onboarding.ariaLabel });
    expect(within(card).queryByRole("link", { name: `${ko.onboarding.step1Cta} →` })).toBeNull();
    expect(within(card).getByRole("link", { name: `${ko.onboarding.step2Cta} →` })).toHaveAttribute(
      "href",
      "/scenarios/S1/runs",
    );
    // ③은 아직 run이 없으므로 회색 안내
    expect(within(card).getByText(ko.onboarding.step3Blocked)).toBeInTheDocument();
  });

  it("runCreated 플래그 → ② 완료, ③ 링크 활성", () => {
    window.localStorage.setItem(KEY, JSON.stringify({ runCreated: true }));
    renderGuide("S1");
    const card = screen.getByRole("region", { name: ko.onboarding.ariaLabel });
    expect(within(card).queryByRole("link", { name: `${ko.onboarding.step2Cta} →` })).toBeNull();
    expect(within(card).getByRole("link", { name: `${ko.onboarding.step3Cta} →` })).toHaveAttribute(
      "href",
      "/scenarios/S1/runs",
    );
  });

  it("3단계 모두 완료면 카드 자체를 렌더하지 않는다", () => {
    window.localStorage.setItem(KEY, JSON.stringify({ runCreated: true, reportViewed: true }));
    renderGuide("S1");
    expect(screen.queryByRole("region", { name: ko.onboarding.ariaLabel })).toBeNull();
  });

  it("✕ dismiss → 즉시 사라지고 localStorage에 영구 기록", async () => {
    const user = userEvent.setup();
    renderGuide(null);
    await user.click(screen.getByRole("button", { name: ko.onboarding.dismiss }));
    expect(screen.queryByRole("region", { name: ko.onboarding.ariaLabel })).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(KEY)!)).toMatchObject({ dismissed: true });
  });

  it("이미 dismissed면 처음부터 렌더하지 않는다", () => {
    window.localStorage.setItem(KEY, JSON.stringify({ dismissed: true }));
    renderGuide(null);
    expect(screen.queryByRole("region", { name: ko.onboarding.ariaLabel })).toBeNull();
  });
});
