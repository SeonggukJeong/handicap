import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useCreateScenario } from "../api/hooks";
import { Button } from "../components/Button";

const STARTER_YAML = `version: 1
name: "My scenario"
variables:
  base_url: "http://localhost:8080"
steps:
  - id: "home"
    name: "GET /"
    type: http
    request:
      method: GET
      url: "{{base_url}}/"
    assert:
      - status: 200
`;

export function ScenarioNewPage() {
  const [yaml, setYaml] = useState(STARTER_YAML);
  const navigate = useNavigate();
  const mutation = useCreateScenario();

  return (
    <div>
      <h2 className="text-xl font-semibold mb-4">New scenario</h2>
      <p className="text-sm text-slate-600 mb-4">
        Slice 2 ships a raw YAML editor only — the drag-and-drop canvas and Monaco editor arrive in
        Slice 3.
      </p>

      <textarea
        className="w-full h-96 font-mono text-sm border border-slate-300 rounded-md p-3 focus:outline-none focus:ring-2 focus:ring-slate-400"
        value={yaml}
        onChange={(e) => setYaml(e.target.value)}
        spellCheck={false}
      />

      {mutation.error && <p className="mt-3 text-red-600">{(mutation.error as Error).message}</p>}

      <div className="mt-4 flex gap-2">
        <Button
          onClick={() =>
            mutation.mutate(yaml, {
              onSuccess: (created) => navigate(`/scenarios/${created.id}`),
            })
          }
          disabled={mutation.isPending || yaml.trim().length === 0}
        >
          {mutation.isPending ? "Creating…" : "Create"}
        </Button>
        <Button variant="secondary" onClick={() => navigate("/")}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
