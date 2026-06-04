import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TestRunSection } from "../TestRunSection";

// Spy on the test-run mutation. We mock the whole hooks module so that
// useTestRun's mutate is observable and the EnvironmentPicker's data hooks
// (useEnvironment/useEnvironments) return empty stubs (no QueryClient needed).
const mutate = vi.fn();
vi.mock("../../../api/hooks", () => ({
  useTestRun: () => ({ mutate, isPending: false, error: null, data: undefined }),
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
});
afterEach(() => {
  vi.clearAllMocks();
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
