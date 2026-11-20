/** 접어 둔 시나리오 그룹 이름의 localStorage 영속. editorPrefs 이디엄: 접근 불가/오염 시 조용히 기본값. */
const KEY = "handicap:scenarios:collapsed-groups:v1";

export function loadCollapsedGroups(): string[] {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    if (!parsed.every((v) => typeof v === "string")) return [];
    return parsed as string[];
  } catch {
    return [];
  }
}

export function saveCollapsedGroups(names: string[]): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(names));
  } catch {
    // 프라이빗 모드 등 — 세션 메모리 상태만으로 동작
  }
}
