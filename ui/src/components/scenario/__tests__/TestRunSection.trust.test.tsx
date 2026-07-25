import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TestRunSection } from "../TestRunSection";
import { ScenarioModel, type Scenario } from "../../../scenario/model";
import { DRAFT_KEY, fingerprintHash, testRunStateFor } from "../../../scenario/trustPrefs";
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
const URL_A = "https://e.test/a";
/** 지문에 실제로 포함되는 필드(URL)만 A와 다른 내용 — T3에서 URL 지문 포함이 핀됨. */
const URL_B = "https://e.test/b";

function yamlWithUrl(url: string): string {
  return `version: 1
name: t
steps:
  - id: ${A}
    name: s-A
    type: http
    request:
      method: GET
      url: ${url}
`;
}

const YAML = yamlWithUrl(URL_A);
const YAML_B = yamlWithUrl(URL_B);

/** YAML과 동일한 시나리오 — 버킷 조회용 오라클. 변형은 사후 변경이 아니라
 *  매번 새 빌더 호출로 만든다(Step union 사후 변경 금지). */
function parsedScenario(url: string = URL_A): Scenario {
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
        request: { method: "GET", url, headers: {} },
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
  // 이 파일의 마지막 케이스가 라이브 store를 갈아끼우므로 케이스마다 초기화한다.
  useScenarioEditor.setState(useScenarioEditor.getInitialState());
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

  // 지문은 mutate *전*(fire() 시점)에 스냅샷돼야 한다. 성공 시점에 라이브 store
  // (useScenarioEditor.getState().model)에서 다시 계산하면, 실행 중 편집한 내용이
  // verified로 기록된다. 재렌더(yamlText prop 교체)로는 이 구현을 구별할 수 없다 —
  // fire()가 그 렌더의 yamlText를 클로저로 잡으므로 onSuccess 안에서 prop을 다시
  // 파싱해도 같은 해시가 나온다. 그래서 *가변 공유 소스*인 라이브 store를 바꾼다.
  it("지문은 fire() 시점 스냅샷 — 실행 중 store가 바뀌어도 옛 내용만 verified", async () => {
    render(<TestRunSection yamlText={YAML} />);
    const onSuccess = await fireAndGetOnSuccess();

    // 실행 중 사용자가 에디터에서 URL을 B로 바꾼다(라이브 store 교체).
    act(() => {
      useScenarioEditor.getState().loadFromString(YAML_B);
    });
    const live = useScenarioEditor.getState().model;
    expect(live).not.toBeNull();
    // 전제 확인: 라이브 store는 이제 B로 해시된다(A와 다르다).
    expect(fingerprintHash(live!)).toBe(fingerprintHash(parsedScenario(URL_B)));
    expect(fingerprintHash(live!)).not.toBe(fingerprintHash(parsedScenario(URL_A)));

    onSuccess({ ok: true, truncated: false, steps: [] });

    expect(testRunStateFor(DRAFT_KEY, parsedScenario(URL_A))).toBe("verified");
    expect(testRunStateFor(DRAFT_KEY, parsedScenario(URL_B))).not.toBe("verified");
  });
});
