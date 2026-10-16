import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PickArrayDialog } from "../PickArrayDialog";
import { ko } from "../../../i18n/ko";
import type { PickArraySpec } from "../../../scenario/genVars";

const BASE: PickArraySpec = { gen: "pick_array", length: 30, min: 2, max: 3, positions: "1-5, 8, 12-20" };

function setup(initial: PickArraySpec = BASE) {
  const onApply = vi.fn();
  const onCancel = vi.fn();
  render(<PickArrayDialog name="flags" initial={initial} onApply={onApply} onCancel={onCancel} />);
  const dialog = screen.getByRole("dialog");
  const posInput = within(dialog).getByRole("textbox", { name: ko.editor.pickSectionPositions });
  const grid = within(dialog).getByRole("group", { name: ko.editor.pickGridAria });
  const apply = within(dialog).getByRole("button", { name: ko.editor.pickApply });
  return { onApply, onCancel, dialog, posInput, grid, apply };
}
const cell = (grid: HTMLElement, i: number) =>
  within(grid).getByRole("button", { name: ko.editor.pickCellAria(i) });

describe("PickArrayDialog", () => {
  it("텍스트 → 칸 동기화", async () => {
    const user = userEvent.setup();
    const { posInput, grid } = setup();
    expect(cell(grid, 8)).toHaveAttribute("aria-pressed", "true");
    expect(cell(grid, 9)).toHaveAttribute("aria-pressed", "false");
    await user.clear(posInput);
    await user.type(posInput, "9");
    expect(cell(grid, 9)).toHaveAttribute("aria-pressed", "true");
    expect(cell(grid, 8)).toHaveAttribute("aria-pressed", "false");
  });

  it("칸 클릭 → 텍스트 정규형, Shift+클릭 = 범위", async () => {
    const user = userEvent.setup();
    const { posInput, grid } = setup();
    await user.click(cell(grid, 6));
    expect(posInput).toHaveValue("1-6, 8, 12-20");
    await user.keyboard("{Shift>}");
    await user.click(cell(grid, 10));
    await user.keyboard("{/Shift}");
    expect(posInput).toHaveValue("1-10, 12-20");
  });

  it("적용 전에는 onApply 없음, 적용 시 spec 1회 (전체 positions·기본값 키 생략)", async () => {
    const user = userEvent.setup();
    const { onApply, dialog, apply } = setup({ gen: "pick_array", length: 5, min: 1, max: 2 });
    await user.click(within(dialog).getByRole("button", { name: ko.editor.pickNone }));
    expect(onApply).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: ko.editor.pickAll }));
    await user.click(apply);
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledWith({ gen: "pick_array", length: 5, min: 1, max: 2 });
  });

  it("취소·ESC는 onCancel, onApply 없음", async () => {
    const user = userEvent.setup();
    const { onApply, onCancel, dialog } = setup();
    await user.click(within(dialog).getByRole("button", { name: ko.common.cancel }));
    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onApply).not.toHaveBeenCalled();
  });

  it("무효 설정에서 적용 disabled — 후보 0·최소>최대·최대>길이·최소>후보, 경고는 허용", async () => {
    const user = userEvent.setup();
    const { dialog, posInput, apply } = setup();
    const min = within(dialog).getByRole("spinbutton", { name: ko.editor.pickFieldMin });
    const max = within(dialog).getByRole("spinbutton", { name: ko.editor.pickFieldMax });
    await user.clear(posInput);
    expect(apply).toBeDisabled();
    expect(within(dialog).getByText(ko.editor.pickErrNoCandidates)).toBeInTheDocument();
    await user.type(posInput, "1-3");
    expect(apply).toBeEnabled();
    await user.clear(max);
    await user.type(max, "1");
    expect(apply).toBeDisabled(); // min 2 > max 1
    await user.clear(max);
    await user.type(max, "31");
    expect(apply).toBeDisabled(); // max > length
    await user.clear(max);
    await user.type(max, "10");
    expect(apply).toBeEnabled(); // max > 후보 3 = 경고만
    expect(within(dialog).getByText(ko.editor.pickWarnMaxGtCandidates(3))).toBeInTheDocument();
    await user.clear(min);
    await user.type(min, "4");
    expect(apply).toBeDisabled(); // min > 후보
  });

  it("문법 오류 동안 칸은 직전 유효 집합을 흐리게·비활성, 전체는 활성, 빈 문자열이면 칸 활성", async () => {
    const user = userEvent.setup();
    const { dialog, posInput, grid } = setup();
    await user.type(posInput, ","); // "1-5, 8, 12-20," — 후행 빈 항목 = 문법 오류
    expect(cell(grid, 8)).toHaveAttribute("aria-pressed", "true"); // 직전 유효 집합 유지(spec §6.3)
    expect(cell(grid, 9)).toHaveAttribute("aria-pressed", "false");
    expect(cell(grid, 8)).toBeDisabled();
    expect(within(dialog).getByText(ko.editor.pickErrBadItem(4))).toBeInTheDocument();
    await user.clear(posInput);
    await user.type(posInput, "1,,2");
    expect(cell(grid, 1)).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: ko.editor.pickAll })).toBeEnabled();
    expect(within(dialog).getByText(ko.editor.pickErrBadItem(2))).toBeInTheDocument();
    await user.clear(posInput);
    expect(cell(grid, 1)).toBeEnabled();
  });

  it("길이 재입력 중간값에서 positions를 깎지 않는다 (30 → 25)", async () => {
    const user = userEvent.setup();
    const { dialog, posInput } = setup();
    const len = within(dialog).getByRole("spinbutton", { name: ko.editor.pickFieldLength });
    await user.clear(len);
    await user.type(len, "25"); // "2"를 거쳐도
    expect(posInput).toHaveValue("1-5, 8, 12-20");
    await user.tab(); // 커밋
    expect(posInput).toHaveValue("1-5, 8, 12-20"); // 25 이내라 보존
    await user.clear(len);
    await user.type(len, "10");
    await user.tab();
    expect(posInput).toHaveValue("1-5, 8");
  });

  // jsdom에선 RTL이 이벤트마다 act로 재렌더를 정착시켜 '첫 클릭 삼킴'을 재현하지 못한다 —
  // 이 케이스는 동작 명세 핀이고, 회귀 가드는 라이브 검증(US4 행)이 담당한다.
  it("무효 길이를 고친 직후 적용 첫 클릭이 동작 (live 길이로 활성 판정)", async () => {
    const user = userEvent.setup();
    const { onApply, dialog, apply } = setup({ gen: "pick_array", length: 5, min: 1, max: 2 });
    const len = within(dialog).getByRole("spinbutton", { name: ko.editor.pickFieldLength });
    await user.clear(len);
    await user.type(len, "0");
    expect(apply).toBeDisabled();
    await user.clear(len);
    await user.type(len, "6");
    await user.click(apply); // 길이 칸에 포커스가 남은 채 바로 클릭
    expect(onApply).toHaveBeenCalledWith({ gen: "pick_array", length: 6, min: 1, max: 2 });
  });

  it("값 형식: 기본 접힘, 프리셋 선택, 직접 입력 무효면 적용 disabled", async () => {
    const user = userEvent.setup();
    const { onApply, dialog, apply } = setup({ gen: "pick_array", length: 4, min: 1, max: 1 });
    const toggle = within(dialog).getByRole("button", { name: ko.editor.pickValuesToggle("true", "false") });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(within(dialog).getByRole("radio", { name: /"Y" \/ "N"/ })).toBeInTheDocument(); // 프리셋 라벨은 문자열에 따옴표(목업)
    await user.click(within(dialog).getByRole("radio", { name: /^1 \/ 0/ }));
    await user.click(apply);
    expect(onApply).toHaveBeenLastCalledWith({ gen: "pick_array", length: 4, min: 1, max: 1, pick: 1, rest: 0 });
  });

  it("직접 입력: 타입 표시·null 보존·빈 값 disabled", async () => {
    const user = userEvent.setup();
    const { onApply, dialog, apply } = setup({ gen: "pick_array", length: 4, min: 1, max: 1, pick: "Y", rest: null });
    // 기본이 아니면 펼친 채로 열리고 직접 입력이 선택돼 있다
    const pick = within(dialog).getByRole("textbox", { name: ko.editor.pickFieldPick });
    const rest = within(dialog).getByRole("textbox", { name: ko.editor.pickFieldRest });
    expect(pick).toHaveValue("Y");
    expect(rest).toHaveValue("null");
    await user.clear(pick);
    expect(apply).toBeDisabled();
    await user.type(pick, '"1"');
    await user.click(apply);
    expect(onApply).toHaveBeenLastCalledWith({ gen: "pick_array", length: 4, min: 1, max: 1, pick: "1", rest: null });
  });

  it("roving: 그리드 Tab 정지 1개, 화살표 이동, Home/End", async () => {
    const user = userEvent.setup();
    const { grid } = setup({ gen: "pick_array", length: 12, min: 1, max: 1 });
    const tabbable = Array.from(grid.querySelectorAll("button")).filter((b) => b.tabIndex === 0);
    expect(tabbable).toHaveLength(1);
    act(() => cell(grid, 1).focus());
    await user.keyboard("{ArrowRight}");
    expect(cell(grid, 2)).toHaveFocus();
    await user.keyboard("{End}");
    expect(cell(grid, 12)).toHaveFocus();
    await user.keyboard("{Home}");
    expect(cell(grid, 1)).toHaveFocus();
    expect(Array.from(grid.querySelectorAll("button")).filter((b) => b.tabIndex === 0)).toHaveLength(1);
  });

  it("Shift+Space = 직전 토글 자리부터 범위, 1회만", async () => {
    const user = userEvent.setup();
    const { posInput, grid } = setup({ gen: "pick_array", length: 8, min: 0, max: 1, positions: "1" });
    await user.click(cell(grid, 2)); // anchor=2, "1-2"
    act(() => cell(grid, 5).focus());
    await user.keyboard("{Shift>} {/Shift}");
    expect(posInput).toHaveValue("1-5");
  });

  it("Space는 네이티브 활성화로 1회만 토글", async () => {
    const user = userEvent.setup();
    const { posInput, grid } = setup({ gen: "pick_array", length: 5, min: 0, max: 1, positions: "1" });
    act(() => cell(grid, 3).focus());
    await user.keyboard(" ");
    expect(posInput).toHaveValue("1, 3");
  });

  it("길이를 줄인 뒤 Shift+클릭이 옛 앵커로 범위를 만들지 않는다 (30 → 10)", async () => {
    const user = userEvent.setup();
    const { dialog, posInput, grid } = setup();
    await user.click(cell(grid, 25)); // anchor=25
    const len = within(dialog).getByRole("spinbutton", { name: ko.editor.pickFieldLength });
    await user.clear(len);
    await user.type(len, "10");
    await user.tab(); // 커밋
    await user.keyboard("{Shift>}");
    await user.click(cell(grid, 6));
    await user.keyboard("{/Shift}");
    expect(posInput).toHaveValue("1-6, 8");
    expect(cell(grid, 6)).toBeEnabled();
  });

  it("Shift를 Space보다 먼저 떼도 따라오는 keyup(=네이티브 click)이 1회 억제된다", () => {
    // jsdom/user-event는 keyup→click을 모사하지 않으므로 keyup의 defaultPrevented(=click 억제)를 직접 본다.
    const { grid } = setup({ gen: "pick_array", length: 8, min: 0, max: 1, positions: "1" });
    const c = cell(grid, 5);
    fireEvent.keyDown(c, { key: " ", shiftKey: true });
    expect(fireEvent.keyUp(c, { key: " ", shiftKey: false })).toBe(false); // 억제됨
    expect(fireEvent.keyUp(c, { key: " ", shiftKey: false })).toBe(true); // 1회만
  });

  it("무효 크기에서 aria-invalid·aria-describedby로 오류 문구가 연결된다", async () => {
    const user = userEvent.setup();
    const { dialog } = setup();
    const min = within(dialog).getByRole("spinbutton", { name: ko.editor.pickFieldMin });
    const max = within(dialog).getByRole("spinbutton", { name: ko.editor.pickFieldMax });
    expect(max).not.toHaveAttribute("aria-invalid");
    await user.clear(max);
    await user.type(max, "1"); // min 2 > max 1
    expect(min).toHaveAttribute("aria-invalid", "true");
    expect(max).toHaveAttribute("aria-invalid", "true");
    const err = within(dialog).getByText(ko.editor.pickErrMinGtMax);
    expect(err.id).not.toBe("");
    expect(min.getAttribute("aria-describedby")).toContain(err.id);
    expect(max.getAttribute("aria-describedby")).toContain(err.id);
  });

  it("자리 목록·직접 입력 값 오류 문구가 aria-describedby로 입력에 연결된다", async () => {
    const user = userEvent.setup();
    const { dialog, posInput } = setup({ gen: "pick_array", length: 4, min: 1, max: 1, pick: "Y", rest: null });
    await user.clear(posInput);
    const posErr = within(dialog).getByText(ko.editor.pickErrNoCandidates);
    expect(posErr.id).not.toBe("");
    expect(posInput.getAttribute("aria-describedby")).toContain(posErr.id);
    const pick = within(dialog).getByRole("textbox", { name: ko.editor.pickFieldPick });
    const rest = within(dialog).getByRole("textbox", { name: ko.editor.pickFieldRest });
    await user.clear(pick);
    await user.clear(rest);
    const errs = within(dialog).getAllByText(ko.editor.pickErrValueEmpty);
    expect(errs).toHaveLength(2);
    expect(errs[0].id).not.toBe(errs[1].id);
    expect(pick.getAttribute("aria-describedby")).toContain(errs[0].id);
    expect(rest.getAttribute("aria-describedby")).toContain(errs[1].id);
  });

  it("값 형식 토글이 aria-controls로 영역을 가리킨다", async () => {
    const user = userEvent.setup();
    const { dialog } = setup({ gen: "pick_array", length: 4, min: 1, max: 1 });
    const toggle = within(dialog).getByRole("button", { name: ko.editor.pickValuesToggle("true", "false") });
    await user.click(toggle);
    const id = toggle.getAttribute("aria-controls");
    expect(id).toBeTruthy();
    expect(document.getElementById(id!)).toContainElement(within(dialog).getByRole("radiogroup", { name: ko.editor.pickValuesAria }));
  });

  it("길이 1000: 1000칸 렌더·토글이 텍스트를 정규형으로", async () => {
    const user = userEvent.setup();
    // setup()의 role 쿼리는 1000칸 접근명 계산으로 느리다 — 이 케이스는 DOM 쿼리로 직접.
    render(
      <PickArrayDialog name="flags" initial={{ gen: "pick_array", length: 1000, min: 0, max: 5 }} onApply={vi.fn()} onCancel={vi.fn()} />,
    );
    const grid = document.querySelector('[aria-label="' + ko.editor.pickGridAria + '"]')!;
    const cells = grid.querySelectorAll("button");
    expect(cells).toHaveLength(1000);
    await user.click(cells[499]);
    const pos = document.querySelector('input[aria-label="' + ko.editor.pickSectionPositions + '"]') as HTMLInputElement;
    expect(pos.value).toBe("1-499, 501-1000");
  }, 30_000);

  it("사용 안내와 미리보기(유효 시 JSON 배열)", () => {
    const { dialog } = setup({ gen: "pick_array", length: 4, min: 1, max: 1 });
    expect(within(dialog).getByText(ko.editor.pickUsageHint("flags"))).toBeInTheDocument();
    const pre = within(dialog).getByTestId("pick-preview");
    expect(JSON.parse(pre.textContent!)).toHaveLength(4);
  });

  it("불리언 전제 문구가 없다", () => {
    const { dialog } = setup();
    expect(dialog.textContent).not.toMatch(/true 개수|true 자리|불리언 배열|true 후보/);
  });
});
