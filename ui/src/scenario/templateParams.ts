/**
 * 스텝 템플릿 삽입 시 토큰 파라미터화 — 순수 함수.
 * scanTemplateTokens: 템플릿 fragment의 {{flow}}·${ENV} 토큰을 두 네임스페이스로 스캔.
 * applyTokenSubstitutions: 토큰별 치환(유지/이름변경/리터럴)을 YAML Document 스칼라에 적용.
 *
 * 왜 Document visit인가(spec R8): parseStepsFragment는 StepModel.id의 ULID regex를
 * 강제하지만 백엔드는 step-id ULID를 검증 안 함(api/step_templates.rs) → 비-ULID id
 * 템플릿도 스캔/치환 가능해야 한다. Document 스칼라만 방문하면 Zod 게이트를 우회하고
 * 주석/구조도 보존한다(reissueStepIdsInFragment와 동형).
 */
import {
  parseDocument,
  visit,
  isScalar,
  isPair,
  isSeq,
  Scalar,
  type Document,
  type Node,
  type Pair,
} from "yaml";
import { serializeDoc } from "./yamlDoc";
import { splitFlowToken } from "./flowToken";
import { PURE_FLOW } from "./cast";

export type Substitution =
  | { kind: "keep" }
  | { kind: "rename"; to: string }
  | { kind: "literal"; value: string };

export interface SubMap {
  flow: Record<string, Substitution>;
  env: Record<string, Substitution>;
}

// {{ name }} — scanVars.ts FLOW_VAR_RE와 동일.
const FLOW_RE = /\{\{\s*([^}]+?)\s*\}\}/g;
// ${ NAME } 또는 ${ NAME:-default } — group1=이름, group2=":-default"(옵션).
// 이름은 ':' 금지(엔진 :-default 구분자 보수 가드, template.rs). `${a:b}`(bare colon)는
// 매칭 안 함 → 스캔 누락 = identity 유지(안전 방향, spec §4.1 의도적 엣지).
const ENV_RE = /\$\{\s*([^}:]+?)\s*(:-[^}]*)?\}/g;
// 두 토큰을 한 번에 훑는다 — 따로 두 번 돌리면 flow 리터럴 안의 `${X}` 글자가 env 치환을 다시 탄다.
// group1 = flow inner / group2 = env 이름, group3 = env ":-default".
const TOKEN_RE = new RegExp(`${FLOW_RE.source}|${ENV_RE.source}`, "g");

// 엔진이 런타임 시스템 값으로 해석 — 파라미터화 대상 아님(EnvironmentsPage.RESERVED 동일).
const RESERVED = new Set(["vu_id", "iter_id", "loop_index"]);

type VisitPath = readonly (Document | Node | Pair)[];

const keyText = (p: Pair): unknown => (isScalar(p.key) ? p.key.value : p.key);

/** 이 글자가 `body.json` 아래에 있는가 — 엔진의 캐스트는 JSON 본문의 문자열 leaf에만 먹는다. */
function inJsonBody(path: VisitPath): boolean {
  const body = path.findIndex((n) => isPair(n) && keyText(n) === "body");
  if (body < 0) return false;
  return path.slice(body + 1).some((n) => isPair(n) && keyText(n) === "json");
}

/** 값 전체가 캐스트 붙은 flow 토큰 하나면 `{base, cast}` (엔진 `parse_cast_leaf`와 같은 판정). */
function pureCastToken(text: string): { base: string; cast: string } | null {
  const m = PURE_FLOW.exec(text.trim());
  if (!m) return null;
  const { base, cast } = splitFlowToken(m[1]);
  return cast === null ? null : { base, cast };
}

/**
 * 리터럴 값이 캐스트 타입에 맞는가 — 엔진 `coerce_num`/`coerce_bool`과 같은 규칙.
 * num은 JSON 숫자 문법(앞뒤 공백 허용)이고, 이 화면이 그대로 옮길 수 있는 범위(유한·안전 정수)여야 한다.
 */
export function fitsCast(value: string, cast: string): boolean {
  if (cast === "bool") return value === "true" || value === "false";
  if (cast !== "num" && cast !== "json") return true;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return false;
  }
  if (cast === "json") return true;
  return (
    typeof parsed === "number" &&
    Number.isFinite(parsed) &&
    (!Number.isInteger(parsed) || Number.isSafeInteger(parsed))
  );
}

export function scanTemplateTokens(stepsYaml: string): { flow: string[]; env: string[] } {
  const flow: string[] = [];
  const env: string[] = [];
  const flowSeen = new Set<string>();
  const envSeen = new Set<string>();
  let doc;
  try {
    doc = parseDocument(stepsYaml);
  } catch {
    return { flow, env };
  }
  if (doc.errors.length > 0) return { flow, env };
  visit(doc, {
    Scalar(_key, node) {
      if (typeof node.value !== "string") return;
      const s = node.value;
      for (const m of s.matchAll(FLOW_RE)) {
        // 캐스트(`:num` 등)는 이름이 아니다 — `{{n:num}}`과 `{{n}}`은 같은 변수.
        const name = splitFlowToken(m[1]).base;
        if (!flowSeen.has(name)) {
          flowSeen.add(name);
          flow.push(name);
        }
      }
      for (const m of s.matchAll(ENV_RE)) {
        const name = m[1];
        if (RESERVED.has(name) || envSeen.has(name)) continue;
        envSeen.add(name);
        env.push(name);
      }
    },
  });
  return { flow, env };
}

/**
 * flow 변수별로, JSON 본문에서 값 전체가 그 변수의 캐스트 토큰인 자리의 타입 목록.
 * 리터럴로 바꿀 때 값이 이 타입들에 맞아야 한다(`fitsCast`).
 */
export function scanTemplateCasts(stepsYaml: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  let doc;
  try {
    doc = parseDocument(stepsYaml);
  } catch {
    return out;
  }
  if (doc.errors.length > 0) return out;
  visit(doc, {
    Scalar(key, node, path) {
      if (key === "key" || typeof node.value !== "string" || !inJsonBody(path)) return;
      const tok = pureCastToken(node.value);
      if (!tok) return;
      const casts = (out[tok.base] ??= []);
      if (!casts.includes(tok.cast)) casts.push(tok.cast);
    },
  });
  return out;
}

function isIdentity(subs: SubMap): boolean {
  const all = [...Object.values(subs.flow), ...Object.values(subs.env)];
  return all.every((s) => s.kind === "keep");
}

function rewrite(s: string, subs: SubMap): { out: string; literal: boolean } {
  let literal = false;
  const out = s.replace(
    TOKEN_RE,
    (full: string, flowInner?: string, envName?: string, envDefault?: string) => {
      if (flowInner !== undefined) {
        const { base, cast } = splitFlowToken(flowInner);
        const sub = subs.flow[base];
        if (!sub || sub.kind === "keep") return full;
        if (sub.kind === "rename") return `{{${sub.to}${cast === null ? "" : `:${cast}`}}}`;
        literal = true;
        return sub.value; // literal — braces dropped
      }
      const sub = envName === undefined ? undefined : subs.env[envName];
      if (!sub || sub.kind === "keep") return full;
      if (sub.kind === "rename") return `\${${sub.to}${envDefault ?? ""}}`; // :- default preserved
      literal = true;
      return sub.value; // literal — whole ${...} replaced
    },
  );
  return { out, literal };
}

/**
 * 캐스트 자리(JSON 본문의 값 전체가 `{{x:num|bool|json}}`)에 들어갈 리터럴을 그 타입의 값으로.
 * 해당 없거나 값이 타입에 안 맞으면 `undefined`(문자열 치환으로 넘어간다).
 */
function typedLiteral(text: string, subs: SubMap, path: VisitPath): { value: unknown } | undefined {
  const tok = pureCastToken(text);
  if (!tok || tok.cast === "str" || !inJsonBody(path)) return undefined;
  const sub = subs.flow[tok.base];
  if (!sub || sub.kind !== "literal" || !fitsCast(sub.value, tok.cast)) return undefined;
  return { value: tok.cast === "bool" ? sub.value === "true" : (JSON.parse(sub.value) as unknown) };
}

export function applyTokenSubstitutions(stepsYaml: string, subs: SubMap): string {
  // R12: identity = no-op, return input byte-identical (skip parse/reserialize so we
  // never normalize quoting/indentation when nothing changed).
  if (isIdentity(subs)) return stepsYaml;
  let doc: Document.Parsed;
  try {
    doc = parseDocument(stepsYaml);
  } catch {
    return stepsYaml;
  }
  if (doc.errors.length > 0) return stepsYaml;
  visit(doc, {
    Scalar(key, node, path) {
      if (!isScalar(node) || typeof node.value !== "string") return undefined;
      if (key !== "key") {
        const typed = typedLiteral(node.value, subs, path);
        if (typed) {
          // 새 노드는 다시 훑지 않는다(SKIP) — `:json` 리터럴 안의 토큰 글자를 또 치환하지 않게.
          const fresh = doc.createNode(typed.value);
          const parent = path[path.length - 1];
          if (isPair(parent)) parent.value = fresh;
          else if (isSeq(parent) && typeof key === "number") parent.items[key] = fresh;
          return visit.SKIP;
        }
      }
      const { out, literal } = rewrite(node.value, subs);
      node.value = out;
      // 리터럴이 들어간 평문 글자는 큰따옴표로 — `yaml`(1.2)이 평문으로 쓰는 `0b101`·`+0x1F`를
      // 서버 serde_yaml은 숫자로 읽는다. 원래 문자열이던 자리는 서버에서도 문자열이어야 한다.
      if (literal && (node.type === undefined || node.type === Scalar.PLAIN)) {
        node.type = Scalar.QUOTE_DOUBLE;
      }
      return undefined;
    },
  });
  return serializeDoc(doc);
}
