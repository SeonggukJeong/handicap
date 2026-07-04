import { useEffect, useRef, useState } from "react";
import { useScenarioEditor } from "../../scenario/store";
import { ko } from "../../i18n/ko";
import { FlowOutline } from "./FlowOutline";
import { Inspector } from "./Inspector";
import { MonacoYamlView } from "./MonacoYamlView";
import { Modal } from "../Modal";
import { TestFlowChips } from "./TestFlowChips";
import { ValidationBanner } from "./ValidationBanner";
import { VariablesPanel } from "./VariablesPanel";
import type { Step } from "../../scenario/model";

const EMPTY_STEPS: Step[] = []; // 셀렉터 안정 참조 — 인라인 `?? []` 금지(getSnapshot 함정)

export function EditorShell({
  initialYaml,
  onChange,
}: {
  initialYaml: string;
  onChange?: (yaml: string) => void;
}) {
  const loadFromString = useScenarioEditor((s) => s.loadFromString);
  const yamlText = useScenarioEditor((s) => s.yamlText);
  const commitPendingYaml = useScenarioEditor((s) => s.commitPendingYaml);
  const steps = useScenarioEditor((s) => s.model?.steps ?? EMPTY_STEPS);
  const selectedStepId = useScenarioEditor((s) => s.selectedStepId);
  const select = useScenarioEditor((s) => s.select);

  const [yamlOpen, setYamlOpen] = useState(false);
  const [varsOpen, setVarsOpen] = useState(true);
  const [wideOpen, setWideOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);

  const initialRef = useRef(initialYaml);
  useEffect(() => {
    loadFromString(initialRef.current);
  }, [loadFromString]);
  useEffect(() => {
    onChange?.(yamlText);
  }, [yamlText, onChange]);

  // R8 리셋 ②: 선택 해제(모달 내 삭제 포함 — removeStep이 선택을 먼저 clear) 시 닫힘.
  // 이 리셋이 없으면 stale detailOpen=true가 다음 칩 점프에서 모달을 재오픈한다.
  useEffect(() => {
    if (selectedStepId === null) setDetailOpen(false);
  }, [selectedStepId]);

  const closeYaml = () => {
    commitPendingYaml(); // 디바운스 윈도 중 닫기 시 마지막 편집 flush (R8)
    setYamlOpen(false);
  };

  // R8 리셋 ①+blur-flush: ESC는 blur 없이 Inspector를 언마운트해 onBlur-커밋 draft
  // (타임아웃/think/JSON 바디/추출/조건)를 버린다 — 동기 blur로 커밋을 flush 후 닫기.
  const closeDetail = () => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    setDetailOpen(false);
  };

  const jumpToStep = (id: string) => {
    select(id);
    // jsdom은 scrollIntoView 미구현 — 옵셔널 호출. block:nearest = 중첩 스크롤에서 페이지 이동 최소화.
    document.querySelector(`[data-step-id="${id}"]`)?.scrollIntoView?.({ block: "nearest" });
  };

  return (
    <div className="flex flex-col gap-3">
      <ValidationBanner onOpenYaml={() => setYamlOpen(true)} />
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label={ko.editor.varsToggleAria}
          onClick={() => setVarsOpen((v) => !v)}
          className="rounded border border-slate-300 px-2 py-1 text-sm hover:bg-slate-100"
        >
          <span aria-hidden="true">☰</span> {ko.editor.varsToggle}
        </button>
        <button
          type="button"
          aria-label={ko.editor.openYaml}
          onClick={() => setYamlOpen(true)}
          className="rounded border border-slate-300 px-2 py-1 text-sm hover:bg-slate-100"
        >
          <span aria-hidden="true">{"</>"}</span> {ko.editor.openYaml}
        </button>
        <button
          type="button"
          aria-label={ko.editor.wideToggleAria}
          aria-pressed={wideOpen}
          onClick={() => {
            setWideOpen((v) => !v);
            setDetailOpen(false); // 와이드 전환(양방향) 시 모달 상태 초기화 (R8 ③)
          }}
          className="rounded border border-slate-300 px-2 py-1 text-sm hover:bg-slate-100"
        >
          <span aria-hidden="true">⛶</span> {ko.editor.wideToggle}
        </button>
      </div>
      <div
        data-testid="editor-grid"
        className={
          wideOpen
            ? `grid gap-4 ${varsOpen ? "grid-cols-[210px_1fr]" : "grid-cols-[1fr]"}`
            : `grid gap-4 max-h-[calc(100vh-16rem)] grid-rows-[minmax(0,1fr)] ${varsOpen ? "grid-cols-[210px_minmax(260px,300px)_1fr]" : "grid-cols-[minmax(260px,300px)_1fr]"}`
        }
      >
        {varsOpen && (
          <aside
            role="complementary"
            aria-label={ko.editor.varsPanelAria}
            className={`flex min-h-0 flex-col overflow-visible rounded-md border border-slate-200 bg-white p-3 ${wideOpen ? "max-h-[calc(100vh-16rem)]" : ""}`}
          >
            <VariablesPanel onJumpToStep={jumpToStep} />
          </aside>
        )}
        {wideOpen ? (
          <div className="flex max-h-[calc(100vh-16rem)] min-h-0 flex-col gap-2 rounded-md border border-slate-200 bg-white p-3">
            <section aria-label={ko.editor.wideFlowStripAria} className="shrink-0">
              <TestFlowChips
                steps={steps}
                trace={null}
                selectedStepId={selectedStepId}
                onSelect={jumpToStep}
              />
            </section>
            <div className="min-h-0 flex-1">
              <FlowOutline wide onActivateStep={() => setDetailOpen(true)} />
            </div>
          </div>
        ) : (
          <>
            <div className="rounded-md border border-slate-200 bg-white p-3 overflow-auto min-h-0">
              <FlowOutline />
            </div>
            <div className="rounded-md border border-slate-200 bg-white p-3 overflow-auto min-h-0">
              <Inspector />
            </div>
          </>
        )}
      </div>
      <Modal open={yamlOpen} onClose={closeYaml} title={ko.editor.yamlModalTitle}>
        <div className="h-[70vh]">
          <MonacoYamlView />
        </div>
      </Modal>
      <Modal
        open={wideOpen && detailOpen && selectedStepId !== null}
        onClose={closeDetail}
        title={ko.editor.stepDetailModalTitle}
      >
        <Inspector />
      </Modal>
    </div>
  );
}
