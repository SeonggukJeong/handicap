export interface CommonHeader {
  name: string;
  value: string;
}

// Placeholder curation (spec §5). Cookie is intentionally excluded (ADR-0018:
// per-VU automatic cookie jar manages the session; a manual Cookie header misleads).
export const COMMON_HEADERS: CommonHeader[] = [
  { name: "Content-Type", value: "application/json" },
  { name: "Accept", value: "application/json" },
  { name: "Authorization", value: "Bearer {{token}}" },
  { name: "Accept-Encoding", value: "gzip, deflate" },
  { name: "Accept-Language", value: "en-US" },
  { name: "Cache-Control", value: "no-cache" },
  { name: "User-Agent", value: "handicap-loadtest" },
  { name: "X-Request-Id", value: "{{requestId}}" },
  { name: "Origin", value: "" },
  { name: "Referer", value: "" },
];

/** Case-insensitive, trimmed lookup. Used for datalist value-seeding only — the
 *  stored key remains the literal the user typed/picked (no case normalization). */
export function findCommonHeader(name: string): CommonHeader | undefined {
  const lower = name.trim().toLowerCase();
  if (lower === "") return undefined;
  return COMMON_HEADERS.find((h) => h.name.toLowerCase() === lower);
}
