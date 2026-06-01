export type BulkFormat = "header" | "form";

export interface ParseResult {
  entries: Record<string, string>;
  /** Count of separator-less or empty-key lines ignored (blank lines are NOT counted). */
  skipped: number;
}

// Decode one urlencoded token: '+' -> space, then percent-decode.
// `decodeURIComponent` throws on a malformed `%` sequence — preserve verbatim.
function decodeFormToken(s: string): string {
  const plusDecoded = s.replace(/\+/g, " ");
  try {
    return decodeURIComponent(plusDecoded);
  } catch {
    return plusDecoded;
  }
}

export function parseBulk(text: string, format: BulkFormat): ParseResult {
  const out: Record<string, string> = {};
  let skipped = 0;
  const rawPairs = format === "form" ? text.split(/[\n&]/) : text.split(/\n/);
  const sep = format === "form" ? "=" : ":";
  for (const raw of rawPairs) {
    const line = raw.trim();
    if (line === "") continue; // blank: silently skipped, not counted
    const at = line.indexOf(sep);
    if (at < 0) {
      skipped++;
      continue;
    }
    let key = line.slice(0, at).trim();
    let value = line.slice(at + 1).trim();
    if (format === "form") {
      key = decodeFormToken(key);
      value = decodeFormToken(value);
    }
    if (key === "") {
      skipped++;
      continue;
    }
    out[key] = value; // last-wins
  }
  return { entries: out, skipped };
}

// Escape only the chars that would break a round-trip through parseBulk(form).
// `%` MUST be escaped first so our own added escapes are not re-encoded.
// `=` is structural only in the KEY (value uses first-'=' split, so trailing '=' is safe).
function escapeFormToken(s: string, isKey: boolean): string {
  let out = s.replace(/%/g, "%25").replace(/\+/g, "%2B").replace(/&/g, "%26").replace(/\n/g, "%0A");
  if (isKey) out = out.replace(/=/g, "%3D");
  // leading/trailing spaces -> %20 (parse trims tokens); interior spaces stay raw.
  out = out
    .replace(/^ +/, (m) => "%20".repeat(m.length))
    .replace(/ +$/, (m) => "%20".repeat(m.length));
  return out;
}

export function formatEntries(entries: Record<string, string>, format: BulkFormat): string {
  const pairs = Object.entries(entries);
  if (format === "form") {
    return pairs
      .map(([k, v]) => `${escapeFormToken(k, true)}=${escapeFormToken(v, false)}`)
      .join("\n");
  }
  return pairs.map(([k, v]) => `${k}: ${v}`).join("\n");
}
