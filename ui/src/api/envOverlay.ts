/** One editable per-run env override row. Lifted out of RunDialog so the picker
 *  and the merge fn form a reusable unit (spec §7: future scenario-editor test-run). */
export type EnvEntry = { key: string; value: string };

/** Merge a selected environment's vars (base layer) with per-run override rows.
 *  Priority: base < override (override wins). Empty/whitespace override keys are
 *  dropped and keys are trimmed — identical to RunDialog's previous submit loop
 *  (`for {key,value} of envEntries { k=key.trim(); if(k) env[k]=value }`,
 *  RunDialog.tsx:121-125). With an empty `base` the result is byte-identical to
 *  that loop, so "no environment selected" stays back-compatible and prefill
 *  (resolved snapshot) re-submits unchanged. */
export function resolveEnv(
  base: Record<string, string>,
  overrides: EnvEntry[],
): Record<string, string> {
  const out: Record<string, string> = { ...base };
  for (const { key, value } of overrides) {
    const k = key.trim();
    if (k) out[k] = value;
  }
  return out;
}
