const pad2 = (n: number) => String(n).padStart(2, "0");

/** Local `YYYY-MM-DD HH:MM:SS` from epoch ms. */
export function formatDateHms(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${formatHms(ms)}`;
}

/** Local 24h `HH:MM:SS` from epoch ms. */
export function formatHms(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
