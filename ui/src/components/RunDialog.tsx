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
import type { Criteria, DataBinding } from "../api/schemas";
import type { Scenario } from "../scenario/model";
import { DataBindingPanel } from "./DataBindingPanel";
import { Button } from "./Button";
import type { RunPrefill } from "../api/runPrefill";
import { envValueToRecord, normalizeProfile } from "../api/runPrefill";
import { getPreset } from "../api/presets";
import type { PresetInput } from "../api/presets";
import { EnvironmentPicker } from "./EnvironmentPicker";
import { resolveEnv, type EnvEntry } from "../api/envOverlay";

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

export function RunDialog({
  scenarioId,
  hasLoop,
  scenario,
  initial,
  scenarioChangedWarning = false,
  onCreated,
  onCancel,
}: Props) {
  const [vus, setVus] = useState(initial?.profile.vus ?? 2);
  const [duration, setDuration] = useState(initial?.profile.duration_seconds ?? 5);
  const [rampUp, setRampUp] = useState(initial?.profile.ramp_up_seconds ?? 0);
  const [loopCap, setLoopCap] = useState(initial?.profile.loop_breakdown_cap ?? 256);
  const initC = initial?.profile.criteria ?? undefined;
  const numToStr = (n?: number) => (n == null ? "" : String(n));
  const [maxP50, setMaxP50] = useState(numToStr(initC?.max_p50_ms));
  const [maxP95, setMaxP95] = useState(numToStr(initC?.max_p95_ms));
  const [maxP99, setMaxP99] = useState(numToStr(initC?.max_p99_ms));
  const [maxErrPct, setMaxErrPct] = useState(
    initC?.max_error_rate != null ? String(initC.max_error_rate * 100) : "",
  );
  const [minRps, setMinRps] = useState(numToStr(initC?.min_rps));
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
  const canSubmit =
    vus >= 1 &&
    duration >= 1 &&
    !rampInvalid &&
    !loopCapInvalid &&
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

  function currentInput(): PresetInput {
    return {
      name: presetName.trim(),
      profile: {
        vus,
        duration_seconds: duration,
        ramp_up_seconds: rampUp,
        loop_breakdown_cap: hasLoop ? loopCap : 0,
        data_binding: binding ?? undefined,
        criteria: buildCriteria(),
      },
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
      <div className="grid grid-cols-3 gap-4 mb-3">
        <label className="block text-sm">
          <span className="text-slate-600">VUs</span>
          <input
            type="number"
            min={1}
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
            value={rampUp}
            onChange={(e) => setRampUp(Number(e.target.value))}
            className="mt-1 block w-full rounded border border-slate-300 px-2 py-1"
            aria-invalid={rampInvalid}
            aria-describedby={rampInvalid ? "ramp-up-error" : undefined}
          />
        </label>
      </div>

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

      {rampInvalid && (
        <p id="ramp-up-error" className="mb-3 text-red-600 text-sm">
          Ramp-up must be ≤ duration.
        </p>
      )}

      {loopCapInvalid && (
        <p id="loop-cap-error" className="mb-3 text-red-600 text-sm">
          0 ~ 10000 사이여야 합니다.
        </p>
      )}

      <fieldset className="mt-3 border-t pt-3">
        <legend className="text-sm font-medium">SLO 기준 (선택)</legend>
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
      </fieldset>

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
              {
                scenarioId,
                profile: {
                  vus,
                  duration_seconds: duration,
                  ramp_up_seconds: rampUp,
                  loop_breakdown_cap: hasLoop ? loopCap : 0,
                  data_binding: binding ?? undefined,
                  criteria: buildCriteria(),
                },
                env,
              },
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
