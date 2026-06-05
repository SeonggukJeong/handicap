import { memo } from "react";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";

export interface ParallelStepNodeData extends Record<string, unknown> {
  name: string;
  lanes: Array<{ name: string; x: number; y: number }>;
  selected: boolean;
}

type ParallelStepNodeType = Node<ParallelStepNodeData, "parallel">;

function ParallelStepNodeImpl({ data }: NodeProps<ParallelStepNodeType>) {
  const { name, lanes, selected } = data;
  return (
    <div
      className={
        "relative box-border h-full w-full rounded-md border-2 border-dashed bg-violet-50/50 " +
        (selected ? "border-violet-700 ring-1 ring-violet-700" : "border-violet-400")
      }
    >
      <Handle type="target" position={Position.Left} className="!bg-violet-400" />
      <div className="px-2 py-1">
        <div className="flex items-center justify-between">
          <span className="font-medium text-slate-900 truncate" title={name}>
            {name}
          </span>
          <span className="text-xs font-mono text-violet-700">parallel</span>
        </div>
      </div>
      {lanes.map((lane) => (
        <div
          key={lane.name}
          className="absolute text-[10px] font-semibold uppercase tracking-wide text-violet-600 pointer-events-none"
          style={{ left: lane.x, top: lane.y }}
        >
          {lane.name}
        </div>
      ))}
      <Handle type="source" position={Position.Right} className="!bg-violet-400" />
    </div>
  );
}

export const ParallelStepNode = memo(ParallelStepNodeImpl);
