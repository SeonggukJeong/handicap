import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { Layout } from "./components/Layout";
import { ScenarioListPage } from "./pages/ScenarioListPage";
import { ScenarioNewPage } from "./pages/ScenarioNewPage";
import { ScenarioEditPage } from "./pages/ScenarioEditPage";
import { ScenarioRunsPage } from "./pages/ScenarioRunsPage";
import { RunDetailPage } from "./pages/RunDetailPage";
import { DatasetsPage } from "./pages/DatasetsPage";
import { EnvironmentsPage } from "./pages/EnvironmentsPage";

const router = createBrowserRouter([
  {
    path: "/",
    element: <Layout />,
    children: [
      { index: true, element: <ScenarioListPage /> },
      { path: "scenarios/new", element: <ScenarioNewPage /> },
      { path: "scenarios/:id", element: <ScenarioEditPage /> },
      { path: "scenarios/:id/runs", element: <ScenarioRunsPage /> },
      { path: "runs/:id", element: <RunDetailPage /> },
      { path: "datasets", element: <DatasetsPage /> },
      { path: "environments", element: <EnvironmentsPage /> },
    ],
  },
]);

export function AppRouter() {
  return <RouterProvider router={router} />;
}
