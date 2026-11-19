import { readFileSync } from "node:fs";
import nodePath from "node:path";
import { describe, expect, it } from "vitest";
import { RunSchema, StairLiveSchema, StairReportSchema } from "../../../api/schemas";
import type { EmergencyStopConfig, StairLive, StairStep } from "../../../api/schemas";
import { clockText, reasonTexts, stopLineText } from "../../report/stair/stairFormat";
import {
  liveEmergencyText,
  liveForecastText,
  liveHeadText,
  liveReasonText,
  liveStateLabel,
  liveStepLabel,
  liveStopText,
  liveSummaryText,
} from "../stairLive";

const targets = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];

const empty = { reasons: [], slot_limited: false, ref_fast: false };
const rs = (kind: StairStep["reasons"][number]["kind"], value: number) => ({ kind, value });
const R = (reasons: ReturnType<typeof rs>[], over: Partial<typeof empty> = {}) => ({
  ...empty,
  reasons,
  ...over,
});

function live(over: Partial<StairLive> = {}): StairLive {
  const base: StairLive = {
    current_step: null,
    phase: null,
    step_states: [],
    step_reasons: [],
    last_ok_step: null,
    next_fail_stops: false,
    emergency_now: null,
    suspended_seconds: 0,
    frozen: false,
    stop: null,
    ...over,
  };
  if (over.step_reasons === undefined) {
    base.step_reasons = base.step_states.map(() => ({ ...empty, reasons: [] }));
  }
  return base;
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
    step_reasons: [empty, empty, empty],
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

describe("StairLiveSchema step_reasons", () => {
  it("schema_accepts_step_reasons_and_rejects_missing_or_extra", () => {
    const server = {
      current_step: null,
      phase: null,
      step_states: ["ok", "spike"],
      step_reasons: [empty, R([rs("errors", 0.05)])],
      last_ok_step: null,
      next_fail_stops: false,
      emergency_now: null,
      suspended_seconds: 0,
      frozen: false,
      stop: null,
    };
    expect(StairLiveSchema.safeParse(server).success).toBe(true);
    const without: Partial<typeof server> = { ...server };
    delete without.step_reasons;
    expect(StairLiveSchema.safeParse(without).success).toBe(false);
    expect(
      StairLiveSchema.safeParse({ ...server, step_reasons: [empty, { ...empty, bogus: 1 }] })
        .success,
    ).toBe(false);
  });
});

describe("liveStepLabel", () => {
  it("step_label_reason_texts", () => {
    const l = live({
      step_states: ["ok", "spike", "ok", "saturated", "saturated"],
      step_reasons: [
        empty,
        R([rs("errors", 0.046)]),
        empty,
        R([rs("p99_relative", 3.94)]),
        R([rs("p99_relative", 9.2)], { ref_fast: true }),
      ],
    });
    expect(liveStepLabel(l, 1)).toBe("튄 계단(오류 4.6%)");
    expect(liveStepLabel(l, 3)).toBe("포화(p99 3.9×)");
    expect(liveStepLabel(l, 4)).toBe("포화(p99 5 ms 이상)");
    expect(liveStepLabel(l, 0)).toBe("정상");
  });

  it("step_label_unconfirmed_pending_one_paren", () => {
    const l = live({
      step_states: ["ok", "unconfirmed"],
      step_reasons: [empty, R([rs("errors", 0.046)])],
    });
    expect(liveStepLabel(l, 1)).toBe("실패(오류 4.6%, 다음 계단 확인 중)");
    expect(liveStepLabel({ ...l, stop: stopBase }, 1)).toBe("확인 못 한 실패(오류 4.6%)");
    expect(liveStepLabel({ ...l, frozen: true }, 1)).toBe("확인 못 한 실패(오류 4.6%)");
  });

  it("step_label_after_without_reasons_has_no_parens", () => {
    const l = live({ step_states: ["ok", "saturated", "after"] });
    expect(liveStepLabel(l, 2)).toBe("포화 이후");
    const w = live({
      step_states: ["ok", "saturated", "after"],
      step_reasons: [empty, empty, R([rs("p99_relative", 3.1)])],
    });
    expect(liveStepLabel(w, 2)).toBe("포화 이후(p99 3.1×)");
  });

  it("step_label_max_reasons", () => {
    const four = [
      rs("achieved", 0.5),
      rs("dropped", 1e9),
      rs("errors", 0.046),
      rs("p99_relative", 12345.6),
    ];
    const l = live({ step_states: ["ok", "saturated"], step_reasons: [empty, R(four)] });
    const text = "포화(달성 50.0%, dropped 1,000,000,000, 오류 4.6%, p99 12345.6×)";
    expect(liveStepLabel(l, 1)).toBe(text);
    expect(liveSummaryText(l)).toBe(`1 정상 · 2 ${text}`);
    const slot = live({
      step_states: ["ok", "saturated"],
      step_reasons: [empty, R([rs("achieved", 0.8), rs("dropped", 1e9)], { slot_limited: true })],
    });
    expect(liveStepLabel(slot, 1)).toBe("포화(달성 80.0%, dropped 1,000,000,000, 슬롯 부족 의심)");
  });

  it("missing_step_reasons_is_no_reason", () => {
    const l = live({ step_states: ["ok", "spike"], step_reasons: [] });
    expect(liveStepLabel(l, 1)).toBe("튄 계단");
    expect(liveReasonText(l, 1)).toBeNull();
  });

  it("live_parts_equal_report_parts", () => {
    const file = nodePath.resolve(__dirname, "../../../../../testdata/stair_report_golden.json");
    const report = structuredClone(StairReportSchema.parse(JSON.parse(readFileSync(file, "utf8"))));
    report.steps[0] = { ...report.steps[0], state: "ok", p99_us: 500, reasons: [] };
    report.steps[1] = {
      ...report.steps[1],
      state: "saturated",
      reasons: [rs("errors", 0.046), rs("p99_relative", 3.94)],
      slot_limited: true,
    };
    const l = live({
      step_states: ["ok", "saturated"],
      step_reasons: [
        empty,
        R([rs("errors", 0.046), rs("p99_relative", 3.94)], { slot_limited: true, ref_fast: true }),
      ],
    });
    expect(liveReasonText(l, 1)!.split(", ")).toEqual(reasonTexts(report, report.steps[1]));
    expect(liveReasonText(l, 1)).toContain("p99 5 ms 이상");
  });
});

describe("liveHeadText", () => {
  it("head_waiting_current_and_after_stop", () => {
    expect(liveHeadText(live(), targets)).toBe("첫 데이터 대기 중");
    const cur = live({ current_step: 5, phase: "measure" });
    expect(liveHeadText(cur, targets)).toBe("계단 6/10 (600 req/s) 측정 중");
    expect(liveHeadText({ ...cur, stop: stopBase }, targets)).toBeNull();
    expect(liveHeadText(live({ step_states: ["ok", "ok"] }), targets)).toBeNull();
    expect(liveHeadText(live({ step_states: ["pending", "pending"] }), targets)).toBe(
      "첫 데이터 대기 중",
    );
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
    expect(
      liveSummaryText(
        live({
          step_states: ["ok", "spike", "ok"],
          step_reasons: [empty, R([rs("errors", 0.046)]), empty],
        }),
      ),
    ).toBe("1 정상 · 2 튄 계단(오류 4.6%) · 3 정상");
    expect(
      liveSummaryText(
        live({
          step_states: ["ok", "saturated", "saturated", "after", "after"],
          step_reasons: [
            empty,
            R([rs("errors", 0.046)]),
            R([rs("p99_relative", 3.94)]),
            R([rs("p99_relative", 3.1)]),
            R([rs("errors", 0.1)]),
          ],
        }),
      ),
    ).toBe("1 정상 · 2 포화(오류 4.6%) · 3 포화(p99 3.9×) · 4–5 포화 이후");
    expect(
      liveSummaryText(
        live({
          step_states: ["ok", "unconfirmed", "measuring"],
          step_reasons: [empty, R([rs("errors", 0.046)]), empty],
        }),
      ),
    ).toBe("1 정상 · 2 실패(오류 4.6%, 다음 계단 확인 중)");
    expect(liveSummaryText(live({ step_states: ["measuring", "pending"] }))).toBeNull();
    expect(liveSummaryText(live())).toBeNull();
  });

  it("summary_reason_step_is_alone_even_after_reasonless_same_state", () => {
    expect(
      liveSummaryText(
        live({
          step_states: ["ok", "saturated", "saturated"],
          step_reasons: [empty, empty, R([rs("errors", 0.046)])],
        }),
      ),
    ).toBe("1 정상 · 2 포화 · 3 포화(오류 4.6%)");
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
