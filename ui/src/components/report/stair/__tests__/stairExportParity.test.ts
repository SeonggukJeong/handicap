import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import nodePath from "node:path";
import { StairReportSchema, type StairReport } from "../../../../api/schemas";
import {
  headlineText,
  noteTexts,
  reasonTexts,
  stopLineText,
  suspendedLineText,
} from "../stairFormat";

// 화면 문구(`stairFormat.ts`) ↔ 내보내기(CSV·XLSX, `export.rs`) 글자 일치.
// 기대값은 Rust 테스트 `stair_export_text_matches_golden`이 같은 골든 계단 run에서 만든 파일이다.
// 변형의 수정 내용은 Rust `export_text_golden`과 똑같이 맞춘다.
const read = (name: string) =>
  JSON.parse(
    readFileSync(nodePath.resolve(__dirname, `../../../../../../testdata/${name}`), "utf8"),
  );
const golden = StairReportSchema.parse(read("stair_report_golden.json"));
const want = read("stair_export_text_golden.json") as {
  headline_lines: string[];
  headline_lines_variant: string[];
  reasons: string[];
  reasons_all_kinds: string;
  reasons_fast_ref: string;
};

const exportLines = (st: StairReport) => [...headlineText(st), ...noteTexts(st)];
const reasonLine = (st: StairReport, i: number) => reasonTexts(st, st.steps[i]).join(" · ");

describe("계단 화면 ↔ 내보내기 문구 일치", () => {
  it("머리말 줄들", () => {
    expect(exportLines(golden)).toEqual(want.headline_lines);
  });

  it("머리말 변형: 힌트 줄·max_in_flight 없음·안내 줄 둘", () => {
    const st = structuredClone(golden);
    st.notes = { t0_estimated: true, open_loop_unknown: true };
    st.max_in_flight = null;
    st.headline = {
      ...st.headline,
      saturated_target: 100,
      last_ok_target: null,
      first_fail_hint: true,
    };
    expect(exportLines(st)).toEqual(want.headline_lines_variant);
  });

  it("계단별 사유 — 슬롯 부족·달성 94.96% 계단 포함", () => {
    expect(golden.steps.map((_, i) => reasonLine(golden, i))).toEqual(want.reasons);
    expect(want.reasons[6]).toBe("달성 94.9% · 슬롯 부족 의심");
  });

  it("사유 다섯 종류 + 슬롯 부족 (2.25× 반올림 포함)", () => {
    const st = structuredClone(golden);
    st.steps[5] = {
      ...st.steps[5],
      reasons: [
        { kind: "achieved", value: 0.9496 },
        { kind: "dropped", value: 1234 },
        { kind: "errors", value: 0.0234 },
        { kind: "p99_cap", value: 25 },
        { kind: "p99_relative", value: 2.25 },
      ],
      slot_limited: true,
    };
    expect(reasonLine(st, 5)).toBe(want.reasons_all_kinds);
  });

  it("기준 계단 p99 1 ms 미만이면 절대 기준 문구", () => {
    const st = structuredClone(golden);
    st.steps[4] = { ...st.steps[4], p99_us: 900 };
    expect(reasonLine(st, 5)).toBe(want.reasons_fast_ref);
  });
});

// ---- 자동 정지 줄 (Rust `export.rs` stop_line_* 테스트와 같은 합성 10계단) ----
type StepState = StairReport["steps"][number]["state"];
type Phase = "ramp" | "discard" | "measure";
const stopGolden = read("stair_stop_line_golden.json") as Record<string, string>;

function autoReport(
  states: StepState[],
  lastOk: number | null,
  stop: NonNullable<StairReport["auto_stop"]>["stop"],
): StairReport {
  const st = structuredClone(golden);
  st.steps = states.map((state, i) => ({
    ...golden.steps[0],
    index: i,
    target: 100 * (i + 1),
    state,
    reasons: [],
    slot_limited: false,
    partial: undefined,
  }));
  st.headline = { ...st.headline, last_ok_target: lastOk };
  st.auto_stop = { stop, suspended_seconds: 0 };
  return st;
}
function satInfo(mode: "two_fails" | "first_fail", failed: number[], slot = false) {
  return {
    kind: "saturation" as const,
    mode,
    failed_steps: failed,
    decided_step: failed[failed.length - 1],
    judged_through: failed[failed.length - 1],
    phase: null,
    decided_at_ms: 1_700_000_000_000,
    stopped_at_ms: 1_700_000_001_000,
    emergency: null,
    slot_limited: slot,
  };
}
function withPartial(st: StairReport, i: number, seconds: number, phase: Phase) {
  st.steps[i].partial = { seconds, phase };
  return st;
}
const ok10 = (over: Record<number, StepState>): StepState[] =>
  Array.from({ length: 10 }, (_, i) => over[i] ?? "ok");
function twoFails() {
  return withPartial(
    autoReport(
      ok10({ 6: "saturated", 7: "saturated", 8: "partial", 9: "skipped" }),
      600,
      satInfo("two_fails", [6, 7]),
    ),
    8,
    2,
    "ramp",
  );
}
function firstFail() {
  return withPartial(
    autoReport(
      ok10({ 6: "saturated", 7: "partial", 8: "skipped", 9: "skipped" }),
      600,
      satInfo("first_fail", [6]),
    ),
    7,
    1,
    "ramp",
  );
}
function emergency() {
  const states = ok10({ 4: "emergency_stopped" }).map((s, i) =>
    i > 4 ? "skipped" : s,
  ) as StepState[];
  return autoReport(states, 400, {
    kind: "emergency",
    mode: null,
    failed_steps: [],
    decided_step: 4,
    judged_through: 3,
    phase: "ramp",
    decided_at_ms: 1_700_000_000_000,
    stopped_at_ms: 1_700_000_001_000,
    emergency: {
      max_error_rate: 0.12,
      max_p99_us: 100_000,
      seconds: 3,
      error_hit: true,
      p99_hit: false,
    },
    slot_limited: false,
  });
}

describe("정지 줄 ↔ Rust 골든", () => {
  it("stop line matches Rust golden", () => {
    expect(stopLineText(twoFails(), "TIME")).toBe(stopGolden.two_fails);
    expect(stopLineText(firstFail(), "TIME")).toBe(stopGolden.first_fail);
    expect(stopLineText(emergency(), "TIME")).toBe(stopGolden.emergency);
  });

  it("구간별 일부 실행 문구 (줄·행)", () => {
    let st = withPartial(twoFails(), 8, 7, "discard");
    expect(stopLineText(st, "T")).toContain(" · 9계단 시작 7초 뒤(버림 중) 멈춤 · ");
    expect(reasonTexts(st, st.steps[8])).toEqual(["일부 실행 — 계단 시작 7초 뒤(버림 중) 정지"]);
    st = withPartial(twoFails(), 8, 12, "measure");
    expect(stopLineText(st, "T")).toContain(" · 9계단 시작 12초 뒤(측정 중) 멈춤 · ");
    expect(reasonTexts(st, st.steps[8])).toEqual(["일부 실행 — 계단 시작 12초 뒤(측정 중) 정지"]);
    st = twoFails();
    expect(reasonTexts(st, st.steps[8])).toEqual(["일부 실행 — 상승 2초 진입 후 정지"]);
  });

  it("일부 실행 행이 둘이면 구절이 각각 붙는다", () => {
    const st = twoFails();
    st.steps[9].state = "partial";
    st.steps[9].partial = { seconds: 1, phase: "ramp" };
    const line = stopLineText(st, "T")!;
    expect(line).toContain(" · 9계단 상승 2초 진입 후 멈춤 · 10계단 상승 1초 진입 후 멈춤 · T");
    expect(line).not.toContain("실행 안 함");
  });

  it("슬롯 부족 의심 꼬리", () => {
    const st = twoFails();
    st.auto_stop = { stop: satInfo("two_fails", [6, 7], true), suspended_seconds: 0 };
    expect(stopLineText(st, "T")).toContain(
      "7·8계단 연속 실패 (슬롯 부족 의심 — 부하기 한계일 수 있음) · 9계단",
    );
  });

  it("일부 실행 없음·마지막 정상 없음·p99 단독", () => {
    const st = twoFails();
    st.steps[8].state = "skipped";
    st.steps[8].partial = undefined;
    expect(stopLineText(st, "T")).toBe(
      "8계단(800 req/s) 판정 뒤 자동 정지 — 7·8계단 연속 실패 · 9–10계단 실행 안 함 · T",
    );
    const e = emergency();
    e.headline.last_ok_target = null;
    expect(stopLineText(e, "T")).toContain(" · 정상 계단 없음 · ");
    const p = emergency();
    p.auto_stop = {
      stop: {
        ...p.auto_stop!.stop!,
        phase: "measure",
        emergency: {
          max_error_rate: 0,
          max_p99_us: 2_500_000,
          seconds: 3,
          error_hit: false,
          p99_hit: true,
        },
      },
      suspended_seconds: 0,
    };
    expect(stopLineText(p, "T")).toContain(
      "5계단(500 req/s) 측정 중 즉시 정지 — p99 2500 ms 3초 연속 · 마지막 정상",
    );
    // 기록상 불가능한 (false,false)도 Rust와 같은 글자(p99 꼴).
    const n = emergency();
    n.auto_stop = {
      stop: {
        ...n.auto_stop!.stop!,
        phase: "measure",
        emergency: {
          max_error_rate: 0,
          max_p99_us: 2_500_000,
          seconds: 3,
          error_hit: false,
          p99_hit: false,
        },
      },
      suspended_seconds: 0,
    };
    expect(stopLineText(n, "T")).toContain(
      "5계단(500 req/s) 측정 중 즉시 정지 — p99 2500 ms 3초 연속 · 마지막 정상",
    );
  });

  it("보류만 있으면 회색 줄 글자, 기록 없으면 둘 다 없음", () => {
    const st = twoFails();
    st.auto_stop = { stop: null, suspended_seconds: 4 };
    expect(stopLineText(st, "T")).toBeNull();
    expect(suspendedLineText(st)).toBe(
      "자동 정지 감시가 4초 보류됐습니다(부하기 등록·데이터 지연) — 그동안 즉시 정지는 동작하지 않았습니다",
    );
    st.auto_stop = { stop: null, suspended_seconds: 0 };
    expect(suspendedLineText(st)).toBeNull();
    expect(stopLineText(golden, "T")).toBeNull();
    expect(suspendedLineText(golden)).toBeNull();
  });

  it("즉시 정지·실행 안 함 행 문구", () => {
    const e = emergency();
    expect(reasonTexts(e, e.steps[4])).toEqual(["즉시 정지"]);
    expect(reasonTexts(e, e.steps[5])).toEqual(["실행 안 함"]);
  });
});
