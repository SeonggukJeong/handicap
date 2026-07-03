import { useMemo } from "react";
import { ko } from "../../i18n/ko";
import { collectProblems } from "../../scenario/problems";
import { useScenarioEditor } from "../../scenario/store";
import { Callout } from "../ui/Callout";

/** 시나리오 문제 요약 배너 (U4, spec §5.4). 상단 상시 슬롯 —
 *  yamlError가 YAML 탭에서만 보이던 갭도 해소한다. 문제 0건이면 미렌더.
 *  스텝 항목 클릭 = 해당 스텝 선택, 게이트 항목 = YAML 모달 열기(onOpenYaml). */
export function ValidationBanner({ onOpenYaml }: { onOpenYaml?: () => void } = {}) {
  const model = useScenarioEditor((s) => s.model);
  const yamlError = useScenarioEditor((s) => s.yamlError);
  const select = useScenarioEditor((s) => s.select);

  const problems = useMemo(
    () => collectProblems(model?.steps ?? null, yamlError),
    [model, yamlError],
  );
  if (problems.length === 0) return null;

  const hasGate = problems.some((p) => p.kind === "gate");

  return (
    <Callout variant="warn" role="status" aria-label={ko.editor.problemsBannerAria}>
      <div className="flex items-center justify-between gap-2">
        <p className="font-medium">{ko.editor.problemsBannerTitle(problems.length)}</p>
        {hasGate && (
          <button
            type="button"
            className="shrink-0 underline decoration-amber-400 hover:text-amber-900"
            onClick={() => onOpenYaml?.()}
          >
            {ko.editor.problemGateAction}
          </button>
        )}
      </div>
      {hasGate && <p className="mt-1 text-xs">{ko.editor.problemGateIntro}</p>}
      {yamlError !== null && (
        <p className="mt-1 text-xs font-medium">{ko.editor.editBlockedWhileInvalid}</p>
      )}
      <ul className="mt-1 flex flex-col gap-1">
        {problems.map((p, i) => (
          <li key={`${p.kind}-${i}`}>
            {p.kind === "step" ? (
              <button
                type="button"
                className="text-left underline decoration-amber-400 hover:text-amber-900"
                onClick={() => {
                  select(p.stepId);
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
    </Callout>
  );
}
