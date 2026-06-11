import { useCallback, useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { DataBinding, Profile } from "../api/schemas";
import type { ScheduleInput, TriggerInput } from "../api/schedules";
import { useEnvironment, useScenario } from "../api/hooks";
import { normalizeProfile } from "../api/runPrefill";
import { resolveEnv, type EnvEntry } from "../api/envOverlay";
import { parseScenarioDoc } from "../scenario/yamlDoc";
import { isLoopStep } from "../scenario/model";
import { LoadModelFields } from "./LoadModelFields";
import { loadModelErrors, type LoadModelState } from "./loadModel";
import { CriteriaFields } from "./CriteriaFields";
import {
  buildProfile as buildProfileShared,
  criteriaStateFrom,
  criteriaHasValue,
  criteriaActiveCount,
  type CriteriaState,
} from "./profileForm";
import { DataBindingPanel } from "./DataBindingPanel";
import { EnvironmentPicker } from "./EnvironmentPicker";
import { TriggerBuilder } from "./TriggerBuilder";
import type { BuilderState } from "./triggerCron";
import { Button } from "./Button";
import { ko } from "../i18n/ko";

export type ScenarioOption = { id: string; name: string };

type StageRow = { target: string; duration_seconds: string };

type Props = {
  scenarioOptions: ScenarioOption[];
  onSubmit: (input: ScheduleInput) => void;
  submitting: boolean;
  initial?: {
    name: string;
    scenario_id: string;
    profile: Profile;
    env: Record<string, string>;
    trigger: TriggerInput;
    enabled: boolean;
  };
  onCancel?: () => void;
};

export function ScheduleForm({ scenarioOptions, onSubmit, submitting, initial, onCancel }: Props) {
  const init = initial ? normalizeProfile(initial.profile) : undefined;

  const [name, setName] = useState(initial?.name ?? "");
  const [scenarioId, setScenarioId] = useState(initial?.scenario_id ?? "");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [trigger, setTrigger] = useState<TriggerInput | null>(initial?.trigger ?? null);

  // ── scenario fetch (for DataBindingPanel + hasLoop) ──────────────────────
  const scenarioQuery = useScenario(scenarioId || undefined);
  const parsedScenario = useMemo(() => {
    const yaml = scenarioQuery.data?.yaml;
    if (!yaml) return null;
    const parsed = parseScenarioDoc(yaml);
    return "model" in parsed ? parsed.model : null;
  }, [scenarioQuery.data?.yaml]);
  const hasLoop = parsedScenario?.steps.some(isLoopStep) ?? false;

  // ── load model state (mirrors RunDialog EXACTLY) ──────────────────────────
  const [loadModel, setLoadModel] = useState<"closed" | "open">(
    init?.target_rps != null || (init?.stages != null && init.stages.length > 0)
      ? "open"
      : "closed",
  );
  const [rateMode, setRateMode] = useState<"fixed" | "curve">(
    init?.stages && init.stages.length > 0 ? "curve" : "fixed",
  );
  const [targetRps, setTargetRps] = useState(
    init?.target_rps != null ? String(init.target_rps) : "100",
  );
  const [maxInFlight, setMaxInFlight] = useState(
    init?.max_in_flight != null ? String(init.max_in_flight) : "200",
  );
  const [stages, setStages] = useState<StageRow[]>(
    init?.stages?.map((s) => ({
      target: String(s.target),
      duration_seconds: String(s.duration_seconds),
    })) ?? [{ target: "100", duration_seconds: "30" }],
  );
  const [vus, setVus] = useState(init?.vus ?? 2);
  const [duration, setDuration] = useState(init?.duration_seconds ?? 5);
  const [rampUp, setRampUp] = useState(init?.ramp_up_seconds ?? 0);
  const [loopCap, setLoopCap] = useState(init?.loop_breakdown_cap ?? 256);
  const [httpTimeout, setHttpTimeout] = useState(init?.http_timeout_seconds ?? 30);

  // ── think-time state — DEFERRED (no UI, kept as empty strings) ───────────
  const [thinkMin] = useState("");
  const [thinkMax] = useState("");
  const [thinkSeed] = useState("");

  // ── SLO criteria ──────────────────────────────────────────────────────────
  const initC = init?.criteria ?? undefined;
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
  const [sloOpen, setSloOpen] = useState(() => criteriaHasValue(initCriteria));

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
    if (
      key === "minWindowRps" &&
      val.trim() !== "" &&
      rpsWarmup.trim() === "" &&
      loadModel === "closed"
    ) {
      setRpsWarmup(String(rampUp));
    }
  };

  // ── measure phases (진단/고급) ───────────────────────────────────────────
  const [measurePhases, setMeasurePhases] = useState(init?.measure_phases ?? false);
  const [advancedOpen, setAdvancedOpen] = useState(() => init?.measure_phases ?? false);

  // ── data binding ──────────────────────────────────────────────────────────
  const [binding, setBinding] = useState<DataBinding | null>(init?.data_binding ?? null);
  // DataBindingPanel 막힘 사유(ok + reasons). 패널의 emit effect deps에 onValidityChange가
  // 있어 인라인 화살표를 넘기면 부모 렌더마다 effect 재발화 → setState → 재렌더 루프 —
  // 반드시 stable useCallback으로 넘긴다.
  const [bindingBlock, setBindingBlock] = useState<{ ok: boolean; reasons: string[] }>({
    ok: true,
    reasons: [],
  });
  const onBindingValidity = useCallback(
    (ok: boolean, reasons: string[]) => setBindingBlock({ ok, reasons }),
    [],
  );
  // seedBinding drives DataBindingPanel's initialBinding; panelKey remounts the panel
  // on scenario change so it re-seeds with the reset (null) binding (mount-once contract).
  const [seedBinding, setSeedBinding] = useState<DataBinding | null>(init?.data_binding ?? null);
  const [panelKey, setPanelKey] = useState(0);

  // ── environment overlay ───────────────────────────────────────────────────
  const [selectedEnvId, setSelectedEnvId] = useState<string | null>(null);
  const selectedEnv = useEnvironment(selectedEnvId ?? undefined);
  const baseVars = selectedEnv.data?.vars ?? {};
  const [envEntries, setEnvEntries] = useState<EnvEntry[]>(
    initial ? Object.entries(initial.env).map(([key, value]) => ({ key, value })) : [],
  );

  // ── derived values ────────────────────────────────────────────────────────
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

  const loopCapInvalid = hasLoop && (loopCap < 0 || loopCap > 10000);
  const httpTimeoutInvalid = httpTimeout < 1 || httpTimeout > 600;

  const env: Record<string, string> = resolveEnv(baseVars, envEntries);

  const canSubmit =
    name.trim() !== "" &&
    scenarioId !== "" &&
    trigger != null &&
    bindingBlock.ok &&
    !loopCapInvalid &&
    !httpTimeoutInvalid &&
    (loadModel === "open"
      ? rateMode === "curve"
        ? !loadErrs.maxInFlightInvalid && !loadErrs.stagesInvalid
        : duration >= 1 && !loadErrs.targetRpsInvalid && !loadErrs.maxInFlightInvalid
      : vus >= 1 && duration >= 1 && !loadErrs.rampInvalid) &&
    !submitting;

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

  const submit = () => {
    if (!canSubmit || !trigger) return;
    onSubmit({
      name: name.trim(),
      scenario_id: scenarioId,
      profile: buildProfile(),
      env,
      trigger,
      enabled,
    });
  };

  const sloActiveCount = criteriaActiveCount(criteriaState);

  return (
    <div className="border border-slate-200 rounded-md p-4 bg-white">
      {/* 기본 정보 */}
      <div className="grid grid-cols-2 gap-3 mb-3 max-w-2xl">
        <label className="block text-sm">
          <span className="text-slate-600">이름</span>
          <input
            aria-label="이름"
            className="mt-1 block w-full rounded border border-slate-300 px-2 py-1"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="block text-sm">
          <span className="text-slate-600">시나리오</span>
          <select
            aria-label="시나리오"
            className="mt-1 block w-full rounded border border-slate-300 px-2 py-1"
            value={scenarioId}
            onChange={(e) => {
              setScenarioId(e.target.value);
              setBinding(null);
              setSeedBinding(null);
              setBindingBlock({ ok: true, reasons: [] });
              setPanelKey((k) => k + 1);
            }}
          >
            <option value="">선택…</option>
            {scenarioOptions.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* 트리거 */}
      <TriggerBuilder onChange={setTrigger} initial={triggerToInitial(initial?.trigger)} />

      {/* 부하 모델 */}
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
        setStages={
          setStages as Dispatch<SetStateAction<{ target: string; duration_seconds: string }[]>>
        }
        errs={loadErrs}
      />

      {/* HTTP timeout */}
      <div className="mb-3 max-w-xs">
        <label className="block text-sm">
          <span className="text-slate-600">{ko.loadModel.httpTimeout}</span>
          <input
            type="number"
            min={1}
            max={600}
            aria-label={ko.loadModel.httpTimeout}
            value={httpTimeout}
            onChange={(e) => setHttpTimeout(Number(e.target.value))}
            className="mt-1 block w-full rounded border border-slate-300 px-2 py-1"
            aria-invalid={httpTimeoutInvalid}
          />
        </label>
      </div>

      {/* Loop breakdown cap (loop 스텝이 있는 시나리오에서만) */}
      {hasLoop && (
        <div className="mb-3">
          <label className="block text-sm">
            {ko.loadModel.loopCap}
            <input
              type="number"
              min={0}
              max={10000}
              aria-label={ko.loadModel.loopCap}
              value={loopCap}
              onChange={(e) => setLoopCap(Number(e.target.value))}
              className="mt-1 block w-full rounded border border-slate-300 px-2 py-1"
              aria-invalid={loopCapInvalid}
            />
            <span className="text-xs text-slate-500">
              0 = 끄기 · 루프 스텝의 loop_index별 집계 상한
            </span>
          </label>
        </div>
      )}

      {/* SLO 기준 (선택) */}
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

      {/* 진단/고급 (선택) */}
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

      {/* 환경 */}
      <EnvironmentPicker
        selectedEnvId={selectedEnvId}
        onSelect={setSelectedEnvId}
        baseVars={baseVars}
        overrides={envEntries}
        onOverridesChange={setEnvEntries}
      />

      {/* 데이터 바인딩 (시나리오 파싱 완료 시) */}
      {parsedScenario && (
        <DataBindingPanel
          key={panelKey}
          scenario={parsedScenario}
          initialBinding={seedBinding}
          onChange={setBinding}
          onValidityChange={onBindingValidity}
        />
      )}

      {/* 활성화 */}
      <label className="mb-3 flex items-center gap-2 text-sm">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        활성화 (체크 해제 시 발사 안 함)
      </label>

      {/* 막힘 사유 블록 — 저장 버튼 비활성 이유를 나열 */}
      {(() => {
        // ScheduleForm은 접힘 섹션이 없어 인라인 aria-invalid만 있고 에러 p가 없다.
        // 따라서 httpTimeout/loopCap invalid도 블록에 포함(중복 없음).
        const blockedReasons: string[] = [
          ...(!bindingBlock.ok
            ? bindingBlock.reasons.map((r) => ko.runDialog.bindingReasonPrefix + r)
            : []),
          ...(httpTimeoutInvalid ? [ko.validation.httpTimeout] : []),
          ...(loopCapInvalid ? [ko.validation.loopCap] : []),
        ];
        return (
          blockedReasons.length > 0 && (
            <div
              role="status"
              className="mb-3 rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-800"
            >
              <p className="font-medium">{ko.runDialog.blockedReasonsIntro}</p>
              <ul className="list-disc pl-5">
                {blockedReasons.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </div>
          )
        );
      })()}

      {/* 액션 버튼 */}
      <div className="flex gap-2">
        <Button onClick={submit} disabled={!canSubmit}>
          {submitting ? "저장 중…" : "저장"}
        </Button>
        {onCancel && (
          <Button variant="secondary" onClick={onCancel}>
            취소
          </Button>
        )}
      </div>
    </div>
  );
}

/** TriggerInput → TriggerBuilder initial 상태로 역변환. */
function triggerToInitial(t?: TriggerInput): Partial<BuilderState> | undefined {
  if (!t) return undefined;
  if (t.kind === "once") return { mode: "once", runAtLocal: msToLocalDatetime(t.run_at) };
  // cron: best-effort mode 추측(저장/수정 UX용) — 정확도보다 round-trip 안정성 우선
  return { mode: "advanced", raw: t.cron_expr };
}

function msToLocalDatetime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
