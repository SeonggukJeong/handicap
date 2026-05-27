import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useScenario, useUpdateScenario } from "../api/hooks";
import { Button } from "../components/Button";

export function ScenarioEditPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data, isLoading, error } = useScenario(id);
  const update = useUpdateScenario(id ?? "");
  const [yaml, setYaml] = useState<string>("");
  const [loadedVersion, setLoadedVersion] = useState<number | null>(null);

  useEffect(() => {
    if (data) {
      setYaml(data.yaml);
      setLoadedVersion(data.version);
    }
  }, [data]);

  if (isLoading) return <p className="text-slate-500">Loading…</p>;
  if (error) return <p className="text-red-600">Failed: {(error as Error).message}</p>;
  if (!data) return <p className="text-slate-500">Not found.</p>;

  const dirty = data.yaml !== yaml;

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
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

      <textarea
        className="w-full h-96 font-mono text-sm border border-slate-300 rounded-md p-3 focus:outline-none focus:ring-2 focus:ring-slate-400"
        value={yaml}
        onChange={(e) => setYaml(e.target.value)}
        spellCheck={false}
      />

      {update.error && <p className="mt-3 text-red-600">{(update.error as Error).message}</p>}

      <div className="mt-4 flex gap-2">
        <Button
          onClick={() =>
            loadedVersion !== null &&
            update.mutate(
              { yaml, version: loadedVersion },
              {
                onSuccess: (next) => {
                  setLoadedVersion(next.version);
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
