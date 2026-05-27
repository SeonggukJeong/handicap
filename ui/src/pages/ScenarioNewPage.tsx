import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useCreateScenario } from "../api/hooks";
import { Button } from "../components/Button";
import { EditorShell } from "../components/scenario/EditorShell";

const STARTER_YAML = `version: 1
name: "Untitled"
cookie_jar: auto
variables:
  base_url: "http://localhost:8080"
steps: []
`;

export function ScenarioNewPage() {
  const navigate = useNavigate();
  const mutation = useCreateScenario();
  const [yamlText, setYamlText] = useState(STARTER_YAML);

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-xl font-semibold">New scenario</h2>

      <EditorShell initialYaml={STARTER_YAML} onChange={setYamlText} />

      {mutation.error && <p className="text-red-600">{(mutation.error as Error).message}</p>}

      <div className="flex gap-2">
        <Button
          onClick={() =>
            mutation.mutate(yamlText, {
              onSuccess: (created) => navigate(`/scenarios/${created.id}`),
            })
          }
          disabled={mutation.isPending || yamlText.trim().length === 0}
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
