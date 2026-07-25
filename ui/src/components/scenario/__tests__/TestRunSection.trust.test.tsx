import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TestRunSection } from "../TestRunSection";
import { ScenarioModel, type Scenario } from "../../../scenario/model";
import { DRAFT_KEY, testRunStateFor } from "../../../scenario/trustPrefs";
import { useScenarioEditor } from "../../../scenario/store";

const mutate = vi.fn();
vi.mock("../../../api/hooks", () => ({
  useTestRun: () => ({ mutate, isPending: false, error: null, data: undefined, reset: vi.fn() }),
  useTestRunSequential: () => ({
    mutate: vi.fn(),
    isPending: false,
    error: null,
    data: undefined,
    reset: vi.fn(),
  }),
  useEnvironment: () => ({ data: undefined }),
  useEnvironments: () => ({ data: [] }),
}));

const A = "01HZZZZZZZZZZZZZZZZZZZZZZA";

const YAML = `version: 1
name: t
steps:
  - id: ${A}
    name: s-A
    type: http
    request:
      method: GET
      url: https://e.test/a
`;

/** YAML과 동일한 시나리오 — 버킷 조회용 오라클. */
function parsedScenario(): Scenario {
  return ScenarioModel.parse({
    version: 1,
    name: "t",
    cookie_jar: "auto",
    variables: {},
    steps: [
      {
        id: A,
        name: "s-A",
        type: "http",
        request: { method: "GET", url: "https://e.test/a", headers: {} },
        assert: [],
        extract: [],
      },
    ],
  });
}

/** fire() 후 단발 mutate에 넘어간 onSuccess를 꺼낸다. */
async function fireAndGetOnSuccess() {
  // 셀렉터는 기존 TestRunSection.test.tsx:80 과 동일하다.
  await userEvent.click(screen.getByRole("button", { name: /미리 실행/i }));
  const opts = mutate.mock.calls[0][1] as { onSuccess: (t: unknown) => void };
  return opts.onSuccess;
}

beforeEach(() => {
  window.localStorage.clear();
  mutate.mockReset();
});

describe("TestRunSection — 신뢰도 검증 기록", () => {
  it("ok=true·truncated=false면 verified로 기록되고 epoch가 오른다", async () => {
    const before = useScenarioEditor.getState().testRunEpoch;
    render(<TestRunSection yamlText={YAML} />);
    (await fireAndGetOnSuccess())({ ok: true, truncated: false, steps: [] });
    expect(testRunStateFor(DRAFT_KEY, parsedScenario())).toBe("verified");
    expect(useScenarioEditor.getState().testRunEpoch).toBe(before + 1);
  });

  it("ok=false면 기록하지 않는다 (전 스텝이 죽은 test-run)", async () => {
    render(<TestRunSection yamlText={YAML} />);
    (await fireAndGetOnSuccess())({ ok: false, truncated: false, steps: [] });
    expect(testRunStateFor(DRAFT_KEY, parsedScenario())).toBe("never");
  });

  it("truncated=true면 기록하지 않는다", async () => {
    render(<TestRunSection yamlText={YAML} />);
    (await fireAndGetOnSuccess())({ ok: true, truncated: true, steps: [] });
    expect(testRunStateFor(DRAFT_KEY, parsedScenario())).toBe("never");
  });
});
