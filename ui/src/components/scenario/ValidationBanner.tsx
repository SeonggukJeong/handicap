import { useMemo } from "react";
import { ko } from "../../i18n/ko";
import { collectProblems } from "../../scenario/problems";
import { useScenarioEditor } from "../../scenario/store";

/** 시나리오 문제 요약 배너 (U4, spec §5.4). 캔버스·YAML 두 탭 공통 상단 상시 슬롯 —
 *  yamlError가 YAML 탭에서만 보이던 갭도 해소한다. 문제 0건이면 미렌더.
 *  스텝 항목 클릭 = 해당 스텝 선택(+캔버스 탭), 게이트 항목 = YAML 탭 유도만(모델 stale). */
export function ValidationBanner() {
  const model = useScenarioEditor((s) => s.model);
  const yamlError = useScenarioEditor((s) => s.yamlError);
  const select = useScenarioEditor((s) => s.select);
  const setActiveTab = useScenarioEditor((s) => s.setActiveTab);

  const problems = useMemo(
    () => collectProblems(model?.steps ?? null, yamlError),
    [model, yamlError],
  );
  if (problems.length === 0) return null;

  const hasGate = problems.some((p) => p.kind === "gate");

  return (
    <div
      role="status"
      aria-label={ko.editor.problemsBannerAria}
      className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="font-medium">{ko.editor.problemsBannerTitle(problems.length)}</p>
        {hasGate && (
          <button
            type="button"
            className="shrink-0 underline decoration-amber-400 hover:text-amber-900"
            onClick={() => setActiveTab("yaml")}
          >
            {ko.editor.problemGateAction}
          </button>
        )}
      </div>
      {hasGate && <p className="mt-1 text-xs">{ko.editor.problemGateIntro}</p>}
      <ul className="mt-1 flex flex-col gap-1">
        {problems.map((p, i) => (
          <li key={`${p.kind}-${i}`}>
            {p.kind === "step" ? (
              <button
                type="button"
                className="text-left underline decoration-amber-400 hover:text-amber-900"
                onClick={() => {
                  select(p.stepId);
                  setActiveTab("canvas");
                }}
              >
                {p.message}
              </button>
            ) : (
              <span className="whitespace-pre-wrap break-words">{p.message}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
