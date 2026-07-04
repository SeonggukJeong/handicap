import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StepCriteriaFields } from "../StepCriteriaFields";
import type { StepCriterionDraft } from "../profileForm";

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
    <StepCriteriaFields value={rows} options={opts} onChange={onChange} />,
  );
  await user.click(screen.getByRole("button", { name: "+ 스텝 기준 추가" }));
  expect(rows).toHaveLength(1);
  expect(rows[0]).toEqual({ target: "A", metric: "p95_ms", op: "max", threshold: "" });
  rerender(<StepCriteriaFields value={rows} options={opts} onChange={onChange} />);
  await user.click(screen.getByRole("button", { name: "스텝 기준 1 삭제" }));
  expect(rows).toHaveLength(0);
});

test("rate metric shows % unit, latency shows ms", () => {
  const { rerender } = render(
    <StepCriteriaFields
      value={[{ target: "A", metric: "5xx_rate", op: "max", threshold: "2" }]}
      options={opts}
      onChange={() => {}}
    />,
  );
  expect(screen.getByText("%")).toBeInTheDocument();
  rerender(
    <StepCriteriaFields
      value={[{ target: "A", metric: "p95_ms", op: "max", threshold: "300" }]}
      options={opts}
      onChange={() => {}}
    />,
  );
  expect(screen.getByText("ms")).toBeInTheDocument();
});

test("no http steps shows guidance", () => {
  render(<StepCriteriaFields value={[]} options={[]} onChange={() => {}} />);
  expect(screen.getByText(/http 스텝이 있는 시나리오/)).toBeInTheDocument();
});

test("스텝 기준 추가 버튼은 accent 링크색(blue→accent)", () => {
  render(<StepCriteriaFields value={[]} options={opts} onChange={() => {}} />);
  const addBtn = screen.getByRole("button", { name: "+ 스텝 기준 추가" });
  expect(addBtn).toHaveClass("text-accent-600"); // 이주 전 RED (현 text-blue-600)
});
