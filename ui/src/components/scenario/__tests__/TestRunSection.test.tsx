import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TestRunSection } from "../TestRunSection";

// Spy on the test-run mutation. We mock the whole hooks module so that
// useTestRun's mutate is observable and the EnvironmentPicker's data hooks
// (useEnvironment/useEnvironments) return empty stubs (no QueryClient needed).
const mutate = vi.fn();
let isPending = false;
// data controls whether TestRunPanel (and the addedNote region) renders
let testRunData: unknown = undefined;
// error controls whether the error Callout renders
let testRunError: unknown = null;
vi.mock("../../../api/hooks", () => ({
  useTestRun: () => ({ mutate, isPending, error: testRunError, data: testRunData }),
  useEnvironment: () => ({ data: undefined }),
  useEnvironments: () => ({ data: [] }),
}));

// Capture the onAddExtract callback from TestRunPanel so the test can invoke it
// without needing to simulate deep panel interactions or a real ScenarioTrace.
let capturedOnAddExtract: ((stepId: string, extract: { var: string }) => void) | undefined;
vi.mock("../TestRunPanel", () => ({
  TestRunPanel: (props: { onAddExtract?: (stepId: string, extract: { var: string }) => void }) => {
    capturedOnAddExtract = props.onAddExtract;
    return <div data-testid="test-run-panel-stub" />;
  },
}));

// Stub the scenario store so addStepExtract doesn't blow up.
const select = vi.fn();
vi.mock("../../../scenario/store", () => ({
  useScenarioEditor: Object.assign(
    vi.fn((selector?: (s: { selectedStepId: string | null }) => unknown) =>
      selector ? selector({ selectedStepId: null }) : undefined,
    ),
    {
      getState: () => ({ addStepExtract: vi.fn(), select }),
    },
  ),
}));

const VALID_YAML = `version: 1
name: s
steps:
  - type: http
    id: a
    request:
      method: GET
      url: http://x/ping
`;

beforeEach(() => {
  mutate.mockReset();
  isPending = false;
  testRunData = undefined;
  testRunError = null;
  capturedOnAddExtract = undefined;
  select.mockReset();
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("TestRunSection apply_think_time toggle", () => {
  it("passes apply_think_time when the toggle is checked", async () => {
    const user = userEvent.setup();
    render(<TestRunSection yamlText={VALID_YAML} />);

    await user.click(screen.getByRole("checkbox", { name: /think time/i }));
    await user.click(screen.getByRole("button", { name: /미리 실행/i }));

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0]).toMatchObject({ apply_think_time: true });
  });

  it("passes apply_think_time false when the toggle is unchecked", async () => {
    const user = userEvent.setup();
    render(<TestRunSection yamlText={VALID_YAML} />);

    await user.click(screen.getByRole("button", { name: /미리 실행/i }));

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0]).toMatchObject({ apply_think_time: false });
  });
});

describe("TestRunSection 제목/안내 (목적 자명화)", () => {
  it("컨트롤 제목과 안내 문구를 렌더한다", () => {
    render(<TestRunSection yamlText={VALID_YAML} />);
    expect(screen.getByRole("heading", { name: "시나리오 미리 테스트" })).toBeInTheDocument();
    expect(screen.getByText(/저장·부하 없이 현재 내용으로/)).toBeInTheDocument();
  });
});

describe("TestRunSection addedNote transience", () => {
  it("새 test-run 발사 시 이전 '추출 추가됨' 안내가 지워진다", async () => {
    const user = userEvent.setup();
    // 1) data가 있으면 TestRunPanel(stub)이 렌더되고 onAddExtract가 캡처된다
    testRunData = { steps: [] };
    render(<TestRunSection yamlText={VALID_YAML} />);

    // stub이 렌더됐는지 + onAddExtract가 캡처됐는지 확인
    expect(screen.getByTestId("test-run-panel-stub")).toBeInTheDocument();
    expect(capturedOnAddExtract).toBeDefined();

    // 2) onAddExtract를 직접 호출해 addedNote를 설정한다
    act(() => {
      capturedOnAddExtract!("step-1", { var: "token" });
    });
    expect(screen.getByRole("status", { hidden: true })).toHaveTextContent("추출 추가됨");

    // 3) 새 test-run 발사 — fire() 안에서 setAddedNote(null)이 불려야 한다
    await user.click(screen.getByRole("button", { name: /미리 실행/i }));

    // 안내가 사라졌어야 한다
    expect(screen.queryByRole("status", { hidden: true })).not.toBeInTheDocument();
  });
});

// 스트립 렌더용 fixture — id는 유효 ULID 필수(비-ULID면 parseScenarioDoc가 실패해 스트립이 안 뜸)
const CHIP_YAML = `version: 1
name: s
steps:
  - id: "01HX0000000000000000000001"
    name: ping
    type: http
    request:
      method: GET
      url: http://x/ping
`;

describe("TestRunSection flow chip strip (spec R1/R6)", () => {
  it("파싱 가능한 버퍼면 스트립을 렌더하고 칩 클릭이 store select로 배선된다", async () => {
    const user = userEvent.setup();
    render(<TestRunSection yamlText={CHIP_YAML} />);
    expect(screen.getByRole("group", { name: "테스트 흐름" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "ping" }));
    expect(select).toHaveBeenCalledWith("01HX0000000000000000000001");
  });

  it("파싱 불가 버퍼면 스트립을 렌더하지 않는다", () => {
    render(<TestRunSection yamlText={"version: ["} />);
    expect(screen.queryByRole("group", { name: "테스트 흐름" })).not.toBeInTheDocument();
  });
});

describe("TestRunSection — maxRequests input adopts primitive Input (design-system-editor)", () => {
  it("maxRequests input uses primitive Input with accent focus-ring class", () => {
    render(<TestRunSection yamlText={VALID_YAML} />);
    const maxRequests = screen.getByLabelText("최대 요청 수") as HTMLInputElement;
    expect(maxRequests).toHaveClass("focus:ring-accent-500/30"); // Input BASE — RED before migration
    expect(maxRequests.type).toBe("number");
  });
});

describe("TestRunSection — error state adopts Callout (design-system-editor)", () => {
  it("renders the test-run error as a roleless error Callout box", () => {
    testRunError = new Error("boom");
    render(<TestRunSection yamlText={VALID_YAML} />);
    const message = screen.getByText("boom");
    const box = message.closest("div");
    expect(box).toHaveClass("rounded-md"); // Callout box — RED before migration (raw <p> has no box)
    expect(box).toHaveClass("bg-red-50");
    expect(box).not.toHaveAttribute("role"); // roleless (R7)
  });

  it("keeps the success emerald role=status inline note untouched (frozen R7)", () => {
    testRunData = { steps: [] };
    render(<TestRunSection yamlText={VALID_YAML} />);
    act(() => {
      capturedOnAddExtract!("step-1", { var: "token" });
    });
    const note = screen.getByRole("status", { hidden: true });
    expect(note).toHaveClass("text-emerald-700");
  });
});
