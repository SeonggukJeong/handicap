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

function setup(overrides: Partial<React.ComponentProps<typeof LoadModelFields>> = {}) {
  const props: React.ComponentProps<typeof LoadModelFields> = {
    loadModel: "closed",
    setLoadModel: vi.fn(),
    rateMode: "fixed",
    setRateMode: vi.fn(),
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
    errs: noErrs,
    ...overrides,
  };
  render(<LoadModelFields {...props} />);
  return props;
}

describe("LoadModelFields", () => {
  it("부하 모델 + 프로파일 두 fieldset을 렌더", () => {
    setup();
    expect(screen.getByRole("group", { name: /부하 모델/i })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /프로파일/i })).toBeInTheDocument();
  });

  it("closed일 때 곡선 라디오는 disabled (곧 지원)", () => {
    setup({ loadModel: "closed" });
    expect(screen.getByRole("radio", { name: /곡선/ })).toBeDisabled();
  });

  it("open일 때 곡선 라디오는 enabled", () => {
    setup({ loadModel: "open" });
    expect(screen.getByRole("radio", { name: /곡선/ })).toBeEnabled();
  });

  it("closed 라디오 선택 시 setLoadModel('closed') + setRateMode('fixed')", async () => {
    const user = userEvent.setup();
    const props = setup({ loadModel: "open", rateMode: "curve" });
    await user.click(screen.getByRole("radio", { name: /closed-loop/i }));
    expect(props.setLoadModel).toHaveBeenCalledWith("closed");
    expect(props.setRateMode).toHaveBeenCalledWith("fixed");
  });

  it("closed 모드: VUs/Ramp-up 입력, target_rps·max_in_flight 입력 없음", () => {
    setup({ loadModel: "closed" });
    expect(screen.getByLabelText("VUs")).toBeInTheDocument();
    expect(screen.getByLabelText("Ramp-up (s)")).toBeInTheDocument();
    expect(screen.queryByLabelText("Target RPS")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Max in-flight")).not.toBeInTheDocument();
  });

  it("open+fixed 모드: Target RPS + Max in-flight 각 1개, VUs 없음", () => {
    setup({ loadModel: "open", rateMode: "fixed" });
    expect(screen.getByLabelText("Target RPS")).toBeInTheDocument();
    expect(screen.getAllByLabelText("Max in-flight")).toHaveLength(1);
    expect(screen.queryByLabelText("VUs")).not.toBeInTheDocument();
  });

  it("open+curve 모드: Max in-flight 1개 + stage 입력 + 부하 모양 select", () => {
    setup({ loadModel: "open", rateMode: "curve" });
    expect(screen.getAllByLabelText("Max in-flight")).toHaveLength(1);
    expect(screen.getByLabelText("stage target 0")).toBeInTheDocument();
    expect(screen.getByLabelText("부하 모양")).toBeInTheDocument();
  });

  it("http_timeout 입력은 여기 없음 (RunDialog 공유)", () => {
    setup({ loadModel: "closed" });
    expect(screen.queryByLabelText(/HTTP timeout/i)).not.toBeInTheDocument();
  });
});
