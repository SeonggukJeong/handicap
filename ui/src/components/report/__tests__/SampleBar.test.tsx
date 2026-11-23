import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { Report } from "../../../api/schemas";
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

function bar(over: Partial<Pick<Report, "windows" | "sample">>) {
  return render(<SampleBar report={{ windows: [win], ...over }} />);
}

describe("SampleBar", () => {
  it("나뉜 run: 「통과한 요청」 표지 + 설명 + 도움말, 전환 단추는 없다", async () => {
    const user = userEvent.setup();
    bar({ sample: { selected: "passed", default: "passed", split: true } });
    expect(screen.getByText(t.barLabel)).toBeInTheDocument();
    expect(screen.getByText(t.passed)).toBeInTheDocument();
    expect(screen.getByText(t.passedHint)).toBeInTheDocument();
    expect(screen.queryByText(t.all)).not.toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: t.helpLabel }));
    expect(screen.getByRole("note")).toHaveTextContent(t.passedHelp);
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

describe("MixedSampleBadge", () => {
  it("글자는 「실패 포함」이고 도움말 버튼이 이유를 읽어 준다", async () => {
    const user = userEvent.setup();
    render(<MixedSampleBadge />);
    expect(screen.getByText(t.mixedBadge)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: t.mixedHelpLabel }));
    expect(screen.getByRole("note")).toHaveTextContent(t.mixedTitle);
  });
});
