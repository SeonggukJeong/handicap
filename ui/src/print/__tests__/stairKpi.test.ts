import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import nodePath from "node:path";
import { StairReportSchema, type StairReport } from "../../api/schemas";
import { stairKpiCards } from "../stairKpi";

const golden = StairReportSchema.parse(
  JSON.parse(
    readFileSync(
      nodePath.resolve(__dirname, "../../../../testdata/stair_report_golden.json"),
      "utf8",
    ),
  ),
);
const mk = (): StairReport => structuredClone(golden);

describe("stairKpiCards (stair-feedback §B101 c)", () => {
  it("포화 run: 마지막 정상 계단의 값 3칸 + 포화 시작 칸", () => {
    const cards = stairKpiCards(mk())!;
    expect(cards.map((c) => [c.label, c.value, c.unit, c.bad])).toEqual([
      ["마지막 정상 계단", "500", "iter/s", false],
      ["그 계단의 처리량", "500", "req/s", false],
      ["그 계단의 95% 응답 시간", "8", "ms", false],
      ["포화 시작", "600", "iter/s", true],
    ]);
    expect(cards[0].target).toBe("5번째 계단 · 달성 500 iter/s");
    expect(cards[1].target).toBe("오류율 0.0%");
    expect(cards[2].target).toBe("p99 8 ms");
    expect(cards[3].target).toBe("달성 25.0% · dropped 8,500 · p99 12.5×");
  });

  it("값은 전체 평균이 아니라 그 계단 행에서 온다", () => {
    const st = mk();
    st.steps[4] = { ...st.steps[4], throughput_rps: 432.1, p95_us: 77_000, error_rate: 0.012 };
    const cards = stairKpiCards(st)!;
    expect(cards[1].value).toBe("432.1");
    expect(cards[2].value).toBe("77");
    expect(cards[1].target).toBe("오류율 1.2%");
  });

  it("정상 계단이 없으면 「없음」과 「–」", () => {
    const st = mk();
    st.headline = { ...st.headline, last_ok_target: null };
    const cards = stairKpiCards(st)!;
    expect(cards.slice(0, 3).map((c) => c.value)).toEqual(["없음", "–", "–"]);
    expect(cards[0].unit).toBe("");
  });

  it("모든 계단 정상: 포화 칸은 「못 찾음」, 빨강 아님", () => {
    const st = mk();
    st.headline = {
      ...st.headline,
      kind: "all_ok",
      saturated_target: null,
      last_ok_target: null,
      through_target: 500,
    };
    const cards = stairKpiCards(st)!;
    expect(cards[0].value).toBe("500");
    expect([cards[3].value, cards[3].bad]).toEqual(["못 찾음", false]);
  });

  it("포화 의심은 이름이 다르고 빨강 아님", () => {
    const st = mk();
    st.headline = { ...st.headline, kind: "unconfirmed" };
    const c = stairKpiCards(st)![3];
    expect([c.label, c.value, c.bad]).toEqual(["포화 의심", "600", false]);
  });

  it("응답 시간 표본이 없는 계단(p99 0)은 「–」", () => {
    const st = mk();
    st.steps[4] = { ...st.steps[4], p50_us: 0, p95_us: 0, p99_us: 0 };
    const c = stairKpiCards(st)![2];
    expect([c.value, c.unit, c.target]).toEqual(["–", "", "–"]);
  });

  it("판정할 계단이 없으면 null(기존 칸 유지)", () => {
    const st = mk();
    st.headline = { ...st.headline, kind: "no_data" };
    expect(stairKpiCards(st)).toBeNull();
  });
});
