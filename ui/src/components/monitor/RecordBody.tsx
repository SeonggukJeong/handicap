import { useMemo, useState } from "react";
import { JsonValueTree } from "../response/JsonValueTree";
import { parseBodyJson } from "../../monitor/conditions";
import { ko } from "../../i18n/ko";

/** JsonValueTree draws every node at once — above this UTF-8 size show raw text only. */
const TREE_MAX_BYTES = 64 * 1024;
/** JsonValueTree recurses once per level; a 64KB `[[[…]]]` is ~32K levels deep. */
const TREE_MAX_DEPTH = 64;

/** Nesting depth of a parsed JSON value, iteratively (the input may be too deep to recurse).
 *  Stops as soon as `limit` is exceeded. */
function jsonDepthExceeds(value: unknown, limit: number): boolean {
  const stack: [unknown, number][] = [[value, 1]];
  while (stack.length > 0) {
    const [v, d] = stack.pop()!;
    if (v === null || typeof v !== "object") continue;
    if (d > limit) return true;
    for (const child of Object.values(v)) stack.push([child, d + 1]);
  }
  return false;
}

/** Inline body block (NOT BodyBlock: its "full view" would nest a Modal inside the
 *  record Modal and ESC would close both). Max height + internal scroll. */
export function RecordBody({
  body,
  clippedKb,
  engineTruncated,
}: {
  body: string;
  clippedKb: number | null;
  engineTruncated: boolean;
}) {
  const [raw, setRaw] = useState(false);
  const parsed = useMemo(() => {
    // A body clipped at the record limit is cut mid-JSON: always raw.
    if (clippedKb !== null) return null;
    const bytes = new TextEncoder().encode(body).length;
    if (bytes > TREE_MAX_BYTES) return "too_large" as const;
    const json = parseBodyJson(body);
    if (json !== null && jsonDepthExceeds(json.value, TREE_MAX_DEPTH)) return "too_deep" as const;
    return json;
  }, [body, clippedKb]);

  const tooLarge = parsed === "too_large";
  const tooDeep = parsed === "too_deep";
  const tree = parsed !== null && !tooLarge && !tooDeep ? parsed : null;
  const showTree = tree !== null && !raw;

  return (
    <div>
      {(clippedKb !== null || engineTruncated || tooLarge || tooDeep || tree !== null) && (
        <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
          {clippedKb !== null && (
            <span className="text-amber-700">{ko.monitor.recordClipped(clippedKb)}</span>
          )}
          {engineTruncated && (
            <span className="text-amber-700">{ko.monitor.recordEngineTruncated}</span>
          )}
          {tooLarge && <span>{ko.monitor.recordTreeTooLarge}</span>}
          {tooDeep && <span>{ko.monitor.recordTreeTooDeep}</span>}
          {tree !== null && tree.unwrapped > 0 && <span>{ko.monitor.previewUnwrapped}</span>}
          {tree !== null && (
            <button
              type="button"
              onClick={() => setRaw((v) => !v)}
              className="rounded bg-slate-200 px-1.5 py-0.5 hover:bg-slate-300"
            >
              {raw ? ko.monitor.recordViewTree : ko.monitor.recordViewRaw}
            </button>
          )}
        </div>
      )}
      <div className="max-h-64 overflow-auto">
        {showTree ? (
          <JsonValueTree value={tree.value} />
        ) : (
          <pre className="whitespace-pre-wrap break-all rounded bg-slate-900 p-2 font-mono text-xs text-slate-100">
            {body}
          </pre>
        )}
      </div>
    </div>
  );
}
