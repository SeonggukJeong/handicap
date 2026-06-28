import { describe, it, expect } from "vitest";
import { ko } from "../ko";

describe("editor redesign ko keys", () => {
  it("새 툴바/아웃라인/모달 키가 비어있지 않은 문자열이다", () => {
    expect(ko.editor.varsToggle).toBeTruthy();
    expect(ko.editor.varsToggleAria).toBeTruthy();
    expect(ko.editor.openYaml).toBeTruthy();
    expect(ko.editor.yamlModalTitle).toBeTruthy();
    expect(ko.editor.dragHandleAria("로그인")).toContain("로그인");
    expect(ko.editor.outlineRowAria("로그인")).toContain("로그인");
    // ADR-0035: 아웃라인/변수 패널의 사용자 노출 문구도 ko 경유 (finding 3)
    expect(ko.editor.varsPanelAria).toBeTruthy();
    expect(ko.editor.urlMissingTitle).toBe("URL이 비어 있습니다");
    expect(ko.editor.containerLoop).toBeTruthy();
    expect(ko.editor.containerIf).toBeTruthy();
    expect(ko.editor.containerParallel).toBeTruthy();
  });

  it("죽은 UI 참조 문구 정정 (C1) — '탭'/'캔버스' 제거", () => {
    expect(ko.editor.problemGateAction).toBe("YAML 열어 확인");
    expect(ko.editor.problemGateAction).not.toContain("탭");
    expect(ko.editor.problemGateIntro).not.toContain("캔버스");
    expect(ko.editor.problemGateIntro).toContain("에디터");
  });

  it("죽은 탭 키가 제거됐다 (Task 4)", () => {
    const e = ko.editor as Record<string, unknown>;
    expect(e.tabCanvas).toBeUndefined();
    expect(e.tabYaml).toBeUndefined();
    expect(e.yamlTabNoInspector).toBeUndefined();
  });
});
