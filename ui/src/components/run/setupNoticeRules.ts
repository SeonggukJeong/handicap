import type { DataBinding } from "../../api/schemas";
import type { Scenario } from "../../scenario/model";
import { setupSteps } from "../../scenario/model";
import { scanFlowVars } from "../../scenario/scanVars";

export type SetupNotice =
  | { kind: "burst" }
  | { kind: "per_slot"; slots: number }
  | { kind: "shared_rows"; rows: number; units: number; unit: "vu" | "slot" }
  | { kind: "not_per_vu"; vars: string[] };

export interface SetupNoticeInput {
  scenario: Scenario | null;
  loadModel: "closed" | "open";
  rateMode: "fixed" | "curve" | "stair"; // 폼의 타입 그대로. stair는 open-loop 전용
  vus: number | null; // VU 고정
  rampUpSeconds: number | null;
  vuPeak: number | null; // VU 곡선 최고점
  maxInFlight: number | null; // open-loop 슬롯 수
  bindings: ReadonlyArray<DataBinding>;
  rowCounts: Readonly<Record<string, number>>; // dataset_id → 행 수(모르면 키 없음)
}

export function setupNotices(input: SetupNoticeInput): SetupNotice[] {
  const { scenario, loadModel, rateMode, bindings, rowCounts } = input;
  if (!scenario || setupSteps(scenario).length === 0) return [];
  const out: SetupNotice[] = [];

  if (loadModel === "closed" && rateMode === "fixed" && input.rampUpSeconds === 0) {
    out.push({ kind: "burst" });
  }
  if (loadModel === "open" && input.maxInFlight !== null) {
    out.push({ kind: "per_slot", slots: input.maxInFlight });
  }

  const unit: "vu" | "slot" = loadModel === "open" ? "slot" : "vu";
  const units =
    loadModel === "open" ? input.maxInFlight : rateMode === "curve" ? input.vuPeak : input.vus;
  const setupVars = scanFlowVars({ ...scenario, steps: [] });

  for (const b of bindings) {
    if (b.policy !== "per_vu") continue;
    if (!b.mappings.some((m) => setupVars.has(m.var))) continue;
    const rows = rowCounts[b.dataset_id];
    if (rows !== undefined && units !== null && rows < units) {
      out.push({ kind: "shared_rows", rows, units, unit });
    }
  }

  const notPerVu: string[] = [];
  for (const b of bindings) {
    if (b.policy === "per_vu") continue;
    for (const m of b.mappings) {
      if (setupVars.has(m.var) && !notPerVu.includes(m.var)) notPerVu.push(m.var);
    }
  }
  if (notPerVu.length > 0) out.push({ kind: "not_per_vu", vars: notPerVu });

  return out;
}

/** 폼 상태(문자열 초안 포함)를 `SetupNoticeInput`의 숫자 칸으로 옮긴다. RunDialog·ScheduleForm 공용. */
export function loadFieldsForNotices(f: {
  loadModel: "closed" | "open";
  rateMode: "fixed" | "curve" | "stair";
  vus: number;
  rampUp: number;
  stages: ReadonlyArray<{ target: string }>;
  maxInFlight: string;
}): Pick<
  SetupNoticeInput,
  "loadModel" | "rateMode" | "vus" | "rampUpSeconds" | "vuPeak" | "maxInFlight"
> {
  const targets = f.stages.map((s) => Number(s.target)).filter((n) => Number.isFinite(n));
  const mif = f.maxInFlight.trim() === "" ? null : Number(f.maxInFlight);
  return {
    loadModel: f.loadModel,
    rateMode: f.rateMode,
    vus: f.vus,
    rampUpSeconds: f.rampUp,
    vuPeak: targets.length > 0 ? Math.max(...targets) : null,
    maxInFlight: mif !== null && Number.isInteger(mif) ? mif : null,
  };
}
