import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { StepCriteriaFields } from "../StepCriteriaFields";
import type { StepCriterionDraft } from "../profileForm";
import { ko } from "../../../i18n/ko";

const opts = [
  { id: "A", label: "login (GET /a)" },
  { id: "B", label: "feed (GET /b)" },
];

test("add appends a default row and remove drops it", async () => {
  const user = userEvent.setup();
  let rows: StepCriterionDraft[] = [];
  const onChange = (r: StepCriterionDraft[]) => {
    rows = r;
  };
  const { rerender } = render(
    <StepCriteriaFields value={rows} options={opts} errors={[]} onChange={onChange} />,
  );
  await user.click(screen.getByRole("button", { name: "+ 스텝 기준 추가" }));
  expect(rows).toHaveLength(1);
  expect(rows[0]).toEqual({ target: "A", metric: "p95_ms", op: "max", threshold: "", p: "" });
  rerender(<StepCriteriaFields value={rows} options={opts} errors={[]} onChange={onChange} />);
  await user.click(screen.getByRole("button", { name: "스텝 기준 1 삭제" }));
  expect(rows).toHaveLength(0);
});

test("rate metric shows % unit, latency shows ms", () => {
  const { rerender } = render(
    <StepCriteriaFields
      value={[{ target: "A", metric: "5xx_rate", op: "max", threshold: "2", p: "" }]}
      options={opts}
      errors={[]}
      onChange={() => {}}
    />,
  );
  expect(screen.getByText("%")).toBeInTheDocument();
  rerender(
    <StepCriteriaFields
      value={[{ target: "A", metric: "p95_ms", op: "max", threshold: "300", p: "" }]}
      options={opts}
      errors={[]}
      onChange={() => {}}
    />,
  );
  expect(screen.getByText("ms")).toBeInTheDocument();
});

test("no http steps shows guidance", () => {
  render(<StepCriteriaFields value={[]} options={[]} errors={[]} onChange={() => {}} />);
  expect(screen.getByText(/http 스텝이 있는 시나리오/)).toBeInTheDocument();
});

test("스텝 기준 추가 버튼은 accent 링크색(blue→accent)", () => {
  render(<StepCriteriaFields value={[]} options={opts} errors={[]} onChange={() => {}} />);
  const addBtn = screen.getByRole("button", { name: "+ 스텝 기준 추가" });
  expect(addBtn).toHaveClass("text-accent-600"); // 이주 전 RED (현 text-blue-600)
});

describe("StepCriteriaFields — 새 항목", () => {
  it("항목 선택 옵션 순서: 평균·최대·백분위·p50…", () => {
    render(
      <StepCriteriaFields
        value={[{ target: "A", metric: "p95_ms", op: "max", threshold: "", p: "" }]}
        options={opts}
        errors={[]}
        onChange={() => {}}
      />,
    );
    const labels = within(screen.getByLabelText("지표 1"))
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(labels.slice(0, 6)).toEqual([
      ko.criteria.stepMean,
      ko.criteria.stepMax,
      ko.criteria.stepPercentile,
      "p50(ms)",
      "p95(ms)",
      "p99(ms)",
    ]);
    expect(labels.slice(0, 3)).toEqual(["평균(ms)", "최대(ms)", "백분위(ms)"]);
  });

  it("「백분위」를 고르면 p가 비어 있었으면 90으로 채운다", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <StepCriteriaFields
        value={[{ target: "A", metric: "p95_ms", op: "max", threshold: "5", p: "" }]}
        options={opts}
        errors={[]}
        onChange={onChange}
      />,
    );
    await user.selectOptions(screen.getByLabelText("지표 1"), "백분위(ms)");
    expect(onChange).toHaveBeenCalledWith([
      { target: "A", metric: "percentile", op: "max", threshold: "5", p: "90" },
    ]);
  });

  it("p가 이미 있으면 그대로 둔다", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <StepCriteriaFields
        value={[{ target: "A", metric: "p95_ms", op: "max", threshold: "5", p: "99.9" }]}
        options={opts}
        errors={[]}
        onChange={onChange}
      />,
    );
    await user.selectOptions(screen.getByLabelText("지표 1"), "백분위(ms)");
    expect(onChange.mock.calls[0][0][0].p).toBe("99.9");
  });

  it("백분위 행은 N 칸과 단위 ms, 평균 행은 단위 ms", () => {
    const { rerender } = render(
      <StepCriteriaFields
        value={[{ target: "A", metric: "percentile", op: "max", threshold: "1200", p: "90" }]}
        options={opts}
        errors={[]}
        onChange={() => {}}
      />,
    );
    expect(screen.getByLabelText("스텝 기준 1 백분위")).toHaveValue(90);
    expect(screen.getByText("ms")).toBeInTheDocument();
    rerender(
      <StepCriteriaFields
        value={[{ target: "A", metric: "mean_ms", op: "max", threshold: "500", p: "" }]}
        options={opts}
        errors={[]}
        onChange={() => {}}
      />,
    );
    expect(screen.queryByLabelText("스텝 기준 1 백분위")).not.toBeInTheDocument();
    expect(screen.getByText("ms")).toBeInTheDocument();
  });

  it("행 오류 글자가 그 행 아래에 보인다", () => {
    render(
      <StepCriteriaFields
        value={[{ target: "A", metric: "percentile", op: "max", threshold: "70000", p: "100" }]}
        options={opts}
        errors={[{ p: ko.criteria.errPercentileRange, threshold: ko.criteria.errTime }]}
        onChange={() => {}}
      />,
    );
    expect(screen.getByText(ko.criteria.errPercentileRange)).toBeInTheDocument();
    expect(screen.getByText(ko.criteria.errTime)).toBeInTheDocument();
    expect(screen.getByLabelText("스텝 기준 1 백분위")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("임계값 1")).toHaveAttribute("aria-invalid", "true");
  });

  it("스텝 기준 행은 줄바꿈하고 스텝 선택은 12rem 밑으로 줄지 않으며 숫자 칸은 넓다", () => {
    render(
      <StepCriteriaFields
        value={[
          { target: "A", metric: "percentile", op: "max", threshold: "59999.999", p: "99.999" },
        ]}
        options={opts}
        errors={[]}
        onChange={() => {}}
      />,
    );
    expect(screen.getByRole("group", { name: "스텝 기준 1" }).className).toContain("flex-wrap");
    const sel = screen.getByLabelText("스텝 1").className;
    expect(sel).toContain("min-w-[12rem]");
    expect(sel).not.toContain("min-w-0");
    expect(screen.getByLabelText("스텝 기준 1 백분위").className).toContain("w-[88px]");
    expect(screen.getByLabelText("임계값 1").className).toContain("w-32");
  });
});
