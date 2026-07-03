/** 인스펙터 섹션 열림 상태의 localStorage 영속(R3). `onboarding/state.ts` 이디엄:
 *  localStorage 불가/오염 시 fail-soft(기본값·no-op) — 기능 저하는 "기본 접힘"뿐. */
export type SectionKey = "headers" | "body" | "timing" | "assert" | "extract";
export type SectionPrefs = Record<SectionKey, boolean>;

export const DEFAULT_SECTION_PREFS: SectionPrefs = {
  headers: false,
  body: false,
  timing: false,
  assert: false,
  extract: false,
};

const KEY = "handicap:editor:inspector-sections:v1";

export function loadSectionPrefs(): SectionPrefs {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === null) return { ...DEFAULT_SECTION_PREFS };
    const parsed: unknown = JSON.parse(raw);
    const out = { ...DEFAULT_SECTION_PREFS };
    if (typeof parsed === "object" && parsed !== null) {
      for (const k of Object.keys(DEFAULT_SECTION_PREFS) as SectionKey[]) {
        const v = (parsed as Record<string, unknown>)[k];
        if (typeof v === "boolean") out[k] = v;
      }
    }
    return out;
  } catch {
    return { ...DEFAULT_SECTION_PREFS };
  }
}

export function saveSectionPrefs(prefs: SectionPrefs): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // 프라이빗 모드 등 — 조용히 무시(세션 메모리 상태만으로 동작)
  }
}
