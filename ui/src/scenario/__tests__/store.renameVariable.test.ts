import { describe, it, expect, beforeEach } from "vitest";
import { useScenarioEditor } from "../store";

const reset = () => useScenarioEditor.setState(useScenarioEditor.getInitialState());

const FLAT = `version: 1
name: t
cookie_jar: auto
variables:
  token: seed
steps:
  - id: 01HX0000000000000000000001
    name: s
    type: http
    request:
      method: GET
      url: "/x?a={{token}}&b={{token:num}}"
      headers: {}
`;

const PARALLEL = `version: 1
name: t
cookie_jar: auto
variables: {}
steps:
  - id: 01HX0000000000000000000050
    name: par
    type: parallel
    branches:
      - name: alpha
        steps:
          - id: 01HX0000000000000000000051
            name: leaf
            type: http
            request: { method: GET, url: "/{{s}}", headers: {} }
            extract:
              - from: body
                path: $.t
                var: s
`;

const SETUP = `version: 1
name: t
cookie_jar: auto
variables: {}
setup:
  steps:
    - id: 01HX0000000000000000000060
      name: login
      type: http
      request: { method: POST, url: "/login", headers: {} }
      extract:
        - from: body
          path: $.token
          var: token
steps:
  - id: 01HX0000000000000000000061
    name: me
    type: http
    request:
      method: GET
      url: "/me"
      headers:
        Authorization: "Bearer {{token}}"
`;

describe("store.renameVariable", () => {
  beforeEach(reset);

  it("renames a setup-only extract and its main-step reference together", () => {
    useScenarioEditor.getState().loadFromString(SETUP);
    const err = useScenarioEditor.getState().renameVariable("token", "auth");
    expect(err).toBeNull();
    const st = useScenarioEditor.getState();
    expect(st.yamlError).toBeNull();
    const setupStep = st.model?.setup?.steps[0];
    expect(setupStep?.extract.map((e) => e.var)).toEqual(["auth"]);
    const main = st.model?.steps[0];
    expect(main?.type === "http" && main.request.headers).toEqual({
      Authorization: "Bearer {{auth}}",
    });
    expect(st.yamlText).not.toContain("{{token");
    expect(st.yamlText).not.toContain("var: token");
  });

  it("happy: renames declaration key + all references (cast preserved), commits transactionally", () => {
    const s = useScenarioEditor.getState();
    s.loadFromString(FLAT);
    const err = useScenarioEditor.getState().renameVariable("token", "auth");
    expect(err).toBeNull();
    const yaml = useScenarioEditor.getState().yamlText;
    expect(yaml).toContain("auth: seed");
    expect(yaml).toContain("{{auth}}");
    expect(yaml).toContain("{{auth:num}}"); // cast 보존
    expect(yaml).not.toContain("{{token"); // 옛 참조 없음
    expect(useScenarioEditor.getState().yamlError).toBeNull();
  });

  it("no-op on self / blank / illegal / collision — state unchanged, error code returned", () => {
    const s = useScenarioEditor.getState();
    s.loadFromString(FLAT);
    const before = useScenarioEditor.getState().yamlText;
    expect(useScenarioEditor.getState().renameVariable("token", "token")).toBe("self");
    expect(useScenarioEditor.getState().renameVariable("token", "")).toBe("invalid");
    expect(useScenarioEditor.getState().renameVariable("token", "a b")).toBe("invalid");
    expect(useScenarioEditor.getState().renameVariable("token", "a:b")).toBe("invalid");
    expect(useScenarioEditor.getState().yamlText).toBe(before); // self/blank/illegal 모두 무변이
    // 충돌: 이미 참조되는 이름(자기 참조 token은 self가 먼저지만, 새 var 추가로 충돌 유발)
    useScenarioEditor.getState().setVariable("taken", "x");
    expect(useScenarioEditor.getState().renameVariable("token", "taken")).toBe("collision");
    expect(useScenarioEditor.getState().yamlText).toContain("token: seed"); // 무변이
  });

  it("no-op (shadow) when oldName is also extracted in a parallel branch", () => {
    const s = useScenarioEditor.getState();
    s.loadFromString(PARALLEL);
    expect(useScenarioEditor.getState().renameVariable("s", "renamed")).toBe("shadow");
  });

  it("no-op during yamlError (edit gate) — does not corrupt state", () => {
    const s = useScenarioEditor.getState();
    s.loadFromString(FLAT);
    s.setPendingYamlText("version: 1\nname: t\nsteps: [\n"); // 깨진 버퍼
    s.commitPendingYaml(); // yamlError 세팅
    expect(useScenarioEditor.getState().yamlError).not.toBeNull();
    expect(useScenarioEditor.getState().renameVariable("token", "auth")).toBe("invalid");
  });

  it("increments renameEpoch on a successful rename, not on a no-op/failure", () => {
    const s = useScenarioEditor.getState();
    s.loadFromString(FLAT);
    const before = useScenarioEditor.getState().renameEpoch;
    const ok = useScenarioEditor.getState().renameVariable("token", "auth");
    expect(ok).toBeNull();
    expect(useScenarioEditor.getState().renameEpoch).toBe(before + 1);
    // 실패는 미증가
    const err = useScenarioEditor.getState().renameVariable("auth", "auth"); // self → 미증가
    expect(err).not.toBeNull();
    expect(useScenarioEditor.getState().renameEpoch).toBe(before + 1);
  });
});
