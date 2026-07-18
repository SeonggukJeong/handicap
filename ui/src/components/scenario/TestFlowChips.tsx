import { Fragment, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ScenarioTrace } from "../../api/schemas";
import { isIfStep, isLoopStep, isParallelStep, type Step } from "../../scenario/model";
import { branchText, deriveChipResults, type ChipResult } from "../../scenario/chipResults";
import { METHOD_BADGE } from "./methodBadge";
import { ko } from "../../i18n/ko";

// 결과 상태별 칩 표면 — 데이터-식별 도메인(accent 토큰 금지, TestRunPanel emerald/red 계열 통일).
// border는 선택 링과 충돌하므로 표면과 분리: 선택 시 결과 border를 SELECTED_RING으로 *교체*
// (같은 요소에 border-* 2개를 겹치면 Tailwind 스타일시트 순서에 좌우된다 — spec §4.2).
type ChipState = "plain" | "pass" | "fail" | "notRun";
const CHIP_BORDER: Record<ChipState, string> = {
  plain: "border-slate-300",
  pass: "border-emerald-300",
  fail: "border-red-300",
  notRun: "border-slate-200",
};
const CHIP_SURFACE: Record<ChipState, string> = {
  plain: "bg-white text-slate-800",
  pass: "bg-emerald-50 text-emerald-900",
  fail: "bg-red-50 text-red-900",
  notRun: "bg-slate-50 text-slate-400",
};
const CHIP_ICON: Record<Exclude<ChipState, "plain">, string> = {
  pass: "✓",
  fail: "✗",
  notRun: "○",
};
// 선택 링(클릭 대상 = 링 대상) — FlowOutline 행과 동일 규약(spec R6).
const SELECTED_RING = "border-accent-500 ring-1 ring-accent-500";

function chipAria(name: string, state: ChipState): string {
  if (state === "pass") return ko.editor.chipAriaPass(name);
  if (state === "fail") return ko.editor.chipAriaFail(name);
  if (state === "notRun") return ko.editor.chipAriaNotRun(name);
  return name;
}

interface NodeProps {
  step: Step;
  results: Map<string, ChipResult> | null;
  selectedStepId: string | null;
  onSelect: (id: string) => void;
}

// 분기 밴드(구조 키 = 엔진 select_branch와 1:1 — then/elif_{i}(0-based)/else).
// taken: true=타짐(violet 강조+→), false=안 타짐(run 후 dimmed), null=중립(loop 본문·parallel 분기).
function containerBands(step: Step): { key: string; label: string | null; children: Step[] }[] {
  if (isLoopStep(step)) return [{ key: "do", label: null, children: step.do }];
  if (isIfStep(step)) {
    return [
      { key: "then", label: branchText("then"), children: step.then },
      ...step.elif.map((e, i) => ({
        key: `elif_${i}`,
        label: branchText(`elif_${i}`),
        children: e.then,
      })),
      ...(step.else.length > 0
        ? [{ key: "else", label: branchText("else"), children: step.else }]
        : []),
    ];
  }
  if (isParallelStep(step)) {
    return step.branches.map((b) => ({ key: b.name, label: b.name, children: b.steps }));
  }
  return [];
}

function ChipNode({ step, results, selectedStepId, onSelect }: NodeProps) {
  const selected = step.id === selectedStepId;

  if (isLoopStep(step) || isIfStep(step) || isParallelStep(step)) {
    const r = results?.get(step.id);
    const taken = r?.kind === "if" ? r.branches : [];
    const hasIfResult = r?.kind === "if";
    const glyph = isLoopStep(step) ? "⟳" : isIfStep(step) ? "⎇" : "⇉";
    return (
      <span
        data-group={step.id}
        className="inline-flex flex-wrap items-center gap-1 rounded border border-slate-200 bg-slate-50 px-1.5 py-1"
      >
        <button
          type="button"
          onClick={() => onSelect(step.id)}
          className={`inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-semibold text-slate-600 ${selected ? SELECTED_RING : "border-transparent"}`}
        >
          <span aria-hidden="true">{glyph}</span>
          <span className="max-w-[8rem] truncate" title={step.name}>
            {step.name}
          </span>
          {isLoopStep(step) && <span className="shrink-0">× {step.repeat}</span>}
          {taken.includes("none") && (
            <span className="shrink-0 text-violet-700">{branchText("none")}</span>
          )}
        </button>
        {containerBands(step).map((b) => {
          const isTaken = hasIfResult && taken.includes(b.key);
          const isDimmed = hasIfResult && !taken.includes(b.key) && isIfStep(step);
          return (
            <Fragment key={b.key}>
              {b.label != null && (
                <span
                  className={`shrink-0 text-[11px] font-semibold ${
                    isTaken ? "text-violet-700" : isDimmed ? "text-slate-300" : "text-slate-400"
                  }`}
                >
                  {isTaken ? "→" : ""}
                  {b.label}:
                </span>
              )}
              {b.children.map((c) => (
                <ChipNode
                  key={c.id}
                  step={c}
                  results={results}
                  selectedStepId={selectedStepId}
                  onSelect={onSelect}
                />
              ))}
            </Fragment>
          );
        })}
      </span>
    );
  }

  // http leaf
  const r = results?.get(step.id);
  const state: ChipState =
    results == null
      ? "plain"
      : r?.kind === "http"
        ? r.result === "fail"
          ? "fail"
          : "pass"
        : "notRun";
  return (
    <button
      type="button"
      aria-label={chipAria(step.name, state)}
      onClick={() => onSelect(step.id)}
      className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-xs ${selected ? SELECTED_RING : CHIP_BORDER[state]} ${CHIP_SURFACE[state]}`}
    >
      <span
        className={`shrink-0 rounded px-1 text-[10px] font-bold ${METHOD_BADGE[step.request.method] ?? "bg-slate-100 text-slate-600"}`}
      >
        {step.request.method}
      </span>
      <span className="max-w-[10rem] truncate" title={step.name}>
        {step.name}
      </span>
      {state !== "plain" && <span aria-hidden="true">{CHIP_ICON[state]}</span>}
    </button>
  );
}

/** 시나리오 흐름을 가로 flex-wrap 그룹 칩으로 미러하는 상시 스트립(spec R1/R2).
 *  run 전 = 플레인 미러, run 후 = deriveChipResults로 스텝별 ✓/✗/○(spec R4/R5).
 *  칩 클릭 = onSelect(stepId) — 부모가 store select로 배선(spec R6).
 *  칩 wrap은 기본 max-h-24 캡+내부 스크롤 — 긴 시나리오가 wide 아웃라인/결과 패널을
 *  잠식하지 않게(editor-wide-view-overflow R1). expandable(TestRunSection만)이면
 *  overflow 실측 시 "전체 펼치기/접기" 토글(R2). */
const WRAP_BASE = "flex flex-wrap items-center gap-1.5";

export function TestFlowChips({
  steps,
  trace,
  selectedStepId,
  onSelect,
  expandable = false,
}: {
  steps: ReadonlyArray<Step>;
  trace: ScenarioTrace | null;
  selectedStepId: string | null;
  onSelect: (id: string) => void;
  /** true(TestRunSection)면 overflow 시 펼치기 토글 — EditorShell(wide)은 미전달=하드 캡(펼치면 가림 복귀). */
  expandable?: boolean;
}) {
  const results = useMemo(() => (trace ? deriveChipResults(trace) : null), [trace]);
  // 훅은 전부 steps-empty early return 앞에 (rules-of-hooks).
  const wrapId = useId();
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);

  // overflow 불리언의 모든 전이는 캡 경계(96px)를 지나며 wrap 박스 높이가 변하므로
  // 재측정은 RO 전담으로 충분(캡에 눌린 96px→96px 내부 증감은 상태도 불변이라 무발화 무해).
  // deps에 steps/trace를 넣으면 effect 본문 미참조로 exhaustive-deps 경고(--max-warnings=0).
  // 알려진 한계(수용, spec §7): steps 0→>0로 wrap이 재마운트되면 새 div를 재관측하지
  // 않아 overflowing이 stale할 수 있음(토글 가시성만 영향·리마운트로 회복).
  useLayoutEffect(() => {
    if (!expandable) return;
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setOverflowing(el.scrollHeight > el.clientHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [expandable]);

  if (steps.length === 0) return null;
  return (
    <div role="group" aria-label={ko.editor.testFlowTitle} className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-slate-500">{ko.editor.testFlowTitle}</span>
        {expandable && (overflowing || expanded) && (
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={wrapId}
            onClick={() => setExpanded((v) => !v)}
            className="rounded border border-slate-200 px-1.5 py-0.5 text-[11px] text-slate-500 hover:bg-slate-100"
          >
            {expanded ? ko.editor.chipStripCollapse : ko.editor.chipStripExpand}
          </button>
        )}
      </div>
      <div
        id={wrapId}
        ref={wrapRef}
        data-testid="chip-strip-wrap"
        className={expanded ? WRAP_BASE : `${WRAP_BASE} max-h-24 overflow-y-auto`}
      >
        {steps.map((s, i) => (
          <Fragment key={s.id}>
            {i > 0 && (
              <span aria-hidden="true" className="text-slate-300">
                →
              </span>
            )}
            <ChipNode
              step={s}
              results={results}
              selectedStepId={selectedStepId}
              onSelect={onSelect}
            />
          </Fragment>
        ))}
      </div>
    </div>
  );
}
