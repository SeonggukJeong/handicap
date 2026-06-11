import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useCreateScenario } from "../api/hooks";
import { Breadcrumb } from "../components/Breadcrumb";
import { Button } from "../components/Button";
import { EditorShell } from "../components/scenario/EditorShell";
import { TestRunSection } from "../components/scenario/TestRunSection";
import { ko } from "../i18n/ko";
import { useScenarioEditor } from "../scenario/store";
import { BLANK_TEMPLATE_YAML, SCENARIO_TEMPLATES } from "../scenario/templates";

// 빈 템플릿이 곧 기존 STARTER — 단일 소스는 templates.ts (기존 import 호환 re-export).
export const STARTER_YAML = BLANK_TEMPLATE_YAML;

export function ScenarioNewPage() {
  const navigate = useNavigate();
  const mutation = useCreateScenario();
  // null = 템플릿 선택 단계(EditorShell mount 이전 — initialYaml은 mount 1회 고정이라
  // 선택을 mount 앞에 둔다, spec §4). 선택 후엔 그 YAML이 에디터 시드.
  const [seedYaml, setSeedYaml] = useState<string | null>(null);
  const [yamlText, setYamlText] = useState("");
  const [originalYaml, setOriginalYaml] = useState("");

  const handleEditorChange = useCallback((next: string) => {
    setYamlText(next);
  }, []);

  const dirty = yamlText !== originalYaml;

  // dirty baseline은 여기서 선험 확정한다. EditorShell의 첫 onChange는 mount-렌더에
  // 캡처된 *pre-load* store 텍스트(싱글톤 잔존물)라 baseline 시딩에 쓸 수 없다 —
  // 대신 mount 전에 store를 선적재해 "첫 onChange == canonical 템플릿"을 만들고,
  // 그 canonical을 yamlText/originalYaml 양쪽에 시드한다(미수정 = dirty false).
  const chooseTemplate = (yaml: string) => {
    useScenarioEditor.getState().loadFromString(yaml);
    const canonical = useScenarioEditor.getState().yamlText;
    setSeedYaml(yaml);
    setYamlText(canonical);
    setOriginalYaml(canonical);
  };

  const cancel = () => {
    if (!dirty || window.confirm(ko.editor.discardConfirm)) navigate("/");
  };

  if (seedYaml === null) {
    return (
      <div className="flex flex-col gap-4">
        <Breadcrumb
          items={[{ label: ko.nav.scenarios, to: "/" }, { label: ko.pages.newScenario }]}
        />
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold">{ko.pages.newScenario}</h2>
          <Button variant="secondary" onClick={() => navigate("/")}>
            {ko.editor.cancel}
          </Button>
        </div>
        <section aria-label={ko.templates.galleryAria} className="flex flex-col gap-2">
          <p className="text-sm font-medium text-slate-700">{ko.templates.galleryTitle}</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-3xl">
            {SCENARIO_TEMPLATES.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => chooseTemplate(t.yaml)}
                className="rounded-md border border-slate-300 bg-white p-4 text-left hover:border-slate-500 hover:bg-slate-50"
              >
                <span className="block font-medium text-slate-900">{t.name}</span>
                <span className="mt-1 block text-xs text-slate-500">{t.description}</span>
              </button>
            ))}
          </div>
          <p className="text-xs text-slate-400">{ko.templates.galleryHint}</p>
        </section>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Breadcrumb items={[{ label: ko.nav.scenarios, to: "/" }, { label: ko.pages.newScenario }]} />
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">{ko.pages.newScenario}</h2>
        <div className="flex gap-2">
          <Button
            onClick={() =>
              mutation.mutate(yamlText, {
                onSuccess: (created) => navigate(`/scenarios/${created.id}`),
              })
            }
            disabled={mutation.isPending || yamlText.trim().length === 0}
          >
            {mutation.isPending ? ko.editor.creating : ko.editor.create}
          </Button>
          <Button variant="secondary" onClick={cancel}>
            {ko.editor.cancel}
          </Button>
        </div>
      </div>

      {mutation.error && <p className="text-red-600">{(mutation.error as Error).message}</p>}

      <EditorShell initialYaml={seedYaml} onChange={handleEditorChange} />

      <TestRunSection yamlText={yamlText} />
    </div>
  );
}
