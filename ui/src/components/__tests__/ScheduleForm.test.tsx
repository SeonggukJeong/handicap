import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ScheduleForm } from "../ScheduleForm";
import type { Profile } from "../../api/schemas";
import * as schedApi from "../../api/schedules";

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  vi.spyOn(schedApi, "previewNext").mockResolvedValue([1]);
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ scenarios: [] }) }),
  );
});

describe("ScheduleForm", () => {
  it("submits a ScheduleInput with name + trigger + profile + enabled", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    wrap(
      <ScheduleForm
        scenarioOptions={[{ id: "s1", name: "scn" }]}
        onSubmit={onSubmit}
        submitting={false}
      />,
    );

    await user.type(screen.getByLabelText(/이름/), "nightly");
    await user.selectOptions(screen.getByLabelText(/시나리오/), "s1");
    // 트리거: daily 02:00 (기본 모드 daily, 기본 time 02:00)
    await user.click(screen.getByRole("button", { name: /저장/ }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const input = onSubmit.mock.calls[0][0];
    expect(input.name).toBe("nightly");
    expect(input.scenario_id).toBe("s1");
    expect(input.trigger).toEqual({ kind: "cron", cron_expr: "0 2 * * *" });
    expect(input.enabled).toBe(true);
    expect(input.profile.vus).toBeGreaterThanOrEqual(1);
  });

  it("disables 저장 until name + scenario + valid trigger are set", () => {
    wrap(
      <ScheduleForm
        scenarioOptions={[{ id: "s1", name: "scn" }]}
        onSubmit={vi.fn()}
        submitting={false}
      />,
    );
    expect(screen.getByRole("button", { name: /저장/ })).toBeDisabled();
  });

  it("prefills fields in edit mode (name, enabled, cron trigger)", async () => {
    const onSubmit = vi.fn();
    wrap(
      <ScheduleForm
        scenarioOptions={[{ id: "s1", name: "scn" }]}
        onSubmit={onSubmit}
        submitting={false}
        initial={{
          name: "existing",
          scenario_id: "s1",
          profile: {
            vus: 3,
            duration_seconds: 10,
            ramp_up_seconds: 0,
            loop_breakdown_cap: 256,
            http_timeout_seconds: 30,
          } as Profile,
          env: { BASE_URL: "https://x" },
          trigger: { kind: "cron", cron_expr: "0 2 * * *" },
          enabled: false,
        }}
      />,
    );
    expect((screen.getByLabelText(/이름/) as HTMLInputElement).value).toBe("existing");
    expect((screen.getByLabelText(/시나리오/) as HTMLSelectElement).value).toBe("s1");
    // enabled=false → checkbox unchecked
    const enabledCheckbox = screen.getByRole("checkbox", { name: /활성화/ });
    expect(enabledCheckbox).not.toBeChecked();
  });
});
