import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { StairFields } from "../StairFields";
import { STAIR_DEFAULTS, stairErrors, type StairDraft } from "../stair";
import { ko } from "../../../i18n/ko";

function Harness({ initial }: { initial?: Partial<StairDraft> }) {
  const [v, setV] = useState<StairDraft>({ ...STAIR_DEFAULTS, ...initial });
  return <StairFields value={v} onChange={setV} errors={stairErrors(v)} />;
}

describe("StairFields", () => {
  it("도우미: 목표 400 · 최대 배수 2× → 목록 칸이 채워진다", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByLabelText("목표 (req/s)"), "400");
    await user.selectOptions(screen.getByLabelText("최대 배수"), "2×");
    await user.click(screen.getByRole("button", { name: "목록 만들기" }));
    expect(screen.getByLabelText("목표 목록 (req/s)")).toHaveValue(
      "100, 200, 300, 400, 500, 600, 700, 800",
    );
  });

  it("도우미: 목표가 비었거나 0이면 목록을 바꾸지 않는다", async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ targets: "10, 20" }} />);
    await user.click(screen.getByRole("button", { name: "목록 만들기" }));
    expect(screen.getByLabelText("목표 목록 (req/s)")).toHaveValue("10, 20");
  });

  it("도우미: 목표가 0이어도 목록을 바꾸지 않는다", async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ targets: "10, 20" }} />);
    await user.type(screen.getByLabelText("목표 (req/s)"), "0");
    await user.click(screen.getByRole("button", { name: "목록 만들기" }));
    expect(screen.getByLabelText("목표 목록 (req/s)")).toHaveValue("10, 20");
  });

  it("요약 줄: 8계단 · 총 8분 40초 · 계단마다 측정 45초", () => {
    render(<Harness initial={{ targets: "100, 200, 300, 400, 500, 600, 700, 800" }} />);
    expect(screen.getByTestId("stair-summary")).toHaveTextContent(
      /^8계단 · 총 8분 40초 · 계단마다 측정 45초$/,
    );
  });

  it("잘못된 목록이면 요약 대신 오류 문구가 보인다", () => {
    render(<Harness initial={{ targets: "300, 200" }} />);
    expect(screen.getByText(ko.loadModel.stairTargetsNotIncreasing)).toBeInTheDocument();
    expect(screen.queryByTestId("stair-summary")).not.toBeInTheDocument();
  });

  it("유효한 유지(60)에서 버림이 51 이상이면 버림 오류 문구가 보인다", () => {
    render(<Harness initial={{ targets: "100, 200", hold: "60", discard: "51" }} />);
    expect(screen.getByText(ko.loadModel.stairDiscardInvalid(50))).toBeInTheDocument();
  });

  it("유지·상승 오류 문구가 각 칸에 보인다", () => {
    render(<Harness initial={{ targets: "100, 200", hold: "5", ramp: "0", discard: "99" }} />);
    expect(screen.getByText(ko.loadModel.stairHoldInvalid)).toBeInTheDocument();
    expect(screen.getByText(ko.loadModel.stairRampInvalid)).toBeInTheDocument();
  });

  it("판정 기준은 기본 접힘, 펼치면 규칙 문구와 절대 p99 상한 입력", async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ targets: "100, 200" }} />);
    const toggle = screen.getByRole("button", { name: /판정 기준/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByLabelText("절대 p99 상한 (ms, 선택)")).not.toBeInTheDocument();
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(ko.loadModel.stairJudgeRules)).toBeInTheDocument();
    await user.type(screen.getByLabelText("절대 p99 상한 (ms, 선택)"), "500");
    expect(screen.getByLabelText("절대 p99 상한 (ms, 선택)")).toHaveValue(500);
  });

  it("상한 값이 있으면 접힌 채 '1개 설정됨'이 보인다", () => {
    render(<Harness initial={{ targets: "100, 200", p99Cap: "500" }} />);
    expect(screen.getByRole("button", { name: /판정 기준/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.getByText(/1개 설정됨/)).toBeInTheDocument();
  });

  it("빈 목록은 건드리기 전엔 붉은 오류를 보이지 않고, 칸을 떠나면 보인다", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.queryByText(ko.loadModel.stairTargetsEmpty)).not.toBeInTheDocument();
    expect(screen.getByLabelText("목표 목록 (req/s)")).toHaveAttribute("aria-invalid", "false");
    await user.click(screen.getByLabelText("목표 목록 (req/s)"));
    await user.tab();
    expect(screen.getByText(ko.loadModel.stairTargetsEmpty)).toBeInTheDocument();
  });

  it("상한 오류가 나면 펼쳐진 채 유지되고, 고쳐도 접히지 않는다", async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ targets: "100, 200" }} />);
    await user.click(screen.getByRole("button", { name: /판정 기준/ }));
    const input = screen.getByLabelText("절대 p99 상한 (ms, 선택)");
    await user.type(input, "0");
    expect(screen.getByText(ko.loadModel.stairP99CapInvalid)).toBeInTheDocument();
    // 오류 중에는 접히지 않고 aria도 일관
    await user.click(screen.getByRole("button", { name: /판정 기준/ }));
    expect(screen.getByRole("button", { name: /판정 기준/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await user.clear(input);
    await user.type(input, "500");
    expect(screen.queryByText(ko.loadModel.stairP99CapInvalid)).not.toBeInTheDocument();
    expect(screen.getByLabelText("절대 p99 상한 (ms, 선택)")).toHaveValue(500);
    expect(screen.getByRole("button", { name: /판정 기준/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("절대 p99 상한 오류 문구", async () => {
    render(<Harness initial={{ targets: "100, 200", p99Cap: "0" }} />);
    // 값이 있고 잘못되면 접힌 채라도 오류를 알 수 있게 자동 펼침
    expect(screen.getByText(ko.loadModel.stairP99CapInvalid)).toBeInTheDocument();
  });
  describe("자동 정지 상자", () => {
    const SAT = "포화가 확정되면 남은 계단을 실행하지 않음";
    const WARN = /한 번 튄 계단으로도 멈출 수 있고/;
    const FINAL = /자동 정지가 걸리면 설정한 계단을 다 돌지 않습니다/;

    it("기본값: 두 체크 켜짐 · 두 번 연속 실패 선택 · 첫 실패 경고 없음 · 상자는 접히지 않고 보인다", () => {
      render(<Harness initial={{ targets: "100, 200" }} />);
      expect(screen.getByRole("group", { name: "자동 정지" })).toBeInTheDocument();
      expect(screen.getByRole("checkbox", { name: SAT })).toBeChecked();
      expect(screen.getByRole("checkbox", { name: "즉시 정지" })).toBeChecked();
      expect(screen.getByRole("radio", { name: /연속 두 계단 실패 시/ })).toBeChecked();
      expect(screen.queryByText(WARN)).not.toBeInTheDocument();
      expect(screen.getByText(FINAL)).toBeInTheDocument();
      expect(screen.getByLabelText("오류율 %")).toHaveValue(5);
      expect(screen.getByLabelText("p99 ms")).toHaveValue(2000);
      expect(screen.getByLabelText("초 연속")).toHaveValue(3);
      expect(screen.getByLabelText("초당 완료 개수 이상")).toHaveValue(20);
    });

    it("첫 실패에서 바로 정지를 고르면 경고가 보인다", async () => {
      const user = userEvent.setup();
      render(<Harness initial={{ targets: "100, 200" }} />);
      await user.click(screen.getByRole("radio", { name: /첫 실패에서 바로 정지/ }));
      expect(screen.getByText(WARN)).toBeInTheDocument();
    });

    it("둘 다 끄면 마지막 경고 줄이 숨겨지고, 하위 칸은 비활성으로 남는다(값 유지)", async () => {
      const user = userEvent.setup();
      render(<Harness initial={{ targets: "100, 200" }} />);
      await user.click(screen.getByRole("checkbox", { name: SAT }));
      await user.click(screen.getByRole("checkbox", { name: "즉시 정지" }));
      expect(screen.queryByText(FINAL)).not.toBeInTheDocument();
      expect(screen.getByRole("radio", { name: /첫 실패에서 바로 정지/ })).toBeDisabled();
      expect(screen.getByLabelText("오류율 %")).toBeDisabled();
      expect(screen.getByLabelText("오류율 %")).toHaveValue(5);
      await user.click(screen.getByRole("checkbox", { name: "즉시 정지" }));
      expect(screen.getByLabelText("오류율 %")).toBeEnabled();
    });

    it("포화 체크를 꺼도 첫 실패 경고는 숨겨진다", async () => {
      const user = userEvent.setup();
      render(<Harness initial={{ targets: "100, 200", satMode: "first_fail" }} />);
      expect(screen.getByText(WARN)).toBeInTheDocument();
      await user.click(screen.getByRole("checkbox", { name: SAT }));
      expect(screen.queryByText(WARN)).not.toBeInTheDocument();
    });

    it("오류율 0이면 오류 문구 + aria-invalid, 꺼 두면 오류가 없다", async () => {
      const user = userEvent.setup();
      render(<Harness initial={{ targets: "100, 200", emErrorPct: "0" }} />);
      expect(screen.getByText(ko.loadModel.stairAutoStopErrorRateInvalid)).toBeInTheDocument();
      expect(screen.getByLabelText("오류율 %")).toHaveAttribute("aria-invalid", "true");
      expect(screen.getByLabelText("p99 ms")).toHaveAttribute("aria-invalid", "false");
      await user.click(screen.getByRole("checkbox", { name: "즉시 정지" }));
      expect(
        screen.queryByText(ko.loadModel.stairAutoStopErrorRateInvalid),
      ).not.toBeInTheDocument();
    });
  });
});
