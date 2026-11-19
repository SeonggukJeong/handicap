import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ko } from "../../i18n/ko";
import { usePoolWorkers, useVersion } from "../../api/hooks";
import type { PoolWorkerSummary } from "../../api/pool";
import { Layout } from "../Layout";

vi.mock("../../api/hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/hooks")>()),
  useVersion: vi.fn(),
  usePoolWorkers: vi.fn(),
}));

function mockPool(data: { pool_mode: boolean; workers: PoolWorkerSummary[] }) {
  vi.mocked(usePoolWorkers).mockReturnValue({
    data: { ...data, heartbeat_interval_seconds: 5, stale_timeout_seconds: 15 },
  } as unknown as ReturnType<typeof usePoolWorkers>);
}

function w(id: string): PoolWorkerSummary {
  return {
    worker_id: id,
    hostname: `host-${id}`,
    capacity_vus: 100,
    busy: false,
    run_id: null,
    last_seen_secs_ago: 1,
    drained: false,
    capacity_override: null,
    label: null,
    stable: true,
  };
}

beforeEach(() => {
  mockPool({ pool_mode: false, workers: [] });
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__HANDICAP_DESKTOP__;
});

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

describe("Layout 메뉴 묶음 (사용자 요청 2026-11-20)", () => {
  beforeEach(() => {
    mockVersion(undefined);
  });

  function navLinkNames(scope: HTMLElement) {
    return within(scope)
      .getAllByRole("link")
      .map((a) => a.textContent);
  }

  it("메뉴가 만들기 → 실행 → 부하기·설정 순서로 놓인다", () => {
    renderLayout();
    const nav = screen.getByRole("navigation");
    expect(navLinkNames(nav)).toEqual([
      "시나리오",
      "스텝 템플릿",
      "데이터셋",
      "환경",
      "스케줄",
      "모니터",
      "워커",
      "운영 상한",
    ]);
  });

  it("세 묶음이 이름 붙은 그룹이고 각자 제 메뉴만 담는다", () => {
    renderLayout();
    const groups = within(screen.getByRole("navigation")).getAllByRole("group");
    expect(groups.map((g) => g.getAttribute("aria-label"))).toEqual([
      "만들기",
      "실행",
      "부하기·설정",
    ]);
    expect(navLinkNames(groups[0])).toEqual(["시나리오", "스텝 템플릿", "데이터셋", "환경"]);
    expect(navLinkNames(groups[1])).toEqual(["스케줄", "모니터"]);
    expect(navLinkNames(groups[2])).toEqual(["워커", "운영 상한"]);
  });

  it("묶음 사이에만 구분선이 하나씩 있다 (묶음 안에는 없다)", () => {
    renderLayout();
    const nav = screen.getByRole("navigation");
    const kids = Array.from(nav.children);
    const isSep = (el: Element) => el.getAttribute("data-nav-separator") === "";
    expect(kids.map((el) => (isSep(el) ? "|" : el.getAttribute("role")))).toEqual([
      "group",
      "|",
      "group",
      "|",
      "group",
    ]);
    for (const el of kids.filter(isSep)) {
      expect(el).toHaveAttribute("aria-hidden", "true");
    }
    for (const g of within(nav).getAllByRole("group")) {
      expect(g.querySelector("[data-nav-separator]")).toBeNull();
    }
  });

  it("데스크톱·풀 모드면 「모드 전환」과 칩이 부하기·설정 묶음 끝에 붙는다", () => {
    (window as unknown as Record<string, unknown>).__HANDICAP_DESKTOP__ = {
      rolePageUrl: "tauri://localhost/role.html",
    };
    mockPool({ pool_mode: true, workers: [w("a"), w("b")] });
    renderLayout();
    const ops = within(screen.getByRole("navigation")).getByRole("group", {
      name: "부하기·설정",
    });
    expect(navLinkNames(ops)).toEqual(["워커", "운영 상한", "모드 전환", "서버 · 부하기 2대"]);
  });
});

describe("Layout 버전 표시", () => {
  it("버전을 받으면 로고 옆에 v<버전>을 렌더한다", () => {
    mockVersion({ version: "9.9.9" });
    renderLayout();
    const badge = screen.getByTitle(ko.common.versionTitle);
    expect(badge).toHaveTextContent(new RegExp(`^${ko.common.versionTitle} v9\\.9\\.9$`));
    // 로고 접근명이 오염되지 않는다(버전은 <Link> 밖 형제여야 한다)
    expect(screen.getByRole("link", { name: "Handicap" })).not.toHaveTextContent("9.9.9");
  });

  it("버전이 없으면(로딩·실패) 아무것도 렌더하지 않는다", () => {
    mockVersion(undefined);
    renderLayout();
    expect(screen.queryByTitle(ko.common.versionTitle)).not.toBeInTheDocument();
    expect(screen.queryByText(/^v\d/)).not.toBeInTheDocument();
  });

  it("버전 배지: AA 대비 slate-500 + title 존치 + sr-only 맥락 접두 (a11y-bundle D)", () => {
    mockVersion({ version: "9.9.9" });
    renderLayout();
    const badge = screen.getByTitle(ko.common.versionTitle);
    expect(badge.className).toContain("text-slate-500");
    expect(badge.className).not.toContain("text-slate-400");
    expect(badge.querySelector("span")).toHaveClass("sr-only");
    expect(badge).toHaveTextContent(new RegExp(`^${ko.common.versionTitle} v9\\.9\\.9$`));
  });
});

describe("Layout 풀 칩·모드 전환", () => {
  beforeEach(() => {
    mockVersion(undefined);
  });

  it("풀 모드가 아니면 칩이 없다", () => {
    renderLayout();
    expect(screen.queryByText(/서버 · 부하기/)).toBeNull();
  });

  it("풀 모드면 연결된 워커 수로 칩을 보이고 /workers로 간다", () => {
    mockPool({ pool_mode: true, workers: [w("a"), w("b")] });
    renderLayout();
    expect(screen.getByRole("link", { name: "서버 · 부하기 2대" })).toHaveAttribute(
      "href",
      "/workers",
    );
  });

  it("풀 칩 링크는 키보드 초점 고리와 마우스 올림 표시가 있다", () => {
    mockPool({ pool_mode: true, workers: [w("a")] });
    renderLayout();
    const chip = screen.getByRole("link", { name: "서버 · 부하기 1대" });
    expect(chip).toHaveClass(
      "rounded",
      "focus-visible:outline-none",
      "focus-visible:ring-2",
      "focus-visible:ring-accent-500",
    );
    // 이웃 네비 링크(hover:text-slate-900)처럼 올리면 진해진다 — 배지 색이 자기 글자색을 가지므로 배경으로.
    expect(chip.firstElementChild).toHaveClass("group-hover:bg-accent-100");
    expect(chip).toHaveClass("group");
  });

  it("데스크톱 표지가 없으면 「모드 전환」 링크가 없다", () => {
    renderLayout();
    expect(screen.queryByRole("link", { name: "모드 전환" })).toBeNull();
  });

  it("표지가 있으면 「모드 전환」 링크가 셸 화면을 가리킨다", () => {
    (window as unknown as Record<string, unknown>).__HANDICAP_DESKTOP__ = {
      rolePageUrl: "tauri://localhost/role.html",
    };
    renderLayout();
    expect(screen.getByRole("link", { name: "모드 전환" })).toHaveAttribute(
      "href",
      "tauri://localhost/role.html",
    );
  });
});
