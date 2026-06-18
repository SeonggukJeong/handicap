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
import { parseDocument, visit, isScalar } from "yaml";

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

// 엔진이 런타임 시스템 값으로 해석 — 파라미터화 대상 아님(EnvironmentsPage.RESERVED 동일).
const RESERVED = new Set(["vu_id", "iter_id", "loop_index"]);

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
        const name = m[1];
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

function isIdentity(subs: SubMap): boolean {
  const all = [...Object.values(subs.flow), ...Object.values(subs.env)];
  return all.every((s) => s.kind === "keep");
}

function rewrite(s: string, subs: SubMap): string {
  let out = s.replace(FLOW_RE, (full, name: string) => {
    const sub = subs.flow[name];
    if (!sub || sub.kind === "keep") return full;
    if (sub.kind === "rename") return `{{${sub.to}}}`;
    return sub.value; // literal — braces dropped
  });
  out = out.replace(ENV_RE, (full, name: string, def?: string) => {
    const sub = subs.env[name];
    if (!sub || sub.kind === "keep") return full;
    if (sub.kind === "rename") return `\${${sub.to}${def ?? ""}}`; // :- default preserved
    return sub.value; // literal — whole ${...} replaced
  });
  return out;
}

export function applyTokenSubstitutions(stepsYaml: string, subs: SubMap): string {
  // R12: identity = no-op, return input byte-identical (skip parse/reserialize so we
  // never normalize quoting/indentation when nothing changed).
  if (isIdentity(subs)) return stepsYaml;
  let doc;
  try {
    doc = parseDocument(stepsYaml);
  } catch {
    return stepsYaml;
  }
  if (doc.errors.length > 0) return stepsYaml;
  visit(doc, {
    Scalar(_key, node) {
      if (isScalar(node) && typeof node.value === "string") {
        node.value = rewrite(node.value, subs);
      }
    },
  });
  return String(doc);
}
