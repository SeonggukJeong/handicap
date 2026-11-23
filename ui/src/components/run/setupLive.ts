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
  profile: Pick<Profile, "vus" | "target_rps" | "stages" | "vu_stages" | "stair" | "steady">,
  live: SetupLive | undefined,
): SetupLiveView {
  const mode = deriveLoadMode(profile);
  const unit: "vu" | "slot" = mode.loadModel === "open" ? "slot" : "vu";
  // open-loop 슬롯은 처음 쓰일 때 준비한다 — 설정 슬롯 수는 「준비할 수」가 아니라서 분모로 쓰지 않는다.
  const raw = mode.loadModel === "open" || mode.rateMode === "curve" ? null : profile.vus;
  const total = raw != null && Number.isInteger(raw) && raw > 0 ? raw : null;
  const ok = live?.ok ?? 0;
  const failed = live?.failed ?? 0;
  if (total === null) return { unit, ok, failed, total, okPct: 0, failedPct: 0 };
  const okPct = Math.min(100, (ok / total) * 100);
  const failedPct = Math.min(100 - okPct, (failed / total) * 100);
  return { unit, ok, failed, total, okPct, failedPct };
}
