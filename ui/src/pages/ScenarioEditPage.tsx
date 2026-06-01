import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useScenario, useTestRun, useUpdateScenario, useEnvironment } from "../api/hooks";
import { resolveEnv, type EnvEntry } from "../api/envOverlay";
import { parseScenarioDoc } from "../scenario/yamlDoc";
import type { Step } from "../scenario/model";
import { Button } from "../components/Button";
import { EnvironmentPicker } from "../components/EnvironmentPicker";
import { EditorShell } from "../components/scenario/EditorShell";
import { TestRunPanel } from "../components/scenario/TestRunPanel";

export function ScenarioEditPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data, isLoading, error } = useScenario(id);
  const update = useUpdateScenario(id ?? "");
  const [yamlText, setYamlText] = useState<string>("");
  const [loadedVersion, setLoadedVersion] = useState<number | null>(null);
  const [originalYaml, setOriginalYaml] = useState<string>("");
  const baselineSeededRef = useRef(false);

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

  useEffect(() => {
    if (data) {
      setLoadedVersion(data.version);
      baselineSeededRef.current = false; // re-seed when data changes
    }
  }, [data]);

  // EditorShell calls this after every store yamlText change. The first call
  // after a fresh data load captures the canonical (re-serialized) form as
  // our baseline — so the dirty flag stays false until the user actually edits.
  const handleEditorChange = useCallback((next: string) => {
    setYamlText(next);
    if (!baselineSeededRef.current) {
      baselineSeededRef.current = true;
      setOriginalYaml(next);
    }
  }, []);

  if (isLoading) return <p className="text-slate-500">Loading…</p>;
  if (error) return <p className="text-red-600">Failed: {(error as Error).message}</p>;
  if (!data) return <p className="text-slate-500">Not found.</p>;

  const dirty = originalYaml !== yamlText;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">{data.name}</h2>
          <p className="text-sm text-slate-600">
            v{data.version} · updated {new Date(data.updated_at).toLocaleString()}
          </p>
        </div>
        <div className="flex gap-2">
          <Link to={`/scenarios/${data.id}/runs`}>
            <Button variant="secondary">Runs</Button>
          </Link>
        </div>
      </div>

      <EditorShell initialYaml={data.yaml} onChange={handleEditorChange} />

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

      {update.error && <p className="text-red-600">{(update.error as Error).message}</p>}

      <div className="flex gap-2">
        <Button
          onClick={() =>
            loadedVersion !== null &&
            update.mutate(
              { yaml: yamlText, version: loadedVersion },
              {
                onSuccess: (next) => {
                  setLoadedVersion(next.version);
                  setOriginalYaml(next.yaml);
                  baselineSeededRef.current = true; // server form is canonical; don't re-seed from next onChange
                },
              },
            )
          }
          disabled={!dirty || update.isPending || loadedVersion === null}
        >
          {update.isPending ? "Saving…" : "Save"}
        </Button>
        <Button variant="secondary" onClick={() => navigate("/")}>
          Back
        </Button>
      </div>
    </div>
  );
}
