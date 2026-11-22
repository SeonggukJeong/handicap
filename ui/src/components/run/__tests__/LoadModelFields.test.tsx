import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LoadModelFields } from "../LoadModelFields";
import type { LoadModelErrors } from "../loadModel";
import type { Scenario, Step } from "../../../scenario/model";
import { ko } from "../../../i18n/ko";
import { STAIR_DEFAULTS } from "../stair";

vi.mock("../VuSizingHelper", () => ({
  VuSizingHelper: () => <div data-testid="sizing-helper" />,
}));

vi.mock("../SlotSizingHelper", () => ({
  SlotSizingHelper: ({ targetRps, peakBased }: { targetRps: string; peakBased?: boolean }) => (
    <div data-testid="slot-sizing-helper" data-target={targetRps} data-peak={String(!!peakBased)} />
  ),
}));

vi.mock("../WorkerSizingHelper", () => ({
  WorkerSizingHelper: ({ targetRps, peakBased }: { targetRps: string; peakBased?: boolean }) => (
    <div
      data-testid="worker-sizing-helper"
      data-target={targetRps}
      data-peak={String(!!peakBased)}
    />
  ),
}));

const noErrs: LoadModelErrors = {
  rampInvalid: false,
  targetRpsInvalid: false,
  maxInFlightInvalid: false,
  stagesInvalid: false,
  workerCountInvalid: false,
  gracefulCapInvalid: false,
  stairInvalid: false,
  steadyInvalid: false,
};

// These spies are needed for the new tests and must be stable references
const setRateMode = vi.fn();
const setRampDown = vi.fn();
const setGracefulCap = vi.fn();

function baseProps(
  overrides: Partial<React.ComponentProps<typeof LoadModelFields>> = {},
): React.ComponentProps<typeof LoadModelFields> {
  return {
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
    rampOpen: 0,
    setRampOpen: vi.fn(),
    discard: 0,
    setDiscard: vi.fn(),
    targetRps: "100",
    setTargetRps: vi.fn(),
    maxInFlight: "200",
    setMaxInFlight: vi.fn(),
    stages: [{ target: "100", duration_seconds: "30" }],
    setStages: vi.fn(),
    rampDown: "graceful",
    setRampDown,
    gracefulCap: "",
    setGracefulCap,
    errs: noErrs,
    ...overrides,
  };
}

function setup(overrides: Partial<React.ComponentProps<typeof LoadModelFields>> = {}) {
  const props = baseProps(overrides);
  render(<LoadModelFields {...props} />);
  return props;
}

// alias for clarity in new tests
const renderFields = setup;

// ── open-loop 무시 토글(Task 5②) 전용 prop factory — openFixedProps/openCurveProps/closedProps
// 는 baseProps 위에 모드만 오버라이드한다(렌더는 호출부가 raw render/rerender로 직접 제어).
const openFixedProps = () => baseProps({ loadModel: "open", rateMode: "fixed" });
const openCurveProps = () =>
  baseProps({
    loadModel: "open",
    rateMode: "curve",
    stages: [{ target: "50", duration_seconds: "30" }],
  });
const closedProps = () => baseProps({ loadModel: "closed", rateMode: "fixed" });

describe("LoadModelFields", () => {
  it("maxInFlightHint는 라벨 문구로 시작하지 않는다 (SR 라벨 중복 낭독 가드, a11y-bundle A2)", () => {
    expect(ko.loadModel.maxInFlightHint.startsWith(ko.loadModel.maxInFlight)).toBe(false);
  });

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

  it("closed 모드: 동시 사용자/점진 시작 입력, 목표 도착률·동시 요청 상한 입력 없음", () => {
    setup({ loadModel: "closed" });
    expect(screen.getByLabelText(/동시 사용자/)).toBeInTheDocument();
    expect(screen.getByLabelText("상승 시간(초)")).toBeInTheDocument();
    expect(screen.queryByLabelText(/도착률\(iter\/s\)/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/동시 요청 상한/)).not.toBeInTheDocument();
  });

  it("open+fixed 모드: 목표 도착률 + 동시 요청 상한 각 1개, 동시 사용자 없음", () => {
    setup({ loadModel: "open", rateMode: "fixed" });
    expect(screen.getByLabelText(/도착률\(iter\/s\)/i)).toBeInTheDocument();
    expect(screen.getAllByLabelText(/동시 요청 상한/)).toHaveLength(1);
    expect(screen.queryByLabelText(/동시 사용자/)).not.toBeInTheDocument();
  });

  it("open+curve 모드: 동시 요청 상한 1개 + stage 입력 + 부하 모양 select", () => {
    setup({ loadModel: "open", rateMode: "curve" });
    expect(screen.getAllByLabelText(/동시 요청 상한/)).toHaveLength(1);
    expect(screen.getByLabelText("스테이지 0 목표")).toBeInTheDocument();
    expect(screen.getByLabelText("부하 모양")).toBeInTheDocument();
  });

  it("HTTP 타임아웃 입력은 여기 없음 (RunDialog 공유)", () => {
    setup({ loadModel: "closed" });
    expect(screen.queryByLabelText(/HTTP 타임아웃/i)).not.toBeInTheDocument();
  });

  it("closed 모드에서 빠른 입력 chips가 보이고 클릭하면 VU·시간을 채운다", async () => {
    const user = userEvent.setup();
    const props = setup();
    expect(screen.getByRole("group", { name: ko.loadModel.sizePresetsLabel })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: ko.loadModel.sizePresets[1].label }));
    expect(props.setVus).toHaveBeenCalledWith(50);
    expect(props.setDuration).toHaveBeenCalledWith(60);
  });

  it("open 모드에선 빠른 입력 chips가 없다", () => {
    setup({ loadModel: "open" });
    expect(screen.queryByRole("group", { name: ko.loadModel.sizePresetsLabel })).toBeNull();
  });

  it("현재 VU·시간이 프리셋과 일치하면 해당 chip이 눌린 상태(aria-pressed)다", () => {
    setup({ vus: 10, duration: 30 });
    expect(screen.getByRole("button", { name: ko.loadModel.sizePresets[0].label })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: ko.loadModel.sizePresets[1].label })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("VU만 일치하고 시간이 다르면 chip이 눌리지 않는다", () => {
    setup({ vus: 10, duration: 60 });
    expect(screen.getByRole("button", { name: ko.loadModel.sizePresets[0].label })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("빠른 입력 캡션과 중립 라벨 (가볍게/보통/세게 부재)", () => {
    setup();
    expect(screen.getByText(ko.loadModel.sizePresetsCaption)).toBeInTheDocument();
    expect(screen.queryByText("가볍게")).not.toBeInTheDocument();
    expect(screen.queryByText("보통")).not.toBeInTheDocument();
    expect(screen.queryByText("세게")).not.toBeInTheDocument();
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
    expect(screen.queryByRole("group", { name: /빠른 입력/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("상승 시간(초)")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("실행 시간(초)")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/동시 요청 상한/)).not.toBeInTheDocument();
  });

  it("closed+curve+graceful: 느슨한 감축 상한 입력 렌더", () => {
    renderFields({ loadModel: "closed", rateMode: "curve", rampDown: "graceful" });
    expect(screen.getByLabelText(ko.loadModel.gracefulCapLabel)).toBeInTheDocument();
  });

  it("closed+curve+immediate: 느슨한 감축 상한 입력 미렌더", () => {
    renderFields({ loadModel: "closed", rateMode: "curve", rampDown: "immediate" });
    expect(screen.queryByLabelText(ko.loadModel.gracefulCapLabel)).not.toBeInTheDocument();
  });

  it("open+curve: 기존 목표 도착률 라벨 유지 + ramp_down 비노출 (회귀 가드)", () => {
    renderFields({ loadModel: "open", rateMode: "curve" });
    expect(screen.getAllByText("목표 도착률").length).toBeGreaterThan(0);
    expect(screen.queryByRole("radio", { name: /즉시 줄이기/ })).not.toBeInTheDocument();
  });

  it("closed+fixed + onApplyVus 주어지면 사이징 헬퍼 렌더", () => {
    renderFields({
      sizingScenarioId: "s1",
      sizingScenario: null,
      sizingEnv: {},
      onApplyVus: vi.fn(),
    });
    expect(screen.getByTestId("sizing-helper")).toBeInTheDocument();
  });

  it("onApplyVus 없으면(스케줄 편집기 경로) 헬퍼 미렌더", () => {
    renderFields(); // 기본 closed+fixed, sizing prop 없음 → ScheduleForm 경로와 동일
    expect(screen.queryByTestId("sizing-helper")).toBeNull();
  });

  it("onApplyVus 있어도 sizingScenarioId 없으면 헬퍼 미렌더 (가드 && 반쪽)", () => {
    renderFields({ onApplyVus: vi.fn() }); // sizingScenarioId 미전달 → 가드 미충족
    expect(screen.queryByTestId("sizing-helper")).toBeNull();
  });

  // 모드 분기 불변식: 헬퍼는 closed+fixed 전용 — sizing prop이 다 있어도 다른 3모드에선 미렌더.
  it.each([
    { loadModel: "open", rateMode: "fixed" },
    { loadModel: "open", rateMode: "curve" },
    { loadModel: "closed", rateMode: "curve" },
  ] as const)("$loadModel+$rateMode 모드에선 sizing prop이 있어도 헬퍼 미렌더", (mode) => {
    renderFields({
      ...mode,
      sizingScenarioId: "s1",
      sizingScenario: null,
      sizingEnv: {},
      onApplyVus: vi.fn(),
    });
    expect(screen.queryByTestId("sizing-helper")).toBeNull();
  });

  it("open+fixed + onApplyMaxInFlight 주어지면 슬롯 헬퍼 렌더", () => {
    renderFields({
      loadModel: "open",
      rateMode: "fixed",
      sizingScenarioId: "s1",
      sizingEnv: {},
      onApplyMaxInFlight: vi.fn(),
    });
    expect(screen.getByTestId("slot-sizing-helper")).toBeInTheDocument();
  });

  it("onApplyMaxInFlight 없으면(스케줄 편집기 경로) 슬롯 헬퍼 미렌더", () => {
    renderFields({ loadModel: "open", rateMode: "fixed" });
    expect(screen.queryByTestId("slot-sizing-helper")).toBeNull();
  });

  it("onApplyMaxInFlight 있어도 sizingScenarioId 없으면 슬롯 헬퍼 미렌더 (가드 && 반쪽)", () => {
    renderFields({ loadModel: "open", rateMode: "fixed", onApplyMaxInFlight: vi.fn() });
    expect(screen.queryByTestId("slot-sizing-helper")).toBeNull();
  });

  it("open+curve + onApplyMaxInFlight 주어지면 슬롯 헬퍼 렌더", () => {
    renderFields({
      loadModel: "open",
      rateMode: "curve",
      sizingScenarioId: "s1",
      sizingEnv: {},
      onApplyMaxInFlight: vi.fn(),
    });
    expect(screen.getByTestId("slot-sizing-helper")).toBeInTheDocument();
  });

  // 슬롯 헬퍼는 open(fixed/curve) 전용 — prop이 다 있어도 closed 모드(VU 기반)에선 미렌더.
  it.each([
    { loadModel: "closed", rateMode: "fixed" },
    { loadModel: "closed", rateMode: "curve" },
  ] as const)("$loadModel+$rateMode 모드에선 슬롯 헬퍼 미렌더 (prop 있어도)", (mode) => {
    renderFields({
      ...mode,
      sizingScenarioId: "s1",
      sizingEnv: {},
      onApplyMaxInFlight: vi.fn(),
    });
    expect(screen.queryByTestId("slot-sizing-helper")).toBeNull();
  });

  // ── worker_count 사이징 헬퍼 (RunDialog 전용, open 모드에서만) ──────────────────
  it.each([
    { loadModel: "open", rateMode: "fixed" },
    { loadModel: "open", rateMode: "curve" },
  ] as const)(
    "$loadModel+$rateMode + onApplyWorkerCount → 워커 헬퍼 렌더",
    ({ loadModel, rateMode }) => {
      renderFields({
        loadModel,
        rateMode,
        sizingScenarioId: "s1",
        onApplyWorkerCount: vi.fn(),
        setWorkerCount: vi.fn(),
        workerCount: "2", // disclosure 자동 펼침
      });
      expect(screen.getByTestId("worker-sizing-helper")).toBeInTheDocument();
    },
  );

  it("onApplyWorkerCount 없으면(스케줄 편집기 경로) 워커 헬퍼 미렌더", () => {
    renderFields({
      loadModel: "open",
      rateMode: "fixed",
      sizingScenarioId: "s1",
      setWorkerCount: vi.fn(),
      workerCount: "2",
    });
    expect(screen.queryByTestId("worker-sizing-helper")).toBeNull();
  });

  it("onApplyWorkerCount 있어도 sizingScenarioId 없으면 워커 헬퍼 미렌더 (가드 && 반쪽)", () => {
    renderFields({
      loadModel: "open",
      rateMode: "fixed",
      onApplyWorkerCount: vi.fn(),
      setWorkerCount: vi.fn(),
      workerCount: "2",
    });
    expect(screen.queryByTestId("worker-sizing-helper")).toBeNull();
  });

  it.each([
    { loadModel: "closed", rateMode: "fixed" },
    { loadModel: "closed", rateMode: "curve" },
  ] as const)(
    "$loadModel+$rateMode 에선 워커 헬퍼 미렌더(disclosure가 open 전용)",
    ({ loadModel, rateMode }) => {
      renderFields({
        loadModel,
        rateMode,
        sizingScenarioId: "s1",
        onApplyWorkerCount: vi.fn(),
        setWorkerCount: vi.fn(),
        workerCount: "2",
      });
      expect(screen.queryByTestId("worker-sizing-helper")).toBeNull();
    },
  );

  // ── worker_count 접이식 입력 (RunDialog 전용, open 모드 고정·곡선) ───────────────
  // 토글은 open 모드에서 setWorkerCount가 주어질 때만 렌더. 기본 접힘 → 펼친 뒤에야 입력 등장.
  it.each([
    { loadModel: "open", rateMode: "fixed" },
    { loadModel: "open", rateMode: "curve" },
  ] as const)(
    "$loadModel+$rateMode + setWorkerCount 주어지면 토글 렌더 + 펼치면 입력 등장",
    async (mode) => {
      const user = userEvent.setup();
      renderFields({ ...mode, workerCount: "1", setWorkerCount: vi.fn() });
      const toggle = screen.getByRole("button", { name: /부하 생성기 워커 수/ });
      expect(toggle).toBeInTheDocument();
      // 접힌 채라 입력은 아직 DOM에 없다
      expect(screen.queryByLabelText("부하 생성기 워커 수 (수평 확장)")).toBeNull();
      await user.click(toggle);
      expect(screen.getByLabelText("부하 생성기 워커 수 (수평 확장)")).toBeInTheDocument();
    },
  );

  it("open+fixed: 시드된 workerCount>1이면 자동 펼침 + 입력 노출", () => {
    renderFields({
      loadModel: "open",
      rateMode: "fixed",
      workerCount: "3",
      setWorkerCount: vi.fn(),
    });
    expect(screen.getByLabelText("부하 생성기 워커 수 (수평 확장)")).toHaveValue(3);
  });

  it("open+fixed: setWorkerCount 없으면(ScheduleForm 경로) 토글 미렌더", () => {
    renderFields({ loadModel: "open", rateMode: "fixed" });
    expect(screen.queryByRole("button", { name: /부하 생성기 워커 수/ })).toBeNull();
  });

  // closed 모드(고정·곡선)에선 prop이 다 있어도 worker_count 토글/입력 미렌더.
  it.each([
    { loadModel: "closed", rateMode: "fixed" },
    { loadModel: "closed", rateMode: "curve" },
  ] as const)(
    "$loadModel+$rateMode 모드에선 worker_count 토글 미렌더 (setWorkerCount 있어도)",
    (mode) => {
      renderFields({ ...mode, workerCount: "2", setWorkerCount: vi.fn() });
      expect(screen.queryByRole("button", { name: /부하 생성기 워커 수/ })).toBeNull();
      expect(screen.queryByLabelText("부하 생성기 워커 수 (수평 확장)")).toBeNull();
    },
  );

  // ── B4: duration HelpTip (신규) ───────────────────────────────────────────────
  it("closed+fixed: duration HelpTip 존재 (실행 시간 설명 버튼)", () => {
    renderFields({ loadModel: "closed", rateMode: "fixed" });
    expect(screen.getByRole("button", { name: "실행 시간 설명" })).toBeInTheDocument();
  });

  it("open+fixed: duration HelpTip 존재 (실행 시간 설명 버튼)", () => {
    renderFields({ loadModel: "open", rateMode: "fixed" });
    expect(screen.getByRole("button", { name: "실행 시간 설명" })).toBeInTheDocument();
  });

  // ── B4: '추천' Badge는 더 이상 렌더하지 않는다 (prop 제거됨) ──────────────────────
  it("'추천' Badge 미렌더 (closed+fixed)", () => {
    renderFields();
    expect(screen.queryByText("추천")).not.toBeInTheDocument();
  });
  it("'추천' Badge 미렌더 (open+fixed)", () => {
    renderFields({ loadModel: "open", rateMode: "fixed" });
    expect(screen.queryByText("추천")).not.toBeInTheDocument();
  });

  // ── Task 5: simpleMode / loadModelTiles / numeric 게이트 ─────────────────────
  it("simpleMode closed hides profile/curve/rampdown, keeps VU helper + numbers", () => {
    setup({
      simpleMode: true,
      loadModel: "closed",
      rateMode: "fixed",
      onApplyVus: vi.fn(),
      sizingScenarioId: "s1",
    });
    expect(screen.queryByRole("group", { name: /프로파일/i })).not.toBeInTheDocument();
    expect(screen.getByTestId("sizing-helper")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /사용자 수 기준/ })).toBeInTheDocument(); // 타일/라디오 name 보존
  });

  it("simpleMode open hides worker disclosure, keeps slot helper", () => {
    setup({
      simpleMode: true,
      loadModel: "open",
      rateMode: "fixed",
      onApplyMaxInFlight: vi.fn(),
      sizingScenarioId: "s1",
      setWorkerCount: vi.fn(),
    });
    expect(screen.queryByRole("button", { name: /워커 수/ })).not.toBeInTheDocument();
    expect(screen.getByTestId("slot-sizing-helper")).toBeInTheDocument();
  });

  it("simpleMode + curve renders nothing for the curve area (RunDialog owns the R17 card)", () => {
    setup({ simpleMode: true, loadModel: "closed", rateMode: "curve" });
    expect(screen.queryByLabelText(ko.loadModelFields.stageTargetAria(0))).not.toBeInTheDocument();
  });

  it("loadModelTiles renders load-model as role=radio tiles inside the fieldset, name preserved", () => {
    setup({ loadModelTiles: true, loadModel: "closed" });
    const group = screen.getByRole("group", { name: /부하 모델/i });
    expect(group.tagName).toBe("FIELDSET");
    expect(screen.getByRole("radio", { name: /동시 사용자 \(VU\)/ })).toBeInTheDocument();
    expect(screen.getByText(ko.loadModel.tileClosedDesc)).toBeInTheDocument();
    // ②: HelpTip이 제목 옆·테두리 안 (closed/open 각각)
    expect(screen.getByRole("button", { name: "closed-loop 설명" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "open-loop 설명" })).toBeInTheDocument();
  });

  it("선택 타일에 accent 클래스, 비선택엔 부재 (R1) + teeth", () => {
    setup({ loadModelTiles: true, loadModel: "closed" });
    const closed = screen.getByRole("radio", { name: /동시 사용자 \(VU\)/ }).closest("div")!;
    const open = screen.getByRole("radio", { name: /도착률/ }).closest("div")!;
    expect(closed).toHaveClass("border-accent-500"); // 선택
    expect(open).not.toHaveClass("border-accent-500"); // 비선택 (teeth: 선택을 open으로 뒤집으면 FAIL)
  });

  it("타일 라디오 accessible name은 제목만 (HelpTip 비오염, U3)", () => {
    setup({ loadModelTiles: true, loadModel: "closed" });
    // 정확매치: 설명/HelpTip 라벨이 섞이면 실패
    expect(screen.getByRole("radio", { name: "동시 사용자 (VU)" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "도착률 (iter/s)" })).toBeInTheDocument();
  });

  it("without new props, renders legacy radios + profile + worker (ScheduleForm parity)", () => {
    setup({ loadModel: "open", rateMode: "fixed", setWorkerCount: vi.fn() });
    expect(screen.getByRole("radio", { name: /도착률 기준/ })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /프로파일/i })).toBeInTheDocument();
  });

  it("loadModelTiles=true: 프로파일이 Segmented(radio 고정/곡선) (R4)", () => {
    setup({ loadModelTiles: true, simpleMode: false, loadModel: "closed" }); // setup가 내부 render — 래핑 금지
    // Segmented는 role="radiogroup" aria-label="프로파일" 컨테이너를 렌더한다
    expect(screen.getByRole("radiogroup", { name: "프로파일" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "고정" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "곡선" })).toBeInTheDocument(); // 정확매치 — ramp_down 라벨의 "곡선" 단어와 구분
  });

  it("loadModelTiles 미전달(라디오 모드): 프로파일 라디오 유지 (R12)", () => {
    setup({ simpleMode: false, loadModel: "closed" }); // loadModelTiles 없음
    // ScheduleForm 호환 라디오 모드: Segmented radiogroup이 없어야 한다
    expect(screen.queryByRole("radiogroup", { name: "프로파일" })).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "고정" })).toBeInTheDocument(); // input[type=radio] 유지
  });

  // ── Task 5②: open-loop 시나리오 think time 무시 토글 (§B21) ──────────────────
  it("open-loop + think 있으면 무시 토글 노출(기본 무시) — open+curve도 노출, no-think/closed는 미노출", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <LoadModelFields
        {...openFixedProps()}
        scenarioHasThink
        onApplyScenarioThinkChange={onChange}
        applyScenarioThink={false}
      />,
    );
    const toggle = screen.getByRole("checkbox", { name: ko.loadModel.applyScenarioThinkLabel });
    expect(toggle).not.toBeChecked(); // default ignore
    expect(screen.getByText(ko.loadModel.applyScenarioThinkIgnoreNote)).toBeInTheDocument();

    // toggling calls the handler with true
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith(true);

    // still shown for open+curve (spec §6.1 — 토글은 open 양 arm 공통)
    rerender(
      <LoadModelFields
        {...openCurveProps()}
        scenarioHasThink
        onApplyScenarioThinkChange={onChange}
        applyScenarioThink={false}
      />,
    );
    expect(
      screen.getByRole("checkbox", { name: ko.loadModel.applyScenarioThinkLabel }),
    ).toBeInTheDocument();

    // hidden when scenario has no think
    rerender(
      <LoadModelFields
        {...openFixedProps()}
        scenarioHasThink={false}
        onApplyScenarioThinkChange={onChange}
      />,
    );
    expect(
      screen.queryByRole("checkbox", { name: ko.loadModel.applyScenarioThinkLabel }),
    ).not.toBeInTheDocument();

    // hidden for closed-loop
    rerender(
      <LoadModelFields {...closedProps()} scenarioHasThink onApplyScenarioThinkChange={onChange} />,
    );
    expect(
      screen.queryByRole("checkbox", { name: ko.loadModel.applyScenarioThinkLabel }),
    ).not.toBeInTheDocument();
  });

  it("applyScenarioThink=true면 적용 안내 문구로 전환된다", () => {
    render(
      <LoadModelFields
        {...openFixedProps()}
        scenarioHasThink
        onApplyScenarioThinkChange={vi.fn()}
        applyScenarioThink
      />,
    );
    expect(
      screen.getByRole("checkbox", { name: ko.loadModel.applyScenarioThinkLabel }),
    ).toBeChecked();
    expect(screen.getByText(ko.loadModel.applyScenarioThinkApplyNote)).toBeInTheDocument();
  });

  it("onApplyScenarioThinkChange 미전달(ScheduleForm 경로)이면 scenarioHasThink=true여도 미렌더", () => {
    render(<LoadModelFields {...openFixedProps()} scenarioHasThink />);
    expect(
      screen.queryByRole("checkbox", { name: ko.loadModel.applyScenarioThinkLabel }),
    ).not.toBeInTheDocument();
  });

  // ── Task 6③: 관측 RPS 앵커 (open+fixed) (§B21) ──────────────────────────
  it("offers the observed-RPS anchor in open+fixed and fills target_rps on click", () => {
    const setTargetRps = vi.fn();
    render(
      <LoadModelFields
        {...openFixedProps()}
        setTargetRps={setTargetRps}
        sizePresetAnchor={{ vus: 50, rps: 180.4, durationSeconds: 60 }}
      />,
    );
    expect(screen.getByText(ko.loadModel.observedRpsAnchor(180))).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: ko.loadModel.observedRpsApply }));
    expect(setTargetRps).toHaveBeenCalledWith("180");
  });

  it("hides the anchor when there is no prior run", () => {
    render(<LoadModelFields {...openFixedProps()} sizePresetAnchor={null} />);
    expect(
      screen.queryByRole("button", { name: ko.loadModel.observedRpsApply }),
    ).not.toBeInTheDocument();
  });

  it("open 모드 maxInFlight hint가 accessible description으로 낭독된다 (US2)", () => {
    renderFields({ loadModel: "open", rateMode: "fixed" });
    expect(screen.getByLabelText(ko.loadModel.maxInFlight)).toHaveAccessibleDescription(
      ko.loadModel.maxInFlightHint,
    );
  });
});

const oneHttp = { steps: [{ type: "http" }] } as unknown as Scenario;

// http leaf 필수 필드는 SlotSizingHelper.test.tsx의 http() 관행과 동형 — id/name/request 채운 뒤 캐스트.
const http = (id: string): Step =>
  ({
    type: "http",
    id,
    name: id,
    request: { method: "GET", url: "/x" },
  }) as unknown as Step;

const twoStepScenario = { steps: [http("a"), http("b")] } as unknown as Scenario;

const branchScenario = {
  steps: [
    http("a"),
    {
      type: "if",
      id: "I",
      name: "I",
      cond: {},
      then: [http("b")],
      elif: [],
      else: [],
    } as unknown as Step,
  ],
} as unknown as Scenario;

const oneStepScenario = { steps: [http("a")] } as unknown as Scenario;

describe("LoadModelFields — open-loop 구조 경고", () => {
  it("① 곡선 W>peak → 유휴 워커 경고 + 적용 버튼이 worker_count를 peak로", async () => {
    const user = userEvent.setup();
    const setWorkerCount = vi.fn();
    renderFields({
      loadModel: "open",
      rateMode: "curve",
      stages: [{ target: "1", duration_seconds: "10" }],
      workerCount: "3",
      setWorkerCount,
      onApplyWorkerCount: vi.fn(),
      sizingScenarioId: "s1",
    });
    expect(screen.getByText(/할 일이 없어요/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /맞추기/ }));
    expect(setWorkerCount).toHaveBeenCalledWith("1"); // peak=1
  });

  it("② 단일 워커·inert → max_in_flight 무효 경고", () => {
    renderFields({
      loadModel: "open",
      rateMode: "fixed",
      targetRps: "10",
      maxInFlight: "10000",
      httpTimeout: 1,
      sizingScenario: oneHttp,
      sizingScenarioId: "s1",
    });
    expect(screen.getByText(/영향을 주지 않아요/)).toBeInTheDocument();
  });

  it("② pool 모드면 미렌더 (R13)", () => {
    renderFields({
      loadModel: "open",
      rateMode: "fixed",
      targetRps: "10",
      maxInFlight: "10000",
      httpTimeout: 1,
      sizingScenario: oneHttp,
      sizingScenarioId: "s1",
      poolMode: true,
    });
    expect(screen.queryByText(/영향을 주지 않아요/)).not.toBeInTheDocument();
  });

  it("② httpTimeout 부재(ScheduleForm) → 미렌더", () => {
    renderFields({
      loadModel: "open",
      rateMode: "fixed",
      targetRps: "10",
      maxInFlight: "10000",
      sizingScenario: oneHttp,
      sizingScenarioId: "s1",
    });
    expect(screen.queryByText(/영향을 주지 않아요/)).not.toBeInTheDocument();
  });

  it("경고가 있어도 제출을 막지 않는다(비차단 advisory, R5)", () => {
    // LoadModelFields는 Run 버튼을 소유하지 않음 — 경고는 role=status, aria-invalid/disabled 미설정.
    renderFields({
      loadModel: "open",
      rateMode: "fixed",
      targetRps: "10",
      maxInFlight: "10000",
      httpTimeout: 1,
      sizingScenario: oneHttp,
      sizingScenarioId: "s1",
    });
    const warn = screen.getByText(/영향을 주지 않아요/);
    expect(warn.closest("[role='status']")).not.toBeNull();
  });
});

describe("도착률→요청 환산 힌트", () => {
  it("simpleMode에서도 fixed 환산 힌트 렌더(의도 — 입력 아래 보조 문구)", () => {
    renderFields({
      loadModel: "open",
      rateMode: "fixed",
      targetRps: "20",
      sizingScenario: twoStepScenario,
      simpleMode: true,
    });
    expect(screen.getByText("≈ 초당 요청 40건")).toBeInTheDocument();
  });
  it("open+fixed + scenario(http 2개) + 목표 20 → '≈ 초당 요청 40건'", () => {
    renderFields({
      loadModel: "open",
      rateMode: "fixed",
      targetRps: "20",
      sizingScenario: twoStepScenario,
    });
    expect(screen.getByText("≈ 초당 요청 40건")).toBeInTheDocument();
  });
  it("분기 시나리오(http1 + if(then 1/else 빈)) + 목표 10 → 범위 '≈ 초당 요청 10~20건'", () => {
    renderFields({
      loadModel: "open",
      rateMode: "fixed",
      targetRps: "10",
      sizingScenario: branchScenario,
    });
    expect(screen.getByText("≈ 초당 요청 10~20건")).toBeInTheDocument();
  });
  it("scenario 미전달(ScheduleForm 경로) → 힌트 미렌더", () => {
    renderFields({ loadModel: "open", rateMode: "fixed", targetRps: "20" });
    expect(screen.queryByText(/≈ 초당 요청/)).not.toBeInTheDocument();
  });
  it("목표 무효(빈 문자열) → 미렌더", () => {
    renderFields({
      loadModel: "open",
      rateMode: "fixed",
      targetRps: "",
      sizingScenario: twoStepScenario,
    });
    expect(screen.queryByText(/≈ 초당 요청/)).not.toBeInTheDocument();
  });
  it("open+curve + scenario(http 1개) + peak 50 → '최고 단계 기준 ≈ 초당 요청 50건'", () => {
    renderFields({
      loadModel: "open",
      rateMode: "curve",
      sizingScenario: oneStepScenario,
      stages: [
        { target: "50", duration_seconds: "30" },
        { target: "10", duration_seconds: "30" },
      ],
    });
    expect(screen.getByText("최고 단계 기준 ≈ 초당 요청 50건")).toBeInTheDocument();
  });
  it("closed 모드 → 미렌더 (VU 곡선에 환산 없음)", () => {
    renderFields({ loadModel: "closed", rateMode: "fixed", sizingScenario: twoStepScenario });
    expect(screen.queryByText(/≈ 초당 요청/)).not.toBeInTheDocument();
  });
});

describe("LoadModelFields — 계단", () => {
  const stair = {
    ...STAIR_DEFAULTS,
    targets: "100, 200, 800",
  };

  it("세그먼트(타일 모드)·라디오 둘 다 open에서만 「계단」을 낸다", () => {
    const { unmount } = render(
      <LoadModelFields {...baseProps({ loadModel: "open", loadModelTiles: true })} />,
    );
    expect(screen.getByRole("radio", { name: "계단" })).toBeInTheDocument();
    unmount();
    const r2 = render(<LoadModelFields {...baseProps({ loadModel: "open" })} />);
    expect(screen.getByRole("radio", { name: "계단" })).toBeInTheDocument();
    r2.unmount();
    render(<LoadModelFields {...baseProps({ loadModel: "closed" })} />);
    expect(screen.queryByRole("radio", { name: "계단" })).not.toBeInTheDocument();
  });

  it("사이징 도우미는 고정 target_rps 대신 최대 목표(800)를 받는다 — 슬롯·워커 둘 다", async () => {
    setup({
      loadModel: "open",
      rateMode: "stair",
      targetRps: "7",
      stair,
      setStair: vi.fn(),
      onApplyMaxInFlight: vi.fn(),
      onApplyWorkerCount: vi.fn(),
      setWorkerCount: vi.fn(),
      workerCount: "2",
      sizingScenarioId: "s1",
    });
    const slot = screen.getByTestId("slot-sizing-helper");
    expect(slot).toHaveAttribute("data-target", "800");
    expect(slot).toHaveAttribute("data-peak", "true");
    const worker = screen.getByTestId("worker-sizing-helper");
    expect(worker).toHaveAttribute("data-target", "800");
    expect(worker).toHaveAttribute("data-peak", "true");
  });

  it("최대 목표보다 워커가 많으면 유휴 워커 경고가 뜬다 (stairTargets 전달)", () => {
    setup({
      loadModel: "open",
      rateMode: "stair",
      stair: { ...stair, targets: "1, 2" },
      setStair: vi.fn(),
      setWorkerCount: vi.fn(),
      workerCount: "5",
    });
    expect(screen.getByText(/할 일이 없어요/)).toBeInTheDocument();
  });

  it("closed로 바꾸면 계단은 고정으로 되돌린다", async () => {
    const user = userEvent.setup();
    setRateMode.mockClear();
    const props = setup({ loadModel: "open", rateMode: "stair", stair, setStair: vi.fn() });
    await user.click(screen.getByRole("radio", { name: /closed-loop/ }));
    expect(props.setLoadModel).toHaveBeenCalledWith("closed");
    expect(setRateMode).toHaveBeenCalledWith("fixed");
  });

  it("계단 탭 경고·도우미 문구는 곡선/단계가 아니라 목표 목록 기준이다", () => {
    setup({
      loadModel: "open",
      rateMode: "stair",
      stair: { ...stair, targets: "1, 2" },
      setStair: vi.fn(),
      setWorkerCount: vi.fn(),
      workerCount: "5",
    });
    expect(screen.getByText(ko.openLoopCheck.idleWorkersStair(3, 2))).toBeInTheDocument();
    expect(screen.queryByText(/곡선 최고점/)).not.toBeInTheDocument();
  });

  describe("steady 칸 (상승·버림)", () => {
    it("도착률 고정: 상세 모드에 상승·버림 칸", () => {
      setup({ loadModel: "open", rateMode: "fixed" });
      expect(screen.getByRole("spinbutton", { name: "상승 시간(초)" })).toBeInTheDocument();
      expect(screen.getByRole("spinbutton", { name: "앞부분 버림(초)" })).toBeInTheDocument();
    });

    it("도착률 고정: 간단 모드에는 두 칸이 없다", () => {
      setup({ loadModel: "open", rateMode: "fixed", simpleMode: true });
      expect(screen.queryByRole("spinbutton", { name: "상승 시간(초)" })).toBeNull();
      expect(screen.queryByRole("spinbutton", { name: "앞부분 버림(초)" })).toBeNull();
    });

    it("VU 고정: 간단 모드에 상승 칸은 있고 버림 칸은 없다", () => {
      setup({ loadModel: "closed", rateMode: "fixed", simpleMode: true });
      expect(screen.getByLabelText("상승 시간(초)")).toBeInTheDocument();
      expect(screen.queryByRole("spinbutton", { name: "앞부분 버림(초)" })).toBeNull();
    });

    it("VU 고정: 상세 모드에 버림 칸", () => {
      setup({ loadModel: "closed", rateMode: "fixed" });
      expect(screen.getByRole("spinbutton", { name: "앞부분 버림(초)" })).toBeInTheDocument();
    });

    it.each([
      ["open", "curve"],
      ["open", "stair"],
      ["closed", "curve"],
    ] as const)("곡선·계단: 새 칸이 없다 (%s %s)", (loadModel, rateMode) => {
      setup({ loadModel, rateMode, stair: STAIR_DEFAULTS });
      expect(screen.queryByRole("spinbutton", { name: "앞부분 버림(초)" })).toBeNull();
      expect(screen.queryByRole("spinbutton", { name: "상승 시간(초)" })).toBeNull();
    });

    it("요약 줄", () => {
      setup({ loadModel: "open", rateMode: "fixed", duration: 300, rampOpen: 30, discard: 5 });
      expect(
        screen.getByText("상승 30초 → 유지 270초 · 리포트 기본 기준은 뒤 265초"),
      ).toBeInTheDocument();
    });

    it("요약 줄: 상승 0이면 앞부분 없이", () => {
      setup({ loadModel: "open", rateMode: "fixed", duration: 60, discard: 5 });
      expect(screen.getByText("유지 60초 · 리포트 기본 기준은 뒤 55초")).toBeInTheDocument();
    });

    it("fallback 안내는 간단 모드에서도 보인다", () => {
      setup({ loadModel: "closed", rateMode: "fixed", simpleMode: true, rampUp: 5, duration: 5 });
      const status = screen.getByRole("status");
      expect(status).toHaveTextContent("전체 구간 기준");
      expect(status).toHaveTextContent("상승이 실행 시간과 같거나 깁니다");
    });

    it("error 안내", () => {
      setup({
        loadModel: "closed",
        rateMode: "fixed",
        duration: 12,
        discard: 10,
        errs: { ...noErrs, steadyInvalid: true },
      });
      expect(screen.getByRole("alert")).toHaveTextContent("상승 뒤 남는 시간이 5초보다 짧습니다");
      expect(screen.getByRole("spinbutton", { name: "앞부분 버림(초)" })).toHaveAttribute(
        "aria-invalid",
        "true",
      );
    });

    it("권장 5초 안내", () => {
      const setDiscard = vi.fn();
      const { unmount } = render(
        <LoadModelFields
          {...baseProps({
            loadModel: "open",
            rateMode: "fixed",
            duration: 60,
            rampOpen: 10,
            setDiscard,
          })}
        />,
      );
      expect(screen.getByText("권장 5초")).toBeInTheDocument();
      expect(setDiscard).not.toHaveBeenCalled();
      unmount();
      render(
        <LoadModelFields
          {...baseProps({
            loadModel: "open",
            rateMode: "fixed",
            duration: 60,
            rampOpen: 10,
            discard: 5,
          })}
        />,
      );
      expect(screen.queryByText("권장 5초")).toBeNull();
    });

    it("도착률 고정: 목표 도착률 오류가 상승·버림 칸과 안내 줄보다 앞에 온다", () => {
      const { container } = render(
        <LoadModelFields
          {...baseProps({
            loadModel: "open",
            rateMode: "fixed",
            duration: 12,
            discard: 10,
            errs: { ...noErrs, targetRpsInvalid: true, steadyInvalid: true },
          })}
        />,
      );
      const targetError = container.querySelector("#target-rps-error")!;
      const ramp = screen.getByRole("spinbutton", { name: "상승 시간(초)" });
      const steadyLine = screen.getByRole("alert");
      const follows = (a: Element, b: Element) =>
        Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
      expect(targetError).not.toBeNull();
      expect(follows(targetError, ramp)).toBe(true);
      expect(follows(targetError, steadyLine)).toBe(true);
    });

    it.each([
      ["ramp_too_long", { duration: 10000, rampOpen: 3601 }, "true", "false"],
      ["discard_too_long", { duration: 5000, discard: 3601 }, "false", "true"],
      ["ramp_ge_duration", { duration: 60, rampOpen: 100 }, "true", "true"],
      ["hold_too_short", { duration: 12, discard: 10 }, "true", "true"],
      ["hold_too_long", { duration: 90000, rampOpen: 1 }, "true", "true"],
      ["not_whole_seconds(버림)", { duration: 60, discard: 2.5 }, "false", "true"],
      ["not_whole_seconds(상승)", { duration: 60, rampOpen: 2.5 }, "true", "false"],
    ] as const)(
      "aria-invalid은 사유가 가리키는 칸에만: %s",
      (_n, over, rampInvalid, discardInvalid) => {
        setup({
          loadModel: "open",
          rateMode: "fixed",
          errs: { ...noErrs, steadyInvalid: true },
          ...over,
        });
        expect(screen.getByRole("spinbutton", { name: "상승 시간(초)" })).toHaveAttribute(
          "aria-invalid",
          rampInvalid,
        );
        expect(screen.getByRole("spinbutton", { name: "앞부분 버림(초)" })).toHaveAttribute(
          "aria-invalid",
          discardInvalid,
        );
      },
    );

    it("표시된 오류 줄을 표시된 칸이 aria-describedby로 가리킨다", () => {
      setup({
        loadModel: "open",
        rateMode: "fixed",
        duration: 12,
        discard: 10,
        errs: { ...noErrs, steadyInvalid: true },
      });
      const lineId = screen.getByRole("alert").id;
      expect(lineId).not.toBe("");
      for (const name of ["상승 시간(초)", "앞부분 버림(초)"]) {
        expect(screen.getByRole("spinbutton", { name }).getAttribute("aria-describedby")).toContain(
          lineId,
        );
      }
    });

    it("VU 고정: 상승이 실행 시간보다 길면 빨간 줄은 하나 — steady 줄을 겹쳐 띄우지 않는다", () => {
      setup({
        loadModel: "closed",
        rateMode: "fixed",
        duration: 12,
        rampUp: 20,
        discard: 3,
        errs: { ...noErrs, rampInvalid: true, steadyInvalid: true },
      });
      expect(screen.getByText("상승 시간은 실행 시간 이하여야 합니다.")).toBeInTheDocument();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByText(/상승이 실행 시간과 같거나 깁니다/)).toBeNull();
      const ramp = screen.getByRole("spinbutton", { name: "상승 시간(초)" });
      expect(ramp.getAttribute("aria-describedby")).toBe("ramp-up-error");
      expect(ramp).toHaveAttribute("aria-invalid", "true");
    });

    it("VU 고정: 상승이 실행 시간보다 길고 버림 0이면 「전체 구간 기준」 안내도 띄우지 않는다", () => {
      setup({
        loadModel: "closed",
        rateMode: "fixed",
        duration: 12,
        rampUp: 20,
        discard: 0,
        errs: { ...noErrs, rampInvalid: true },
      });
      expect(screen.getByText("상승 시간은 실행 시간 이하여야 합니다.")).toBeInTheDocument();
      expect(screen.queryByText(/전체 구간 기준/)).toBeNull();
    });

    it("VU 고정: 상승이 실행 시간과 같으면 steady 줄 하나만 뜬다", () => {
      setup({
        loadModel: "closed",
        rateMode: "fixed",
        duration: 20,
        rampUp: 20,
        discard: 3,
        errs: { ...noErrs, steadyInvalid: true },
      });
      expect(screen.getByRole("alert")).toHaveTextContent("상승이 실행 시간과 같거나 깁니다");
      expect(screen.queryByText("상승 시간은 실행 시간 이하여야 합니다.")).toBeNull();
    });

    it("오류가 없으면 칸에 steady 줄 연결이 없다", () => {
      setup({ loadModel: "open", rateMode: "fixed", duration: 60, rampOpen: 10, discard: 5 });
      expect(
        screen
          .getByRole("spinbutton", { name: "앞부분 버림(초)" })
          .getAttribute("aria-describedby"),
      ).toBeNull();
    });

    it("새 도움말 버튼의 접근명", () => {
      setup({ loadModel: "open", rateMode: "fixed" });
      expect(screen.getByRole("button", { name: "상승 시간 설명" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "앞부분 버림 설명" })).toBeInTheDocument();
    });
  });
});
