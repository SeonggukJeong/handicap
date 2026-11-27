import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CompareOverlaySection } from "../CompareOverlaySection";
import type { Report } from "../../../api/schemas";

function rep(id: string): Report {
  return {
    run: { id },
    latency_by_second: [
      { ts_second: 1000, n: 10, mean_us: 5000, p95_us: 8000 },
      { ts_second: 1001, n: 12, mean_us: 6000, p95_us: 9000 },
    ],
    windows: [
      {
        ts_second: 1000,
        n: 0,
        step_id: "s",
        count: 10,
        error_count: 1,
        status_counts: {},
        p50_ms: 4,
        p95_ms: 8,
        p99_ms: 9,
      },
      {
        ts_second: 1001,
        n: 0,
        step_id: "s",
        count: 12,
        error_count: 0,
        status_counts: {},
        p50_ms: 4,
        p95_ms: 9,
        p99_ms: 10,
      },
    ],
  } as unknown as Report;
}
const reports = [rep("aaaaaa111111"), rep("bbbbbb222222")];

describe("CompareOverlaySection", () => {
  it("defaults to req/s + p95 charts (errors off)", () => {
    render(<CompareOverlaySection reports={reports} baselineIdx={0} />);
    expect(screen.getByRole("region", { name: /초당 요청 수/ })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /p95/ })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /초당 에러/ })).not.toBeInTheDocument();
  });

  it("평균 응답 시간은 처음 꺼져 있고, 켜면 그 제목의 그래프가 나온다", async () => {
    const user = userEvent.setup();
    render(<CompareOverlaySection reports={reports} baselineIdx={0} />);
    const box = screen.getByRole("checkbox", { name: "평균 응답 시간 (ms)" });
    expect(box).not.toBeChecked();
    expect(screen.queryByRole("region", { name: /평균 응답 시간/ })).not.toBeInTheDocument();
    await user.click(box);
    expect(screen.getByRole("region", { name: /평균 응답 시간/ })).toBeInTheDocument();
  });

  it("checking errors adds the errors chart; unchecking req/s removes it", async () => {
    const user = userEvent.setup();
    render(<CompareOverlaySection reports={reports} baselineIdx={0} />);
    await user.click(screen.getByRole("checkbox", { name: /초당 에러/ }));
    expect(screen.getByRole("region", { name: /초당 에러/ })).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: /초당 요청 수/ }));
    expect(screen.queryByRole("region", { name: /초당 요청 수/ })).not.toBeInTheDocument();
  });
  it("그래프마다 제 가로 스크롤 상자가 있다(서로 다른 상자)", () => {
    render(<CompareOverlaySection reports={reports} baselineIdx={0} />);
    const a = screen.getByRole("region", { name: /초당 요청 수/ }).closest(".overflow-x-auto");
    const b = screen.getByRole("region", { name: /p95/ }).closest(".overflow-x-auto");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toBe(b);
  });
});
