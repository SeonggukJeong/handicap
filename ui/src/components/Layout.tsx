import { Link, Outlet } from "react-router-dom";
import { ko } from "../i18n/ko";
import { usePoolWorkers, useVersion } from "../api/hooks";
import { readDesktopShell } from "../api/desktopShell";
import { Badge } from "./ui/Badge";

const NAV_LINK = "hover:text-slate-900";

/** 메뉴 묶음(만들기 · 실행 · 부하기·설정) 사이 구분선. 묶음 이름은 그룹 접근명으로만. */
function NavSeparator() {
  return <span aria-hidden="true" data-nav-separator="" className="h-4 w-px bg-slate-300" />;
}

export function Layout() {
  const version = useVersion();
  const pool = usePoolWorkers();
  const desktop = readDesktopShell();
  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-slate-200 bg-white">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
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
          <nav className="flex items-center gap-4 text-sm text-slate-600">
            <div role="group" aria-label={ko.nav.groupBuild} className="flex items-center gap-4">
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
            <div role="group" aria-label={ko.nav.groupRun} className="flex items-center gap-4">
              <Link to="/schedules" className={NAV_LINK}>
                {ko.nav.schedules}
              </Link>
              <Link to="/monitors" className={NAV_LINK}>
                {ko.nav.monitors}
              </Link>
            </div>
            <NavSeparator />
            <div role="group" aria-label={ko.nav.groupOps} className="flex items-center gap-4">
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
