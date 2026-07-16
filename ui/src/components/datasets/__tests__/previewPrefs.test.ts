import { describe, it, expect, beforeEach } from "vitest";
import { loadPreviewPageSize, savePreviewPageSize } from "../previewPrefs";

const KEY = "handicap:dataset:preview-page-size:v1";

beforeEach(() => window.localStorage.clear());

describe("previewPrefs (fail-soft — editorPrefs 이디엄)", () => {
  it("미저장이면 기본 10", () => {
    expect(loadPreviewPageSize()).toBe(10);
  });

  it("save→load 왕복", () => {
    savePreviewPageSize(100);
    expect(loadPreviewPageSize()).toBe(100);
  });

  it("비옵션 값(37)·malformed('abc')는 기본 10", () => {
    window.localStorage.setItem(KEY, "37");
    expect(loadPreviewPageSize()).toBe(10);
    window.localStorage.setItem(KEY, "abc");
    expect(loadPreviewPageSize()).toBe(10);
  });
});
