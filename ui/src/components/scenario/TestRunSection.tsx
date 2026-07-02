import { useMemo, useState } from "react";
import { useEnvironment, useTestRun } from "../../api/hooks";
import { ko } from "../../i18n/ko";
import { resolveEnv, type EnvEntry } from "../../api/envOverlay";
import { parseScenarioDoc } from "../../scenario/yamlDoc";
import type { Step } from "../../scenario/model";
import { useScenarioEditor } from "../../scenario/store";
import { Button } from "../Button";
import { EnvironmentPicker } from "../EnvironmentPicker";
import { TestFlowChips } from "./TestFlowChips";
import { TestRunPanel } from "./TestRunPanel";

/** Test-run controls + result panel for a scenario editor buffer. Self-contained
 *  unit whose only input is the live `yamlText` — so both the new-scenario page
 *  and the edit page reuse it (works on an unsaved draft; ephemeral, nothing is
 *  persisted). The `steps` parsed from the buffer feed `TestRunPanel`'s if-row
 *  condition summaries (the `ScenarioTrace` wire contract carries no cond text). */
export function TestRunSection({ yamlText }: { yamlText: string }) {
  const testRun = useTestRun();
  const selectedStepId = useScenarioEditor((s) => s.selectedStepId);
  const [selectedEnvId, setSelectedEnvId] = useState<string | null>(null);
  const [envEntries, setEnvEntries] = useState<EnvEntry[]>([]);
  const [maxRequests, setMaxRequests] = useState<number>(50);
  const [applyThinkTime, setApplyThinkTime] = useState(false);
  const [addedNote, setAddedNote] = useState<string | null>(null);
  const selectedEnv = useEnvironment(selectedEnvId ?? undefined);
  const baseVars = selectedEnv.data?.vars ?? {};
  const traceSteps = useMemo<Step[]>(() => {
    const parsed = parseScenarioDoc(yamlText);
    return "model" in parsed ? parsed.model.steps : [];
  }, [yamlText]);

  const fire = () => {
    if (testRun.isPending) return;
    setAddedNote(null);
    testRun.mutate({
      scenario_yaml: yamlText,
      env: resolveEnv(baseVars, envEntries),
      max_requests: maxRequests,
      apply_think_time: applyThinkTime,
    });
  };

  return (
    <>
      <section
        aria-label={ko.editor.testRunControlsAria}
        className="flex flex-col gap-3 rounded border border-slate-200 p-4"
      >
        <h3 className="text-lg font-semibold">{ko.editor.testRunTitle}</h3>
        <p className="text-sm text-slate-600">{ko.editor.testRunIntro}</p>
        <TestFlowChips
          steps={traceSteps}
          trace={testRun.data ?? null}
          selectedStepId={selectedStepId ?? null}
          onSelect={(id) => useScenarioEditor.getState().select(id)}
        />
        <EnvironmentPicker
          selectedEnvId={selectedEnvId}
          onSelect={setSelectedEnvId}
          baseVars={baseVars}
          overrides={envEntries}
          onOverridesChange={setEnvEntries}
        />
        <label className="flex items-center gap-2 text-sm">
          <span className="text-slate-600">{ko.editor.testRunMaxRequests}</span>
          <input
            type="number"
            min={1}
            max={10000}
            value={maxRequests}
            onChange={(e) => setMaxRequests(Number(e.target.value))}
            className="w-28 rounded border border-slate-300 px-2 py-1 text-sm"
          />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={applyThinkTime}
            onChange={(e) => setApplyThinkTime(e.target.checked)}
          />
          <span className="text-slate-600">{ko.editor.testRunThinkTime}</span>
        </label>
        <div>
          <Button onClick={fire} disabled={testRun.isPending}>
            {testRun.isPending ? ko.editor.testRunRunning : ko.editor.testRunRun}
          </Button>
        </div>
        {testRun.error && (
          <p className="text-sm text-red-700">{(testRun.error as Error).message}</p>
        )}
      </section>

      {testRun.data && (
        <>
          <TestRunPanel
            trace={testRun.data}
            steps={traceSteps}
            onAddExtract={(stepId, extract) => {
              useScenarioEditor.getState().addStepExtract(stepId, extract);
              setAddedNote(`추출 추가됨 — ${extract.var} (Inspector·YAML에서 확인)`);
            }}
          />
          {addedNote && (
            <div role="status" className="mt-1 text-xs text-emerald-700">
              {addedNote}
            </div>
          )}
        </>
      )}
    </>
  );
}
