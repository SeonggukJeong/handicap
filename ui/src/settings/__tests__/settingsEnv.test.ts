import { describe, it, expect } from "vitest";
import { scopeOf, ENV_NOTE_KEY } from "../settingsEnv";

describe("settingsEnv.scopeOf", () => {
  it("classifies is_pool_mode-gated reaper knobs as pool", () => {
    expect(scopeOf("pool_heartbeat_interval_seconds")).toBe("pool");
    expect(scopeOf("pool_stale_timeout_seconds")).toBe("pool");
  });

  it("classifies pool_keepalive_seconds as common (gRPC keepalive applies in all modes, not reaper-gated)", () => {
    expect(scopeOf("pool_keepalive_seconds")).toBe("common");
  });

  it("classifies non-pool settings as common", () => {
    expect(scopeOf("worker_capacity_vus")).toBe("common");
    expect(scopeOf("dataset_max_rows")).toBe("common");
    expect(scopeOf("scheduler_tick_seconds")).toBe("common");
    expect(scopeOf("run_startup_grace_seconds")).toBe("common");
  });

  it("falls back to common for unmapped keys (a future knob never gets a false pool badge)", () => {
    expect(scopeOf("some_future_unknown_knob")).toBe("common");
  });
});

describe("settingsEnv.ENV_NOTE_KEY", () => {
  it("maps env-divergent common settings to a note key", () => {
    expect(ENV_NOTE_KEY.worker_capacity_vus).toBe("workerCapacityPoolIgnored");
    expect(ENV_NOTE_KEY.pool_keepalive_seconds).toBe("poolKeepaliveAllModes");
  });

  it("has no note for plain common settings", () => {
    expect(ENV_NOTE_KEY.dataset_max_rows).toBeUndefined();
  });
});
