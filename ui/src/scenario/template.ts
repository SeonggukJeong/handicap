/**
 * Display-time template resolver — mirrors the engine `${NAME}` / `${NAME:-default}` rules
 * (see `crates/engine/src/template.rs`) but is lenient: unresolved tokens stay verbatim
 * instead of erroring, since this is for diagnostic display, not request execution.
 *
 * - `${NAME}` → `env[NAME]` if present, else left as `${NAME}`.
 * - `${NAME:-default}` → `env[NAME]` if present, else `default`.
 * - `${vu_id}` / `${iter_id}` left as-is (runtime-only, no single display value).
 * - `{{name}}` flow vars left as-is (resolved per step at runtime).
 */
export function resolveForDisplay(
  template: string,
  env: Record<string, string>,
): string {
  let out = "";
  let i = 0;
  while (i < template.length) {
    const ch = template[i];
    const next = template[i + 1];

    if (ch === "$" && next === "{") {
      const end = template.indexOf("}", i + 2);
      if (end === -1) {
        out += template.slice(i);
        break;
      }
      const inner = template.slice(i + 2, end);
      const sep = inner.indexOf(":-");
      const name = (sep === -1 ? inner : inner.slice(0, sep)).trim();
      const def = sep === -1 ? null : inner.slice(sep + 2);
      if (name === "vu_id" || name === "iter_id") {
        out += template.slice(i, end + 1);
      } else if (name in env) {
        out += env[name];
      } else if (def !== null) {
        out += def;
      } else {
        out += template.slice(i, end + 1);
      }
      i = end + 1;
      continue;
    }

    out += ch;
    i += 1;
  }
  return out;
}
