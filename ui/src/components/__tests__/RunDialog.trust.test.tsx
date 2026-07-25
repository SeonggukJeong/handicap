import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { RunDialog } from "../RunDialog";
import { ko } from "../../i18n/ko";
import { ScenarioModel, type Scenario } from "../../scenario/model";
import { DRAFT_KEY, fingerprintHash, recordVerified } from "../../scenario/trustPrefs";
import { normalizeProfile, type RunPrefill } from "../../api/runPrefill";

// 데이터셋 패널은 stub — 시드된 `bindings` state가 그대로 유지돼 검증이 결정적이다
// (실제 패널은 데이터셋 fetch에 의존하고, 그 자체 커버리지는 DataBindingPanel.test.tsx).
// 사이징 헬퍼도 상세 모드에서 fetch를 쏘므로 차단(RunDialog.test.tsx 선례).
vi.mock("../DataBindingPanel", () => ({ DataBindingPanel: () => null }));
vi.mock("../VuSizingHelper", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../VuSizingHelper")>()),
  VuSizingHelper: () => null,
}));

const A = "01HZZZZZZZZZZZZZZZZZZZZZZA";

function sc(over: Record<string, unknown> = {}): Scenario {
  return ScenarioModel.parse({
    version: 1,
    name: "t",
    cookie_jar: "auto",
    variables: {},
    steps: [],
    ...over,
  });
}
function step(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: A,
    name: "s-A",
    type: "http",
    request: { method: "GET", url: "https://e.test/a", headers: {} },
    assert: [{ kind: "status", code: 200 }],
    extract: [],
    ...over,
  };
}

function renderDialog(scenario: Scenario | null, initial?: RunPrefill) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <RunDialog
        scenarioId="S1"
        hasLoop={false}
        scenario={scenario}
        initial={initial}
        onCreated={vi.fn()}
        onCancel={vi.fn()}
      />
    </QueryClientProvider>,
  );
}

/** 데이터셋 열이 `{{username}}`을 공급하는 run 프리필 — `bindings` state를 시드한다
 *  (`seedBindingsFrom(initial.profile)`). 이 값이 있으면 RunDialog는 상세 모드로 열린다. */
const boundPrefill = (): RunPrefill => ({
  profile: normalizeProfile({
    vus: 2,
    duration_seconds: 5,
    data_bindings: [
      {
        dataset_id: "DS1",
        policy: "per_vu",
        mappings: [{ kind: "column", var: "username", column: "username" }],
      },
    ],
  }),
  env: {},
});

beforeEach(() => {
  window.localStorage.clear();
});

describe("RunDialog — 신뢰도 한 줄", () => {
  it("양호면 아무것도 렌더하지 않는다", () => {
    renderDialog(sc({ steps: [step()] }));
    expect(screen.queryByText(/시나리오 신뢰도/)).not.toBeInTheDocument();
  });

  it("검증 기록이 있든 없든 렌더 여부가 같다 (FR1 회귀 가드)", () => {
    const good = sc({ steps: [step()] });
    // ① 버킷을 채운 채
    recordVerified(DRAFT_KEY, fingerprintHash(good));
    recordVerified("S1", fingerprintHash(good));
    const { unmount } = renderDialog(good);
    expect(screen.queryByText(/시나리오 신뢰도/)).not.toBeInTheDocument();
    unmount();
    // ② 비운 채
    window.localStorage.clear();
    renderDialog(good);
    expect(screen.queryByText(/시나리오 신뢰도/)).not.toBeInTheDocument();
  });

  it("검증 없는 스텝이 있으면 한 줄 + 에디터 링크", () => {
    renderDialog(sc({ steps: [step({ assert: [] })] }));
    expect(screen.getByText(ko.trust.runDialogLine(ko.trust.level.caution, 1))).toBeInTheDocument();
    // 위 단언은 기대값과 렌더가 **같은 ko 함수**를 호출하므로, 카피에서 `(N건)` 보간이
    // 빠지면 양쪽이 함께 변해 green으로 남는다(self-referential formatter). US3가 요구하는
    // **건수**를 리터럴로 따로 못 박는다.
    expect(screen.getByText(/\(1건\)/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: ko.trust.runDialogLink })).toBeInTheDocument();
  });

  it("미정의 변수가 있으면 등급 단어 대신 전멸 예고 문구를 낸다", () => {
    renderDialog(
      sc({
        steps: [step({ request: { method: "GET", url: "https://e.test/{{nope}}", headers: {} } })],
      }),
    );
    expect(screen.getByText(ko.trust.runDialogBFail)).toBeInTheDocument();
  });

  // 데이터셋 열이 그 변수를 공급하는데도 전멸을 단정하면 거짓말이다 — 같은 다이얼로그의
  // DataBindingPanel이 방금 그 열 매핑을 **요구**했고, 실제 run은 성공한다
  // (engine runner.rs가 렌더 전에 바인딩 행 키를 iter_vars에 넣는다). 등급은 시나리오
  // 텍스트에 대한 판정이므로 `취약`으로 남는다(spec D4) — 바뀌는 건 문장뿐이다.
  it("바인딩이 있으면 전멸 단정 대신 등급 한 줄을 낸다", () => {
    renderDialog(
      sc({
        steps: [
          step({ request: { method: "GET", url: "https://e.test/{{username}}", headers: {} } }),
        ],
      }),
      boundPrefill(),
    );
    expect(screen.queryByText(ko.trust.runDialogBFail)).not.toBeInTheDocument();
    expect(screen.getByText(ko.trust.runDialogLine(ko.trust.level.weak, 1))).toBeInTheDocument();
  });
});
