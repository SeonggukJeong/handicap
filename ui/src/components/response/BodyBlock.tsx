import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Callout } from "../ui/Callout";
import { Modal } from "../Modal";

// Future: expose via an options menu (docs/roadmap.md §B2''). JS string units (UTF-16
// code points), distinct from the engine's byte cap.
export const INLINE_PREVIEW_CHARS = 500;

export type BodyTreeBinding = {
  render: (value: unknown) => ReactNode;
  openLabel: string;
  fallbackNotice?: (truncated: boolean) => ReactNode;
};

/** Modal content: full body + copy / JSON-format / word-wrap toolbar. Only mounts
 *  when the modal is open, so JSON.parse runs at most once per open (memoized). */
export function BodyViewer({
  body,
  truncated,
  value,
  renderTree,
}: {
  body: string;
  truncated: boolean;
  value?: unknown;
  renderTree?: (value: unknown) => ReactNode;
}) {
  const [formatted, setFormatted] = useState(false);
  const [wrap, setWrap] = useState(true);
  const [copied, setCopied] = useState(false);
  const [tree, setTree] = useState(value !== undefined && renderTree !== undefined);
  const pretty = useMemo(() => {
    try {
      return JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      return null;
    }
  }, [body]);
  const text = formatted && pretty != null ? pretty : body;
  // Revert the "복사됨" confirmation after a moment; cleanup cancels a pending
  // revert on rapid re-copy or unmount (modal close).
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  // Only confirm on an actual successful write — a rejected/unavailable
  // clipboard must NOT show false success.
  function copy() {
    void (async () => {
      try {
        await navigator.clipboard?.writeText(text);
        setCopied(true);
      } catch {
        // clipboard unavailable or denied — leave the label as "복사"
      }
    })();
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {truncated && <Callout variant="warn">1 MiB에서 잘림 — 실제 응답은 더 큼</Callout>}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={copy}
          aria-live="polite"
          className="rounded bg-slate-200 px-2 py-0.5 text-xs hover:bg-slate-300"
        >
          {copied ? "복사됨" : "복사"}
        </button>
        {pretty != null && (
          <button
            type="button"
            aria-pressed={formatted}
            onClick={() => setFormatted((f) => !f)}
            className="rounded bg-slate-200 px-2 py-0.5 text-xs hover:bg-slate-300"
          >
            {formatted ? "원본" : "JSON 포맷"}
          </button>
        )}
        <button
          type="button"
          aria-pressed={wrap}
          onClick={() => setWrap((w) => !w)}
          className="rounded bg-slate-200 px-2 py-0.5 text-xs hover:bg-slate-300"
        >
          {wrap ? "줄바꿈: 켜짐" : "줄바꿈: 꺼짐"}
        </button>
        {value !== undefined && renderTree !== undefined && (
          <button
            type="button"
            aria-pressed={tree}
            onClick={() => setTree((t) => !t)}
            className="rounded bg-slate-200 px-2 py-0.5 text-xs hover:bg-slate-300"
          >
            {tree ? "원본" : "트리"}
          </button>
        )}
      </div>
      {tree && value !== undefined && renderTree !== undefined ? (
        <div className="min-h-0 flex-1 overflow-auto">{renderTree(value)}</div>
      ) : (
        <pre
          className={[
            "min-h-0 flex-1 overflow-auto rounded bg-slate-50 p-3 text-xs",
            wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre",
          ].join(" ")}
        >
          {text}
        </pre>
      )}
    </div>
  );
}

/** Request/response body block: inline-full when short, else a 500-char preview
 *  with a "전체 보기" button that opens the full body in a modal.
 *  When `tree` is passed (response side) and the body is valid JSON & not
 *  truncated, renders `tree.render(parsed)` instead of raw text. */
export function BodyBlock({
  body,
  truncated = false,
  label,
  tree,
}: {
  body: string;
  truncated?: boolean;
  label: string;
  tree?: BodyTreeBinding;
}) {
  const [open, setOpen] = useState(false);
  // Depend on the boolean, never the `tree` object (fresh literal each render).
  const hasTree = tree !== undefined;
  const parsed = useMemo<{ value: unknown } | undefined>(() => {
    if (!hasTree || truncated) return undefined;
    try {
      return { value: JSON.parse(body) as unknown };
    } catch {
      return undefined;
    }
  }, [body, truncated, hasTree]);

  if (!body) return null;

  // Response body, valid JSON, not truncated → interactive tree.
  if (parsed && tree) {
    const isLong = body.length > INLINE_PREVIEW_CHARS;
    if (!isLong) {
      return <div className="mb-2">{tree.render(parsed.value)}</div>;
    }
    return (
      <div className="mb-2">
        <div className="mb-1 flex items-center gap-2">
          <span className="text-xs text-slate-500">
            {label} · {body.length.toLocaleString()}자
          </span>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="rounded bg-slate-200 px-2 py-0.5 text-xs hover:bg-slate-300"
          >
            {tree.openLabel}
          </button>
        </div>
        <Modal open={open} onClose={() => setOpen(false)} title={label}>
          <BodyViewer
            body={body}
            truncated={truncated}
            value={parsed.value}
            renderTree={tree.render}
          />
        </Modal>
      </div>
    );
  }

  // Fallback: request body, non-JSON, or truncated → raw rendering.
  const isLong = body.length > INLINE_PREVIEW_CHARS || truncated;
  const notice = tree?.fallbackNotice ? tree.fallbackNotice(truncated) : null;
  if (!isLong) {
    return (
      <div className="mb-2">
        {notice}
        <pre className="whitespace-pre-wrap break-all rounded bg-white p-2 text-xs">{body}</pre>
      </div>
    );
  }
  return (
    <div className="mb-2">
      {notice}
      <div className="mb-1 flex items-center gap-2">
        <span className="text-xs text-slate-500">
          {label} · {body.length.toLocaleString()}자{truncated ? " (잘림)" : ""}
        </span>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded bg-slate-200 px-2 py-0.5 text-xs hover:bg-slate-300"
        >
          전체 보기
        </button>
      </div>
      <pre className="whitespace-pre-wrap break-all rounded bg-white p-2 text-xs">
        {body.slice(0, INLINE_PREVIEW_CHARS)}…
      </pre>
      <Modal open={open} onClose={() => setOpen(false)} title={label}>
        <BodyViewer body={body} truncated={truncated} />
      </Modal>
    </div>
  );
}
