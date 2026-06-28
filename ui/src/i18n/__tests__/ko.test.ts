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
    expect(ko.runDialog.title).toBe("실행 설정");
    expect(ko.runDialog.sectionAdvancedTitle).toContain("고급");
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

describe("ko.common 네임스페이스 (R2, R4, R7)", () => {
  it("common 네임스페이스의 핵심 키가 전부 존재하고 비어 있지 않다", () => {
    const stringKeys = [
      "loading",
      "loadingRuns",
      "notFound",
      "save",
      "saving",
      "cancel",
      "close",
      "delete",
      "edit",
      "add",
      "remove",
      "moveUp",
      "moveDown",
      "abort",
      "aborting",
      "parsing",
    ] as const;
    for (const k of stringKeys) {
      expect(ko.common[k], `common.${k}`).toBeTypeOf("string");
      expect(ko.common[k].length, `common.${k}`).toBeGreaterThan(0);
    }
  });

  it("common.failedToLoad 는 msg 를 포함한 문자열을 반환한다", () => {
    const result = ko.common.failedToLoad("네트워크 오류");
    expect(result).toBeTypeOf("string");
    expect(result).toContain("불러오기 실패");
    expect(result).toContain("네트워크 오류");
  });
});

describe("Task 7+8 신규 키 (closed+curve / ramp_down)", () => {
  it("glossary.vuCurve — VU 곡선 설명 존재", () => {
    expect(ko.glossary.vuCurve).toBeTypeOf("string");
    expect(ko.glossary.vuCurve.length).toBeGreaterThan(0);
    expect(ko.glossary.vuCurve).toContain("VU 곡선");
  });

  it("glossary.rampDown — 줄이는 방식 설명 존재", () => {
    expect(ko.glossary.rampDown).toBeTypeOf("string");
    expect(ko.glossary.rampDown.length).toBeGreaterThan(0);
    expect(ko.glossary.rampDown).toContain("줄이는 방식");
  });

  it("loadModel 신규 키 6종 존재", () => {
    expect(ko.loadModel.curveTargetVu).toBeTypeOf("string");
    expect(ko.loadModel.curveTargetVu.length).toBeGreaterThan(0);
    expect(ko.loadModel.curveTargetRps).toBeTypeOf("string");
    expect(ko.loadModel.curveHintVu).toBeTypeOf("string");
    expect(ko.loadModel.curveHintRps).toBeTypeOf("string");
    expect(ko.loadModel.curvePreviewAriaVu).toBeTypeOf("string");
    expect(ko.loadModel.curvePreviewAriaRps).toBeTypeOf("string");
    expect(ko.loadModel.rampDownLabel).toBeTypeOf("string");
    expect(ko.loadModel.rampDownGraceful).toBeTypeOf("string");
    expect(ko.loadModel.rampDownImmediate).toBeTypeOf("string");
    expect(ko.loadModel.rampDownGraceful).toContain("요청을 마친 뒤");
    expect(ko.loadModel.rampDownImmediate).toContain("즉시");
  });

  it("report.headlineClosedCurve — 함수형 카탈로그, common 인자 수용", () => {
    const result = ko.report.headlineClosedCurve({
      duration: "1분",
      count: "12,345",
      p95: "0.21초",
      errPct: "0.3%",
    });
    expect(result).toBeTypeOf("string");
    expect(result).toContain("단계별 VU 곡선으로");
    expect(result).toContain("12,345회 요청");
  });
});
