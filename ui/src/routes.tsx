import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { Layout } from "./components/Layout";
import { ScenarioListPage } from "./pages/ScenarioListPage";
import { ScenarioNewPage } from "./pages/ScenarioNewPage";
import { ScenarioImportPage } from "./pages/ScenarioImportPage";
import { ScenarioEditPage } from "./pages/ScenarioEditPage";
import { ScenarioRunsPage } from "./pages/ScenarioRunsPage";
import { ScenarioComparePage } from "./pages/ScenarioComparePage";
import { RunDetailPage } from "./pages/RunDetailPage";
import { DatasetsPage } from "./pages/DatasetsPage";
import { EnvironmentsPage } from "./pages/EnvironmentsPage";
import { SchedulesPage } from "./pages/SchedulesPage";
import { SettingsPage } from "./pages/SettingsPage";
import { TemplatesPage } from "./pages/TemplatesPage";
import { MonitorListPage } from "./pages/MonitorListPage";
import { MonitorEditPage } from "./pages/MonitorEditPage";
import { MonitorDisplayPage } from "./pages/MonitorDisplayPage";
import { WorkerDashboardPage } from "./pages/WorkerDashboardPage";

const router = createBrowserRouter([
  {
    path: "/",
    element: <Layout />,
    children: [
      { index: true, element: <ScenarioListPage /> },
      { path: "scenarios/new", element: <ScenarioNewPage /> },
      { path: "scenarios/import", element: <ScenarioImportPage /> },
      { path: "scenarios/:id", element: <ScenarioEditPage /> },
      { path: "scenarios/:id/runs", element: <ScenarioRunsPage /> },
      { path: "scenarios/:id/compare", element: <ScenarioComparePage /> },
      { path: "runs/:id", element: <RunDetailPage /> },
      { path: "datasets", element: <DatasetsPage /> },
      { path: "environments", element: <EnvironmentsPage /> },
      { path: "templates", element: <TemplatesPage /> },
      { path: "schedules", element: <SchedulesPage /> },
      { path: "settings", element: <SettingsPage /> },
      { path: "monitors", element: <MonitorListPage /> },
      { path: "monitors/new", element: <MonitorEditPage /> },
      { path: "monitors/:id", element: <MonitorEditPage /> },
      { path: "workers", element: <WorkerDashboardPage /> },
    ],
  },
  // Wall display: outside Layout (no app header / max-width) — spec §7.1.
  { path: "/monitors/:id/display", element: <MonitorDisplayPage /> },
]);

export function AppRouter() {
  return <RouterProvider router={router} />;
}
