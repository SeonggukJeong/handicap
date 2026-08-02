import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ScheduleForm } from "../ScheduleForm";
import type { Profile } from "../../api/schemas";
import * as schedApi from "../../api/schedules";
import { ko } from "../../i18n/ko";

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
  it("HTTP 타임아웃이 invalid면 저장이 비활성이고 사유 블록이 보인다", async () => {
    const user = userEvent.setup();
    wrap(
      <ScheduleForm
        scenarioOptions={[{ id: "s1", name: "scn" }]}
        onSubmit={vi.fn()}
        submitting={false}
      />,
    );
    const timeout = screen.getByLabelText(/HTTP 타임아웃/);
    await user.clear(timeout);
    await user.type(timeout, "601");
    expect(screen.getByRole("button", { name: /저장/ })).toBeDisabled();
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(/HTTP 타임아웃은 1 ~ 600초 사이/);
  });

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

  it("vu_stages 든 initial → closed+curve 역도출 + stage 행·rampDown 시드 (Task 8)", () => {
    wrap(
      <ScheduleForm
        scenarioOptions={[{ id: "s1", name: "scn" }]}
        onSubmit={vi.fn()}
        submitting={false}
        initial={{
          name: "nightly",
          scenario_id: "s1",
          profile: {
            vus: 0,
            duration_seconds: 0,
            ramp_up_seconds: 0,
            loop_breakdown_cap: 256,
            http_timeout_seconds: 30,
            vu_stages: [{ target: 7, duration_seconds: 11 }],
            ramp_down: "immediate",
          } as Profile,
          env: {},
          trigger: { kind: "cron", cron_expr: "0 2 * * *" },
          enabled: true,
        }}
      />,
    );
    expect(screen.getByRole("radio", { name: "곡선" })).toBeChecked();
    expect(screen.getByRole("radio", { name: /사용자 수 기준/ })).toBeChecked();
    expect(screen.getByLabelText("스테이지 0 목표")).toHaveValue(7);
    expect(screen.getByRole("radio", { name: /즉시 줄이기/ })).toBeChecked();
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

  it("SLO section toggles via aria-expanded (Section collapsible 전환 후도 보존)", async () => {
    wrap(
      <ScheduleForm
        scenarioOptions={[{ id: "s1", name: "scn" }]}
        onSubmit={vi.fn()}
        submitting={false}
      />,
    );
    const toggle = screen.getByRole("button", { name: /SLO 기준/ });
    expect(toggle).toHaveAttribute("aria-expanded");
  });

  // ── §B9 리뷰 Should-fix: gracefulCapInvalid 게이트 회귀 테스트 (RunDialog.test.tsx
  // 미러 — RunDialog는 동일 게이트에 전용 테스트가 있으나 ScheduleForm엔 없었다) ──────
  it("closed+curve: 저장 disabled when graceful cap is invalid (gracefulCapInvalid 게이트, §B9)", async () => {
    const user = userEvent.setup();
    wrap(
      <ScheduleForm
        scenarioOptions={[{ id: "s1", name: "scn" }]}
        onSubmit={vi.fn()}
        submitting={false}
      />,
    );
    // closed가 기본 — 곡선(rateMode)만 전환하면 closed+curve+graceful(rampDown 기본값)
    await user.click(screen.getByRole("radio", { name: "곡선" }));
    const capInput = screen.getByLabelText(/느슨한 감축 상한/);
    await user.type(capInput, "0");
    expect(screen.getByRole("button", { name: /저장/ })).toBeDisabled();
  });

  // ── B4: ScheduleForm은 추천/바로실행 프레이밍을 렌더하지 않는다 (R6/R10) ────────
  it("ScheduleForm은 추천/바로실행 프레이밍을 안 보인다", () => {
    wrap(
      <ScheduleForm
        scenarioOptions={[{ id: "s1", name: "scn" }]}
        onSubmit={vi.fn()}
        submitting={false}
      />,
    );
    expect(
      screen.queryByText("기본값이 채워져 있어 바로 실행할 수 있습니다 — 대상에 맞게 조정하세요."),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("추천")).not.toBeInTheDocument();
  });

  it("저장된 connect_timeout_seconds가 편집 저장 라운드트립에서 보존된다", async () => {
    // pass-through가 없으면 buildProfileShared 재구성 과정에서 조용히 사라진다.
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    wrap(
      <ScheduleForm
        scenarioOptions={[{ id: "s1", name: "scn" }]}
        onSubmit={onSubmit}
        submitting={false}
        initial={{
          name: "nightly",
          scenario_id: "s1",
          profile: {
            vus: 1,
            duration_seconds: 5,
            ramp_up_seconds: 0,
            loop_breakdown_cap: 256,
            http_timeout_seconds: 30,
            connect_timeout_seconds: 3,
          } as Profile,
          env: {},
          trigger: { kind: "cron", cron_expr: "0 2 * * *" },
          enabled: true,
        }}
      />,
    );
    await user.click(screen.getByRole("button", { name: /저장/ }));
    expect(onSubmit.mock.calls[0][0].profile.connect_timeout_seconds).toBe(3);
  });

  it("저장된 connect_timeout이 http_timeout 이상이면 저장을 막고 저장값을 밝힌다", async () => {
    // 이 폼엔 connect_timeout 입력이 없다 — 막기만 하면 사용자가 얼마로 올려야 할지
    // 알 수 없으므로 저장값(초)을 문구로 노출해야 한다.
    const user = userEvent.setup();
    wrap(
      <ScheduleForm
        scenarioOptions={[{ id: "s1", name: "scn" }]}
        onSubmit={vi.fn()}
        submitting={false}
        initial={{
          name: "nightly",
          scenario_id: "s1",
          profile: {
            vus: 1,
            duration_seconds: 5,
            ramp_up_seconds: 0,
            loop_breakdown_cap: 256,
            http_timeout_seconds: 30,
            connect_timeout_seconds: 5,
          } as Profile,
          env: {},
          trigger: { kind: "cron", cron_expr: "0 2 * * *" },
          enabled: true,
        }}
      />,
    );
    await user.clear(screen.getByLabelText(ko.loadModel.httpTimeout));
    await user.type(screen.getByLabelText(ko.loadModel.httpTimeout), "3");
    // http_timeout=3 자체는 유효(1..600)하고 hasLoop=false·bindingBlock.ok=true라
    // 이 사유가 목록의 유일한 항이다 = 비혼동.
    expect(screen.getByText(ko.validation.connectTimeoutStored(5))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /저장/ })).toBeDisabled();
  });
});
