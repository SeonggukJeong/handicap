import { useEffect, useId, useRef, useState } from "react";
import { Link, Outlet, useLocation } from "react-router-dom";
import { ko } from "../i18n/ko";
import { usePoolWorkers, useVersion } from "../api/hooks";
import { readDesktopShell } from "../api/desktopShell";
import { Badge } from "./ui/Badge";

const NAV_LINK = "hover:text-slate-900 whitespace-nowrap";
// 묶음 하나: 넓은 화면은 한 줄, 좁은 화면(펼친 메뉴)은 묶음 이름 아래로 항목이 감긴다.
const NAV_GROUP = "flex flex-wrap items-center gap-x-4 gap-y-2";

/** 좁은 화면에서만 보이는 묶음 이름. 그룹 접근명(aria-label)과 같은 글자라 읽기 트리에선 뺀다. */
function NavGroupLabel({ children }: { children: string }) {
  return (
    <span
      aria-hidden="true"
      data-nav-group-label=""
      className="lg:hidden basis-full text-xs font-medium text-slate-500"
    >
      {children}
    </span>
  );
}

/** 메뉴 묶음(만들기 · 실행 · 부하기·설정) 사이 구분선. 묶음 이름은 그룹 접근명으로만. */
function NavSeparator() {
  return (
    <span
      aria-hidden="true"
      data-nav-separator=""
      className="hidden lg:block h-4 w-px bg-slate-300"
    />
  );
}

export function Layout() {
  const version = useVersion();
  const pool = usePoolWorkers();
  const desktop = readDesktopShell();
  // 좁은 화면(lg 미만)에서는 메뉴를 「메뉴」 버튼 뒤로 접는다. lg부터는 이 상태와 무관하게 한 줄.
  const [menuOpen, setMenuOpen] = useState(false);
  const navId = useId();
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const { pathname } = useLocation();
  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setMenuOpen(false);
      menuButtonRef.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [menuOpen]);
  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-slate-200 bg-white">
        <div className="max-w-6xl mx-auto px-6 py-4 flex flex-wrap items-center justify-between gap-x-4">
          <div className="flex items-baseline gap-2">
            <Link to="/" className="text-xl font-semibold tracking-tight">
              Handicap
            </Link>
            {version.data && (
              <span className="text-xs text-slate-500" title={ko.common.versionTitle}>
                <span className="sr-only">{ko.common.versionTitle} </span>v{version.data.version}
              </span>
            )}
          </div>
          <button
            ref={menuButtonRef}
            type="button"
            aria-expanded={menuOpen}
            aria-controls={navId}
            onClick={() => setMenuOpen((o) => !o)}
            className="lg:hidden inline-flex items-center gap-1 rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
          >
            {ko.nav.menu}
            <span aria-hidden="true" className="text-xs">
              {menuOpen ? "▴" : "▾"}
            </span>
          </button>
          <nav
            id={navId}
            className={`${menuOpen ? "flex" : "hidden"} lg:flex basis-full lg:basis-auto flex-col lg:flex-row items-start lg:items-center gap-3 lg:gap-4 pt-4 lg:pt-0 text-sm text-slate-600`}
          >
            <div role="group" aria-label={ko.nav.groupBuild} className={NAV_GROUP}>
              <NavGroupLabel>{ko.nav.groupBuild}</NavGroupLabel>
              <Link to="/" className={NAV_LINK}>
                {ko.nav.scenarios}
              </Link>
              <Link to="/templates" className={NAV_LINK}>
                {ko.nav.stepTemplates}
              </Link>
              <Link to="/datasets" className={NAV_LINK}>
                {ko.nav.datasets}
              </Link>
              <Link to="/environments" className={NAV_LINK}>
                {ko.nav.environments}
              </Link>
            </div>
            <NavSeparator />
            <div role="group" aria-label={ko.nav.groupRun} className={NAV_GROUP}>
              <NavGroupLabel>{ko.nav.groupRun}</NavGroupLabel>
              <Link to="/schedules" className={NAV_LINK}>
                {ko.nav.schedules}
              </Link>
              <Link to="/monitors" className={NAV_LINK}>
                {ko.nav.monitors}
              </Link>
            </div>
            <NavSeparator />
            <div role="group" aria-label={ko.nav.groupOps} className={NAV_GROUP}>
              <NavGroupLabel>{ko.nav.groupOps}</NavGroupLabel>
              <Link to="/workers" className={NAV_LINK}>
                {ko.nav.workers}
              </Link>
              <Link to="/settings" className={NAV_LINK}>
                {ko.nav.settings}
              </Link>
              {desktop && (
                <a href={desktop.rolePageUrl} className={NAV_LINK}>
                  {ko.nav.modeSwitch}
                </a>
              )}
              {pool.data?.pool_mode && (
                <Link
                  to="/workers"
                  title={ko.nav.poolChipTitle}
                  className="group rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
                >
                  <Badge tone="accent" className="group-hover:bg-accent-100">
                    {ko.nav.poolChip(pool.data.workers.length)}
                  </Badge>
                </Link>
              )}
            </div>
          </nav>
        </div>
      </header>
      <main className="flex-1 max-w-6xl w-full mx-auto px-6 py-8">
        <Outlet />
      </main>
    </div>
  );
}
