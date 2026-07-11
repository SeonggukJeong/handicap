import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { PageSection } from "../PageSection";

describe("PageSection", () => {
  it("메인 캐넌: region aria-label + 기본 mb-6 + h3 정확 클래스 + children", () => {
    render(
      <PageSection ariaLabel="요약 섹션" title="요약">
        <p>내용</p>
      </PageSection>,
    );
    const section = screen.getByRole("region", { name: "요약 섹션" });
    expect(section.tagName).toBe("SECTION");
    expect(section.className).toBe("mb-6");
    const h = screen.getByRole("heading", { level: 3, name: "요약" });
    expect(h.className).toBe("text-lg font-semibold mb-2");
    expect(screen.getByText("내용")).toBeInTheDocument();
  });

  it("sub 캐넌: h4 + 정확 클래스 (h3 부재)", () => {
    render(<PageSection sub ariaLabel="차트 섹션" title="RPS" />);
    const h = screen.getByRole("heading", { level: 4, name: "RPS" });
    expect(h.className).toBe("text-sm font-semibold text-slate-700 mb-2");
    expect(screen.queryByRole("heading", { level: 3 })).not.toBeInTheDocument();
  });

  it("className은 통째 교체 — mt-8 전달 시 mb-6 부재", () => {
    render(<PageSection ariaLabel="비교" title="비교" className="mt-8" />);
    expect(screen.getByRole("region", { name: "비교" }).className).toBe("mt-8");
  });

  it('className=""는 빈 class로 렌더 (mb-6 오주입 금지 — ?? 시맨틱)', () => {
    render(<PageSection ariaLabel="레이턴시" title="레이턴시" className="" />);
    expect(screen.getByRole("region", { name: "레이턴시" }).className).toBe("");
  });

  it("title은 ReactNode 수용 (함수형 ko 키 호출 결과 등)", () => {
    render(<PageSection ariaLabel="워커" title={<>워커별 분해 (2개 워커)</>} />);
    expect(
      screen.getByRole("heading", { level: 3, name: "워커별 분해 (2개 워커)" }),
    ).toBeInTheDocument();
  });
});
