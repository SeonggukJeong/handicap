import { readFileSync } from "node:fs";
import nodePath from "node:path";
import { describe, expect, it } from "vitest";
import { RunSchema, StairLiveSchema, StairReportSchema } from "../../../api/schemas";
import type { EmergencyStopConfig, StairLive } from "../../../api/schemas";
import { clockText, stopLineText } from "../../report/stair/stairFormat";
import {
  liveEmergencyText,
  liveForecastText,
  liveHeadText,
  liveStateLabel,
  liveStopText,
  liveSummaryText,
} from "../stairLive";

const targets = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];

function live(over: Partial<StairLive> = {}): StairLive {
  return {
    current_step: null,
    phase: null,
    step_states: [],
    last_ok_step: null,
    next_fail_stops: false,
    emergency_now: null,
    suspended_seconds: 0,
    frozen: false,
    stop: null,
    ...over,
  };
}

const em: EmergencyStopConfig = {
  error_rate_pct: 5,
  p99_ms: 2000,
  consecutive_seconds: 3,
  min_requests: 20,
};

const stopBase = {
  kind: "saturation" as const,
  mode: "two_fails" as const,
  failed_steps: [3, 4],
  decided_step: 4,
  judged_through: 4,
  phase: null,
  decided_at_ms: 1_700_000_000_000,
  stopped_at_ms: 1_700_000_003_000,
  emergency: null,
  slot_limited: false,
};

describe("StairLiveSchema", () => {
  const server = {
    current_step: null,
    phase: null,
    step_states: ["ok", "measuring", "pending"],
    last_ok_step: null,
    next_fail_stops: false,
    emergency_now: null,
    suspended_seconds: 0,
    frozen: false,
    stop: null,
  };

  it("schema_accepts_server_shape", () => {
    expect(StairLiveSchema.safeParse(server).success).toBe(true);
    expect(
      StairLiveSchema.safeParse({
        ...server,
        emergency_now: { error_rate: 0.1, p99_us: 5, bad_streak: 1, held: false },
      }).success,
    ).toBe(true);
    expect(StairLiveSchema.safeParse({ ...server, stop: stopBase }).success).toBe(true);
    expect(StairLiveSchema.safeParse({ ...server, step_states: ["bogus"] }).success).toBe(false);
    expect(StairLiveSchema.safeParse({ ...server, extra: 1 }).success).toBe(false);
    const run = {
      id: "r",
      scenario_id: "s",
      scenario_yaml: "",
      status: "running",
      profile: { vus: 1, duration_seconds: 1 },
      env: null,
      started_at: null,
      ended_at: null,
      created_at: 1,
    };
    expect(RunSchema.safeParse(run).success).toBe(true);
    const withLive = RunSchema.safeParse({ ...run, auto_stop_live: server });
    expect(withLive.success).toBe(true);
  });
});

describe("liveHeadText", () => {
  it("head_waiting_current_and_after_stop", () => {
    expect(liveHeadText(live(), targets)).toBe("첫 데이터 대기 중");
    const cur = live({ current_step: 5, phase: "measure" });
    expect(liveHeadText(cur, targets)).toBe("계단 6/10 (600 req/s) 측정 중");
    expect(liveHeadText({ ...cur, stop: stopBase }, targets)).toBeNull();
  });
});

describe("liveSummaryText", () => {
  const pre = ["ok", "ok", "ok", "ok", "unconfirmed", "measuring", "pending"] as const;

  it("summary_groups", () => {
    expect(liveSummaryText(live({ step_states: [...pre] }))).toBe(
      "1–4 정상 · 5 실패(다음 계단 확인 중)",
    );
    expect(liveSummaryText(live({ step_states: [...pre], stop: stopBase }))).toBe(
      "1–4 정상 · 5 확인 못 한 실패",
    );
    expect(liveSummaryText(live({ step_states: [...pre], frozen: true }))).toBe(
      "1–4 정상 · 5 확인 못 한 실패",
    );
    expect(liveSummaryText(live({ step_states: ["ok", "spike", "ok"] }))).toBe(
      "1 정상 · 2 튄 계단 · 3 정상",
    );
    expect(liveSummaryText(live({ step_states: ["ok", "saturated", "saturated", "after"] }))).toBe(
      "1 정상 · 2–3 포화 · 4 포화 이후",
    );
    expect(liveSummaryText(live({ step_states: ["measuring", "pending"] }))).toBeNull();
    expect(liveSummaryText(live())).toBeNull();
  });

  it("state_label_running_only_and_report", () => {
    expect(liveStateLabel("measuring", live())).toBe("측정 중");
    expect(liveStateLabel("pending", live())).toBe("예정");
    expect(liveStateLabel("frozen", live())).toBe("판정 중단");
    expect(liveStateLabel("ok", live())).toBe("정상");
  });
});

describe("liveForecastText", () => {
  it("forecast", () => {
    const five = ["ok", "ok", "ok", "ok", "ok", "measuring"] as const;
    expect(liveForecastText(live({ next_fail_stops: true, step_states: [...five] }))).toBe(
      "→ 6계단이 실패하면 자동 정지",
    );
    expect(liveForecastText(live({ next_fail_stops: false, step_states: [...five] }))).toBeNull();
  });
});

describe("liveEmergencyText", () => {
  it("emergencyLine_off_waiting_held_value", () => {
    expect(liveEmergencyText(live(), null)).toBeNull();
    expect(liveEmergencyText(live(), undefined)).toBeNull();
    expect(liveEmergencyText(live(), em)).toBe("즉시 정지 감시: 첫 판정 대기");
    expect(
      liveEmergencyText(
        live({ emergency_now: { error_rate: 0, p99_us: 0, bad_streak: 0, held: true } }),
        em,
      ),
    ).toBe("즉시 정지 감시: 초당 완료 20개 미만 — 판정 보류 (기준 5% · 2000 ms 초과, 3초 연속)");
    expect(
      liveEmergencyText(
        live({ emergency_now: { error_rate: 0.002, p99_us: 340000, bad_streak: 0, held: false } }),
        em,
      ),
    ).toBe("즉시 정지 감시: 오류율 0.2% · p99 340 ms (기준 5% · 2000 ms 초과, 3초 연속) 나쁜 초 0");
  });

  it("emergencyLine_hidden_after_stop", () => {
    expect(liveEmergencyText(live({ stop: stopBase }), em)).toBeNull();
    expect(
      liveEmergencyText(
        live({
          stop: stopBase,
          emergency_now: { error_rate: 0, p99_us: 0, bad_streak: 0, held: false },
        }),
        em,
      ),
    ).toBeNull();
  });
});

describe("liveStopText", () => {
  it("stopLine_saturation_and_emergency", () => {
    expect(liveStopText(live(), targets)).toBeNull();
    expect(liveStopText(live({ stop: stopBase }), targets)).toBe(
      `5계단(500 req/s) 판정 뒤 자동 정지 — 4·5계단 연속 실패 · ${clockText(stopBase.stopped_at_ms)}`,
    );
    const emStop = {
      ...stopBase,
      kind: "emergency" as const,
      mode: null,
      failed_steps: [],
      decided_step: 2,
      phase: "measure" as const,
      emergency: {
        max_error_rate: 0.12,
        max_p99_us: 1000,
        seconds: 3,
        error_hit: true,
        p99_hit: false,
      },
    };
    expect(liveStopText(live({ stop: emStop, last_ok_step: 1 }), targets)).toBe(
      `3계단(300 req/s) 측정 중 즉시 정지 — 오류율 12.0% 3초 연속 · 마지막 정상 2계단(200 req/s) · ${clockText(emStop.stopped_at_ms)}`,
    );
    expect(liveStopText(live({ stop: emStop }), targets)).toContain("정상 계단 없음");
  });
});

describe("stopLineText last_ok_target", () => {
  it("last_ok_target_missing_from_steps_uses_target_text", () => {
    const file = nodePath.resolve(__dirname, "../../../../../testdata/stair_report_golden.json");
    const st = structuredClone(StairReportSchema.parse(JSON.parse(readFileSync(file, "utf8"))));
    st.headline = { ...st.headline, last_ok_target: 12345 };
    st.auto_stop = {
      stop: {
        ...stopBase,
        kind: "emergency",
        mode: null,
        failed_steps: [],
        phase: "measure",
        emergency: {
          max_error_rate: 0.12,
          max_p99_us: 1000,
          seconds: 3,
          error_hit: true,
          p99_hit: false,
        },
      },
      suspended_seconds: 0,
    };
    expect(stopLineText(st, "T")).toContain("마지막 정상 12345 req/s");
  });
});
