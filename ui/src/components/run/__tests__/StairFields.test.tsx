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

  it("유지·상승·버림 오류 문구가 각 칸에 보인다", () => {
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

  it("절대 p99 상한 오류 문구", async () => {
    render(<Harness initial={{ targets: "100, 200", p99Cap: "0" }} />);
    // 값이 있고 잘못되면 접힌 채라도 오류를 알 수 있게 자동 펼침
    expect(screen.getByText(ko.loadModel.stairP99CapInvalid)).toBeInTheDocument();
  });
});
