import { memo } from "react";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";

export interface IfStepNodeData extends Record<string, unknown> {
  name: string;
  condSummary: string;
  bands: Array<{ label: string; y: number }>;
  selected: boolean;
}

type IfStepNodeType = Node<IfStepNodeData, "if">;

function IfStepNodeImpl({ data }: NodeProps<IfStepNodeType>) {
  const { name, condSummary, bands, selected } = data;
  return (
    <div
      className={
        "relative box-border h-full w-full rounded-md border-2 border-dashed bg-indigo-50/50 " +
        (selected ? "border-indigo-700 ring-1 ring-indigo-700" : "border-indigo-400")
      }
    >
      <Handle type="target" position={Position.Left} className="!bg-indigo-400" />
      <div className="px-2 py-1">
        <div className="flex items-center justify-between">
          <span className="font-medium text-slate-900 truncate" title={name}>
            {name}
          </span>
          <span className="text-xs font-mono text-indigo-700">if</span>
        </div>
        <div className="text-[11px] font-mono text-slate-600 truncate" title={condSummary}>
          {condSummary}
        </div>
      </div>
      {bands.map((b) => (
        <div
          key={b.label}
          className="absolute left-0 right-0 px-2 text-[10px] font-semibold uppercase tracking-wide text-indigo-600 pointer-events-none"
          style={{ top: b.y }}
        >
          {b.label}
        </div>
      ))}
      <Handle type="source" position={Position.Right} className="!bg-indigo-400" />
    </div>
  );
}

export const IfStepNode = memo(IfStepNodeImpl);
