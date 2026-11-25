import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CriteriaFields } from "../CriteriaFields";
import { EMPTY_CRITERIA, NEW_PERCENTILE_ROW, type CriteriaErrors } from "../profileForm";
import { ko } from "../../../i18n/ko";

const noErrors: CriteriaErrors = { percentiles: [], steps: [] };

function setup(
  over: Partial<typeof EMPTY_CRITERIA> = {},
  errors: CriteriaErrors = noErrors,
  handlers: { onChange?: () => void; onPercentilesChange?: (r: unknown) => void } = {},
) {
  return render(
    <CriteriaFields
      value={{ ...EMPTY_CRITERIA, ...over }}
      errors={errors}
      onChange={handlers.onChange ?? vi.fn()}
      onPercentilesChange={handlers.onPercentilesChange ?? vi.fn()}
    />,
  );
}

describe("CriteriaFields — 새 판정 항목", () => {
  it("평균·최대 칸이 최대 p50 앞에 있고 평균 도움말이 격자 뒤에 있다", () => {
    setup();
    const mean = screen.getByLabelText("평균 응답 시간(ms)");
    const max = screen.getByLabelText("최대 응답 시간(ms)");
    const p50 = screen.getByLabelText("최대 p50(ms)");
    const help = screen.getByText(ko.criteria.meanHelp);
    const before = (a: Node, b: Node) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(before(mean, max)).toBe(true);
    expect(before(max, p50)).toBe(true);
    expect(before(p50, help)).toBe(true);
    expect(ko.criteria.meanHelp).toBe(
      "평균은 느린 응답 몇 건이 있어도 낮게 나올 수 있습니다. 대부분의 사용자가 겪는 속도를 보려면 p95를 함께 거세요.",
    );
  });

  it("+ 백분위 기준 추가는 새 행을 만든다", async () => {
    const user = userEvent.setup();
    const onP = vi.fn();
    setup({}, noErrors, { onPercentilesChange: onP });
    await user.click(screen.getByRole("button", { name: "+ 백분위 기준 추가" }));
    expect(onP).toHaveBeenCalledWith([NEW_PERCENTILE_ROW]);
  });

  it("행: 백분위·기준 칸과 삭제 단추, 삭제는 그 행을 뺀다", async () => {
    const user = userEvent.setup();
    const onP = vi.fn();
    const rows = [
      { p: "90", ms: "2500" },
      { p: "99.9", ms: "8000" },
    ];
    setup({ percentiles: rows }, noErrors, { onPercentilesChange: onP });
    expect(screen.getByLabelText("백분위 1")).toHaveValue(90);
    expect(screen.getByLabelText("기준 1")).toHaveValue(2500);
    expect(screen.getByLabelText("백분위 2")).toHaveValue(99.9);
    await user.click(screen.getByRole("button", { name: "백분위 기준 1 삭제" }));
    expect(onP).toHaveBeenCalledWith([rows[1]]);
  });

  it("행이 10개면 추가 단추가 막히고 이유가 보인다", () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ p: String(i + 1), ms: "" }));
    setup({ percentiles: rows });
    expect(screen.getByRole("button", { name: "+ 백분위 기준 추가" })).toBeDisabled();
    expect(screen.getByText(ko.criteria.maxRowsHint)).toBeInTheDocument();
  });

  it("9개면 추가 단추가 살아 있다", () => {
    const rows = Array.from({ length: 9 }, (_, i) => ({ p: String(i + 1), ms: "" }));
    setup({ percentiles: rows });
    expect(screen.getByRole("button", { name: "+ 백분위 기준 추가" })).toBeEnabled();
    expect(screen.queryByText(ko.criteria.maxRowsHint)).not.toBeInTheDocument();
  });

  it("평균 오류는 글자·aria-invalid·aria-describedby로 이어진다", () => {
    setup({ maxMean: "70000" }, { ...noErrors, maxMean: ko.criteria.errTime });
    const input = screen.getByLabelText("평균 응답 시간(ms)");
    expect(input).toHaveAttribute("aria-invalid", "true");
    const msg = screen.getByText(ko.criteria.errTime);
    expect(input.getAttribute("aria-describedby")).toBe(msg.id);
    expect(screen.getByLabelText("최대 응답 시간(ms)")).not.toHaveAttribute("aria-invalid");
  });

  it("행 오류(백분위·기준)와 목록 오류가 각각 보인다", () => {
    setup(
      {
        percentiles: [
          { p: "95", ms: "1" },
          { p: "90", ms: "-1" },
        ],
      },
      {
        percentiles: [{ p: ko.criteria.errPercentileFixed("95") }, { ms: ko.criteria.errTime }],
        percentilesList: ko.criteria.errPercentilesMax,
        steps: [],
      },
    );
    expect(screen.getByText(ko.criteria.errPercentileFixed("95"))).toBeInTheDocument();
    expect(screen.getByText(ko.criteria.errTime)).toBeInTheDocument();
    expect(screen.getByText(ko.criteria.errPercentilesMax)).toBeInTheDocument();
    expect(screen.getByLabelText("백분위 1")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("기준 2")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("기준 1")).not.toHaveAttribute("aria-invalid");
  });

  it("목록 오류는 + 백분위 기준 추가 단추의 aria-describedby로 이어진다", () => {
    const { unmount } = setup({}, { ...noErrors, percentilesList: ko.criteria.errPercentilesMax });
    const msg = screen.getByText(ko.criteria.errPercentilesMax);
    const add = screen.getByRole("button", { name: "+ 백분위 기준 추가" });
    expect(msg.id).not.toBe("");
    expect(add.getAttribute("aria-describedby")).toBe(msg.id);
    unmount();
    setup();
    expect(screen.getByRole("button", { name: "+ 백분위 기준 추가" })).not.toHaveAttribute(
      "aria-describedby",
    );
  });

  it("백분위 N·기준 칸이 극단값(99.999·59999.999)이 잘리지 않을 폭이다", () => {
    setup({ percentiles: [{ p: "99.999", ms: "59999.999" }] });
    expect(screen.getByLabelText("백분위 1").className).toContain("w-24");
    expect(screen.getByLabelText("기준 1").className).toContain("w-36");
  });
});
