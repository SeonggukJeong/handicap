import { useId, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import type { LoadModelErrors } from "./loadModel";
import { LOAD_SHAPES } from "./loadShapes";
import { StageCurvePreview } from "./StageCurvePreview";
import { ko } from "../i18n/ko";
import { HelpTip } from "./HelpTip";
import { VuSizingHelper } from "./VuSizingHelper";
import { SlotSizingHelper } from "./SlotSizingHelper";
import { WorkerSizingHelper } from "./WorkerSizingHelper";
import { peakStageTarget } from "./sizing";
import type { Scenario } from "../scenario/model";
import { openLoopWarnings, type OpenLoopWarning } from "./openLoopChecks";

type StageRow = { target: string; duration_seconds: string };

type Props = {
  loadModel: "closed" | "open";
  setLoadModel: (m: "closed" | "open") => void;
  rateMode: "fixed" | "curve";
  setRateMode: (m: "fixed" | "curve") => void;
  vus: number;
  setVus: (n: number) => void;
  duration: number;
  setDuration: (n: number) => void;
  rampUp: number;
  setRampUp: (n: number) => void;
  targetRps: string;
  setTargetRps: (s: string) => void;
  maxInFlight: string;
  setMaxInFlight: (s: string) => void;
  stages: StageRow[];
  setStages: Dispatch<SetStateAction<StageRow[]>>;
  rampDown: "graceful" | "immediate";
  setRampDown: (m: "graceful" | "immediate") => void;
  errs: LoadModelErrors;
  // 닫힌 루프 사이징 헬퍼(RunDialog 전용 — ScheduleForm은 미전달, §3.1).
  // model Scenario(steps 보유)지 api Scenario 아님.
  sizingScenarioId?: string;
  sizingScenario?: Scenario | null;
  sizingEnv?: Record<string, string>;
  onApplyVus?: (n: number) => void;
  // 열린 루프 슬롯 사이징 힌트(RunDialog 전용 — ScheduleForm 미전달). open+fixed에서만.
  onApplyMaxInFlight?: (n: number) => void;
  // worker_count 사이징 헬퍼(RunDialog 전용 — ScheduleForm 미전달). open 모드에서만.
  onApplyWorkerCount?: (n: number) => void;
  // worker_count(open 전용 fan-out 노브) — RunDialog 전용. setWorkerCount 부재 = 미렌더
  // (ScheduleForm은 state로 round-trip만 하고 입력은 안 띄운다, spec §4.1).
  workerCount?: string;
  setWorkerCount?: (s: string) => void;
  // ② inert max_in_flight 판정용(RunDialog http_timeout). 미전달(ScheduleForm) → ② 미발생.
  httpTimeout?: number;
  // pool 모드 신호(RunDialog pool.data?.pool_mode). true → 두 경고 모두 suppress(R13).
  poolMode?: boolean;
};

const INPUT = "mt-1 block w-full rounded border border-slate-300 px-2 py-1";

export function LoadModelFields({
  loadModel,
  setLoadModel,
  rateMode,
  setRateMode,
  vus,
  setVus,
  duration,
  setDuration,
  rampUp,
  setRampUp,
  targetRps,
  setTargetRps,
  maxInFlight,
  setMaxInFlight,
  stages,
  setStages,
  rampDown,
  setRampDown,
  errs,
  sizingScenarioId,
  sizingScenario,
  sizingEnv,
  onApplyVus,
  onApplyMaxInFlight,
  onApplyWorkerCount,
  workerCount,
  setWorkerCount,
  httpTimeout,
  poolMode,
}: Props) {
  const ids = {
    vus: useId(),
    durationClosed: useId(),
    rampUp: useId(),
    targetRps: useId(),
    durationOpen: useId(),
    maxInFlight: useId(),
    workerCount: useId(),
  };
  // worker_count 접이식 disclosure — 기본 접힘, 시드된 값(>1)이면 자동 펼침
  // (ui-optional-sections-collapsible 이디엄). 무조건 호출 hook(모드 분기 위).
  const [workerOpen, setWorkerOpen] = useState(() => Number(workerCount ?? "1") > 1);

  // open+curve 슬롯 힌트의 기준 = 최고 단계 목표(peak). stages는 문자열 드래프트라
  // 유효 정수만 후보(peakStageTarget). 없으면 "" → 헬퍼가 needTargetCurve 표시.
  const peakStr = useMemo(() => {
    const p = peakStageTarget(stages);
    return p != null ? String(p) : "";
  }, [stages]);

  // open-loop 구조 경고(순수·결정적). poolMode/closed/W>1 등 게이트는 openLoopWarnings 내부.
  const openLoopWarns = useMemo(
    () =>
      openLoopWarnings({
        loadModel,
        rateMode,
        targetRps,
        maxInFlight,
        stages,
        workerCount,
        httpTimeoutSeconds: httpTimeout,
        scenario: sizingScenario ?? null,
        poolMode,
      }),
    [
      loadModel,
      rateMode,
      targetRps,
      maxInFlight,
      stages,
      workerCount,
      httpTimeout,
      sizingScenario,
      poolMode,
    ],
  );
  // 판별 union 좁히기: 평범한 `=== ` 화살표는 `find`가 narrow 못 함(strict tsc) → 타입가드 술어 필수.
  const idleWarn = openLoopWarns.find(
    (w): w is Extract<OpenLoopWarning, { kind: "idle_workers" }> => w.kind === "idle_workers",
  );
  const inertWarn = openLoopWarns.find(
    (w): w is Extract<OpenLoopWarning, { kind: "inert_slots" }> => w.kind === "inert_slots",
  );

  // 곡선 에디터 블록 — open+curve / closed+curve 공유, 라벨만 모드 분기
  const curveEditor = (
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
          className={INPUT}
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
        {loadModel === "closed" ? ko.loadModel.curveHintVu : ko.loadModel.curveHintRps}
      </p>
      <p className="text-xs text-slate-500 mb-2">이 단계가 지속되는 시간(초)</p>
      {stages.map((s, i) => (
        <div key={i} className="flex items-end gap-2 mb-2">
          <label className="block text-sm flex-1 min-w-0">
            <span className="text-slate-600">
              {loadModel === "closed" ? ko.loadModel.curveTargetVu : ko.loadModel.curveTargetRps}
            </span>
            <input
              type="number"
              min={0}
              max={1000000}
              aria-label={ko.loadModelFields.stageTargetAria(i)}
              value={s.target}
              onChange={(e) =>
                setStages((prev) =>
                  prev.map((r, j) => (j === i ? { ...r, target: e.target.value } : r)),
                )
              }
              className={INPUT}
            />
          </label>
          <label className="block text-sm flex-1 min-w-0">
            <span className="text-slate-600">지속(s)</span>
            <input
              type="number"
              min={1}
              aria-label={ko.loadModelFields.stageDurationAria(i)}
              value={s.duration_seconds}
              onChange={(e) =>
                setStages((prev) =>
                  prev.map((r, j) => (j === i ? { ...r, duration_seconds: e.target.value } : r)),
                )
              }
              className={INPUT}
            />
          </label>
          <button
            type="button"
            aria-label={ko.loadModelFields.removeStageAria(i)}
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
          onClick={() => setStages((prev) => [...prev, { target: "100", duration_seconds: "30" }])}
          className="text-sm text-blue-600 hover:underline"
        >
          + 단계 추가
        </button>
        <span className="ml-3 text-xs text-slate-500">
          총 길이: {stages.reduce((a, s) => a + (Number(s.duration_seconds) || 0), 0)}s
        </span>
      </div>
      {errs.stagesInvalid && (
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
            <div
              className="h-32"
              role="img"
              aria-label={
                loadModel === "closed"
                  ? ko.loadModel.curvePreviewAriaVu
                  : ko.loadModel.curvePreviewAriaRps
              }
            >
              <StageCurvePreview stages={previewStages} />
            </div>
          </div>
        ) : null;
      })()}
    </div>
  );

  return (
    <>
      {/* 1차 축: 부하 모델 */}
      <fieldset className="mb-3">
        <legend className="text-sm text-slate-600 mb-1">부하 모델</legend>
        <div className="flex items-center gap-4">
          <span className="flex items-center">
            <label className="flex items-center gap-1 text-sm cursor-pointer">
              <input
                type="radio"
                name="load-model"
                value="closed"
                checked={loadModel === "closed"}
                onChange={() => {
                  setLoadModel("closed");
                  // eager reset 제거 — closed+curve는 이제 유효한 모드
                }}
              />
              {ko.loadModel.closedLoop}
            </label>
            <HelpTip label="closed-loop 설명">{ko.glossary.closedLoop}</HelpTip>
          </span>
          <span className="flex items-center">
            <label className="flex items-center gap-1 text-sm cursor-pointer">
              <input
                type="radio"
                name="load-model"
                value="open"
                checked={loadModel === "open"}
                onChange={() => setLoadModel("open")}
              />
              {ko.loadModel.openLoop}
            </label>
            <HelpTip label="open-loop 설명">{ko.glossary.openLoop}</HelpTip>
          </span>
        </div>
      </fieldset>

      {/* 2차 축: 프로파일(고정/곡선) — 이제 closed에서도 곡선 활성 */}
      <fieldset className="mb-3">
        <legend className="text-sm text-slate-600 mb-1">프로파일</legend>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-1 text-sm cursor-pointer">
            <input
              type="radio"
              name="rate-mode"
              value="fixed"
              checked={rateMode === "fixed"}
              onChange={() => setRateMode("fixed")}
            />
            고정
          </label>
          {/* HelpTip은 label 밖 형제 — label 안에 넣으면 곡선 라디오 accname 오염 (U3) */}
          <span className="flex items-center gap-1">
            <label className="flex items-center gap-1 text-sm cursor-pointer">
              <input
                type="radio"
                name="rate-mode"
                value="curve"
                checked={rateMode === "curve"}
                onChange={() => setRateMode("curve")}
              />
              곡선
            </label>
            {loadModel === "closed" && (
              <HelpTip label="VU 곡선 설명">{ko.glossary.vuCurve}</HelpTip>
            )}
          </span>
        </div>
      </fieldset>

      {loadModel === "closed" ? (
        rateMode === "curve" ? (
          <>
            {curveEditor}
            {/* ramp_down 라디오 — HelpTip은 그룹 라벨 밖 형제 (U3 accname 오염 방지);
                radiogroup+aria-label로 그룹 접근명 제공(파일 idiom: label+HelpTip 한 행) */}
            <div className="mb-3">
              <div className="flex items-center gap-1 mb-1">
                <span className="text-sm text-slate-600">{ko.loadModel.rampDownLabel}</span>
                <HelpTip label="줄이는 방식 설명">{ko.glossary.rampDown}</HelpTip>
              </div>
              <div
                role="radiogroup"
                aria-label={ko.loadModel.rampDownLabel}
                className="flex flex-col gap-1"
              >
                <label className="flex items-center gap-1 text-sm cursor-pointer">
                  <input
                    type="radio"
                    name="ramp-down"
                    value="graceful"
                    checked={rampDown === "graceful"}
                    onChange={() => setRampDown("graceful")}
                  />
                  {ko.loadModel.rampDownGraceful}
                </label>
                <label className="flex items-center gap-1 text-sm cursor-pointer">
                  <input
                    type="radio"
                    name="ramp-down"
                    value="immediate"
                    checked={rampDown === "immediate"}
                    onChange={() => setRampDown("immediate")}
                  />
                  {ko.loadModel.rampDownImmediate}
                </label>
              </div>
            </div>
          </>
        ) : (
          <>
            {/* 부하 크기 프리셋 chips */}
            <div
              role="group"
              aria-label={ko.loadModel.sizePresetsLabel}
              className="mb-2 flex flex-wrap gap-2"
            >
              {ko.loadModel.sizePresets.map((p) => {
                const active = vus === p.vus && duration === p.durationSeconds;
                return (
                  <button
                    key={p.label}
                    type="button"
                    aria-pressed={active}
                    onClick={() => {
                      setVus(p.vus);
                      setDuration(p.durationSeconds);
                    }}
                    className={`rounded-full border px-3 py-1 text-sm ${
                      active
                        ? "border-indigo-500 bg-indigo-50 text-indigo-700"
                        : "border-slate-300 text-slate-600 hover:bg-slate-50"
                    }`}
                  >
                    {p.label}{" "}
                    <span className={active ? "text-xs text-indigo-500" : "text-xs text-slate-400"}>
                      {p.hint}
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="grid grid-cols-3 gap-4 mb-3">
              <div className="block text-sm">
                <label htmlFor={ids.vus} className="text-slate-600">
                  {ko.loadModel.vus}
                </label>
                <HelpTip label="VU 설명">{ko.glossary.vu}</HelpTip>
                <input
                  id={ids.vus}
                  type="number"
                  min={1}
                  value={vus}
                  onChange={(e) => setVus(Number(e.target.value))}
                  className={INPUT}
                />
              </div>
              <div className="block text-sm">
                <label htmlFor={ids.durationClosed} className="text-slate-600">
                  {ko.loadModel.duration}
                </label>
                <input
                  id={ids.durationClosed}
                  type="number"
                  min={1}
                  value={duration}
                  onChange={(e) => setDuration(Number(e.target.value))}
                  className={INPUT}
                />
              </div>
              <div className="block text-sm">
                <label htmlFor={ids.rampUp} className="text-slate-600">
                  {ko.loadModel.rampUp}
                </label>
                <HelpTip label="ramp-up 설명">{ko.glossary.rampUp}</HelpTip>
                <input
                  id={ids.rampUp}
                  type="number"
                  min={0}
                  value={rampUp}
                  onChange={(e) => setRampUp(Number(e.target.value))}
                  className={INPUT}
                  aria-invalid={errs.rampInvalid}
                  aria-describedby={errs.rampInvalid ? "ramp-up-error" : undefined}
                />
              </div>
            </div>
            {errs.rampInvalid && (
              <p id="ramp-up-error" className="mb-3 text-red-600 text-sm">
                {ko.validation.rampUp}
              </p>
            )}
            {onApplyVus && sizingScenarioId !== undefined && (
              <VuSizingHelper
                scenarioId={sizingScenarioId}
                scenario={sizingScenario ?? null}
                env={sizingEnv ?? {}}
                onApply={onApplyVus}
              />
            )}
          </>
        )
      ) : (
        <>
          {/* Max in-flight — fixed/curve 공통, 1개 */}
          <div className="mb-3 max-w-xs">
            <div className="block text-sm">
              <label htmlFor={ids.maxInFlight} className="text-slate-600">
                {ko.loadModel.maxInFlight}
              </label>
              <HelpTip label="max in-flight 설명">{ko.glossary.maxInFlight}</HelpTip>
              <input
                id={ids.maxInFlight}
                type="number"
                min={1}
                max={10000}
                value={maxInFlight}
                onChange={(e) => setMaxInFlight(e.target.value)}
                className={INPUT}
                aria-invalid={errs.maxInFlightInvalid}
                aria-describedby={errs.maxInFlightInvalid ? "max-in-flight-error" : undefined}
              />
              <span className="text-xs text-slate-500">
                동시 요청 상한 — 서비스가 목표 속도를 못 따라가면 초과분은 drop되어 리포트에
                표시됩니다
              </span>
            </div>
          </div>
          {errs.maxInFlightInvalid && (
            <p id="max-in-flight-error" className="mb-3 text-red-600 text-sm">
              {ko.validation.maxInFlight}
            </p>
          )}
          {inertWarn && (
            <p role="status" className="mb-3 max-w-xs text-amber-700 text-sm">
              {ko.openLoopCheck.inertSlots}
            </p>
          )}

          {/* worker_count(수평 확장) 접이식 — RunDialog 전용(setWorkerCount 부재면 미렌더),
              open 모드(고정·곡선) 공통. 기본 접힘 + 값>1이면 자동 펼침·접힌 채면 "N개 설정됨"
              힌트로 비기본값 노출 (ui-optional-sections-collapsible). */}
          {setWorkerCount !== undefined && loadModel === "open" && (
            <div className="mb-3 max-w-xs">
              <button
                type="button"
                aria-expanded={workerOpen}
                onClick={() => setWorkerOpen((o) => !o)}
                className="flex items-center gap-1 text-sm text-slate-600 hover:underline"
              >
                <span>{workerOpen ? "▾" : "▸"}</span>
                <span>{ko.loadModel.workerCount}</span>
                {!workerOpen && Number(workerCount ?? "1") > 1 ? (
                  <span className="ml-1 text-xs font-normal text-slate-500">
                    · {ko.loadModel.workerCountHint(Number(workerCount))}
                  </span>
                ) : null}
              </button>
              {workerOpen && (
                <div className="mt-1">
                  {/* HelpTip은 라벨 텍스트와 형제 — 입력 accname은 aria-label로(toggle 버튼이
                      라벨 텍스트를 이미 보유, 입력은 aria-label로 동일 접근명). */}
                  <div className="flex items-center gap-1">
                    <span className="text-xs text-slate-500">{ko.loadModel.workerCount}</span>
                    <HelpTip label="worker_count 설명">{ko.glossary.workerCount}</HelpTip>
                  </div>
                  <input
                    id={ids.workerCount}
                    type="number"
                    min={1}
                    max={64}
                    aria-label={ko.loadModel.workerCount}
                    value={workerCount ?? "1"}
                    onChange={(e) => setWorkerCount(e.target.value)}
                    className={INPUT}
                    aria-invalid={errs.workerCountInvalid}
                    aria-describedby={errs.workerCountInvalid ? "worker-count-error" : undefined}
                  />
                  {errs.workerCountInvalid && (
                    <p id="worker-count-error" role="alert" className="mt-1 text-red-600 text-sm">
                      {ko.validation.workerCount}
                    </p>
                  )}
                  {onApplyWorkerCount && sizingScenarioId !== undefined && (
                    <WorkerSizingHelper
                      scenarioId={sizingScenarioId}
                      targetRps={rateMode === "curve" ? peakStr : targetRps}
                      peakBased={rateMode === "curve"}
                      maxInFlight={maxInFlight}
                      onApply={onApplyWorkerCount}
                    />
                  )}
                  {idleWarn && (
                    <p role="status" className="mt-2 text-amber-700 text-sm">
                      {ko.openLoopCheck.idleWorkers(idleWarn.idle, idleWarn.peak)}{" "}
                      <button
                        type="button"
                        onClick={() => setWorkerCount?.(String(idleWarn.peak))}
                        className="text-blue-600 hover:underline"
                      >
                        {ko.openLoopCheck.apply(idleWarn.peak)}
                      </button>
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {rateMode === "fixed" ? (
            <>
              <div className="grid grid-cols-2 gap-4 mb-3">
                <div className="block text-sm">
                  <label htmlFor={ids.targetRps} className="text-slate-600">
                    {ko.loadModel.targetRps}
                  </label>
                  <HelpTip label="RPS 설명">{ko.glossary.rps}</HelpTip>
                  <input
                    id={ids.targetRps}
                    type="number"
                    min={1}
                    max={1000000}
                    value={targetRps}
                    onChange={(e) => setTargetRps(e.target.value)}
                    className={INPUT}
                    aria-invalid={errs.targetRpsInvalid}
                    aria-describedby={errs.targetRpsInvalid ? "target-rps-error" : undefined}
                  />
                </div>
                <div className="block text-sm">
                  <label htmlFor={ids.durationOpen} className="text-slate-600">
                    {ko.loadModel.duration}
                  </label>
                  <input
                    id={ids.durationOpen}
                    type="number"
                    min={1}
                    value={duration}
                    onChange={(e) => setDuration(Number(e.target.value))}
                    className={INPUT}
                  />
                </div>
              </div>
              {errs.targetRpsInvalid && (
                <p id="target-rps-error" className="mb-3 text-red-600 text-sm">
                  {ko.validation.targetRps}
                </p>
              )}
              {onApplyMaxInFlight && sizingScenarioId !== undefined && (
                <SlotSizingHelper
                  scenarioId={sizingScenarioId}
                  env={sizingEnv ?? {}}
                  targetRps={targetRps}
                  onApply={onApplyMaxInFlight}
                />
              )}
            </>
          ) : (
            <>
              {curveEditor}
              {onApplyMaxInFlight && sizingScenarioId !== undefined && (
                <SlotSizingHelper
                  scenarioId={sizingScenarioId}
                  env={sizingEnv ?? {}}
                  targetRps={peakStr}
                  peakBased
                  onApply={onApplyMaxInFlight}
                />
              )}
            </>
          )}
        </>
      )}
    </>
  );
}
