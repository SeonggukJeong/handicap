import { Link, Outlet } from "react-router-dom";

export function Layout() {
  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-slate-200 bg-white">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link to="/" className="text-xl font-semibold tracking-tight">
            Handicap
          </Link>
          <nav className="flex gap-4 text-sm text-slate-600">
            <Link to="/" className="hover:text-slate-900">
              Scenarios
            </Link>
            <Link to="/datasets" className="hover:text-slate-900">
              Datasets
            </Link>
            <Link to="/environments" className="hover:text-slate-900">
              Environments
            </Link>
            <Link to="/schedules" className="hover:text-slate-900">
              Schedules
            </Link>
          </nav>
        </div>
      </header>
      <main className="flex-1 max-w-6xl w-full mx-auto px-6 py-8">
        <Outlet />
      </main>
    </div>
  );
}
