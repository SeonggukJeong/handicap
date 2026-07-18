import { useMemo, useState } from "react";
import { useEnvironment, useTestRun, useTestRunSequential } from "../../api/hooks";
import { ko } from "../../i18n/ko";
import { resolveEnv, type EnvEntry } from "../../api/envOverlay";
import { parseScenarioDoc } from "../../scenario/yamlDoc";
import { flattenHttpSteps, type Step } from "../../scenario/model";
import { useScenarioEditor } from "../../scenario/store";
import { Button } from "../Button";
import { Callout } from "../ui/Callout";
import { Input } from "../ui/Input";
import { EnvironmentPicker } from "../EnvironmentPicker";
import { TestFlowChips } from "./TestFlowChips";
import { TestRunPanel } from "./TestRunPanel";
import { SequentialRunPanel, defaultExpandedRow } from "./SequentialRunPanel";
import { TestRunDatasetSection, type DatasetDraftState } from "./TestRunDatasetSection";
import type { TestRunBody } from "../../api/client";

/** Test-run controls + result panel for a scenario editor buffer. Self-contained
 *  unit whose only input is the live `yamlText` — so both the new-scenario page
 *  and the edit page reuse it (works on an unsaved draft; ephemeral, nothing is
 *  persisted). The `steps` parsed from the buffer feed `TestRunPanel`'s if-row
 *  condition summaries (the `ScenarioTrace` wire contract carries no cond text). */
export function TestRunSection({ yamlText }: { yamlText: string }) {
  const testRun = useTestRun();
  const testRunSeq = useTestRunSequential();
  const selectedStepId = useScenarioEditor((s) => s.selectedStepId);
  const [selectedEnvId, setSelectedEnvId] = useState<string | null>(null);
  const [envEntries, setEnvEntries] = useState<EnvEntry[]>([]);
  const [maxRequests, setMaxRequests] = useState<number>(50);
  const [applyThinkTime, setApplyThinkTime] = useState(false);
  const [addedNote, setAddedNote] = useState<string | null>(null);
  const [dsState, setDsState] = useState<DatasetDraftState | null>(null);
  const [expandedRow, setExpandedRow] = useState<number | null>(null);
  const [seqRequested, setSeqRequested] = useState(0);
  const selectedEnv = useEnvironment(selectedEnvId ?? undefined);
  const baseVars = selectedEnv.data?.vars ?? {};
  const traceSteps = useMemo<Step[]>(() => {
    const parsed = parseScenarioDoc(yamlText);
    return "model" in parsed ? parsed.model.steps : [];
  }, [yamlText]);
  const leafCount = useMemo(() => flattenHttpSteps(traceSteps).length, [traceSteps]);
  const isPending = testRun.isPending || testRunSeq.isPending;
  const dsIncomplete = dsState?.kind === "incomplete";
  const seqData = testRunSeq.data ?? null;
  const chipTrace = seqData
    ? (seqData.rows.find((r) => r.row_index === expandedRow)?.trace ?? null)
    : (testRun.data ?? null);

  const fire = () => {
    if (isPending || dsIncomplete) return;
    setAddedNote(null);
    const base: TestRunBody = {
      scenario_yaml: yamlText,
      env: resolveEnv(baseVars, envEntries),
      max_requests: maxRequests,
      apply_think_time: applyThinkTime,
    };
    if (dsState?.kind === "ready" && dsState.config.mode === "sequential") {
      testRun.reset();
      setSeqRequested(dsState.requestedRows);
      testRunSeq.mutate(
        { ...base, dataset: dsState.config },
        { onSuccess: (s) => setExpandedRow(defaultExpandedRow(s)) },
      );
    } else {
      testRunSeq.reset();
      testRun.mutate({
        ...base,
        ...(dsState?.kind === "ready" ? { dataset: dsState.config } : {}),
      });
    }
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
          trace={chipTrace}
          selectedStepId={selectedStepId ?? null}
          onSelect={(id) => useScenarioEditor.getState().select(id)}
          expandable
        />
        <EnvironmentPicker
          selectedEnvId={selectedEnvId}
          onSelect={setSelectedEnvId}
          baseVars={baseVars}
          overrides={envEntries}
          onOverridesChange={setEnvEntries}
        />
        <TestRunDatasetSection
          onChange={setDsState}
          expectedLeafCount={leafCount}
          maxRequests={maxRequests}
        />
        <label className="flex items-center gap-2 text-sm">
          <span className="text-slate-600">{ko.editor.testRunMaxRequests}</span>
          <div className="w-28">
            <Input
              numeric
              type="number"
              min={1}
              max={10000}
              value={maxRequests}
              onChange={(e) => setMaxRequests(Number(e.target.value))}
            />
          </div>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={applyThinkTime}
            onChange={(e) => setApplyThinkTime(e.target.checked)}
          />
          <span className="text-slate-600">{ko.editor.testRunThinkTime}</span>
        </label>
        <div className="flex items-center gap-2">
          <Button onClick={fire} disabled={isPending || dsIncomplete}>
            {isPending ? ko.editor.testRunRunning : ko.editor.testRunRun}
          </Button>
          {dsState?.kind === "incomplete" && (
            <span className="text-xs text-amber-700">{dsState.reason}</span>
          )}
        </div>
        {(testRun.error ?? testRunSeq.error) && (
          <Callout variant="error">
            {((testRun.error ?? testRunSeq.error) as Error).message}
          </Callout>
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
      {seqData && (
        <SequentialRunPanel
          seq={seqData}
          steps={traceSteps}
          requestedRows={seqRequested}
          expandedRow={expandedRow}
          onExpandRow={setExpandedRow}
          onAddExtract={(stepId, extract) => {
            useScenarioEditor.getState().addStepExtract(stepId, extract);
            setAddedNote(`추출 추가됨 — ${extract.var} (Inspector·YAML에서 확인)`);
          }}
        />
      )}
    </>
  );
}
