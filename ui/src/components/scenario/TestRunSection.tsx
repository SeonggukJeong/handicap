import { useMemo, useState } from "react";
import { useEnvironment, useTestRun } from "../../api/hooks";
import { resolveEnv, type EnvEntry } from "../../api/envOverlay";
import { parseScenarioDoc } from "../../scenario/yamlDoc";
import type { Step } from "../../scenario/model";
import { Button } from "../Button";
import { EnvironmentPicker } from "../EnvironmentPicker";
import { TestRunPanel } from "./TestRunPanel";

/** Test-run controls + result panel for a scenario editor buffer. Self-contained
 *  unit whose only input is the live `yamlText` — so both the new-scenario page
 *  and the edit page reuse it (works on an unsaved draft; ephemeral, nothing is
 *  persisted). The `steps` parsed from the buffer feed `TestRunPanel`'s if-row
 *  condition summaries (the `ScenarioTrace` wire contract carries no cond text). */
export function TestRunSection({ yamlText }: { yamlText: string }) {
  const testRun = useTestRun();
  const [selectedEnvId, setSelectedEnvId] = useState<string | null>(null);
  const [envEntries, setEnvEntries] = useState<EnvEntry[]>([]);
  const [maxRequests, setMaxRequests] = useState<number>(50);
  const selectedEnv = useEnvironment(selectedEnvId ?? undefined);
  const baseVars = selectedEnv.data?.vars ?? {};

  const traceSteps = useMemo<Step[]>(() => {
    const parsed = parseScenarioDoc(yamlText);
    return "model" in parsed ? parsed.model.steps : [];
  }, [yamlText]);

  return (
    <>
      <section
        aria-label="Test run controls"
        className="flex flex-col gap-3 rounded border border-slate-200 p-4"
      >
        <h3 className="text-lg font-semibold">Test run</h3>
        <EnvironmentPicker
          selectedEnvId={selectedEnvId}
          onSelect={setSelectedEnvId}
          baseVars={baseVars}
          overrides={envEntries}
          onOverridesChange={setEnvEntries}
        />
        <label className="flex items-center gap-2 text-sm">
          <span className="text-slate-600">Max requests</span>
          <input
            type="number"
            min={1}
            max={10000}
            value={maxRequests}
            onChange={(e) => setMaxRequests(Number(e.target.value))}
            className="w-28 rounded border border-slate-300 px-2 py-1 text-sm"
          />
        </label>
        <div>
          <Button
            onClick={() =>
              testRun.mutate({
                scenario_yaml: yamlText,
                env: resolveEnv(baseVars, envEntries),
                max_requests: maxRequests,
              })
            }
            disabled={testRun.isPending}
          >
            {testRun.isPending ? "Running…" : "Test run"}
          </Button>
        </div>
        {testRun.error && (
          <p className="text-sm text-red-700">{(testRun.error as Error).message}</p>
        )}
      </section>

      {testRun.data && <TestRunPanel trace={testRun.data} steps={traceSteps} />}
    </>
  );
}
