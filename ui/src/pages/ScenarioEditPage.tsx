import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useCloneScenario, useScenario, useScenarios, useUpdateScenario } from "../api/hooks";
import { Button } from "../components/Button";
import { Modal } from "../components/Modal";
import { EditorShell } from "../components/scenario/EditorShell";
import { TestRunSection } from "../components/scenario/TestRunSection";

type CloneDialog = null | { stage: "confirm" } | { stage: "save-failed"; message: string };

export function ScenarioEditPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data, isLoading, error } = useScenario(id);
  const { data: scenarios } = useScenarios();
  const update = useUpdateScenario(id ?? "");
  const clone = useCloneScenario();
  const [yamlText, setYamlText] = useState<string>("");
  const [loadedVersion, setLoadedVersion] = useState<number | null>(null);
  const [originalYaml, setOriginalYaml] = useState<string>("");
  const [cloneDialog, setCloneDialog] = useState<CloneDialog>(null);
  const baselineSeededRef = useRef(false);

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
  const scenariosLoaded = scenarios !== undefined;

  // 클론 소스는 항상 data.yaml(현재 저장본) 또는 next.yaml(방금 저장한 결과) — 둘 다
  // 서버가 준 유효 YAML. originalYaml(정규화·post-mount까지 "")은 클론 소스로 쓰지 않음.
  const cloneAndGo = async (sourceYaml: string, sourceName: string) => {
    const existingNames = scenarios?.scenarios.map((s) => s.name) ?? [];
    const created = await clone.mutateAsync({ sourceYaml, sourceName, existingNames });
    setCloneDialog(null);
    navigate(`/scenarios/${created.id}`);
  };

  const onCloneClick = () => {
    if (!dirty) {
      void cloneAndGo(data.yaml, data.name);
      return;
    }
    setCloneDialog({ stage: "confirm" });
  };

  const saveThenClone = async () => {
    if (loadedVersion === null) return;
    try {
      const next = await update.mutateAsync({ yaml: yamlText, version: loadedVersion });
      setLoadedVersion(next.version);
      setOriginalYaml(next.yaml);
      baselineSeededRef.current = true;
      await cloneAndGo(next.yaml, next.name);
    } catch (e) {
      setCloneDialog({ stage: "save-failed", message: (e as Error).message });
    }
  };

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
          <Button
            variant="secondary"
            onClick={onCloneClick}
            disabled={!scenariosLoaded || clone.isPending}
          >
            {clone.isPending ? "Duplicating…" : "Duplicate"}
          </Button>
          <Link to={`/scenarios/${data.id}/runs`}>
            <Button variant="secondary">Runs</Button>
          </Link>
        </div>
      </div>

      {update.error && <p className="text-red-600">{(update.error as Error).message}</p>}
      {clone.error && (
        <p role="alert" className="text-sm text-red-600">
          복제 실패: {(clone.error as Error).message}
        </p>
      )}

      <EditorShell initialYaml={data.yaml} onChange={handleEditorChange} />

      <TestRunSection yamlText={yamlText} />

      <Modal
        open={cloneDialog?.stage === "confirm"}
        onClose={() => setCloneDialog(null)}
        title="시나리오 복제"
      >
        <div className="flex flex-col gap-4">
          <p>변경사항이 저장되지 않았습니다. 복제 전에 저장할까요?</p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCloneDialog(null)}>
              취소
            </Button>
            <Button
              variant="secondary"
              onClick={() => void cloneAndGo(data.yaml, data.name)}
              disabled={clone.isPending}
            >
              저장 없이 복제
            </Button>
            <Button
              onClick={() => void saveThenClone()}
              disabled={update.isPending || clone.isPending}
            >
              저장 후 복제
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        open={cloneDialog?.stage === "save-failed"}
        onClose={() => setCloneDialog(null)}
        title="저장 실패"
      >
        <div className="flex flex-col gap-4">
          <p>
            저장에 실패했습니다: {cloneDialog?.stage === "save-failed" ? cloneDialog.message : ""}.
            마지막 저장본으로 복제를 계속할까요?
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCloneDialog(null)}>
              취소
            </Button>
            <Button
              onClick={() => void cloneAndGo(data.yaml, data.name)}
              disabled={clone.isPending}
            >
              저장본으로 복제
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
