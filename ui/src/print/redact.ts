import { ko } from "../i18n/ko";
import { resolveForDisplay } from "../scenario/template";
import type { StepFacts } from "./scenarioFacts";

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * 선두 `${…}`(첫 `}`까지 — 엔진·`resolveForDisplay`와 같은 닫힘 규칙)·`{{…}}`(첫 `}}`까지) 토큰 길이.
 * 토큰이 없으면 0, 닫히지 않았으면 -1(모호 — 호출부는 아무 조각도 내보내지 않는다).
 */
function leadingTokenLen(s: string): number {
  if (s.startsWith("${")) {
    const e = s.indexOf("}", 2);
    return e === -1 ? -1 : e + 1;
  }
  if (s.startsWith("{{")) {
    const e = s.indexOf("}}", 2);
    return e === -1 ? -1 : e + 2;
  }
  return 0;
}

/**
 * 스킴(또는 `//`) 뒤 문자열의 권한부: 호스트 시작과 권한부 끝(경로·`?`·`#` 시작).
 * `@`가 있으면 마지막 `@` 뒤를 호스트로 본다 — userinfo에 날 `/`·`?`·`#`가 있어도 자격증명이
 * 경로·호스트로 새지 않게(경로·쿼리 속 `@`면 경로가 덜 보일 뿐). 호스트 자리 선두 토큰은 통째로 건너뛴다.
 * null = 모호(닫히지 않은 토큰).
 */
function splitAuthority(t: string): { hostStart: number; end: number } | null {
  const at = t.lastIndexOf("@");
  const hostStart = at === -1 ? 0 : at + 1;
  const tok = leadingTokenLen(t.slice(hostStart));
  if (tok < 0) return null;
  const rel = t.slice(hostStart + tok).search(/[/?#]/);
  return { hostStart, end: rel === -1 ? t.length : hostStart + tok + rel };
}

/** 호스트(+포트)만 반환. 풀리지 않은 토큰이 호스트 자리에 있으면 원형 템플릿에서 호스트 부분만. "" = 건너뜀. */
export function hostOf(urlTemplate: string, env: Record<string, string>): string {
  const resolved = resolveForDisplay(urlTemplate, env);
  try {
    const host = new URL(resolved).host;
    if (host && !host.includes("{") && !host.includes("$")) return host;
  } catch {
    // fall through to template fallback
  }
  let rest: string;
  const m = SCHEME.exec(urlTemplate);
  if (m) {
    rest = urlTemplate.slice(m[0].length);
  } else if (urlTemplate.startsWith("//")) {
    // 프로토콜 상대(`//host/x`) — 스킴처럼 권한부로 취급
    rest = urlTemplate.slice(2);
  } else {
    // 스킴 없이 토큰으로 시작(`${BASE_URL}/x`) — 토큰 자체가 호스트 자리. 경로·쿼리 속 `@`는 보지 않게 먼저 자른다
    const tok = leadingTokenLen(urlTemplate);
    if (tok <= 0) return "";
    const cut = urlTemplate.slice(tok).search(/[/?#]/);
    rest = cut === -1 ? urlTemplate : urlTemplate.slice(0, tok + cut);
  }
  const a = splitAuthority(rest);
  return a ? rest.slice(a.hostStart, a.end) : "";
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

/** 풀지 않은 원형 경로. 쿼리는 `?…`, 프래그먼트는 제거. 권한부(자격증명 포함)는 절대 내보내지 않는다. */
export function displayPath(urlTemplate: string): string {
  let t = urlTemplate;
  const m = SCHEME.exec(t);
  if (m || t.startsWith("//")) {
    t = t.slice(m ? m[0].length : 2);
    const a = splitAuthority(t);
    if (!a) return "/";
    t = t.slice(a.end);
  } else if (!t.startsWith("/")) {
    // 선두 `${…}`/`{{…}}` 토큰(기본값에 URL·자격증명이 들 수 있다)은 통째로 건너뛴다
    const tok = leadingTokenLen(t);
    if (tok < 0) return "/";
    const cut = t.slice(tok).search(/[/?#]/);
    t = cut === -1 ? "" : t.slice(tok + cut);
  }
  if (!t.startsWith("/")) return "/";
  const hash = t.indexOf("#");
  if (hash !== -1) t = t.slice(0, hash);
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
