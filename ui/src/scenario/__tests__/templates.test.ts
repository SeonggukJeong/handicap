import { describe, expect, it } from "vitest";
import { BLANK_TEMPLATE_YAML, SCENARIO_TEMPLATES } from "../templates";
import { parseScenarioDoc, serializeDoc } from "../yamlDoc";
import { useScenarioEditor } from "../store";
import { ko } from "../../i18n/ko";

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

describe("SCENARIO_TEMPLATES", () => {
  it("4종(blank/simple-get/login-flow/data-driven)이 이 순서로 있다", () => {
    expect(SCENARIO_TEMPLATES.map((t) => t.id)).toEqual([
      "blank",
      "simple-get",
      "login-flow",
      "data-driven",
    ]);
  });

  it("4종 전부 parseScenarioDoc(Zod 게이트)을 통과한다", () => {
    for (const t of SCENARIO_TEMPLATES) {
      const parsed = parseScenarioDoc(t.yaml);
      expect("model" in parsed, `${t.id}: ${"error" in parsed ? parsed.error : ""}`).toBe(true);
    }
  });

  it("모든 step id가 유효 ULID(I/L/O/U 제외 26자)이고 시나리오 안에서 유일하다", () => {
    for (const t of SCENARIO_TEMPLATES) {
      const ids = [...t.yaml.matchAll(/^\s*-?\s*id:\s*(\S+)$/gm)].map((m) => m[1]);
      for (const id of ids) expect(id, `${t.id}/${id}`).toMatch(ULID_RE);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("한국어 주석이 Document round-trip(serializeDoc) 후에도 보존된다", () => {
    const login = SCENARIO_TEMPLATES.find((t) => t.id === "login-flow")!;
    const parsed = parseScenarioDoc(login.yaml);
    if (!("doc" in parsed)) throw new Error("parse failed");
    const out = serializeDoc(parsed.doc);
    expect(out).toContain("값 추출");
    expect(out).toContain("환경");
  });

  it("blank 템플릿은 store.resetEmpty의 STARTER와 canonical 동일(드리프트 가드)", () => {
    // store.ts의 private STARTER_YAML 사본과의 조용한 drift를 canonical 비교로 차단.
    useScenarioEditor.setState(useScenarioEditor.getInitialState());
    useScenarioEditor.getState().resetEmpty();
    const fromStore = useScenarioEditor.getState().yamlText;
    const parsed = parseScenarioDoc(BLANK_TEMPLATE_YAML);
    if (!("doc" in parsed)) throw new Error("blank template parse failed");
    expect(serializeDoc(parsed.doc)).toBe(fromStore);
  });

  it("name/description은 ko.templates 카탈로그를 쓴다", () => {
    const byId = Object.fromEntries(SCENARIO_TEMPLATES.map((t) => [t.id, t]));
    expect(byId["simple-get"].name).toBe(ko.templates.getName);
    expect(byId["login-flow"].description).toBe(ko.templates.loginDesc);
  });

  it("로그인 흐름은 extract→{{token}} 사용을 시연한다", () => {
    const login = SCENARIO_TEMPLATES.find((t) => t.id === "login-flow")!;
    expect(login.yaml).toContain("var: token");
    expect(login.yaml).toContain("Bearer {{token}}");
    expect(login.yaml).toContain("${BASE_URL}");
  });
});
