import { useMemo } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  type Edge,
  type Node,
  type NodeMouseHandler,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useScenarioEditor } from "../../scenario/store";
import { HttpStepNode, type HttpStepNodeData } from "./HttpStepNode";
import { LoopStepNode, type LoopStepNodeData } from "./LoopStepNode";
import { IfStepNode, type IfStepNodeData } from "./IfStepNode";
import { isLoopStep, isIfStep, type Condition, type HttpStep } from "../../scenario/model";

const NODE_TYPES = { http: HttpStepNode, loop: LoopStepNode, if: IfStepNode };
const NODE_WIDTH = 220;
const NODE_GAP = 60;
const CHILD_H = 64;
const CHILD_GAP = 16;
const LOOP_HEADER_H = 36;
const LOOP_PAD = 12;
const IF_HEADER_H = 44;
const BAND_LABEL_H = 18;
const BAND_PAD = 8;
// Body steps sit inside the loop container; bound their width so a long request
// URL truncates instead of overflowing the dashed container.
const CHILD_WIDTH = NODE_WIDTH - LOOP_PAD * 2;

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
      if (isLoopStep(step)) {
        const bodyH = Math.max(1, step.do.length) * (CHILD_H + CHILD_GAP);
        const height = LOOP_HEADER_H + LOOP_PAD + bodyH;
        out.push({
          id: step.id,
          type: "loop",
          position: { x, y: 0 },
          data: { name: step.name, repeat: step.repeat, selected: step.id === selectedStepId },
          style: { width: NODE_WIDTH, height },
          draggable: false,
          selectable: false,
        });
        step.do.forEach((child, j) => {
          out.push({
            id: child.id,
            type: "http",
            parentId: step.id,
            extent: "parent",
            position: { x: LOOP_PAD, y: LOOP_HEADER_H + j * (CHILD_H + CHILD_GAP) },
            data: {
              name: child.name,
              method: child.request.method,
              url: child.request.url,
              selected: child.id === selectedStepId,
            },
            style: { width: CHILD_WIDTH },
            draggable: false,
            selectable: false,
          });
        });
        x += NODE_WIDTH + NODE_GAP;
      } else if (isIfStep(step)) {
        const bands: Array<{ label: string; children: HttpStep[] }> = [
          { label: "THEN", children: step.then },
          ...step.elif.map((e, i) => ({ label: `ELIF ${i + 1}`, children: e.then })),
          ...(step.else.length > 0 ? [{ label: "ELSE", children: step.else }] : []),
        ];
        let yy = IF_HEADER_H;
        const bandMeta: Array<{ label: string; y: number }> = [];
        const childPlacements: Array<{ child: HttpStep; y: number }> = [];
        for (const band of bands) {
          bandMeta.push({ label: band.label, y: yy });
          yy += BAND_LABEL_H;
          for (const child of band.children) {
            childPlacements.push({ child, y: yy });
            yy += CHILD_H + CHILD_GAP;
          }
          yy += BAND_PAD;
        }
        out.push({
          id: step.id,
          type: "if",
          position: { x, y: 0 },
          data: {
            name: step.name,
            condSummary: summarizeCondition(step.cond),
            bands: bandMeta,
            selected: step.id === selectedStepId,
          },
          style: { width: NODE_WIDTH, height: yy },
          draggable: false,
          selectable: false,
        });
        for (const { child, y } of childPlacements) {
          out.push({
            id: child.id,
            type: "http",
            parentId: step.id,
            extent: "parent",
            position: { x: LOOP_PAD, y },
            data: {
              name: child.name,
              method: child.request.method,
              url: child.request.url,
              selected: child.id === selectedStepId,
            },
            style: { width: CHILD_WIDTH },
            draggable: false,
            selectable: false,
          });
        }
        x += NODE_WIDTH + NODE_GAP;
      } else {
        out.push({
          id: step.id,
          type: "http",
          position: { x, y: 0 },
          data: {
            name: step.name,
            method: step.request.method,
            url: step.request.url,
            selected: step.id === selectedStepId,
          },
          style: { width: NODE_WIDTH },
          draggable: false,
          selectable: false,
        });
        x += NODE_WIDTH + NODE_GAP;
      }
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

  const onNodeClick: NodeMouseHandler = (_e, node) => {
    select(node.id);
  };

  const onPaneClick = () => {
    select(null);
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 min-h-[400px] border border-slate-200 rounded-md overflow-hidden">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          onNodeClick={onNodeClick}
          onPaneClick={onPaneClick}
          fitView
          fitViewOptions={{ padding: 0.3, maxZoom: 1.2 }}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={20} />
          <Controls position="bottom-right" showInteractive={false} />
        </ReactFlow>
      </div>
      <div className="flex gap-2 mt-3">
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
          className="px-3 py-1.5 text-sm border border-slate-300 rounded hover:bg-slate-100"
        >
          {selectedLoopId ? "+ Add step in loop" : "+ Add step"}
        </button>
        <button
          type="button"
          onClick={() => {
            const id = addLoopStep(`Loop ${steps.length + 1}`);
            select(id);
          }}
          className="px-3 py-1.5 text-sm border border-slate-300 rounded hover:bg-slate-100"
        >
          + Add loop
        </button>
        <button
          type="button"
          onClick={() => {
            const id = addIfStep(`If ${steps.length + 1}`);
            select(id);
          }}
          className="px-3 py-1.5 text-sm border border-slate-300 rounded hover:bg-slate-100"
        >
          + Add if
        </button>
        {steps.length === 0 && (
          <span className="text-xs text-slate-400 self-center">
            Canvas is empty. Add a step or a loop to begin.
          </span>
        )}
      </div>
    </div>
  );
}

function summarizeCondition(c: Condition): string {
  if ("all" in c) return c.all.map(summarizeCondition).join(" AND ");
  if ("any" in c) return c.any.map(summarizeCondition).join(" OR ");
  const noRight = c.op === "exists" || c.op === "empty";
  return `${c.left || "?"} ${c.op}${noRight ? "" : ` ${c.right ?? ""}`}`;
}
