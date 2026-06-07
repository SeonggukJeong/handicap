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
import type { DataBinding, Profile } from "../api/schemas";
import type { Scenario } from "../scenario/model";
import { DataBindingPanel } from "./DataBindingPanel";
import { Button } from "./Button";
import type { RunPrefill } from "../api/runPrefill";
import { envValueToRecord, normalizeProfile } from "../api/runPrefill";
import { getPreset } from "../api/presets";
import type { PresetInput } from "../api/presets";
import { EnvironmentPicker } from "./EnvironmentPicker";
import { resolveEnv, type EnvEntry } from "../api/envOverlay";
import { LoadModelFields } from "./LoadModelFields";
import { loadModelErrors, type LoadModelState } from "./loadModel";
import {
  buildProfile as buildProfileShared,
  type CriteriaState,
  criteriaStateFrom,
  criteriaHasValue,
  criteriaActiveCount,
} from "./profileForm";
import { CriteriaFields } from "./CriteriaFields";

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
  const initCriteria = criteriaStateFrom(initC);
  const [maxP50, setMaxP50] = useState(initCriteria.maxP50);
  const [maxP95, setMaxP95] = useState(initCriteria.maxP95);
  const [maxP99, setMaxP99] = useState(initCriteria.maxP99);
  const [maxErrPct, setMaxErrPct] = useState(initCriteria.maxErrPct);
  const [minRps, setMinRps] = useState(initCriteria.minRps);
  const [max4xxPct, setMax4xxPct] = useState(initCriteria.max4xxPct);
  const [max5xxPct, setMax5xxPct] = useState(initCriteria.max5xxPct);
  const [max4xxCount, setMax4xxCount] = useState(initCriteria.max4xxCount);
  const [max5xxCount, setMax5xxCount] = useState(initCriteria.max5xxCount);
  const [minWindowRps, setMinWindowRps] = useState(initCriteria.minWindowRps);
  const [rpsWarmup, setRpsWarmup] = useState(initCriteria.rpsWarmup);
  // SLO 기준 is optional → collapsible. Start open only when seeded criteria exist.
  const [sloOpen, setSloOpen] = useState(() => criteriaHasValue(initCriteria));
  // Pacing (think time) is optional → collapsible. Empty inputs omit think_time
  // / think_seed entirely (byte-identical to pre-feature submit).
  const numToStr = (n?: number | null) => (n == null ? "" : String(n));
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
  const [measurePhases, setMeasurePhases] = useState(initial?.profile.measure_phases ?? false);
  const [advancedOpen, setAdvancedOpen] = useState(() => initial?.profile.measure_phases ?? false);
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
      const pc = criteriaStateFrom(prof.criteria ?? undefined);
      setMaxP50(pc.maxP50);
      setMaxP95(pc.maxP95);
      setMaxP99(pc.maxP99);
      setMaxErrPct(pc.maxErrPct);
      setMinRps(pc.minRps);
      setMax4xxPct(pc.max4xxPct);
      setMax5xxPct(pc.max5xxPct);
      setMax4xxCount(pc.max4xxCount);
      setMax5xxCount(pc.max5xxCount);
      setMinWindowRps(pc.minWindowRps);
      setRpsWarmup(pc.rpsWarmup);
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

  // Assemble criteriaState early so criteriaActiveCount can be computed below.
  const criteriaState: CriteriaState = {
    maxP50,
    maxP95,
    maxP99,
    maxErrPct,
    minRps,
    max4xxPct,
    max5xxPct,
    max4xxCount,
    max5xxCount,
    minWindowRps,
    rpsWarmup,
  };
  // Only meaningful while the cap control is shown (scenario has a loop step).
  const loopCapInvalid = hasLoop && (loopCap < 0 || loopCap > 10000);
  const httpTimeoutInvalid = httpTimeout < 1 || httpTimeout > 600;
  // Count of filled SLO inputs — shown as a hint on the toggle when collapsed so
  // active criteria aren't silently hidden.
  const sloActiveCount = criteriaActiveCount(criteriaState);
  // think_time requires both min & max (one alone is invalid); min ≤ max ≤ 600000.
  const thinkInvalid =
    (thinkMin.trim() !== "" || thinkMax.trim() !== "") &&
    (thinkMin.trim() === "" ||
      thinkMax.trim() === "" ||
      Number(thinkMin) < 0 ||
      Number(thinkMax) < Number(thinkMin) ||
      Number(thinkMax) > 600_000);
  const pacingActiveCount = [thinkMin, thinkMax, thinkSeed].filter((s) => s.trim() !== "").length;
  // 모드 state를 모아 순수 헬퍼에 위임(필드 형태·검증). 나머지 state는 RunDialog 소유.
  const loadState: LoadModelState = {
    loadModel,
    rateMode,
    vus,
    duration,
    rampUp,
    targetRps,
    maxInFlight,
    stages,
    thinkMin,
    thinkMax,
    thinkSeed,
  };
  const loadErrs = loadModelErrors(loadState);
  const canSubmit =
    loadModel === "open"
      ? rateMode === "curve"
        ? !loadErrs.maxInFlightInvalid &&
          !loadErrs.stagesInvalid &&
          !loopCapInvalid &&
          !httpTimeoutInvalid &&
          bindingValid &&
          !mutation.isPending
        : duration >= 1 &&
          !loadErrs.targetRpsInvalid &&
          !loadErrs.maxInFlightInvalid &&
          !loopCapInvalid &&
          !httpTimeoutInvalid &&
          bindingValid &&
          !mutation.isPending
      : vus >= 1 &&
        duration >= 1 &&
        !loadErrs.rampInvalid &&
        !loopCapInvalid &&
        !httpTimeoutInvalid &&
        !thinkInvalid &&
        bindingValid &&
        !mutation.isPending;

  // Merge selected environment (base) under the per-run override rows. With no env
  // selected, baseVars is {} and this is byte-identical to the old loop.
  const env: Record<string, string> = resolveEnv(baseVars, envEntries);

  const criteriaSetters: Record<keyof CriteriaState, (v: string) => void> = {
    maxP50: setMaxP50,
    maxP95: setMaxP95,
    maxP99: setMaxP99,
    maxErrPct: setMaxErrPct,
    minRps: setMinRps,
    max4xxPct: setMax4xxPct,
    max5xxPct: setMax5xxPct,
    max4xxCount: setMax4xxCount,
    max5xxCount: setMax5xxCount,
    minWindowRps: setMinWindowRps,
    rpsWarmup: setRpsWarmup,
  };
  const setCriteria = (key: keyof CriteriaState, val: string) => {
    criteriaSetters[key](val);
    // cross-field: minWindowRps 채우면 closed-loop에선 rpsWarmup을 rampUp으로 seed (기존 동작).
    if (
      key === "minWindowRps" &&
      val.trim() !== "" &&
      rpsWarmup.trim() === "" &&
      loadModel === "closed"
    ) {
      setRpsWarmup(String(rampUp));
    }
  };

  function buildProfile(): Profile {
    return buildProfileShared({
      hasLoop,
      loopCap,
      httpTimeout,
      binding,
      loadState,
      criteria: criteriaState,
      measurePhases,
    });
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
      <LoadModelFields
        loadModel={loadModel}
        setLoadModel={setLoadModel}
        rateMode={rateMode}
        setRateMode={setRateMode}
        vus={vus}
        setVus={setVus}
        duration={duration}
        setDuration={setDuration}
        rampUp={rampUp}
        setRampUp={setRampUp}
        targetRps={targetRps}
        setTargetRps={setTargetRps}
        maxInFlight={maxInFlight}
        setMaxInFlight={setMaxInFlight}
        stages={stages}
        setStages={setStages}
        errs={loadErrs}
      />

      {/* HTTP timeout — 모든 모드 공통(transport 설정), 1개만 */}
      <div className="mb-3 max-w-xs">
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
        {sloOpen && <CriteriaFields value={criteriaState} onChange={setCriteria} />}
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

      <fieldset className="mt-3 mb-4 border-t pt-3">
        <legend className="text-sm font-medium">
          <button
            type="button"
            onClick={() => setAdvancedOpen((v) => !v)}
            className="font-medium text-slate-700 hover:underline"
            aria-expanded={advancedOpen}
          >
            {advancedOpen ? "▾" : "▸"} 진단/고급 (선택)
            {!advancedOpen && measurePhases ? (
              <span className="ml-1 text-xs font-normal text-slate-500">· 1개 설정됨</span>
            ) : null}
          </button>
        </legend>
        {advancedOpen && (
          <label className="mt-2 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={measurePhases}
              onChange={(e) => setMeasurePhases(e.target.checked)}
            />
            측정: 레이턴시 단계 분해(TTFB/다운로드)
          </label>
        )}
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
