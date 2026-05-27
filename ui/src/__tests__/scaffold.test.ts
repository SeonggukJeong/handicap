import { describe, it, expect } from "vitest";

// Placeholder test so the workspace has at least one passing case from day 1.
// Task 13 of Slice 2 replaces this with real schema + client tests.
describe("vitest scaffold", () => {
  it("runs", () => {
    expect(1 + 1).toBe(2);
  });
});

describe("Layout", () => {
  it.todo("renders Handicap brand link to /");
  it.todo("renders Outlet for routed pages");
});

describe("AppRouter", () => {
  it.todo("renders ScenarioListPage at /");
  it.todo("renders ScenarioNewPage at /scenarios/new");
  it.todo("renders ScenarioEditPage at /scenarios/:id");
  it.todo("renders ScenarioRunsPage at /scenarios/:id/runs");
  it.todo("renders RunDetailPage at /runs/:id");
});

describe("ScenarioSchema", () => {
  it.todo("parses a valid scenario response");
  it.todo("rejects missing required fields");
});

describe("RunSchema", () => {
  it.todo("accepts pending run with null timestamps");
  it.todo("rejects unknown status");
});

describe("api client", () => {
  it.todo("listScenarios GETs /api/scenarios");
  it.todo("createScenario POSTs yaml as JSON");
  it.todo("updateScenario PUTs yaml + version");
  it.todo("throws ApiError with parsed message on 4xx");
});

describe("react-query hooks", () => {
  it.todo("useScenarios caches under ['scenarios']");
  it.todo("useScenario is disabled when id is undefined");
  it.todo("useCreateScenario invalidates scenarios list on success");
  it.todo("useUpdateScenario invalidates list and sets cache for the scenario");
  it.todo("useScenarioRuns is disabled when scenarioId is undefined");
  it.todo("useCreateRun invalidates the scenario's runs list");
  it.todo("useRun polls every 1s until status is terminal");
  it.todo("useRunMetrics polls until paused flag is set");
});

describe("Button primitive", () => {
  it.todo("renders primary variant by default");
  it.todo("applies variant class for secondary and danger");
  it.todo("merges through native button attributes (disabled, onClick)");
});

describe("StatusBadge", () => {
  it.todo("renders status text with color class per RunStatus");
});

describe("ScenarioListPage", () => {
  it.todo("shows loading state while query is pending");
  it.todo("shows error message on query failure");
  it.todo("shows empty-state copy when scenarios is []");
  it.todo("renders a row per scenario with edit and runs links");
});

describe("ScenarioNewPage", () => {
  it.todo("renders starter YAML in the textarea on mount");
  it.todo("disables Create button when yaml is whitespace-only");
  it.todo("disables Create button while mutation is pending");
  it.todo("navigates to /scenarios/:id on successful create");
  it.todo("renders backend error message when mutation fails");
  it.todo("Cancel navigates back to /");
});
