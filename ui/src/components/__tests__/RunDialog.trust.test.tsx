import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { RunDialog } from "../RunDialog";
import { ko } from "../../i18n/ko";
import { ScenarioModel, type Scenario } from "../../scenario/model";
import { DRAFT_KEY, fingerprintHash, recordVerified } from "../../scenario/trustPrefs";

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

function renderDialog(scenario: Scenario | null) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <RunDialog
        scenarioId="S1"
        hasLoop={false}
        scenario={scenario}
        onCreated={vi.fn()}
        onCancel={vi.fn()}
      />
    </QueryClientProvider>,
  );
}

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
});
