import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import nodePath from "node:path";
import { StairReportSchema, type StairReport } from "../../../../api/schemas";
import { headlineText, noteTexts, reasonTexts } from "../stairFormat";

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
