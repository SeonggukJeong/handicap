import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useScenario, useUpdateScenario } from "../api/hooks";
import { Button } from "../components/Button";
import { EditorShell } from "../components/scenario/EditorShell";

export function ScenarioEditPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data, isLoading, error } = useScenario(id);
  const update = useUpdateScenario(id ?? "");
  const [yamlText, setYamlText] = useState<string>("");
  const [loadedVersion, setLoadedVersion] = useState<number | null>(null);
  const [originalYaml, setOriginalYaml] = useState<string>("");

  useEffect(() => {
    if (data) {
      setYamlText(data.yaml);
      setOriginalYaml(data.yaml);
      setLoadedVersion(data.version);
    }
  }, [data]);

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

      <EditorShell initialYaml={data.yaml} onChange={setYamlText} />

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
