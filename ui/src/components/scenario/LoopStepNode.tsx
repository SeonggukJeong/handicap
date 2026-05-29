import { memo } from "react";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";

export interface LoopStepNodeData extends Record<string, unknown> {
  name: string;
  repeat: number;
  selected: boolean;
}

type LoopStepNodeType = Node<LoopStepNodeData, "loop">;

function LoopStepNodeImpl({ data }: NodeProps<LoopStepNodeType>) {
  const { name, repeat, selected } = data;
  return (
    <div
      className={
        "h-full w-full rounded-md border-2 border-dashed bg-slate-50/60 " +
        (selected ? "border-slate-900 ring-1 ring-slate-900" : "border-slate-400")
      }
    >
      <Handle type="target" position={Position.Left} className="!bg-slate-400" />
      <div className="flex items-center justify-between px-2 py-1">
        <span className="font-medium text-slate-900 truncate" title={name}>
          {name}
        </span>
        <span className="text-xs font-mono text-slate-600 bg-white border border-slate-300 rounded px-1.5">
          × {repeat}
        </span>
      </div>
      <Handle type="source" position={Position.Right} className="!bg-slate-400" />
    </div>
  );
}

export const LoopStepNode = memo(LoopStepNodeImpl);
