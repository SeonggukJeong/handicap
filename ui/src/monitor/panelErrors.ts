// The server prefixes per-panel validation errors with `칸 N: ` (N is 1-based).
// Board-level errors carry no prefix and return null here.
export function parsePanelError(message: string): { index: number; reason: string } | null {
  const m = /^칸 (\d+): (.+)$/s.exec(message);
  if (!m) return null;
  return { index: Number(m[1]) - 1, reason: m[2] };
}

// Group-level errors are prefixed `점검 묶음 N: ` (N is 1-based, first-appearance order).
export function parseGroupError(message: string): { groupNumber: number; reason: string } | null {
  const m = /^점검 묶음 (\d+): (.+)$/s.exec(message);
  if (!m) return null;
  return { groupNumber: Number(m[1]), reason: m[2] };
}
