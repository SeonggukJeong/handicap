import { describe, expect, it } from "vitest";
import { partsText } from "../../i18n/lineParts";
import type { ReportSetup } from "../../api/schemas";
import type { StepFacts } from "../scenarioFacts";
import { buildSetupModel } from "../setupTable";

type StepIn = Partial<ReportSetup["steps"][number]> & { step_id: string };

const step = (o: StepIn): ReportSetup["steps"][number] => ({
  count: 50,
  errors: 0,
  p50_ms: 84,
  p95_ms: 120,
  max_ms: 163,
  status_counts: { "200": 50 },
  failure_kinds: {},
  ...o,
});

const setupOf = (
  ok: number,
  failed: number,
  interrupted: number,
  steps: StepIn[] = [],
): ReportSetup => ({ ok, failed, interrupted, steps: steps.map(step) });

const facts = (id: string, name: string, method = "POST", url = "/api/x"): StepFacts => ({
  id,
  name,
  method,
  url,
  statusCodes: [],
  fallibleExtract: false,
});

const TAIL_CLOSED =
  "준비 스텝은 사용자마다 한 번 실행하며, 위 단계별 결과와 요약 숫자에는 들어가지 않습니다.";
const TAIL_OPEN =
  "준비 스텝은 슬롯마다 한 번 실행하며, 위 단계별 결과와 요약 숫자에는 들어가지 않습니다.";

const lead = (s: ReportSetup, open = false) => buildSetupModel({ setup: s, facts: [], open }).lead;

describe("buildSetupModel 요약 줄", () => {
  it("성공만(closed)", () => {
    const l = lead(setupOf(50, 0, 0));
    expect(partsText(l)).toBe(`가상 사용자 50명이 모두 준비를 마쳤습니다. ${TAIL_CLOSED}`);
    expect(l).toContainEqual({ text: "50명", strong: true });
  });

  it("중단만", () => {
    const l = lead(setupOf(48, 0, 2));
    expect(partsText(l)).toBe(
      `가상 사용자 50명 중 48명이 준비를 마쳤습니다. 2명은 준비 도중 측정이 끝났습니다. ${TAIL_CLOSED}`,
    );
    expect(l).toContainEqual({ text: "48명", strong: true });
  });

  it("실패", () => {
    const l = lead(setupOf(47, 3, 0));
    expect(partsText(l)).toBe(
      `가상 사용자 50명 중 47명이 준비를 마쳤고 3명이 실패했습니다. 실패한 사용자는 본 스텝을 실행하지 않았습니다. ${TAIL_CLOSED}`,
    );
    expect(l).toContainEqual({ text: "47명", strong: true });
    expect(l).toContainEqual({ text: "3명이 실패", strong: true, tone: "bad" });
  });

  it("실패 + 중단", () => {
    expect(partsText(lead(setupOf(45, 3, 2)))).toBe(
      `가상 사용자 50명 중 45명이 준비를 마쳤고 3명이 실패했습니다. 실패한 사용자는 본 스텝을 실행하지 않았습니다. 2명은 준비 도중 측정이 끝났습니다. ${TAIL_CLOSED}`,
    );
  });

  it("open-loop 실패", () => {
    const l = lead(setupOf(180, 20, 0), true);
    expect(partsText(l)).toBe(
      `슬롯 200개 중 180개가 준비를 마쳤고 20개가 실패했습니다. 실패한 슬롯은 run에서 빠졌습니다. ${TAIL_OPEN}`,
    );
    expect(l).toContainEqual({ text: "180개", strong: true });
    expect(l).toContainEqual({ text: "20개가 실패", strong: true, tone: "bad" });
  });

  it("open-loop 성공만", () => {
    expect(partsText(lead(setupOf(200, 0, 0), true))).toBe(
      `슬롯 200개가 모두 준비를 마쳤습니다. ${TAIL_OPEN}`,
    );
  });

  it("큰 수는 천 단위 구분", () => {
    expect(partsText(lead(setupOf(123456, 0, 0)))).toContain("123,456");
  });
});

describe("buildSetupModel 행", () => {
  it("이름·요청 줄은 facts에서, 없는 id는 step_id와 null", () => {
    const m = buildSetupModel({
      setup: setupOf(50, 0, 0, [{ step_id: "A" }, { step_id: "B" }]),
      facts: [facts("A", "로그인")],
      open: false,
    });
    expect(m.rows[0]).toMatchObject({ stepId: "A", no: 1, name: "로그인" });
    expect(m.rows[0].requestLine).toBe("POST /api/x");
    expect(m.rows[1]).toMatchObject({ stepId: "B", no: 2, name: "B", requestLine: null });
  });

  it("count 0이면 응답 시간 셋이 null", () => {
    const m = buildSetupModel({
      setup: setupOf(1, 0, 0, [{ step_id: "A", count: 0, p50_ms: 0, p95_ms: 0, max_ms: 0 }]),
      facts: [],
      open: false,
    });
    expect(m.rows[0]).toMatchObject({ p50Ms: null, p95Ms: null, maxMs: null });
  });

  it("코드는 오름차순이고 0은 「응답 없음」", () => {
    const m = buildSetupModel({
      setup: setupOf(47, 3, 0, [{ step_id: "A", status_counts: { "503": 2, "200": 47, "0": 1 } }]),
      facts: [],
      open: false,
    });
    expect(m.rows[0].codes).toEqual([
      { label: "응답 없음", count: 1 },
      { label: "200", count: 47 },
      { label: "503", count: 2 },
    ]);
  });
});

describe("buildSetupModel 실패 종류 줄", () => {
  it("스텝을 합산하고 종류 글자 오름차순", () => {
    const m = buildSetupModel({
      setup: setupOf(47, 3, 0, [
        { step_id: "A", failure_kinds: { status_assert: 2 } },
        { step_id: "B", failure_kinds: { connect_timeout: 1, status_assert: 1 } },
      ]),
      facts: [],
      open: false,
    });
    expect(m.kindsLine).toBe("실패 종류: 연결 수립 타임아웃 1 · 상태 코드 검증 실패 3");
  });

  it("카탈로그에 없는 글자는 그대로", () => {
    const m = buildSetupModel({
      setup: setupOf(1, 1, 0, [{ step_id: "A", failure_kinds: { constructor: 1, zzz_new: 2 } }]),
      facts: [],
      open: false,
    });
    expect(m.kindsLine).toBe("실패 종류: constructor 1 · zzz_new 2");
  });

  it("종류가 없으면 null", () => {
    const m = buildSetupModel({
      setup: setupOf(50, 0, 0, [{ step_id: "A" }]),
      facts: [],
      open: false,
    });
    expect(m.kindsLine).toBeNull();
  });
});
