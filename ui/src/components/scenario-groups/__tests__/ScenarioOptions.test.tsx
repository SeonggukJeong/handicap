import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { ScenarioOptions } from "../ScenarioOptions";

function renderSelect(scenarios: { id: string; name: string; group?: string | null }[]) {
  return render(
    <select aria-label="시나리오">
      <option value="">선택…</option>
      <ScenarioOptions scenarios={scenarios} />
    </select>,
  );
}

describe("ScenarioOptions", () => {
  it("그룹이 없으면 optgroup 없이 입력 순서·value·글자 그대로", () => {
    const { container } = renderSelect([
      { id: "b", name: "나", group: null },
      { id: "a", name: "가" },
      { id: "c", name: "다", group: null },
    ]);
    expect(container.querySelector("optgroup")).toBeNull();
    const opts = Array.from(container.querySelectorAll("option"));
    expect(opts.map((o) => [o.value, o.textContent])).toEqual([
      ["", "선택…"],
      ["b", "나"],
      ["a", "가"],
      ["c", "다"],
    ]);
  });

  it("그룹은 이름순 optgroup으로 먼저, 그룹 없는 것은 그 뒤 optgroup 밖", () => {
    const { container } = renderSelect([
      { id: "1", name: "단독", group: null },
      { id: "2", name: "x", group: "서비스B" },
      { id: "3", name: "y", group: "서비스A" },
    ]);
    const select = container.querySelector("select")!;
    const kids = Array.from(select.children).map((c) =>
      c.tagName === "OPTGROUP"
        ? `G:${c.getAttribute("label")}`
        : `O:${(c as HTMLOptionElement).value}`,
    );
    expect(kids).toEqual(["O:", "G:서비스A", "G:서비스B", "O:1"]);
  });

  it("같은 이름의 시나리오가 서로 다른 optgroup 아래에 있다", () => {
    renderSelect([
      { id: "1", name: "로그인", group: "서비스A" },
      { id: "2", name: "로그인", group: "서비스B" },
    ]);
    const a = within(screen.getByRole("group", { name: "서비스A" }));
    const b = within(screen.getByRole("group", { name: "서비스B" }));
    expect((a.getByRole("option", { name: "로그인" }) as HTMLOptionElement).value).toBe("1");
    expect((b.getByRole("option", { name: "로그인" }) as HTMLOptionElement).value).toBe("2");
  });
});
