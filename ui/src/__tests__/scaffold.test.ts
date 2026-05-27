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
