import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Segmented } from "../Segmented";

const opts = [
  { value: "simple", label: "간단" },
  { value: "detailed", label: "상세" },
] as const;

it("renders a radiogroup with one radio per option, checked reflects value", () => {
  render(<Segmented value="simple" onChange={() => {}} options={opts} ariaLabel="설정 모드" />);
  expect(screen.getByRole("radiogroup", { name: "설정 모드" })).toBeInTheDocument();
  expect(screen.getByRole("radio", { name: "간단" })).toHaveAttribute("aria-checked", "true");
  expect(screen.getByRole("radio", { name: "상세" })).toHaveAttribute("aria-checked", "false");
});

it("calls onChange with the option value on click", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(<Segmented value="simple" onChange={onChange} options={opts} ariaLabel="설정 모드" />);
  await user.click(screen.getByRole("radio", { name: "상세" }));
  expect(onChange).toHaveBeenCalledWith("detailed");
});

it("moves selection with arrow keys", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(<Segmented value="simple" onChange={onChange} options={opts} ariaLabel="설정 모드" />);
  screen.getByRole("radio", { name: "간단" }).focus();
  await user.keyboard("{ArrowRight}");
  expect(onChange).toHaveBeenCalledWith("detailed");
});
