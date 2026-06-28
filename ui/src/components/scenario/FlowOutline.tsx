import { useMemo } from "react";
import { useScenarioEditor } from "../../scenario/store";
import { ko } from "../../i18n/ko";
import {
  isLoopStep,
  isIfStep,
  isParallelStep,
  summarizeCondition,
  type Step,
} from "../../scenario/model";

// 데이터-식별 팔레트(메서드별) — accent 토큰과 별개 도메인(ui/CLAUDE.md 디자인시스템 노트).
const METHOD_BADGE: Record<string, string> = {
  GET: "bg-emerald-100 text-emerald-700",
  POST: "bg-blue-100 text-blue-700",
  PUT: "bg-amber-100 text-amber-700",
  PATCH: "bg-violet-100 text-violet-700",
  DELETE: "bg-red-100 text-red-700",
  HEAD: "bg-slate-100 text-slate-600",
  OPTIONS: "bg-slate-100 text-slate-600",
};

// 셀렉터 fallback은 모듈 스코프 안정 상수(M3 — 인라인 `?? []` 금지).
const EMPTY_STEPS: Step[] = [];

// loop `do` / if 밴드(then·elif[].then·else) / parallel 레인을 라벨 붙은
// 들여쓴 그룹으로 렌더하는 재귀 함수. depth는 data-depth로 노출(테스트 결정성).
function OutlineRow({ step, depth }: { step: Step; depth: number }) {
  const selectedStepId = useScenarioEditor((s) => s.selectedStepId);
  const select = useScenarioEditor((s) => s.select);
  const selected = step.id === selectedStepId;
  const accent = selected ? "border-accent-500 ring-1 ring-accent-500" : "border-slate-200";

  // 행 컨테이너는 role="option" + tabIndex (button-in-button 회피 — 드래그 핸들이 Task 5에서 별도 button).
  const rowProps = {
    role: "option" as const,
    "aria-selected": selected,
    "aria-label": ko.editor.outlineRowAria(step.name),
    tabIndex: 0,
    "data-depth": String(depth),
    onClick: () => select(step.id),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        select(step.id);
      }
    },
    style: { marginLeft: `${depth * 16}px` },
    className: `flex items-center gap-2 rounded-md border bg-white px-2 py-1.5 text-sm cursor-pointer ${accent}`,
  };

  if (isLoopStep(step)) {
    return (
      <div>
        <div {...rowProps}>
          <ContainerTag glyph="⟳" label={ko.editor.containerLoop} />
          <span className="font-medium">{step.name}</span>
          <span className="text-xs text-slate-500">× {step.repeat}</span>
        </div>
        <div className="mt-1 flex flex-col gap-1 border-l-2 border-slate-200">
          {step.do.map((c) => (
            <OutlineRow key={c.id} step={c} depth={depth + 1} />
          ))}
        </div>
      </div>
    );
  }
  if (isIfStep(step)) {
    const bands: Array<{ label: string; children: Step[] }> = [
      { label: "THEN", children: step.then },
      ...step.elif.map((e, i) => ({ label: `ELIF ${i + 1}`, children: e.then })),
      ...(step.else.length > 0 ? [{ label: "ELSE", children: step.else }] : []),
    ];
    return (
      <div>
        <div {...rowProps}>
          <ContainerTag glyph="⎇" label={ko.editor.containerIf} />
          <span className="font-medium">{step.name}</span>
          <span className="text-xs text-slate-500">{summarizeCondition(step.cond)}</span>
        </div>
        {bands.map((b) => (
          <div key={b.label} className="mt-1 border-l-2 border-slate-200">
            <div
              className="px-2 text-[11px] font-semibold text-slate-400"
              style={{ marginLeft: `${(depth + 1) * 16}px` }}
            >
              {b.label}
            </div>
            <div className="flex flex-col gap-1">
              {b.children.map((c) => (
                <OutlineRow key={c.id} step={c} depth={depth + 1} />
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  }
  if (isParallelStep(step)) {
    return (
      <div>
        <div {...rowProps}>
          <ContainerTag glyph="⇉" label={ko.editor.containerParallel} />
          <span className="font-medium">{step.name}</span>
        </div>
        {step.branches.map((b) => (
          <div key={b.name} className="mt-1 border-l-2 border-slate-200">
            <div
              className="px-2 text-[11px] font-semibold text-slate-400"
              style={{ marginLeft: `${(depth + 1) * 16}px` }}
            >
              {b.name}
            </div>
            <div className="flex flex-col gap-1">
              {b.steps.map((c) => (
                <OutlineRow key={c.id} step={c} depth={depth + 1} />
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  }
  // http leaf
  const urlMissing = step.request.url.trim() === "";
  return (
    <div {...rowProps}>
      <span
        className={`rounded px-1.5 py-0.5 text-[11px] font-bold ${METHOD_BADGE[step.request.method] ?? "bg-slate-100 text-slate-600"}`}
      >
        {step.request.method}
      </span>
      <span className="font-medium">{step.name}</span>
      <span className="truncate text-xs text-slate-500" title={step.request.url}>
        {step.request.url}
      </span>
      {urlMissing && (
        <span title={ko.editor.urlMissingTitle} className="text-amber-500">
          ⚠
        </span>
      )}
    </div>
  );
}

function ContainerTag({ glyph, label }: { glyph: string; label: string }) {
  // glyph는 장식(aria-hidden), 라벨 텍스트만 ko 경유(ADR-0035).
  return (
    <span className="rounded px-1.5 py-0.5 text-[11px] font-semibold text-slate-600">
      <span aria-hidden="true">{glyph}</span> {label}
    </span>
  );
}

export function FlowOutline() {
  const steps = useScenarioEditor((s) => s.model?.steps ?? EMPTY_STEPS);
  const selectedStepId = useScenarioEditor((s) => s.selectedStepId);
  const select = useScenarioEditor((s) => s.select);
  const addStep = useScenarioEditor((s) => s.addStep);
  const addLoopStep = useScenarioEditor((s) => s.addLoopStep);
  const addStepInLoop = useScenarioEditor((s) => s.addStepInLoop);
  const addIfStep = useScenarioEditor((s) => s.addIfStep);
  const addParallelStep = useScenarioEditor((s) => s.addParallelStep);

  const selectedLoopId = useMemo(() => {
    const sel = steps.find((s) => s.id === selectedStepId);
    return sel && isLoopStep(sel) ? sel.id : null;
  }, [steps, selectedStepId]);

  return (
    <div className="flex h-full flex-col">
      <div
        data-testid="outline-blank"
        className="flex-1 overflow-auto"
        onClick={(e) => {
          if (e.target === e.currentTarget) select(null);
        }}
      >
        <div className="flex flex-col gap-1">
          {steps.map((s) => (
            <OutlineRow key={s.id} step={s} depth={0} />
          ))}
        </div>
        {steps.length === 0 && (
          <p className="mt-2 text-xs text-slate-500">{ko.editor.canvasEmpty}</p>
        )}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          className="rounded border border-slate-400 px-3 py-1.5 text-sm font-medium text-slate-900 hover:bg-slate-100"
          onClick={() => {
            const id = selectedLoopId
              ? addStepInLoop(selectedLoopId, `Step ${steps.length + 1}`)
              : addStep(`Step ${steps.length + 1}`);
            select(id);
          }}
        >
          {selectedLoopId ? ko.editor.addHttpStepInLoop : ko.editor.addHttpStep}
        </button>
        <button
          type="button"
          className="rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-500 hover:bg-slate-100"
          onClick={() => select(addLoopStep(`Loop ${steps.length + 1}`))}
        >
          {ko.editor.addLoop}
        </button>
        <button
          type="button"
          className="rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-500 hover:bg-slate-100"
          onClick={() => select(addIfStep(`If ${steps.length + 1}`))}
        >
          {ko.editor.addIf}
        </button>
        <button
          type="button"
          className="rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-500 hover:bg-slate-100"
          onClick={() => select(addParallelStep(`Parallel ${steps.length + 1}`))}
        >
          {ko.editor.addParallel}
        </button>
      </div>
      <p className="mt-1 text-xs text-slate-400">{ko.editor.containerCaption}</p>
    </div>
  );
}
