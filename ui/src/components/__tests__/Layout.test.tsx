import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ko } from "../../i18n/ko";
import { useVersion } from "../../api/hooks";
import { Layout } from "../Layout";

vi.mock("../../api/hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/hooks")>()),
  useVersion: vi.fn(),
}));

function mockVersion(data: { version: string } | undefined) {
  vi.mocked(useVersion).mockReturnValue({ data } as unknown as ReturnType<typeof useVersion>);
}

function renderLayout() {
  render(
    <MemoryRouter>
      <Layout />
    </MemoryRouter>,
  );
}

describe("Layout nav", () => {
  beforeEach(() => {
    mockVersion(undefined);
  });

  it("네비 4개가 한국어 라벨로 올바른 경로를 가리킨다", () => {
    renderLayout();
    expect(screen.getByRole("link", { name: ko.nav.scenarios })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: ko.nav.datasets })).toHaveAttribute(
      "href",
      "/datasets",
    );
    expect(screen.getByRole("link", { name: ko.nav.environments })).toHaveAttribute(
      "href",
      "/environments",
    );
    expect(screen.getByRole("link", { name: ko.nav.schedules })).toHaveAttribute(
      "href",
      "/schedules",
    );
  });
});

describe("Layout 버전 표시", () => {
  it("버전을 받으면 로고 옆에 v<버전>을 렌더한다", () => {
    mockVersion({ version: "9.9.9" });
    renderLayout();
    const badge = screen.getByTitle(ko.common.versionTitle);
    expect(badge).toHaveTextContent(/^v9\.9\.9$/);
    // 로고 접근명이 오염되지 않는다(버전은 <Link> 밖 형제여야 한다)
    expect(screen.getByRole("link", { name: "Handicap" })).not.toHaveTextContent("9.9.9");
  });

  it("버전이 없으면(로딩·실패) 아무것도 렌더하지 않는다", () => {
    mockVersion(undefined);
    renderLayout();
    expect(screen.queryByTitle(ko.common.versionTitle)).not.toBeInTheDocument();
    expect(screen.queryByText(/^v\d/)).not.toBeInTheDocument();
  });
});
