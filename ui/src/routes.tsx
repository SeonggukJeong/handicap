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
      { path: "schedules", element: <SchedulesPage /> },
    ],
  },
]);

export function AppRouter() {
  return <RouterProvider router={router} />;
}
