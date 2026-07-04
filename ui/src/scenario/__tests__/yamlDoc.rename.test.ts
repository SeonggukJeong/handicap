import { describe, it, expect } from "vitest";
import { parseDocument } from "yaml";
import { applyEdit } from "../yamlDoc";

function rename(yaml: string, oldName: string, newName: string): string {
  const doc = parseDocument(yaml);
  applyEdit(doc, { type: "renameVariable", oldName, newName });
  return String(doc);
}

describe("applyEdit renameVariable", () => {
  it("(a) renames the variables map key, preserving value + comment + position", () => {
    const out = rename(
      `version: 1\nname: t\nvariables:\n  old: "keepme" # note\n  other: x\nsteps: []\n`,
      "old",
      "fresh",
    );
    expect(out).toContain('fresh: "keepme" # note');
    expect(out).not.toMatch(/\bold:/);
    expect(out).toContain("other: x"); // 형제 무변
  });

  it("(b) renames extract[].var structurally, not any scalar equal to oldName", () => {
    const out = rename(
      `version: 1\nname: t\nvariables: {}\nsteps:\n` +
        `  - id: 01HX0000000000000000000001\n    name: s\n    type: http\n` +
        `    request:\n      method: GET\n      url: /x\n      headers:\n        X-Val: old\n` + // 헤더 값이 리터럴 "old" — 오염 금지
        `    extract:\n      - from: body\n        path: $.t\n        var: old\n`,
      "old",
      "tok",
    );
    expect(out).toContain("var: tok"); // (b) extract var 변경
    expect(out).toContain("X-Val: old"); // 헤더 값 "old"는 불변(bare-scalar-any-match 금지)
  });

  it("(c) rewrites {{old}} / {{old:cast}} base only, preserving cast + surrounding bytes", () => {
    const out = rename(
      `version: 1\nname: t\nvariables:\n  old: v\nsteps:\n` +
        `  - id: 01HX0000000000000000000001\n    name: s\n    type: http\n` +
        `    request:\n      method: GET\n      url: "/a/{{old}}/b?x={{ old : num }}&y={{oldX}}&z={{team.old}}"\n` +
        `      headers: {}\n`,
      "old",
      "new",
    );
    expect(out).toContain("/a/{{new}}/b"); // bare
    expect(out).toContain("{{ new : num }}"); // cast + 공백 보존
    expect(out).toContain("{{oldX}}"); // 접두 불매치(정확일치)
    expect(out).toContain("{{team.old}}"); // namespaced 불매치
  });

  it("(c-2) leaves {{old:foo}}(non-keyword suffix) and {{old bar}}(space, no keyword) untouched — scanner/rewrite symmetry", () => {
    // splitFlowToken(flowToken.ts)의 base 판정과 대칭이어야 한다: base는 콜론/공백 뒤가
    // CAST_KEYWORDS(str/num/bool/json)일 때만 분리된다. `foo`/`bar`는 keyword가 아니므로
    // 전체(`old:foo`/`old bar`)가 base — oldName("old")과 다르므로 rename 대상이 아니다.
    const outColon = rename(
      `version: 1\nname: t\nvariables:\n  old: v\nsteps:\n` +
        `  - id: 01HX0000000000000000000001\n    name: s\n    type: http\n` +
        `    request:\n      method: GET\n      url: "/x?a={{old:foo}}"\n      headers: {}\n`,
      "old",
      "new",
    );
    expect(outColon).toContain("{{old:foo}}"); // 미오염(non-keyword suffix)
    expect(outColon).not.toContain("{{new:foo}}");

    const outSpace = rename(
      `version: 1\nname: t\nvariables:\n  old: v\nsteps:\n` +
        `  - id: 01HX0000000000000000000001\n    name: s\n    type: http\n` +
        `    request:\n      method: GET\n      url: "/x?a={{old bar}}"\n      headers: {}\n`,
      "old",
      "new",
    );
    expect(outSpace).toContain("{{old bar}}"); // 미오염(공백, keyword 아님)
    expect(outSpace).not.toContain("{{new bar}}");
  });

  it("(d) rewrites condition operands in the (c) pass without creating a right key", () => {
    const out = rename(
      `version: 1\nname: t\nvariables:\n  old: v\nsteps:\n` +
        `  - id: 01HX0000000000000000000001\n    name: g\n    type: if\n` +
        `    cond:\n      left: "{{old}}"\n      op: exists\n` +
        `    then:\n      - id: 01HX0000000000000000000002\n        name: t\n        type: http\n` +
        `        request: { method: GET, url: /ok, headers: {} }\n`,
      "old",
      "new",
    );
    expect(out).toContain('left: "{{new}}"');
    expect(out).not.toContain("right:"); // exists는 right 없음 — 신규 생성 금지
  });
});
