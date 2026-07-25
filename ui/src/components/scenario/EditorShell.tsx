import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { useScenarioEditor } from "../../scenario/store";
import { ko } from "../../i18n/ko";
import { FlowOutline } from "./FlowOutline";
import { Inspector } from "./Inspector";
import { MonacoYamlView } from "./MonacoYamlView";
import { Modal } from "../Modal";
import { TestFlowChips } from "./TestFlowChips";
import { TrustBoard } from "./TrustBoard";
import { ValidationBanner } from "./ValidationBanner";
import { VariablesPanel } from "./VariablesPanel";
import { ScenarioDefaults } from "./ScenarioDefaults";
import { ScenarioNotesCallout } from "./ScenarioNotesCallout";
import { ThinkTimeBoard } from "./ThinkTimeBoard";
import { evaluateTrust, isTrustApplicable } from "../../scenario/trust";
import { DRAFT_KEY, testRunStateFor } from "../../scenario/trustPrefs";
import type { Step } from "../../scenario/model";

const EMPTY_STEPS: Step[] = []; // 셀렉터 안정 참조 — 인라인 `?? []` 금지(getSnapshot 함정)

export function EditorShell({
  initialYaml,
  onChange,
  chromeCollapsed = false,
}: {
  initialYaml: string;
  onChange?: (yaml: string) => void;
  chromeCollapsed?: boolean;
}) {
  const loadFromString = useScenarioEditor((s) => s.loadFromString);
  const yamlText = useScenarioEditor((s) => s.yamlText);
  const commitPendingYaml = useScenarioEditor((s) => s.commitPendingYaml);
  const steps = useScenarioEditor((s) => s.model?.steps ?? EMPTY_STEPS);
  const selectedStepId = useScenarioEditor((s) => s.selectedStepId);
  const select = useScenarioEditor((s) => s.select);

  const [yamlOpen, setYamlOpen] = useState(false);
  const [thinkBoardOpen, setThinkBoardOpen] = useState(false);
  const [varsOpen, setVarsOpen] = useState(true);
  const [wideOpen, setWideOpen] = useState(false);
  const [varsWide, setVarsWide] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [trustOpen, setTrustOpen] = useState(false);
  const { id } = useParams<{ id: string }>();
  const scenarioKey = id ?? DRAFT_KEY;
  const model = useScenarioEditor((s) => s.model);
  const yamlError = useScenarioEditor((s) => s.yamlError);
  const testRunEpoch = useScenarioEditor((s) => s.testRunEpoch);

  // 검사 우선순위(spec §7.4): ① yamlError → 보류 ② model null → 미렌더
  // ③ !isTrustApplicable → 미렌더 ④ 평가. isTrustApplicable을 null 모델에 부르지 않는다.
  const trustPending = yamlError !== null;
  const trustReport = useMemo(
    () => (!trustPending && model && isTrustApplicable(model) ? evaluateTrust(model) : null),
    [trustPending, model],
  );
  const trustTestRun = useMemo(
    () => (model ? testRunStateFor(scenarioKey, model) : "never"),
    // testRunEpoch는 localStorage 재조회 트리거다(값 자체는 안 쓴다).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [model, scenarioKey, testRunEpoch],
  );
  const showTrustChip = trustPending || trustReport !== null;

  // 칩의 **가시 라벨을 한 번만** 만들어 렌더 콘텐츠와 접근명 접두에 함께 쓴다 — 두 값이
  // 갈라질 수 없어야 한다(WCAG 2.5.3 Label in Name: aria-label이 텍스트 콘텐츠를 덮으므로
  // 가시 라벨을 포함하지 않으면 음성 제어로 칩을 호출할 수 없다). 등급 색은 grade span만.
  // `showTrustChip && trustReport === null`이면 곧 trustPending이라 별 분기가 필요 없다.
  const trustGradeLead = `${ko.trust.chipLabel} · `;
  const trustGrade = trustReport
    ? `${ko.trust.level[trustReport.level]}${trustReport.failed > 0 ? ` ${trustReport.failed}` : ""}`
    : ko.trust.chipPending;
  // 보류 상태에는 접미를 붙이지 않는다(spec §7.4) — `trustReport !== null`이 그걸 보장한다.
  const trustSuffix =
    trustReport !== null && trustTestRun !== "verified" ? ` ${ko.trust.chipUnverifiedSuffix}` : "";
  const trustVisible = `${trustGradeLead}${trustGrade}${trustSuffix}`;
  const trustChipName = `${trustVisible} ${
    trustReport === null
      ? ko.trust.chipAriaTailPending
      : trustReport.level === "good"
        ? ko.trust.chipAriaTailGood
        : ko.trust.chipAriaTail(trustReport.failed)
  }`;
  const trustGradeClass =
    trustReport?.level === "weak"
      ? "text-red-700"
      : trustReport?.level === "caution"
        ? "text-amber-700"
        : undefined;

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

  // C3: 접힘이면 크롬이 줄어 그리드가 세로를 되찾는다. 두 값 모두 소스 리터럴(JIT).
  // max-h(상한)가 아니라 h(채움) — 내용이 짧아도 그리드/열이 뷰포트 높이를 채워 패널이
  // 한 화면에 넓게 들어온다(min-h-[520px]는 작은 화면 floor로 유지). 내용이 캡을 넘치면
  // 열의 overflow-auto가 내부 스크롤을 담당(#4 grid-rows-[minmax(0,1fr)] 계약 유지).
  const capClass = chromeCollapsed ? "h-[calc(100vh-11rem)]" : "h-[calc(100vh-16rem)]";

  return (
    <div className="flex flex-col gap-3">
      <ScenarioNotesCallout />
      <ValidationBanner onOpenYaml={() => setYamlOpen(true)} />
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label={ko.editor.varsToggleAria}
          disabled={varsWide}
          title={varsWide ? ko.editor.varsWideActiveTitle : undefined}
          onClick={() => setVarsOpen((v) => !v)}
          className="rounded border border-slate-300 px-2 py-1 text-sm hover:bg-slate-100 disabled:opacity-50"
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
            setVarsWide(false); // 상호배타
            setDetailOpen(false); // 와이드 전환(양방향) 시 모달 상태 초기화 (R8 ③)
          }}
          className="rounded border border-slate-300 px-2 py-1 text-sm hover:bg-slate-100"
        >
          <span aria-hidden="true">⛶</span> {ko.editor.wideToggle}
        </button>
        <button
          type="button"
          aria-label={ko.editor.varsWideToggleAria}
          aria-pressed={varsWide}
          onClick={() => {
            setVarsWide((v) => !v);
            setWideOpen(false); // 상호배타
            setDetailOpen(false);
          }}
          className="rounded border border-slate-300 px-2 py-1 text-sm hover:bg-slate-100"
        >
          <span aria-hidden="true">◧</span> {ko.editor.varsWideToggle}
        </button>
        <button
          type="button"
          aria-label={ko.editor.thinkBoardOpenAria}
          onClick={() => setThinkBoardOpen(true)}
          className="rounded border border-slate-300 px-2 py-1 text-sm hover:bg-slate-100"
        >
          <span aria-hidden="true">⏱</span> {ko.editor.thinkBoardOpen}
        </button>
        {showTrustChip && (
          <button
            type="button"
            aria-label={trustChipName}
            /* D10: 모달을 안 여는 마우스 사용자에게도 같은 문장이 닿아야 한다(spec §7.1). */
            title={trustChipName}
            onClick={() => setTrustOpen(true)}
            className="rounded border border-slate-300 px-2 py-1 text-sm hover:bg-slate-100"
          >
            <span aria-hidden="true">◈</span> {trustGradeLead}
            <span className={trustGradeClass}>{trustGrade}</span>
            {trustSuffix}
          </button>
        )}
      </div>
      <div
        data-testid="editor-grid"
        className={
          varsWide
            ? `grid gap-4 min-h-[520px] ${capClass} grid-rows-[minmax(0,1fr)] grid-cols-[1fr_minmax(260px,300px)]`
            : wideOpen
              ? `grid gap-4 ${varsOpen ? "grid-cols-[210px_1fr]" : "grid-cols-[1fr]"}`
              : `grid gap-4 min-h-[520px] ${capClass} grid-rows-[minmax(0,1fr)] ${varsOpen ? "grid-cols-[210px_minmax(260px,300px)_1fr]" : "grid-cols-[minmax(260px,300px)_1fr]"}`
        }
      >
        {(varsWide || varsOpen) && (
          <aside
            role="complementary"
            aria-label={ko.editor.varsPanelAria}
            className={`flex min-h-0 flex-col gap-3 overflow-visible rounded-md border border-slate-200 bg-white p-3 ${wideOpen ? capClass : ""}`}
          >
            <VariablesPanel onJumpToStep={jumpToStep} />
            <ScenarioDefaults />
          </aside>
        )}
        {varsWide ? (
          <div className="rounded-md border border-slate-200 bg-white p-3 overflow-auto min-h-0">
            <FlowOutline onActivateStep={() => setDetailOpen(true)} />
          </div>
        ) : wideOpen ? (
          <div
            className={`flex ${capClass} min-h-0 flex-col gap-2 rounded-md border border-slate-200 bg-white p-3`}
          >
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
        open={(wideOpen || varsWide) && detailOpen && selectedStepId !== null}
        onClose={closeDetail}
        title={ko.editor.stepDetailModalTitle}
      >
        <Inspector />
      </Modal>
      <ThinkTimeBoard open={thinkBoardOpen} onClose={() => setThinkBoardOpen(false)} />
      <TrustBoard
        open={trustOpen}
        onClose={() => setTrustOpen(false)}
        report={trustReport}
        testRun={trustTestRun}
        onSelectStep={(sid) => {
          // US2 "그 스텝으로 바로 이동" — select만 하면 긴 시나리오에서 선택 행이 화면 밖일 수
          // 있고(형제 점프 사이트들이 jumpToStep을 쓰는 이유), 와이드 레이아웃에서는
          // Inspector가 detailOpen 모달 뒤에만 있어 클릭이 아무 일도 안 한 것처럼 보인다.
          // 게이트는 모달 자신의 게이트(`(wideOpen || varsWide) && detailOpen`)를 미러한다.
          jumpToStep(sid);
          if (wideOpen || varsWide) setDetailOpen(true);
        }}
        onOpenVars={() => setVarsOpen(true)}
      />
    </div>
  );
}
