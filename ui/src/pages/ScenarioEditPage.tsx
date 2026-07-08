import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useCloneScenario, useScenario, useScenarios, useUpdateScenario } from "../api/hooks";
import { Breadcrumb } from "../components/Breadcrumb";
import { Button } from "../components/Button";
import { Modal } from "../components/Modal";
import { EditorShell } from "../components/scenario/EditorShell";
import { InsertTemplateModal } from "../components/scenario/InsertTemplateModal";
import { SaveTemplateDialog } from "../components/scenario/SaveTemplateDialog";
import { TestRunSection } from "../components/scenario/TestRunSection";
import { Callout } from "../components/ui/Callout";
import { Input } from "../components/ui/Input";
import { ko } from "../i18n/ko";
import { useScenarioEditor } from "../scenario/store";

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
  const [saveTplOpen, setSaveTplOpen] = useState(false);
  const [insertTplOpen, setInsertTplOpen] = useState(false);
  const [seededId, setSeededId] = useState<string | null>(null);
  const seeded = data !== undefined && seededId === data.id;
  const [chromeCollapsed, setChromeCollapsed] = useState(false);

  // 템플릿 진입점 게이트: store 상태로 판단 (parseScenarioDoc 재호출 금지 — 깨진 텍스트 중
  // 엔 store yamlText가 마지막 정상본이라 재파싱 결과가 다를 수 있음)
  const editorModel = useScenarioEditor((s) => s.model);
  const editorYamlError = useScenarioEditor((s) => s.yamlError);
  const tplReady = editorModel !== null && editorYamlError === null;

  // ScenarioNewPage.chooseTemplate 선적재 패턴(U3 B1): EditorShell 마운트 전에
  // store를 로드 텍스트로 적재하고 그 시점 canonical을 yamlText/originalYaml
  // 양쪽에 시드 — 첫 onChange가 무엇을 캡처하든 baseline과 일치한다.
  // 재시드는 시나리오 id 변경 시만 — loadedVersion도 id-키드(같은 id의
  // 백그라운드 refetch가 낡은 편집 위에 새 버전을 silent 채택하지 않게, R9).
  useEffect(() => {
    if (!data || seededId === data.id) return;
    useScenarioEditor.getState().loadFromString(data.yaml);
    const canonical = useScenarioEditor.getState().yamlText;
    setYamlText(canonical);
    setOriginalYaml(canonical);
    setLoadedVersion(data.version);
    setSeededId(data.id);
  }, [data, seededId]);

  const handleEditorChange = useCallback((next: string) => {
    setYamlText(next);
  }, []);

  const [nameEditing, setNameEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const nameEscapedRef = useRef(false);

  if (isLoading) return <p className="text-slate-500">{ko.common.loading}</p>;
  if (error)
    return <Callout variant="error">{ko.common.failedToLoad((error as Error).message)}</Callout>;
  if (!data) return <p className="text-slate-500">{ko.common.notFound}</p>;

  const dirty = originalYaml !== yamlText;
  // R7: 싱글톤 store의 stale 모델(이전 페이지 잔존물)이 시드 전 프레임에 새지
  // 않도록 seeded로 게이트 — 시드 전·깨진-YAML(model=null)은 서버명 폴백.
  const liveName = seeded ? (editorModel?.name ?? data.name) : data.name;
  const nameEditable = seeded && editorModel !== null && editorYamlError === null;

  const startNameEdit = () => {
    // 매 편집 세션은 클린 상태로 시작 — 이전 세션의 Escape가 남긴
    // nameEscapedRef를 여기서 리셋하지 않으면, jsdom/React가 언마운트
    // 시 blur를 안 쏘는 탓에 플래그가 소비되지 않고 남아 *다음* 정상
    // 커밋(Enter/blur)을 commitName 첫 분기가 취소로 오인해 삼킨다.
    nameEscapedRef.current = false;
    setNameDraft(liveName);
    setNameEditing(true);
  };
  // 커밋: trim 후 빈 문자열이면 revert(ScenarioModel.name min(1) — 빈 커밋은
  // doc/model 갈라짐), 동일 이름도 no-op. Enter 커밋 직후 unmount-blur가 한 번
  // 더 불러도 liveName 동등성 가드로 멱등.
  const commitName = () => {
    if (nameEscapedRef.current) {
      nameEscapedRef.current = false;
      setNameEditing(false);
      return;
    }
    setNameEditing(false);
    const trimmed = nameDraft.trim();
    if (trimmed.length === 0 || trimmed === liveName) return;
    useScenarioEditor.getState().setName(trimmed);
  };
  const scenariosLoaded = scenarios !== undefined;

  // 클론 소스는 항상 data.yaml(현재 저장본) 또는 next.yaml(방금 저장한 결과) — 둘 다
  // 서버가 준 유효 YAML. originalYaml(정규화·post-mount까지 "")은 클론 소스로 쓰지 않음.
  const cloneAndGo = async (sourceYaml: string, sourceName: string) => {
    const existingNames = scenarios?.scenarios.map((s) => s.name) ?? [];
    try {
      const created = await clone.mutateAsync({ sourceYaml, sourceName, existingNames });
      setCloneDialog(null);
      navigate(`/scenarios/${created.id}`);
    } catch {
      // clone.error(useMutation 내부 상태)가 이미 페이지-레벨 Callout을 구동한다.
      // 열려 있던 모달을 닫아 그 Callout이 backdrop에 가리지 않게 한다(non-dirty
      // 즉시경로는 모달이 없으므로 no-op).
      setCloneDialog(null);
    }
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
      await cloneAndGo(next.yaml, next.name);
    } catch (e) {
      setCloneDialog({ stage: "save-failed", message: (e as Error).message });
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {/* C: 전용 sticky 크롬 wrapper(브레드크럼+제목행만). 내부 gap-2, outer는 gap-4 유지.
          bg-slate-50 = 페이지 배경(index.html:12 `<body class="bg-slate-50">`)이라 그리드 투과 방지.
          정확한 top offset·z·bg·border는 라이브로 확정(§6 Q2 폴백). */}
      <div className="sticky top-0 z-20 -mx-6 flex flex-col gap-2 border-b border-slate-200 bg-slate-50 px-6">
        {!chromeCollapsed && (
          <Breadcrumb items={[{ label: ko.nav.scenarios, to: "/" }, { label: liveName }]} />
        )}
        <div className="flex items-center justify-between">
          <div className="flex items-start gap-2">
            <button
              type="button"
              aria-label={chromeCollapsed ? ko.editor.chromeExpand : ko.editor.chromeCollapse}
              aria-expanded={!chromeCollapsed}
              onClick={() => setChromeCollapsed((v) => !v)}
              className="mt-1 text-slate-500 hover:text-slate-700"
            >
              <span aria-hidden="true">{chromeCollapsed ? "▸" : "▾"}</span>
            </button>
            <div>
              {nameEditing ? (
                <Input
                  autoFocus
                  aria-label={ko.editor.nameInputAria}
                  className="text-xl font-semibold"
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  onBlur={commitName}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitName();
                    if (e.key === "Escape") {
                      nameEscapedRef.current = true;
                      setNameEditing(false);
                    }
                  }}
                />
              ) : (
                <div className="flex items-center gap-2">
                  <h2 className="text-xl font-semibold">{liveName}</h2>
                  <button
                    type="button"
                    aria-label={ko.editor.renameAria}
                    title={nameEditable ? ko.editor.renameTitle : ko.editor.renameDisabledTitle}
                    disabled={!nameEditable}
                    onClick={startNameEdit}
                    className="text-slate-500 hover:text-slate-700 disabled:opacity-50"
                  >
                    <span aria-hidden="true">✎</span>
                  </button>
                </div>
              )}
              {!chromeCollapsed && (
                <p className="text-sm text-slate-600">
                  v{data.version} · updated {new Date(data.updated_at).toLocaleString()}
                </p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              onClick={() => setSaveTplOpen(true)}
              disabled={!tplReady}
              title={tplReady ? undefined : ko.stepTemplates.gateTooltip}
            >
              {ko.stepTemplates.saveButton}
            </Button>
            <Button
              variant="secondary"
              onClick={() => setInsertTplOpen(true)}
              disabled={!tplReady}
              title={tplReady ? undefined : ko.stepTemplates.gateTooltip}
            >
              {ko.stepTemplates.insertButton}
            </Button>
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
              {update.isPending ? ko.common.saving : ko.common.save}
            </Button>
            <Button
              variant="secondary"
              onClick={onCloneClick}
              disabled={!scenariosLoaded || clone.isPending}
            >
              {clone.isPending ? ko.pages.duplicatingBtn : ko.pages.duplicateBtn}
            </Button>
            <Link to={`/scenarios/${data.id}/runs`}>
              <Button variant="secondary">{ko.pages.runsBtn}</Button>
            </Link>
          </div>
        </div>
      </div>

      {update.error && <Callout variant="error">{(update.error as Error).message}</Callout>}
      {clone.error && (
        <Callout variant="error" role="alert">
          {ko.pages.cloneFailed((clone.error as Error).message)}
        </Callout>
      )}

      {seeded && (
        <EditorShell
          initialYaml={data.yaml}
          onChange={handleEditorChange}
          chromeCollapsed={chromeCollapsed}
        />
      )}

      <TestRunSection yamlText={yamlText} />

      {saveTplOpen && <SaveTemplateDialog onClose={() => setSaveTplOpen(false)} />}
      {insertTplOpen && <InsertTemplateModal onClose={() => setInsertTplOpen(false)} />}

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
