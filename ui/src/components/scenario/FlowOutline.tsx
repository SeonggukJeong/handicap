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
  setupSteps,
  type LoopStep,
  type Step,
} from "../../scenario/model";
import { resolveDrop } from "../../scenario/reorder";
import { formatThink } from "../../scenario/thinkTime";
import { loopCountLabel } from "../../scenario/loopLabel";
import { loopWarnings } from "../../scenario/loopWarnings";
import {
  bandIndex,
  bandKey,
  dropId,
  filterDropCandidates,
  findParentBand,
  keyboardCandidateIds,
  legalTargetBands,
  parseDropId,
  SETUP_BAND,
  SETUP_DROP_ID,
  setupZoneCollision,
  setupDropDecision,
  showSetupZone,
  showTopZone,
  TOP_BAND,
  TOP_DROP_ID,
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
function EmptyBandDrop({ id }: { id: string }) {
  const { setNodeRef, isOver } = useDroppable({
    id,
    data: { index: 0 },
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

// 준비 스텝이 없을 때 목록 맨 위로 끌어 올리면 열리는 준비 놓을 자리(목업 `.dropzone.over`).
function SetupDropZone() {
  const { setNodeRef } = useDroppable({ id: SETUP_DROP_ID, data: { index: 0 } });
  return (
    <div
      ref={setNodeRef}
      className="mb-2.5 rounded-lg border-[1.5px] border-dashed border-accent-500 bg-accent-100 p-2.5 text-center text-xs font-medium text-accent-800 ring-2 ring-accent-200"
    >
      {ko.editor.setupDropHint}
    </div>
  );
}

// wide 모드의 행 컨텍스트 — activate 훅 + wide 플래그를 트리 아래로 흘린다
// (store 미접촉, prop-only). wide 미지정(undefined)이면 이 파일의 모든 렌더
// 분기가 non-wide로 접혀 R9 byte-identical이 유지된다.
type RowView = { wide: boolean; onActivate?: (id: string) => void };

// 조건 요약은 변수명이 길면 한없이 길어진다 — 이름과 함께 줄어들며 말줄임, 전체는 툴팁.
function CondSummary({ text }: { text: string }) {
  return (
    <span className="min-w-0 truncate text-xs text-slate-500" title={text}>
      {text}
    </span>
  );
}

function LoopWarnIcon({ step }: { step: LoopStep }) {
  const defaultThink = useScenarioEditor((s) => s.model?.default_think_time);
  // 사용자 정규식을 평가하므로 무관한 재렌더마다 다시 계산하지 않는다.
  const w = useMemo(() => loopWarnings(step, defaultThink), [step, defaultThink]);
  if (!(w.noThink || w.thinkNotKept || w.retryOnFailure)) return null;
  const label = ko.editor.loopWarnIconAria(step.name);
  return (
    <span role="img" aria-label={label} title={label} className="shrink-0 text-amber-500">
      ⚠
    </span>
  );
}

// 한 행 헤더의 "드래그 핸들 이후" 내용. 대화형 OutlineRow와 오버레이용
// OutlineRowPreview가 공유 — 시각 드리프트 방지(spec §3.3).
function RowContent({ step, wide = false }: { step: Step; wide?: boolean }) {
  if (isLoopStep(step)) {
    if (step.while !== undefined) {
      // 조건 반복: http 행처럼 두 줄 — 1줄 이름·개수 라벨·⚠, 2줄 조건 요약(좁은 행에서도 읽히게).
      return (
        <>
          <ContainerTag glyph="⟳" label={ko.editor.containerLoop} />
          <div className="flex min-w-0 flex-col">
            <div className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 truncate font-medium" title={step.name}>
                {step.name}
              </span>
              <span className="shrink-0 text-xs text-slate-500">{loopCountLabel(step)}</span>
              <LoopWarnIcon step={step} />
            </div>
            <CondSummary text={summarizeCondition(step.while)} />
          </div>
        </>
      );
    }
    return (
      <>
        <ContainerTag glyph="⟳" label={ko.editor.containerLoop} />
        <span className="min-w-0 truncate font-medium" title={step.name}>
          {step.name}
        </span>
        <span className="shrink-0 text-xs text-slate-500">{loopCountLabel(step)}</span>
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
        <CondSummary text={summarizeCondition(step.cond)} />
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
      {wide &&
        (step.assert.length > 0 || step.extract.length > 0 || step.think_time !== undefined) && (
          <span className="ml-auto flex shrink-0 items-center gap-1">
            {step.assert.length > 0 && (
              <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] text-slate-600">
                {ko.editor.wideChipAssert(step.assert.length)}
              </span>
            )}
            {step.extract.length > 0 && (
              <span
                title={step.extract.map((x) => x.var).join(", ")}
                className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] text-slate-600"
              >
                {ko.editor.wideChipExtract(step.extract.length)}
              </span>
            )}
            {step.think_time !== undefined && (
              <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] text-slate-600">
                {ko.editor.wideChipThink(formatThink(step.think_time))}
              </span>
            )}
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
  view,
}: {
  step: Step;
  depth: number;
  band?: BandRef;
  index?: number;
  drag?: DragCtx;
  view?: RowView;
}) {
  const selectedStepId = useScenarioEditor((s) => s.selectedStepId);
  const select = useScenarioEditor((s) => s.select);
  const editLocked = useScenarioEditor((s) => s.yamlError) !== null; // 편집 게이트(R3)
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, isDragging } =
    useSortable({
      id: step.id,
      data: { parentId: band.parentId, band: band.band, index },
      disabled: editLocked,
    });
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
  const activate = (target: EventTarget) => {
    // 드래그 핸들(행 안의 유일한 <button>) 경유 활성화 제외 — select만(spec §4.4).
    if (!(target as HTMLElement).closest("button")) view?.onActivate?.(step.id);
  };
  // 헤더 행의 role/선택/키보드 속성(transform 제외 — transform 은 sortable 노드로).
  const rowAria = {
    role: "option" as const,
    "aria-selected": selected,
    "aria-label": ko.editor.outlineRowAria(step.name),
    tabIndex: 0,
    "data-depth": String(depth),
    ...(view?.wide || view?.onActivate || bandKey(band) === bandKey(SETUP_BAND)
      ? { "data-step-id": step.id }
      : {}),
    onClick: (e: React.MouseEvent) => {
      select(step.id);
      activate(e.target);
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        select(step.id);
        activate(e.target);
      }
    },
  };
  const dragHandle = (
    <button
      type="button"
      disabled={editLocked}
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
          <RowContent step={step} wide={view?.wide ?? false} />
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
                      view={view}
                    />
                  ))}
                </SortableContext>
                {children.length === 0 && drag.activeId !== null && legalHere && (
                  <EmptyBandDrop id={dropId(childBand)} />
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
      <RowContent step={step} wide={view?.wide ?? false} />
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

// 끄는 미리보기. 준비 놓을 자리가 열려 있으면 미리보기가 그 안내 글을 덮으므로 같은 안내를 미리보기 위에 붙인다.
export function DragPreview({ step, toSetup }: { step: Step; toSetup: boolean }) {
  return (
    <div className="relative">
      {toSetup && (
        <span className="absolute -top-6 left-0 whitespace-nowrap rounded-md bg-accent-600 px-2 py-0.5 text-xs font-medium text-white shadow">
          {ko.editor.setupDropPreviewHint}
        </span>
      )}
      <OutlineRowPreview step={step} depth={0} />
    </div>
  );
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

export function FlowOutline({
  wide = false,
  onActivateStep,
}: {
  wide?: boolean;
  onActivateStep?: (id: string) => void;
} = {}) {
  const steps = useScenarioEditor((s) => s.model?.steps ?? EMPTY_STEPS);
  const model = useScenarioEditor((s) => s.model);
  const setup = useMemo(() => (model ? setupSteps(model) : EMPTY_STEPS), [model]);
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
  // 준비 놓을 자리: 「내용 맨 위」 기준선(높이 0 div)과 끌기 시작 때 집은 내용 Y.
  // 열림 여부는 그리기용 state와 충돌 판정이 읽는 ref 둘 다에 둔다.
  const contentTopRef = useRef<HTMLDivElement | null>(null);
  const grabYRef = useRef<number | null>(null);
  const setupZoneRef = useRef(false);
  const [setupZoneShown, setSetupZoneShown] = useState(false);
  const all = useMemo(() => [...setup, ...steps], [setup, steps]);
  const addSetupStep = useScenarioEditor((s) => s.addSetupStep);
  const activeStep = activeId ? findStepById(all, activeId) : null;

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // 포인터 = 합법 밴드 전체(경계 넘기, spec R3) / 키보드 = 기존 형제-그룹 제한.
  // 후보 중 드롭 대상은 nearestByHeader(헤더 근접) 유지. 판정 half를 ref에 기록(R4).
  const collisionDetection = useCallback<CollisionDetection>(
    (args) => {
      const zone = setupZoneCollision({
        open: setupZoneRef.current,
        registered: args.droppableContainers.some((c) => c.id === SETUP_DROP_ID),
        measured: args.droppableRects.has(SETUP_DROP_ID),
      });
      if (zone === "zone") return [{ id: SETUP_DROP_ID }];
      if (zone === "none") return [];
      const dragId = args.active.id as string;
      const pointerY = args.pointerCoordinates?.y;
      // 놓을 자리가 지금 충돌 대상이 아니면(닫힘) 언마운트 전까지 남은 낡은 droppable을 후보에서 뺀다.
      const allIds = args.droppableContainers
        .map((c) => c.id as string)
        .filter((id) => id !== SETUP_DROP_ID);
      if (pointerY == null) {
        const kb = new Set(keyboardCandidateIds(steps, dragId, allIds, setup));
        const candidates = args.droppableContainers.filter((c) => kb.has(c.id as string));
        return closestCenter({ ...args, droppableContainers: candidates });
      }
      const calc = dragCalcRef.current;
      const candidateIds = new Set(
        calc
          ? filterDropCandidates(allIds, calc.legal, calc.index)
          : keyboardCandidateIds(steps, dragId, allIds, setup),
      );
      const candidates = args.droppableContainers.filter((c) => candidateIds.has(c.id as string));
      if (candidates.length === 0) return [];
      const items = candidates.flatMap((c) => {
        const rect = args.droppableRects.get(c.id);
        if (!rect) return [];
        const cStep = findStepById(all, c.id as string);
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
    [steps, setup, all],
  );

  const handleDragStart = (event: DragStartEvent) => {
    const id = event.active.id as string;
    setActiveId(id);
    dragCalcRef.current = {
      legal: legalTargetBands(steps, id, setup),
      index: bandIndex(steps, setup),
    };
    halfRef.current = null;
    setOverInfo(null);
    closeSetupZone();
    const ev = event.activatorEvent;
    const top = contentTopRef.current;
    grabYRef.current =
      ev instanceof KeyboardEvent || !(ev instanceof MouseEvent) || !top
        ? null
        : ev.clientY - top.getBoundingClientRect().top;
  };
  const closeSetupZone = () => {
    grabYRef.current = null;
    setupZoneRef.current = false;
    setSetupZoneShown(false);
  };
  const handleDragMove = (event: DragMoveEvent) => {
    const grabY = grabYRef.current;
    const calc = dragCalcRef.current;
    if (grabY !== null && calc) {
      const open = showSetupZone({
        setupCount: setup.length,
        legal: calc.legal,
        pointerY: grabY + event.delta.y,
        grabY,
      });
      if (open !== setupZoneRef.current) {
        setupZoneRef.current = open;
        setSetupZoneShown(open);
      }
    }
    const overId = (event.over?.id ?? null) as string | null;
    const h = halfRef.current;
    const next =
      overId === null
        ? null
        : { id: overId, half: h && h.overId === overId ? h.half : ("below" as const) };
    setOverInfo((prev) => (prev?.id === next?.id && prev?.half === next?.half ? prev : next));
  };
  const handleDragEnd = (event: DragEndEvent) => {
    // 닫기 전에 읽는다: 놓는 순간의 포인터 위치(event.delta는 스크롤 반영 — move와 같은 값)로 열림을 다시 계산.
    const grabY = grabYRef.current;
    const calc = dragCalcRef.current;
    const open =
      grabY !== null &&
      calc !== null &&
      showSetupZone({
        setupCount: setup.length,
        legal: calc.legal,
        pointerY: grabY + event.delta.y,
        grabY,
      });
    setActiveId(null);
    setOverInfo(null);
    closeSetupZone();
    const { active, over } = event;
    const dragId = active.id as string;
    const overId = (over?.id ?? null) as string | null;
    const half =
      overId !== null && halfRef.current?.overId === overId ? halfRef.current.half : null;
    dragCalcRef.current = null;
    halfRef.current = null;
    const decision = setupDropDecision({ open, overId });
    if (decision === "setup") {
      reparentStep(dragId, { parentId: null, band: "setup", index: 0 });
      return;
    }
    if (decision === "none") return;
    const res = resolveDrop(steps, dragId, overId, half, setup);
    if (res?.kind === "move") moveStep(res.stepId, res.toIndex);
    else if (res?.kind === "reparent") reparentStep(res.stepId, res.target);
  };
  const handleDragCancel = () => {
    setActiveId(null);
    setOverInfo(null);
    closeSetupZone();
    dragCalcRef.current = null;
    halfRef.current = null;
  };

  const selectedLoopId = useMemo(() => {
    const sel = steps.find((s) => s.id === selectedStepId);
    return sel && isLoopStep(sel) ? sel.id : null;
  }, [steps, selectedStepId]);

  const overBandKey = useMemo(() => {
    if (!overInfo) return null;
    const ph = parseDropId(overInfo.id);
    if (ph) return bandKey(ph);
    const b = findParentBand(steps, overInfo.id, setup);
    return b ? bandKey(b) : null;
  }, [overInfo, steps, setup]);
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
  const setupBoxDrag =
    activeId === null
      ? ""
      : `${overBandKey === bandKey(SETUP_BAND) && activeBandKey !== bandKey(SETUP_BAND) ? " ring-2 ring-accent-300" : ""}${
          drag.legal && !drag.legal.has(bandKey(SETUP_BAND)) ? " opacity-[0.55]" : ""
        }`;
  const addSetupClick = () => select(addSetupStep(`Setup ${setup.length + 1}`));
  const view = useMemo<RowView>(
    () => ({ wide, onActivate: onActivateStep }),
    [wide, onActivateStep],
  );

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
          className="flex-1 overflow-auto [overflow-anchor:none]"
          onClick={(e) => {
            if (e.target === e.currentTarget) select(null);
          }}
        >
          <div ref={contentTopRef} aria-hidden="true" className="h-0" />
          {setupZoneShown && setup.length === 0 && activeId !== null && <SetupDropZone />}
          {setup.length > 0 && (
            <>
              <div
                role="group"
                aria-label={`${ko.editor.setupSectionName} ${ko.editor.setupSectionNote}`}
                className={`mb-2.5 rounded-lg border border-accent-200 bg-accent-50 p-2${setupBoxDrag}`}
              >
                <p className="mb-1 px-0.5 text-[11px] font-semibold text-accent-800">
                  {ko.editor.setupSectionName}{" "}
                  <span className="font-normal text-slate-600">{ko.editor.setupSectionNote}</span>
                </p>
                <div className="flex flex-col gap-1">
                  <SortableContext
                    items={setup.map((s) => s.id)}
                    strategy={verticalListSortingStrategy}
                  >
                    {setup.map((s, i) => (
                      <OutlineRow
                        key={s.id}
                        step={s}
                        depth={0}
                        band={SETUP_BAND}
                        index={i}
                        drag={drag}
                        view={view}
                      />
                    ))}
                  </SortableContext>
                </div>
                <button
                  type="button"
                  className="mt-1.5 rounded-md border border-dashed border-accent-300 px-2.5 py-1 text-xs text-accent-800"
                  onClick={addSetupClick}
                >
                  {ko.editor.addSetupStep}
                </button>
              </div>
              <p className="mb-1 px-0.5 text-[11px] font-semibold text-slate-400">
                {ko.editor.mainSectionTitle}
              </p>
            </>
          )}
          <div className="flex flex-col gap-1">
            <SortableContext items={steps.map((s) => s.id)} strategy={verticalListSortingStrategy}>
              {steps.map((s, i) => (
                <OutlineRow
                  key={s.id}
                  step={s}
                  depth={0}
                  band={TOP_BAND}
                  index={i}
                  drag={drag}
                  view={view}
                />
              ))}
            </SortableContext>
          </div>
          {showTopZone({
            mainCount: steps.length,
            draggingSetupStep: activeBandKey === bandKey(SETUP_BAND),
          }) ? (
            <EmptyBandDrop id={TOP_DROP_ID} />
          ) : (
            steps.length === 0 && (
              <p className="mt-2 text-xs text-slate-500">{ko.editor.canvasEmpty}</p>
            )
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
          {setup.length === 0 && (
            <button
              type="button"
              className="rounded border border-accent-200 px-3 py-1.5 text-sm text-accent-800 hover:bg-slate-100"
              onClick={addSetupClick}
            >
              {ko.editor.addSetupStep}
            </button>
          )}
        </div>
        <p className="mt-1 text-xs text-slate-400">{ko.editor.containerCaption}</p>
      </div>
      <DragOverlay>
        {activeStep ? (
          <DragPreview step={activeStep} toSetup={setupZoneShown && setup.length === 0} />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
