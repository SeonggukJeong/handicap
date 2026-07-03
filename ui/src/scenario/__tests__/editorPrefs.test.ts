import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SECTION_PREFS, loadSectionPrefs, saveSectionPrefs } from "../editorPrefs";

const KEY = "handicap:editor:inspector-sections:v1";

describe("editorPrefs — 섹션 열림 localStorage 영속 (R3)", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("저장이 없으면 기본값(전부 접힘)", () => {
    expect(loadSectionPrefs()).toEqual(DEFAULT_SECTION_PREFS);
  });

  it("save → load 라운드트립", () => {
    saveSectionPrefs({ ...DEFAULT_SECTION_PREFS, headers: true });
    expect(loadSectionPrefs()).toEqual({ ...DEFAULT_SECTION_PREFS, headers: true });
    expect(window.localStorage.getItem(KEY)).not.toBeNull();
  });

  it("malformed JSON이면 기본값 + 무throw (fail-soft)", () => {
    window.localStorage.setItem(KEY, "{not json");
    expect(loadSectionPrefs()).toEqual(DEFAULT_SECTION_PREFS);
  });

  it("비-boolean 값·미지 키는 기본값으로 강등", () => {
    window.localStorage.setItem(KEY, JSON.stringify({ headers: "yes", junk: 1, body: true }));
    const p = loadSectionPrefs();
    expect(p.headers).toBe(false);
    expect(p.body).toBe(true);
    expect(Object.keys(p).sort()).toEqual(Object.keys(DEFAULT_SECTION_PREFS).sort());
  });
});
