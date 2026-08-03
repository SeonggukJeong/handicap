import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
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
    // 입력이 init에서 시드되므로 무수정 저장 시 값이 그대로 실린다(구 pass-through의 의미 계승).
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

  it("connect_timeout이 http_timeout 이상이면 저장을 막고 일반 검증 문구를 보인다", async () => {
    const user = userEvent.setup();
    wrap(
      <ScheduleForm
        scenarioOptions={[{ id: "s1", name: "scn" }]}
        onSubmit={vi.fn()}
        submitting={false}
        initial={{
          name: "n",
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
    expect(screen.getByText(ko.validation.connectTimeout)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /저장/ })).toBeDisabled();
  });

  it("US2: 시드된 connect_timeout을 비우고 저장하면 키 자체가 빠진다", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    wrap(
      <ScheduleForm
        scenarioOptions={[{ id: "s1", name: "scn" }]}
        onSubmit={onSubmit}
        submitting={false}
        initial={{
          name: "n",
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
    const input = screen.getByLabelText(ko.loadModel.connectTimeout);
    // 시드 실증 — 빈 칸이면 아래 not.toHaveProperty가 공허 통과한다(auto-seed 공허 클래스).
    expect(input).toHaveValue(3);
    await user.clear(input);
    await user.click(screen.getByRole("button", { name: /저장/ }));
    expect(onSubmit.mock.calls[0][0].profile).not.toHaveProperty("connect_timeout_seconds");
  });

  it("US1: connect_timeout을 입력해 저장하면 숫자로 실린다", async () => {
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
    // 트리거: 기본 daily 02:00 → trigger != null (기존 :54-59 저장 케이스와 동일 전제)
    await user.type(screen.getByLabelText(ko.loadModel.connectTimeout), "5");
    await user.click(screen.getByRole("button", { name: /저장/ }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0].profile.connect_timeout_seconds).toBe(5);
  });

  it("비정수 connect_timeout은 저장을 막는다", () => {
    wrap(
      <ScheduleForm
        scenarioOptions={[{ id: "s1", name: "scn" }]}
        onSubmit={vi.fn()}
        submitting={false}
      />,
    );
    const input = screen.getByLabelText(ko.loadModel.connectTimeout);
    fireEvent.change(input, { target: { value: "1.5" } });
    expect(input).toHaveValue(1.5); // 착지 확인 — sanitize가 지웠으면 아래가 공허해진다
    expect(screen.getByText(ko.validation.connectTimeout)).toBeInTheDocument();
    expect(input).toHaveAttribute("aria-invalid", "true"); // 유일한 인라인 신호 가드(spec §3-1, 리뷰 M2)
    expect(screen.getByRole("button", { name: /저장/ })).toBeDisabled();
  });

  it("connect_timeout 입력에 hint가 aria-describedby로 연결된다", () => {
    wrap(
      <ScheduleForm
        scenarioOptions={[{ id: "s1", name: "scn" }]}
        onSubmit={vi.fn()}
        submitting={false}
      />,
    );
    expect(screen.getByLabelText(ko.loadModel.connectTimeout)).toHaveAccessibleDescription(
      ko.loadModel.connectTimeoutHint,
    );
  });

  it("open 모드 maxInFlight hint가 aria-describedby로 연결된다 (US2, ScheduleForm 통합)", async () => {
    const user = userEvent.setup();
    wrap(
      <ScheduleForm
        scenarioOptions={[{ id: "s1", name: "scn" }]}
        onSubmit={vi.fn()}
        submitting={false}
      />,
    );
    await user.click(screen.getByRole("radio", { name: /도착률 기준/ }));
    expect(screen.getByLabelText(ko.loadModel.maxInFlight)).toHaveAccessibleDescription(
      ko.loadModel.maxInFlightHint,
    );
  });

  it("루프 시나리오 선택 시 loopCap hint가 aria-describedby로 연결된다 (#4, US2)", async () => {
    const user = userEvent.setup();
    const LOOP_YAML = [
      "version: 1",
      "name: loop-scn",
      "steps:",
      '  - id: "01HX0000000000000000000001"',
      "    name: L",
      "    type: loop",
      "    repeat: 2",
      "    do:",
      '      - id: "01HX0000000000000000000002"',
      "        name: ping",
      "        type: http",
      "        request:",
      "          method: GET",
      '          url: "/ping"',
    ].join("\n");
    vi.stubGlobal(
      "fetch",
      vi.fn((url: RequestInfo | URL) =>
        Promise.resolve(
          String(url).includes("/scenarios/s1")
            ? new Response(
                JSON.stringify({
                  id: "s1",
                  name: "loop-scn",
                  yaml: LOOP_YAML,
                  version: 1,
                  created_at: 1754200000000,
                  updated_at: 1754200000000,
                }),
                { status: 200, headers: { "content-type": "application/json" } },
              )
            : new Response(JSON.stringify({ scenarios: [] }), {
                status: 200,
                headers: { "content-type": "application/json" },
              }),
        ),
      ),
    );
    wrap(
      <ScheduleForm
        scenarioOptions={[{ id: "s1", name: "loop-scn" }]}
        onSubmit={vi.fn()}
        submitting={false}
      />,
    );
    await user.selectOptions(screen.getByLabelText(/시나리오/), "s1");
    const input = await screen.findByLabelText(ko.loadModel.loopCap);
    expect(input).toHaveAccessibleDescription(ko.loadModel.loopCapHint);
  });
});
