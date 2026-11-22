import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ReportHeader } from "../components/ReportHeader";
import type { PrintDoc } from "../buildPrintDoc";

const NOTE =
  "요약·판정에는 준비 스텝이 들어 있지 않습니다. 본 스텝은 준비 스텝을 마친 상태에서 측정했습니다.";

function docWith(meta: Partial<PrintDoc["meta"]>): PrintDoc {
  return {
    title: "t",
    shortId: "abc",
    createdDate: "2026-01-01",
    meta: { targets: "a", window: "b", load: "c", ident: "d", ...meta },
  } as PrintDoc;
}

describe("ReportHeader 준비 스텝 안내", () => {
  it("setupNote가 있으면 격자 밖 전체 폭 줄로 그린다", () => {
    const { container } = render(<ReportHeader doc={docWith({ setupNote: NOTE })} />);
    const line = screen.getByText(NOTE);
    expect(line.closest(".p-meta")).toBeNull();
    expect(container.querySelector(".p-meta")?.children).toHaveLength(4);
  });

  it("없으면 줄이 없다", () => {
    render(<ReportHeader doc={docWith({})} />);
    expect(screen.queryByText(NOTE)).not.toBeInTheDocument();
  });
});
