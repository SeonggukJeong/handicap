/**
 * Normalize a candidate filename (e.g. a scenario name) into a string safe for
 * the filesystem and showSaveFilePicker's `suggestedName`. Removes path
 * separators / reserved characters / control characters and trims.
 *
 * Returns "" for nullish or fully-stripped input — callers apply their own
 * fallback, e.g. `sanitizeFilename(name) || "scenario"`. Must never throw on
 * nullish input (the invalid-buffer export path passes `undefined`).
 */
export function sanitizeFilename(name: string | undefined | null): string {
  if (name == null) return "";
  // eslint-disable-next-line no-control-regex -- intentionally strip C0 control chars from filenames
  return name.replace(/[/\\:*?"<>|\x00-\x1f]/g, "").trim();
}
