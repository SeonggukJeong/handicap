import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { useThinkTimePair } from "../useThinkTimePair";
import type { ThinkTime } from "../../../scenario/model";

function Harness({
  value,
  onCommit,
  onClear,
}: {
  value: ThinkTime | undefined;
  onCommit: (v: ThinkTime) => void;
  onClear: () => void;
}) {
  const { minProps, maxProps } = useThinkTimePair({ value, onCommit, onClear });
  return (
    <div>
      <input aria-label="min" {...minProps} />
      <input aria-label="max" {...maxProps} />
      <button type="button">outside</button>
    </div>
  );
}

/** H1 전용 하니스: max에 **ref를 붙이지 않아** partner.current가 null인 상태를 만든다.
 *  `const { ref, ...rest } = maxProps`로 빼면 eslint `no-unused-vars`에 걸린다
 *  (`ignoreRestSiblings` 미설정 — `ui/eslint.config.js:23`) → 필드를 명시 나열한다. */
function DetachedPartnerHarness({
  value,
  onCommit,
  onClear,
}: {
  value: ThinkTime | undefined;
  onCommit: (v: ThinkTime) => void;
  onClear: () => void;
}) {
  const { minProps, maxProps } = useThinkTimePair({ value, onCommit, onClear });
  return (
    <div>
      <input aria-label="min" {...minProps} />
      <input
        aria-label="max"
        value={maxProps.value}
        onChange={maxProps.onChange}
        onBlur={maxProps.onBlur}
      />
    </div>
  );
}

const min = () => screen.getByLabelText("min");
const max = () => screen.getByLabelText("max");

describe("useThinkTimePair", () => {
  it("짝 내부로 포커스가 이동할 땐 커밋하지 않고 draft를 보존한다 (핵심 회귀 가드)", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<Harness value={{ min_ms: 200, max_ms: 500 }} onCommit={onCommit} onClear={vi.fn()} />);

    await user.clear(min());
    await user.type(min(), "1000");
    await user.click(max()); // min이 blur되지만 짝 내부라 보류돼야 한다

    expect(onCommit).not.toHaveBeenCalled();
    // ↓ 이 단언이 이 테스트의 이빨이다. 가드가 없으면 중간 쌍 {1000,500}이
    //   min>max라 `revert`로 떨어져 draft가 "200"으로 되돌아간다 — 그런데 revert는
    //   onCommit을 부르지 않으므로 위의 not.toHaveBeenCalled()는 **가드가 없어도
    //   통과한다**(공허). 사라진 값을 직접 관찰해야 RED가 뜬다.
    expect((min() as HTMLInputElement).value).toBe("1000");
  });

  it("짝을 떠날 때 최종 쌍으로 커밋한다 (상향 편집)", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<Harness value={{ min_ms: 200, max_ms: 500 }} onCommit={onCommit} onClear={vi.fn()} />);

    await user.clear(min());
    await user.type(min(), "1000");
    await user.click(max());
    await user.clear(max());
    await user.type(max(), "2000");
    await user.click(screen.getByRole("button", { name: "outside" }));

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith({ min_ms: 1000, max_ms: 2000 });
  });

  it("H1: partner ref가 미부착이고 relatedTarget도 null이면 그래도 커밋한다", () => {
    const onCommit = vi.fn();
    render(
      <DetachedPartnerHarness
        value={{ min_ms: 200, max_ms: 500 }}
        onCommit={onCommit}
        onClear={vi.fn()}
      />,
    );

    // max에 ref가 안 붙어 있으므로 maxRef.current === null이고, fireEvent.blur는
    // relatedTarget === null이다. 가드가 non-null 확인 없이 `===`만 쓰면
    // null === null이 참이 되어 **모든 커밋이 조용히 사라진다**.
    fireEvent.change(min(), { target: { value: "100" } });
    fireEvent.change(max(), { target: { value: "300" } });
    fireEvent.blur(min()); // partner = maxRef(=null), relatedTarget = null

    expect(onCommit).toHaveBeenCalledWith({ min_ms: 100, max_ms: 300 });
  });

  it("둘 다 비우면 onClear", () => {
    const onClear = vi.fn();
    render(<Harness value={{ min_ms: 200, max_ms: 500 }} onCommit={vi.fn()} onClear={onClear} />);
    fireEvent.change(min(), { target: { value: "" } });
    fireEvent.change(max(), { target: { value: "" } });
    fireEvent.blur(max());
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("정확히 한 칸만 비면 noop — 커밋도 클리어도 없고 draft가 보존된다", () => {
    const onCommit = vi.fn();
    const onClear = vi.fn();
    render(<Harness value={{ min_ms: 200, max_ms: 500 }} onCommit={onCommit} onClear={onClear} />);
    fireEvent.change(min(), { target: { value: "" } });
    fireEvent.blur(min());
    expect(onCommit).not.toHaveBeenCalled();
    expect(onClear).not.toHaveBeenCalled();
    expect((min() as HTMLInputElement).value).toBe("");
  });

  it("min>max로 짝을 떠나면 revert — 마지막 커밋값으로 draft 복귀 (US2)", () => {
    const onCommit = vi.fn();
    render(<Harness value={{ min_ms: 200, max_ms: 500 }} onCommit={onCommit} onClear={vi.fn()} />);
    fireEvent.change(min(), { target: { value: "900" } });
    fireEvent.change(max(), { target: { value: "100" } });
    fireEvent.blur(max());
    expect(onCommit).not.toHaveBeenCalled();
    expect((min() as HTMLInputElement).value).toBe("200");
    expect((max() as HTMLInputElement).value).toBe("500");
  });

  it("경계값 600000은 커밋되고 600001은 revert된다 (규칙 0-diff 확인)", () => {
    const onCommit = vi.fn();
    const { rerender } = render(
      <Harness value={{ min_ms: 0, max_ms: 1 }} onCommit={onCommit} onClear={vi.fn()} />,
    );
    fireEvent.change(min(), { target: { value: "0" } });
    fireEvent.change(max(), { target: { value: "600000" } });
    fireEvent.blur(max());
    expect(onCommit).toHaveBeenCalledWith({ min_ms: 0, max_ms: 600000 });

    onCommit.mockClear();
    rerender(<Harness value={{ min_ms: 0, max_ms: 1 }} onCommit={onCommit} onClear={vi.fn()} />);
    fireEvent.change(min(), { target: { value: "0" } });
    fireEvent.change(max(), { target: { value: "600001" } });
    fireEvent.blur(max());
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("value가 {0,0}이면 빈 칸이 아니라 '0'으로 시드된다 (키 삭제 방지)", () => {
    render(<Harness value={{ min_ms: 0, max_ms: 0 }} onCommit={vi.fn()} onClear={vi.fn()} />);
    expect((min() as HTMLInputElement).value).toBe("0");
    expect((max() as HTMLInputElement).value).toBe("0");
  });
});
