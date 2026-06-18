/** One step of a JSON path: an object key or an array index. */
export type Segment = { kind: "key"; key: string } | { kind: "index"; index: number };

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Escape a key for an RFC 9535 single-quoted name-selector. serde_json_path 0.7.2
 *  REJECTS raw control chars (< U+0020) inside the quotes ("expected an ending
 *  quote") — they MUST be \uXXXX. Verified against the engine's locked dep. */
function escapeBracketKey(key: string): string {
  let out = "";
  for (const ch of key) {
    const cp = ch.codePointAt(0)!;
    if (ch === "\\") out += "\\\\";
    else if (ch === "'") out += "\\'";
    else if (cp < 0x20) out += "\\u" + cp.toString(16).padStart(4, "0");
    else out += ch;
  }
  return out;
}

/** Build a JSONPath string from path segments, lockstep with the engine's
 *  serde_json_path consumer (crates/engine/src/extract.rs). Identifier keys use
 *  dot notation; everything else uses bracket-quote with RFC 9535 escaping. */
export function segmentsToPath(segments: ReadonlyArray<Segment>): string {
  let out = "$";
  for (const seg of segments) {
    if (seg.kind === "index") out += `[${seg.index}]`;
    else if (IDENT_RE.test(seg.key)) out += `.${seg.key}`;
    else out += `['${escapeBracketKey(seg.key)}']`;
  }
  return out;
}

/** Suggest a flow-variable name from a key/header/cookie name: non-identifier
 *  chars → "_", leading digit → "_"-prefixed, empty → "value". */
export function suggestVarName(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_]/g, "_");
  if (cleaned.length === 0) return "value";
  return /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned;
}
