import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCreatePreset,
  useCreateRun,
  useDeletePreset,
  useEnvironment,
  usePresets,
  useUpdatePreset,
  queryKeys,
} from "../api/hooks";
import type { Criteria, DataBinding, Profile } from "../api/schemas";
import type { Scenario } from "../scenario/model";
import { DataBindingPanel } from "./DataBindingPanel";
import { Button } from "./Button";
import type { RunPrefill } from "../api/runPrefill";
import { envValueToRecord, normalizeProfile } from "../api/runPrefill";
import { getPreset } from "../api/presets";
import type { PresetInput } from "../api/presets";
import { EnvironmentPicker } from "./EnvironmentPicker";
import { resolveEnv, type EnvEntry } from "../api/envOverlay";
import { LOAD_SHAPES } from "./loadShapes";
import { StageCurvePreview } from "./StageCurvePreview";

type Props = {
  scenarioId: string;
  /** Whether the scenario contains a loop step. When false, the loop-breakdown
   *  cap control is hidden and the run is created with cap = 0 (no breakdown
   *  bookkeeping in the engine at all). */
  hasLoop: boolean;
  /** Parsed scenario model, used to power the DataBindingPanel. Pass null when
   *  the scenario YAML is unavailable or failed to parse (binding panel is hidden). */
  scenario: Scenario | null;
  /** When set, seed every form field from this past run's profile + env (retry
   *  prefill). The parent remounts the dialog (React key) to reseed; there is no
   *  reseed effect. */
  initial?: RunPrefill;
  /** True when `initial` came from a run whose scenario snapshot differs from the
   *  current live scenario — renders a drift warning. */
  scenarioChangedWarning?: boolean;
  onCreated: (runId: string) => void;
  onCancel: () => void;
};

/** True when any SLO criterion is set — drives the auto-expand of the (optional,
 *  collapsible) SLO section so seeded criteria are never hidden behind the toggle. */
function criteriaHasValue(c?: Criteria): boolean {
  return (
    c != null &&
    (c.max_p50_ms != null ||
      c.max_p95_ms != null ||
      c.max_p99_ms != null ||
      c.max_error_rate != null ||
      c.min_rps != null)
  );
}

export function RunDialog({
  scenarioId,
  hasLoop,
  scenario,
  initial,
  scenarioChangedWarning = false,
  onCreated,
  onCancel,
}: Props) {
  // Load model: "closed" = closed-loop (VUs), "open" = open-loop (arrival rate).
  // Prefill from initial if it carries target_rps or stages (open-loop retry).
  const [loadModel, setLoadModel] = useState<"closed" | "open">(
    initial?.profile.target_rps != null ||
      (initial?.profile.stages != null && initial.profile.stages.length > 0)
      ? "open"
      : "closed",
  );
  const [targetRps, setTargetRps] = useState(
    initial?.profile.target_rps != null ? String(initial.profile.target_rps) : "100",
  );
  const [maxInFlight, setMaxInFlight] = useState(
    initial?.profile.max_in_flight != null ? String(initial.profile.max_in_flight) : "200",
  );
  const [rateMode, setRateMode] = useState<"fixed" | "curve">(
    initial?.profile.stages && initial.profile.stages.length > 0 ? "curve" : "fixed",
  );
  const [stages, setStages] = useState<{ target: string; duration_seconds: string }[]>(
    initial?.profile.stages?.map((s) => ({
      target: String(s.target),
      duration_seconds: String(s.duration_seconds),
    })) ?? [{ target: "100", duration_seconds: "30" }],
  );
  const [vus, setVus] = useState(initial?.profile.vus ?? 2);
  const [duration, setDuration] = useState(initial?.profile.duration_seconds ?? 5);
  const [rampUp, setRampUp] = useState(initial?.profile.ramp_up_seconds ?? 0);
  const [loopCap, setLoopCap] = useState(initial?.profile.loop_breakdown_cap ?? 256);
  const [httpTimeout, setHttpTimeout] = useState(initial?.profile.http_timeout_seconds ?? 30);
  const initC = initial?.profile.criteria ?? undefined;
  const numToStr = (n?: number) => (n == null ? "" : String(n));
  const [maxP50, setMaxP50] = useState(numToStr(initC?.max_p50_ms));
  const [maxP95, setMaxP95] = useState(numToStr(initC?.max_p95_ms));
  const [maxP99, setMaxP99] = useState(numToStr(initC?.max_p99_ms));
  const [maxErrPct, setMaxErrPct] = useState(
    initC?.max_error_rate != null ? String(initC.max_error_rate * 100) : "",
  );
  const [minRps, setMinRps] = useState(numToStr(initC?.min_rps));
  // SLO 기준 is optional → collapsible. Start open only when seeded criteria exist.
  const [sloOpen, setSloOpen] = useState(() => criteriaHasValue(initC));
  // Pacing (think time) is optional → collapsible. Empty inputs omit think_time
  // / think_seed entirely (byte-identical to pre-feature submit).
  const initTT = initial?.profile.think_time;
  const [thinkMin, setThinkMin] = useState(numToStr(initTT?.min_ms));
  const [thinkMax, setThinkMax] = useState(numToStr(initTT?.max_ms));
  const [thinkSeed, setThinkSeed] = useState(numToStr(initial?.profile.think_seed));
  const [pacingOpen, setPacingOpen] = useState(
    () => initTT != null || initial?.profile.think_seed != null,
  );
  const [envEntries, setEnvEntries] = useState<EnvEntry[]>(() =>
    initial ? Object.entries(initial.env).map(([key, value]) => ({ key, value })) : [],
  );
  const [binding, setBinding] = useState<DataBinding | null>(initial?.profile.data_binding ?? null);
  const [bindingValid, setBindingValid] = useState(true);
  // B-2 environment overlay. Prefill (preset/retry) is override-only (env = none):
  // the stored env is already a resolved snapshot, so it seeds envEntries with no base.
  const [selectedEnvId, setSelectedEnvId] = useState<string | null>(null);
  const selectedEnv = useEnvironment(selectedEnvId ?? undefined);
  const baseVars = selectedEnv.data?.vars ?? {};

  // seedBinding drives the DataBindingPanel's initialBinding; bumping panelKey remounts
  // the panel so it re-seeds from the loaded preset's binding (explicit user action).
  const [seedBinding, setSeedBinding] = useState<DataBinding | null>(
    initial?.profile.data_binding ?? null,
  );
  const [panelKey, setPanelKey] = useState(0);
  // loadedPresetId / presetName: used by save/rename/delete preset controls.
  const [loadedPresetId, setLoadedPresetId] = useState<string | null>(null);
  const [presetName, setPresetName] = useState("");
  const [presetError, setPresetError] = useState<string | null>(null);

  const presets = usePresets(scenarioId);
  const qc = useQueryClient();

  async function loadPreset(id: string) {
    if (!id) return;
    setPresetError(null);
    try {
      const p = await qc.fetchQuery({
        queryKey: queryKeys.preset(id),
        queryFn: () => getPreset(id),
      });
      const prof = normalizeProfile(p.profile);
      setVus(prof.vus);
      setDuration(prof.duration_seconds);
      setRampUp(prof.ramp_up_seconds);
      setLoopCap(prof.loop_breakdown_cap);
      setHttpTimeout(prof.http_timeout_seconds);
      setEnvEntries(
        Object.entries(envValueToRecord(p.env)).map(([key, value]) => ({ key, value })),
      );
      const b = prof.data_binding ?? null;
      setBinding(b);
      setSeedBinding(b);
      setPanelKey((k) => k + 1);
      const pc = prof.criteria ?? undefined;
      setMaxP50(numToStr(pc?.max_p50_ms));
      setMaxP95(numToStr(pc?.max_p95_ms));
      setMaxP99(numToStr(pc?.max_p99_ms));
      setMaxErrPct(pc?.max_error_rate != null ? String(pc.max_error_rate * 100) : "");
      setMinRps(numToStr(pc?.min_rps));
      if (criteriaHasValue(pc)) setSloOpen(true); // reveal loaded criteria
      const ptt = prof.think_time ?? undefined;
      setThinkMin(numToStr(ptt?.min_ms));
      setThinkMax(numToStr(ptt?.max_ms));
      setThinkSeed(numToStr(prof.think_seed ?? undefined));
      if (ptt != null || prof.think_seed != null) setPacingOpen(true); // reveal loaded pacing
      // Open-loop prefill: if preset has target_rps, switch to open mode and seed fields.
      if (prof.target_rps != null) {
        setLoadModel("open");
        setTargetRps(String(prof.target_rps));
        setMaxInFlight(prof.max_in_flight != null ? String(prof.max_in_flight) : "200");
      } else {
        setLoadModel("closed");
      }
      // Stages prefill: if preset has stages, switch to open+curve and seed stage rows.
      if (prof.stages && prof.stages.length > 0) {
        setLoadModel("open");
        setRateMode("curve");
        setStages(
          prof.stages.map((s) => ({
            target: String(s.target),
            duration_seconds: String(s.duration_seconds),
          })),
        );
        if (prof.max_in_flight != null) setMaxInFlight(String(prof.max_in_flight));
      } else {
        setRateMode("fixed");
      }
      setLoadedPresetId(id);
      setPresetName(p.name);
    } catch (e) {
      setPresetError((e as Error).message);
    }
  }

  const createPreset = useCreatePreset(scenarioId);
  const updatePreset = useUpdatePreset(scenarioId);
  const deletePreset = useDeletePreset(scenarioId);

  const mutation = useCreateRun();

  const rampInvalid = rampUp > duration;
  // Only meaningful while the cap control is shown (scenario has a loop step).
  const loopCapInvalid = hasLoop && (loopCap < 0 || loopCap > 10000);
  const httpTimeoutInvalid = httpTimeout < 1 || httpTimeout > 600;
  // Count of filled SLO inputs — shown as a hint on the toggle when collapsed so
  // active criteria aren't silently hidden.
  const sloActiveCount = [maxP50, maxP95, maxP99, maxErrPct, minRps].filter(
    (s) => s.trim() !== "",
  ).length;
  // think_time requires both min & max (one alone is invalid); min ≤ max ≤ 600000.
  const thinkInvalid =
    (thinkMin.trim() !== "" || thinkMax.trim() !== "") &&
    (thinkMin.trim() === "" ||
      thinkMax.trim() === "" ||
      Number(thinkMin) < 0 ||
      Number(thinkMax) < Number(thinkMin) ||
      Number(thinkMax) > 600_000);
  const pacingActiveCount = [thinkMin, thinkMax, thinkSeed].filter((s) => s.trim() !== "").length;
  // Open-loop field validation: target_rps and max_in_flight must be valid integers in range.
  const targetRpsNum = Number(targetRps);
  const maxInFlightNum = Number(maxInFlight);
  const targetRpsInvalid =
    targetRps.trim() === "" ||
    !Number.isInteger(targetRpsNum) ||
    targetRpsNum < 1 ||
    targetRpsNum > 1_000_000;
  const maxInFlightInvalid =
    maxInFlight.trim() === "" ||
    !Number.isInteger(maxInFlightNum) ||
    maxInFlightNum < 1 ||
    maxInFlightNum > 10_000;
  // Stages validation: each row needs valid target (0–1M int) and duration (≥1 int),
  // and at least one stage must have target > 0.
  const stagesInvalid =
    rateMode === "curve" &&
    loadModel === "open" &&
    (stages.length === 0 ||
      stages.some((s) => {
        const t = Number(s.target);
        const d = Number(s.duration_seconds);
        return (
          s.target.trim() === "" ||
          s.duration_seconds.trim() === "" ||
          !Number.isInteger(t) ||
          t < 0 ||
          t > 1_000_000 ||
          !Number.isInteger(d) ||
          d < 1
        );
      }) ||
      !stages.some((s) => Number(s.target) > 0));
  const canSubmit =
    loadModel === "open"
      ? rateMode === "curve"
        ? !maxInFlightInvalid &&
          !stagesInvalid &&
          !loopCapInvalid &&
          !httpTimeoutInvalid &&
          bindingValid &&
          !mutation.isPending
        : duration >= 1 &&
          !targetRpsInvalid &&
          !maxInFlightInvalid &&
          !loopCapInvalid &&
          !httpTimeoutInvalid &&
          bindingValid &&
          !mutation.isPending
      : vus >= 1 &&
        duration >= 1 &&
        !rampInvalid &&
        !loopCapInvalid &&
        !httpTimeoutInvalid &&
        !thinkInvalid &&
        bindingValid &&
        !mutation.isPending;

  // Merge selected environment (base) under the per-run override rows. With no env
  // selected, baseVars is {} and this is byte-identical to the old loop.
  const env: Record<string, string> = resolveEnv(baseVars, envEntries);

  function buildCriteria(): Criteria | undefined {
    const c: Criteria = {};
    if (maxP50.trim() !== "") c.max_p50_ms = Number(maxP50);
    if (maxP95.trim() !== "") c.max_p95_ms = Number(maxP95);
    if (maxP99.trim() !== "") c.max_p99_ms = Number(maxP99);
    if (maxErrPct.trim() !== "") c.max_error_rate = Number(maxErrPct) / 100;
    if (minRps.trim() !== "") c.min_rps = Number(minRps);
    return Object.keys(c).length > 0 ? c : undefined;
  }

  function buildThinkTime(): { min_ms: number; max_ms: number } | undefined {
    if (thinkMin.trim() === "" || thinkMax.trim() === "") return undefined;
    return { min_ms: Number(thinkMin), max_ms: Number(thinkMax) };
  }

  function buildProfile(): Profile {
    const base = {
      loop_breakdown_cap: hasLoop ? loopCap : 0,
      http_timeout_seconds: httpTimeout,
      data_binding: binding ?? undefined,
      criteria: buildCriteria(),
    };
    if (loadModel === "open" && rateMode === "curve") {
      return {
        ...base,
        vus: 0,
        duration_seconds: 0, // curve: total = sum(stages); controller rejects >0 with stages
        ramp_up_seconds: 0,
        max_in_flight: Number(maxInFlight),
        stages: stages.map((s) => ({
          target: Number(s.target),
          duration_seconds: Number(s.duration_seconds),
        })),
        // NO target_rps, NO think_time
      };
    }
    if (loadModel === "open") {
      return {
        ...base,
        vus: 0,
        duration_seconds: duration,
        ramp_up_seconds: 0,
        target_rps: Number(targetRps),
        max_in_flight: Number(maxInFlight),
        // NO think_time — open-loop forbids run-level think time
      };
    }
    return {
      ...base,
      vus,
      duration_seconds: duration,
      ramp_up_seconds: rampUp,
      think_time: buildThinkTime(),
      think_seed: thinkSeed.trim() !== "" ? Number(thinkSeed) : undefined,
      // target_rps / max_in_flight omitted → closed-loop byte-identical
    };
  }

  function currentInput(): PresetInput {
    return {
      name: presetName.trim(),
      profile: buildProfile(),
      env,
    };
  }

  function savePreset() {
    const name = presetName.trim();
    if (!name) {
      setPresetError("프리셋 이름을 입력하세요");
      return;
    }
    setPresetError(null);
    const existing = presets.data?.find((p) => p.name === name);
    if (existing) {
      if (!window.confirm(`'${name}' 프리셋을 덮어쓸까요?`)) return;
      updatePreset.mutate(
        { id: existing.id, body: currentInput() },
        {
          onError: (e) => setPresetError((e as Error).message),
          onSuccess: () => setLoadedPresetId(existing.id),
        },
      );
    } else {
      createPreset.mutate(currentInput(), {
        onError: (e) => setPresetError((e as Error).message),
        onSuccess: (p) => setLoadedPresetId(p.id),
      });
    }
  }

  // NOTE (UX, spec §3 #12 deviation): rename PUTs currentInput() i.e. the live
  // form state — so editing the form after loading then renaming also persists
  // those edits ("save current state under a new name", not a pure metadata
  // rename). Intentional and safe (rename only offered when a preset is loaded).
  function renamePreset() {
    if (!loadedPresetId) return;
    const next = window.prompt("새 이름", presetName)?.trim();
    if (!next) return;
    setPresetError(null);
    updatePreset.mutate(
      { id: loadedPresetId, body: { ...currentInput(), name: next } },
      {
        onError: (e) => setPresetError((e as Error).message),
        onSuccess: () => setPresetName(next),
      },
    );
  }

  function removePreset() {
    if (!loadedPresetId) return;
    if (!window.confirm(`'${presetName}' 프리셋을 삭제할까요?`)) return;
    setPresetError(null);
    deletePreset.mutate(loadedPresetId, {
      onError: (e) => setPresetError((e as Error).message),
      onSuccess: () => {
        setLoadedPresetId(null);
        setPresetName("");
      },
    });
  }

  return (
    <div className="border border-slate-200 rounded-md p-4 bg-white">
      <h3 className="text-lg font-semibold mb-3">New run</h3>
      {scenarioChangedWarning && (
        <p
          role="alert"
          className="mb-3 p-2 rounded border border-amber-300 bg-amber-50 text-sm text-amber-800"
        >
          이 시나리오는 이 run 이후 수정됨 — 설정이 안 맞을 수 있습니다.
        </p>
      )}
      {presets.data && presets.data.length > 0 && (
        <div className="mb-3 flex items-center gap-2">
          <label className="text-sm text-slate-600" htmlFor="load-preset">
            프리셋 불러오기
          </label>
          <select
            id="load-preset"
            aria-label="load preset"
            className="border border-slate-300 rounded px-2 py-1 text-sm"
            value=""
            onChange={(e) => {
              if (e.target.value) void loadPreset(e.target.value);
            }}
          >
            <option value="">— 선택 —</option>
            {presets.data.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {presetError && (
        <p role="alert" className="mb-3 text-red-600 text-sm">
          프리셋 오류: {presetError}
        </p>
      )}
      {/* Load model toggle */}
      <fieldset className="mb-3">
        <legend className="text-sm text-slate-600 mb-1">부하 모델</legend>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-1 text-sm cursor-pointer">
            <input
              type="radio"
              name="load-model"
              value="closed"
              checked={loadModel === "closed"}
              onChange={() => setLoadModel("closed")}
            />
            Closed-loop (VUs)
          </label>
          <label className="flex items-center gap-1 text-sm cursor-pointer">
            <input
              type="radio"
              name="load-model"
              value="open"
              checked={loadModel === "open"}
              onChange={() => setLoadModel("open")}
            />
            Open-loop (arrival rate)
          </label>
        </div>
      </fieldset>

      {loadModel === "closed" ? (
        <div className="grid grid-cols-4 gap-4 mb-3">
          <label className="block text-sm">
            <span className="text-slate-600">VUs</span>
            <input
              type="number"
              min={1}
              aria-label="VUs"
              value={vus}
              onChange={(e) => setVus(Number(e.target.value))}
              className="mt-1 block w-full rounded border border-slate-300 px-2 py-1"
            />
          </label>
          <label className="block text-sm">
            <span className="text-slate-600">Duration (s)</span>
            <input
              type="number"
              min={1}
              aria-label="Duration (s)"
              value={duration}
              onChange={(e) => setDuration(Number(e.target.value))}
              className="mt-1 block w-full rounded border border-slate-300 px-2 py-1"
            />
          </label>
          <label className="block text-sm">
            <span className="text-slate-600">Ramp-up (s)</span>
            <input
              type="number"
              min={0}
              aria-label="Ramp-up (s)"
              value={rampUp}
              onChange={(e) => setRampUp(Number(e.target.value))}
              className="mt-1 block w-full rounded border border-slate-300 px-2 py-1"
              aria-invalid={rampInvalid}
              aria-describedby={rampInvalid ? "ramp-up-error" : undefined}
            />
          </label>
          <label className="block text-sm">
            <span className="text-slate-600">HTTP timeout (s)</span>
            <input
              type="number"
              min={1}
              max={600}
              aria-label="HTTP timeout (s)"
              value={httpTimeout}
              onChange={(e) => setHttpTimeout(Number(e.target.value))}
              className="mt-1 block w-full rounded border border-slate-300 px-2 py-1"
              aria-invalid={httpTimeoutInvalid}
              aria-describedby={httpTimeoutInvalid ? "http-timeout-error" : undefined}
            />
          </label>
        </div>
      ) : (
        <>
          {/* Rate mode toggle — only shown in open-loop branch */}
          <fieldset className="mb-3">
            <legend className="text-sm text-slate-600 mb-1">레이트</legend>
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-1 text-sm cursor-pointer">
                <input
                  type="radio"
                  name="rate-mode"
                  value="fixed"
                  checked={rateMode === "fixed"}
                  onChange={() => setRateMode("fixed")}
                />
                고정 (RPS)
              </label>
              <label className="flex items-center gap-1 text-sm cursor-pointer">
                <input
                  type="radio"
                  name="rate-mode"
                  value="curve"
                  checked={rateMode === "curve"}
                  onChange={() => setRateMode("curve")}
                />
                곡선 (stages)
              </label>
            </div>
          </fieldset>

          {rateMode === "fixed" ? (
            <div className="grid grid-cols-4 gap-4 mb-3">
              <label className="block text-sm">
                <span className="text-slate-600">Target RPS</span>
                <input
                  type="number"
                  min={1}
                  max={1000000}
                  aria-label="Target RPS"
                  value={targetRps}
                  onChange={(e) => setTargetRps(e.target.value)}
                  className="mt-1 block w-full rounded border border-slate-300 px-2 py-1"
                  aria-invalid={targetRpsInvalid}
                  aria-describedby={targetRpsInvalid ? "target-rps-error" : undefined}
                />
              </label>
              <label className="block text-sm">
                <span className="text-slate-600">Max in-flight</span>
                <input
                  type="number"
                  min={1}
                  max={10000}
                  aria-label="Max in-flight"
                  value={maxInFlight}
                  onChange={(e) => setMaxInFlight(e.target.value)}
                  className="mt-1 block w-full rounded border border-slate-300 px-2 py-1"
                  aria-invalid={maxInFlightInvalid}
                  aria-describedby={maxInFlightInvalid ? "max-in-flight-error" : undefined}
                />
              </label>
              <label className="block text-sm">
                <span className="text-slate-600">Duration (s)</span>
                <input
                  type="number"
                  min={1}
                  aria-label="Duration (s)"
                  value={duration}
                  onChange={(e) => setDuration(Number(e.target.value))}
                  className="mt-1 block w-full rounded border border-slate-300 px-2 py-1"
                />
              </label>
              <label className="block text-sm">
                <span className="text-slate-600">HTTP timeout (s)</span>
                <input
                  type="number"
                  min={1}
                  max={600}
                  aria-label="HTTP timeout (s)"
                  value={httpTimeout}
                  onChange={(e) => setHttpTimeout(Number(e.target.value))}
                  className="mt-1 block w-full rounded border border-slate-300 px-2 py-1"
                  aria-invalid={httpTimeoutInvalid}
                  aria-describedby={httpTimeoutInvalid ? "http-timeout-error" : undefined}
                />
              </label>
            </div>
          ) : (
            <div className="mb-3">
              <label className="block text-sm mb-2">
                <span className="text-slate-600">부하 모양</span>
                <select
                  aria-label="부하 모양"
                  defaultValue=""
                  onChange={(e) => {
                    const shape = LOAD_SHAPES.find((s) => s.id === e.target.value);
                    if (shape) {
                      setStages(
                        shape.stages.map((s) => ({
                          target: String(s.target),
                          duration_seconds: String(s.duration_seconds),
                        })),
                      );
                    }
                  }}
                  className="mt-1 block w-full rounded border border-slate-300 px-2 py-1"
                >
                  <option value="">직접 입력</option>
                  {LOAD_SHAPES.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </label>
              <p className="text-xs text-slate-500 mb-1">
                각 단계가 끝날 때의 목표 초당 요청 수 (이전 값에서 선형 변화)
              </p>
              <p className="text-xs text-slate-500 mb-2">이 단계가 지속되는 시간(초)</p>
              {stages.map((s, i) => (
                <div key={i} className="flex items-end gap-2 mb-2">
                  <label className="block text-sm flex-1 min-w-0">
                    <span className="text-slate-600">목표 RPS</span>
                    <input
                      type="number"
                      min={0}
                      max={1000000}
                      aria-label={`stage target ${i}`}
                      value={s.target}
                      onChange={(e) =>
                        setStages((prev) =>
                          prev.map((r, j) => (j === i ? { ...r, target: e.target.value } : r)),
                        )
                      }
                      className="mt-1 block w-full rounded border border-slate-300 px-2 py-1"
                    />
                  </label>
                  <label className="block text-sm flex-1 min-w-0">
                    <span className="text-slate-600">지속(s)</span>
                    <input
                      type="number"
                      min={1}
                      aria-label={`stage duration ${i}`}
                      value={s.duration_seconds}
                      onChange={(e) =>
                        setStages((prev) =>
                          prev.map((r, j) =>
                            j === i ? { ...r, duration_seconds: e.target.value } : r,
                          ),
                        )
                      }
                      className="mt-1 block w-full rounded border border-slate-300 px-2 py-1"
                    />
                  </label>
                  <button
                    type="button"
                    aria-label={`remove stage ${i}`}
                    disabled={stages.length <= 1}
                    onClick={() => setStages((prev) => prev.filter((_, j) => j !== i))}
                    className="shrink-0 px-2 py-1 text-slate-500 hover:text-red-600 disabled:opacity-30"
                  >
                    ×
                  </button>
                </div>
              ))}
              <div className="flex items-center">
                <button
                  type="button"
                  onClick={() =>
                    setStages((prev) => [...prev, { target: "100", duration_seconds: "30" }])
                  }
                  className="text-sm text-blue-600 hover:underline"
                >
                  + 단계 추가
                </button>
                <span className="ml-3 text-xs text-slate-500">
                  총 길이: {stages.reduce((a, s) => a + (Number(s.duration_seconds) || 0), 0)}s
                </span>
              </div>
              {stagesInvalid && (
                <p role="alert" className="mt-2 text-red-600 text-sm">
                  각 단계는 목표 0–1,000,000 · 지속 ≥1초, 최소 한 단계의 목표 &gt; 0 이어야 합니다
                </p>
              )}
              {(() => {
                const previewStages = stages
                  .map((s) => ({
                    target: Number(s.target),
                    duration_seconds: Number(s.duration_seconds),
                  }))
                  .filter(
                    (s) =>
                      Number.isFinite(s.target) &&
                      Number.isFinite(s.duration_seconds) &&
                      s.duration_seconds > 0,
                  );
                return previewStages.length > 0 ? (
                  <div className="mt-2">
                    <span className="text-xs text-slate-500">미리보기</span>
                    <div className="h-32">
                      <StageCurvePreview stages={previewStages} />
                    </div>
                  </div>
                ) : null;
              })()}
              <div className="grid grid-cols-2 gap-4 mt-3">
                <label className="block text-sm">
                  <span className="text-slate-600">Max in-flight</span>
                  <input
                    type="number"
                    min={1}
                    max={10000}
                    aria-label="Max in-flight"
                    value={maxInFlight}
                    onChange={(e) => setMaxInFlight(e.target.value)}
                    className="mt-1 block w-full rounded border border-slate-300 px-2 py-1"
                    aria-invalid={maxInFlightInvalid}
                    aria-describedby={maxInFlightInvalid ? "max-in-flight-error" : undefined}
                  />
                  <span className="text-xs text-slate-500">
                    동시 처리 상한 — 서비스가 목표 레이트를 못 따라가면 초과분은 drop되어 리포트에
                    표시됩니다
                  </span>
                </label>
                <label className="block text-sm">
                  <span className="text-slate-600">HTTP timeout (s)</span>
                  <input
                    type="number"
                    min={1}
                    max={600}
                    aria-label="HTTP timeout (s)"
                    value={httpTimeout}
                    onChange={(e) => setHttpTimeout(Number(e.target.value))}
                    className="mt-1 block w-full rounded border border-slate-300 px-2 py-1"
                    aria-invalid={httpTimeoutInvalid}
                    aria-describedby={httpTimeoutInvalid ? "http-timeout-error" : undefined}
                  />
                </label>
              </div>
            </div>
          )}
        </>
      )}

      {hasLoop && (
        <div className="mb-3">
          <label className="block text-sm">
            Loop breakdown cap
            <input
              type="number"
              min={0}
              max={10000}
              aria-label="loop breakdown cap"
              value={loopCap}
              onChange={(e) => setLoopCap(Number(e.target.value))}
              className="mt-1 block w-full rounded border border-slate-300 px-2 py-1"
              aria-invalid={loopCapInvalid}
              aria-describedby={loopCapInvalid ? "loop-cap-error" : undefined}
            />
            <span className="text-xs text-slate-500">
              0 = 끄기 · 루프 스텝의 loop_index별 집계 상한
            </span>
          </label>
        </div>
      )}

      {loadModel === "closed" && rampInvalid && (
        <p id="ramp-up-error" className="mb-3 text-red-600 text-sm">
          Ramp-up must be ≤ duration.
        </p>
      )}

      {loopCapInvalid && (
        <p id="loop-cap-error" className="mb-3 text-red-600 text-sm">
          0 ~ 10000 사이여야 합니다.
        </p>
      )}

      {httpTimeoutInvalid && (
        <p id="http-timeout-error" className="mb-3 text-red-600 text-sm">
          HTTP timeout must be between 1 and 600 seconds.
        </p>
      )}

      {loadModel === "open" && rateMode === "fixed" && targetRpsInvalid && (
        <p id="target-rps-error" className="mb-3 text-red-600 text-sm">
          Target RPS must be between 1 and 1,000,000.
        </p>
      )}

      {loadModel === "open" && maxInFlightInvalid && (
        <p id="max-in-flight-error" className="mb-3 text-red-600 text-sm">
          Max in-flight must be between 1 and 10,000.
        </p>
      )}

      <fieldset className="mt-3 mb-4 border-t pt-3">
        <legend className="text-sm font-medium">
          <button
            type="button"
            onClick={() => setSloOpen((v) => !v)}
            className="font-medium text-slate-700 hover:underline"
            aria-expanded={sloOpen}
          >
            {sloOpen ? "▾" : "▸"} SLO 기준 (선택)
            {!sloOpen && sloActiveCount > 0 ? (
              <span className="ml-1 text-xs font-normal text-slate-500">
                · {sloActiveCount}개 설정됨
              </span>
            ) : null}
          </button>
        </legend>
        {sloOpen && (
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-sm">
              <span className="text-slate-600">Max p50 (ms)</span>
              <input
                type="number"
                min="0"
                className="mt-1 block w-full rounded border border-slate-300 px-2 py-1"
                value={maxP50}
                onChange={(e) => setMaxP50(e.target.value)}
              />
            </label>
            <label className="block text-sm">
              <span className="text-slate-600">Max p95 (ms)</span>
              <input
                type="number"
                min="0"
                className="mt-1 block w-full rounded border border-slate-300 px-2 py-1"
                value={maxP95}
                onChange={(e) => setMaxP95(e.target.value)}
              />
            </label>
            <label className="block text-sm">
              <span className="text-slate-600">Max p99 (ms)</span>
              <input
                type="number"
                min="0"
                className="mt-1 block w-full rounded border border-slate-300 px-2 py-1"
                value={maxP99}
                onChange={(e) => setMaxP99(e.target.value)}
              />
            </label>
            <label className="block text-sm">
              <span className="text-slate-600">Max error rate (%)</span>
              <input
                type="number"
                min="0"
                max="100"
                step="any"
                className="mt-1 block w-full rounded border border-slate-300 px-2 py-1"
                value={maxErrPct}
                onChange={(e) => setMaxErrPct(e.target.value)}
              />
            </label>
            <label className="block text-sm">
              <span className="text-slate-600">Min RPS</span>
              <input
                type="number"
                min="0"
                step="any"
                className="mt-1 block w-full rounded border border-slate-300 px-2 py-1"
                value={minRps}
                onChange={(e) => setMinRps(e.target.value)}
              />
            </label>
          </div>
        )}
      </fieldset>

      {loadModel === "closed" && (
        <fieldset className="mt-3 mb-4 border-t pt-3">
          <legend className="text-sm font-medium">
            <button
              type="button"
              onClick={() => setPacingOpen((v) => !v)}
              className="font-medium text-slate-700 hover:underline"
              aria-expanded={pacingOpen}
            >
              {pacingOpen ? "▾" : "▸"} Pacing (think time, 선택)
              {!pacingOpen && pacingActiveCount > 0 ? (
                <span className="ml-1 text-xs font-normal text-slate-500">
                  · {pacingActiveCount}개 설정됨
                </span>
              ) : null}
            </button>
          </legend>
          {pacingOpen && (
            <>
              <div className="grid grid-cols-2 gap-2">
                <label className="block text-sm">
                  <span className="text-slate-600">Think min (ms)</span>
                  <input
                    type="number"
                    min="0"
                    className="mt-1 block w-full rounded border border-slate-300 px-2 py-1"
                    value={thinkMin}
                    onChange={(e) => setThinkMin(e.target.value)}
                    aria-invalid={thinkInvalid}
                    aria-describedby={thinkInvalid ? "think-time-error" : undefined}
                  />
                </label>
                <label className="block text-sm">
                  <span className="text-slate-600">Think max (ms)</span>
                  <input
                    type="number"
                    min="0"
                    className="mt-1 block w-full rounded border border-slate-300 px-2 py-1"
                    value={thinkMax}
                    onChange={(e) => setThinkMax(e.target.value)}
                    aria-invalid={thinkInvalid}
                    aria-describedby={thinkInvalid ? "think-time-error" : undefined}
                  />
                </label>
                <label className="block text-sm">
                  <span className="text-slate-600">Think seed (선택)</span>
                  <input
                    type="number"
                    min="0"
                    className="mt-1 block w-full rounded border border-slate-300 px-2 py-1"
                    value={thinkSeed}
                    onChange={(e) => setThinkSeed(e.target.value)}
                  />
                </label>
              </div>
              {thinkInvalid ? (
                <p id="think-time-error" className="mt-1 text-red-600 text-sm">
                  min ≤ max ≤ 600000, 둘 다 입력
                </p>
              ) : (
                <p className="mt-1 text-xs text-slate-500">min=max면 고정 지연</p>
              )}
            </>
          )}
        </fieldset>
      )}

      <EnvironmentPicker
        selectedEnvId={selectedEnvId}
        onSelect={setSelectedEnvId}
        baseVars={baseVars}
        overrides={envEntries}
        onOverridesChange={setEnvEntries}
      />

      <div className="mb-3 flex items-center gap-2">
        <input
          aria-label="preset name"
          className="w-48 border border-slate-300 rounded px-2 py-1 text-sm"
          placeholder="프리셋 이름"
          value={presetName}
          onChange={(e) => setPresetName(e.target.value)}
        />
        <button
          type="button"
          onClick={savePreset}
          disabled={createPreset.isPending || updatePreset.isPending || deletePreset.isPending}
          className="px-2 py-1 text-sm border border-slate-300 rounded disabled:opacity-50"
        >
          프리셋으로 저장
        </button>
        {loadedPresetId && (
          <>
            <button
              type="button"
              onClick={renamePreset}
              disabled={updatePreset.isPending}
              className="text-slate-700 hover:underline text-sm disabled:opacity-50"
            >
              이름 변경
            </button>
            <button
              type="button"
              onClick={removePreset}
              disabled={deletePreset.isPending}
              className="text-red-600 hover:underline text-sm disabled:opacity-50"
            >
              프리셋 삭제
            </button>
          </>
        )}
      </div>

      {scenario && (
        <DataBindingPanel
          key={panelKey}
          scenario={scenario}
          initialBinding={seedBinding}
          onChange={setBinding}
          onValidityChange={setBindingValid}
        />
      )}

      {mutation.error && (
        <p className="mb-3 text-red-600 text-sm">{(mutation.error as Error).message}</p>
      )}

      <div className="flex gap-2">
        <Button
          onClick={() =>
            mutation.mutate(
              { scenarioId, profile: buildProfile(), env },
              { onSuccess: (run) => onCreated(run.id) },
            )
          }
          disabled={!canSubmit}
        >
          {mutation.isPending ? "Starting…" : "Run"}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
