import { useEffect, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { ko } from "../../i18n/ko";
import { copyText } from "./copyText";

/** Marks a clickable response row (header row / JSON value row). Drag-copy only
 *  fires for selections that start and end inside such rows — text in an expanded
 *  confirm box below a row is not copied. */
export const PICK_ROW_ATTR = "data-pick-row";

const TOAST_MS = 1500;

function inPickRow(root: HTMLElement, n: Node | null): boolean {
  const el = n instanceof Element ? n : (n?.parentElement ?? null);
  const row = el?.closest(`[${PICK_ROW_ATTR}]`);
  return row != null && root.contains(row);
}

/** A row click does what the row's own button does — unless the click landed on a
 *  control (the button handles itself) or ended a drag selection (that is a copy). */
export function pickClick(e: MouseEvent, run: () => void) {
  if ((e.target as Element).closest("button, a, input, select, textarea")) return;
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed && sel.toString() !== "") return;
  run();
}

/** Copy-on-select for a container of pick rows: `onMouseUp` goes on the container,
 *  `feedback` must be rendered (an always-present polite live region + a short
 *  floating 「복사됨」 next to the pointer). */
export function usePickCopy(enabled: boolean) {
  const [toast, setToast] = useState<{ x: number; y: number; ok: boolean; n: number } | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(t);
  }, [toast]);

  const onMouseUp = (e: MouseEvent<HTMLElement>) => {
    if (!enabled) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const text = sel.toString();
    if (text.trim() === "") return;
    const root = e.currentTarget;
    if (!inPickRow(root, sel.anchorNode) || !inPickRow(root, sel.focusNode)) return;
    const { clientX: x, clientY: y } = e;
    void copyText(text).then((ok) => setToast((t) => ({ x, y, ok, n: (t?.n ?? 0) + 1 })));
  };

  const message = toast ? (toast.ok ? ko.common.copied : ko.common.copyFailed) : "";
  const feedback = enabled ? (
    <>
      <span role="status" aria-live="polite" className="sr-only">
        {message}
      </span>
      {toast &&
        createPortal(
          <span
            key={toast.n}
            aria-hidden="true"
            style={{
              left: Math.min(toast.x + 12, window.innerWidth - 240),
              top: Math.max(toast.y - 32, 4),
            }}
            className={`pointer-events-none fixed z-[70] rounded px-2 py-1 font-sans text-xs text-white shadow ${
              toast.ok ? "bg-slate-800" : "bg-amber-800"
            }`}
          >
            {message}
          </span>,
          document.body,
        )}
    </>
  ) : null;

  return { onMouseUp, feedback };
}
