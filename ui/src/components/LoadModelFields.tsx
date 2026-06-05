import type { Dispatch, SetStateAction } from "react";
import type { LoadModelErrors } from "./loadModel";
import { LOAD_SHAPES } from "./loadShapes";
import { StageCurvePreview } from "./StageCurvePreview";

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
  errs: LoadModelErrors;
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
  errs,
}: Props) {
  return (
    <>
      {/* 1차 축: 부하 모델 */}
      <fieldset className="mb-3">
        <legend className="text-sm text-slate-600 mb-1">부하 모델</legend>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-1 text-sm cursor-pointer">
            <input
              type="radio"
              name="load-model"
              value="closed"
              checked={loadModel === "closed"}
              onChange={() => {
                setLoadModel("closed");
                setRateMode("fixed"); // closed+curve(곧 지원)는 도달 불가
              }}
            />
            Closed-loop (VU)
          </label>
          <label className="flex items-center gap-1 text-sm cursor-pointer">
            <input
              type="radio"
              name="load-model"
              value="open"
              checked={loadModel === "open"}
              onChange={() => setLoadModel("open")}
            />
            Open-loop (rate)
          </label>
        </div>
      </fieldset>

      {/* 2차 축: 프로파일(고정/곡선) — closed에선 곡선 disabled */}
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
          <label
            className={`flex items-center gap-1 text-sm ${
              loadModel === "closed" ? "cursor-not-allowed text-slate-400" : "cursor-pointer"
            }`}
          >
            <input
              type="radio"
              name="rate-mode"
              value="curve"
              checked={rateMode === "curve"}
              disabled={loadModel === "closed"}
              onChange={() => setRateMode("curve")}
            />
            곡선{loadModel === "closed" ? " (곧 지원)" : ""}
          </label>
        </div>
      </fieldset>

      {loadModel === "closed" ? (
        <>
          <div className="grid grid-cols-3 gap-4 mb-3">
            <label className="block text-sm">
              <span className="text-slate-600">VUs</span>
              <input
                type="number"
                min={1}
                aria-label="VUs"
                value={vus}
                onChange={(e) => setVus(Number(e.target.value))}
                className={INPUT}
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
                className={INPUT}
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
                className={INPUT}
                aria-invalid={errs.rampInvalid}
                aria-describedby={errs.rampInvalid ? "ramp-up-error" : undefined}
              />
            </label>
          </div>
          {errs.rampInvalid && (
            <p id="ramp-up-error" className="mb-3 text-red-600 text-sm">
              Ramp-up must be ≤ duration.
            </p>
          )}
        </>
      ) : (
        <>
          {/* Max in-flight — fixed/curve 공통, 1개 */}
          <div className="mb-3 max-w-xs">
            <label className="block text-sm">
              <span className="text-slate-600">Max in-flight</span>
              <input
                type="number"
                min={1}
                max={10000}
                aria-label="Max in-flight"
                value={maxInFlight}
                onChange={(e) => setMaxInFlight(e.target.value)}
                className={INPUT}
                aria-invalid={errs.maxInFlightInvalid}
                aria-describedby={errs.maxInFlightInvalid ? "max-in-flight-error" : undefined}
              />
              <span className="text-xs text-slate-500">
                동시 처리 상한 — 서비스가 목표 레이트를 못 따라가면 초과분은 drop되어 리포트에
                표시됩니다
              </span>
            </label>
          </div>
          {errs.maxInFlightInvalid && (
            <p id="max-in-flight-error" className="mb-3 text-red-600 text-sm">
              Max in-flight must be between 1 and 10,000.
            </p>
          )}

          {rateMode === "fixed" ? (
            <>
              <div className="grid grid-cols-2 gap-4 mb-3">
                <label className="block text-sm">
                  <span className="text-slate-600">Target RPS</span>
                  <input
                    type="number"
                    min={1}
                    max={1000000}
                    aria-label="Target RPS"
                    value={targetRps}
                    onChange={(e) => setTargetRps(e.target.value)}
                    className={INPUT}
                    aria-invalid={errs.targetRpsInvalid}
                    aria-describedby={errs.targetRpsInvalid ? "target-rps-error" : undefined}
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
                    className={INPUT}
                  />
                </label>
              </div>
              {errs.targetRpsInvalid && (
                <p id="target-rps-error" className="mb-3 text-red-600 text-sm">
                  Target RPS must be between 1 and 1,000,000.
                </p>
              )}
            </>
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
                      className={INPUT}
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
                      className={INPUT}
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
                      aria-label="레이트 곡선 미리보기 (x: 누적 초, y: RPS)"
                    >
                      <StageCurvePreview stages={previewStages} />
                    </div>
                  </div>
                ) : null;
              })()}
            </div>
          )}
        </>
      )}
    </>
  );
}
