import { it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TemplatesPage } from "../TemplatesPage";
import * as api from "../../api/stepTemplates";

// Factory form (NOT bare `vi.mock(path)`): a bare auto-mock replaces the
// StepTemplateConflictError constructor body, nulling `.message` → the R6
// banner assertion (`/이미 있습니다/`) would fail. Spread the real module so the
// error class keeps its constructor; mock only the network functions.
// Mirrors ui/src/components/scenario/__tests__/InsertTemplateModal.test.tsx.
vi.mock("../../api/stepTemplates", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../api/stepTemplates")>();
  return {
    ...mod,
    listStepTemplates: vi.fn(),
    getStepTemplate: vi.fn(),
    updateStepTemplate: vi.fn(),
    deleteStepTemplate: vi.fn(),
  };
});

const STEPS =
  "- id: 01ARZ3NDEKTSV4RRFFQ69G5FAV\n  name: login\n  type: http\n  request:\n    method: POST\n    url: /login\n";

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TemplatesPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.resetAllMocks());

it("lists templates (R1)", async () => {
  vi.mocked(api.listStepTemplates).mockResolvedValue([
    {
      id: "t1",
      name: "login-flow",
      description: "로그인",
      step_count: 1,
      created_at: 1765500000000,
      updated_at: 1765500000000,
    },
  ]);
  wrap();
  expect(await screen.findByText("login-flow")).toBeInTheDocument();
});

it("shows empty state when there are no templates (R7)", async () => {
  vi.mocked(api.listStepTemplates).mockResolvedValue([]);
  wrap();
  expect(await screen.findByText(/저장된 스텝 템플릿이 없습니다/)).toBeInTheDocument();
});

it("edits name/description and resends the original steps_yaml (R2)", async () => {
  const user = userEvent.setup();
  vi.mocked(api.listStepTemplates).mockResolvedValue([
    {
      id: "t1",
      name: "login-flow",
      description: "",
      step_count: 1,
      created_at: 1765500000000,
      updated_at: 1765500000000,
    },
  ]);
  vi.mocked(api.getStepTemplate).mockResolvedValue({
    id: "t1",
    name: "login-flow",
    description: "",
    steps_yaml: STEPS,
    step_count: 1,
    created_at: 1765500000000,
    updated_at: 1765500000000,
  });
  vi.mocked(api.updateStepTemplate).mockResolvedValue({
    id: "t1",
    name: "login-v2",
    description: "",
    steps_yaml: STEPS,
    step_count: 1,
    created_at: 1765500000000,
    updated_at: 1765600000000,
  });
  wrap();
  await user.click(await screen.findByRole("button", { name: "편집" }));
  const nameInput = await screen.findByLabelText(/이름/);
  await user.clear(nameInput);
  await user.type(nameInput, "login-v2");
  await user.click(screen.getByRole("button", { name: "저장" }));
  await waitFor(() =>
    expect(api.updateStepTemplate).toHaveBeenCalledWith("t1", {
      name: "login-v2",
      description: "",
      steps_yaml: STEPS, // R2: body resent unchanged
    }),
  );
});

it("renders a read-only step preview (R3)", async () => {
  const user = userEvent.setup();
  vi.mocked(api.listStepTemplates).mockResolvedValue([
    { id: "t1", name: "x", description: "", step_count: 1, created_at: 1, updated_at: 1 },
  ]);
  vi.mocked(api.getStepTemplate).mockResolvedValue({
    id: "t1",
    name: "x",
    description: "",
    steps_yaml: STEPS,
    step_count: 1,
    created_at: 1,
    updated_at: 1,
  });
  wrap();
  await user.click(await screen.findByRole("button", { name: "편집" }));
  expect(await screen.findByText(/login/)).toBeInTheDocument();
  expect(screen.getByText(/POST/)).toBeInTheDocument();
});

it("surfaces a 409 rename conflict as an error banner (R6)", async () => {
  const user = userEvent.setup();
  vi.mocked(api.listStepTemplates).mockResolvedValue([
    { id: "t1", name: "x", description: "", step_count: 1, created_at: 1, updated_at: 1 },
  ]);
  vi.mocked(api.getStepTemplate).mockResolvedValue({
    id: "t1",
    name: "x",
    description: "",
    steps_yaml: STEPS,
    step_count: 1,
    created_at: 1,
    updated_at: 1,
  });
  vi.mocked(api.updateStepTemplate).mockRejectedValue(
    new api.StepTemplateConflictError("t2", "같은 이름의 템플릿이 이미 있습니다"),
  );
  wrap();
  await user.click(await screen.findByRole("button", { name: "편집" }));
  await user.click(screen.getByRole("button", { name: "저장" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/이미 있습니다/);
});

it("deletes with confirm (R4)", async () => {
  const user = userEvent.setup();
  vi.spyOn(window, "confirm").mockReturnValue(true);
  vi.mocked(api.listStepTemplates).mockResolvedValue([
    { id: "t1", name: "x", description: "", step_count: 1, created_at: 1, updated_at: 1 },
  ]);
  vi.mocked(api.deleteStepTemplate).mockResolvedValue(undefined);
  wrap();
  await user.click(await screen.findByRole("button", { name: "삭제" }));
  await waitFor(() => expect(api.deleteStepTemplate).toHaveBeenCalledWith("t1"));
});
