import type { Profile, SetupLive } from "../../api/schemas";
import { deriveLoadMode } from "./loadModel";

export type SetupLiveView = {
  unit: "vu" | "slot";
  ok: number;
  failed: number;
  total: number | null;
  okPct: number;
  failedPct: number;
};

export function setupLiveView(
  profile: Pick<
    Profile,
    "vus" | "max_in_flight" | "target_rps" | "stages" | "vu_stages" | "stair" | "steady"
  >,
  live: SetupLive | undefined,
): SetupLiveView {
  const mode = deriveLoadMode(profile);
  const unit: "vu" | "slot" = mode.loadModel === "open" ? "slot" : "vu";
  let raw: number | null | undefined;
  if (mode.loadModel === "open") raw = profile.max_in_flight;
  else if (mode.rateMode === "curve") raw = null;
  else raw = profile.vus;
  const total = raw != null && Number.isInteger(raw) && raw > 0 ? raw : null;
  const ok = live?.ok ?? 0;
  const failed = live?.failed ?? 0;
  if (total === null) return { unit, ok, failed, total, okPct: 0, failedPct: 0 };
  const okPct = Math.min(100, (ok / total) * 100);
  const failedPct = Math.min(100 - okPct, (failed / total) * 100);
  return { unit, ok, failed, total, okPct, failedPct };
}
