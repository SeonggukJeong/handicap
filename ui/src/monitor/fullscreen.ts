/** Must be called synchronously from a user-gesture handler (before any await). */
export function enterFullscreen(): void {
  const el = document.documentElement;
  if (typeof el.requestFullscreen !== "function") return;
  try {
    const p = el.requestFullscreen() as Promise<void> | undefined;
    p?.catch(() => {});
  } catch {
    // unsupported / blocked — fullscreen is best-effort
  }
}

export function exitFullscreen(): void {
  if (!document.fullscreenElement) return;
  if (typeof document.exitFullscreen !== "function") return;
  try {
    const p = document.exitFullscreen() as Promise<void> | undefined;
    p?.catch(() => {});
  } catch {
    // ignore
  }
}

export function isFullscreen(): boolean {
  return Boolean(document.fullscreenElement);
}
