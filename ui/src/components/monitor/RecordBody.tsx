import { useMemo, useState } from "react";
import { JsonValueTree } from "../response/JsonValueTree";
import { parseBodyJson } from "../../monitor/conditions";
import { ko } from "../../i18n/ko";

/** JsonValueTree draws every node at once — above this UTF-8 size show raw text only. */
const TREE_MAX_BYTES = 64 * 1024;

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
    return parseBodyJson(body);
  }, [body, clippedKb]);

  const tooLarge = parsed === "too_large";
  const tree = parsed !== null && !tooLarge ? parsed : null;
  const showTree = tree !== null && !raw;

  return (
    <div>
      {(clippedKb !== null || engineTruncated || tooLarge || tree !== null) && (
        <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
          {clippedKb !== null && (
            <span className="text-amber-700">{ko.monitor.recordClipped(clippedKb)}</span>
          )}
          {engineTruncated && (
            <span className="text-amber-700">{ko.monitor.recordEngineTruncated}</span>
          )}
          {tooLarge && <span>{ko.monitor.recordTreeTooLarge}</span>}
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
