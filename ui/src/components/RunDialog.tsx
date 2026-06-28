import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCreatePreset,
  useCreateRun,
  useDeletePreset,
  useEnvironment,
  usePoolWorkers,
  usePresets,
  useUpdatePreset,
  queryKeys,
} from "../api/hooks";
import type { DataBinding, Profile } from "../api/schemas";
import type { Scenario } from "../scenario/model";
import { flattenHttpSteps } from "../scenario/model";
import { DataBindingPanel } from "./DataBindingPanel";
import { Button } from "./Button";
import type { RunPrefill } from "../api/runPrefill";
import { envValueToRecord, normalizeProfile, seedBindingsFrom } from "../api/runPrefill";
import { getPreset } from "../api/presets";
import type { PresetInput } from "../api/presets";
import { EnvironmentPicker } from "./EnvironmentPicker";
import { resolveEnv, type EnvEntry } from "../api/envOverlay";
import { LoadModelFields } from "./LoadModelFields";
import { loadModelErrors, deriveLoadMode, type LoadModelState } from "./loadModel";
import {
  buildProfile as buildProfileShared,
  type CriteriaState,
  type StepCriterionDraft,
  criteriaStateFrom,
  criteriaHasValue,
  criteriaActiveCount,
} from "./profileForm";
import { CriteriaFields } from "./CriteriaFields";
import { StepCriteriaFields, type StepOption } from "./StepCriteriaFields";
import { ko } from "../i18n/ko";
import { HelpTip } from "./HelpTip";
import { PoolCapacityError } from "../api/client";
import { scaleVuStages, peakStageTarget } from "./sizing";
import { runSummary } from "./runSummary";
import { StageCurvePreview } from "./StageCurvePreview";
import { LoadShapePreview } from "./LoadShapePreview";
import { Section } from "./ui/Section";
import { Badge } from "./ui/Badge";
import { Callout } from "./ui/Callout";
import { Field } from "./ui/Field";
import { Input } from "./ui/Input";
import { Select } from "./ui/Select";
import { Segmented } from "./ui/Segmented";

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
  // deriveLoadMode is the single source of truth for reverse-derivation (RunDialog init /
  // RunDialog loadPreset / ScheduleForm init).
  const initMode = deriveLoadMode(initial?.profile ?? {});
  const [loadModel, setLoadModel] = useState<"closed" | "open">(initMode.loadModel);
  const [rateMode, setRateMode] = useState<"fixed" | "curve">(initMode.rateMode);
  const [targetRps, setTargetRps] = useState(
    initial?.profile.target_rps != null ? String(initial.profile.target_rps) : "100",
  );
  const [maxInFlight, setMaxInFlight] = useState(
    initial?.profile.max_in_flight != null ? String(initial.profile.max_in_flight) : "200",
  );
  const [workerCount, setWorkerCount] = useState(
    initial?.profile.worker_count != null ? String(initial.profile.worker_count) : "1",
  );
  const [rampDown, setRampDown] = useState<"graceful" | "immediate">(
    initial?.profile.ramp_down ?? "graceful",
  );
  const [stages, setStages] = useState<{ target: string; duration_seconds: string }[]>(
    (initial?.profile.vu_stages?.length ? initial.profile.vu_stages : initial?.profile.stages)?.map(
      (s) => ({
        target: String(s.target),
        duration_seconds: String(s.duration_seconds),
      }),
    ) ?? [{ target: "100", duration_seconds: "30" }],
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
  const [stepCriteria, setStepCriteria] = useState<StepCriterionDraft[]>(initCriteria.stepCriteria);
  // think time(페이싱) draft. Empty inputs omit think_time / think_seed entirely
  // (byte-identical to pre-feature submit).
  const numToStr = (n?: number | null) => (n == null ? "" : String(n));
  const initTT = initial?.profile.think_time;
  const [thinkMin, setThinkMin] = useState(numToStr(initTT?.min_ms));
  const [thinkMax, setThinkMax] = useState(numToStr(initTT?.max_ms));
  const [thinkSeed, setThinkSeed] = useState(numToStr(initial?.profile.think_seed));
  const [envEntries, setEnvEntries] = useState<EnvEntry[]>(() =>
    initial ? Object.entries(initial.env).map(([key, value]) => ({ key, value })) : [],
  );
  const [measurePhases, setMeasurePhases] = useState(initial?.profile.measure_phases ?? false);
  // 상세 모드 예측 술어 — mode 초기값·advancedOpen 초기값 양쪽에서 재사용.
  function advancedPrefill(init: RunPrefill | undefined): boolean {
    const iC = init?.profile.criteria ?? undefined;
    const iCriteria = criteriaStateFrom(iC);
    const iTT = init?.profile.think_time;
    return (
      criteriaHasValue(iCriteria) ||
      iTT != null ||
      init?.profile.think_seed != null ||
      (init?.profile.measure_phases ?? false) ||
      (init?.profile.http_timeout_seconds != null && init.profile.http_timeout_seconds !== 30) ||
      (hasLoop &&
        init?.profile.loop_breakdown_cap != null &&
        init.profile.loop_breakdown_cap !== 256)
    );
  }
  // 상세 모드를 열어야 하는지 판단 — profile + env 기준. loadPreset과 mode 초기값에서 공유.
  // 단방향 전환(상세→간단은 이 술어로 강제하지 않음).
  function opensDetailed(profile: Profile, env: Record<string, string>): boolean {
    return (
      advancedPrefill({ profile, env }) ||
      deriveLoadMode(profile).rateMode === "curve" ||
      Number(profile.worker_count ?? 1) > 1 ||
      Object.keys(env).length > 0 ||
      seedBindingsFrom(profile).length > 0
    );
  }
  // '판정·고급' 단일 토글(SLO·페이싱·진단 통합, spec §6.1). 시드된 비기본값이 접힌
  // 그룹에 숨지 않게, 하나라도 있으면 펼친 채 시작.
  const [advancedOpen, setAdvancedOpen] = useState(() => advancedPrefill(initial));
  // 간단/상세 모드. 시드된 값이 상세-전용이면 상세로 시작.
  const [mode, setMode] = useState<"simple" | "detailed">(() =>
    initial != null && opensDetailed(initial.profile, initial.env) ? "detailed" : "simple",
  );
  // 다중 데이터 바인딩. 레거시 단일 data_binding은 한 카드로 복원(읽기 호환).
  const [bindings, setBindings] = useState<DataBinding[]>(seedBindingsFrom(initial?.profile));
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
  // B-2 environment overlay. Prefill (preset/retry) is override-only (env = none):
  // the stored env is already a resolved snapshot, so it seeds envEntries with no base.
  const [selectedEnvId, setSelectedEnvId] = useState<string | null>(null);
  const selectedEnv = useEnvironment(selectedEnvId ?? undefined);
  const baseVars = selectedEnv.data?.vars ?? {};

  // seedBindings drives the DataBindingPanel's initialBindings; bumping panelKey remounts
  // the panel so it re-seeds from the loaded preset's bindings (explicit user action).
  const [seedBindings, setSeedBindings] = useState<DataBinding[]>(
    seedBindingsFrom(initial?.profile),
  );
  const [panelKey, setPanelKey] = useState(0);
  // loadedPresetId / presetName: used by save/rename/delete preset controls.
  const [loadedPresetId, setLoadedPresetId] = useState<string | null>(null);
  // 1b: 드롭다운 표시는 render-derived (loadedPresetId 미클리어 — rename/delete 보존).
  const [presetSnapshotKey, setPresetSnapshotKey] = useState<string>("");
  const [presetLoadTick, setPresetLoadTick] = useState(0);
  const [presetName, setPresetName] = useState("");
  const [presetError, setPresetError] = useState<string | null>(null);

  const presets = usePresets(scenarioId);
  const pool = usePoolWorkers();
  const qc = useQueryClient();

  // Stable ids for Field+Input pairs (B3). Must be at hook call site (Rules of Hooks).
  const thinkMinId = useId();
  const thinkMaxId = useId();
  const thinkSeedId = useId();
  const httpTimeoutId = useId();
  const loopCapId = useId();

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
      const b = seedBindingsFrom(prof);
      setBindings(b);
      setSeedBindings(b);
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
      setStepCriteria(pc.stepCriteria);
      const ptt = prof.think_time ?? undefined;
      setThinkMin(numToStr(ptt?.min_ms));
      setThinkMax(numToStr(ptt?.max_ms));
      setThinkSeed(numToStr(prof.think_seed ?? undefined));
      // 프리셋의 비기본 고급 값이 접힌 그룹에 숨지 않게 펼침. measure_phases는 의도적
      // 제외 — loadPreset이 measurePhases state를 시드하지 않는 기존 갭이 있어(수정은
      // U1b 범위 밖), 조건에 넣으면 "펼쳤는데 체크박스 꺼짐" 불일치가 생긴다.
      if (
        criteriaHasValue(pc) ||
        ptt != null ||
        prof.think_seed != null ||
        prof.http_timeout_seconds !== 30 ||
        (hasLoop && prof.loop_breakdown_cap !== 256)
      ) {
        setAdvancedOpen(true);
      }
      // 모드 역도출은 deriveLoadMode 단일화 (vu_stages → closed+curve, stages → open+curve, etc.)
      const mode = deriveLoadMode(prof);
      setLoadModel(mode.loadModel);
      setRateMode(mode.rateMode);
      if (prof.target_rps != null) setTargetRps(String(prof.target_rps));
      if (prof.max_in_flight != null) setMaxInFlight(String(prof.max_in_flight));
      if (prof.worker_count != null) setWorkerCount(String(prof.worker_count));
      else setWorkerCount("1");
      const curveStages = prof.vu_stages?.length ? prof.vu_stages : prof.stages;
      if (curveStages && curveStages.length > 0) {
        setStages(
          curveStages.map((s) => ({
            target: String(s.target),
            duration_seconds: String(s.duration_seconds),
          })),
        );
      }
      setRampDown(prof.ramp_down ?? "graceful");
      // Fix-1b: 프리셋이 상세-전용 설정(바인딩·곡선·멀티워커·env·고급)을 포함하면
      // 간단 모드였어도 상세로 단방향 전환. 역방향(상세→간단) 강제는 없음.
      if (opensDetailed(prof, envValueToRecord(p.env))) setMode("detailed");
      setLoadedPresetId(id);
      setPresetName(p.name);
      setPresetLoadTick((t) => t + 1); // 1b: commit 후 스냅샷 재캡처 트리거
    } catch (e) {
      setPresetError((e as Error).message);
    }
  }

  const createPreset = useCreatePreset(scenarioId);
  const updatePreset = useUpdatePreset(scenarioId);
  const deletePreset = useDeletePreset(scenarioId);

  const mutation = useCreateRun();

  // 풀 과부하 가드 (L3): PoolCapacityError 발생 시 확인 다이얼로그 상태.
  const [poolConflict, setPoolConflict] = useState<{
    achievable: number;
    requested: number;
  } | null>(null);
  useEffect(() => {
    const e = mutation.error;
    if (e instanceof PoolCapacityError) {
      setPoolConflict({ achievable: e.achievable_vus, requested: e.requested_vus });
    }
  }, [mutation.error]);

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
    stepCriteria,
  };
  const stepOptions = useMemo<StepOption[]>(() => {
    if (!scenario) return [];
    return flattenHttpSteps(scenario.steps).map((s) => ({
      id: s.id,
      label: `${s.name || s.id} (${s.request.method} ${s.request.url || "—"})`,
    }));
  }, [scenario]);
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
  // '판정·고급' 접힘 힌트 카운트. 타임아웃·루프캡은 항상 값이 있는 기본 입력이라 제외.
  // open 모드에서는 think time 입력이 비노출·payload 미포함이라 계산에서 제외.
  const advancedActiveCount =
    sloActiveCount + (loadModel === "closed" ? pacingActiveCount : 0) + (measurePhases ? 1 : 0);
  // 판정·고급 접힘 힌트: measure는 이제 별도 섹션이라 collapse 힌트에서 제외 (R9·리뷰 A).
  const collapseHintCount = sloActiveCount + (loadModel === "closed" ? pacingActiveCount : 0);
  // 간단 모드에서 숨겨진 상세 설정 수 (R6). measure는 advancedActiveCount 경유로만 — 이중 계수 금지.
  const detailedAppliedCount =
    advancedActiveCount +
    (rateMode === "curve" ? 1 : 0) +
    (Number(workerCount) > 1 ? 1 : 0) +
    (httpTimeout !== 30 ? 1 : 0) +
    (hasLoop && loopCap !== 256 ? 1 : 0) +
    (loadModel === "closed" && rateMode === "curve" && rampDown !== "graceful" ? 1 : 0) +
    // Fix-1c: 데이터 바인딩이 활성 상태면 카운트에 포함 (간단 모드에선 패널이 숨겨짐).
    (bindings.length > 0 ? 1 : 0);
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
    rampDown, // 실제 state 배선 (Task 7+8)
    workerCount,
  };
  const loadErrs = loadModelErrors(loadState);
  // 실시간 요약 footer (R8). loadState가 곧 form 상태라 sum은 항상 라이브.
  const sum = runSummary(loadState);
  // StageCurvePreview용 숫자 변환 (string-draft → Stage[], 유효 행만)
  const previewStages = stages
    .map((s) => ({ target: Number(s.target), duration_seconds: Number(s.duration_seconds) }))
    .filter(
      (s) =>
        Number.isFinite(s.target) && Number.isFinite(s.duration_seconds) && s.duration_seconds > 0,
    );
  const canSubmit =
    !poolConflict &&
    (loadModel === "open"
      ? rateMode === "curve"
        ? !loadErrs.maxInFlightInvalid &&
          !loadErrs.stagesInvalid &&
          !loadErrs.workerCountInvalid &&
          !loopCapInvalid &&
          !httpTimeoutInvalid &&
          bindingBlock.ok &&
          !mutation.isPending
        : duration >= 1 &&
          !loadErrs.targetRpsInvalid &&
          !loadErrs.maxInFlightInvalid &&
          !loadErrs.workerCountInvalid &&
          !loopCapInvalid &&
          !httpTimeoutInvalid &&
          bindingBlock.ok &&
          !mutation.isPending
      : rateMode === "curve"
        ? !loadErrs.stagesInvalid &&
          !loopCapInvalid &&
          !httpTimeoutInvalid &&
          !thinkInvalid &&
          bindingBlock.ok &&
          !mutation.isPending
        : vus >= 1 &&
          duration >= 1 &&
          !loadErrs.rampInvalid &&
          !loopCapInvalid &&
          !httpTimeoutInvalid &&
          !thinkInvalid &&
          bindingBlock.ok &&
          !mutation.isPending);

  // Merge selected environment (base) under the per-run override rows. With no env
  // selected, baseVars is {} and this is byte-identical to the old loop.
  const env: Record<string, string> = resolveEnv(baseVars, envEntries);

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
      bindings,
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
          onSuccess: () => {
            setLoadedPresetId(existing.id);
            setPresetLoadTick((t) => t + 1);
          },
        },
      );
    } else {
      createPreset.mutate(currentInput(), {
        onError: (e) => setPresetError((e as Error).message),
        onSuccess: (p) => {
          setLoadedPresetId(p.id);
          setPresetLoadTick((t) => t + 1);
        },
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
        onSuccess: () => {
          setPresetName(next);
          setPresetLoadTick((t) => t + 1);
        },
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

  // 1b: 현재 폼의 정규화 키 + latest-value ref (effect가 ref로 읽어 exhaustive-deps 회피).
  const currentProfileKey = JSON.stringify(buildProfile());
  const keyRef = useRef(currentProfileKey);
  keyRef.current = currentProfileKey;
  // load/save/rename이 commit된 뒤 그 시점 폼으로 스냅샷 캡처(단일 발화).
  // currentProfileKey를 dep에 넣지 말 것 — 매 수정마다 재캡처돼 드롭다운이 복귀 안 함.
  useEffect(() => {
    setPresetSnapshotKey(keyRef.current);
  }, [presetLoadTick]);

  // 정밀계기 룩 — 섹션 타이틀 eyebrow 스타일 (RunDialog 국소)
  const eyebrowCls = "text-[10px] font-semibold uppercase tracking-[0.15em] text-slate-500";

  return (
    <div className="border border-slate-200 rounded-md p-4 bg-white shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-lg font-semibold">{ko.runDialog.title}</h3>
        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            { value: "simple", label: ko.runDialog.modeSimple },
            { value: "detailed", label: ko.runDialog.modeDetail },
          ]}
          ariaLabel={ko.runDialog.modeAria}
        />
      </div>
      {scenarioChangedWarning && (
        <Callout variant="warn" role="alert" className="mb-3">
          이 시나리오는 이 run 이후 수정됨 — 설정이 안 맞을 수 있습니다.
        </Callout>
      )}
      {presets.data && presets.data.length > 0 && (
        <div className="mb-3 flex items-center gap-2">
          <label
            className="text-sm text-slate-600 shrink-0 whitespace-nowrap"
            htmlFor="load-preset"
          >
            프리셋 불러오기
          </label>
          <Select
            id="load-preset"
            aria-label={ko.runDialog.loadPresetAria}
            value={loadedPresetId && currentProfileKey === presetSnapshotKey ? loadedPresetId : ""}
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
          </Select>
        </div>
      )}
      {presetError && (
        <Callout variant="error" role="alert" className="mb-3">
          프리셋 오류: {presetError}
        </Callout>
      )}
      {/* 그룹 1: 부하 정의 — 항상 펼침 */}
      <Section
        index={1}
        title={<span className={eyebrowCls}>{ko.runDialog.sectionLoadTitle}</span>}
        badge={<Badge tone="required">{ko.common.required}</Badge>}
      >
        <p className="mb-2 text-xs text-accent-700">{ko.runDialog.recommendedNotice}</p>
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
          rampDown={rampDown}
          setRampDown={setRampDown}
          errs={loadErrs}
          sizingScenarioId={scenarioId}
          sizingScenario={scenario}
          sizingEnv={env}
          onApplyVus={setVus}
          onApplyMaxInFlight={(n) => setMaxInFlight(String(n))}
          workerCount={workerCount}
          setWorkerCount={setWorkerCount}
          onApplyWorkerCount={(n) => setWorkerCount(String(n))}
          httpTimeout={httpTimeout}
          poolMode={pool.data?.pool_mode}
          showRecommended
          simpleMode={mode === "simple"}
          loadModelTiles
          numeric
        />
        {/* R17: 간단 모드에서 곡선이 설정된 경우 읽기전용 카드 표시. rateMode는 절대 변경하지 않음. */}
        {mode === "simple" && rateMode === "curve" && previewStages.length > 0 && (
          <div className="mt-3 rounded border border-slate-200 bg-slate-50 p-3">
            <p className="text-sm font-medium">{ko.runDialog.curveCardTitle}</p>
            <p className="text-xs text-slate-500 mb-1">{ko.runDialog.curveCardHint}</p>
            {/* Fix-2: 카드 내 프리뷰는 장식용 — aria-hidden으로 SR 중복 억제.
                푸터의 role="img"가 유일한 SR 구술 지점. */}
            <div aria-hidden="true" className="h-20">
              <StageCurvePreview stages={previewStages} width={300} height={80} />
            </div>
          </div>
        )}
      </Section>
      {pool.data?.pool_mode
        ? (() => {
            const idle = pool.data.workers.filter((w) => !w.drained && !w.busy);
            const idleCapacity = idle.reduce(
              (sum, w) => sum + Math.max(w.capacity_override ?? w.capacity_vus, 1),
              0,
            );
            const drainedCount = pool.data.workers.filter((w) => w.drained && !w.busy).length;
            const closedFixed = loadModel === "closed" && rateMode === "fixed";
            const closedCurve = loadModel === "closed" && rateMode === "curve";
            const isOpenLoop = loadModel === "open";
            const curvePeak = closedCurve ? peakStageTarget(stages) : null; // number | null
            const overClosed = closedFixed && Number(vus) > idleCapacity;
            const overOpen =
              isOpenLoop && maxInFlight.trim() !== "" && Number(maxInFlight) > idleCapacity;
            const overCurve = closedCurve && curvePeak != null && curvePeak > idleCapacity;
            const over = overClosed || overOpen || overCurve;
            return (
              <div className="mb-4">
                <p className="text-sm text-slate-600">
                  {ko.workers.poolPreview(idle.length)} ·{" "}
                  {ko.capacityGuard.totalCapacity(idleCapacity)}
                  {drainedCount > 0 ? " " + ko.workers.poolPreviewDrained(drainedCount) : ""}
                </p>
                {over ? (
                  <Callout variant="warn" role="status">
                    {overCurve
                      ? ko.capacityGuard.overHintCurve(idleCapacity)
                      : overOpen
                        ? ko.capacityGuard.overHintOpen(idleCapacity)
                        : ko.capacityGuard.overHint(idleCapacity)}
                  </Callout>
                ) : null}
              </div>
            );
          })()
        : null}

      {/* 그룹 2: 환경 — 항상 펼침 */}
      <Section
        index={2}
        divider
        title={<span className={eyebrowCls}>{ko.runDialog.sectionEnvTitle}</span>}
        badge={<Badge tone="optional">{ko.common.optional}</Badge>}
      >
        <EnvironmentPicker
          selectedEnvId={selectedEnvId}
          onSelect={setSelectedEnvId}
          baseVars={baseVars}
          overrides={envEntries}
          onOverridesChange={setEnvEntries}
          showOverrides={mode === "detailed"}
        />
      </Section>

      {/* 그룹 3: 데이터셋 바인딩 — 상세+시나리오 존재 시만 */}
      {mode === "detailed" && scenario && (
        <Section
          index={3}
          divider
          title={<span className={eyebrowCls}>{ko.runDialog.sectionDatasetTitle}</span>}
          badge={<Badge tone="optional">{ko.common.optional}</Badge>}
        >
          <DataBindingPanel
            key={panelKey}
            scenario={scenario}
            initialBindings={seedBindings}
            onChange={setBindings}
            onValidityChange={onBindingValidity}
          />
        </Section>
      )}

      {/* 그룹 4: 측정 — 상세-only (R13·R14③) */}
      {mode === "detailed" && (
        <Section
          index={4}
          divider
          title={<span className={eyebrowCls}>{ko.runDialog.sectionMeasureTitle}</span>}
          badge={<Badge tone="optional">{ko.common.optional}</Badge>}
        >
          <div className="flex items-start gap-3 rounded-lg border border-slate-200 p-3">
            <button
              type="button"
              role="switch"
              aria-checked={measurePhases}
              aria-label={ko.runDialog.measureTitle}
              onClick={() => setMeasurePhases(!measurePhases)}
              className={`relative mt-0.5 h-[22px] w-[38px] shrink-0 rounded-full transition-colors ${measurePhases ? "bg-accent-600" : "bg-slate-300"}`}
            >
              <span
                aria-hidden="true"
                className={`absolute top-0.5 h-[18px] w-[18px] rounded-full bg-white shadow transition-all ${measurePhases ? "left-[18px]" : "left-0.5"}`}
              />
            </button>
            <span className="flex flex-col">
              <span className="flex items-center gap-1 text-sm font-semibold">
                {ko.runDialog.measureTitle}
                <HelpTip label={ko.runDialog.measureTitle}>{ko.runDialog.measureDesc}</HelpTip>
              </span>
              <span className="text-xs text-slate-500">{ko.runDialog.measureDesc}</span>
            </span>
          </div>
        </Section>
      )}

      {/* 그룹 5: 판정·고급 — Section 접힘(Section이 open 게이트 소유) */}
      {mode === "detailed" && (
        <Section
          index={5}
          divider
          title={<span className={eyebrowCls}>{ko.runDialog.sectionAdvancedTitle}</span>}
          badge={<Badge tone="optional">{ko.common.optional}</Badge>}
          collapsible
          open={advancedOpen}
          onToggle={() => setAdvancedOpen((v) => !v)}
          hint={collapseHintCount > 0 ? ko.runDialog.advancedSetHint(collapseHintCount) : undefined}
        >
          <>
            <h4 className={`mt-2 ${eyebrowCls}`}>
              {ko.runDialog.sectionSlo}
              <HelpTip label="SLO 설명">{ko.glossary.slo}</HelpTip>
            </h4>
            <CriteriaFields value={criteriaState} onChange={setCriteria} />
            <StepCriteriaFields
              value={stepCriteria}
              options={stepOptions}
              onChange={setStepCriteria}
            />

            {loadModel === "closed" && (
              <>
                <h4 className={`mt-3 ${eyebrowCls}`}>
                  {ko.runDialog.sectionPacing}
                  <HelpTip label="think time 설명">{ko.glossary.thinkTime}</HelpTip>
                </h4>
                <div className="grid grid-cols-2 gap-2">
                  <Field label={ko.loadModel.thinkMin} htmlFor={thinkMinId}>
                    <Input
                      id={thinkMinId}
                      type="number"
                      min="0"
                      value={thinkMin}
                      onChange={(e) => setThinkMin(e.target.value)}
                      aria-invalid={thinkInvalid}
                      aria-describedby={thinkInvalid ? "think-time-error" : undefined}
                    />
                  </Field>
                  <Field label={ko.loadModel.thinkMax} htmlFor={thinkMaxId}>
                    <Input
                      id={thinkMaxId}
                      type="number"
                      min="0"
                      value={thinkMax}
                      onChange={(e) => setThinkMax(e.target.value)}
                      aria-invalid={thinkInvalid}
                      aria-describedby={thinkInvalid ? "think-time-error" : undefined}
                    />
                  </Field>
                  <Field label={ko.loadModel.thinkSeed} htmlFor={thinkSeedId}>
                    <Input
                      id={thinkSeedId}
                      type="number"
                      min="0"
                      value={thinkSeed}
                      onChange={(e) => setThinkSeed(e.target.value)}
                    />
                  </Field>
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

            <h4 className={`mt-3 ${eyebrowCls}`}>{ko.runDialog.sectionDiag}</h4>
            {/* HTTP timeout — 모든 모드 공통(transport 설정), 1개만 */}
            <div className="max-w-xs">
              <Field label={ko.loadModel.httpTimeout} htmlFor={httpTimeoutId}>
                <Input
                  id={httpTimeoutId}
                  type="number"
                  min={1}
                  max={600}
                  value={httpTimeout}
                  onChange={(e) => setHttpTimeout(Number(e.target.value))}
                  aria-invalid={httpTimeoutInvalid}
                  aria-describedby={httpTimeoutInvalid ? "http-timeout-error" : undefined}
                />
              </Field>
            </div>

            {hasLoop && (
              <Field
                label={ko.loadModel.loopCap}
                htmlFor={loopCapId}
                hint="0 = 끄기 · 루프 스텝의 loop_index별 집계 상한"
              >
                <Input
                  id={loopCapId}
                  type="number"
                  min={0}
                  max={10000}
                  value={loopCap}
                  onChange={(e) => setLoopCap(Number(e.target.value))}
                  aria-invalid={loopCapInvalid}
                  aria-describedby={loopCapInvalid ? "loop-cap-error" : undefined}
                />
              </Field>
            )}

            {loopCapInvalid && (
              <p id="loop-cap-error" className="mb-3 text-red-600 text-sm">
                0 ~ 10000 사이여야 합니다.
              </p>
            )}

            {httpTimeoutInvalid && (
              <p id="http-timeout-error" className="mb-3 text-red-600 text-sm">
                {ko.validation.httpTimeout}
              </p>
            )}
          </>
        </Section>
      )}

      {/* 그룹 6: 이 설정 저장 — 상세-only, 본문 최하단 (R7) */}
      {mode === "detailed" && (
        <Section
          index={6}
          divider
          title={<span className={eyebrowCls}>{ko.runDialog.sectionSaveTitle}</span>}
          badge={<Badge tone="optional">{ko.common.optional}</Badge>}
        >
          <div className="mb-3 flex items-center gap-2">
            <Input
              className="w-48"
              aria-label={ko.runDialog.presetNameAria}
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
        </Section>
      )}

      {mutation.error && !(mutation.error instanceof PoolCapacityError) && (
        <Callout variant="error" role="alert" className="mb-3">
          {(mutation.error as Error).message}
        </Callout>
      )}

      {/* 간단 모드 적용-요약 칩 — 클릭하면 상세 모드 (R3·R6) */}
      {mode === "simple" && (
        <button
          type="button"
          onClick={() => setMode("detailed")}
          className="mb-3 inline-flex items-center gap-1.5 rounded-md bg-accent-50 px-2.5 py-1 text-xs text-accent-700 hover:bg-accent-100"
        >
          <span aria-hidden="true">⚙</span>
          {ko.runDialog.appliedDetail(detailedAppliedCount)}
        </button>
      )}

      {(() => {
        // 접힌 그룹의 진단 값이 invalid면 인라인 에러 p가 DOM에 없어 사유가 안 보인다.
        // advancedOpen(펼침)이면 인라인 에러가 이미 보이므로 중복 표시 안 함.
        // 간단 모드(mode==="simple")에서도 숨겨진 invalid 값을 표면화 (R5).
        const blockedReasons: string[] = [
          ...(!bindingBlock.ok
            ? bindingBlock.reasons.map((r) => ko.runDialog.bindingReasonPrefix + r)
            : []),
          ...((mode === "simple" || !advancedOpen) && httpTimeoutInvalid
            ? [ko.validation.httpTimeout]
            : []),
          ...((mode === "simple" || !advancedOpen) && loopCapInvalid
            ? [ko.validation.loopCap]
            : []),
          ...((mode === "simple" || !advancedOpen) && loadModel === "closed" && thinkInvalid
            ? [ko.validation.think]
            : []),
          ...(mode === "simple" && loadModel === "open" && loadErrs.workerCountInvalid
            ? [ko.validation.workerCount]
            : []),
        ];
        return (
          blockedReasons.length > 0 && (
            <Callout
              variant="warn"
              role="status"
              className="mb-3"
              title={ko.runDialog.blockedReasonsIntro}
            >
              <ul className="list-disc pl-5">
                {blockedReasons.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </Callout>
          )
        );
      })()}

      {poolConflict
        ? (() => {
            const isOpenLoop = loadModel === "open";
            const isCurve = loadModel === "closed" && rateMode === "curve";
            return (
              <Callout
                variant="warn"
                role="alertdialog"
                aria-label={ko.capacityGuard.dialogTitle}
                className="mb-3"
              >
                <p className="mb-2 font-medium">{ko.capacityGuard.dialogTitle}</p>
                <p className="mb-3">
                  {isCurve
                    ? ko.capacityGuard.dialogBodyCurve(
                        poolConflict.achievable,
                        poolConflict.requested,
                      )
                    : isOpenLoop
                      ? ko.capacityGuard.dialogBodyOpen(
                          poolConflict.achievable,
                          poolConflict.requested,
                        )
                      : ko.capacityGuard.dialogBody(
                          poolConflict.achievable,
                          poolConflict.requested,
                        )}
                </p>
                {isCurve ? (
                  <p className="mb-3 text-xs">
                    {ko.capacityGuard.clampNoteCurve(
                      poolConflict.achievable,
                      poolConflict.requested,
                    )}
                  </p>
                ) : isOpenLoop ? (
                  <p className="mb-3 text-xs">{ko.capacityGuard.clampNoteOpen}</p>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <Button
                    onClick={() => {
                      const built = buildProfile();
                      const clamped = isCurve
                        ? {
                            ...built,
                            vu_stages: scaleVuStages(
                              stages,
                              poolConflict.achievable,
                              poolConflict.requested,
                            ).map((s) => ({
                              target: Number(s.target),
                              duration_seconds: Number(s.duration_seconds),
                            })),
                          }
                        : isOpenLoop
                          ? { ...built, max_in_flight: poolConflict.achievable }
                          : { ...built, vus: poolConflict.achievable };
                      setPoolConflict(null);
                      mutation.reset();
                      mutation.mutate(
                        { scenarioId, profile: clamped, env },
                        { onSuccess: (run) => onCreated(run.id) },
                      );
                    }}
                  >
                    {isCurve
                      ? ko.capacityGuard.clampCurve(poolConflict.achievable)
                      : isOpenLoop
                        ? ko.capacityGuard.clampOpen(poolConflict.achievable)
                        : ko.capacityGuard.clamp(poolConflict.achievable)}
                  </Button>
                  <Button
                    onClick={() => {
                      setPoolConflict(null);
                      mutation.reset();
                      mutation.mutate(
                        { scenarioId, profile: buildProfile(), env, force: true },
                        { onSuccess: (run) => onCreated(run.id) },
                      );
                    }}
                  >
                    {ko.capacityGuard.force}
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setPoolConflict(null);
                      mutation.reset();
                    }}
                  >
                    {ko.capacityGuard.cancel}
                  </Button>
                </div>
              </Callout>
            );
          })()
        : null}

      {/* 실행 요약 footer (R8): 좌측 요약 시그니처 + 우측 Run/취소 버튼 */}
      <div className="sticky bottom-0 bg-white border-t border-slate-200 pt-3 mt-3 flex items-center justify-between gap-3">
        {/* 좌측: 강조 바 + 선택적 곡선 미리보기 + 요약 텍스트 */}
        <div className="flex items-center gap-3 min-w-0">
          <span className="w-0.5 self-stretch rounded bg-accent-600" />
          {sum.tone !== "warn" && (
            <LoadShapePreview
              kind={sum.curve ? "curve" : "flat"}
              stages={sum.curve ? previewStages : undefined}
              width={60}
              height={30}
              role="img"
              aria-label={
                sum.curve
                  ? loadModel === "closed"
                    ? ko.loadModel.curvePreviewAriaVu
                    : ko.loadModel.curvePreviewAriaRps
                  : ko.runDialog.loadShapeAria
              }
              className="shrink-0"
            />
          )}
          <span
            className={sum.tone === "warn" ? "text-amber-700 text-sm" : "text-slate-900 text-sm"}
          >
            <span>
              {sum.main.map((seg, i) =>
                seg.bold ? (
                  <b key={i} className="font-bold tabular-nums">
                    {seg.text}
                  </b>
                ) : (
                  <span key={i}>{seg.text}</span>
                ),
              )}
            </span>
            {sum.sub && <span className="block text-xs text-slate-500">{sum.sub}</span>}
          </span>
        </div>
        {/* 우측: Run/취소 */}
        <div className="flex gap-2 shrink-0">
          <Button
            onClick={() =>
              mutation.mutate(
                { scenarioId, profile: buildProfile(), env },
                { onSuccess: (run) => onCreated(run.id) },
              )
            }
            disabled={!canSubmit}
          >
            {mutation.isPending ? ko.runDialog.running : ko.runDialog.run}
          </Button>
          <Button variant="secondary" onClick={onCancel}>
            {ko.runDialog.cancel}
          </Button>
        </div>
      </div>
    </div>
  );
}
