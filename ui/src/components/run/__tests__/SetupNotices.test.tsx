import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DataBinding } from "../../../api/schemas";
import type { Scenario } from "../../../scenario/model";
import { parseScenarioDoc } from "../../../scenario/yamlDoc";
import { NoMainStepsWarning } from "../NoMainStepsWarning";
import { SetupNotices } from "../SetupNotices";

vi.mock("../../../api/hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../api/hooks")>()),
  useDatasets: () => ({ data: { datasets: [{ id: "D1", row_count: 5 }] } }),
}));

const S1 = "01ARZ3NDEKTSV4RRFFQ69G5FA1";
const S2 = "01ARZ3NDEKTSV4RRFFQ69G5FA2";

function step(id: string, url: string): string {
  return `  - id: ${id}\n    name: n${id.slice(-1)}\n    type: http\n    request:\n      method: GET\n      url: "${url}"\n`;
}

function model(setupUrl: string | null, mainUrl: string | null): Scenario {
  const setup = setupUrl === null ? "" : `setup:\n  steps:\n${step(S1, setupUrl)}`;
  const main = mainUrl === null ? "steps: []\n" : `steps:\n${step(S2, mainUrl)}`;
  const parsed = parseScenarioDoc(`version: 1\nname: s\n${setup}${main}`);
  if (!("model" in parsed)) throw new Error(`fixture must parse: ${parsed.error}`);
  return parsed.model;
}

function binding(policy: DataBinding["policy"], ...vars: string[]): DataBinding {
  return {
    dataset_id: "D1",
    policy,
    mappings: vars.map((v) => ({ kind: "column" as const, var: v, column: v })),
  };
}

const BASE = {
  loadModel: "closed" as const,
  rateMode: "fixed" as const,
  vus: 20,
  rampUpSeconds: 3,
  vuPeak: null,
  maxInFlight: null,
  bindings: [] as DataBinding[],
};

describe("SetupNotices", () => {
  it("문구가 글자 그대로 나온다", () => {
    const { rerender } = render(
      <SetupNotices {...BASE} scenario={model("http://x/login", "http://x/o")} rampUpSeconds={0} />,
    );
    expect(screen.getByText("준비 스텝 안내")).toBeInTheDocument();
    expect(
      screen.getByText(
        "준비 스텝이 VU 수만큼 한꺼번에 나갑니다. 상승 시간을 두면 나눠서 나갑니다.",
      ),
    ).toBeInTheDocument();

    rerender(
      <SetupNotices
        {...BASE}
        scenario={model("http://x/login", "http://x/o")}
        loadModel="open"
        maxInFlight={30}
      />,
    );
    const slot = screen.getByRole("listitem");
    expect(slot.textContent).toContain("30개");
    expect(slot.textContent).toContain("30번");

    rerender(
      <SetupNotices
        {...BASE}
        scenario={model("http://x/{{user}}", "http://x/o")}
        loadModel="open"
        maxInFlight={8}
        bindings={[binding("per_vu", "user")]}
      />,
    );
    const shared = screen.getAllByRole("listitem")[1];
    expect(shared.textContent).toContain("슬롯 8개가 나눠");
    expect(shared.textContent).toContain("그 행을 받은 슬롯이 모두");

    rerender(
      <SetupNotices
        {...BASE}
        scenario={model("http://x/{{user}}/{{pw}}", "http://x/o")}
        bindings={[binding("iter_sequential", "user", "pw")]}
      />,
    );
    const text = screen.getByRole("listitem").textContent ?? "";
    expect(text).toContain("`user`, `pw` 값이 VU마다 고정돼야 한다면 ");
    expect(text).toContain("'per_vu — VU마다 한 행 (고정)'으로 두세요");
  });

  it("안내가 없으면 아무것도 그리지 않는다", () => {
    const { container } = render(
      <SetupNotices {...BASE} scenario={model("http://x/login", "http://x/o")} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe("NoMainStepsWarning", () => {
  it("본 스텝이 없으면 경고 상자가 나온다", () => {
    const { container, rerender } = render(
      <NoMainStepsWarning scenario={model("http://x/login", null)} />,
    );
    expect(
      screen.getByText("본 스텝이 없습니다. 준비 스텝만 한 번 실행하고 run이 끝납니다."),
    ).toBeInTheDocument();

    rerender(<NoMainStepsWarning scenario={model(null, null)} />);
    expect(
      screen.getByText("본 스텝이 없습니다. 보낼 요청이 없어 run이 바로 끝납니다."),
    ).toBeInTheDocument();

    rerender(<NoMainStepsWarning scenario={model("http://x/login", "http://x/o")} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<NoMainStepsWarning scenario={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
