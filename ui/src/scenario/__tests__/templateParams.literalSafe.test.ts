import { describe, it, expect } from "vitest";
import { parse, parseDocument, visit, Scalar } from "yaml";
import { applyTokenSubstitutions, type SubMap } from "../templateParams";

// 템플릿 삽입의 「리터럴로 바꾸기」가 넣은 값은 어떤 글자든 서버(serde_yaml)에서도 같은 **문자열**로
// 읽혀야 한다. `yaml`(1.2)과 serde_yaml은 평문 글자를 다르게 읽는 경우가 있으므로(`0b101` → serde 정수,
// flow 안의 `?0` → serde 파싱 오류) 리터럴이 들어간 평문 글자는 큰따옴표로 감싼다.
// 아래 목록 × 다섯 자리의 출력은 serde_yaml 0.9로 다시 읽어 전부 같은 문자열임을 한 번 대조했다
// (수정 전에는 block 평문 자리의 `0b101`·`+0x1F`·`-0x10`이 정수로 읽혔다).

// 토큰이 값 전체인 자리 다섯 곳: block 평문 / block 큰따옴표 / block 작은따옴표 / flow 큰따옴표 / flow 작은따옴표.
const FRAG = [
  "- id: 01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "  name: block",
  "  type: http",
  "  request:",
  "    method: GET",
  "    url: http://h/",
  "    headers:",
  "      X-Plain: ${TOK}",
  '      X-Dq: "{{v}}"',
  "      X-Sq: '{{v}}'",
  "- id: 01ARZ3NDEKTSV4RRFFQ69G5FAW",
  "  name: flow",
  "  type: http",
  "  request: { method: GET, url: http://h/, headers: { X-FlowDq: \"{{v}}\", X-FlowSq: '${TOK}' } }",
  "",
].join("\n");

const LITERALS = [
  "?0",
  "?",
  "? x",
  ":v",
  ": v",
  "- x",
  "-",
  "# c",
  "a #b",
  "a: b",
  "[x]",
  "{x}",
  "a, b",
  "123",
  "01",
  "1e3",
  "+12",
  "0b101",
  "0o17",
  "0x1F",
  "+0x1F",
  "-0x10",
  "1_000",
  "1.5",
  ".5",
  ".inf",
  ".nan",
  "true",
  "True",
  "false",
  "null",
  "Null",
  "~",
  "yes",
  "no",
  "on",
  "off",
  "y",
  "n",
  "*a",
  "&a",
  "!t",
  "|",
  ">",
  "%x",
  "@x",
  "`x",
  "'q'",
  '"dq"',
  "back\\slash",
  " lead",
  "tail ",
  "2026-11-22",
  "12:30:45",
  "<<",
  "=",
  "",
];

const subs = (value: string): SubMap => ({
  flow: { v: { kind: "literal", value } },
  env: { TOK: { kind: "literal", value } },
});

function headerValues(yamlText: string): unknown[] {
  const steps = parse(yamlText) as Array<{ request: { headers: Record<string, unknown> } }>;
  return steps.flatMap((s) => Object.values(s.request.headers));
}

describe("applyTokenSubstitutions — 리터럴 값은 서버에서도 같은 문자열", () => {
  it.each(LITERALS)("리터럴 %j — 다섯 자리 모두 같은 문자열로 다시 읽힌다", (value) => {
    const out = applyTokenSubstitutions(FRAG, subs(value));
    expect(headerValues(out)).toEqual([value, value, value, value, value]);
  });

  it.each(LITERALS)("리터럴 %j — 바뀐 글자는 평문으로 남지 않는다", (value) => {
    const out = applyTokenSubstitutions(FRAG, subs(value));
    const plain: string[] = [];
    visit(parseDocument(out), {
      Scalar(_k, node) {
        if (node.value === value && node.type === Scalar.PLAIN) plain.push(String(node.value));
      },
    });
    expect(plain).toEqual([]);
  });

  it("이름 바꾸기만 하면 평문 글자의 표기를 바꾸지 않는다", () => {
    const out = applyTokenSubstitutions(FRAG, {
      flow: {},
      env: { TOK: { kind: "rename", to: "OTHER" } },
    });
    expect(out).toContain("      X-Plain: ${OTHER}\n");
  });

  it("리터럴이 섞여 들어간 평문 글자도 감싼다", () => {
    const frag = FRAG.replace("X-Plain: ${TOK}", "X-Plain: 0b${TOK}");
    const out = applyTokenSubstitutions(frag, subs("101"));
    expect(out).toContain('      X-Plain: "0b101"\n');
  });
});
