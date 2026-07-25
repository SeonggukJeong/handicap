import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TrustBoard } from "../TrustBoard";
import { ko } from "../../../i18n/ko";
import type { TrustReport } from "../../../scenario/trust";

const GOOD: TrustReport = {
  level: "good",
  checks: [
    { id: "response_validation", status: "pass", steps: [], count: 0 },
    { id: "undefined_vars", status: "pass", steps: [], count: 0 },
    { id: "broken_extract_chain", status: "na", steps: [], count: 0 },
  ],
  passed: 2,
  applicable: 2,
  failed: 0,
  noValidationAtAll: false,
};

const CAUTION: TrustReport = {
  level: "caution",
  checks: [
    { id: "response_validation", status: "fail", steps: [{ id: "S1", name: "로그인" }], count: 0 },
    { id: "undefined_vars", status: "pass", steps: [], count: 0 },
    { id: "broken_extract_chain", status: "fail", steps: [], count: 2 },
  ],
  passed: 1,
  applicable: 3,
  failed: 2,
  noValidationAtAll: false,
};

// B fail(2건) — B는 D14대로 "개수 + 링크"를 낸다(C와 동형).
const WEAK: TrustReport = {
  level: "weak",
  checks: [
    { id: "response_validation", status: "pass", steps: [], count: 0 },
    { id: "undefined_vars", status: "fail", steps: [], count: 2 },
    { id: "broken_extract_chain", status: "na", steps: [], count: 0 },
  ],
  passed: 1,
  applicable: 2,
  failed: 1,
  noValidationAtAll: false,
};

const noop = () => {};
function board(props: Partial<Parameters<typeof TrustBoard>[0]> = {}) {
  return render(
    <TrustBoard
      open
      report={GOOD}
      testRun="verified"
      onClose={noop}
      onSelectStep={noop}
      onOpenVars={noop}
      {...props}
    />,
  );
}

describe("TrustBoard", () => {
  it("good일 때만 성능 오독 방어 문구가 뜬다", () => {
    const { unmount } = board();
    expect(screen.getByText(ko.trust.boardGoodNote)).toBeInTheDocument();
    unmount();
    board({ report: CAUTION });
    expect(screen.queryByText(ko.trust.boardGoodNote)).not.toBeInTheDocument();
  });

  it("상시 부제는 등급과 무관하게 뜬다", () => {
    board({ report: CAUTION });
    expect(screen.getByText(ko.trust.boardSubtitle)).toBeInTheDocument();
  });

  it("A 실패는 스텝 **이름** 칩을 내고 클릭하면 그 스텝을 선택하며 닫힌다", async () => {
    const onSelectStep = vi.fn();
    const onClose = vi.fn();
    board({ report: CAUTION, onSelectStep, onClose });
    await userEvent.click(screen.getByRole("button", { name: "로그인" }));
    expect(onSelectStep).toHaveBeenCalledWith("S1");
    expect(onClose).toHaveBeenCalled();
  });

  it("C 실패는 스텝 칩 대신 변수 패널 링크를 낸다", () => {
    board({ report: CAUTION });
    // `getByText(ko…(2))`만으론 **공허**하다 — 카피가 보간을 멈추면 기대값도 같이 변해 통과한다.
    // 렌더된 문구에 숫자가 실제로 있는지 따로 본다(카피 회귀 + 배선 회귀 둘 다 잡힌다).
    expect(screen.getByText(ko.trust.checkCFailTitle(2)).textContent).toContain("2");
    expect(screen.getByRole("button", { name: ko.trust.varsPanelLink })).toBeInTheDocument();
  });

  it("B 실패도 개수를 말하고 변수 패널 링크를 낸다 (D14 — B·C 동형)", () => {
    board({ report: WEAK });
    // count(2)가 카피의 보간을 거쳐 실제로 제목에 흘러야 한다(위 C와 같은 이빨 규칙).
    expect(screen.getByText(ko.trust.checkBFailTitle(2)).textContent).toContain("2");
    expect(screen.getByRole("button", { name: ko.trust.varsPanelLink })).toBeInTheDocument();
  });

  it("통과 개수의 분모는 applicable(na 제외)이다", () => {
    board();
    // GOOD은 checks 3개 중 na 1개 → 정직한 문장은 "2개 중 2개". checks.length(3)를 쓰면 거짓말.
    expect(
      screen.getByText(`${ko.trust.level.good} · ${ko.trust.boardCount(2, 2)}`),
    ).toBeInTheDocument();
  });

  it("통과 항목은 기본 접힘이고 na를 통과로 세지 않는다", () => {
    board();
    // GOOD은 pass 2 + na 1. 접힘 라벨은 **passed(2)** 여야 한다 (D7).
    expect(screen.getByText(ko.trust.boardPassedFold(2))).toBeInTheDocument();
    expect(screen.queryByText(ko.trust.checkAPass)).not.toBeInTheDocument();
  });

  it("펼치면 통과 항목과 na 항목이 구분돼 보인다", async () => {
    board();
    await userEvent.click(screen.getByText(ko.trust.boardPassedFold(2)));
    expect(screen.getByText(ko.trust.checkAPass)).toBeInTheDocument();
    expect(screen.getByText(ko.trust.naLabel)).toBeInTheDocument();
  });

  it("D 줄은 접힘 없이 상시 렌더되고 세 상태를 구분한다", () => {
    const { unmount } = board({ testRun: "never" });
    expect(screen.getByText(ko.trust.testRunNever)).toBeInTheDocument();
    unmount();
    const second = board({ testRun: "stale" });
    expect(screen.getByText(ko.trust.testRunStale)).toBeInTheDocument();
    second.unmount();
    // 제목이 약속한 **세** 번째 상태 — 이게 없으면 verified 문구를 어떤 테스트도 안 본다.
    board({ testRun: "verified" });
    expect(screen.getByText(ko.trust.testRunVerified)).toBeInTheDocument();
  });

  it("report=null(보류)이면 등급·점검·D를 렌더하지 않는다", () => {
    board({ report: null });
    expect(screen.getByText(ko.trust.boardGateBlocked)).toBeInTheDocument();
    expect(screen.queryByText(ko.trust.boardSubtitle)).not.toBeInTheDocument();
    // 이 픽스처의 testRun은 "verified"다 — D가 보류 분기로 새면(또는 early return 위로 올라가면)
    // 이 두 문구가 실제로 뜬다. testRunNever를 단언하면 픽스처가 대신 통과시켜 공허해진다.
    expect(screen.queryByText(ko.trust.testRunVerified)).not.toBeInTheDocument();
    expect(screen.queryByText(ko.trust.testRunScope)).not.toBeInTheDocument();
  });
});
