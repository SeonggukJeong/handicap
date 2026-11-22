import { describe, expect, it } from "vitest";
import type { DataBinding } from "../../../api/schemas";
import { parseScenarioDoc } from "../../../scenario/yamlDoc";
import type { Scenario } from "../../../scenario/model";
import { loadFieldsForNotices, setupNotices, type SetupNoticeInput } from "../setupNoticeRules";

describe("loadFieldsForNotices 목표 곡선", () => {
  const f = (targets: string[]) =>
    loadFieldsForNotices({
      loadModel: "closed",
      rateMode: "curve",
      vus: 10,
      rampUp: 0,
      stages: targets.map((target) => ({ target })),
      maxInFlight: "",
    });
  it("빈 목표만 있으면 vuPeak은 null이다", () => {
    expect(f(["", "  "]).vuPeak).toBeNull();
    expect(f([]).vuPeak).toBeNull();
  });
  it("빈 목표는 건너뛰고 최댓값을 잡는다", () => {
    expect(f(["", "50"]).vuPeak).toBe(50);
  });
});

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

function input(over: Partial<SetupNoticeInput>): SetupNoticeInput {
  return {
    scenario: model("http://x/login", "http://x/orders"),
    loadModel: "closed",
    rateMode: "fixed",
    vus: 20,
    rampUpSeconds: 3,
    vuPeak: null,
    maxInFlight: null,
    bindings: [],
    rowCounts: {},
    ...over,
  };
}

describe("setupNotices", () => {
  it("준비 스텝이 없으면 안내가 없다", () => {
    const all = {
      loadModel: "open" as const,
      rampUpSeconds: 0,
      maxInFlight: 30,
      bindings: [binding("per_vu", "user"), binding("iter_sequential", "pw")],
      rowCounts: { D1: 1 },
    };
    expect(setupNotices(input({ ...all, scenario: model(null, "http://x/{{user}}") }))).toEqual([]);
    expect(setupNotices(input({ ...all, scenario: null }))).toEqual([]);
  });

  it("VU 고정에 상승 시간 0이면 burst", () => {
    expect(setupNotices(input({ rampUpSeconds: 0 }))).toEqual([{ kind: "burst" }]);
    expect(setupNotices(input({ rampUpSeconds: 5 }))).toEqual([]);
    const curve = setupNotices(
      input({ rateMode: "curve", rampUpSeconds: 0, vus: null, vuPeak: 50 }),
    );
    expect(curve.map((n) => n.kind)).not.toContain("burst");
  });

  it("open-loop이면 슬롯 수 안내", () => {
    expect(setupNotices(input({ loadModel: "open", maxInFlight: 30 }))).toEqual([
      { kind: "per_slot", slots: 30 },
    ]);
    expect(setupNotices(input({ loadModel: "open", maxInFlight: null }))).toEqual([]);
    expect(
      setupNotices(
        input({ loadModel: "open", rateMode: "stair", rampUpSeconds: 0, maxInFlight: 30 }),
      ),
    ).toEqual([{ kind: "per_slot", slots: 30 }]);
  });

  it("준비 스텝이 쓰는 per_vu 데이터의 행이 VU보다 적으면 shared_rows", () => {
    const base = {
      scenario: model("http://x/{{user}}", "http://x/orders"),
      bindings: [binding("per_vu", "user")],
    };
    expect(setupNotices(input({ ...base, rowCounts: { D1: 5 } }))).toEqual([
      { kind: "shared_rows", rows: 5, units: 20, unit: "vu" },
    ]);
    expect(setupNotices(input({ ...base, rowCounts: { D1: 20 } }))).toEqual([]);
    expect(setupNotices(input({ ...base, rowCounts: {} }))).toEqual([]);
  });

  it("준비 스텝이 안 쓰는 변수만 대는 per_vu 바인딩은 세지 않는다", () => {
    expect(
      setupNotices(
        input({
          scenario: model("http://x/{{user}}", "http://x/orders"),
          bindings: [binding("per_vu", "other")],
          rowCounts: { D1: 5 },
        }),
      ),
    ).toEqual([]);
  });

  it("VU 곡선은 최고점, open-loop은 슬롯 수와 비교한다", () => {
    const scenario = model("http://x/{{user}}", "http://x/orders");
    const bindings = [binding("per_vu", "user")];
    expect(
      setupNotices(
        input({
          scenario,
          bindings,
          rateMode: "curve",
          vus: null,
          vuPeak: 50,
          rowCounts: { D1: 10 },
        }),
      ),
    ).toEqual([{ kind: "shared_rows", rows: 10, units: 50, unit: "vu" }]);
    expect(
      setupNotices(
        input({ scenario, bindings, loadModel: "open", maxInFlight: 8, rowCounts: { D1: 5 } }),
      ),
    ).toEqual([
      { kind: "per_slot", slots: 8 },
      { kind: "shared_rows", rows: 5, units: 8, unit: "slot" },
    ]);
  });

  it("per_vu가 아닌 바인딩의 변수를 준비 스텝이 쓰면 not_per_vu", () => {
    const bindings = [binding("iter_sequential", "user", "pw")];
    expect(
      setupNotices(
        input({ scenario: model("http://x/{{user}}/{{pw}}", "http://x/orders"), bindings }),
      ),
    ).toEqual([{ kind: "not_per_vu", vars: ["user", "pw"] }]);
    expect(setupNotices(input({ bindings }))).toEqual([]);
  });

  it("본 스텝만 쓰는 변수는 준비가 쓰는 것으로 보지 않는다", () => {
    expect(
      setupNotices(
        input({
          scenario: model("http://x/login", "http://x/{{user}}"),
          bindings: [binding("iter_sequential", "user"), binding("per_vu", "user")],
          rowCounts: { D1: 1 },
        }),
      ),
    ).toEqual([]);
  });

  it("순서는 burst → per_slot → shared_rows → not_per_vu", () => {
    const scenario = model("http://x/{{user}}/{{pw}}", "http://x/orders");
    const bindings = [
      { ...binding("per_vu", "user"), dataset_id: "D1" },
      { ...binding("iter_random", "pw"), dataset_id: "D2" },
    ];
    // closed 고정: burst, shared_rows, not_per_vu
    const closed = setupNotices(
      input({ scenario, bindings, rampUpSeconds: 0, rowCounts: { D1: 5 } }),
    ).map((n) => n.kind);
    expect(closed).toEqual(["burst", "shared_rows", "not_per_vu"]);
    // open: per_slot, shared_rows, not_per_vu
    const open = setupNotices(
      input({ scenario, bindings, loadModel: "open", maxInFlight: 8, rowCounts: { D1: 5 } }),
    ).map((n) => n.kind);
    expect(open).toEqual(["per_slot", "shared_rows", "not_per_vu"]);
  });
});
