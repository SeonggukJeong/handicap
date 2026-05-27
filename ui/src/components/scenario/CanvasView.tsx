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

const NODE_TYPES = { http: HttpStepNode };
const NODE_WIDTH = 200;
const NODE_GAP = 60;

export function CanvasView() {
  const steps = useScenarioEditor((s) => s.model?.steps ?? []);
  const selectedStepId = useScenarioEditor((s) => s.selectedStepId);
  const select = useScenarioEditor((s) => s.select);
  const addStep = useScenarioEditor((s) => s.addStep);

  const nodes = useMemo<Array<Node<HttpStepNodeData>>>(
    () =>
      steps.map((step, idx) => ({
        id: step.id,
        type: "http",
        position: { x: idx * (NODE_WIDTH + NODE_GAP), y: 0 },
        data: {
          name: step.name,
          method: step.request.method,
          url: step.request.url,
          selected: step.id === selectedStepId,
        },
        draggable: false,
        selectable: false,
      })),
    [steps, selectedStepId],
  );

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
            const id = addStep(`Step ${steps.length + 1}`);
            select(id);
          }}
          className="px-3 py-1.5 text-sm border border-slate-300 rounded hover:bg-slate-100"
        >
          + Add step
        </button>
        {steps.length === 0 && (
          <span className="text-xs text-slate-400 self-center">
            Canvas is empty. Click "Add step" to begin.
          </span>
        )}
      </div>
    </div>
  );
}
