import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { ReportSchema, type Report } from "../../../api/schemas";
import { buildOverlay } from "../overlay";
import { OverlayChart } from "../components/OverlayChart";
import { buildRunModel, type RunModel } from "../runModel";
import { mkMeta, mkReport, scenarioYaml } from "./fixtures";

const T0_SEC = 1_700_000_000;
type W = Report["windows"][number];
const win = (sec: number, count: number, err: number): W => ({
  ts_second: T0_SEC + sec,
  step_id: "s1",
  count,
  error_count: err,
  status_counts: {},
  p50_ms: 0,
  p95_ms: 0,
  p99_ms: 0,
});
function run(id: string, windows: W[]): RunModel {
  const report = {
    ...mkReport({
      id,
      steps: [{ id: "s1", counts: { "200": 10 }, errors: 0 }],
      yaml: scenarioYaml([{ id: "s1", name: "접수" }]),
    }),
    windows,
  };
  expect(ReportSchema.safeParse(report).success).toBe(true);
  return buildRunModel(mkMeta(id), report);
}
const secs = (n: number, count: number, errFrom = Infinity, err = 0): W[] =>
  Array.from({ length: n }, (_, i) => win(i, count, i >= errFrom ? err : 0));

describe("OverlayChart", () => {
  it("오류가 있으면 선 2개(이전은 점선) · 빗금 무늬 1개 · 막대는 높이 > 0인 만큼", () => {
    const m = buildOverlay(run("b", secs(10, 100, 5, 10)), run("a", secs(10, 100, 7, 4)), false);
    const { container } = render(<OverlayChart model={m} />);
    const lines = container.querySelectorAll("polyline");
    expect(lines).toHaveLength(2);
    expect([...lines].filter((l) => l.hasAttribute("stroke-dasharray"))).toHaveLength(1);
    expect(container.querySelectorAll("pattern")).toHaveLength(1);
    const bars = container.querySelectorAll("rect.p-cmp-ov-bar");
    const want =
      m.before.bins.filter((b) => b.err > 0).length + m.after.bins.filter((b) => b.err > 0).length;
    expect(want).toBe(5 + 3);
    expect(bars).toHaveLength(want);
    const hatched = [...bars].filter((r) => r.getAttribute("fill") === "url(#p-cmp-ov-hatch)");
    expect(hatched).toHaveLength(5);
    expect(container.querySelector("svg")?.getAttribute("width")).toBe("100%");
    expect(container.querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 180 55");
    expect(container.querySelector("svg")?.getAttribute("aria-label")).toBe(
      "이전·이후 처리량과 오류를 시간 순서로 겹쳐 그린 그래프",
    );
    expect(container.innerHTML).not.toContain("NaN");
  });

  it("오류가 없으면 막대 없음 · 「두 측정 모두 오류 없음」", () => {
    const m = buildOverlay(run("b", secs(10, 100)), run("a", secs(10, 100)), false);
    const { container } = render(<OverlayChart model={m} />);
    expect(container.querySelectorAll("rect.p-cmp-ov-bar")).toHaveLength(0);
    expect(container.textContent).toContain("두 측정 모두 오류 없음");
    expect(container.textContent).toContain("두 측정 모두 오류가 없었습니다.");
    expect(container.innerHTML).not.toContain("NaN");
  });

  it("둘 다 빈 모델이면 선 0개 · NaN 없음", () => {
    const m = buildOverlay(run("b", []), run("a", []), true);
    const { container } = render(<OverlayChart model={m} />);
    expect(container.querySelectorAll("polyline")).toHaveLength(0);
    expect(container.innerHTML).not.toContain("NaN");
    expect(container.innerHTML).not.toContain("Infinity");
    expect(container.textContent).toContain(
      "요청이 실행되지 않은 측정이 있어 비교하지 않았습니다.",
    );
  });

  it("한쪽만 빈 모델이면 있는 쪽 선만 그린다", () => {
    const m = buildOverlay(run("b", secs(10, 100, 5, 10)), run("a", []), true);
    const { container } = render(<OverlayChart model={m} />);
    expect(container.querySelectorAll("polyline")).toHaveLength(1);
    expect(container.innerHTML).not.toContain("NaN");
  });

  it("범례: 선 모양·빗금 견본과 글자, 기간 글", () => {
    const m = buildOverlay(run("b", secs(60, 10, 30, 2)), run("a", secs(1800, 10)), false);
    const { container } = render(<OverlayChart model={m} />);
    const text = container.textContent ?? "";
    for (const t of ["이전 처리량", "이후 처리량", "이전 오류(건/초)", "이후 오류(건/초)"]) {
      expect(text).toContain(t);
    }
    expect(text).toContain("(측정 시간이 다릅니다: 이전 1분, 이후 30분)");
  });
});
