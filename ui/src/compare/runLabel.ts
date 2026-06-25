// Short human-readable run label, shared by the compare matrix headers and the
// overlay legend so the two never drift (spec R5).
export function runShortLabel(id: string): string {
  return `#${id.slice(-6)}`;
}
