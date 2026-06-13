import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LoadModelFields } from "../LoadModelFields";
import type { LoadModelErrors } from "../loadModel";

const noErrs: LoadModelErrors = {
  rampInvalid: false,
  targetRpsInvalid: false,
  maxInFlightInvalid: false,
  stagesInvalid: false,
};

// These spies are needed for the new tests and must be stable references
const setRateMode = vi.fn();
const setRampDown = vi.fn();

function setup(overrides: Partial<React.ComponentProps<typeof LoadModelFields>> = {}) {
  const props: React.ComponentProps<typeof LoadModelFields> = {
    loadModel: "closed",
    setLoadModel: vi.fn(),
    rateMode: "fixed",
    setRateMode,
    vus: 5,
    setVus: vi.fn(),
    duration: 30,
    setDuration: vi.fn(),
    rampUp: 0,
    setRampUp: vi.fn(),
    targetRps: "100",
    setTargetRps: vi.fn(),
    maxInFlight: "200",
    setMaxInFlight: vi.fn(),
    stages: [{ target: "100", duration_seconds: "30" }],
    setStages: vi.fn(),
    rampDown: "graceful",
    setRampDown,
    errs: noErrs,
    ...overrides,
  };
  render(<LoadModelFields {...props} />);
  return props;
}

// alias for clarity in new tests
const renderFields = setup;

describe("LoadModelFields", () => {
  it("부하 모델 + 프로파일 두 fieldset을 렌더", () => {
    setup();
    expect(screen.getByRole("group", { name: /부하 모델/i })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /프로파일/i })).toBeInTheDocument();
  });

  it("closed에서 곡선 라디오가 활성화돼 선택 가능 (곧 지원 제거)", async () => {
    const user = userEvent.setup();
    setRateMode.mockClear();
    renderFields({ loadModel: "closed", rateMode: "fixed" });
    const curve = screen.getByRole("radio", { name: "곡선" });
    expect(curve).toBeEnabled();
    await user.click(curve);
    expect(setRateMode).toHaveBeenCalledWith("curve");
  });

  it("open일 때 곡선 라디오는 enabled", () => {
    setup({ loadModel: "open" });
    expect(screen.getByRole("radio", { name: /곡선/ })).toBeEnabled();
  });

  it("closed 라디오 클릭이 rateMode를 리셋하지 않는다 (eager reset 제거)", async () => {
    const user = userEvent.setup();
    setRateMode.mockClear();
    renderFields({ loadModel: "open", rateMode: "curve" });
    await user.click(screen.getByRole("radio", { name: /사용자 수 기준/ }));
    expect(setRateMode).not.toHaveBeenCalled();
  });

  it("closed 모드: 동시 사용자/점진 시작 입력, 목표 RPS·동시 요청 상한 입력 없음", () => {
    setup({ loadModel: "closed" });
    expect(screen.getByLabelText(/동시 사용자/)).toBeInTheDocument();
    expect(screen.getByLabelText(/점진 시작/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/목표 RPS/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/동시 요청 상한/)).not.toBeInTheDocument();
  });

  it("open+fixed 모드: 목표 RPS + 동시 요청 상한 각 1개, 동시 사용자 없음", () => {
    setup({ loadModel: "open", rateMode: "fixed" });
    expect(screen.getByLabelText(/목표 RPS/i)).toBeInTheDocument();
    expect(screen.getAllByLabelText(/동시 요청 상한/)).toHaveLength(1);
    expect(screen.queryByLabelText(/동시 사용자/)).not.toBeInTheDocument();
  });

  it("open+curve 모드: 동시 요청 상한 1개 + stage 입력 + 부하 모양 select", () => {
    setup({ loadModel: "open", rateMode: "curve" });
    expect(screen.getAllByLabelText(/동시 요청 상한/)).toHaveLength(1);
    expect(screen.getByLabelText("stage target 0")).toBeInTheDocument();
    expect(screen.getByLabelText("부하 모양")).toBeInTheDocument();
  });

  it("HTTP 타임아웃 입력은 여기 없음 (RunDialog 공유)", () => {
    setup({ loadModel: "closed" });
    expect(screen.queryByLabelText(/HTTP 타임아웃/i)).not.toBeInTheDocument();
  });

  it("closed 모드에서 부하 크기 프리셋 chips가 보이고 클릭하면 VU·시간을 채운다", async () => {
    const user = userEvent.setup();
    const props = setup();
    expect(screen.getByRole("group", { name: /부하 크기 프리셋/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /보통/ }));
    expect(props.setVus).toHaveBeenCalledWith(50);
    expect(props.setDuration).toHaveBeenCalledWith(60);
  });

  it("open 모드에선 크기 chips가 없다", () => {
    setup({ loadModel: "open" });
    expect(screen.queryByRole("group", { name: /부하 크기 프리셋/ })).toBeNull();
  });

  it("현재 VU·시간이 프리셋과 일치하면 해당 chip이 눌린 상태(aria-pressed)다", () => {
    setup({ vus: 10, duration: 30 });
    expect(screen.getByRole("button", { name: /가볍게/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /보통/ })).toHaveAttribute("aria-pressed", "false");
  });

  it("VU만 일치하고 시간이 다르면 chip이 눌리지 않는다", () => {
    setup({ vus: 10, duration: 60 });
    expect(screen.getByRole("button", { name: /가볍게/ })).toHaveAttribute("aria-pressed", "false");
  });

  it("closed+curve: 목표 VU 라벨 + ramp_down 라디오 + vus/chips/ramp_up/duration/max_in_flight 비노출", () => {
    renderFields({ loadModel: "closed", rateMode: "curve" });
    expect(screen.getAllByText("목표 VU").length).toBeGreaterThan(0);
    expect(screen.getByRole("radio", { name: /요청을 마친 뒤 줄이기/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /즉시 줄이기/ })).not.toBeChecked();
    // ramp_down 그룹은 radiogroup으로 접근명 제공 (HelpTip은 그룹 라벨 밖 — accname 비오염)
    expect(screen.getByRole("radiogroup", { name: "줄이는 방식" })).toBeInTheDocument();
    // 비노출 확인
    expect(screen.queryByLabelText(/동시 사용자/)).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: /부하 크기 프리셋/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/점진 시작/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/테스트 시간/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/동시 요청 상한/)).not.toBeInTheDocument();
  });

  it("open+curve: 기존 목표 RPS 라벨 유지 + ramp_down 비노출 (회귀 가드)", () => {
    renderFields({ loadModel: "open", rateMode: "curve" });
    expect(screen.getAllByText("목표 RPS").length).toBeGreaterThan(0);
    expect(screen.queryByRole("radio", { name: /즉시 줄이기/ })).not.toBeInTheDocument();
  });
});
