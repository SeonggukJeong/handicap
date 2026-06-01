import { useEffect, useMemo, useRef } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  useNodesInitialized,
  useReactFlow,
  type Edge,
  type Node,
  type NodeMouseHandler,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useScenarioEditor } from "../../scenario/store";
import { HttpStepNode, type HttpStepNodeData } from "./HttpStepNode";
import { LoopStepNode, type LoopStepNodeData } from "./LoopStepNode";
import { IfStepNode, type IfStepNodeData } from "./IfStepNode";
import { isLoopStep, summarizeCondition, type Step } from "../../scenario/model";

const NODE_TYPES = { http: HttpStepNode, loop: LoopStepNode, if: IfStepNode };
const FIT_OPTIONS = { padding: 0.25, maxZoom: 1.2 } as const;
const NODE_WIDTH = 220;
const NODE_GAP = 60;
const CHILD_H = 64;
const CHILD_GAP = 16;
const LOOP_HEADER_H = 36;
const LOOP_PAD = 12;
const IF_HEADER_H = 44;
const BAND_LABEL_H = 18;
const BAND_PAD = 8;

type AnyData = HttpStepNodeData | LoopStepNodeData | IfStepNodeData;

export function CanvasView() {
  const steps = useScenarioEditor((s) => s.model?.steps ?? []);
  const selectedStepId = useScenarioEditor((s) => s.selectedStepId);
  const select = useScenarioEditor((s) => s.select);
  const addStep = useScenarioEditor((s) => s.addStep);
  const addLoopStep = useScenarioEditor((s) => s.addLoopStep);
  const addIfStep = useScenarioEditor((s) => s.addIfStep);
  const addStepInLoop = useScenarioEditor((s) => s.addStepInLoop);

  const selectedLoopId = useMemo(() => {
    const sel = steps.find((s) => s.id === selectedStepId);
    return sel && isLoopStep(sel) ? sel.id : null;
  }, [steps, selectedStepId]);

  const nodes = useMemo<Array<Node<AnyData>>>(() => {
    const out: Array<Node<AnyData>> = [];
    let x = 0;
    for (const step of steps) {
      emitStep(step, x, 0, NODE_WIDTH, undefined, out, selectedStepId);
      x += NODE_WIDTH + NODE_GAP;
    }
    return out;
  }, [steps, selectedStepId]);

  const edges = useMemo<Edge[]>(
    () =>
      steps.slice(1).map((step, i) => ({
        id: `${steps[i].id}->${step.id}`,
        source: steps[i].id,
        target: step.id,
        type: "default",
      })),
    [steps],
  );

  // Identity of the current node set — drives the auto-fit below. Changes when a
  // scenario loads (empty → populated) or when steps are added/removed/nested.
  const fitKey = useMemo(() => nodes.map((n) => n.id).join(","), [nodes]);

  const onNodeClick: NodeMouseHandler = (_e, node) => {
    select(node.id);
  };

  const onPaneClick = () => {
    select(null);
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 min-h-[520px] border border-slate-200 rounded-md overflow-hidden">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          onNodeClick={onNodeClick}
          onPaneClick={onPaneClick}
          fitView
          fitViewOptions={FIT_OPTIONS}
          minZoom={0.2}
          proOptions={{ hideAttribution: true }}
        >
          <AutoFitView fitKey={fitKey} />
          <Background gap={20} />
          <Controls position="bottom-right" showInteractive={false} />
        </ReactFlow>
      </div>
      <div className="mt-3">
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => {
              if (selectedLoopId) {
                const id = addStepInLoop(selectedLoopId, `Step ${steps.length + 1}`);
                select(id);
              } else {
                const id = addStep(`Step ${steps.length + 1}`);
                select(id);
              }
            }}
            className="whitespace-nowrap px-3 py-1.5 text-sm border border-slate-300 rounded hover:bg-slate-100"
          >
            {selectedLoopId ? "+ Add step in loop" : "+ Add step"}
          </button>
          <button
            type="button"
            onClick={() => {
              const id = addLoopStep(`Loop ${steps.length + 1}`);
              select(id);
            }}
            className="whitespace-nowrap px-3 py-1.5 text-sm border border-slate-300 rounded hover:bg-slate-100"
          >
            + Add loop
          </button>
          <button
            type="button"
            onClick={() => {
              const id = addIfStep(`If ${steps.length + 1}`);
              select(id);
            }}
            className="whitespace-nowrap px-3 py-1.5 text-sm border border-slate-300 rounded hover:bg-slate-100"
          >
            + Add if
          </button>
        </div>
        {steps.length === 0 && (
          <p className="mt-2 text-xs text-slate-400">
            Canvas is empty. Add a step, loop, or if to begin.
          </p>
        )}
      </div>
    </div>
  );
}

// React Flow's `fitView` prop only fits once, at initialization. The scenario
// model loads asynchronously (EditorShell.loadFromString runs in a post-mount
// effect), so on first paint the graph is empty and that single fit lands on
// nothing — leaving an existing scenario's nodes stranded off-screen (the
// "shows the wrong place" bug). Re-fit whenever the node set changes *and* the
// nodes have actually been measured. Keyed on fitKey so a manual pan/zoom is
// preserved until the structure itself changes.
function AutoFitView({ fitKey }: { fitKey: string }) {
  const initialized = useNodesInitialized();
  const { fitView } = useReactFlow();
  const fittedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!initialized || fitKey === "" || fittedRef.current === fitKey) return;
    fittedRef.current = fitKey;
    void fitView(FIT_OPTIONS);
  }, [initialized, fitKey, fitView]);
  return null;
}

function ifBands(step: Extract<Step, { type: "if" }>): Array<{ label: string; children: Step[] }> {
  return [
    { label: "THEN", children: step.then },
    ...step.elif.map((e, i) => ({ label: `ELIF ${i + 1}`, children: e.then })),
    ...(step.else.length > 0 ? [{ label: "ELSE", children: step.else }] : []),
  ];
}

// Rendered pixel height of a step's node (recursive — a nested container's height
// drives its parent's height).
function measureStep(step: Step): number {
  if (step.type === "http") return CHILD_H;
  if (step.type === "loop") {
    const body = step.do.reduce((h, c) => h + measureStep(c) + CHILD_GAP, 0);
    return LOOP_HEADER_H + LOOP_PAD + Math.max(body, CHILD_H + CHILD_GAP);
  }
  let h = IF_HEADER_H;
  for (const b of ifBands(step)) {
    h += BAND_LABEL_H;
    for (const c of b.children) h += measureStep(c) + CHILD_GAP;
    h += BAND_PAD;
  }
  return h;
}

// Emit a step (and, recursively, its children) as React Flow nodes. Children get
// parentId + extent:"parent"; positions are relative to the immediate parent.
function emitStep(
  step: Step,
  x: number,
  y: number,
  width: number,
  parentId: string | undefined,
  out: Array<Node<AnyData>>,
  selectedStepId: string | null,
): void {
  const base = {
    position: { x, y },
    draggable: false as const,
    selectable: false as const,
    ...(parentId ? { parentId, extent: "parent" as const } : {}),
  };
  if (step.type === "http") {
    out.push({
      id: step.id,
      type: "http",
      data: {
        name: step.name,
        method: step.request.method,
        url: step.request.url,
        selected: step.id === selectedStepId,
      },
      style: { width },
      ...base,
    });
    return;
  }
  const inner = width - LOOP_PAD * 2;
  if (step.type === "loop") {
    out.push({
      id: step.id,
      type: "loop",
      data: { name: step.name, repeat: step.repeat, selected: step.id === selectedStepId },
      style: { width, height: measureStep(step) },
      ...base,
    });
    let cy = LOOP_HEADER_H;
    for (const child of step.do) {
      const h = measureStep(child);
      emitStep(child, LOOP_PAD, cy, inner, step.id, out, selectedStepId);
      cy += h + CHILD_GAP;
    }
    return;
  }
  // if
  const bandMeta: Array<{ label: string; y: number }> = [];
  const placements: Array<{ child: Step; y: number }> = [];
  let cy = IF_HEADER_H;
  for (const b of ifBands(step)) {
    bandMeta.push({ label: b.label, y: cy });
    cy += BAND_LABEL_H;
    for (const child of b.children) {
      placements.push({ child, y: cy });
      cy += measureStep(child) + CHILD_GAP;
    }
    cy += BAND_PAD;
  }
  out.push({
    id: step.id,
    type: "if",
    data: {
      name: step.name,
      condSummary: summarizeCondition(step.cond),
      bands: bandMeta,
      selected: step.id === selectedStepId,
    },
    style: { width, height: cy },
    ...base,
  });
  for (const { child, y: cyy } of placements) {
    emitStep(child, LOOP_PAD, cyy, inner, step.id, out, selectedStepId);
  }
}
