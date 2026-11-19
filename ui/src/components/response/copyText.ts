/** Copy `text` to the clipboard; resolves true only when a copy really happened.
 *
 *  The async Clipboard API exists only in secure contexts (https / localhost) — a
 *  desktop "server" mode reached from another PC over `http://192.168…` has none, so
 *  fall back to `execCommand("copy")` on a hidden textarea. The user's own text
 *  selection is put back afterwards (the fallback has to select the textarea). */
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // denied or unavailable — try the legacy path below
    }
  }
  return legacyCopy(text);
}

function legacyCopy(text: string): boolean {
  if (typeof document.execCommand !== "function") return false;
  const sel = window.getSelection();
  const saved: Range[] = [];
  if (sel) for (let i = 0; i < sel.rangeCount; i++) saved.push(sel.getRangeAt(i));
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.top = "0";
  ta.style.left = "0";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  let ok = false;
  try {
    ta.select();
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  } finally {
    ta.remove();
    active?.focus({ preventScroll: true });
    if (sel) {
      sel.removeAllRanges();
      for (const r of saved) sel.addRange(r);
    }
  }
  return ok;
}
