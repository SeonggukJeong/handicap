import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RunVuCell } from "../RunVuCell";

const OPEN_HINT = "VU 해당 없음 — 열린 루프(도착률·슬롯 기반)";

describe("RunVuCell", () => {
  it("closed+fixed → 숫자 그대로 (R3)", () => {
    render(<RunVuCell profile={{ vus: 50 }} />);
    expect(screen.getByText("50")).toBeInTheDocument();
  });

  it("closed+curve → '최대 N (곡선)' (R1)", () => {
    render(
      <RunVuCell
        profile={{
          vus: 0,
          vu_stages: [
            { target: 5, duration_seconds: 10 },
            { target: 50, duration_seconds: 20 },
          ],
        }}
      />,
    );
    expect(screen.getByText("최대 50 (곡선)")).toBeInTheDocument();
  });

  it("open-loop → '—' + aria-label/title 힌트 (R2)", () => {
    render(<RunVuCell profile={{ vus: 0, target_rps: 100 }} />);
    const cell = screen.getByLabelText(OPEN_HINT);
    expect(cell).toHaveTextContent("—");
    expect(cell).toHaveAttribute("title", OPEN_HINT);
  });
});
