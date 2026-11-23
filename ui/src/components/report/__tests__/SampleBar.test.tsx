import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Report, ReportSampleName } from "../../../api/schemas";
import { ko } from "../../../i18n/ko";
import { MixedSampleBadge } from "../MixedSampleBadge";
import { SampleBar } from "../SampleBar";

const win = {
  t_unix_s: 1,
  count: 5,
  errors: 0,
  rps: 5,
  p50_ms: 1,
  p95_ms: 2,
  p99_ms: 3,
  max_ms: 4,
} as unknown as Report["windows"][number];

const t = ko.report.sample;

function bar(
  over: Partial<Pick<Report, "windows" | "sample">>,
  requested?: ReportSampleName,
) {
  return render(<SampleBar report={{ windows: [win], ...over }} requested={requested} />);
}

describe("SampleBar", () => {
  it("나뉜 run: 단추 셋, 요청한 표본이 눌려 있다", async () => {
    const user = userEvent.setup();
    bar({ sample: { selected: "passed", default: "passed", split: true } });
    expect(screen.getByText(t.barLabel)).toBeInTheDocument();
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    expect(screen.getByRole("radio", { name: t.passed })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText(t.passedHint)).toBeInTheDocument();
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: t.helpLabel }));
    expect(screen.getByRole("note")).toHaveTextContent(t.passedHelp);
  });

  it("실패한 요청을 받았고 요청했다: 설명 = failedHint, 안내 상자", () => {
    bar({ sample: { selected: "failed", default: "passed", split: true } }, "failed");
    expect(screen.getByRole("radio", { name: t.failed })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText(t.failedHint)).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent(
      "응답 시간 숫자만 실패한 요청 기준으로 바꿔 보여 줍니다. 판정·인사이트·계단 표는 바뀌지 않습니다. 인쇄·CSV·XLSX는 통과한 요청 기준입니다.",
    );
  });

  it("불러오는 중: 눌린 단추는 요청을 따르고 설명·상자는 받은 표본을 따른다", () => {
    const { unmount } = bar(
      { sample: { selected: "passed", default: "passed", split: true } },
      "failed",
    );
    expect(screen.getByRole("radio", { name: t.failed })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: t.passed })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText(t.passedHint)).toBeInTheDocument();
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
    unmount();
    bar({ sample: { selected: "failed", default: "passed", split: true } });
    expect(screen.getByRole("radio", { name: t.passed })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText(t.failedHint)).toBeInTheDocument();
    expect(screen.getByRole("note")).toBeInTheDocument();
  });

  it("pending이면 radiogroup이 aria-busy", () => {
    render(
      <SampleBar
        report={{
          windows: [win],
          sample: { selected: "passed", default: "passed", split: true },
        }}
        pending
      />,
    );
    expect(screen.getByRole("radiogroup")).toHaveAttribute("aria-busy", "true");
  });

  it("단추를 누르면 onSelect(그 표본)", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <SampleBar
        report={{
          windows: [win],
          sample: { selected: "passed", default: "passed", split: true },
        }}
        onSelect={onSelect}
      />,
    );
    await user.click(screen.getByRole("radio", { name: t.allShort }));
    expect(onSelect).toHaveBeenCalledWith("all");
  });

  it("(?)를 누르면 세 표본 이름과 언제·무엇을 보는지·통과 정의", async () => {
    const user = userEvent.setup();
    bar({ sample: { selected: "passed", default: "passed", split: true } });
    await user.click(screen.getByRole("button", { name: t.helpLabel }));
    const panel = screen.getByRole("note");
    for (const name of [t.passed, t.failed, t.allShort]) {
      expect(within(panel).getByText(name)).toBeInTheDocument();
    }
    expect(panel).toHaveTextContent(t.whenFailed);
    expect(panel).toHaveTextContent(t.lookAll);
    expect(panel).toHaveTextContent(t.passedHelp);
  });

  it("radio마다 접근 가능한 설명에 「언제 고르는지」가 들어 있다", () => {
    bar({ sample: { selected: "passed", default: "passed", split: true } });
    expect(screen.getByRole("radio", { name: t.passed })).toHaveAccessibleDescription(
      expect.stringContaining(t.whenPassed),
    );
    expect(screen.getByRole("radio", { name: t.failed })).toHaveAccessibleDescription(
      expect.stringContaining(t.whenFailed),
    );
    expect(screen.getByRole("radio", { name: t.allShort })).toHaveAccessibleDescription(
      expect.stringContaining(t.whenAll),
    );
  });

  it("radio마다 접근 가능한 설명은 「언제」와 「무엇」을 공백 하나로 잇는다", () => {
    bar({ sample: { selected: "passed", default: "passed", split: true } });
    const pairs = [
      [t.passed, t.whenPassed, t.lookPassed],
      [t.failed, t.whenFailed, t.lookFailed],
      [t.allShort, t.whenAll, t.lookAll],
    ] as const;
    for (const [name, when, look] of pairs) {
      expect(screen.getByRole("radio", { name })).toHaveAccessibleDescription(`${when} ${look}`);
    }
  });

  it("나눌 수 없는 run은 requested가 failed여도 단추·상자 없이 그대로(R14)", () => {
    bar({ sample: { selected: "all", default: "all", split: false } }, "failed");
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.getByText(t.all)).toBeInTheDocument();
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });

  it("옛 run(sample 없음): 「모든 요청 (실패한 요청 포함)」 표지 + 설명", () => {
    bar({});
    expect(screen.getByText(t.all)).toBeInTheDocument();
    expect(screen.getByText(t.allHint)).toBeInTheDocument();
    expect(screen.queryByText(t.passed)).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("나눌 수 없는 run(sample.split=false)도 「모든 요청」", () => {
    bar({ sample: { selected: "all", default: "all", split: false } });
    expect(screen.getByText(t.all)).toBeInTheDocument();
    expect(screen.queryByText(t.passed)).not.toBeInTheDocument();
  });

  it("창이 없으면 아무것도 그리지 않는다", () => {
    const { container } = render(
      <SampleBar
        report={{
          windows: [],
          sample: { selected: "passed", default: "passed", split: true },
        }}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe("SampleBar (?) 도움말 모양", () => {
  it("둘째 줄부터 mt-1.5, 이름은 slate-900", async () => {
    const user = userEvent.setup();
    bar({ sample: { selected: "passed", default: "passed", split: true } });
    await user.click(screen.getByRole("button", { name: t.helpLabel }));
    const lines = Array.from(screen.getByRole("note").children);
    expect(lines).toHaveLength(4);
    expect(lines[0]).not.toHaveClass("mt-1.5");
    for (const l of lines.slice(1)) expect(l).toHaveClass("mt-1.5");
    expect(lines[0].querySelector("b")).toHaveClass("text-slate-900");
  });
});

describe("MixedSampleBadge", () => {
  it("글자는 「실패 포함」이고 도움말 버튼이 이유를 읽어 준다", async () => {
    const user = userEvent.setup();
    render(<MixedSampleBadge />);
    expect(screen.getByText(t.mixedBadge)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: t.mixedHelpLabel }));
    expect(screen.getByRole("note")).toHaveTextContent(t.mixedTitle);
  });
});
