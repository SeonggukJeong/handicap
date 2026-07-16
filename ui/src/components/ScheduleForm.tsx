import { useCallback, useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { DataBinding, Profile } from "../api/schemas";
import type { ScheduleInput, TriggerInput } from "../api/schedules";
import { useEnvironment, useScenario } from "../api/hooks";
import { normalizeProfile, seedBindingsFrom } from "../api/runPrefill";
import { resolveEnv, type EnvEntry } from "../api/envOverlay";
import { parseScenarioDoc } from "../scenario/yamlDoc";
import { isLoopStep, flattenHttpSteps } from "../scenario/model";
import { LoadModelFields } from "./LoadModelFields";
import { loadModelErrors, deriveLoadMode, type LoadModelState } from "./loadModel";
import { CriteriaFields } from "./CriteriaFields";
import {
  buildProfile as buildProfileShared,
  criteriaStateFrom,
  criteriaHasValue,
  criteriaActiveCount,
  type CriteriaState,
  type StepCriterionDraft,
} from "./profileForm";
import { StepCriteriaFields, type StepOption } from "./StepCriteriaFields";
import { DataBindingPanel } from "./DataBindingPanel";
import { EnvironmentPicker } from "./EnvironmentPicker";
import { TriggerBuilder } from "./TriggerBuilder";
import type { BuilderState } from "./triggerCron";
import { Button } from "./Button";
import { Input } from "./ui/Input";
import { Select } from "./ui/Select";
import { Section } from "./ui/Section";
import { Callout } from "./ui/Callout";
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

  // ── load model state (mirrors RunDialog EXACTLY, deriveLoadMode 단일화) ──────
  const initMode = deriveLoadMode(init ?? {});
  const [loadModel, setLoadModel] = useState<"closed" | "open">(initMode.loadModel);
  const [rateMode, setRateMode] = useState<"fixed" | "curve">(initMode.rateMode);
  const [targetRps, setTargetRps] = useState(
    init?.target_rps != null ? String(init.target_rps) : "100",
  );
  const [maxInFlight, setMaxInFlight] = useState(
    init?.max_in_flight != null ? String(init.max_in_flight) : "200",
  );
  // worker_count는 RunDialog에서만 편집 — ScheduleForm은 state로 round-trip만(입력 미렌더).
  const [workerCount] = useState(init?.worker_count != null ? String(init.worker_count) : "1");
  const [rampDown, setRampDown] = useState<"graceful" | "immediate">(init?.ramp_down ?? "graceful");
  // graceful ramp-down 상한(초, §B9). string draft — 빈칸 = 무제한(미설정).
  const [gracefulCap, setGracefulCap] = useState(
    init?.graceful_ramp_down_seconds != null ? String(init.graceful_ramp_down_seconds) : "",
  );
  const [stages, setStages] = useState<StageRow[]>(
    (init?.vu_stages?.length ? init.vu_stages : init?.stages)?.map((s) => ({
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
  const [stepCriteria, setStepCriteria] = useState<StepCriterionDraft[]>(initCriteria.stepCriteria);
  const [sloOpen, setSloOpen] = useState(() => criteriaHasValue(initCriteria));

  const stepOptions = useMemo<StepOption[]>(() => {
    if (!parsedScenario) return [];
    return flattenHttpSteps(parsedScenario.steps).map((s) => ({
      id: s.id,
      label: `${s.name || s.id} (${s.request.method} ${s.request.url || "—"})`,
    }));
  }, [parsedScenario]);

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
    stepCriteria,
  };
  // Task 6: stepCriteria는 별도 array state로 다룬다(string setter 아님) — 여기선 제외.
  const criteriaSetters: Record<
    Exclude<keyof CriteriaState, "stepCriteria">,
    (v: string) => void
  > = {
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
    if (key === "stepCriteria") return; // Task 6: array state 경로로 분리
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
  // 다중 데이터 바인딩 (RunDialog와 lockstep). 레거시 단일 data_binding은 한 카드로 복원.
  const [bindings, setBindings] = useState<DataBinding[]>(seedBindingsFrom(init));
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
  // seedBindings drives DataBindingPanel's initialBindings; panelKey remounts the panel
  // on scenario change so it re-seeds with the reset ([]) bindings (mount-once contract).
  const [seedBindings, setSeedBindings] = useState<DataBinding[]>(seedBindingsFrom(init));
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
    rampDown, // 실제 state 배선 (Task 7+8)
    workerCount,
    gracefulCap,
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
      : rateMode === "curve"
        ? !loadErrs.stagesInvalid && !loadErrs.gracefulCapInvalid
        : vus >= 1 && duration >= 1 && !loadErrs.rampInvalid) &&
    !submitting;

  function buildProfile(): Profile {
    return buildProfileShared({
      hasLoop,
      loopCap,
      httpTimeout,
      bindings,
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
          <Input
            aria-label="이름"
            className="mt-1"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="block text-sm">
          <span className="text-slate-600">시나리오</span>
          <Select
            aria-label="시나리오"
            className="mt-1"
            value={scenarioId}
            onChange={(e) => {
              setScenarioId(e.target.value);
              setBindings([]);
              setSeedBindings([]);
              setBindingBlock({ ok: true, reasons: [] });
              setPanelKey((k) => k + 1);
              setStepCriteria([]);
            }}
          >
            <option value="">선택…</option>
            {scenarioOptions.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </Select>
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
        rampDown={rampDown}
        setRampDown={setRampDown}
        gracefulCap={gracefulCap}
        setGracefulCap={setGracefulCap}
        errs={loadErrs}
      />

      {/* HTTP timeout */}
      <div className="mb-3 max-w-xs">
        <label className="block text-sm">
          <span className="text-slate-600">{ko.loadModel.httpTimeout}</span>
          <Input
            type="number"
            min={1}
            max={600}
            aria-label={ko.loadModel.httpTimeout}
            value={httpTimeout}
            onChange={(e) => setHttpTimeout(Number(e.target.value))}
            className="mt-1"
            aria-invalid={httpTimeoutInvalid}
          />
        </label>
      </div>

      {/* Loop breakdown cap (loop 스텝이 있는 시나리오에서만) */}
      {hasLoop && (
        <div className="mb-3">
          <label className="block text-sm">
            {ko.loadModel.loopCap}
            <Input
              type="number"
              min={0}
              max={10000}
              aria-label={ko.loadModel.loopCap}
              value={loopCap}
              onChange={(e) => setLoopCap(Number(e.target.value))}
              className="mt-1"
              aria-invalid={loopCapInvalid}
            />
            <span className="text-xs text-slate-500">
              0 = 끄기 · 루프 스텝의 loop_index별 집계 상한
            </span>
          </label>
        </div>
      )}

      {/* SLO 기준 (선택) */}
      <Section
        title="SLO 기준 (선택)"
        collapsible
        open={sloOpen}
        onToggle={() => setSloOpen((v) => !v)}
        divider
        hint={!sloOpen && sloActiveCount > 0 ? `${sloActiveCount}개 설정됨` : undefined}
      >
        <CriteriaFields value={criteriaState} onChange={setCriteria} />
        <StepCriteriaFields value={stepCriteria} options={stepOptions} onChange={setStepCriteria} />
      </Section>

      {/* 진단/고급 (선택) */}
      <Section
        title="진단/고급 (선택)"
        collapsible
        open={advancedOpen}
        onToggle={() => setAdvancedOpen((v) => !v)}
        divider
        hint={!advancedOpen && measurePhases ? "1개 설정됨" : undefined}
      >
        <label className="mt-2 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={measurePhases}
            onChange={(e) => setMeasurePhases(e.target.checked)}
          />
          측정: 레이턴시 단계 분해(TTFB/다운로드)
        </label>
      </Section>

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
          initialBindings={seedBindings}
          onChange={setBindings}
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
            <Callout variant="warn" role="status" className="mb-3">
              <p className="font-medium">{ko.runDialog.blockedReasonsIntro}</p>
              <ul className="list-disc pl-5">
                {blockedReasons.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </Callout>
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
