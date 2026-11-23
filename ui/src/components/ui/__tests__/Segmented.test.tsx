import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
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

describe("Segmented — 초점 이동과 설명 툴팁", () => {
  type O = { value: string; label: string; description?: string };
  const OPTS: ReadonlyArray<O> = [
    { value: "a", label: "가", description: "가 설명" },
    { value: "b", label: "나", description: "나 설명" },
    { value: "c", label: "다", description: "다 설명" },
  ];
  const PLAIN: ReadonlyArray<O> = [
    { value: "a", label: "가" },
    { value: "b", label: "나" },
  ];

  function Wrapper({ options = OPTS }: { options?: ReadonlyArray<O> }) {
    const [v, setV] = useState("a");
    return <Segmented value={v} onChange={setV} options={options} ariaLabel="표본" />;
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("화살표 키로 고르면 초점이 고른 단추로 간다", async () => {
    const user = userEvent.setup();
    render(<Wrapper />);
    act(() => screen.getByRole("radio", { name: "가" }).focus());
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "나" }));
    expect(screen.getByRole("radio", { name: "나" })).toHaveAttribute("aria-checked", "true");
  });

  it("단추의 접근 이름에 설명이 섞이지 않고 aria-describedby가 설명을 가리킨다(닫혀 있어도)", () => {
    render(<Wrapper />);
    const radios = screen.getAllByRole("radio", { name: "나" });
    expect(radios).toHaveLength(1);
    expect(radios[0]).toHaveAccessibleDescription("나 설명");
    expect(radios[0].getAttribute("aria-describedby")).toBeTruthy();
    expect(screen.queryByRole("tooltip", { hidden: true })).toBeNull();
  });

  it("마우스를 올리면 그 선택지의 툴팁이 뜨고, 툴팁 위로 옮겨도 열려 있다", () => {
    vi.useFakeTimers();
    render(<Wrapper />);
    const btn = screen.getByRole("radio", { name: "나" });
    fireEvent.pointerEnter(btn);
    const tip = screen.getByRole("tooltip", { hidden: true });
    expect(tip).toHaveTextContent("나 설명");
    fireEvent.pointerLeave(btn);
    fireEvent.pointerEnter(tip);
    act(() => {
      vi.advanceTimersByTime(120);
    });
    expect(screen.getByRole("tooltip", { hidden: true })).toBeInTheDocument();
    fireEvent.pointerLeave(tip);
    act(() => {
      vi.advanceTimersByTime(120);
    });
    expect(screen.queryByRole("tooltip", { hidden: true })).toBeNull();
  });

  it("Esc로 닫히고, 다시 초점이 오면 열린다", async () => {
    const user = userEvent.setup();
    render(<Wrapper />);
    await user.tab();
    expect(screen.getByRole("tooltip", { hidden: true })).toHaveTextContent("가 설명");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("tooltip", { hidden: true })).toBeNull();
    expect(screen.queryByRole("tooltip", { hidden: true })).toBeNull();
    await user.tab({ shift: true });
    await user.tab();
    expect(screen.getByRole("tooltip", { hidden: true })).toHaveTextContent("가 설명");
  });

  it("키보드 초점으로 뜨고 blur로 닫힌다", async () => {
    const user = userEvent.setup();
    render(<Wrapper />);
    await user.tab();
    expect(screen.getByRole("tooltip", { hidden: true })).toHaveTextContent("가 설명");
    await user.tab();
    expect(screen.queryByRole("tooltip", { hidden: true })).toBeNull();
  });

  it("한 번에 하나만 뜬다", async () => {
    const user = userEvent.setup();
    render(<Wrapper />);
    await user.tab();
    await user.keyboard("{ArrowRight}");
    const tips = screen.getAllByRole("tooltip", { hidden: true });
    expect(tips).toHaveLength(1);
    expect(tips[0]).toHaveTextContent("나 설명");
  });

  it("description이 없으면 숨은 설명·aria-describedby·툴팁이 없다", () => {
    const { container } = render(<Wrapper options={PLAIN} />);
    expect(container.querySelector("[hidden]")).toBeNull();
    for (const r of screen.getAllByRole("radio")) expect(r).not.toHaveAttribute("aria-describedby");
    fireEvent.pointerEnter(screen.getByRole("radio", { name: "나" }));
    expect(screen.queryByRole("tooltip", { hidden: true })).toBeNull();
  });
});
