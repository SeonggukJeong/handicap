import { useState } from "react";
import type { Extract } from "../../scenario/model";
import { segmentsToPath, suggestVarName, type Segment } from "../../scenario/jsonPath";
import { ExtractConfirmRow } from "./ExtractConfirmRow";

function isScalar(v: unknown): v is string | number | boolean | null {
  return v === null || typeof v !== "object";
}

function preview(v: unknown): string {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 40 ? `${s.slice(0, 40)}…` : s;
}

/** Nearest object-key ancestor (skip array indices) → var suggestion source. */
function lastKey(segments: ReadonlyArray<Segment>): string {
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i];
    if (seg.kind === "key") return seg.key;
  }
  return "value";
}

/** Renders parsed JSON as a tree; scalar leaves expose "+추출" → inline confirm row
 *  → onCreate(body extract). Object/array containers are shown but not extractable
 *  (R6 — path/value would be ambiguous). */
export function ResponseBodyTree({
  value,
  onCreate,
}: {
  value: unknown;
  onCreate: (extract: Extract) => void;
}) {
  return (
    <div className="overflow-auto rounded bg-slate-900 p-2 font-mono text-xs text-slate-100">
      <TreeNode value={value} segments={[]} onCreate={onCreate} />
    </div>
  );
}

function TreeNode({
  value,
  segments,
  label,
  onCreate,
}: {
  value: unknown;
  segments: ReadonlyArray<Segment>;
  label?: string;
  onCreate: (extract: Extract) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const prefix = label !== undefined ? `${label}: ` : "";

  if (isScalar(value)) {
    const path = segmentsToPath(segments);
    return (
      <div className="pl-3">
        <div className="flex items-center justify-between gap-2">
          <span className="min-w-0 truncate">
            {prefix}
            {typeof value === "string" ? `"${value}"` : String(value)}
          </span>
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="shrink-0 rounded bg-accent-600 px-1.5 py-0.5 text-[11px] text-white"
          >
            +추출
          </button>
        </div>
        {confirming && (
          <ExtractConfirmRow
            proposed={{ var: suggestVarName(lastKey(segments)), from: "body", path }}
            preview={preview(value)}
            onConfirm={(ex) => {
              onCreate(ex);
              setConfirming(false);
            }}
            onCancel={() => setConfirming(false)}
          />
        )}
      </div>
    );
  }

  const entries: [string | number, unknown][] = Array.isArray(value)
    ? value.map((v, idx) => [idx, v] as [number, unknown])
    : Object.entries(value as Record<string, unknown>);
  return (
    <div className="pl-3">
      <div className="text-slate-400">
        {prefix}
        {Array.isArray(value) ? `[${entries.length}]` : "{…}"}
      </div>
      {entries.map(([key, child]) => (
        <TreeNode
          key={String(key)}
          value={child}
          label={typeof key === "number" ? `[${key}]` : key}
          segments={[
            ...segments,
            typeof key === "number" ? { kind: "index", index: key } : { kind: "key", key },
          ]}
          onCreate={onCreate}
        />
      ))}
    </div>
  );
}
