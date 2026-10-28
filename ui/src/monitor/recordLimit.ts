import type { PanelConfig } from "../api/monitors";

/** 보드 최악 기록 메모리(MB) 문자열: Σ bar_count × limitKb / 1024. */
export function worstCaseMb(panels: PanelConfig[], limitKb: number): string {
  const mb = (panels.reduce((n, p) => n + p.bar_count, 0) * limitKb) / 1024;
  return mb < 10 ? mb.toFixed(1) : Math.round(mb).toLocaleString("en-US");
}
