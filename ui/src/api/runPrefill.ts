import { ProfileSchema, type Profile } from "./schemas";

/** Decode a stored run/preset env (arbitrary JSON value) into a string→string
 *  record, dropping non-string values. The backend now rejects non-string env at
 *  the boundary, but stored/legacy values may still be anything — be defensive.
 *  Used to prefill the run dialog from a past run (spec §5). */
export function envValueToRecord(env: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (env && typeof env === "object" && !Array.isArray(env)) {
    for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
  }
  return out;
}

/** Re-parse a run's `profile` into a clean `Profile`.
 *
 *  WHY THIS EXISTS: `RunSchema.profile` nests `ProfileSchema`, and Zod's nested
 *  `.default()` leaks `number | undefined` into the parent infer (ui/CLAUDE.md
 *  "Zod 중첩 .default() input 타입 누출"). So `run.profile` is typed with
 *  `ramp_up_seconds`/`loop_breakdown_cap` as `number | undefined`, which is NOT
 *  assignable to the standalone `Profile` type that `RunPrefill`/`useCreateRun`
 *  expect — a hard `tsc -b` error. Re-parsing collapses the type to ProfileSchema's
 *  output (clean `number`). At runtime it's an idempotent re-validation (the value
 *  was already ProfileSchema-validated when RunSchema parsed it). */
export function normalizeProfile(profile: unknown): Profile {
  return ProfileSchema.parse(profile);
}

/** Effective run length in seconds. Open-loop curve runs (S-D) store
 *  `duration_seconds: 0` and carry the real length in `stages` (the worker derives
 *  the engine deadline as the stage-duration sum); every other run uses the flat
 *  `duration_seconds`. Mirrors the worker's `run_duration_secs`. Takes only the two
 *  fields it reads so a `RunSchema.profile` (nested-default leaks `number|undefined`
 *  on other fields — ui/CLAUDE.md) is assignable without `normalizeProfile`. */
export function profileDurationSeconds(
  profile: Pick<Profile, "duration_seconds" | "stages">,
): number {
  const stages = profile.stages;
  if (stages && stages.length > 0) {
    return stages.reduce((acc, s) => acc + s.duration_seconds, 0);
  }
  return profile.duration_seconds;
}

/** Shape of RunDialog's `initial` prop — a past run's profile + decoded env. */
export type RunPrefill = { profile: Profile; env: Record<string, string> };
