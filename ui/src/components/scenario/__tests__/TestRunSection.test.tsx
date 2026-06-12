import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TestRunSection, type TestRunHandle } from "../TestRunSection";

// Spy on the test-run mutation. We mock the whole hooks module so that
// useTestRun's mutate is observable and the EnvironmentPicker's data hooks
// (useEnvironment/useEnvironments) return empty stubs (no QueryClient needed).
const mutate = vi.fn();
let isPending = false;
vi.mock("../../../api/hooks", () => ({
  useTestRun: () => ({ mutate, isPending, error: null, data: undefined }),
  useEnvironment: () => ({ data: undefined }),
  useEnvironments: () => ({ data: [] }),
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
});
afterEach(() => {
  vi.clearAllMocks();
  // jsdom은 scrollIntoView 미구현 — 테스트가 깐 폴리필을 sibling 누수 없이 회수
  Reflect.deleteProperty(Element.prototype, "scrollIntoView");
});

describe("TestRunSection apply_think_time toggle", () => {
  it("passes apply_think_time when the toggle is checked", async () => {
    const user = userEvent.setup();
    render(<TestRunSection yamlText={VALID_YAML} />);

    await user.click(screen.getByRole("checkbox", { name: /think time/i }));
    await user.click(screen.getByRole("button", { name: /test run/i }));

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0]).toMatchObject({ apply_think_time: true });
  });

  it("passes apply_think_time false when the toggle is unchecked", async () => {
    const user = userEvent.setup();
    render(<TestRunSection yamlText={VALID_YAML} />);

    await user.click(screen.getByRole("button", { name: /test run/i }));

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0]).toMatchObject({ apply_think_time: false });
  });
});

describe("TestRunSection runNow handle (U4 §5.5)", () => {
  it("runNow()는 섹션으로 스크롤하고 현재 입력값으로 mutation을 발사한다", () => {
    const scrollSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollSpy;
    const ref = createRef<TestRunHandle>();
    render(<TestRunSection ref={ref} yamlText={VALID_YAML} />);

    act(() => ref.current!.runNow());

    expect(scrollSpy).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0]).toMatchObject({
      scenario_yaml: VALID_YAML,
      max_requests: 50,
      apply_think_time: false,
    });
  });

  it("isPending 중에는 runNow()가 중복 발사하지 않는다 — 스크롤(진행 상태 안내)은 그대로 동작", () => {
    isPending = true;
    const scrollSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollSpy;
    const ref = createRef<TestRunHandle>();
    render(<TestRunSection ref={ref} yamlText={VALID_YAML} />);
    act(() => ref.current!.runNow());
    expect(mutate).not.toHaveBeenCalled();
    expect(scrollSpy).toHaveBeenCalledTimes(1); // 진행 중에도 섹션으로 데려가 상태를 보여준다
  });
});
