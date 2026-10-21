const pad2 = (n: number) => String(n).padStart(2, "0");

/** Local 24h `HH:MM:SS` from epoch ms. */
export function formatHms(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
