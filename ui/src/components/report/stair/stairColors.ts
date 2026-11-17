import type { StairState } from "../../../api/schemas";

export const STAIR_STATE_COLOR: Record<StairState, string> = {
  ok: "#10b981",
  spike: "#f59e0b",
  saturated: "#ef4444",
  unconfirmed: "#f59e0b",
  after: "#94a3b8",
  not_measured: "#94a3b8",
};
