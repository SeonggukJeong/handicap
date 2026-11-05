import { ko } from "../i18n/ko";
import { resolveForDisplay } from "../scenario/template";
import type { StepFacts } from "./scenarioFacts";

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/** 호스트(+포트)만 반환. 풀리지 않은 토큰이 호스트 자리에 있으면 원형 템플릿에서 호스트 부분만. "" = 건너뜀. */
export function hostOf(urlTemplate: string, env: Record<string, string>): string {
  const resolved = resolveForDisplay(urlTemplate, env);
  try {
    const host = new URL(resolved).host;
    if (host && !host.includes("{") && !host.includes("$")) return host;
  } catch {
    // fall through to template fallback
  }
  const m = SCHEME.exec(urlTemplate);
  let rest: string;
  if (m) {
    rest = urlTemplate.slice(m[0].length);
  } else if (urlTemplate.startsWith("${") || urlTemplate.startsWith("{{")) {
    // 스킴 없이 토큰으로 시작(`${BASE_URL}/x`) — 토큰 자체가 호스트 자리
    rest = urlTemplate;
  } else {
    return "";
  }
  // 첫 토큰(`${…}`/`{{…}}`)은 통째로 보존한 채 그 뒤 첫 `/`·`?`·`#` 앞에서 자른다
  const tok = /^(\$\{[^}]*\}|\{\{[^}]*\}\})/.exec(rest);
  const skip = tok ? tok[0].length : 0;
  const cutRel = rest.slice(skip).search(/[/?#]/);
  if (cutRel !== -1) rest = rest.slice(0, skip + cutRel);
  const at = rest.lastIndexOf("@");
  if (at !== -1) rest = rest.slice(at + 1);
  return rest;
}

export function targetSystems(steps: StepFacts[], env: Record<string, string>): string {
  const seen: string[] = [];
  for (const s of steps) {
    const h = hostOf(s.url, env);
    if (h && !seen.includes(h)) seen.push(h);
  }
  if (seen.length === 0) return ko.print.fmt.noTarget;
  if (seen.length <= 2) return seen.join(", ");
  return seen.slice(0, 2).join(", ") + ko.print.fmt.targetMore(seen.length - 2);
}

/** 풀지 않은 원형 경로. 쿼리는 `?…`, 프래그먼트는 제거. */
export function displayPath(urlTemplate: string): string {
  let t = urlTemplate;
  const hash = t.indexOf("#");
  if (hash !== -1) t = t.slice(0, hash);
  const m = SCHEME.exec(t);
  if (m) t = t.slice(m[0].length);
  if (m || !t.startsWith("/")) {
    const slash = t.indexOf("/");
    t = slash === -1 ? "/" : t.slice(slash);
  }
  const q = t.indexOf("?");
  if (q !== -1) t = t.slice(0, q) + "?…";
  return t;
}

export function middleEllipsis(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = Math.floor((max - 1) * 0.6);
  const tail = max - 1 - head;
  return s.slice(0, head) + "…" + s.slice(s.length - tail);
}

export function requestLine(method: string, urlTemplate: string): string {
  return `${method} ${displayPath(urlTemplate)}`;
}

/** 6.8pt 영문 평균 글자 폭 ≈ 1.3mm. */
export function requestLineBudget(nameColMm: number): number {
  return Math.max(24, Math.floor(nameColMm / 1.3));
}
