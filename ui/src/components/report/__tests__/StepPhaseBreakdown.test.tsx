import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ko } from "../../../i18n/ko";
import { StepPhaseBreakdown } from "../StepPhaseBreakdown";

const steps = [
  {
    step_id: "s1",
    count: 100,
    error_count: 0,
    status_counts: { "200": 100 },
    p50_ms: 48,
    p95_ms: 60,
    p99_ms: 70,
    wait: { count: 100, p50_ms: 45, p95_ms: 55, p99_ms: 60, max_ms: 61 },
    download: { count: 100, p50_ms: 3, p95_ms: 5, p99_ms: 6, max_ms: 7 },
  },
];
const meta = new Map([["s1", { id: "s1", name: "login", method: "POST", url: "/login" }]]);

const longName = "POST /kramycard/cache/ajax/setupList.json";
const stepsLong = [
  {
    step_id: "s2",
    count: 50,
    error_count: 0,
    status_counts: { "200": 50 },
    p50_ms: 100,
    p95_ms: 120,
    p99_ms: 130,
    wait: { count: 50, p50_ms: 90, p95_ms: 110, p99_ms: 120, max_ms: 125 },
    download: { count: 50, p50_ms: 10, p95_ms: 15, p99_ms: 18, max_ms: 20 },
  },
];
const metaLong = new Map([
  [
    "s2",
    {
      id: "s2",
      name: longName,
      method: "POST",
      url: "/kramycard/cache/ajax/setupList.json",
    },
  ],
]);

describe("StepPhaseBreakdown", () => {
  it("defaults to waterfall and toggles to chips", async () => {
    const user = userEvent.setup();
    render(<StepPhaseBreakdown steps={steps as never} meta={meta} />);
    // waterfall default: role="img" bars are unique to the waterfall view (not chips)
    expect(screen.getByRole("img", { name: /login/ })).toBeInTheDocument();
    // toggle to chips view
    await user.click(screen.getByRole("button", { name: "칩" }));
    expect(screen.getByText(/대기/)).toBeInTheDocument();
  });

  it("칩 보기에도 「스텝」 제목과 같은 이름 구역이 하나뿐", async () => {
    const user = userEvent.setup();
    render(<StepPhaseBreakdown steps={steps as never} meta={meta} sampleTag="통과" />);
    await user.click(screen.getByRole("button", { name: "칩" }));
    expect(screen.getAllByRole("heading", { name: ko.report.stepsHeading })).toHaveLength(1);
    expect(screen.getAllByRole("region", { name: ko.report.perStepStatsLabel })).toHaveLength(1);
    expect(screen.getByRole("button", { name: ko.report.stats.toggleMore })).toBeInTheDocument();
    expect(screen.getByText("통과")).toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();
  });

  it("칩 보기에서만 통계 더 보기 단추가 있고 펼치면 「모든 스텝」 행(summary 전달)", async () => {
    const user = userEvent.setup();
    const summary = {
      count: 100,
      errors: 0,
      rps: 1,
      duration_seconds: 1,
      mean_ms: 50,
      p50_ms: 48,
      p95_ms: 60,
      p99_ms: 70,
    };
    render(<StepPhaseBreakdown steps={steps as never} meta={meta} summary={summary as never} />);
    expect(screen.queryByRole("button", { name: ko.report.stats.toggleMore })).toBeNull();
    await user.click(screen.getByRole("button", { name: "칩" }));
    await user.click(screen.getByRole("button", { name: ko.report.stats.toggleMore }));
    expect(screen.getByText(ko.report.stats.allSteps)).toBeInTheDocument();
  });

  it("waterfall label div has truncate class and title for long step names", () => {
    render(<StepPhaseBreakdown steps={stepsLong as never} meta={metaLong} />);
    // The label div renders the step name as text; bar div has role="img" and is distinct
    const labelEl = screen.getByText(longName);
    expect(labelEl).toHaveClass("truncate");
    expect(labelEl).toHaveAttribute("title", longName);
  });

  it("wholeRunBadge면 막대 접근명이 전체 구간 값임을 말한다", () => {
    const a = render(<StepPhaseBreakdown steps={steps as never} meta={meta} wholeRunBadge />);
    expect(screen.getByRole("img").getAttribute("aria-label")).toContain("전체 구간");
    a.unmount();
    render(<StepPhaseBreakdown steps={steps as never} meta={meta} />);
    expect(screen.getByRole("img").getAttribute("aria-label")).not.toContain("전체 구간");
  });

  describe("retriedStepIds 표지", () => {
    it("막대 보기: 이름 칸 안에 표지, 이름은 truncate+title 유지", () => {
      render(
        <StepPhaseBreakdown steps={steps as never} meta={meta} retriedStepIds={new Set(["s1"])} />,
      );
      const name = screen.getByTitle("login");
      expect(name).toHaveClass("truncate");
      expect(name).not.toHaveClass("w-40");
      const cell = name.closest(".w-40") as HTMLElement;
      expect(cell).not.toBeNull();
      expect(within(cell).getByText("재시도 포함")).toHaveClass("shrink-0");
    });
    it("표 보기로 전환해도 표지가 보인다", async () => {
      const user = userEvent.setup();
      render(
        <StepPhaseBreakdown steps={steps as never} meta={meta} retriedStepIds={new Set(["s1"])} />,
      );
      await user.click(screen.getByRole("button", { name: "칩" }));
      expect(screen.getByText("재시도 포함")).toBeInTheDocument();
    });
    it("표지 없는 행은 기존 DOM 그대로, prop 없음 = 빈 Set", () => {
      const a = render(<StepPhaseBreakdown steps={steps as never} meta={meta} />);
      const cell = screen.getByTitle("login");
      expect(cell).toHaveClass("w-40");
      expect(cell).toHaveClass("truncate");
      const htmlNone = a.container.innerHTML;
      a.unmount();
      const b = render(
        <StepPhaseBreakdown steps={steps as never} meta={meta} retriedStepIds={new Set()} />,
      );
      expect(b.container.innerHTML).toBe(htmlNone);
    });
  });
  describe("loop_split 두 줄 (막대 보기)", () => {
    const split = {
      final: { count: 1200, error_count: 0, p50_ms: 182, p95_ms: 420, p99_ms: 488 },
      retry: { count: 612, error_count: 0, p50_ms: 12, p95_ms: 31, p99_ms: 44 },
    };
    const withSplit = [{ ...steps[0], loop_split: split }];
    const FINAL = "반복을 끝낸 응답 · 1,200건 · 에러 0 · p50 182 · p95 420 · p99 488 ms";
    const RETRY = "재시도로 이어진 응답 · 612건 · 에러 0 · p50 12 · p95 31 · p99 44 ms";
    const lineText = (el: HTMLElement) => el.textContent ?? "";

    it("막대 보기에 글자 두 줄, loop_split 없는 스텝에는 없다", () => {
      const two = [...withSplit, { ...stepsLong[0], step_id: "s3" }];
      const m2 = new Map([...meta, ["s3", { id: "s3", name: "plain", method: "GET", url: "/p" }]]);
      render(<StepPhaseBreakdown steps={two as never} meta={m2} />);
      const finals = screen.getAllByText(
        (_, el) => el?.tagName === "DIV" && lineText(el as HTMLElement) === "└ " + FINAL,
      );
      expect(finals).toHaveLength(1);
      expect(
        screen.getAllByText(
          (_, el) => el?.tagName === "DIV" && lineText(el as HTMLElement) === "└ " + RETRY,
        ),
      ).toHaveLength(1);
      expect(screen.getAllByText(/반복을 끝낸 응답/)).toHaveLength(1);
      expect(screen.getAllByText(/재시도로 이어진 응답/)).toHaveLength(1);
    });

    it("끝낸 응답 0건이면 백분위 자리에 —", () => {
      const zero = [
        {
          ...steps[0],
          loop_split: {
            ...split,
            final: { count: 0, error_count: 0, p50_ms: 0, p95_ms: 0, p99_ms: 0 },
          },
        },
      ];
      render(<StepPhaseBreakdown steps={zero as never} meta={meta} />);
      expect(
        screen.getByText(/반복을 끝낸 응답 · 0건 · 에러 0 · p50 — · p95 — · p99 — ms/),
      ).toBeInTheDocument();
    });

    it("막대 줄 구조는 loop_split 유무와 무관하다", () => {
      const a = render(<StepPhaseBreakdown steps={steps as never} meta={meta} />);
      const rowA = screen.getByRole("img").parentElement as HTMLElement;
      const sigA = [rowA.className, rowA.children.length];
      a.unmount();
      render(<StepPhaseBreakdown steps={withSplit as never} meta={meta} />);
      const rowB = screen.getByRole("img").parentElement as HTMLElement;
      expect([rowB.className, rowB.children.length]).toEqual(sigA);
      // 두 줄은 막대 줄 밖 형제
      expect(within(rowB).queryByText(/반복을 끝낸 응답/)).toBeNull();
    });

    it("loop_split 없는 스텝의 막대 줄은 작업 전 DOM 그대로(wrapper 없음)", () => {
      const two = [steps[0], { ...stepsLong[0], step_id: "s3" }];
      const m2 = new Map([...meta, ["s3", { id: "s3", name: "plain", method: "GET", url: "/p" }]]);
      render(<StepPhaseBreakdown steps={two as never} meta={m2} />);
      const rows = screen.getAllByRole("img").map((i) => i.parentElement as HTMLElement);
      expect(rows).toHaveLength(2);
      for (const r of rows) {
        // git show 504350bb 의 막대 줄 className 그대로
        expect(r.className).toBe("flex items-center gap-3 border-t border-slate-100 py-2");
      }
      expect(rows[0].parentElement).toBe(rows[1].parentElement);
      // 스텝 2개 + 범례 1개, 그 사이 wrapper 없음
      expect(rows[0].parentElement?.children).toHaveLength(3);
    });

    it("「칩」으로 바꾸면 표에 두 줄", async () => {
      const user = userEvent.setup();
      render(<StepPhaseBreakdown steps={withSplit as never} meta={meta} />);
      await user.click(screen.getByRole("button", { name: "칩" }));
      expect(screen.getByRole("table")).toHaveTextContent("반복을 끝낸 응답");
    });

    it("└는 aria-hidden 요소 안", () => {
      render(<StepPhaseBreakdown steps={withSplit as never} meta={meta} />);
      const marks = screen
        .getAllByText("└", { exact: false, ignore: "" })
        .filter((e) => e.tagName === "SPAN");
      expect(marks).toHaveLength(2);
      for (const mk of marks) expect(mk).toHaveAttribute("aria-hidden", "true");
    });
  });

  describe("표본 표지·막대 안내", () => {
    const note =
      "이 보기의 값은 표본을 따르지 않습니다. 표본별 응답 시간은 「칩」 보기에서 봅니다.";

    it("막대 보기: 안내 줄이 있고 표지는 없다 → 칩 보기: 표지가 있고 안내 줄은 없다", async () => {
      const user = userEvent.setup();
      render(<StepPhaseBreakdown steps={steps as never} meta={meta} sampleTag="실패한 요청" />);
      expect(screen.getByText(note)).toBeInTheDocument();
      expect(screen.queryByText("실패한 요청")).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "칩" }));
      expect(screen.getByText("실패한 요청")).toBeInTheDocument();
      expect(screen.queryByText(note)).not.toBeInTheDocument();
    });

    it("sampleTag 없음: 안내 줄도 표지도 없다", async () => {
      const user = userEvent.setup();
      render(<StepPhaseBreakdown steps={steps as never} meta={meta} />);
      expect(screen.queryByText(note)).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "칩" }));
      expect(screen.queryByText("실패한 요청")).not.toBeInTheDocument();
    });

    it("단계 분해 없는 run: 표에 표지가 그대로 간다", () => {
      const plain = [{ ...steps[0], wait: undefined, download: undefined }];
      render(<StepPhaseBreakdown steps={plain as never} meta={meta} sampleTag="실패한 요청" />);
      expect(screen.getByText("실패한 요청")).toBeInTheDocument();
      expect(screen.queryByText(note)).not.toBeInTheDocument();
    });
  });
});
