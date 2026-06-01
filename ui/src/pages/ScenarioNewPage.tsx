import { useCallback, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useCreateScenario } from "../api/hooks";
import { Button } from "../components/Button";
import { EditorShell } from "../components/scenario/EditorShell";
import { TestRunSection } from "../components/scenario/TestRunSection";

export const STARTER_YAML = `version: 1
name: "Untitled"
cookie_jar: auto
variables: {}
steps: []
`;

export function ScenarioNewPage() {
  const navigate = useNavigate();
  const mutation = useCreateScenario();
  const [yamlText, setYamlText] = useState(STARTER_YAML);
  const [originalYaml, setOriginalYaml] = useState(STARTER_YAML);
  const baselineSeededRef = useRef(false);

  // The first EditorShell onChange is the canonical (re-serialized) starter —
  // seed it as baseline so an untouched draft isn't falsely "dirty" (yaml
  // normalization would otherwise trip the Cancel discard prompt immediately).
  const handleEditorChange = useCallback((next: string) => {
    setYamlText(next);
    if (!baselineSeededRef.current) {
      baselineSeededRef.current = true;
      setOriginalYaml(next);
    }
  }, []);

  const dirty = yamlText !== originalYaml;

  const cancel = () => {
    if (!dirty || window.confirm("저장하지 않은 변경을 버릴까요?")) navigate("/");
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">New scenario</h2>
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
          <Button variant="secondary" onClick={cancel}>
            Cancel
          </Button>
        </div>
      </div>

      {mutation.error && <p className="text-red-600">{(mutation.error as Error).message}</p>}

      <EditorShell initialYaml={STARTER_YAML} onChange={handleEditorChange} />

      <TestRunSection yamlText={yamlText} />
    </div>
  );
}
