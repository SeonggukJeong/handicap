import { describe, it, expect } from "vitest";
import { ko } from "../ko";

describe("ko 카탈로그", () => {
  it("핵심 용어 14종이 전부 비어 있지 않은 문자열이다 (잉여 키 추가 허용)", () => {
    const required = [
      "vu",
      "rps",
      "p50",
      "p95",
      "p99",
      "rampUp",
      "closedLoop",
      "openLoop",
      "thinkTime",
      "maxInFlight",
      "slo",
      "scenario",
      "step",
      "run",
    ] as const;
    for (const key of required) {
      const value = ko.glossary[key];
      expect(value, `glossary.${key}`).toBeTypeOf("string");
      expect(value.length, `glossary.${key}`).toBeGreaterThan(0);
    }
  });

  it("백분위 용어 설명은 '낮을수록 좋음' 방향성을 포함한다", () => {
    for (const key of ["p50", "p95", "p99"] as const) {
      expect(ko.glossary[key]).toContain("낮을수록 좋");
    }
  });

  it("U1b 네임스페이스(runDialog/loadModel/validation)가 비어 있지 않다", () => {
    expect(ko.runDialog.title).toBe("새 실행");
    expect(ko.runDialog.groupAdvanced).toContain("판정·고급");
    expect(ko.loadModel.vus).toContain("동시 사용자");
    expect(ko.loadModel.sizePresets.length).toBe(3);
    for (const p of ko.loadModel.sizePresets) {
      expect(p.vus).toBeGreaterThan(0);
      expect(p.durationSeconds).toBeGreaterThan(0);
    }
    expect(ko.validation.httpTimeout).toContain("1 ~ 600");
  });
});

describe("U2 카탈로그 (nav/breadcrumb/onboarding/empty/pages)", () => {
  it("nav/breadcrumb 키가 존재한다", () => {
    const navKeys = ["scenarios", "datasets", "environments", "schedules"] as const;
    for (const k of navKeys) {
      expect(ko.nav[k], `nav.${k}`).toBeTypeOf("string");
      expect(ko.nav[k].length).toBeGreaterThan(0);
    }
    const bcKeys = ["runs", "compare"] as const;
    for (const k of bcKeys) {
      expect(ko.breadcrumb[k], `breadcrumb.${k}`).toBeTypeOf("string");
      expect(ko.breadcrumb[k].length).toBeGreaterThan(0);
    }
  });

  it("onboarding 3단계 문구가 존재한다", () => {
    const keys = [
      "ariaLabel",
      "title",
      "dismiss",
      "done",
      "step1Title",
      "step1Desc",
      "step1Cta",
      "step2Title",
      "step2Desc",
      "step2Cta",
      "step2Blocked",
      "step3Title",
      "step3Desc",
      "step3Cta",
      "step3Blocked",
    ] as const;
    for (const k of keys) {
      expect(ko.onboarding[k], `onboarding.${k}`).toBeTypeOf("string");
      expect(ko.onboarding[k].length).toBeGreaterThan(0);
    }
  });

  it("empty 5종은 무엇+다음 행동 3요소 패턴", () => {
    expect(ko.empty.scenarios).toContain("API 요청");
    expect(ko.empty.scenarios).toContain("템플릿");
    expect(ko.empty.datasets).toContain("CSV");
    expect(ko.empty.environments).toContain("BASE_URL");
    expect(ko.empty.schedules).toContain("cron");
    expect(ko.empty.runs).toContain("실행");
    const ctaKeys = [
      "scenariosCta",
      "datasetsCta",
      "environmentsCta",
      "schedulesCta",
      "runsCta",
    ] as const;
    for (const k of ctaKeys) {
      expect(ko.empty[k], `empty.${k}`).toBeTypeOf("string");
      expect(ko.empty[k].length).toBeGreaterThan(0);
    }
  });

  it("pages chrome 라벨 스모크", () => {
    expect(ko.pages.newScenario).toBe("새 시나리오");
    expect(ko.pages.runScenario).toBe("실행하기");
    expect(ko.pages.newEnvironment).toBe("새 환경");
    expect(ko.pages.newSchedule).toBe("새 스케줄");
  });

  it("U3 editor/templates 네임스페이스 키가 비어 있지 않다", () => {
    const editorKeys = [
      "inspectorAria",
      "inspectorEmpty",
      "yamlTabNoInspector",
      "httpPanelTitle",
      "loopPanelTitle",
      "ifPanelTitle",
      "parallelPanelTitle",
      "assertionsLegend",
      "extractsLegend",
      "extractsHint",
      "urlLabel",
      "urlPlaceholder",
      "urlEmptyWarning",
      "urlMissingBadge",
      "canvasEmpty",
      "addHttpStep",
      "addHttpStepInLoop",
      "addLoop",
      "addIf",
      "addParallel",
      "containerCaption",
      "panelHint",
      "varCheatSheetLabel",
      "varCheatSheetContext",
      "variablesTitle",
      "variablesEmpty",
      "variablesAdd",
      "create",
      "creating",
      "cancel",
      "discardConfirm",
    ] as const;
    for (const k of editorKeys) {
      expect(ko.editor[k], `editor.${k}`).toBeTypeOf("string");
      expect(ko.editor[k].length, `editor.${k}`).toBeGreaterThan(0);
    }
    const tplKeys = [
      "galleryAria",
      "galleryTitle",
      "galleryHint",
      "blankName",
      "blankDesc",
      "getName",
      "getDesc",
      "loginName",
      "loginDesc",
      "dataName",
      "dataDesc",
    ] as const;
    for (const k of tplKeys) {
      expect(ko.templates[k], `templates.${k}`).toBeTypeOf("string");
      expect(ko.templates[k].length, `templates.${k}`).toBeGreaterThan(0);
    }
  });

  it("glossary 변수 표기 3분류(ADR-0014)가 표기 원문을 담는다", () => {
    expect(ko.glossary.varFlow).toContain("{{");
    expect(ko.glossary.varEnv).toContain("${ENV}");
    expect(ko.glossary.varSys).toContain("${vu_id}");
  });
});
