// requestFullscreen() settles asynchronously, so document.fullscreenElement is
// still null right after the call. Keep the pending request so exitFullscreen
// can wait for it before deciding whether there is anything to exit.
let pending: Promise<void> | null = null;

/** Must be called synchronously from a user-gesture handler (before any await). */
export function enterFullscreen(): void {
  const el = document.documentElement;
  if (typeof el.requestFullscreen !== "function") return;
  try {
    const p: Promise<void> = Promise.resolve(el.requestFullscreen()).then(
      () => {},
      () => {},
    );
    pending = p;
    void p.then(() => {
      if (pending === p) pending = null;
    });
  } catch {
    // unsupported / blocked — fullscreen is best-effort
  }
}

function exitNow(): void {
  if (!document.fullscreenElement) return;
  if (typeof document.exitFullscreen !== "function") return;
  try {
    Promise.resolve(document.exitFullscreen()).catch(() => {});
  } catch {
    // ignore
  }
}

export function exitFullscreen(): void {
  if (pending) {
    void pending.then(exitNow);
    return;
  }
  exitNow();
}

export function isFullscreen(): boolean {
  return Boolean(document.fullscreenElement);
}
