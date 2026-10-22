import { useState, type ReactNode } from "react";
import { segmentsToPath, type Segment } from "../../scenario/jsonPath";

export type JsonLeaf = {
  segments: ReadonlyArray<Segment>;
  path: string;
  value: string | number | boolean | null;
  key: string;
};

function isScalar(v: unknown): v is string | number | boolean | null {
  return v === null || typeof v !== "object";
}

/** Nearest object-key ancestor (skip array indices) → var suggestion source. */
function lastKey(segments: ReadonlyArray<Segment>): string {
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i];
    if (seg.kind === "key") return seg.key;
  }
  return "value";
}

interface TreeProps {
  actionLabel: string;
  actionAriaLabel?: (leaf: JsonLeaf) => string;
  renderConfirm: (leaf: JsonLeaf, close: () => void) => ReactNode;
}

/** Renders parsed JSON as a tree; scalar leaves expose an action button that opens
 *  `renderConfirm` inline below the leaf. Containers are shown but have no action. */
export function JsonValueTree({ value, ...props }: TreeProps & { value: unknown }) {
  return (
    <div className="overflow-auto rounded bg-slate-900 p-2 font-mono text-xs text-slate-100">
      <TreeNode value={value} segments={[]} {...props} />
    </div>
  );
}

function TreeNode({
  value,
  segments,
  label,
  actionLabel,
  actionAriaLabel,
  renderConfirm,
}: TreeProps & {
  value: unknown;
  segments: ReadonlyArray<Segment>;
  label?: string;
}) {
  const [confirming, setConfirming] = useState(false);
  const prefix = label !== undefined ? `${label}: ` : "";

  if (isScalar(value)) {
    const leaf: JsonLeaf = {
      segments,
      path: segmentsToPath(segments),
      value,
      key: lastKey(segments),
    };
    return (
      <div className="pl-3">
        <div className="flex items-center justify-between gap-2">
          <span className="min-w-0 truncate">
            {prefix}
            {typeof value === "string" ? `"${value}"` : String(value)}
          </span>
          <button
            type="button"
            aria-label={actionAriaLabel ? actionAriaLabel(leaf) : undefined}
            onClick={() => setConfirming(true)}
            className="shrink-0 rounded bg-accent-600 px-1.5 py-0.5 text-[11px] text-white"
          >
            {actionLabel}
          </button>
        </div>
        {confirming && renderConfirm(leaf, () => setConfirming(false))}
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
          actionLabel={actionLabel}
          actionAriaLabel={actionAriaLabel}
          renderConfirm={renderConfirm}
        />
      ))}
    </div>
  );
}
