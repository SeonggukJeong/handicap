import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RunListControls } from "../RunListControls";
import { EMPTY_FILTER, DEFAULT_SORT, type RunFilter, type SortKey } from "../../runs/runFilterSort";
import { ko } from "../../i18n/ko";

function setup(filter: RunFilter = EMPTY_FILTER, sort: SortKey[] = DEFAULT_SORT) {
  const onChange = vi.fn();
  const user = userEvent.setup();
  render(<RunListControls filter={filter} sort={sort} total={10} shown={4} onChange={onChange} />);
  return { onChange, user };
}

describe("RunListControls — filters", () => {
  it("toggling a verdict filter emits OR membership (R1)", async () => {
    const { onChange, user } = setup();
    await user.click(
      screen.getByRole("button", { name: ko.runFilter.verdictFail, pressed: false }),
    );
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ filter: expect.objectContaining({ verdicts: ["fail"] }) }),
    );
  });

  it("status filter exposes all 5 incl. pending (R2)", () => {
    setup();
    for (const label of [
      ko.runFilter.statusPending,
      ko.runFilter.statusRunning,
      ko.runFilter.statusCompleted,
      ko.runFilter.statusFailed,
      ko.runFilter.statusAborted,
    ]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
  });

  it("date preset select emits datePreset (R4)", async () => {
    const { onChange, user } = setup();
    await user.selectOptions(screen.getByLabelText(ko.runFilter.dateLabel), "7d");
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ filter: expect.objectContaining({ datePreset: "7d" }) }),
    );
  });

  it("count + reset show when active (R14)", async () => {
    const { onChange, user } = setup({ ...EMPTY_FILTER, statuses: ["running"] }, DEFAULT_SORT);
    expect(screen.getByText(ko.runFilter.count(4, 10))).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: ko.runFilter.reset }));
    expect(onChange).toHaveBeenCalledWith({ filter: EMPTY_FILTER, sort: DEFAULT_SORT });
  });

  it("no count/reset when defaults", () => {
    setup(EMPTY_FILTER, DEFAULT_SORT);
    expect(screen.queryByRole("button", { name: ko.runFilter.reset })).not.toBeInTheDocument();
  });
});

describe("RunListControls — sort builder (R6, R12)", () => {
  it("adds a sort key for the first unused field", async () => {
    const { onChange, user } = setup(EMPTY_FILTER, DEFAULT_SORT);
    // 버튼 텍스트는 "+ 정렬 추가"(컴포넌트가 "+ " 접두) → 정확매치 대신 regex(ui/CLAUDE.md 다중매치 함정과 별개·exact name 실패 회피)
    await user.click(screen.getByRole("button", { name: /정렬 추가/ }));
    // created already used → next add picks first unused (duration)
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        sort: [
          { field: "created", dir: "desc" },
          { field: "duration", dir: "desc" },
        ],
      }),
    );
  });

  it("removes a sort key", async () => {
    const sort: SortKey[] = [
      { field: "created", dir: "desc" },
      { field: "verdict", dir: "asc" },
    ];
    const { onChange, user } = setup(EMPTY_FILTER, sort);
    await user.click(
      screen.getByRole("button", { name: ko.runSort.removeKeyAria(ko.runSort.fieldVerdict) }),
    );
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ sort: [{ field: "created", dir: "desc" }] }),
    );
  });

  it("toggles a key direction", async () => {
    const { onChange, user } = setup(EMPTY_FILTER, [{ field: "created", dir: "desc" }]);
    await user.click(
      screen.getByRole("button", { name: ko.runSort.toggleDirAria(ko.runSort.fieldCreated) }),
    );
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ sort: [{ field: "created", dir: "asc" }] }),
    );
  });

  it("moves a key up to raise priority", async () => {
    const sort: SortKey[] = [
      { field: "created", dir: "desc" },
      { field: "verdict", dir: "asc" },
    ];
    const { onChange, user } = setup(EMPTY_FILTER, sort);
    await user.click(
      screen.getByRole("button", { name: ko.runSort.moveUpAria(ko.runSort.fieldVerdict) }),
    );
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        sort: [
          { field: "verdict", dir: "asc" },
          { field: "created", dir: "desc" },
        ],
      }),
    );
  });

  it("moves a key down to lower priority", async () => {
    const sort: SortKey[] = [
      { field: "created", dir: "desc" },
      { field: "verdict", dir: "asc" },
    ];
    const { onChange, user } = setup(EMPTY_FILTER, sort);
    await user.click(
      screen.getByRole("button", { name: ko.runSort.moveDownAria(ko.runSort.fieldCreated) }),
    );
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        sort: [
          { field: "verdict", dir: "asc" },
          { field: "created", dir: "desc" },
        ],
      }),
    );
  });

  it("disables move-up on the first key and move-down on the last", () => {
    const sort: SortKey[] = [
      { field: "created", dir: "desc" },
      { field: "verdict", dir: "asc" },
    ];
    setup(EMPTY_FILTER, sort);
    expect(
      screen.getByRole("button", { name: ko.runSort.moveUpAria(ko.runSort.fieldCreated) }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: ko.runSort.moveDownAria(ko.runSort.fieldVerdict) }),
    ).toBeDisabled();
  });
});

describe("RunListControls — 디자인시스템 compact 이주 (5차 R5)", () => {
  it("날짜 preset select가 Select 캐넌 compact를 쓴다 (rounded-md·포커스 링·py-0.5)", () => {
    setup();
    const sel = screen.getByLabelText(ko.runFilter.dateLabel);
    expect(sel).toHaveClass("rounded-md"); // 이주 전 "rounded"라 FAIL
    expect(sel).toHaveClass("py-0.5");
    expect(sel).toHaveClass("focus:ring-accent-500/30");
  });

  it("날짜 from/to input이 Input 캐넌 compact를 쓴다 (px-1→px-2 fold-in)", () => {
    setup();
    for (const label of [ko.runFilter.dateFromAria, ko.runFilter.dateToAria]) {
      const el = screen.getByLabelText(label);
      expect(el).toHaveClass("rounded-md", "py-0.5", "px-2");
      expect(el).not.toHaveClass("px-1");
    }
  });

  it("동결: 정렬 pill 내부 select는 투명 인라인 유지 (이주 대상 아님)", () => {
    setup(EMPTY_FILTER, [{ field: "created", dir: "desc" }]);
    expect(screen.getByLabelText(ko.runSort.fieldSelectAria(1))).toHaveClass("bg-transparent");
  });
});
