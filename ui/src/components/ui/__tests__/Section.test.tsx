import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { Section } from "../Section";

describe("Section", () => {
  it("번호·제목·badge를 렌더하고 non-collapsible이면 children을 항상 보인다", () => {
    render(
      <Section index={1} title="부하 정의" badge={<span>필수</span>}>
        <input aria-label="vu" />
      </Section>,
    );
    expect(screen.getByText("부하 정의")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByLabelText("vu")).toBeInTheDocument();
  });

  it("collapsible: open=false면 children 미렌더 + hint 노출, 토글 호출", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    const { rerender } = render(
      <Section title="판정·고급" collapsible open={false} onToggle={onToggle} hint="3개 설정됨">
        <input aria-label="slo" />
      </Section>,
    );
    expect(screen.queryByLabelText("slo")).not.toBeInTheDocument();
    expect(screen.getByText("3개 설정됨")).toBeInTheDocument();
    const btn = screen.getByRole("button", { name: /판정·고급/ });
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    await user.click(btn);
    expect(onToggle).toHaveBeenCalledOnce();
    rerender(
      <Section title="판정·고급" collapsible open onToggle={onToggle} hint="3개 설정됨">
        <input aria-label="slo" />
      </Section>,
    );
    expect(screen.getByLabelText("slo")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /판정·고급/ }).getAttribute("aria-expanded")).toBe(
      "true",
    );
  });
});

describe("Section — card variant (R2·R3) + 접힘 hint accname 픽스 (R4)", () => {
  it("card non-collapsible: 카드 fieldset·legend 클래스, children은 fieldset 직속(mt-2 래퍼 없음)", () => {
    render(
      <Section variant="card" title="요청">
        <input aria-label="url" />
      </Section>,
    );
    const fieldset = screen.getByRole("group", { name: "요청" });
    expect(fieldset).toHaveClass(
      "flex",
      "flex-col",
      "gap-2",
      "min-w-0",
      "border",
      "border-slate-200",
      "rounded",
      "p-3",
    );
    expect(fieldset).not.toHaveClass("mb-4");
    const legend = fieldset.querySelector("legend")!;
    expect(legend).toHaveClass("px-1", "text-xs", "font-semibold", "text-slate-600");
    expect(legend).not.toHaveClass("flex");
    expect(screen.getByLabelText("url").parentElement).toBe(fieldset);
  });

  it("card aria-label passthrough: 전달 시 fieldset 속성, 미전달 시 부재 (R3)", () => {
    const { rerender } = render(
      <Section variant="card" title="조건" aria-label="조건">
        <span>c</span>
      </Section>,
    );
    expect(screen.getByRole("group", { name: "조건" })).toHaveAttribute("aria-label", "조건");
    rerender(
      <Section variant="card" title="조건2">
        <span>c</span>
      </Section>,
    );
    expect(screen.getByRole("group", { name: "조건2" })).not.toHaveAttribute("aria-label");
  });

  it("card collapsible: 접힘 시 children 미렌더, legend는 flex, accname은 제목 정확매치, hint는 버튼 밖 (R2·R4)", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(
      <Section
        variant="card"
        collapsible
        open={false}
        onToggle={onToggle}
        title="Headers"
        hint="2개 설정됨"
      >
        <input aria-label="hk" />
      </Section>,
    );
    expect(screen.queryByLabelText("hk")).not.toBeInTheDocument();
    const btn = screen.getByRole("button", { name: "Headers" }); // 정확매치 — hint 미포함(US4)
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    const hintEl = screen.getByText("2개 설정됨");
    expect(btn.contains(hintEl)).toBe(false);
    expect(btn.closest("legend")).toHaveClass("flex", "items-center", "gap-1");
    await user.click(btn);
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("card는 index/badge/divider를 무시한다 (R2)", () => {
    render(
      <Section variant="card" title="T" index={3} badge={<span>B</span>} divider>
        <span>x</span>
      </Section>,
    );
    expect(screen.queryByText("3")).not.toBeInTheDocument();
    expect(screen.queryByText("B")).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "T" })).not.toHaveClass("border-t");
  });

  it("R4: 기본 variant도 접힘 hint가 버튼 밖 — accname 제목 정확매치", () => {
    render(
      <Section title="판정·고급" collapsible open={false} onToggle={() => {}} hint="3개 설정됨">
        <input aria-label="slo" />
      </Section>,
    );
    const btn = screen.getByRole("button", { name: "판정·고급" }); // 픽스 전 accname="판정·고급 3개 설정됨"이라 FAIL
    expect(btn.contains(screen.getByText("3개 설정됨"))).toBe(false);
  });

  it("기본 variant fieldset은 min-w-0 — 좁은 화면에서 안쪽 입력 폭이 페이지를 밀어내지 않는다", () => {
    render(
      <Section title="환경" aria-label="환경 구역">
        <input aria-label="k" />
      </Section>,
    );
    expect(screen.getByRole("group", { name: "환경 구역" })).toHaveClass("min-w-0");
  });
});

describe("Section — card hintAlways·hintTone", () => {
  const card = (props: Record<string, unknown>) =>
    render(
      <Section variant="card" collapsible open title="응답 검증" hint="200만 통과" {...props}>
        <span>본문</span>
      </Section>,
    );
  it("hintAlways면 열린 상태에서도 덧글이 보이고, 묶음 이름은 제목뿐이며 describedby가 덧글을 가리킨다", () => {
    card({ hintAlways: true });
    const hint = screen.getByText("200만 통과");
    const group = screen.getByRole("group", { name: "응답 검증" });
    expect(group.getAttribute("aria-describedby")).toBe(hint.id);
    expect(hint.id).not.toBe("");
    expect(screen.getByRole("button", { name: "응답 검증" })).toBeInTheDocument();
  });
  it("hintAlways 없으면 열린 상태에선 덧글이 없고 aria-describedby도 없다", () => {
    card({});
    expect(screen.queryByText("200만 통과")).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "응답 검증" })).not.toHaveAttribute(
      "aria-describedby",
    );
  });
  it("hintTone 색", () => {
    const { unmount } = card({ hintAlways: true, hintTone: "muted" });
    expect(screen.getByText("200만 통과")).toHaveClass("text-slate-500");
    unmount();
    const r = card({ hintAlways: true, hintTone: "warn" });
    expect(screen.getByText("200만 통과")).toHaveClass("text-amber-800");
    r.unmount();
  });
  it("tone 없으면 지금 색, 닫힌 덧글도 같다", () => {
    card({ open: false });
    expect(screen.getByText("200만 통과")).toHaveClass("text-slate-400");
  });
});
