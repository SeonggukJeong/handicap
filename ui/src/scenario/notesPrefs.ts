/** 공유 메모 접힘 상태의 localStorage 영속(spec R3). editorPrefs 이디엄:
 *  localStorage 불가/오염 시 fail-soft — 기능 저하는 "항상 펼침"뿐. */
const KEY = "handicap:scenario-notes-collapsed:v1";

export function loadNotesCollapsed(): Record<string, true> {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    const out: Record<string, true> = {};
    if (typeof parsed === "object" && parsed !== null) {
      for (const [k, v] of Object.entries(parsed)) {
        if (v === true) out[k] = true;
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** collapsed=false는 키 삭제(맵 최소 유지) — "현재 시나리오 키 한정 정리"(spec R3)도 이 경로. */
export function setNotesCollapsed(id: string, collapsed: boolean): void {
  try {
    const map = loadNotesCollapsed();
    if (collapsed) map[id] = true;
    else delete map[id];
    window.localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    // 프라이빗 모드 등 — 조용히 무시(세션 컴포넌트 상태만으로 동작)
  }
}
