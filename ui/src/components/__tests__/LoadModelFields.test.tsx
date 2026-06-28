import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LoadModelFields } from "../LoadModelFields";
import type { LoadModelErrors } from "../loadModel";
import type { Scenario } from "../../scenario/model";
import { ko } from "../../i18n/ko";

vi.mock("../VuSizingHelper", () => ({
  VuSizingHelper: () => <div data-testid="sizing-helper" />,
}));

vi.mock("../SlotSizingHelper", () => ({
  SlotSizingHelper: () => <div data-testid="slot-sizing-helper" />,
}));

vi.mock("../WorkerSizingHelper", () => ({
  WorkerSizingHelper: () => <div data-testid="worker-sizing-helper" />,
}));

const noErrs: LoadModelErrors = {
  rampInvalid: false,
  targetRpsInvalid: false,
  maxInFlightInvalid: false,
  stagesInvalid: false,
  workerCountInvalid: false,
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
    expect(screen.queryByLabelText(/점진 시작/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/테스트 시간/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/동시 요청 상한/)).not.toBeInTheDocument();
  });

  it("open+curve: 기존 목표 RPS 라벨 유지 + ramp_down 비노출 (회귀 가드)", () => {
    renderFields({ loadModel: "open", rateMode: "curve" });
    expect(screen.getAllByText("목표 RPS").length).toBeGreaterThan(0);
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
  it("closed+fixed: duration HelpTip 존재 (지속 시간 설명 버튼)", () => {
    renderFields({ loadModel: "closed", rateMode: "fixed" });
    expect(screen.getByRole("button", { name: "지속 시간 설명" })).toBeInTheDocument();
  });

  it("open+fixed: duration HelpTip 존재 (지속 시간 설명 버튼)", () => {
    renderFields({ loadModel: "open", rateMode: "fixed" });
    expect(screen.getByRole("button", { name: "지속 시간 설명" })).toBeInTheDocument();
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
    const open = screen.getByRole("radio", { name: /목표 RPS/ }).closest("div")!;
    expect(closed).toHaveClass("border-accent-500"); // 선택
    expect(open).not.toHaveClass("border-accent-500"); // 비선택 (teeth: 선택을 open으로 뒤집으면 FAIL)
  });

  it("타일 라디오 accessible name은 제목만 (HelpTip 비오염, U3)", () => {
    setup({ loadModelTiles: true, loadModel: "closed" });
    // 정확매치: 설명/HelpTip 라벨이 섞이면 실패
    expect(screen.getByRole("radio", { name: "동시 사용자 (VU)" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "목표 RPS" })).toBeInTheDocument();
  });

  it("without new props, renders legacy radios + profile + worker (ScheduleForm parity)", () => {
    setup({ loadModel: "open", rateMode: "fixed", setWorkerCount: vi.fn() });
    expect(screen.getByRole("radio", { name: /요청 속도 기준/ })).toBeInTheDocument();
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
});

const oneHttp = { steps: [{ type: "http" }] } as unknown as Scenario;

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
