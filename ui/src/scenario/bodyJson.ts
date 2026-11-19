const MAX_JSON_UNWRAP = 3;

/** Unwrap one JSON-in-string up to 3 layers; an object/array by then -> it, else null.
 *  Mirrors Rust `unwrap_json_str` (only `{`/`[`/`"` after JSON whitespace are tried). */
function unwrapJsonString(s: string): { value: object; layers: number } | null {
  if (!/^[ \t\n\r]*["[{]/.test(s)) return null;
  let cur: unknown = s;
  for (let i = 1; i <= MAX_JSON_UNWRAP; i++) {
    if (typeof cur !== "string") return null;
    try {
      cur = JSON.parse(cur);
    } catch {
      return null;
    }
    if (typeof cur === "object" && cur !== null) return { value: cur, layers: i };
  }
  return null;
}

/** In place: string fields that are JSON-in-string objects/arrays become that value
 *  (each field up to 3 layers). Iterative — the body may be too deep to recurse.
 *  Returns the number of layers unwrapped. */
function unwrapNestedInPlace(root: unknown): number {
  let count = 0;
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const v = stack.pop();
    if (v === null || typeof v !== "object") continue;
    const rec = v as Record<string, unknown>;
    for (const key of Object.keys(rec)) {
      const child = rec[key];
      if (typeof child === "string") {
        const u = unwrapJsonString(child);
        if (u === null) continue;
        // `key` is an own property (JSON.parse), so even `"__proto__"` is updated in place.
        rec[key] = u.value;
        count += u.layers;
        stack.push(u.value);
      } else {
        stack.push(child);
      }
    }
  }
  return count;
}

/** Body JSON for the response tree: JSON-in-string unwrapped up to 3 layers at the root
 *  (mirrors Rust `parse_body_json`; not an object/array by then -> the first parsed value),
 *  then string fields holding JSON-in-string objects/arrays are unwrapped too. The server
 *  looks a path up in the root-only value first and in the nested-unwrapped one only when
 *  missing (Rust `BodyJson::path_first`), so every path in this tree resolves there.
 *  `unwrapped` = total layers unwrapped. Not JSON -> null. */
export function parseBodyJson(body: string): { value: unknown; unwrapped: number } | null {
  let first: unknown;
  try {
    first = JSON.parse(body);
  } catch {
    return null;
  }
  const root = typeof first === "string" ? unwrapJsonString(first) : null;
  const value = root !== null ? root.value : first;
  const nested = unwrapNestedInPlace(value);
  return { value, unwrapped: (root?.layers ?? 0) + nested };
}
