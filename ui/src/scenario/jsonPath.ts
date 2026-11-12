/** One step of a JSON path: an object key or an array index. */
export type Segment = { kind: "key"; key: string } | { kind: "index"; index: number };

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Characters the monitor server rejects in text fields (lockstep with Rust
 *  `is_forbidden_text_char`): C0/C1 controls + DEL, U+2028/2029, and bidi
 *  controls U+061C, U+200E/F, U+202A-202E, U+2066-2069. ZWJ/ZWNJ are allowed.
 *  `ch` is one code point. */
export function isForbiddenTextChar(ch: string): boolean {
  const cp = ch.codePointAt(0)!;
  return (
    cp < 0x20 ||
    (cp >= 0x7f && cp <= 0x9f) ||
    cp === 0x2028 ||
    cp === 0x2029 ||
    cp === 0x061c ||
    cp === 0x200e ||
    cp === 0x200f ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2066 && cp <= 0x2069)
  );
}

/** Escape a key for an RFC 9535 single-quoted name-selector. serde_json_path 0.7.2
 *  REJECTS raw control chars (< U+0020) inside the quotes ("expected an ending
 *  quote") — they MUST be \uXXXX. We escape the whole forbidden set
 *  (isForbiddenTextChar: controls, DEL, C1, line separators, bidi controls) so
 *  the path is also safe to store in a monitor board. Verified against the
 *  engine's locked dep. */
function escapeBracketKey(key: string): string {
  let out = "";
  for (const ch of key) {
    const cp = ch.codePointAt(0)!;
    if (ch === "\\") out += "\\\\";
    else if (ch === "'") out += "\\'";
    else if (isForbiddenTextChar(ch)) out += "\\u" + cp.toString(16).padStart(4, "0");
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
