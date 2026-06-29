import { useCallback, useMemo, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  closestCenter,
  MeasuringStrategy,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  sortableKeyboardCoordinates,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useScenarioEditor } from "../../scenario/store";
import { ko } from "../../i18n/ko";
import {
  isLoopStep,
  isIfStep,
  isParallelStep,
  summarizeCondition,
  findStepById,
  findStepSiblings,
  type Step,
} from "../../scenario/model";
import { resolveDragEnd } from "../../scenario/reorder";

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

// 한 행 헤더의 "드래그 핸들 이후" 내용. 대화형 OutlineRow와 오버레이용
// OutlineRowPreview가 공유 — 시각 드리프트 방지(spec §3.3).
function RowContent({ step }: { step: Step }) {
  if (isLoopStep(step)) {
    return (
      <>
        <ContainerTag glyph="⟳" label={ko.editor.containerLoop} />
        <span className="min-w-0 truncate font-medium" title={step.name}>
          {step.name}
        </span>
        <span className="shrink-0 text-xs text-slate-500">× {step.repeat}</span>
      </>
    );
  }
  if (isIfStep(step)) {
    return (
      <>
        <ContainerTag glyph="⎇" label={ko.editor.containerIf} />
        <span className="min-w-0 truncate font-medium" title={step.name}>
          {step.name}
        </span>
        <span className="shrink-0 text-xs text-slate-500">{summarizeCondition(step.cond)}</span>
      </>
    );
  }
  if (isParallelStep(step)) {
    return (
      <>
        <ContainerTag glyph="⇉" label={ko.editor.containerParallel} />
        <span className="min-w-0 truncate font-medium" title={step.name}>
          {step.name}
        </span>
      </>
    );
  }
  // http leaf
  const urlMissing = step.request.url.trim() === "";
  return (
    <>
      <span
        className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-bold ${METHOD_BADGE[step.request.method] ?? "bg-slate-100 text-slate-600"}`}
      >
        {step.request.method}
      </span>
      <div className="flex min-w-0 flex-col">
        <span className="truncate font-medium" title={step.name}>
          {step.name}
        </span>
        <span className="truncate text-xs text-slate-500" title={step.request.url}>
          {step.request.url}
        </span>
      </div>
      {urlMissing && (
        <span
          role="img"
          aria-label={ko.editor.urlMissingTitle}
          title={ko.editor.urlMissingTitle}
          className="shrink-0 text-amber-500"
        >
          ⚠
        </span>
      )}
    </>
  );
}

// 컨테이너 자식 밴드 스캐폴딩(들여쓰기·border-l-2·밴드 라벨). 자식 렌더 방식만
// renderGroup으로 주입 — 대화형(SortableContext+OutlineRow) vs 프리뷰(OutlineRowPreview).
function ContainerBands({
  step,
  depth,
  renderGroup,
}: {
  step: Step;
  depth: number;
  renderGroup: (children: Step[], childDepth: number) => React.ReactNode;
}) {
  if (isLoopStep(step)) {
    return (
      <div className="mt-1 flex flex-col gap-1 border-l-2 border-slate-200">
        {renderGroup(step.do, depth + 1)}
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
      <>
        {bands.map((b) => (
          <div key={b.label} className="mt-1 border-l-2 border-slate-200">
            <div
              className="px-2 text-[11px] font-semibold text-slate-400"
              style={{ marginLeft: `${(depth + 1) * 16}px` }}
            >
              {b.label}
            </div>
            <div className="flex flex-col gap-1">{renderGroup(b.children, depth + 1)}</div>
          </div>
        ))}
      </>
    );
  }
  if (isParallelStep(step)) {
    return (
      <>
        {step.branches.map((b) => (
          <div key={b.name} className="mt-1 border-l-2 border-slate-200">
            <div
              className="px-2 text-[11px] font-semibold text-slate-400"
              style={{ marginLeft: `${(depth + 1) * 16}px` }}
            >
              {b.name}
            </div>
            <div className="flex flex-col gap-1">{renderGroup(b.steps, depth + 1)}</div>
          </div>
        ))}
      </>
    );
  }
  return null;
}

// loop `do` / if 밴드(then·elif[].then·else) / parallel 레인을 라벨 붙은
// 들여쓴 그룹으로 렌더하는 재귀 함수. depth는 data-depth로 노출(테스트 결정성).
function OutlineRow({ step, depth }: { step: Step; depth: number }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, isDragging } =
    useSortable({
      id: step.id,
    });
  const selectedStepId = useScenarioEditor((s) => s.selectedStepId);
  const select = useScenarioEditor((s) => s.select);
  const selected = step.id === selectedStepId;
  const accent = selected ? "border-accent-500 ring-1 ring-accent-500" : "border-slate-200";

  // 드래그 중 소스는 *숨김만*(opacity-0, DOM 제거 금지 — dnd-kit 측정 필요).
  // 외곽 요소에 적용: 컨테이너는 wrapper(헤더+밴드), leaf는 행 div 자체(spec F1).
  const hidden = isDragging ? "opacity-0" : "";

  const rowStyle: React.CSSProperties = {
    marginLeft: `${depth * 16}px`,
    transform: isDragging ? undefined : CSS.Transform.toString(transform),
  };
  const rowClassBase = `flex gap-2 rounded-md border bg-white px-2 py-1.5 text-sm cursor-pointer ${accent}`;
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
    style: rowStyle,
  };
  const dragHandle = (
    <button
      type="button"
      ref={setActivatorNodeRef}
      {...attributes}
      {...listeners}
      aria-label={ko.editor.dragHandleAria(step.name)}
      className="shrink-0 cursor-grab text-slate-400 hover:text-slate-600"
    >
      ⠿
    </button>
  );
  const headerRow = (extra: string) => (
    <div ref={setNodeRef} {...rowProps} className={`${rowClassBase} items-center ${extra}`}>
      {dragHandle}
      <RowContent step={step} />
    </div>
  );

  if (isLoopStep(step) || isIfStep(step) || isParallelStep(step)) {
    return (
      <div className={hidden}>
        {headerRow("")}
        <ContainerBands
          step={step}
          depth={depth}
          renderGroup={(children, childDepth) => (
            <SortableContext
              items={children.map((c) => c.id)}
              strategy={verticalListSortingStrategy}
            >
              {children.map((c) => (
                <OutlineRow key={c.id} step={c} depth={childDepth} />
              ))}
            </SortableContext>
          )}
        />
      </div>
    );
  }
  // http leaf — 단일 행 div 자체가 최외곽이라 hide를 직접 합친다
  return headerRow(hidden);
}

// DragOverlay 안에 띄우는 비대화형 재귀 프리뷰. useSortable/SortableContext/onClick
// 없음(이중 등록·중복 핸들 방지), store 미접촉, 선택 accent 미표시(F3), aria-hidden 장식.
export function OutlineRowPreview({ step, depth }: { step: Step; depth: number }) {
  const rowStyle: React.CSSProperties = { marginLeft: `${depth * 16}px` };
  // 항상 중립 border-slate-200 — 선택 여부와 무관(store 미접촉).
  const rowClass =
    "flex items-center gap-2 rounded-md border border-slate-200 bg-white px-2 py-1.5 text-sm shadow-lg";
  const staticHandle = (
    <span className="shrink-0 cursor-grab text-slate-400" aria-hidden="true">
      ⠿
    </span>
  );
  const headerRow = (
    <div style={rowStyle} className={rowClass}>
      {staticHandle}
      <RowContent step={step} />
    </div>
  );
  if (isLoopStep(step) || isIfStep(step) || isParallelStep(step)) {
    return (
      <div aria-hidden="true">
        {headerRow}
        <ContainerBands
          step={step}
          depth={depth}
          renderGroup={(children, childDepth) =>
            children.map((c) => <OutlineRowPreview key={c.id} step={c} depth={childDepth} />)
          }
        />
      </div>
    );
  }
  return <div aria-hidden="true">{headerRow}</div>;
}

function ContainerTag({ glyph, label }: { glyph: string; label: string }) {
  // glyph는 장식(aria-hidden), 라벨 텍스트만 ko 경유(ADR-0035).
  return (
    <span className="shrink-0 rounded px-1.5 py-0.5 text-[11px] font-semibold text-slate-600">
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
  const moveStep = useScenarioEditor((s) => s.moveStep);

  const [activeId, setActiveId] = useState<string | null>(null);
  const activeStep = activeId ? findStepById(steps, activeId) : null;

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // 그룹-스코프 충돌(spec §3.1): over 후보를 active의 형제 그룹으로만 좁혀
  // over가 중첩 컨테이너 자식이 되지 않게 → 교차-컨텍스트 취소·dead-zone 제거.
  // resolveDragEnd의 그룹내-전용 의미론과 정확히 일치(re-parenting 없음).
  const collisionDetection = useCallback<CollisionDetection>(
    (args) => {
      const dragId = args.active.id as string;
      const siblingIds = new Set(findStepSiblings(steps, dragId).map((s) => s.id));
      const candidates = args.droppableContainers.filter((c) => siblingIds.has(c.id as string));
      return closestCenter({ ...args, droppableContainers: candidates });
    },
    [steps],
  );

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(event.active.id as string);
  };
  const handleDragEnd = (event: DragEndEvent) => {
    setActiveId(null);
    const { active, over } = event;
    const activeId = active.id as string;
    const overId = (over?.id ?? null) as string | null;
    const result = resolveDragEnd(steps, activeId, overId);
    if (result) {
      moveStep(result.stepId, result.toIndex);
    }
  };
  const handleDragCancel = () => setActiveId(null);

  const selectedLoopId = useMemo(() => {
    const sel = steps.find((s) => s.id === selectedStepId);
    return sel && isLoopStep(sel) ? sel.id : null;
  }, [steps, selectedStepId]);

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <div className="flex h-full flex-col">
        <div
          data-testid="outline-blank"
          className="flex-1 overflow-auto"
          onClick={(e) => {
            if (e.target === e.currentTarget) select(null);
          }}
        >
          <div className="flex flex-col gap-1">
            <SortableContext items={steps.map((s) => s.id)} strategy={verticalListSortingStrategy}>
              {steps.map((s) => (
                <OutlineRow key={s.id} step={s} depth={0} />
              ))}
            </SortableContext>
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
      <DragOverlay>
        {activeStep ? <OutlineRowPreview step={activeStep} depth={0} /> : null}
      </DragOverlay>
    </DndContext>
  );
}
