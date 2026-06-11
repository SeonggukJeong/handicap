import { memo } from "react";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { ko } from "../../i18n/ko";

export interface HttpStepNodeData extends Record<string, unknown> {
  name: string;
  method: string;
  url: string;
  urlMissing: boolean;
  selected: boolean;
}

type HttpStepNodeType = Node<HttpStepNodeData, "http">;

function HttpStepNodeImpl({ data }: NodeProps<HttpStepNodeType>) {
  const { name, method, url, urlMissing, selected } = data;
  return (
    <div
      className={
        // w-full + box-border so the node fills the width set by CanvasView and
        // its truncate-d name/URL lines clip instead of widening the node.
        "box-border w-full px-3 py-2 rounded-md border bg-white text-sm shadow-sm " +
        (selected ? "border-slate-900 ring-1 ring-slate-900" : "border-slate-300")
      }
    >
      <Handle type="target" position={Position.Left} className="!bg-slate-400" />
      <div className="flex items-center gap-1">
        <span className="min-w-0 font-medium text-slate-900 truncate" title={name}>
          {name}
        </span>
        {urlMissing && (
          <span className="shrink-0 text-amber-600" title={ko.editor.urlMissingBadge}>
            ⚠
          </span>
        )}
      </div>
      <div className="text-xs text-slate-600 font-mono truncate" title={`${method} ${url}`}>
        <span className="font-semibold">{method}</span> {url}
      </div>
      <Handle type="source" position={Position.Right} className="!bg-slate-400" />
    </div>
  );
}

export const HttpStepNode = memo(HttpStepNodeImpl);
