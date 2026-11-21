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

describe("Segmented — disabled 선택지", () => {
  const three = [
    { value: "a", label: "가" },
    { value: "b", label: "나", disabled: true },
    { value: "c", label: "다" },
  ] as const;

  it("꺼진 선택지는 disabled + aria-disabled이고 눌러도 onChange가 안 불린다", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Segmented value="a" onChange={onChange} options={three} ariaLabel="순서" />);
    const off = screen.getByRole("radio", { name: "나" });
    expect(off).toBeDisabled();
    expect(off).toHaveAttribute("aria-disabled", "true");
    await user.click(off);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("disabled를 안 넘긴 선택지에는 aria-disabled가 없다", () => {
    render(<Segmented value="a" onChange={() => {}} options={three} ariaLabel="순서" />);
    expect(screen.getByRole("radio", { name: "가" })).not.toHaveAttribute("aria-disabled");
  });

  it("방향키는 꺼진 선택지를 건너뛴다", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Segmented value="a" onChange={onChange} options={three} ariaLabel="순서" />);
    screen.getByRole("radio", { name: "가" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenCalledWith("c");
  });

  it("거꾸로 가도 꺼진 선택지를 건너뛴다", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Segmented value="c" onChange={onChange} options={three} ariaLabel="순서" />);
    screen.getByRole("radio", { name: "다" }).focus();
    await user.keyboard("{ArrowLeft}");
    expect(onChange).toHaveBeenCalledWith("a");
  });

  it("선택된 값이 꺼져 있으면 첫 켜진 선택지가 탭 정지점이다", () => {
    render(<Segmented value="b" onChange={() => {}} options={three} ariaLabel="순서" />);
    expect(screen.getByRole("radio", { name: "나" })).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("radio", { name: "가" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("radio", { name: "다" })).toHaveAttribute("tabindex", "-1");
  });

  it("켜진 선택지가 하나뿐이면 방향키는 아무것도 하지 않는다", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const one = [
      { value: "a", label: "가" },
      { value: "b", label: "나", disabled: true },
    ] as const;
    render(<Segmented value="a" onChange={onChange} options={one} ariaLabel="순서" />);
    screen.getByRole("radio", { name: "가" }).focus();
    await user.keyboard("{ArrowRight}");
    await user.keyboard("{ArrowLeft}");
    expect(onChange).not.toHaveBeenCalled();
  });
});
