import { useCallback, useMemo, useRef, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  closestCenter,
  MeasuringStrategy,
  useSensor,
  useSensors,
  useDroppable,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
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
  type Step,
} from "../../scenario/model";
import { resolveDrop } from "../../scenario/reorder";
import {
  bandIndex,
  bandKey,
  filterDropCandidates,
  findParentBand,
  keyboardCandidateIds,
  legalTargetBands,
  TOP_BAND,
  type BandRef,
} from "../../scenario/dropRules";
import { METHOD_BADGE } from "./methodBadge";

// 셀렉터 fallback은 모듈 스코프 안정 상수(M3 — 인라인 `?? []` 금지).
const EMPTY_STEPS: Step[] = [];

// 드래그 중 시각/판정 컨텍스트 — 행 트리에 prop으로 흘린다(store 미접촉).
interface DragCtx {
  activeId: string | null;
  legal: ReadonlySet<string> | null;
  over: { id: string; half: "above" | "below" } | null;
  overBandKey: string | null;
  activeBandKey: string | null;
}
const IDLE_DRAG: DragCtx = {
  activeId: null,
  legal: null,
  over: null,
  overBandKey: null,
  activeBandKey: null,
};

// 빈 else 밴드의 드롭 타깃(spec R4③ — else만 빈-가능 밴드). 드래그 중·합법일 때만 렌더.
function EmptyBandDrop({ parentId, band }: { parentId: string; band: string }) {
  const { setNodeRef, isOver } = useDroppable({
    id: `band:${parentId}:${band}`,
    data: { parentId, band, index: 0 },
  });
  return (
    <div
      ref={setNodeRef}
      className={`mx-2 my-1 rounded border border-dashed px-2 py-1 text-xs ${
        isOver
          ? "border-accent-500 bg-accent-50 text-accent-700"
          : "border-slate-300 text-slate-400"
      }`}
    >
      {ko.editor.emptyBandDropHint}
    </div>
  );
}

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
  includeEmptyElse = false,
}: {
  step: Step;
  depth: number;
  renderGroup: (
    children: Step[],
    childDepth: number,
    band: { parentId: string; band: string },
  ) => React.ReactNode;
  includeEmptyElse?: boolean;
}) {
  if (isLoopStep(step)) {
    return (
      <div className="mt-1 flex flex-col gap-1 border-l-2 border-slate-200">
        {renderGroup(step.do, depth + 1, { parentId: step.id, band: "do" })}
      </div>
    );
  }
  if (isIfStep(step)) {
    const bands: Array<{ label: string; key: string; children: Step[] }> = [
      { label: "THEN", key: "then", children: step.then },
      ...step.elif.map((e, i) => ({ label: `ELIF ${i + 1}`, key: `elif_${i}`, children: e.then })),
      ...(step.else.length > 0 || includeEmptyElse
        ? [{ label: "ELSE", key: "else", children: step.else }]
        : []),
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
            <div className="flex flex-col gap-1">
              {renderGroup(b.children, depth + 1, { parentId: step.id, band: b.key })}
            </div>
          </div>
        ))}
      </>
    );
  }
  if (isParallelStep(step)) {
    return (
      <>
        {step.branches.map((b, i) => (
          <div key={b.name} className="mt-1 border-l-2 border-slate-200">
            <div
              className="px-2 text-[11px] font-semibold text-slate-400"
              style={{ marginLeft: `${(depth + 1) * 16}px` }}
            >
              {b.name}
            </div>
            <div className="flex flex-col gap-1">
              {renderGroup(b.steps, depth + 1, { parentId: step.id, band: `branch_${i}` })}
            </div>
          </div>
        ))}
      </>
    );
  }
  return null;
}

// loop `do` / if 밴드(then·elif[].then·else) / parallel 레인을 라벨 붙은
// 들여쓴 그룹으로 렌더하는 재귀 함수. depth는 data-depth로 노출(테스트 결정성).
function OutlineRow({
  step,
  depth,
  band = TOP_BAND,
  index = 0,
  drag = IDLE_DRAG,
}: {
  step: Step;
  depth: number;
  band?: BandRef;
  index?: number;
  drag?: DragCtx;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, isDragging } =
    useSortable({
      id: step.id,
      data: { parentId: band.parentId, band: band.band, index },
    });
  const selectedStepId = useScenarioEditor((s) => s.selectedStepId);
  const select = useScenarioEditor((s) => s.select);
  const selected = step.id === selectedStepId;
  const accent = selected ? "border-accent-500 ring-1 ring-accent-500" : "border-slate-200";

  // 드래그 중 소스는 *숨김만*(opacity-0, DOM 제거 금지 — dnd-kit 측정 필요).
  // 외곽 요소에 적용: 컨테이너는 wrapper(헤더+밴드), leaf는 행 div 자체(spec F1).
  const hidden = isDragging ? "opacity-0" : "";
  // 드래그 transform 은 sortable *노드*에 건다(드래그 중 소스는 오버레이가 시각
  // 담당이라 0화). leaf=행 div 자체가 노드, 컨테이너=헤더+밴드 감싼 외곽 wrapper
  // 가 노드 → 재정렬 프리뷰 때 컨테이너 전체(헤더+자식)가 한 덩어리로 이동한다.
  // (헤더 div 에만 걸면 형제 자식 밴드가 안 밀려 드롭존이 어긋나 보인다.)
  const nodeTransform = isDragging ? undefined : CSS.Transform.toString(transform);

  const rowClassBase = `flex gap-2 rounded-md border bg-white px-2 py-1.5 text-sm cursor-pointer ${accent}`;
  // 헤더 행의 role/선택/키보드 속성(transform 제외 — transform 은 sortable 노드로).
  const rowAria = {
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

  // 삽입 예정 위치 인디케이터(spec R5): over 행의 above/below에 accent 라인.
  // 컨테이너는 sortable 노드=외곽 wrapper라 border-b가 "컨테이너 뒤" 시맨틱과 일치(R4①).
  // same-band(재정렬)는 N1 핀에 따라 half 무시하고 verbatim 착지 — 인디케이터가
  // half를 그리면 실제 착지와 모순될 수 있어 *교차-밴드일 때만* 렌더(최종리뷰 F1).
  // sortable shift 애니메이션이 same-band 재정렬의 신호를 이미 담당한다.
  const overHere = drag.over?.id === step.id && drag.overBandKey !== drag.activeBandKey;
  const indicator = overHere
    ? drag.over!.half === "above"
      ? "border-t-2 border-t-accent-500"
      : "border-b-2 border-b-accent-500"
    : "";

  if (isLoopStep(step) || isIfStep(step) || isParallelStep(step)) {
    const includeEmptyElse =
      isIfStep(step) &&
      drag.activeId !== null &&
      (drag.legal?.has(`${step.id}:else`) ?? false) &&
      step.else.length === 0;
    return (
      <div
        ref={setNodeRef}
        style={{ transform: nodeTransform }}
        className={`${hidden} ${indicator}`}
      >
        <div
          {...rowAria}
          style={{ marginLeft: `${depth * 16}px` }}
          className={`${rowClassBase} items-center`}
        >
          {dragHandle}
          <RowContent step={step} />
        </div>
        <ContainerBands
          step={step}
          depth={depth}
          includeEmptyElse={includeEmptyElse}
          renderGroup={(children, childDepth, childBand) => {
            const key = bandKey({ parentId: childBand.parentId, band: childBand.band });
            // 자기-밴드(소스) 하이라이트는 신규 시각 요소 — 교차-밴드일 때만(최종리뷰 F1).
            const isOverBand = drag.overBandKey === key && key !== drag.activeBandKey;
            const legalHere = drag.legal?.has(key) ?? false;
            return (
              // P2: 이 wrapper는 밴드 컨테이너(flex flex-col gap-1)와 행 사이에 끼므로
              // 자신이 flex flex-col gap-1을 실어야 행 간 4px gap이 보존된다(상시 렌더).
              <div className={`flex flex-col gap-1${isOverBand ? " rounded bg-accent-50/60" : ""}`}>
                <SortableContext
                  items={children.map((c) => c.id)}
                  strategy={verticalListSortingStrategy}
                >
                  {children.map((c, i) => (
                    <OutlineRow
                      key={c.id}
                      step={c}
                      depth={childDepth}
                      band={childBand}
                      index={i}
                      drag={drag}
                    />
                  ))}
                </SortableContext>
                {children.length === 0 && drag.activeId !== null && legalHere && (
                  <EmptyBandDrop parentId={childBand.parentId} band={childBand.band} />
                )}
              </div>
            );
          }}
        />
      </div>
    );
  }
  return (
    <div
      ref={setNodeRef}
      {...rowAria}
      style={{ marginLeft: `${depth * 16}px`, transform: nodeTransform }}
      className={`${rowClassBase} items-center ${hidden} ${indicator}`}
    >
      {dragHandle}
      <RowContent step={step} />
    </div>
  );
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

// 컨테이너의 키 큰 헤더 띠. 드롭 대상 비교에 쓰는 헤더 중심 추정 폭(px).
const HEADER_BAND_PX = 44;

// 드롭 대상 선택(Problem 1): 컨테이너의 sortable rect 는 자식 밴드까지 포함해
// 키가 크다. rect 전체 중심으로 비교하면 중심이 자식 영역으로 내려가 "자식이
// 닿아야" 순서가 바뀌는 비직관이 된다 → 컨테이너는 상단 헤더 띠(headerBandPx)
// 중심, leaf 는 행 전체 중심을 포인터 Y 와 비교해 가장 가까운 형제를 고른다
// (부모 헤더 위치가 드롭을 결정). 순수 함수 — 단위 테스트가 헤더-우선을 락인.
// (이 파일 단일-스코프 유지: 순수 헬퍼 1개라 별 파일 분리 대신 react-refresh 예외.)
// eslint-disable-next-line react-refresh/only-export-components
export function nearestByHeader(
  items: { id: string; top: number; height: number; isContainer: boolean }[],
  pointerY: number,
  headerBandPx: number,
): string | null {
  let best: string | null = null;
  let bestDist = Infinity;
  for (const it of items) {
    const center = it.isContainer ? it.top + headerBandPx / 2 : it.top + it.height / 2;
    const dist = Math.abs(center - pointerY);
    if (dist < bestDist) {
      bestDist = dist;
      best = it.id;
    }
  }
  return best;
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
  const reparentStep = useScenarioEditor((s) => s.reparentStep);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [overInfo, setOverInfo] = useState<{ id: string; half: "above" | "below" } | null>(null);
  // dragStart 1회 계산물은 ref로 충돌 콜백([steps] memo)에 전달(리뷰 핀 N2).
  const dragCalcRef = useRef<{ legal: Set<string>; index: Map<string, string> } | null>(null);
  // R4 pointer-half: DragEndEvent엔 포인터 좌표가 없어 충돌 콜백이 판정을 기록.
  const halfRef = useRef<{ overId: string; half: "above" | "below" } | null>(null);
  const activeStep = activeId ? findStepById(steps, activeId) : null;

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // 포인터 = 합법 밴드 전체(경계 넘기, spec R3) / 키보드 = 기존 형제-그룹 제한.
  // 후보 중 드롭 대상은 nearestByHeader(헤더 근접) 유지. 판정 half를 ref에 기록(R4).
  const collisionDetection = useCallback<CollisionDetection>(
    (args) => {
      const dragId = args.active.id as string;
      const pointerY = args.pointerCoordinates?.y;
      const allIds = args.droppableContainers.map((c) => c.id as string);
      if (pointerY == null) {
        const kb = new Set(keyboardCandidateIds(steps, dragId, allIds));
        const candidates = args.droppableContainers.filter((c) => kb.has(c.id as string));
        return closestCenter({ ...args, droppableContainers: candidates });
      }
      const calc = dragCalcRef.current;
      const candidateIds = new Set(
        calc
          ? filterDropCandidates(allIds, calc.legal, calc.index)
          : keyboardCandidateIds(steps, dragId, allIds),
      );
      const candidates = args.droppableContainers.filter((c) => candidateIds.has(c.id as string));
      if (candidates.length === 0) return [];
      const items = candidates.flatMap((c) => {
        const rect = args.droppableRects.get(c.id);
        if (!rect) return [];
        const cStep = findStepById(steps, c.id as string);
        const isContainer =
          cStep != null && (isLoopStep(cStep) || isIfStep(cStep) || isParallelStep(cStep));
        return [{ id: c.id as string, top: rect.top, height: rect.height, isContainer }];
      });
      const overId = nearestByHeader(items, pointerY, HEADER_BAND_PX);
      if (overId == null) return [];
      const it = items.find((i) => i.id === overId);
      if (it) {
        const center = it.isContainer ? it.top + HEADER_BAND_PX / 2 : it.top + it.height / 2;
        halfRef.current = { overId, half: pointerY < center ? "above" : "below" };
      }
      return [{ id: overId }];
    },
    [steps],
  );

  const handleDragStart = (event: DragStartEvent) => {
    const id = event.active.id as string;
    setActiveId(id);
    dragCalcRef.current = { legal: legalTargetBands(steps, id), index: bandIndex(steps) };
    halfRef.current = null;
    setOverInfo(null);
  };
  const handleDragMove = (event: DragMoveEvent) => {
    const overId = (event.over?.id ?? null) as string | null;
    const h = halfRef.current;
    const next =
      overId === null
        ? null
        : { id: overId, half: h && h.overId === overId ? h.half : ("below" as const) };
    setOverInfo((prev) => (prev?.id === next?.id && prev?.half === next?.half ? prev : next));
  };
  const handleDragEnd = (event: DragEndEvent) => {
    setActiveId(null);
    setOverInfo(null);
    const { active, over } = event;
    const dragId = active.id as string;
    const overId = (over?.id ?? null) as string | null;
    const half =
      overId !== null && halfRef.current?.overId === overId ? halfRef.current.half : null;
    dragCalcRef.current = null;
    halfRef.current = null;
    const res = resolveDrop(steps, dragId, overId, half);
    if (res?.kind === "move") moveStep(res.stepId, res.toIndex);
    else if (res?.kind === "reparent") reparentStep(res.stepId, res.target);
  };
  const handleDragCancel = () => {
    setActiveId(null);
    setOverInfo(null);
    dragCalcRef.current = null;
    halfRef.current = null;
  };

  const selectedLoopId = useMemo(() => {
    const sel = steps.find((s) => s.id === selectedStepId);
    return sel && isLoopStep(sel) ? sel.id : null;
  }, [steps, selectedStepId]);

  const overBandKey = useMemo(() => {
    if (!overInfo) return null;
    const ph = /^band:([^:]+):(.+)$/.exec(overInfo.id);
    if (ph) return `${ph[1]}:${ph[2]}`;
    const b = findParentBand(steps, overInfo.id);
    return b ? bandKey(b) : null;
  }, [overInfo, steps]);
  // 드래그 소스가 속한 밴드(N1 핀: same-band는 half 무시·verbatim 착지) —
  // 인디케이터/하이라이트를 교차-밴드로만 게이트하는 기준(최종리뷰 F1).
  const activeBandKey =
    activeId !== null ? (dragCalcRef.current?.index.get(activeId) ?? null) : null;
  const drag: DragCtx = {
    activeId,
    legal: dragCalcRef.current?.legal ?? null,
    over: overInfo,
    overBandKey,
    activeBandKey,
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      onDragStart={handleDragStart}
      onDragMove={handleDragMove}
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
              {steps.map((s, i) => (
                <OutlineRow key={s.id} step={s} depth={0} band={TOP_BAND} index={i} drag={drag} />
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
